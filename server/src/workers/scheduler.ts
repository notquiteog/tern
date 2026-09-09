// Background work on a 20-second tick: sequence steps, scheduled sends,
// snoozed threads. Claims use guarded conditional updates so a second
// process (or an overlapping tick) can never send the same step twice.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { publish } from '../events.js';
import { getAccount, type AccountRow } from '../services/accounts.js';
import { composeAndSend, type ComposeInput } from '../services/compose.js';
import { contactContext, htmlToText, renderHtml, renderText, textToHtml } from '../services/merge.js';
import { jitterMs, reserveSendSlot, sendingBlocked } from '../services/sending.js';
import { chat, getAiSettings } from '../ai/llm.js';
import { buildMessages, cleanOutput, finalizeOutput, modeTuning, threadBudgetChars } from '../ai/prompts.js';
import { describeBriefProblems, describeHits, findBriefProblems, findTemplateArtifacts, type GuardInput } from '../ai/guard.js';
import { candidatesFromContact, resolveRecipient, type ResolvedName } from '../ai/names.js';
import { escapeHtml } from '../services/merge.js';
import * as actions from '../jmap/actions.js';
import { unsubscribeUrl } from '../services/compose.js';
import { replyRecipients, replySubject } from '../services/reply.js';
import { runRetention } from '../services/retention.js';
import { pushDirtyDrafts } from '../services/draftSync.js';
import { openEmail, openEmails, openReview, sealReview } from '../services/mailVault.js';
import { open, seal } from '../services/vault.js';
import { backfillBatch, backfillDraftsAndOutbox, backfillPending, categorizeBatch, categorizePending } from '../services/backfill.js';
import { enrichmentTick } from './enrichment.js';
import { retentionSettings, type RetentionPolicy } from '../services/retentionPolicy.js';

const log = logger('scheduler');
let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startScheduler(intervalMs = 20_000): void {
  timer = setInterval(() => void tick(), intervalMs);
  setTimeout(() => void tick(), 3000);
  log.info('scheduler started');
}
export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await housekeeping();
    await encryptCache();
    await fileCategories();
    await retention();
    await processSnoozes();
    await syncDrafts();
    await processOutbox();
    await processEnrollments();
    await processAiJobs();
    await enrichment();
  } catch (e) {
    log.error('tick failed', { err: (e as Error).message });
  } finally {
    ticking = false;
  }
}

// "Undo send" holds a message for a few seconds; waiting for the next
// 20-second tick would double that, so the outbox is woken at the exact
// moment instead. Claims are guarded, so overlapping with a tick is safe.
let wake: NodeJS.Timeout | null = null;
let wakeAt = Infinity;
export function wakeOutboxAt(when: Date): void {
  const at = when.getTime() + 250;
  if (at >= wakeAt) return;
  if (wake) clearTimeout(wake);
  wakeAt = at;
  wake = setTimeout(() => { wake = null; wakeAt = Infinity; void processOutbox().catch((e) => log.error('outbox wake failed', { err: (e as Error).message })); }, Math.max(0, at - Date.now()));
  wake.unref();
}

// ---------- Retention ----------
// Nothing is kept longer than the feature that needs it. Staged attachments
// live a day, sent outbox copies a week (the mailbox has the real copy),
// decided reviews and finished AI jobs a month, audit entries a year.
// Each sweep carries its own parameters. They used to share one array of
// seven, which meant every statement was handed seven values whatever it
// used: the ones with no placeholder were rejected outright, and the ones
// numbered from $2 up asked for a $1 that was never referenced. Postgres
// refused all twelve, so housekeeping silently deleted nothing at all.
// Exported so a test can check the two halves still agree.
export function housekeepingJobs(r: RetentionPolicy): [string, string, unknown[]][] {
  return [
      // A finished AI job still holds the prompt it was given, which is a copy
      // of somebody's mail sitting in a queue table for no reason. It is
      // emptied the moment the job stops running, before the row is anywhere
      // near old enough to delete.
      // The immediate wipe happens where a job finishes; this is the safety
      // net for a row that was left behind by a crash or an older build.
      // `result` is a one-line outcome and is kept — it is what an admin reads
      // when a responder did nothing and they want to know why.
      ['ai_job_payloads', `UPDATE ai_jobs SET payload='{}'::jsonb WHERE status IN ('done','failed','skipped') AND payload <> '{}'::jsonb`, []],
      // Staged files live a day unless a draft still refers to them, as an
      // attachment or as an image inserted into the body.
      ['uploads', `DELETE FROM uploads u WHERE u.created_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM drafts d WHERE u.id = ANY(d.attachment_ids) OR u.id = ANY(d.inline_upload_ids)) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.status IN ('scheduled','sending') AND u.id = ANY(o.upload_ids))`, []],
      ['outbox', `DELETE FROM outbox WHERE status IN ('sent','cancelled') AND created_at < now() - ($1 || ' days')::interval`, [r.outboxDays]],
      ['review_queue', `DELETE FROM review_queue WHERE status <> 'pending' AND decided_at < now() - ($1 || ' days')::interval`, [r.reviewDays]],
      ['ai_jobs', `DELETE FROM ai_jobs WHERE status IN ('done','failed','skipped') AND updated_at < now() - ($1 || ' hours')::interval`, [r.aiJobHours]],
      ['sessions', `DELETE FROM sessions WHERE expires_at < now()`, []],
      ['invites', `DELETE FROM invites WHERE (used_at IS NOT NULL AND used_at < now() - interval '30 days') OR (used_at IS NULL AND expires_at < now() - interval '30 days')`, []],
      ['audit_log', `DELETE FROM audit_log WHERE created_at < now() - ($1 || ' days')::interval`, [r.auditDays]],
      // A brief is a cache of a page. Past its window it is a description of a
      // mailbox that has moved on, and keeping it is only a copy of mail.
      ['briefs', `DELETE FROM briefs WHERE generated_at < now() - ($1 || ' days')::interval`, [r.briefDays]],
      // Closed commitments are history nobody asked for.
      ['commitments', `DELETE FROM commitments WHERE status <> 'open' AND closed_at < now() - ($1 || ' days')::interval`, [r.commitmentDays]],
      // A finished or abandoned import leaves only its counts.
      ['mail_imports', `DELETE FROM mail_imports WHERE status IN ('done','failed','cancelled') AND updated_at < now() - interval '7 days'`, []],
      // Invitations to meetings that are long past.
      ['calendar_events', `DELETE FROM calendar_events WHERE starts_at IS NOT NULL AND starts_at < now() - ($1 || ' days')::interval`, [r.calendarDays]],
  
  ];
}

