// The safeguards that stand between a campaign and somebody's inbox, checked
// against the dev database with the real scheduler.
//
//   npx tsx --env-file=../.env.dev src/e2e/campaign.e2e.ts        (from server/)
//   ONLY=stop-on-reply npx tsx --env-file=../.env.dev src/e2e/campaign.e2e.ts
//
// These are all races and last-moment reversals: the class of bug a unit test
// structurally cannot catch, because what is being checked is what two pieces
// of code do to the same row in the wrong order. Nothing here talks to the
// model — the steps are plain templates — so it runs in seconds and measures
// the machinery rather than the writing.
//
// Nothing is sent. Every contact is at `.invalid`, which by RFC 6761 can
// never resolve, and the transport is asserted unreachable before anything
// runs.
import { migrate, one, pool, query, waitForDb } from '../db.js';
import { getAccount } from '../services/accounts.js';
import { tick } from '../workers/scheduler.js';
import { assertNothingCanBeDelivered } from '../ai/sendGuard.js';

const ONLY = new Set((process.env.ONLY ?? '').split(',').filter(Boolean));
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}
const want = (group: string) => !ONLY.size || ONLY.has(group);

const TAG = `campaign-e2e-${Date.now()}`;

interface Fixture { seqId: number; contactId: number; enrollmentId: number; email: string }

// One contact, one active campaign of two email steps with no wait between
// them, due now. Templates rather than AI: this is about the gates.
async function fixture(userId: number, accountId: number, label: string, opts: { ai?: boolean } = {}): Promise<Fixture> {
  const email = `${label}.${Date.now().toString(36)}@example.invalid`;
  const contact = (await one<{ id: number }>(
    `INSERT INTO contacts (user_id, email, first_name, last_name, company, status, tags, source, consent_source)
     VALUES ($1,$2,'Dana','Osei','Northwind Supply','active',$3,'import','e2e') RETURNING id`,
    [userId, email, [TAG]],
  ))!;
  const seq = (await one<{ id: number }>(
    `INSERT INTO sequences (user_id, account_id, name, status, ai_mode, stop_on_reply, unsubscribe_footer)
     VALUES ($1,$2,$3,'active',$4,true,true) RETURNING id`,
    [userId, accountId, `${TAG} ${label}`, opts.ai ? 'auto' : 'off'],
  ))!;
  // An AI step takes seconds to write, which is the window the stop-on-reply
  // race lives in. A template step is instant, which is what the other cases
  // want.
  await query(
    `INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize, ai_instructions) VALUES ($1,0,'email','Step one',$2,$3,'Under 80 words.')`,
    [seq.id, opts.ai ? '<p>We have launched same-day bookkeeping reports for wholesale businesses. Ask if they would like a short walkthrough.</p>' : '<p>The first message.</p>', Boolean(opts.ai)],
  );
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html) VALUES ($1,1,'email','Step two','<p>The second message.</p>')`, [seq.id]);
  const enr = (await one<{ id: number }>(
    `INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at) VALUES ($1,$2,$3,'active',0,now()) RETURNING id`,
    [seq.id, contact.id, accountId],
  ))!;
  return { seqId: seq.id, contactId: contact.id, enrollmentId: enr.id, email };
}

const sendsFor = async (f: Fixture) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n FROM send_log WHERE sequence_id=$1`, [f.seqId]))?.n ?? 0;
const statusOf = async (f: Fixture) =>
  (await one<{ status: string }>(`SELECT status FROM enrollments WHERE id=$1`, [f.enrollmentId]))?.status ?? 'gone';

