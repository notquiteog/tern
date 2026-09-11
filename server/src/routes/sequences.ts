import { Router } from 'express';
import { one, query, withTx } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { getAccount, getUserAccount } from '../services/accounts.js';
import { BriefIncompleteError, previewCampaign, renderStep, sampleHeldRate } from '../workers/scheduler.js';
import { coachBrief } from '../ai/guard.js';
import { publish } from '../events.js';
import { describeWindow, nextWindowOpen } from '../services/sending.js';
import { campaignMetrics } from '../services/campaigns.js';
import { readValves } from '../services/valves.js';
import { REPLY_INTENTS } from '../services/replyIntent.js';
import { toCsv } from '../util/csv.js';
import { projectCampaign } from '../services/projection.js';
import { LIBRARY_BY_KEY, SEQUENCE_LIBRARY } from '../services/sequenceLibrary.js';
import { textToHtml } from '../services/merge.js';
import { requireCapability } from '../services/capabilities.js';

export const sequencesRouter = Router();
sequencesRouter.use(requireAuth);

const stepSchema = z.object({
  id: z.number().int().optional(),
  kind: z.enum(['email', 'wait']),
  template_id: z.number().int().nullable().optional(),
  subject: z.string().max(998).default(''),
  body_html: z.string().max(500000).default(''),
  wait_days: z.number().int().min(0).max(365).default(0),
  wait_hours: z.number().int().min(0).max(23).default(0),
  ai_personalize: z.boolean().default(false),
  ai_instructions: z.string().max(5000).default(''),
  // One finished email somebody edited until it was right. See
  // `DraftInput.exemplar`: a concrete example steers a small model harder than
  // any adjective, and keeping it on the step means every later draft gets it.
  ai_exemplar: z.string().max(20000).default(''),
  reply_in_thread: z.boolean().default(true),
});
const seqSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  account_id: z.number().int().nullable().optional(),
  stop_on_reply: z.boolean().default(true),
  ai_mode: z.enum(['off', 'review', 'auto']).default('review'),
  unsubscribe_footer: z.boolean().default(true),
  encrypt_pgp: z.boolean().default(false),
  steps: z.array(stepSchema).optional(),
});

const seqUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(), description: z.string().max(5000).optional(), account_id: z.number().int().nullable().optional(),
  stop_on_reply: z.boolean().optional(), ai_mode: z.enum(['off', 'review', 'auto']).optional(), unsubscribe_footer: z.boolean().optional(), encrypt_pgp: z.boolean().optional(), steps: z.array(stepSchema).optional(),
  contact_local_window: z.boolean().optional(),
  // Zero turns a valve off. Capped well above anything sensible rather than
  // at a "reasonable" number: somebody running a re-engagement campaign to a
  // three-year-old list knows more about what to expect from it than this
  // schema does.
  pause_on_bounce_pct: z.number().int().min(0).max(100).optional(),
  pause_on_unsubscribes: z.number().int().min(0).max(1000).optional(),
});

