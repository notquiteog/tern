import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { publish } from '../events.js';
import { rateLimit } from '../util/rateLimit.js';
import { requireCapability } from '../services/capabilities.js';
import { powGuard } from '../services/workGuard.js';
import { getAccount } from '../services/accounts.js';
import { composeAndSend } from '../services/compose.js';
import { openEmail, openEmailWith, openReview, openReviewWith, sealReview } from '../services/mailVault.js';
import { dataKey, openWith, seal } from '../services/vault.js';
import { describeHits, findTemplateArtifacts, type GuardHit, type GuardInput } from '../ai/guard.js';
import { generateResponderReply, personalize, renderStep } from '../workers/scheduler.js';
import { recordEdit } from '../services/voiceLearning.js';
import { allowed } from '../services/capabilities.js';

export const reviewRouter = Router();
reviewRouter.use(requireAuth);

/**
 * The structured findings behind a hold, if there are any.
 *
 * Sealed, like everything else on the row that quotes the message. An item
 * queued before the column existed has none, and the prose `hold_reason` is
 * still there for a person to read — so the fix buttons simply do not appear
 * for it rather than the page failing to load.
 */
function openHoldHits(dek: Buffer, sealed: unknown): GuardHit[] {
  if (!sealed) return [];
  try {
    const raw = openWith(dek, sealed);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed as GuardHit[] : [];
  } catch { return []; }
}

/**
 * The correction a hit needs, where one can be worked out without a model.
 *
 * The guard has always named the problem and never offered the answer, although
 * for two of the four kinds the answer is mechanical: an unfilled `{{company}}`
 * has a real value sitting on the contact record this draft was written for,
 * and a bracketed placeholder is a line somebody has to delete. Only the
 * remaining kinds — an invented figure, an "as an AI" line — need writing again.
 */
function fixesFor(hits: GuardHit[], contact: Record<string, unknown> | null): { kind: string; sample: string; fix: 'fill' | 'remove' | 'rewrite'; value?: string }[] {
  const out: { kind: string; sample: string; fix: 'fill' | 'remove' | 'rewrite'; value?: string }[] = [];
  for (const h of hits) {
    if (h.kind === 'merge_field') {
      const field = h.sample.replace(/[{}]/g, '').split('|')[0]!.trim().toLowerCase();
      // The merge vocabulary the templates use, mapped onto the contact
      // columns it is filled from. A field with a fallback (`{{first_name|there}}`)
      // has already been handled by the merge engine and would not be a hit.
      const value = field === 'first_name' ? contact?.first_name
        : field === 'last_name' ? contact?.last_name
          : field === 'company' ? contact?.company
            : field === 'title' ? contact?.title
              : field === 'email' ? contact?.email
                : (contact?.fields as Record<string, unknown> | undefined)?.[field];
      const text = value === null || value === undefined ? '' : String(value).trim();
      out.push(text ? { kind: h.kind, sample: h.sample, fix: 'fill', value: text } : { kind: h.kind, sample: h.sample, fix: 'rewrite' });
      continue;
    }
    if (h.kind === 'placeholder') { out.push({ kind: h.kind, sample: h.sample, fix: 'remove' }); continue; }
    out.push({ kind: h.kind, sample: h.sample, fix: 'rewrite' });
  }
  return out;
}