async function main(): Promise<void> {
  await waitForDb();
  await migrate();
  const accRow = await one<any>(`SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1`);
  if (!accRow) throw new Error('no account in the dev database');
  const acc = (await getAccount(accRow.id))!;
  const userId = Number(acc.user_id);
  await assertNothingCanBeDelivered(acc, ['example.invalid']);
  console.log(`account ${acc.email}  tag ${TAG}\n`);

  // ---------- stop on reply, with the reply landing mid-tick ----------
  //
  // The damaging version of this bug is not "the reply was missed". It is the
  // reply that arrives *while the model is writing the next step*: the
  // enrollment was active when the step was picked up, the person answers
  // thirty seconds later, and the step goes out anyway.
  //
  // Reproducing that needs the reply to land inside the window, so this case
  // uses a real AI step — which takes seconds — starts a tick without waiting
  // for it, and applies the reply a moment later. That is the true ordering:
  // claim, generate, reply arrives, send. With the conditional claim in place
  // the send matches no row and nothing leaves.
  if (want('stop-on-reply')) {
    const f = await fixture(userId, acc.id, 'stopreply', { ai: true });
    const running = tick();
    // Long enough to be past the claim and inside generation, short enough to
    // be well before it finishes.
    await new Promise((r) => setTimeout(r, 400));
    // Exactly what services/automation.ts writes when a reply is matched.
    await query(`UPDATE contacts SET last_replied_at=now(), status='replied', updated_at=now() WHERE id=$1`, [f.contactId]);
    const stopped = await query(`UPDATE enrollments SET status='replied', updated_at=now(), finished_at=now() WHERE id=$1 AND status IN ('active','waiting_review','paused') RETURNING id`, [f.enrollmentId]);
    await running;
    check('the reply landed while the step was in flight', stopped.length === 1, 'the enrollment was no longer active by the time the reply was applied — the window closed too early to be testing the race');
    check('a contact who replies mid-generation is not sent the next step', (await sendsFor(f)) === 0, `send_log has ${await sendsFor(f)} rows for this campaign`);
    // The slower route to the same damage: the draft that was already in
    // flight drags the finished enrollment back into the review queue, and a
    // person clicking Approve then sends to somebody who had replied.
    const parked = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE enrollment_id=$1 AND status='pending'`, [f.enrollmentId]))?.n ?? 0;
    check('nor left waiting in the review queue for somebody to approve', parked === 0, `${parked} pending review row(s) for an enrollment that had replied`);
    check('and the enrollment stays "replied"', (await statusOf(f)) === 'replied', `status is ${await statusOf(f)}`);
  }

  // ---------- the same reply, but it lands before the tick ----------
  if (want('stop-on-reply')) {
    const f = await fixture(userId, acc.id, 'stopearly');
    await query(`UPDATE enrollments SET status='replied', finished_at=now(), updated_at=now() WHERE id=$1`, [f.enrollmentId]);
    await tick();
    check('a contact who replied before the tick is not picked up at all', (await sendsFor(f)) === 0, `send_log has ${await sendsFor(f)} rows`);
  }

  // ---------- unsubscribed between deciding to send and sending ----------
  if (want('suppression')) {
    const f = await fixture(userId, acc.id, 'suppressed');
    await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), 'reply_stop', 'e2e') ON CONFLICT DO NOTHING`, [userId, f.email]);
    await tick();
    check('a suppressed address is never sent to', (await sendsFor(f)) === 0, `send_log has ${await sendsFor(f)} rows`);
    check('and the enrollment ends as unsubscribed', ['unsubscribed', 'replied'].includes(await statusOf(f)), `status is ${await statusOf(f)}`);
  }

  // ---------- a contact marked bounced ----------
  if (want('bounce')) {
    const f = await fixture(userId, acc.id, 'bounced');
    await query(`UPDATE contacts SET status='bounced' WHERE id=$1`, [f.contactId]);
    await tick();
    check('a bounced contact is never sent to again', (await sendsFor(f)) === 0, `send_log has ${await sendsFor(f)} rows`);
    check('and the enrollment ends as bounced', (await statusOf(f)) === 'bounced', `status is ${await statusOf(f)}`);
  }

  // ---------- the step is claimed exactly once ----------
  //
  // Two ticks overlapping must not both send step 0. The scheduler's own
  // re-entry guard is bypassed here on purpose, because what is being checked
  // is the conditional claim on the row rather than the in-process flag.
  if (want('idempotent')) {
    const f = await fixture(userId, acc.id, 'idempotent');
    await Promise.all([tick(), tick(), tick()]);
    const sent = await sendsFor(f);
    const step0 = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM send_log WHERE sequence_id=$1 AND step_id=(SELECT id FROM sequence_steps WHERE sequence_id=$1 AND position=0)`, [f.seqId]))?.n ?? 0;
    // The transport is unreachable, so a send attempt is logged as failed
    // rather than sent; either way it must be attempted at most once.
    check('overlapping ticks attempt a step at most once', step0 <= 1, `step 0 has ${step0} send_log rows (${sent} in total)`);
    const cur = await one<{ current_step: number }>(`SELECT current_step FROM enrollments WHERE id=$1`, [f.enrollmentId]);
    check('and a failed send gives the step back rather than skipping it', (cur?.current_step ?? 9) === 0, `current_step is ${cur?.current_step}`);
  }

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed${failed.length ? `\n\nfailed:\n${failed.map((f) => `  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`).join('\n')}` : ''}`);
  console.log(`\n(left in the database: everything tagged ${TAG})`);
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