async function seqOf(userId: number, id: number) {
  const s = await one<any>('SELECT * FROM sequences WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!s) throw notFound('Sequence not found');
  return s;
}

const statsSql = `
  (SELECT jsonb_build_object(
     'total', count(*), 'active', count(*) FILTER (WHERE e.status='active'), 'waiting_review', count(*) FILTER (WHERE e.status='waiting_review'), 'paused', count(*) FILTER (WHERE e.status='paused'),
     'finished', count(*) FILTER (WHERE e.status='finished'), 'replied', count(*) FILTER (WHERE e.status='replied'), 'bounced', count(*) FILTER (WHERE e.status='bounced'),
     'unsubscribed', count(*) FILTER (WHERE e.status='unsubscribed'), 'error', count(*) FILTER (WHERE e.status='error'))
   FROM enrollments e WHERE e.sequence_id=s.id) AS stats,
  (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=s.id AND l.status='sent') AS sent_count,
  (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=s.id AND l.replied_at IS NOT NULL) AS reply_count`;

sequencesRouter.get('/', async (req, res) => {
  const rows = await query<any>(`SELECT s.*, a.email AS account_email, a.name AS account_name, a.color AS account_color, (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id=s.id) AS step_count, ${statsSql} FROM sequences s LEFT JOIN accounts a ON a.id=s.account_id WHERE s.user_id=$1 ORDER BY s.updated_at DESC`, [req.user!.id]);
  res.json({ sequences: rows });
});

/**
 * Sequences you can start from.
 *
 * Templates have had a starter library since they shipped; sequences began
 * from a blank editor and a decision about how many steps and how far apart —
 * questions somebody writing their first campaign has no basis to answer.
 *
 * What comes back is a shape, not copy: the briefs are instructions to the
 * model about what each email is for, so nobody's campaign is the same prose
 * every other install is sending.
 */
sequencesRouter.get('/library', (_req, res) => {
  res.json({ sequences: SEQUENCE_LIBRARY });
});

sequencesRouter.post('/library', async (req, res) => {
  const { key, account_id } = parse(z.object({ key: z.string().max(60), account_id: z.number().int().nullable().optional() }), req.body);
  const lib = LIBRARY_BY_KEY.get(key);
  if (!lib) throw notFound('No such starter sequence');
  if (account_id && !(await getUserAccount(req.user!.id, account_id))) throw badRequest('Account not found');
  const seq = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO sequences (user_id, name, description, account_id, status) VALUES ($1,$2,$3,$4,'draft') RETURNING *`,
      [req.user!.id, lib.name, lib.description, account_id ?? null],
    );
    const row = r.rows[0];
    let pos = 0;
    for (const st of lib.steps) {
      await c.query(
        `INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, wait_days, ai_personalize, ai_instructions, reply_in_thread)
         VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8)`,
        [row.id, pos, st.kind, st.brief ? textToHtml(st.brief) : '', st.days ?? 0, st.kind === 'email', st.instructions ?? '', pos > 0],
      );
      pos++;
    }
    return row;
  });
  res.json({ sequence: seq });
});

sequencesRouter.post('/', async (req, res) => {
  const b = parse(seqSchema, req.body);
  if (b.account_id && !(await getUserAccount(req.user!.id, b.account_id))) throw badRequest('Account not found');
  const seq = await withTx(async (c) => {
    const r = await c.query('INSERT INTO sequences (user_id, name, description, account_id, stop_on_reply, ai_mode, unsubscribe_footer, encrypt_pgp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [req.user!.id, b.name, b.description, b.account_id ?? null, b.stop_on_reply, b.ai_mode, b.unsubscribe_footer, b.encrypt_pgp]);
    const s = r.rows[0];
    let pos = 0;
    for (const st of b.steps ?? []) {
      await c.query('INSERT INTO sequence_steps (sequence_id, position, kind, template_id, subject, body_html, wait_days, wait_hours, ai_personalize, ai_instructions, ai_exemplar, reply_in_thread) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [s.id, pos++, st.kind, st.template_id ?? null, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.ai_exemplar, st.reply_in_thread]);
    }
    return s;
  });
  res.json({ sequence: seq });
});

sequencesRouter.get('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const s = await one<any>(`SELECT s.*, a.email AS account_email, a.name AS account_name, ${statsSql} FROM sequences s LEFT JOIN accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.user_id=$2`, [id, req.user!.id]);
  if (!s) throw notFound('Sequence not found');
  const steps = await query<any>('SELECT st.*, t.name AS template_name FROM sequence_steps st LEFT JOIN templates t ON t.id=st.template_id WHERE st.sequence_id=$1 ORDER BY st.position, st.id', [id]);
  const stepStats = await query<any>(`SELECT step_id, count(*)::int AS sent, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied, count(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced FROM send_log WHERE sequence_id=$1 AND status='sent' GROUP BY step_id`, [id]);
  // How the queue has been treating each step's drafts.
  //
  // A responder that writes badly says so on its own card — "you rejected 14
  // of its last 20, its instructions are below". A sequence step producing the
  // same drafts for the same reason had the same numbers sitting in the same
  // table and never said a word, so the fix (editing the step's instructions)
  // was something you had to think of yourself.
  //
  // Last twenty decided, per step, exactly as the responder version counts it.
  const stepVerdicts = await query<any>(
    `SELECT st.id AS step_id,
            (SELECT count(*)::int FROM (SELECT status FROM review_queue q WHERE q.step_id=st.id AND q.status<>'pending' ORDER BY q.decided_at DESC LIMIT 20) t) AS recent_decided,
            (SELECT count(*)::int FROM (SELECT status FROM review_queue q WHERE q.step_id=st.id AND q.status<>'pending' ORDER BY q.decided_at DESC LIMIT 20) t WHERE t.status='rejected') AS recent_rejected
       FROM sequence_steps st WHERE st.sequence_id=$1`,
    [id],
  );
  const verdictBy = new Map(stepVerdicts.map((v) => [v.step_id, v]));
  for (const st of stepStats) Object.assign(st, verdictBy.get(st.step_id) ?? {});
  // A step whose drafts were all rejected has no sends and so no stepStats row
  // at all — which is exactly the step the warning is for.
  for (const v of stepVerdicts) if (!stepStats.some((s2) => s2.step_id === v.step_id) && v.recent_decided > 0) stepStats.push({ ...v, sent: 0, replied: 0, bounced: 0 });
  // What the campaign has done, as opposed to where everybody is in it.
  // Why people left, for the campaign they left. Most rows have no reason —
  // it is asked after the unsubscribe is already done, on a page nobody has a
  // reason to still be reading — so this is a shape rather than a statistic,
  // and the page says how many answered out of how many went.
  const unsubReasons = await query<{ reason: string; n: number }>(
    `SELECT unsub_reason AS reason, count(*)::int AS n FROM enrollments
      WHERE sequence_id=$1 AND unsub_reason IS NOT NULL GROUP BY unsub_reason ORDER BY n DESC`,
    [id],
  );
  res.json({ sequence: s, steps, stepStats, metrics: await campaignMetrics(id), valves: await readValves(id), unsubReasons });
});

sequencesRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  const b = parse(seqUpdateSchema, req.body);
  if (b.account_id && !(await getUserAccount(req.user!.id, b.account_id))) throw badRequest('Account not found');
  await withTx(async (c) => {
    await c.query(`UPDATE sequences SET name=COALESCE($3,name), description=COALESCE($4,description), account_id=COALESCE($5,account_id), stop_on_reply=COALESCE($6,stop_on_reply), ai_mode=COALESCE($7,ai_mode), unsubscribe_footer=COALESCE($8,unsubscribe_footer), encrypt_pgp=COALESCE($9,encrypt_pgp), contact_local_window=COALESCE($10,contact_local_window), pause_on_bounce_pct=COALESCE($11,pause_on_bounce_pct), pause_on_unsubscribes=COALESCE($12,pause_on_unsubscribes), updated_at=now() WHERE id=$1 AND user_id=$2`, [id, req.user!.id, b.name ?? null, b.description ?? null, b.account_id ?? null, b.stop_on_reply ?? null, b.ai_mode ?? null, b.unsubscribe_footer ?? null, b.encrypt_pgp ?? null, b.contact_local_window ?? null, b.pause_on_bounce_pct ?? null, b.pause_on_unsubscribes ?? null]);
    if (b.steps) {
      // Replace the step list, keeping ids that still exist so send_log
      // history and in-flight enrollments keep pointing at the right step.
      const keep: number[] = [];
      let pos = 0;
      for (const st of b.steps) {
        if (st.id) {
          const r = await c.query('UPDATE sequence_steps SET position=$3, kind=$4, template_id=$5, subject=$6, body_html=$7, wait_days=$8, wait_hours=$9, ai_personalize=$10, ai_instructions=$11, ai_exemplar=$12, reply_in_thread=$13 WHERE id=$1 AND sequence_id=$2 RETURNING id', [st.id, id, pos, st.kind, st.template_id ?? null, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.ai_exemplar, st.reply_in_thread]);
          if (r.rows.length) { keep.push(st.id); pos++; continue; }
        }
        const r = await c.query('INSERT INTO sequence_steps (sequence_id, position, kind, template_id, subject, body_html, wait_days, wait_hours, ai_personalize, ai_instructions, ai_exemplar, reply_in_thread) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id', [id, pos++, st.kind, st.template_id ?? null, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.ai_exemplar, st.reply_in_thread]);
        keep.push(r.rows[0].id);
      }
      await c.query('DELETE FROM sequence_steps WHERE sequence_id=$1 AND NOT (id = ANY($2))', [id, keep]);
    }
  });
  res.json({ ok: true });
});

/**
 * Copy a campaign, so the next one does not start from a blank page.
 *
 * Templates have had a starter library and a duplicate button since they
 * shipped; sequences have neither, so every campaign is rebuilt from nothing
 * even when it is last month's campaign with two sentences changed.
 *
 * The copy is a draft with no enrollments, no history and no pause reason:
 * everything about *this* run of the campaign belongs to the original. What
 * carries over is the part somebody actually spent time on — the steps, their
 * instructions, the waits, and the settings.
 */
sequencesRouter.post('/:id/duplicate', async (req, res) => {
  const id = idParam(req.params.id);
  const src = await seqOf(req.user!.id, id);
  const copy = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO sequences (user_id, name, description, account_id, stop_on_reply, ai_mode, unsubscribe_footer, encrypt_pgp, contact_local_window, pause_on_bounce_pct, pause_on_unsubscribes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft') RETURNING *`,
      [req.user!.id, `${src.name} (copy)`.slice(0, 200), src.description, src.account_id, src.stop_on_reply, src.ai_mode, src.unsubscribe_footer, src.encrypt_pgp, src.contact_local_window, src.pause_on_bounce_pct, src.pause_on_unsubscribes],
    );
    const seq = r.rows[0];
    // One statement rather than a read and a loop: the positions are already
    // right in the source and copying them in the same order is the whole job.
    await c.query(
      `INSERT INTO sequence_steps (sequence_id, position, kind, template_id, subject, body_html, wait_days, wait_hours, ai_personalize, ai_instructions, ai_exemplar, reply_in_thread)
       SELECT $1, position, kind, template_id, subject, body_html, wait_days, wait_hours, ai_personalize, ai_instructions, ai_exemplar, reply_in_thread
         FROM sequence_steps WHERE sequence_id=$2 ORDER BY position, id`,
      [seq.id, id],
    );
    return seq;
  });
  res.json({ sequence: copy });
});

