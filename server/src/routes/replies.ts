// The Replies tab, and the four things it can do about a reply.
//
// Its own router rather than another branch of /api/sequences, because the
// question "what came back" is asked of one campaign on its page and of all
// of them on Home and in the brief, and a route that has to be registered
// before `/:id` to stop `replies` being parsed as a sequence id is a trap
// waiting for the next person to add an endpoint.
//
// Every action here ends in something a person confirms. `referral` creates a
// contact and stops; enrolling them is a second, explicit step, because the
// address in a "wrong person" reply was read out of a sentence by a regular
// expression and mailing it automatically is exactly the behaviour that gets
// a sending domain blocked.
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { getReply, listReplies, markHandled, replyCounts, REENROLL_DAYS } from '../services/campaignReplies.js';
import { REPLY_INTENTS } from '../services/replyIntent.js';
import { contactBlind } from '../services/mailVault.js';
import { publish } from '../events.js';

export const repliesRouter = Router();
repliesRouter.use(requireAuth);

repliesRouter.get('/', async (req, res) => {
  const sequenceId = req.query.sequenceId ? idParam(String(req.query.sequenceId)) : undefined;
  const rawIntent = String(req.query.intent ?? '');
  const intent = (REPLY_INTENTS as readonly string[]).includes(rawIntent) ? rawIntent as typeof REPLY_INTENTS[number] : undefined;
  const handled = String(req.query.handled ?? '') === '1';
  const page = Math.max(1, Number(req.query.page ?? 1));
  const size = 50;
  // A campaign that has been deleted takes its replies with it, so the
  // ownership check is the user_id the service already filters on.
  const replies = await listReplies(req.user!.id, { sequenceId, intent, handled, limit: size, offset: (page - 1) * size });
  res.json({ replies, counts: await replyCounts(req.user!.id, sequenceId), page, size });
});

repliesRouter.post('/:id/handled', async (req, res) => {
  const id = idParam(req.params.id);
  const { handled } = parse(z.object({ handled: z.boolean().default(true) }), req.body);
  await markHandled(req.user!.id, id, handled);
  res.json({ ok: true, counts: await replyCounts(req.user!.id) });
});

/**
 * Add the person a "wrong person" reply pointed at.
 *
 * The address comes from the request rather than from the parse, so that an
 * address the person corrected in the card is the one that gets saved — the
 * parser proposes, the card is editable, and what was on screen is what is
 * written. It is checked against the parse only to the extent of refusing an
 * address that is already suppressed.
 */
