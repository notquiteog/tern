import { Router } from 'express';
import { one, query, withTx } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { getUserAccount } from '../services/accounts.js';
import { renderStep } from '../workers/scheduler.js';
import { publish } from '../events.js';

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

sequencesRouter.post('/', async (req, res) => {
  const b = parse(seqSchema, req.body);
  if (b.account_id && !(await getUserAccount(req.user!.id, b.account_id))) throw badRequest('Account not found');
  const seq = await withTx(async (c) => {
    const r = await c.query('INSERT INTO sequences (user_id, name, description, account_id, stop_on_reply, ai_mode, unsubscribe_footer, encrypt_pgp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [req.user!.id, b.name, b.description, b.account_id ?? null, b.stop_on_reply, b.ai_mode, b.unsubscribe_footer, b.encrypt_pgp]);
    const s = r.rows[0];
    let pos = 0;
    for (const st of b.steps ?? []) {
      await c.query('INSERT INTO sequence_steps (sequence_id, position, kind, template_id, subject, body_html, wait_days, wait_hours, ai_personalize, ai_instructions, reply_in_thread) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [s.id, pos++, st.kind, st.template_id ?? null, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.reply_in_thread]);
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
  res.json({ sequence: s, steps, stepStats });
});

sequencesRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  const b = parse(seqUpdateSchema, req.body);
  if (b.account_id && !(await getUserAccount(req.user!.id, b.account_id))) throw badRequest('Account not found');
  await withTx(async (c) => {
    await c.query(`UPDATE sequences SET name=COALESCE($3,name), description=COALESCE($4,description), account_id=COALESCE($5,account_id), stop_on_reply=COALESCE($6,stop_on_reply), ai_mode=COALESCE($7,ai_mode), unsubscribe_footer=COALESCE($8,unsubscribe_footer), encrypt_pgp=COALESCE($9,encrypt_pgp), updated_at=now() WHERE id=$1 AND user_id=$2`, [id, req.user!.id, b.name ?? null, b.description ?? null, b.account_id ?? null, b.stop_on_reply ?? null, b.ai_mode ?? null, b.unsubscribe_footer ?? null, b.encrypt_pgp ?? null]);
    if (b.steps) {
      // Replace the step list, keeping ids that still exist so send_log
      // history and in-flight enrollments keep pointing at the right step.
      const keep: number[] = [];
      let pos = 0;
      for (const st of b.steps) {
        if (st.id) {
          const r = await c.query('UPDATE sequence_steps SET position=$3, kind=$4, template_id=$5, subject=$6, body_html=$7, wait_days=$8, wait_hours=$9, ai_personalize=$10, ai_instructions=$11, reply_in_thread=$12 WHERE id=$1 AND sequence_id=$2 RETURNING id', [st.id, id, pos, st.kind, st.template_id ?? null, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.reply_in_thread]);
          if (r.rows.length) { keep.push(st.id); pos++; continue; }
        }
        const r = await c.query('INSERT INTO sequence_steps (sequence_id, position, kind, template_id, subject, body_html, wait_days, wait_hours, ai_personalize, ai_instructions, reply_in_thread) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [id, pos++, st.kind, st.template_id ?? null, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.reply_in_thread]);
        keep.push(r.rows[0].id);
      }
      await c.query('DELETE FROM sequence_steps WHERE sequence_id=$1 AND NOT (id = ANY($2))', [id, keep]);
    }
  });
  res.json({ ok: true });
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
  await query('UPDATE sequences SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
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
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments e WHERE ${where}`, params);
  const rows = await query<any>(
    `SELECT e.*, c.email, c.first_name, c.last_name, c.company, (SELECT count(*)::int FROM send_log l WHERE l.enrollment_id=e.id AND l.status='sent') AS sent_count
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

sequencesRouter.post('/:id/enrollments-bulk', async (req, res) => {
  const id = idParam(req.params.id);
  await seqOf(req.user!.id, id);
  const { action, status } = parse(z.object({ action: z.enum(['pause', 'resume', 'remove']), status: z.string().optional() }), req.body);
  const params: unknown[] = [id];
  let filter = '';
  if (status) { params.push(status); filter = ` AND status=$${params.length}`; }
  if (action === 'pause') await query(`UPDATE enrollments SET status='paused', updated_at=now() WHERE sequence_id=$1 AND status IN ('active','waiting_review')${filter}`, params);
  if (action === 'resume') await query(`UPDATE enrollments SET status='active', next_run_at=COALESCE(next_run_at, now()), error=NULL, updated_at=now() WHERE sequence_id=$1 AND status IN ('paused','error')${filter}`, params);
  if (action === 'remove') await query(`DELETE FROM enrollments WHERE sequence_id=$1${filter ? filter : " AND status NOT IN ('active','waiting_review')"}`, params);
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
  const out = [];
  for (const st of steps) {
    if (st.kind === 'wait') { out.push({ step: st, kind: 'wait' }); continue; }
    const r = await renderStep(acc ?? ({ name: req.user!.display_name, email: 'you@example.com', id: 0 } as any), s, st, contact);
    out.push({ step: st, kind: 'email', subject: r.subject, html: r.html, brief: r.brief });
  }
  res.json({ preview: out });
});