sequencesRouter.delete('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  await query('DELETE FROM sequences WHERE id=$1', [id]);
  res.json({ ok: true });
});

sequencesRouter.post('/:id/status', async (req, res) => {
  const id = idParam(req.params.id);
  const s = await seqOf(req.user!.id, id);
  const { status } = parse(z.object({ status: z.enum(['draft', 'active', 'paused', 'archived']) }), req.body);
  if (status === 'active') {
    if (!s.account_id) throw badRequest('Choose a sending account before activating');
    const steps = await one<{ n: number }>(`SELECT count(*)::int AS n FROM sequence_steps WHERE sequence_id=$1 AND kind='email'`, [id]);
    if (!steps?.n) throw badRequest('Add at least one email step before activating');
  }
  // A reason outlives the pause it explains unless it is cleared here. A
  // campaign running again while its card still says "there is no ask in this
  // brief" is worse than a card that says nothing.
  await query(`UPDATE sequences SET status=$2, pause_reason = CASE WHEN $2 = 'paused' THEN pause_reason ELSE NULL END, paused_at = CASE WHEN $2 = 'paused' THEN COALESCE(paused_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1`, [id, status]);
  res.json({ ok: true });
});

const enrollSchema = z.object({ contactIds: z.array(z.number().int()).optional(), tag: z.string().optional(), all: z.boolean().optional(), startAt: z.string().optional() });