reviewRouter.get('/', async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*, c.email, c.first_name, c.last_name, c.company, c.title AS contact_title, c.fields AS contact_fields, c.notes AS contact_notes, s.name AS sequence_name, s.id AS sequence_id, a.email AS account_email, st.position AS step_position, rp.name AS responder_name,
            -- The thread the reply belongs to, so the queue can offer the
            -- conversation rather than only a two-line quotation of it.
            -- Deciding whether a draft is right usually means reading what
            -- it is answering.
            (SELECT x.thread_id FROM emails x WHERE x.id=r.reply_to_email_id) AS thread_id,
            (SELECT jsonb_build_object('subject', x.subject, 'from', x.from_addr, 'preview', x.preview, 'received_at', x.received_at) FROM emails x WHERE x.id=r.reply_to_email_id) AS original
     FROM review_queue r LEFT JOIN contacts c ON c.id=r.contact_id LEFT JOIN enrollments e ON e.id=r.enrollment_id LEFT JOIN sequences s ON s.id=e.sequence_id JOIN accounts a ON a.id=r.account_id LEFT JOIN sequence_steps st ON st.id=r.step_id LEFT JOIN responders rp ON rp.id=r.responder_id
     WHERE r.user_id=$1 AND r.status='pending' ORDER BY r.created_at`,
    [req.user!.id],
  );
  // Both the queued reply and the `original` it answers are sealed.
  const dek = await dataKey(req.user!.id);
  const items = rows.map((r) => openReviewWith(dek, r));
  for (const r of items) {
    // What the guard found, and what would put it right. The queue has always
    // been able to say why a draft was held and never what to do about it,
    // although for an unfilled merge field the value is on the contact row two
    // columns to the left of the complaint.
    const hits = openHoldHits(dek, (r as any).hold_hits);
    (r as any).hold_hits = hits;
    (r as any).fixes = hits.length
      ? fixesFor(hits, { first_name: (r as any).first_name, last_name: (r as any).last_name, company: (r as any).company, email: (r as any).email, title: (r as any).contact_title, fields: (r as any).contact_fields })
      : [];
    if (!r.original) continue;
    const o = openEmailWith(dek, { subject: r.original.subject, preview: r.original.preview, from_addr: r.original.from });
    r.original = { ...r.original, subject: o.subject, preview: o.preview, from: o.from_addr };
  }
  res.json({ items });
});

// ---------- Not like that: try again ----------
//
// The queue could approve, hand-edit, or reject. A draft that is nearly right
// needs a sentence of steering, and giving it meant rewriting the thing by
// hand — at which point the responder that produced it saved nobody any time,
// and the queue is a chore rather than a tool.
//
// Two things make the second attempt better than a re-roll of the first:
//
//   **The note.** What the person actually wants changed, in their words,
//   appended to whatever instructions the responder or the step already
//   carries.
//
//   **The reason it was held.** The guard knows precisely what was wrong — an
//   unfilled merge field, a bracketed placeholder, a claimed attachment that
//   does not exist — and telling the model "you promised an attachment there
//   is not one of" fixes the actual failure, where asking again without it
//   rolls the dice on the same prompt.
//
// The result replaces the item in place and stays pending. Nothing is sent and
// nothing is decided: this is still a draft in a queue, and it still needs the
// same button it needed before.
reviewRouter.post(
  '/:id/regenerate',
  requireCapability('ai.compose'),
  powGuard('ai'),
  rateLimit({ name: 'review-regen', perMinute: 12, message: 'Still writing the last one; wait a moment' }),
  async (req, res) => {
    const id = idParam(String(req.params.id));
    const { note } = parse(z.object({ note: z.string().max(2000).default('') }), req.body);
    const stored = await one<any>(`SELECT * FROM review_queue WHERE id=$1 AND user_id=$2 AND status='pending'`, [id, req.user!.id]);
    if (!stored) throw notFound('Review item not found, or already decided');
    const item = (await openReview(req.user!.id, stored))!;
    const acc = await getAccount(item.account_id);
    if (!acc) throw notFound('Account not found');

    // What the guard said, turned back into an instruction. `hold_hits` carries
    // the structured findings; `hold_reason` is the prose fallback for an item
    // queued before that column existed.
    const hits = openHoldHits(await dataKey(req.user!.id), stored.hold_hits);
    const fix = hits.length
      ? `The previous attempt was held back because of this: ${describeHits(hits)}. Do not repeat it.`
      : stored.hold_reason
        ? `The previous attempt was held back: ${String(stored.hold_reason).replace(/^Held for review:\s*/i, '')}. Do not repeat it.`
        : '';
    const steer = [note.trim(), fix].filter(Boolean).join('\n');
    if (!steer) throw badRequest('Say what you want changed');

    let subject: string;
    let html: string;
    let model: string;
    // What this regeneration was allowed to know, and who it is allowed to
    // greet. Carried out of the generator and handed to the guard below.
    //
    // Leaving it out is not a smaller check, it is a different one: without
    // `specifics` the guard looks for placeholders and prompt leakage and
    // never asks whether a figure in the body was ever given to the model. A
    // regeneration steered with "mention the callout rate" duly invented a
    // flat fee of £45 a shift, and the queue passed it as clean — which is
    // precisely the failure `findInventedSpecifics` was written for, and
    // exactly the one the README says is worse than a leftover placeholder,
    // because a placeholder gets reviewed and a price gets sent.
    let expectation: Pick<GuardInput, 'greeting' | 'specifics'> = {};

    if (item.kind === 'reply') {
      // A responder reply, regenerated through exactly the path that made it —
      // so the addressing rules, the thread packing and the greeting check are
      // the ones that already govern this feature, rather than a second
      // implementation that could disagree with the first.
      const responder = item.responder_id ? await one<any>('SELECT * FROM responders WHERE id=$1', [item.responder_id]) : null;
      if (!responder) throw badRequest('The responder behind this draft has been deleted, so it cannot be written again. Edit it by hand or reject it.');
      const email = await one<any>('SELECT * FROM emails WHERE id=$1 AND account_id=$2', [item.reply_to_email_id, acc.id]);
      if (!email) throw badRequest('The message this was answering is no longer in the cache.');
      const opened = await openEmail(req.user!.id, 'ai.responders', email);
      const gen = await generateResponderReply(
        { ...responder, instructions: [responder.instructions, steer].filter(Boolean).join('\n') },
        acc,
        opened,
      );
      subject = gen.subject; html = gen.html; model = gen.model;
      expectation = gen.guard;
    } else {
      // A sequence step, re-personalised. Same path as the scheduler's.
      if (!item.step_id || !item.enrollment_id) throw badRequest('This draft did not come from a sequence step, so it cannot be written again. Edit it by hand.');
      // Scoped through the sequence, which is the row that carries the owner:
      // `enrollments` has no user_id of its own. The review item was already
      // fetched by (id, user_id), so this is the belt to that braces — an
      // enrollment reached by id alone would be a way to regenerate against
      // somebody else's step.
      const step = await one<any>('SELECT * FROM sequence_steps WHERE id=$1', [item.step_id]);
      const enr = await one<any>(
        `SELECT e.* FROM enrollments e JOIN sequences s ON s.id=e.sequence_id
          WHERE e.id=$1 AND s.user_id=$2`,
        [item.enrollment_id, req.user!.id],
      );
      const contact = await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [item.contact_id, req.user!.id]);
      const seq = enr ? await one<any>('SELECT * FROM sequences WHERE id=$1 AND user_id=$2', [enr.sequence_id, req.user!.id]) : null;
      if (!step || !enr || !contact || !seq) throw badRequest('The sequence step behind this draft is gone. Edit it by hand or reject it.');
      const rendered = await renderStep(acc, seq, step, contact, enr);
      const gen = await personalize(acc, { ...step, ai_instructions: [step.ai_instructions, steer].filter(Boolean).join('\n') }, contact, rendered);
      subject = gen.subject; html = gen.html; model = gen.model;
      expectation = {
        greeting: { first: gen.greetingFirst, forbidden: [acc.name] },
        // A campaign email carries no attachment, so "as attached" in one is
        // always a promise it cannot keep. The same terms the scheduler sets.
        specifics: { facts: gen.facts, hasAttachment: false },
      };
    }

    // Checked again, because a second attempt is exactly as capable of leaving
    // a placeholder in as the first was — and the point of this route is to
    // fix that class of problem, not to become a way around the check.
    const again = findTemplateArtifacts({ subject, html, ...expectation });
    const sealed = await sealReview(req.user!.id, { subject, body_html: html });
    await query(
      `UPDATE review_queue SET subject=$2, body_html=$3, ai_model=$4, hold_reason=$5, hold_hits=$6 WHERE id=$1`,
      [
        id, sealed.subject, sealed.body_html, model,
        again.length ? `Held for review: ${describeHits(again)}` : null,
        again.length ? await seal(req.user!.id, JSON.stringify(again)) : null,
      ],
    );
    res.json({
      subject,
      body_html: html,
      ai_model: model,
      hold_reason: again.length ? `Held for review: ${describeHits(again)}` : null,
      hold_hits: again,
    });
  },
);

/**
 * Keep a steering note, so a fix for one draft is a fix for the rest.
 *
 * "Not like that — stop calling it a solution" fixes the draft in front of you
 * and is then thrown away, so the next forty drafts from the same step call it
 * a solution and you type the same sentence forty times. The step's
 * `ai_instructions` is the field that actually changes what gets written, and
 * this appends the note to it.
 *
 * Appends rather than replaces, and returns the result, because instructions
 * are cumulative and somebody who has tuned a step over a week should not lose
 * that to a one-line correction. The step editor is the place to prune them.
 */
reviewRouter.post('/:id/keep-note', async (req, res) => {
  const id = idParam(req.params.id);
  const { note } = parse(z.object({ note: z.string().min(1).max(2000) }), req.body);
  const item = await one<any>('SELECT * FROM review_queue WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  if (!item) throw notFound('Review item not found');
  const line = note.trim().replace(/\s+/g, ' ').slice(0, 500);
  if (!line) throw badRequest('Say what you want changed');

  // A responder draft and a sequence draft keep their notes in different
  // columns on different tables; both are the field the generator is handed.
  if (item.kind === 'reply' && item.responder_id) {
    const r = await one<{ instructions: string }>(
      // Scoped by user_id: a responder id off a request must not be able to
      // reach somebody else's row.
      `UPDATE responders SET instructions = trim(both E'\n' from coalesce(instructions,'') || E'\n' || $3), updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING instructions`,
      [item.responder_id, req.user!.id, line],
    );
    if (!r) throw notFound('That responder has been deleted');
    return res.json({ ok: true, target: 'responder', instructions: r.instructions });
  }
  if (!item.step_id) throw badRequest('This draft did not come from a sequence step or a responder');
  const step = await one<{ instructions: string }>(
    // Through the sequence, which is the row that carries the owner:
    // `sequence_steps` has no user_id of its own.
    `UPDATE sequence_steps st SET ai_instructions = trim(both E'\n' from coalesce(st.ai_instructions,'') || E'\n' || $3)
       FROM sequences s WHERE st.id=$1 AND s.id=st.sequence_id AND s.user_id=$2
       RETURNING st.ai_instructions AS instructions`,
    [item.step_id, req.user!.id, line],
  );
  if (!step) throw notFound('That step has been deleted');
  res.json({ ok: true, target: 'step', instructions: step.instructions });
});

/**
 * How long an approval can be taken back.
 *
 * The same reasoning as undo send: the decision is reversible for exactly as
 * long as nothing has left, and saying so plainly is better than a window
 * somebody has to guess at. Fifteen seconds is a shade under the scheduler's
 * tick, so in practice the draft is still sitting where it was.
 */
export const UNDO_SECONDS = 15;

/**
 * Put an approved draft back in the queue.
 *
 * Approvals wait for a send slot anyway, so the window costs nothing and the
 * mis-click it catches — approving the draft above the one you meant, on a
 * page built for working quickly — is otherwise unrecoverable.
 *
 * The guard is not the clock but the send: a draft that has gone out cannot be
 * recalled, whatever the stopwatch says, so the revert is conditional on there
 * being no send for this enrollment and step. The enrollment goes back to
 * waiting_review, which is where approving it took it from.
 */
reviewRouter.post('/:id/undo', async (req, res) => {
  const id = idParam(req.params.id);
  const item = await one<any>(`SELECT * FROM review_queue WHERE id=$1 AND user_id=$2`, [id, req.user!.id]);
  if (!item) throw notFound('Review item not found');
  if (item.status !== 'approved') throw badRequest('That draft was not approved');
  // A responder reply is sent inside the approval itself, so there is nothing
  // to put back. Said plainly rather than failing quietly.
  if (item.kind === 'reply' || !item.enrollment_id) throw badRequest('That reply has already gone out and cannot be recalled');

  const sent = await one(
    `SELECT 1 FROM send_log WHERE enrollment_id=$1 AND step_id IS NOT DISTINCT FROM $2 AND sent_at >= $3`,
    [item.enrollment_id, item.step_id, item.decided_at],
  );
  if (sent) throw badRequest('That one has already been sent');

  // Conditional on both rows still being where the approval left them, so a
  // scheduler tick that claimed the step a millisecond ago wins rather than
  // being quietly overwritten.
  const back = await query<{ id: number }>(
    `UPDATE review_queue SET status='pending', decided_at=NULL WHERE id=$1 AND status='approved' RETURNING id`,
    [id],
  );
  if (!back.length) throw badRequest('That one has already been sent');
  await query(
    `UPDATE enrollments SET status='waiting_review', next_run_at=NULL, updated_at=now() WHERE id=$1 AND status='active'`,
    [item.enrollment_id],
  );
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [req.user!.id]);
  publish({ type: 'review', userId: req.user!.id, count: pending?.n ?? 0 });
  res.json({ ok: true, pending: pending?.n ?? 0 });
});

// ---------- Deciding a lot of them at once ----------
//
// Every item was decided one at a time, which is fine for three and absurd for
// the twenty near-identical bad drafts a misfiring responder produces in an
// afternoon. The filters on the page already group them the way somebody wants
// to act on them — by responder, by campaign, by what the guard flagged — so
// this takes a list of ids and applies one decision across it.
//
// It runs the ordinary single decision for each, rather than a bulk UPDATE:
// approving a reply sends it, approving a sequence step un-parks an enrollment,
// and a second code path for the same decisions would be a second place for
// those side effects to be forgotten.
reviewRouter.post('/bulk', async (req, res) => {
  const b = parse(z.object({
    ids: z.array(z.number().int()).min(1).max(200),
    action: z.enum(['approve', 'reject']),
  }), req.body);
  let done = 0;
  const failed: { id: number; error: string }[] = [];
  for (const id of b.ids) {
    try {
      if (await decide(req.user!.id, id, b.action)) done++;
    } catch (e) {
      // One bad item does not stop the rest. A queue of twenty where the
      // fourth has a deleted account is still nineteen decisions somebody
      // wanted made.
      failed.push({ id, error: (e as Error)?.message ?? 'it failed' });
    }
  }
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [req.user!.id]);
  publish({ type: 'review', userId: req.user!.id, count: pending?.n ?? 0 });
  res.json({ done, failed, pending: pending?.n ?? 0 });
});

/**
 * One decision, applied.
 *
 * Lifted out of the route so `/bulk` runs exactly this and not a bulk UPDATE
 * that looks equivalent: approving a reply *sends* it, and approving a sequence
 * step un-parks an enrollment. Those side effects are the decision, and a
 * second path that only moved the status column would silently drop them.
 *
 * Returns false for an item that has already been decided, so a bulk call over
 * a stale selection reports what it really did.
 */
/**
 * Keep a queue edit beside the draft it replaced, when the two differ.
 *
 * Behind the writing-help capability like the composer's own version, because
 * it is the same capability's output being corrected, and never allowed to
 * throw: an approval that failed because a learning table was busy would be an
 * absurd trade for a suggestion nobody has asked for yet. `recordEdit` does
 * the rest of the filtering — an untouched draft teaches nothing and is
 * dropped there rather than here.
 */
async function rememberQueueEdit(userId: number, item: { body_html?: string | null; kind?: string | null }, edit?: { body_html?: string }): Promise<void> {
  try {
    if (!edit?.body_html || !item.body_html) return;
    if (!(await allowed(userId, 'ai.compose'))) return;
    await recordEdit(userId, {
      accountId: null,
      // A campaign draft and a reply are different writing problems, and the
      // suggestion prompt is shown which of the two each example came from.
      mode: item.kind === 'reply' ? 'responder' : 'campaign',
      generated: item.body_html,
      sent: edit.body_html,
    });
  } catch { /* learning is never worth failing an approval for */ }
}

async function decide(
  userId: number,
  id: number,
  action: 'approve' | 'reject',
  edit?: { subject?: string; body_html?: string },
): Promise<boolean> {
  const stored = await one<any>('SELECT * FROM review_queue WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!stored) throw notFound('Review item not found');
  if (stored.status !== 'pending') return false;
  const item = (await openReview(userId, stored))!;
  if (action === 'approve') {
    // An edit made here is the most direct evidence there is of how a campaign
    // should sound.
    //
    // The writing-voice pass has only ever been fed from the composer's send
    // path, so the one place where somebody sits and rewrites a model's draft
    // on purpose — this queue, one message after another, before approving
    // each one — taught it nothing at all. The pair is exactly the pair it
    // wants: what the model wrote is on the stored row, and what the person
    // approved is in the request.
    //
    // Before the update, because the update overwrites the first half of it.
    await rememberQueueEdit(userId, item, edit);
    // What the person edited comes back in the clear and is sealed again.
    const edited = await sealReview(userId, { subject: edit?.subject ?? item.subject ?? '', body_html: edit?.body_html ?? item.body_html ?? '' });
    await query(`UPDATE review_queue SET status='approved', subject=$2, body_html=$3, decided_at=now() WHERE id=$1`, [id, edited.subject, edited.body_html]);
    if (item.kind === 'reply') {
      // An approved auto-reply goes out now, through the account's pacing if the responder asked for it.
      const acc = await getAccount(item.account_id);
      const responder = item.responder_id ? await one<any>('SELECT * FROM responders WHERE id=$1', [item.responder_id]) : null;
      if (acc) {
        const payload = { to: item.to_addr, subject: edit?.subject ?? item.subject, html: edit?.body_html ?? item.body_html, replyToEmailId: item.reply_to_email_id, kind: 'auto_reply', contactId: item.contact_id, responderId: item.responder_id, includeSignature: true, encrypt: 'if_possible', reviewed: true };
        if (responder?.humanize) await query('INSERT INTO outbox (user_id, account_id, payload, send_at) VALUES ($1,$2,$3,now())', [acc.user_id, acc.id, await seal(acc.user_id, JSON.stringify({ ...payload, humanize: true }))]);
        else await composeAndSend(acc, payload as any);
      }
    } else if (item.enrollment_id) {
      // A few seconds' grace, so "undo" has something to undo.
      //
      // The scheduler ticks every twenty seconds and then has to reserve a
      // send slot behind a randomised gap, so an approved step was never going
      // out immediately anyway — this only makes the delay that already
      // existed into a guaranteed one, and costs a campaign nothing.
      await query(`UPDATE enrollments SET status='active', next_run_at=now() + interval '${UNDO_SECONDS} seconds', updated_at=now() WHERE id=$1 AND status='waiting_review'`, [item.enrollment_id]);
    }
  } else {
    await query(`UPDATE review_queue SET status='rejected', decided_at=now() WHERE id=$1`, [id]);
    if (item.enrollment_id) await query(`UPDATE enrollments SET status='paused', updated_at=now() WHERE id=$1 AND status='waiting_review'`, [item.enrollment_id]);
  }
  return true;
}

reviewRouter.post('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ action: z.enum(['approve', 'reject']), subject: z.string().max(998).optional(), body_html: z.string().max(500000).optional() }), req.body);
  await decide(req.user!.id, id, b.action, { subject: b.subject, body_html: b.body_html });
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [req.user!.id]);
  publish({ type: 'review', userId: req.user!.id, count: pending?.n ?? 0 });
  res.json({ ok: true, pending: pending?.n ?? 0 });
});