let lastHousekeeping = 0;
export async function housekeeping(force = false): Promise<Record<string, number>> {
  if (!force && Date.now() - lastHousekeeping < 3600_000) return {};
  lastHousekeeping = Date.now();
  // Every window is a setting with a low default, and each is the shortest
  // the feature can actually work with. See services/retentionPolicy.ts for
  // what each one costs to shorten.
  const jobs = housekeepingJobs(await retentionSettings());
  const counts: Record<string, number> = {};
  for (const [name, sql, args] of jobs) {
    try { const rows = await query(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`, args); counts[name] = (rows[0] as any)?.n ?? 0; } catch (e) { log.warn(`housekeeping ${name} failed`, { err: (e as Error).message }); }
  }
  if (Object.values(counts).some((n) => n > 0)) log.info('housekeeping', counts);
  return counts;
}

// ---------- Encrypting the cache ----------
// An install upgrading from an unencrypted cache converts a batch on each
// tick until nothing is left, then stops asking. Reads work throughout: a
// row that has not been converted is plaintext and the vault passes it
// through, so there is no moment when mail is unavailable.
let backfillDone = false;
let backfillStarted = false;
async function encryptCache(): Promise<void> {
  if (backfillDone) return;
  try {
    if (!backfillStarted) {
      backfillStarted = true;
      const pending = await backfillPending();
      if (pending) log.info(`encrypting the mail cache: ${pending} messages to convert`);
      await backfillDraftsAndOutbox();
    }
    const p = await backfillBatch();
    if (p.done) log.info(`encrypted ${p.done} messages, ${p.remaining} to go`);
    if (p.finished) { backfillDone = true; log.info('the mail cache is fully encrypted'); }
  } catch (e) {
    log.error('cache encryption pass failed', { err: (e as Error).message });
  }
}

// Smart categories for mail synced before they existed. Same shape as the
// encryption walk: batches from the scheduler, stops asking when it is done.
// It waits for encryption to finish so the two are not opening and sealing
// the same rows at once.
let categorizeDone = false;
let categorizeStarted = false;
async function fileCategories(): Promise<void> {
  if (categorizeDone || !backfillDone) return;
  try {
    if (!categorizeStarted) {
      categorizeStarted = true;
      const pending = await categorizePending();
      if (pending) log.info(`filing mail into categories: ${pending} to go`);
    }
    const p = await categorizeBatch();
    if (p.done) log.info(`categorised ${p.done} messages, ${p.remaining} to go`);
    if (p.finished) { categorizeDone = true; log.info('every message has a category'); }
  } catch (e) {
    log.error('categorisation pass failed', { err: (e as Error).message });
  }
}

// ---------- Building what the new features read ----------
// One pass per tick, chosen by workers/enrichment.ts, so the meaning index,
// the priority scores, the guard, the attachment reader, the commitments
// scanner and the invitation finder take turns instead of competing for a
// box with one model on it.
async function enrichment(): Promise<void> {
  try {
    const r = await enrichmentTick();
    if (r?.count) log.debug('enrichment', { ...r });
  } catch (e) {
    log.error('enrichment pass failed', { err: (e as Error).message });
  }
}

// ---------- Emptying Trash and Junk ----------
// Trash and Junk empty themselves after the account's window. Hourly is
// often enough for a daily job and means a box that was off catches up soon
// after it starts; the work itself is skipped per account until 20 hours
// have passed since its last run.
let lastRetention = 0;
async function retention(): Promise<void> {
  if (Date.now() - lastRetention < 3600_000) return;
  lastRetention = Date.now();
  try {
    const r = await runRetention();
    if (r.trash || r.junk) log.info('retention', { ...r });
  } catch (e) {
    log.error('retention failed', { err: (e as Error).message });
  }
}

// ---------- Drafts to the mail server ----------
// Drafts saved here are mirrored into the mailbox's Drafts folder so other
// clients see them. Autosave marks a draft dirty on every save; the push
// waits until it has been quiet, so a burst of typing is one message.
async function syncDrafts(): Promise<void> {
  try {
    const r = await pushDirtyDrafts();
    if (r.pushed || r.failed) log.debug('draft sync', { ...r });
  } catch (e) {
    log.error('draft sync failed', { err: (e as Error).message });
  }
}

// ---------- Snoozes ----------

async function processSnoozes(): Promise<void> {
  const due = await query<any>(`SELECT * FROM snoozes WHERE NOT restored AND until_at <= now() LIMIT 50`);
  for (const s of due) {
    const claimed = await query(`UPDATE snoozes SET restored=true WHERE id=$1 AND NOT restored RETURNING id`, [s.id]);
    if (!claimed.length) continue;
    try {
      const acc = await getAccount(s.account_id);
      if (!acc) continue;
      const inbox = await actions.mailboxByRole(acc.id, 'inbox');
      const ids = await query<{ jmap_id: string }>('SELECT jmap_id FROM emails WHERE account_id=$1 AND thread_id=$2', [acc.id, s.thread_id]);
      if (inbox && ids.length) {
        await actions.addToMailbox(acc, ids.map((r) => r.jmap_id), inbox.jmap_id);
        await actions.setKeyword(acc, ids.map((r) => r.jmap_id), '$seen', false);
      }
      publish({ type: 'sync', userId: s.user_id, accountId: s.account_id });
    } catch (e) {
      log.error('snooze restore failed', { err: (e as Error).message, snooze: s.id });
    }
  }
}

// ---------- Outbox (send later) ----------

async function processOutbox(): Promise<void> {
  const due = await query<any>(`SELECT id FROM outbox WHERE status='scheduled' AND send_at <= now() ORDER BY send_at LIMIT 20`);
  for (const { id } of due) {
    const rows = await query<any>(`UPDATE outbox SET status='sending', attempts = attempts + 1 WHERE id=$1 AND status='scheduled' RETURNING *`, [id]);
    const item = rows[0];
    if (!item) continue;
    const acc = await getAccount(item.account_id);
    if (!acc) { await query(`UPDATE outbox SET status='failed', error='Account no longer exists' WHERE id=$1`, [id]); continue; }
    const raw = await open(item.user_id, item.payload);
    let payload: ComposeInput & { humanize?: boolean; undoWindow?: boolean };
    try { payload = JSON.parse(raw ?? '{}'); } catch { await query(`UPDATE outbox SET status='failed', error='The queued message could not be read' WHERE id=$1`, [id]); continue; }
    // Pacing is two separate things. The daily cap and the send window are
    // limits on mail this install sends by itself, and they apply to every
    // automated message whether or not it also wants to look unhurried; a
    // person's own scheduled message is not outreach and is never held by
    // them. The random gap is the optional half: it is what "natural delay"
    // means, and a responder that turns it off is still capped.
    const automated = payload.kind === 'auto_reply';
    if (automated || payload.humanize) {
      const slot = await reserveSendSlot(acc, { jitter: Boolean(payload.humanize) });
      if (!slot.ok) {
        await query(`UPDATE outbox SET status='scheduled', attempts = attempts - 1, send_at=$2 WHERE id=$1`, [id, new Date(slot.retryAt.getTime() + Math.random() * 30_000)]);
        continue;
      }
      if (slot.waitMs) await new Promise((r) => setTimeout(r, Math.min(slot.waitMs, 5000)));
    }
    try {
      // A message held for "undo send" is an ordinary reply or compose that
      // left a few seconds late; only a real schedule is logged as such.
      const kind = payload.kind === 'auto_reply' ? 'auto_reply' : payload.undoWindow && ['compose', 'reply', 'forward'].includes(payload.kind) ? payload.kind : 'scheduled';
      await composeAndSend(acc, { ...payload, kind });
      await query(`UPDATE outbox SET status='sent', sent_at=now(), error=NULL WHERE id=$1`, [id]);
    } catch (e) {
      const msg = (e as Error).message;
      if (item.attempts < 3) await query(`UPDATE outbox SET status='scheduled', send_at = now() + interval '5 minutes', error=$2 WHERE id=$1`, [id, msg.slice(0, 500)]);
      else await query(`UPDATE outbox SET status='failed', error=$2 WHERE id=$1`, [id, msg.slice(0, 500)]);
    }
  }
}

// ---------- Sequences ----------

interface StepRow { id: number; sequence_id: number; position: number; kind: 'email' | 'wait'; template_id: number | null; subject: string; body_html: string; wait_days: number; wait_hours: number; ai_personalize: boolean; ai_instructions: string; reply_in_thread: boolean }

async function processEnrollments(): Promise<void> {
  const due = await query<{ id: number }>(
    `SELECT e.id FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
     WHERE e.status='active' AND s.status='active' AND e.next_run_at <= now() ORDER BY e.next_run_at LIMIT 25`,
  );
  for (const { id } of due) {
    // Lease the row for ten minutes; a crash mid-step retries after that.
    const claimed = await query<any>(
      `UPDATE enrollments SET next_run_at = now() + interval '10 minutes', updated_at=now() WHERE id=$1 AND status='active' AND next_run_at <= now() RETURNING *`,
      [id],
    );
    if (!claimed.length) continue;
    try {
      await runEnrollment(claimed[0]);
    } catch (e) {
      const msg = (e as Error).message;
      log.error('enrollment step failed', { enrollment: id, err: msg });
      await query(`UPDATE enrollments SET error=$2, next_run_at = now() + interval '30 minutes', updated_at=now() WHERE id=$1 AND status='active'`, [id, msg.slice(0, 500)]);
      const enr = claimed[0];
      publish({ type: 'enrollment', userId: 0, sequenceId: enr.sequence_id, enrollmentId: id, status: 'error' });
    }
  }
}

async function finish(enr: any, status: string, error: string | null = null): Promise<void> {
  await query(`UPDATE enrollments SET status=$2, error=$3, updated_at=now(), finished_at=now() WHERE id=$1`, [enr.id, status, error]);
  publish({ type: 'enrollment', userId: enr.user_id ?? 0, sequenceId: enr.sequence_id, enrollmentId: enr.id, status });
}

function waitMs(step: StepRow): number {
  return (step.wait_days * 24 + step.wait_hours) * 3600_000;
}

// How long a step may sleep on a closed window or a spent cap before it asks
// again. A deferral is computed from the account as it is at that moment, and
// both halves of it can be edited while the row sleeps: widening a window or
// raising a cap should not leave mail parked until tomorrow on a rule that no
// longer exists. Waking early is cheap — a few selects and the same gate,
// with no model call, because generation happens after the gate — so the
// deferral is capped and re-asked rather than trusted for hours.
export const MAX_DEFER_MS = 15 * 60_000;

export function deferUntil(retryAt: Date): Date {
  return new Date(Math.min(retryAt.getTime() + Math.random() * 60_000, Date.now() + MAX_DEFER_MS));
}

// When the step after the one just sent becomes due. A wait step owns its own
// delay — it applies `waitMs` when it runs — so it is only made due here.
// Adding the delay in both places counted it twice, and a four-day wait took
// eight. Anything else waits out the account's randomised gap, with a floor so
// two emails never leave in the same minute.
export function nextRunAfterSend(next: StepRow | undefined, acc: Pick<AccountRow, 'jitter_enabled' | 'jitter_min_s' | 'jitter_max_s'>): Date | null {
  if (!next) return null;
  if (next.kind === 'wait') return new Date();
  return new Date(Date.now() + Math.max(jitterMs(acc), 60_000));
}

// Everything that means "do not write to this person", asked at the moment of
// sending rather than at the moment of deciding to send. Returns why, or null.
//
// The same three facts are checked when a step is picked up; this is the
// version that runs after the model has finished, because that is where the
// gap was.
// Park an enrollment on the review queue — but only while it is still running.
//
// Both callers used to write `status='waiting_review'` unconditionally, which
// quietly resurrected an enrollment that had already ended: a contact replies
// while the model is writing, the reply handler marks the enrollment
// "replied", and the draft that was already in flight then drags it back into
// the queue as "waiting_review". Approving it would send a campaign step to
// somebody who had answered — the same damage as the send race, taking a
// slower route through a person clicking Approve.
//
// So the status write is conditional, and when it matches nothing the review
// row it was about to belong to is withdrawn again.
async function parkForReview(enrollmentId: number, seq: any, acc: AccountRow): Promise<boolean> {
  const still = await query<{ id: number }>(
    `UPDATE enrollments SET status='waiting_review', updated_at=now() WHERE id=$1 AND status='active' RETURNING id`,
    [enrollmentId],
  );
  if (!still.length) {
    const now = await one<{ status: string }>('SELECT status FROM enrollments WHERE id=$1', [enrollmentId]);
    await query(`DELETE FROM review_queue WHERE enrollment_id=$1 AND status='pending'`, [enrollmentId]);
    log.info(`enrollment ${enrollmentId} was not parked for review: it is "${now?.status ?? 'gone'}" now`, { account: acc.id });
    return false;
  }
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [seq.user_id]);
  publish({ type: 'review', userId: seq.user_id, count: pending?.n ?? 0 });
  publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId, status: 'waiting_review' });
  return true;
}

async function suppressedNow(userId: number, contactId: number, email: string): Promise<'unsubscribed' | 'bounced' | 'suppressed' | null> {
  const c = await one<{ status: string }>('SELECT status FROM contacts WHERE id=$1', [contactId]);
  if (!c) return 'unsubscribed';
  if (['unsubscribed', 'do_not_contact'].includes(c.status)) return 'unsubscribed';
  if (c.status === 'bounced') return 'bounced';
  const s = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND lower(email)=lower($2)', [userId, email]);
  return s ? 'suppressed' : null;
}

async function runEnrollment(enr: any): Promise<void> {
  const seq = await one<any>('SELECT * FROM sequences WHERE id=$1', [enr.sequence_id]);
  if (!seq || seq.status !== 'active') { await query(`UPDATE enrollments SET next_run_at = now() + interval '1 hour' WHERE id=$1`, [enr.id]); return; }
  enr.user_id = seq.user_id;
  const steps = await query<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY position, id', [seq.id]);
  const step = steps[enr.current_step];
  if (!step) { await finish(enr, 'finished'); return; }

  if (step.kind === 'wait') {
    await query(`UPDATE enrollments SET current_step = current_step + 1, next_run_at = now() + ($2 || ' milliseconds')::interval, updated_at=now() WHERE id=$1`, [enr.id, String(waitMs(step))]);
    return;
  }

  const contact = await one<any>('SELECT * FROM contacts WHERE id=$1', [enr.contact_id]);
  if (!contact) { await finish(enr, 'error', 'Contact was deleted'); return; }
  if (['unsubscribed', 'do_not_contact'].includes(contact.status)) { await finish(enr, 'unsubscribed'); return; }
  if (contact.status === 'bounced') { await finish(enr, 'bounced'); return; }
  const suppressed = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND lower(email)=lower($2)', [seq.user_id, contact.email]);
  if (suppressed) { await finish(enr, 'unsubscribed'); return; }
  const acc = await getAccount(enr.account_id);
  if (!acc || !acc.enabled) { await query(`UPDATE enrollments SET next_run_at = now() + interval '1 hour', error='Sending account is paused', updated_at=now() WHERE id=$1`, [enr.id]); return; }

  // Content: an approved review, or the template, or the LLM.
  const approved = await openReview(seq.user_id, await one<any>(`SELECT * FROM review_queue WHERE enrollment_id=$1 AND step_id=$2 AND status='approved' ORDER BY decided_at DESC LIMIT 1`, [enr.id, step.id]));
  const willGenerate = !approved && step.ai_personalize && seq.ai_mode !== 'off';
  // Writing a personalised email costs ten to forty seconds of a small
  // model's time. If the account has already used its daily allowance or is
  // outside its send window, that work would be thrown away and done again
  // tomorrow, so a campaign that sends automatically checks before it writes
  // rather than after. Nothing is claimed here — the real reservation still
  // happens below, once there is something to send.
  if (willGenerate && seq.ai_mode === 'auto') {
    const gate = await sendingBlocked(acc);
    if (gate) {
      await query(`UPDATE enrollments SET next_run_at=$2, updated_at=now(), error=NULL WHERE id=$1`, [enr.id, deferUntil(gate.retryAt)]);
      log.debug(`enrollment ${enr.id} deferred before generating (${gate.reason}) until ${gate.retryAt.toISOString()}`);
      return;
    }
  }
  let subject: string, html: string;
  // What the guard is allowed to assert about this message. Only a generated
  // one gets a greeting expectation and a fact set: a template the person
  // wrote is theirs, and its figures are theirs to have chosen.
  let expectation: Pick<GuardInput, 'greeting' | 'specifics'> = {};
  const rendered = await renderStep(acc, seq, step, contact, enr);
  if (approved) {
    subject = approved.subject ?? ''; html = approved.body_html ?? '';
  } else if (step.ai_personalize && seq.ai_mode !== 'off') {
    let gen;
    try {
      gen = await personalize(acc, step, contact, rendered);
    } catch (e) {
      // A brief with a hole in it is not a transient failure and retrying
      // will not close it. The campaign stops and says what to fix, once,
      // instead of writing an email with an invented price in it.
      if (e instanceof BriefIncompleteError) {
        // The hole is in the step, not in this contact, so every other
        // enrollment on this campaign is about to fail in exactly the same
        // way. Pausing the campaign says it once; pausing five hundred
        // enrollments individually says it five hundred times and leaves
        // somebody to work out that it was always the same sentence.
        await query(`UPDATE sequences SET status='paused', updated_at=now() WHERE id=$1 AND status='active'`, [seq.id]);
        await query(`UPDATE enrollments SET status='paused', error=$2, next_run_at=NULL, updated_at=now() WHERE id=$1 AND status='active'`, [enr.id, e.message.slice(0, 500)]);
        publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId: enr.id, status: 'paused' });
        log.warn('campaign paused: the brief is incomplete', { sequence: seq.id, reason: e.message });
        return;
      }
      throw e;
    }
    subject = gen.subject; html = gen.html;
    expectation = {
      greeting: { first: gen.greetingFirst, forbidden: [acc.name] },
      // A campaign email carries no attachment, so "as attached" in one is
      // always a promise it cannot keep.
      specifics: { facts: gen.facts, hasAttachment: false },
    };
    if (seq.ai_mode === 'review') {
      await query(`DELETE FROM review_queue WHERE enrollment_id=$1 AND step_id=$2 AND status='pending'`, [enr.id, step.id]);
      const sealedReview = await sealReview(seq.user_id, { subject, body_html: html });
      await query(
        `INSERT INTO review_queue (user_id, enrollment_id, account_id, contact_id, step_id, subject, body_html, ai_model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [seq.user_id, enr.id, acc.id, contact.id, step.id, sealedReview.subject, sealedReview.body_html, gen.model],
      );
      await parkForReview(enr.id, seq, acc);
      return;
    }
  } else {
    subject = rendered.subject; html = rendered.html;
  }

  // Nothing with a leftover placeholder, an unrendered merge field or echoed
  // prompt text goes out on its own: it waits for a person in the review queue.
  if (!approved) {
    const hits = findTemplateArtifacts({ subject, html, ...expectation });
    if (hits.length) {
      const reason = `Held for review: ${describeHits(hits)}`;
      await query(`DELETE FROM review_queue WHERE enrollment_id=$1 AND step_id=$2 AND status='pending'`, [enr.id, step.id]);
      const heldReview = await sealReview(seq.user_id, { subject, body_html: html });
      await query(
        `INSERT INTO review_queue (user_id, enrollment_id, account_id, contact_id, step_id, subject, body_html, ai_model, hold_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [seq.user_id, enr.id, acc.id, contact.id, step.id, heldReview.subject, heldReview.body_html, step.ai_personalize && seq.ai_mode !== 'off' ? (await getAiSettings()).model : 'template', reason],
      );
      log.warn('sequence step held for review', { enrollment: enr.id, step: step.id, reason });
      await parkForReview(enr.id, seq, acc);
      return;
    }
  }

  const slot = await reserveSendSlot(acc);
  if (!slot.ok) {
    await query(`UPDATE enrollments SET next_run_at=$2, updated_at=now(), error=NULL WHERE id=$1`, [enr.id, deferUntil(slot.retryAt)]);
    log.debug(`enrollment ${enr.id} deferred (${slot.reason}) until ${slot.retryAt.toISOString()}`);
    return;
  }

  // ---------- the last gate before anything leaves ----------
  //
  // Everything above this line can take a long time: writing a personalised
  // email is ten to forty seconds of a model's time, and the checks that
  // decided this contact was still a legitimate recipient ran before it. In
  // that window a reply can land, a bounce can be processed, or somebody can
  // unsubscribe — and the most damaging bug in this whole category is a
  // person who has just replied receiving the next step of a sequence.
  //
  // So the decision is made again here, against the database as it is now,
  // and the send is *claimed* rather than merely permitted: advancing the step
  // is a conditional update on the enrollment still being active and still
  // being on this step. If a reply landed while the model was writing, the
  // claim matches no row and nothing is sent. Two ticks racing each other
  // cannot both win it either.
  const gone = await suppressedNow(seq.user_id, contact.id, contact.email);
  if (gone) {
    log.info(`enrollment ${enr.id} stopped at the gate: ${gone}`, { contact: contact.id });
    await finish(enr, gone === 'bounced' ? 'bounced' : 'unsubscribed');
    return;
  }
  const nextIndex = enr.current_step + 1;
  const claimedSend = await query<{ id: number }>(
    `UPDATE enrollments SET current_step=$2, updated_at=now() WHERE id=$1 AND status='active' AND current_step=$3 RETURNING id`,
    [enr.id, nextIndex, enr.current_step],
  );
  if (!claimedSend.length) {
    // Not an error: somebody replied, paused it, or another tick got here
    // first. The enrollment is already in whatever state that put it in.
    const now = await one<{ status: string }>('SELECT status FROM enrollments WHERE id=$1', [enr.id]);
    log.info(`enrollment ${enr.id} not sent: it is "${now?.status ?? 'gone'}" now, not active`, { step: step.id });
    return;
  }

  const threaded = step.reply_in_thread && enr.last_message_id;
  const finalSubject = threaded ? (/^re:/i.test(subject) ? subject : `Re: ${enr.last_subject || subject}`) : subject;
  const send = async () => composeAndSend(acc, {
    to: [{ name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null, email: contact.email }],
    subject: finalSubject,
    html,
    kind: 'sequence',
    contactId: contact.id,
    sequenceId: seq.id,
    stepId: step.id,
    enrollmentId: enr.id,
    includeSignature: rendered.includeSignature,
    templateId: rendered.templateId,
    inReplyTo: threaded ? enr.last_message_id : null,
    references: threaded ? [enr.last_message_id] : [],
    unsubscribeFooter: seq.unsubscribe_footer,
    encrypt: seq.encrypt_pgp ? 'if_possible' : null,
    reviewed: Boolean(approved),
  });
  let outcome;
  try {
    ({ outcome } = await send());
  } catch (e) {
    // The step was claimed before the send so that a reply could not sneak
    // past it. A send that then failed has to give the step back, or a
    // transient transport error would silently skip a contact's email.
    await query(`UPDATE enrollments SET current_step=$2, updated_at=now() WHERE id=$1 AND current_step=$3`, [enr.id, enr.current_step, nextIndex]);
    throw e;
  }

  const next = steps[nextIndex];
  const nextRun = nextRunAfterSend(next, acc);
  if (!next) {
    await query(`UPDATE enrollments SET current_step=$2, last_message_id=$3, thread_id=COALESCE($4, thread_id), last_subject=$5, status='finished', finished_at=now(), next_run_at=NULL, error=NULL, updated_at=now() WHERE id=$1`, [enr.id, nextIndex, outcome.messageId, outcome.threadId, finalSubject]);
    publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId: enr.id, status: 'finished' });
  } else {
    await query(`UPDATE enrollments SET current_step=$2, last_message_id=$3, thread_id=COALESCE($4, thread_id), last_subject=$5, next_run_at=$6, error=NULL, updated_at=now() WHERE id=$1`, [enr.id, nextIndex, outcome.messageId, outcome.threadId, finalSubject, nextRun]);
    publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId: enr.id, status: 'active' });
  }
}

export async function renderStep(acc: AccountRow, seq: any, step: StepRow, contact: any, enr?: any): Promise<{ subject: string; html: string; brief: string; includeSignature: boolean; templateId: number | null }> {
  let subjectTpl = step.subject, bodyTpl = step.body_html, brief = '', includeSignature = true, templateId: number | null = null;
  if (step.template_id) {
    const t = await one<any>('SELECT * FROM templates WHERE id=$1', [step.template_id]);
    if (t) { subjectTpl = subjectTpl || t.subject; bodyTpl = bodyTpl || t.body_html; brief = t.ai_brief ?? ''; includeSignature = t.include_signature !== false; templateId = t.id; }
  }
  const ctx = contactContext(contact, {
    sender_name: acc.name,
    sender_email: acc.email,
    sender_first_name: acc.name.split(' ')[0],
    sender_tz: acc.send_window?.tz,
    unsubscribe_url: contact.id ? unsubscribeUrl(seq.user_id, contact.id, acc.id) : '',
  });
  const seed = enr?.id ? Number(enr.id) * 7919 + Number(step.id) : undefined;
  return { subject: renderText(subjectTpl ?? '', ctx, seed), html: renderHtml(bodyTpl ?? '', ctx, seed), brief: renderText(brief, ctx, seed), includeSignature, templateId };
}

// Who a campaign email is to, decided from the contact row rather than left
// to the model. A blank or malformed name column, a placeholder an import
// never filled in, the company in the name field, a role address: all of them
// resolve to no name, which the prompt turns into "Hi there," and the guard
// then checks was actually used.
export function campaignRecipient(acc: AccountRow, contact: any): ResolvedName {
  return resolveRecipient(candidatesFromContact(contact), {
    email: contact.email,
    senderName: acc.name,
    senderEmail: acc.email,
    company: contact.company,
  });
}

export async function personalize(acc: AccountRow, step: StepRow, contact: any, rendered: { subject: string; html: string; brief: string }): Promise<{ subject: string; html: string; model: string; facts: string; greetingFirst: string }> {
  const settings = await getAiSettings();
  const name = campaignRecipient(acc, contact);
  const brief = rendered.brief || htmlToText(rendered.html);
  // Nothing is generated from a brief with a hole in it. See
  // `findBriefProblems`: every model tested fills the hole with an invented
  // figure rather than leaving it, so the only safe moment to catch this is
  // before the model sees it.
  const holes = findBriefProblems(brief);
  if (holes.length) throw new BriefIncompleteError(holes);
  const messages = buildMessages({
    mode: 'personalize',
    instruction: step.ai_instructions || undefined,
    senderName: acc.name,
    systemPrompt: settings.systemPrompt,
    voice: acc.voice,
    recipient: { name: name.full || undefined, email: contact.email, company: contact.company, title: contact.title, notes: contact.notes, fields: contact.fields },
    template: brief,
    subject: rendered.subject,
    length: 'medium',
  });
  const recipient = { name: name.full || undefined, email: contact.email };
  // Sequence and responder mail is written minutes or hours before it is
  // sent, so it queues behind whoever is drafting in a browser right now.
  const body = finalizeOutput(await chat({ messages, // 0 is uncapped and must stay uncapped: Math.max(600, 0) would quietly
      // reimpose a ceiling on the one path the operator cannot see.
      maxTokens: settings.maxTokens > 0 ? Math.max(600, settings.maxTokens) : 0, stop: modeTuning('personalize').stop, background: true, owner: String(acc.user_id), consent: { userId: acc.user_id, capability: 'ai.campaigns' } }), 'personalize', { recipient, senderName: acc.name, senderEmail: acc.email });
  let subject = rendered.subject;
  if (!subject.trim()) {
    const st = modeTuning('subject');
    subject = cleanOutput(await chat({ messages: buildMessages({ mode: 'subject', draft: body }), maxTokens: st.maxTokens, temperature: st.temperature, stop: st.stop, background: true, owner: String(acc.user_id), consent: { userId: acc.user_id, capability: 'ai.campaigns' } }), 'subject');
  }
  // Everything this email was allowed to know. The guard holds it back if a
  // figure, a date or a term turns up in the body that is not in here: a
  // price the brief never named is worse than a leftover [price], because the
  // placeholder gets reviewed and the price gets sent.
  const facts = [brief, step.ai_instructions, contact.company, contact.title, contact.notes, ...Object.values(contact.fields ?? {}).map((v) => (v === null || v === undefined ? '' : String(v)))].filter(Boolean).join('\n');
  return { subject, html: textToHtml(body), model: settings.model, facts, greetingFirst: name.first };
}


// ---------- AI responders ----------
// Generates the reply a responder asked for, then either files it as a
// draft, queues it for review, or sends it (through the outbox when the
// responder wants the account's pacing and random delay).

async function processAiJobs(): Promise<void> {
  for (let n = 0; n < 2; n++) {
    const rows = await query<any>(`UPDATE ai_jobs SET status='running', attempts = attempts + 1, updated_at=now() WHERE id = (SELECT id FROM ai_jobs WHERE status='pending' ORDER BY created_at LIMIT 1) AND status='pending' RETURNING *`);
    const job = rows[0];
    if (!job) return;
    try {
      const result = job.kind === 'responder' ? await runResponderJob(job) : 'unknown job kind';
      // The payload is the message the model was asked about. The job is
      // over, so it goes now rather than at the next housekeeping sweep:
      // there is no window in which a finished job is holding somebody's
      // mail. `result` is a one-line outcome ("sent", "responder gone"), not
      // the generated text, which was never stored.
      await query(`UPDATE ai_jobs SET status='done', result=$2, payload='{}'::jsonb, updated_at=now() WHERE id=$1`, [job.id, result]);
    } catch (e) {
      const msg = (e as Error).message;
      log.error('ai job failed', { job: job.id, err: msg });
      // A job that has given up keeps its error and loses its prompt; one
      // that will be retried has to keep the prompt to retry with.
      if (job.attempts >= 3) await query(`UPDATE ai_jobs SET status='failed', error=$2, payload='{}'::jsonb, updated_at=now() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
      else await query(`UPDATE ai_jobs SET status='pending', error=$2, updated_at=now() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
    }
  }
}

export async function generateResponderReply(responder: any, acc: AccountRow, email: any): Promise<{ subject: string; html: string; text: string; to: { name: string | null; email: string }[]; model: string; guard: Pick<GuardInput, 'greeting' | 'specifics'> }> {
  const settings = await getAiSettings();
  const thread = await openEmails(acc.user_id, 'ai.responders', await query<any>('SELECT from_addr, received_at, body_text, body_html, preview FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC', [acc.id, email.thread_id]));
  const contact = await one<any>('SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=$2', [acc.user_id, String(email.from_addr?.[0]?.email ?? '').toLowerCase()]);
  // Who we are answering, decided from the contact row and the From header
  // rather than from whatever the model finds most memorable in the thread.
  // Everybody else who wrote in the conversation is named as forbidden, which
  // is what stops a reply opening "Hi Priya," because Priya wrote three of
  // the last six messages — and stops it greeting somebody who is only
  // quoted below the fold and never wrote at all.
  const writer = email.from_addr?.[0] ?? {};
  const participants = thread.map((m: any) => m.from_addr?.[0]?.name).filter(Boolean);
  const name = resolveRecipient(
    [...candidatesFromContact(contact), { value: writer.name, source: 'display' as const }],
    {
      email: writer.email ?? contact?.email,
      senderName: acc.name,
      senderEmail: acc.email,
      company: contact?.company,
      others: participants.filter((n: string) => n && n !== writer.name),
    },
  );
  const messages = buildMessages({
    mode: 'reply',
    instruction: responder.instructions || undefined,
    tone: responder.tone || undefined,
    length: responder.length || 'medium',
    senderName: acc.name,
    senderEmail: acc.email,
    subject: email.subject,
    systemPrompt: settings.systemPrompt,
    voice: acc.voice,
    recipient: contact
      ? { name: name.full || undefined, email: contact.email, company: contact.company, title: contact.title, notes: contact.notes, fields: contact.fields }
      : { name: name.full || undefined, email: writer.email },
    thread: thread.map((m) => ({ from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(), date: new Date(m.received_at).toDateString(), text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').replace(/\n>.*$/gm, '').trim() })),
    threadChars: threadBudgetChars(settings.numCtx, settings.maxTokens),
  });
  const replyRecipient = { name: name.full || undefined, email: contact?.email ?? writer.email };
  const text = finalizeOutput(await chat({ messages, maxTokens: settings.maxTokens, stop: modeTuning('reply').stop, background: true, owner: String(acc.user_id), consent: { userId: acc.user_id, capability: 'ai.responders' } }), 'reply', { recipient: replyRecipient, senderName: acc.name, senderEmail: acc.email });
  // The same addressing rules as the Reply button in the browser.
  const r = replyRecipients({ from: email.from_addr, replyTo: email.reply_to, to: email.to_addr, cc: email.cc_addr }, acc.email, Boolean(responder.reply_all));
  const to = [...r.to, ...r.cc].map((a) => ({ name: a.name ?? null, email: a.email }));
  // The original is quoted as text, never as its own HTML: a message written
  // to abuse an automatic reply must not travel back out (or into a draft
  // the person opens in the editor) with its markup intact.
  const original = (email.body_text || htmlToText(email.body_html ?? '') || email.preview || '').slice(0, 20_000);
  const quote = `<div class="tern-quote" style="margin-top:16px"><div style="color:#5b6274;font-size:12.5px;margin-bottom:6px">On ${escapeHtml(new Date(email.received_at).toUTCString())}, ${escapeHtml(email.from_addr?.[0]?.email ?? '')} wrote:</div><blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d0d4e0"><div style="white-space:pre-wrap">${escapeHtml(original)}</div></blockquote></div>`;
  // The conversation is the whole of what this reply was allowed to know, so
  // a figure or a date in it that is not in the thread was invented. An
  // automatic reply never carries an attachment either.
  const facts = thread.map((m: any) => m.body_text || htmlToText(m.body_html || '') || m.preview || '').join('\n');
  return {
    subject: replySubject(email.subject),
    html: textToHtml(text) + quote,
    text,
    to,
    model: settings.model,
    guard: { greeting: { first: name.first, forbidden: [acc.name, ...participants] }, specifics: { facts, hasAttachment: false } },
  };
}

async function runResponderJob(job: any): Promise<string> {
  const p = job.payload;
  const responder = await one<any>('SELECT * FROM responders WHERE id=$1 AND enabled', [p.responderId]);
  if (!responder) return 'responder gone or disabled';
  const acc = await getAccount(p.accountId);
  if (!acc || !acc.enabled) return 'account unavailable';
  const email = await openEmail(acc.user_id, 'ai.responders', await one<any>('SELECT * FROM emails WHERE id=$1 AND account_id=$2', [p.emailDbId, acc.id]));
  if (!email) return 'email gone';
  // Someone may have answered by hand in the meantime. The sender is
  // ciphertext now, so the candidates are opened rather than matched in SQL;
  // there are only ever a handful later in one thread.
  const later = await openEmails(acc.user_id, 'ai.responders', await query<any>('SELECT from_addr FROM emails WHERE account_id=$1 AND thread_id=$2 AND received_at > $3', [acc.id, email.thread_id, email.received_at]));
  if (later.some((m) => String(m.from_email ?? '') === acc.email.toLowerCase())) return 'already answered';
  const gen = await generateResponderReply(responder, acc, email);
  if (!gen.to.length) return 'no recipient';
  const contact = await one<{ id: number }>('SELECT id FROM contacts WHERE user_id=$1 AND lower(email)=$2', [acc.user_id, gen.to[0].email.toLowerCase()]);
  await query('UPDATE responders SET hits = hits + 1, updated_at=now() WHERE id=$1', [responder.id]);
  if (responder.mode === 'draft') {
    await query(
      `INSERT INTO drafts (user_id, account_id, kind, reply_to_email_id, thread_id, to_addr, subject, body_html, source, responder_id) VALUES ($1,$2,'reply',$3,$4,$5,$6,$7,'ai',$8)`,
      [acc.user_id, acc.id, email.id, email.thread_id, JSON.stringify(gen.to), gen.subject, gen.html, responder.id],
    );
    publish({ type: 'sync', userId: acc.user_id, accountId: acc.id });
    publish({ type: 'ai', userId: acc.user_id, status: 'draft' });
    return 'draft created';
  }
  if (responder.mode === 'review') {
    const r = await sealReview(acc.user_id, { subject: gen.subject, body_html: gen.html, to_addr: gen.to, context: (email.body_text || email.preview || '').slice(0, 2000) });
    await query(
      `INSERT INTO review_queue (user_id, account_id, contact_id, subject, body_html, ai_model, kind, responder_id, reply_to_email_id, thread_id, to_addr, context)
       VALUES ($1,$2,$3,$4,$5,$6,'reply',$7,$8,$9,$10,$11)`,
      [acc.user_id, acc.id, contact?.id ?? null, r.subject, r.body_html, gen.model, responder.id, email.id, email.thread_id, r.to_addr, r.context],
    );
    const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [acc.user_id]);
    publish({ type: 'review', userId: acc.user_id, count: pending?.n ?? 0 });
    return 'queued for review';
  }
  // Send mode still never sends something a person would wince at: leftover
  // placeholders, prompt text or an "as an AI" line park the reply in the
  // review queue instead.
  const hits = findTemplateArtifacts({ subject: gen.subject, html: gen.html, ...gen.guard });
  if (hits.length) {
    const reason = `Held for review: ${describeHits(hits)}`;
    const held = await sealReview(acc.user_id, { subject: gen.subject, body_html: gen.html, to_addr: gen.to, context: (email.body_text || email.preview || '').slice(0, 2000) });
    await query(
      `INSERT INTO review_queue (user_id, account_id, contact_id, subject, body_html, ai_model, kind, responder_id, reply_to_email_id, thread_id, to_addr, context, hold_reason)
       VALUES ($1,$2,$3,$4,$5,$6,'reply',$7,$8,$9,$10,$11,$12)`,
      [acc.user_id, acc.id, contact?.id ?? null, held.subject, held.body_html, gen.model, responder.id, email.id, email.thread_id, held.to_addr, held.context, reason],
    );
    const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [acc.user_id]);
    publish({ type: 'review', userId: acc.user_id, count: pending?.n ?? 0 });
    log.warn('auto-reply held for review', { responder: responder.id, email: email.id, reason });
    return `held for review: ${describeHits(hits)}`;
  }
  // A reply to someone whose key is on file goes back encrypted.
  const payload = { to: gen.to, subject: gen.subject, html: gen.html, replyToEmailId: email.id, kind: 'auto_reply', contactId: contact?.id ?? null, responderId: responder.id, includeSignature: true, encrypt: 'if_possible', guard: gen.guard };
  // Both paths queue. Sending straight from here would have skipped the
  // account's daily cap and send window along with the delay, which made
  // "no natural delay" quietly mean "no limits at all" — the one thing an
  // automated responder must not be able to do.
  await query('INSERT INTO outbox (user_id, account_id, payload, send_at) VALUES ($1,$2,$3,now())', [acc.user_id, acc.id, await seal(acc.user_id, JSON.stringify({ ...payload, humanize: Boolean(responder.humanize) }))]);
  return responder.humanize ? 'queued to send with natural delay' : 'queued to send';
}


export class BriefIncompleteError extends Error {
  hits: ReturnType<typeof findBriefProblems>;
  constructor(hits: ReturnType<typeof findBriefProblems>) {
    super(describeBriefProblems(hits));
    this.name = 'BriefIncompleteError';
    this.hits = hits;
  }
}

// ---------- The preview a campaign is approved from ----------
//
// The golden path is: import a list, describe the campaign in a sentence, see
// what the model actually wrote for the first few people, approve. Without
// the third step "approve" means approving a description of an email rather
// than an email, which for a 4B model is not the same thing at all — the
// review queue then catches the problems one at a time, after the campaign is
// live, which is a worse place to find out.
//
// This runs the real generation path, the real name resolution and the real
// guard, so what the preview shows is what the campaign would send, including
// whether it would have been held back.
export interface CampaignPreview {
  contact: { id: number; email: string; name: string; company: string | null };
  subject: string;
  html: string;
  /** Why this one would not have been sent as written, if it would not have been. */
  heldFor: string | null;
}

export async function previewCampaign(
  acc: AccountRow,
  opts: { brief: string; instructions?: string; contacts: any[] },
): Promise<CampaignPreview[]> {
  const out: CampaignPreview[] = [];
  // A synthetic step: exactly the shape the scheduler builds from a saved
  // campaign, so the preview cannot drift from what a send would do.
  const step: StepRow = {
    id: 0, sequence_id: 0, position: 0, kind: 'email', template_id: null,
    subject: '', body_html: textToHtml(opts.brief), wait_days: 0, wait_hours: 0,
    ai_personalize: true, ai_instructions: opts.instructions ?? '', reply_in_thread: false,
  };
  for (const contact of opts.contacts) {
    const gen = await personalize(acc, step, contact, { subject: '', html: step.body_html, brief: opts.brief });
    const hits = findTemplateArtifacts({
      subject: gen.subject,
      html: gen.html,
      greeting: { first: gen.greetingFirst, forbidden: [acc.name] },
      specifics: { facts: gen.facts, hasAttachment: false },
    });
    out.push({
      contact: {
        id: contact.id,
        email: contact.email,
        name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
        company: contact.company ?? null,
      },
      subject: gen.subject,
      html: gen.html,
      heldFor: hits.length ? describeHits(hits) : null,
    });
  }
  return out;
}