sequencesRouter.post('/:id/enroll', async (req, res) => {
  const id = idParam(req.params.id);
  const s = await seqOf(req.user!.id, id);
  if (!s.account_id) throw badRequest('Choose a sending account first');
  const b = parse(enrollSchema, req.body);
  let contacts: { id: number; email: string; status: string }[];
  if (b.contactIds?.length) contacts = await query('SELECT id, email, status FROM contacts WHERE user_id=$1 AND id = ANY($2)', [req.user!.id, b.contactIds]);
  else if (b.tag) contacts = await query('SELECT id, email, status FROM contacts WHERE user_id=$1 AND $2 = ANY(tags)', [req.user!.id, b.tag]);
  else if (b.all) contacts = await query(`SELECT id, email, status FROM contacts WHERE user_id=$1 AND status='active'`, [req.user!.id]);
  else throw badRequest('Nothing to enroll');
  const suppressed = new Set((await query<{ email: string }>('SELECT email FROM suppressions WHERE user_id=$1', [req.user!.id])).map((r) => r.email.toLowerCase()));
  const startAt = b.startAt ? new Date(b.startAt) : new Date();
  const stats = { enrolled: 0, skipped: 0, suppressed: 0 };
  for (const c of contacts) {
    if (c.status !== 'active' && c.status !== 'replied') { stats.skipped++; continue; }
    if (suppressed.has(c.email.toLowerCase())) { stats.suppressed++; continue; }
    const r = await query(`INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at) VALUES ($1,$2,$3,'active',0,$4) ON CONFLICT (sequence_id, contact_id) DO NOTHING RETURNING id`, [id, c.id, s.account_id, startAt]);
    if (r.length) stats.enrolled++; else stats.skipped++;
  }
  await query('UPDATE sequences SET updated_at=now() WHERE id=$1', [id]);
  res.json({ ok: true, ...stats });
});