repliesRouter.post('/:id/referral', async (req, res) => {
  const id = idParam(req.params.id);
  const reply = await getReply(req.user!.id, id);
  if (!reply) throw notFound('Reply not found');
  const b = parse(z.object({
    email: z.string().email(),
    first_name: z.string().max(120).default(''),
    last_name: z.string().max(120).default(''),
    company: z.string().max(200).default(''),
    title: z.string().max(200).default(''),
    /** Enroll them in the campaign this reply came from, once created. */
    enroll: z.boolean().default(false),
  }), req.body);
  const email = b.email.toLowerCase();

  // Somebody who has already asked not to be contacted is not made a contact
  // because a third party named them.
  const supp = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND lower(email)=$2', [req.user!.id, email]);
  if (supp) throw badRequest('That address has unsubscribed or bounced before');

  // The company they were referred from is the best guess at their own, and
  // is only used when the card did not carry one.
  const company = b.company || reply.contact?.company || '';
  const existing = await one<{ id: number }>('SELECT id FROM contacts WHERE user_id=$1 AND lower(email)=$2', [req.user!.id, email]);
  let contactId: number;
  if (existing) {
    contactId = existing.id;
  } else {
    const row = await one<{ id: number }>(
      `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, source, consent_source, notes, email_blind)
       VALUES ($1,$2,$3,$4,$5,$6,'referral',$7,$8,$9) RETURNING id`,
      [
        req.user!.id, email, b.first_name, b.last_name, company, b.title,
        // Where the permission to write to them came from, in the words of
        // the person who gave it. This is the column a complaint is answered
        // with, so it says who pointed at them and when.
        `Referred by ${reply.contact?.email ?? 'a reply'}`,
        `Named in a reply from ${reply.contact?.email ?? 'a campaign reply'} on ${reply.repliedAt.slice(0, 10)}.`,
        await contactBlind(req.user!.id, email),
      ],
    );
    contactId = row!.id;
  }

  let enrolled = false;
  if (b.enroll && reply.sequenceId) {
    const seq = await one<{ id: number; account_id: number | null; status: string }>(
      'SELECT id, account_id, status FROM sequences WHERE id=$1 AND user_id=$2',
      [reply.sequenceId, req.user!.id],
    );
    if (!seq?.account_id) throw badRequest('That campaign has no sending account');
    const r = await query(
      `INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at)
       VALUES ($1,$2,$3,'active',0,now()) ON CONFLICT (sequence_id, contact_id) DO NOTHING RETURNING id`,
      [seq.id, contactId, seq.account_id],
    );
    enrolled = r.length > 0;
    if (enrolled) publish({ type: 'enrollment', userId: req.user!.id, sequenceId: seq.id, enrollmentId: r[0]!.id, status: 'active' });
  }

  // The reply has been acted on, so it leaves the queue.
  await markHandled(req.user!.id, id, true);
  res.json({ ok: true, contactId, enrolled, created: !existing, counts: await replyCounts(req.user!.id) });
});

/**
 * "Not now" taken at its word.
 *
 * The enrollment was finished when they replied, so this is a new one dated
 * forward rather than a resumption: the campaign starts again from its first
 * step, which is the right message to send somebody six weeks later.
 */
repliesRouter.post('/:id/reenroll', async (req, res) => {
  const id = idParam(req.params.id);
  const reply = await getReply(req.user!.id, id);
  if (!reply) throw notFound('Reply not found');
  if (!reply.contact) throw badRequest('That reply has no contact to re-enroll');
  if (!reply.sequenceId) throw badRequest('That reply is not from a campaign');
  const { days } = parse(z.object({ days: z.number().int().min(1).max(365).default(REENROLL_DAYS) }), req.body);

  const supp = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND lower(email)=$2', [req.user!.id, reply.contact.email.toLowerCase()]);
  if (supp) throw badRequest('That address has unsubscribed since');
  const seq = await one<{ id: number; account_id: number | null }>('SELECT id, account_id FROM sequences WHERE id=$1 AND user_id=$2', [reply.sequenceId, req.user!.id]);
  if (!seq?.account_id) throw badRequest('That campaign has no sending account');

  const at = new Date(Date.now() + days * 86_400_000);
  // Replacing the finished enrollment rather than adding a second one: the
  // table's unique key is (sequence, contact) and the history of the first
  // run is in send_log, which is where it belongs.
  const r = await query<{ id: number }>(
    `INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at)
     VALUES ($1,$2,$3,'active',0,$4)
     ON CONFLICT (sequence_id, contact_id) DO UPDATE
       SET status='active', current_step=0, next_run_at=$4, error=NULL, finished_at=NULL, updated_at=now()
     RETURNING id`,
    [seq.id, reply.contact.id, seq.account_id, at],
  );
  // A contact marked 'replied' is not writable-to by the enroll path, so the
  // status goes back to active along with the enrollment.
  await query(`UPDATE contacts SET status='active', updated_at=now() WHERE id=$1 AND user_id=$2 AND status='replied'`, [reply.contact.id, req.user!.id]);
  await markHandled(req.user!.id, id, true);
  if (r[0]) publish({ type: 'enrollment', userId: req.user!.id, sequenceId: seq.id, enrollmentId: r[0].id, status: 'active' });
  res.json({ ok: true, at: at.toISOString(), counts: await replyCounts(req.user!.id) });
});