sequencesRouter.get('/:id/enrollments', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  const status = String(req.query.status ?? '');
  const page = Math.max(1, Number(req.query.page ?? 1));
  const size = 50;
  const params: unknown[] = [id];
  let where = 'e.sequence_id=$1';
  if (status) { params.push(status); where += ` AND e.status=$${params.length}`; }
  // What they last said back, on the campaign that asked. The label has been
  // on every answered send since the classifier shipped; this is the table
  // finally able to filter by it, which is how "move everybody who said not
  // now to the last step" is expressed.
  const intent = String(req.query.intent ?? '');
  if ((REPLY_INTENTS as readonly string[]).includes(intent)) {
    params.push(intent);
    where += ` AND EXISTS (SELECT 1 FROM send_log l WHERE l.enrollment_id=e.id AND l.reply_intent=$${params.length})`;
  }
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments e WHERE ${where}`, params);
  const rows = await query<any>(
    `SELECT e.*, c.email, c.first_name, c.last_name, c.company, e.unsub_reason,
            (SELECT count(*)::int FROM send_log l WHERE l.enrollment_id=e.id AND l.status='sent') AS sent_count,
            (SELECT l.reply_intent FROM send_log l WHERE l.enrollment_id=e.id AND l.reply_intent IS NOT NULL ORDER BY l.replied_at DESC LIMIT 1) AS reply_intent
     FROM enrollments e JOIN contacts c ON c.id=e.contact_id WHERE ${where} ORDER BY e.updated_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
    params,
  );
  res.json({ enrollments: rows, total: total?.n ?? 0, page, size });
});

sequencesRouter.post('/:id/enrollments/:eid', async (req, res) => {
  const id = idParam(req.params.id);
  const eid = idParam(req.params.eid);
  await seqOf(req.user!.id, id);
  const { action } = parse(z.object({ action: z.enum(['pause', 'resume', 'remove', 'skip', 'retry']) }), req.body);
  switch (action) {
    case 'pause': await query(`UPDATE enrollments SET status='paused', updated_at=now() WHERE id=$1 AND sequence_id=$2 AND status IN ('active','waiting_review')`, [eid, id]); break;
    case 'resume': await query(`UPDATE enrollments SET status='active', next_run_at=COALESCE(next_run_at, now()), error=NULL, updated_at=now() WHERE id=$1 AND sequence_id=$2 AND status IN ('paused','error')`, [eid, id]); break;
    case 'retry': await query(`UPDATE enrollments SET status='active', next_run_at=now(), error=NULL, updated_at=now() WHERE id=$1 AND sequence_id=$2 AND status IN ('error','paused')`, [eid, id]); break;
    case 'skip': await query(`UPDATE enrollments SET current_step = current_step + 1, next_run_at=now(), updated_at=now() WHERE id=$1 AND sequence_id=$2 AND status='active'`, [eid, id]); break;
    case 'remove': await query('DELETE FROM enrollments WHERE id=$1 AND sequence_id=$2', [eid, id]); break;
  }
  publish({ type: 'enrollment', userId: req.user!.id, sequenceId: id, enrollmentId: eid, status: action });
  res.json({ ok: true });
});

/**
 * The enrollment table as a file.
 *
 * Everything the page can filter by, exported the same way — so "everybody on
 * this campaign who said not now" is a spreadsheet rather than a screenshot.
 * The whole set rather than the page being looked at: an export that silently
 * gave the first fifty rows would be worse than none.
 */
sequencesRouter.get('/:id/enrollments.csv', async (req, res) => {
  const id = idParam(req.params.id);
  const seq = await seqOf(req.user!.id, id);
  const params: unknown[] = [id];
  let where = 'e.sequence_id=$1';
  const status = String(req.query.status ?? '');
  if (status) { params.push(status); where += ` AND e.status=$${params.length}`; }
  const intent = String(req.query.intent ?? '');
  if ((REPLY_INTENTS as readonly string[]).includes(intent)) {
    params.push(intent);
    where += ` AND EXISTS (SELECT 1 FROM send_log l WHERE l.enrollment_id=e.id AND l.reply_intent=$${params.length})`;
  }
  const rows = await query<any>(
    `SELECT c.email, c.first_name, c.last_name, c.company, e.status, e.current_step, e.next_run_at, e.updated_at, e.error, e.unsub_reason,
            (SELECT count(*)::int FROM send_log l WHERE l.enrollment_id=e.id AND l.status='sent') AS sent,
            (SELECT l.reply_intent FROM send_log l WHERE l.enrollment_id=e.id AND l.reply_intent IS NOT NULL ORDER BY l.replied_at DESC LIMIT 1) AS reply_intent
       FROM enrollments e JOIN contacts c ON c.id=e.contact_id WHERE ${where} ORDER BY e.updated_at DESC`,
    params,
  );
  const headers = ['email', 'first_name', 'last_name', 'company', 'status', 'step', 'sent', 'reply', 'unsubscribe_reason', 'next_run_at', 'updated_at', 'error'];
  const body = toCsv(headers, rows.map((r) => [
    r.email, r.first_name, r.last_name, r.company, r.status, r.current_step, r.sent,
    r.reply_intent ?? '', r.unsub_reason ?? '',
    r.next_run_at?.toISOString?.() ?? '', r.updated_at?.toISOString?.() ?? '', r.error ?? '',
  ]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${seq.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-enrollments.csv"`);
  res.send(body);
});

sequencesRouter.post('/:id/enrollments-bulk', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  const { action, status, step } = parse(z.object({
    action: z.enum(['pause', 'resume', 'remove', 'move']),
    status: z.string().optional(),
    // Which step to put them on, counted the way `current_step` counts —
    // every step including the waits, which is what the runner reads.
    step: z.number().int().min(0).max(200).optional(),
  }), req.body);
  const params: unknown[] = [id];
  let filter = '';
  if (status) { params.push(status); filter = ` AND status=$${params.length}`; }
  if (action === 'pause') await query(`UPDATE enrollments SET status='paused', updated_at=now() WHERE sequence_id=$1 AND status IN ('active','waiting_review')${filter}`, params);
  if (action === 'resume') await query(`UPDATE enrollments SET status='active', next_run_at=COALESCE(next_run_at, now()), error=NULL, updated_at=now() WHERE sequence_id=$1 AND status IN ('paused','error')${filter}`, params);
  if (action === 'remove') await query(`DELETE FROM enrollments WHERE sequence_id=$1${filter ? filter : " AND status NOT IN ('active','waiting_review')"}`, params);
  if (action === 'move') {
    if (step === undefined) throw badRequest('Say which step to move them to');
    const total = await one<{ n: number }>('SELECT count(*)::int AS n FROM sequence_steps WHERE sequence_id=$1', [id]);
    if (step >= (total?.n ?? 0)) throw badRequest('That campaign does not have that many steps');
    // Reactivated as well as moved: moving a finished or paused enrolment to a
    // step and leaving it stopped would look like it had worked and send
    // nothing, which is the worst of both.
    params.push(step);
    await query(
      `UPDATE enrollments SET current_step=$${params.length}, status='active', next_run_at=now(), error=NULL, finished_at=NULL, updated_at=now()
        WHERE sequence_id=$1${filter}`,
      params,
    );
  }
  res.json({ ok: true });
});

// Render every step for one contact, before anything is sent.
sequencesRouter.get('/:id/preview', async (req, res) => {
  const id = idParam(req.params.id);
  const s = await seqOf(req.user!.id, id);
  const contactId = Number(req.query.contactId);
  const contact = contactId ? await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [contactId, req.user!.id]) : { id: 0, email: 'jane.doe@example.com', first_name: 'Jane', last_name: 'Doe', company: 'Example Co', title: 'Head of Operations', fields: {} };
  if (!contact) throw notFound('Contact not found');
  const acc = s.account_id ? await getUserAccount(req.user!.id, s.account_id) : null;
  const steps = await query<any>('SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY position, id', [id]);
  // When each step would actually land.
  //
  // The editor previewed the steps and never the run: five emails against a
  // real contact, on the dates the sending policy would really choose. Merge
  // mistakes were findable per step; "these three arrive on the same Tuesday
  // morning" and "the last one lands on Boxing Day" were not findable at all
  // until the campaign was live.
  //
  // Nothing is guessed. The waits are the steps' own, and each date is pushed
  // to the next open moment of the account's send window exactly as
  // `runEnrollment` would push it. The randomised delay is not added: it is
  // seconds to minutes, and showing a projection to the second would imply a
  // precision that does not exist.
  const window = acc?.send_window ?? null;
  let at = window ? nextWindowOpen(window, new Date()) : new Date();
  const out = [];
  for (const st of steps) {
    if (st.kind === 'wait') {
      at = new Date(at.getTime() + ((st.wait_days ?? 0) * 86_400_000) + ((st.wait_hours ?? 0) * 3_600_000));
      if (window) at = nextWindowOpen(window, at);
      out.push({ step: st, kind: 'wait', at: at.toISOString() });
      continue;
    }
    const r = await renderStep(acc ?? ({ name: req.user!.display_name, email: 'you@example.com', id: 0 } as any), s, st, contact);
    out.push({ step: st, kind: 'email', subject: r.subject, html: r.html, brief: r.brief, at: at.toISOString() });
  }
  res.json({
    preview: out,
    // Said once rather than on every row, and said plainly: a projection that
    // does not mention the reply rule would be describing a run that almost
    // never happens.
    schedule: {
      window: window ? describeWindow(window) : null,
      tz: window?.tz ?? null,
      stopsOnReply: s.stop_on_reply,
      contact: contact.id ? { id: contact.id, email: contact.email, name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') } : null,
    },
  });
});

/**
 * What the guard will probably say about drafts written from this brief.
 *
 * A route rather than a copy of `coachBrief` in the browser, deliberately.
 * These notes have to agree with what the guard actually holds, and two
 * implementations of "this brief has no ask in it" would drift the first time
 * either was touched — with the drift showing up as a page that says a brief
 * is fine while the queue fills with held drafts.
 *
 * No model, no capability, no rate limit: it is a handful of regular
 * expressions over a string the caller just typed, and the browser debounces
 * it.
 */
sequencesRouter.post('/brief-notes', async (req, res) => {
  const { brief } = parse(z.object({ brief: z.string().max(4000).default('') }), req.body);
  res.json({ notes: coachBrief(brief) });
});

/**
 * What the guard would do to a bigger sample, reported as arithmetic.
 *
 * The three-draft preview answers "is this any good". It cannot answer "will
 * this brief survive four hundred contacts", because three clean drafts from a
 * brief that invents a date on one contact in five look exactly like three
 * clean drafts from a brief that never will.
 *
 * Nothing generated here is shown or stored. Only the count comes back, which
 * is the point: it is a measurement of the brief, not more drafts to read.
 */
sequencesRouter.post('/campaign-held-rate', requireCapability('ai.campaigns'), async (req, res) => {
  const b = parse(z.object({
    account_id: z.number().int(),
    brief: z.string().min(10).max(4000),
    instructions: z.string().max(2000).optional(),
    exemplar: z.string().max(20000).optional(),
    tag: z.string().max(120).optional(),
    contactIds: z.array(z.number().int()).max(25).optional(),
    // Ten is the number that makes "two of ten" a sentence worth acting on,
    // and twenty-five the point where the wait costs more than the answer.
    count: z.number().int().min(3).max(25).optional(),
  }), req.body);
  const acc = await getUserAccount(req.user!.id, b.account_id);
  if (!acc) throw notFound('Account not found');
  const count = b.count ?? 10;
  const contacts = b.contactIds?.length
    ? await query<any>('SELECT * FROM contacts WHERE user_id=$1 AND id = ANY($2) LIMIT $3', [req.user!.id, b.contactIds, count])
    : b.tag
      ? await query<any>(`SELECT * FROM contacts WHERE user_id=$1 AND $2 = ANY(tags) AND status='active' ORDER BY random() LIMIT $3`, [req.user!.id, b.tag, count])
      : await query<any>(`SELECT * FROM contacts WHERE user_id=$1 AND status='active' ORDER BY random() LIMIT $2`, [req.user!.id, count]);
  if (!contacts.length) throw badRequest('There is nobody in that audience to sample');
  const full = (await getAccount(acc.id))!;
  try {
    res.json(await sampleHeldRate(full, { brief: b.brief, instructions: b.instructions, exemplar: b.exemplar, contacts }));
  } catch (e) {
    if (e instanceof BriefIncompleteError) throw badRequest(e.message);
    throw e;
  }
});

/**
 * When this campaign's mail actually lands, over everybody on it.
 *
 * The dry run places one contact's steps on real dates. This places
 * everybody's, under the daily cap they all share, which is the only way to
 * see the thing that decides whether a campaign is the right shape: when the
 * last person hears from it at all, and when the follow-ups start queueing in
 * front of the people who have not been written to yet.
 */
sequencesRouter.get('/:id/projection', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  const projection = await projectCampaign(id);
  if (!projection) throw badRequest('Give the campaign a sending account and at least one email step first');
  res.json(projection);
});

// The third step of the golden path: see what the model actually wrote for the
// first few people on the list, before the campaign exists. Nothing is stored
// and nothing is enrolled — this is the look before the leap.
sequencesRouter.post('/campaign-preview', requireCapability('ai.campaigns'), async (req, res) => {
  const b = parse(z.object({
    account_id: z.number().int(),
    brief: z.string().min(10).max(4000),
    instructions: z.string().max(2000).optional(),
    tag: z.string().max(120).optional(),
    contactIds: z.array(z.number().int()).max(10).optional(),
    exemplar: z.string().max(20000).optional(),
    // Three is the number the golden path calls for. Capped rather than
    // exposed as a setting: more than a handful is a slow page, and the
    // question a preview answers — "is this right?" — is answered by three.
    count: z.number().int().min(1).max(5).optional(),
  }), req.body);
  const acc = await getUserAccount(req.user!.id, b.account_id);
  if (!acc) throw notFound('Account not found');
  const count = b.count ?? 3;
  const contacts = b.contactIds?.length
    ? await query<any>('SELECT * FROM contacts WHERE user_id=$1 AND id = ANY($2) LIMIT $3', [req.user!.id, b.contactIds, count])
    : b.tag
      ? await query<any>(`SELECT * FROM contacts WHERE user_id=$1 AND $2 = ANY(tags) AND status='active' ORDER BY id LIMIT $3`, [req.user!.id, b.tag, count])
      : await query<any>(`SELECT * FROM contacts WHERE user_id=$1 AND status='active' ORDER BY id LIMIT $2`, [req.user!.id, count]);
  if (!contacts.length) throw badRequest('There is nobody in that audience to preview');
  const full = (await getAccount(acc.id))!;
  try {
    res.json({ previews: await previewCampaign(full, { brief: b.brief, instructions: b.instructions, exemplar: b.exemplar, contacts }) });
  } catch (e) {
    // A hole in the brief is something to fix, not a server error.
    if (e instanceof BriefIncompleteError) throw badRequest(e.message);
    throw e;
  }
});
