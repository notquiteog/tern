// When this campaign's mail would actually land, over everybody on it.
//
// The dry run already places one contact's steps on real dates, which answers
// "does this arrive on Boxing Day". It cannot answer the question that decides
// whether a campaign is the right shape: with four hundred people enrolled and
// a cap of forty a day, when does the last first-send go out, and when do the
// follow-ups start competing with the first sends for the same forty slots?
//
// Nobody works that out in their head. The answer is usually surprising —
// a five-step sequence over four hundred contacts spends most of its second
// fortnight sending follow-ups and cannot start anybody new — and it is
// entirely determined by numbers the app already has.
//
// ── Why it is a simulation and not a formula ────────────────────────────────
//
// Because the cap is global and the waits are per contact, so the two
// interact: a first send pushed to tomorrow pushes its follow-up too, which
// pushes somebody else's. A closed-form answer would have to assume the cap is
// never binding, which is exactly the case worth knowing about.
//
// ── What it does not model ──────────────────────────────────────────────────
//
// Replies. Every enrollment is projected as though it runs to the end, which
// is the worst case for volume and the right one for "will this fit" — a
// campaign that stops half its enrollments on the first reply sends less than
// this, never more. Said out loud on the page rather than hidden here.
import { one, query } from '../db.js';
import { getAccount, type AccountRow } from './accounts.js';
import { effectiveCap, isWindowOpen } from './sending.js';

export interface ProjectionDay {
  day: string;
  /** Sends of the campaign's first email step: people hearing from it at all. */
  first: number;
  followUp: number;
  /** The cap that applies on this day, which a warm-up ramp changes. */
  cap: number;
  /** Whether the day is full, so work was pushed forward. */
  full: boolean;
}

export interface CampaignProjection {
  days: ProjectionDay[];
  enrollments: number;
  /** The day the last person hears from the campaign for the first time. */
  lastFirstSend: string | null;
  /** The day the last message of any kind goes out. */
  finishes: string | null;
  /** The first day a follow-up and a first send want the same slot. */
  contentionFrom: string | null;
  /** True when the projection was cut short rather than run to the end. */
  truncated: boolean;
}

/** How far ahead to simulate. Past this the answer is "too long" either way. */
const HORIZON_DAYS = 180;

function dayKey(d: Date, tz: string): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}

/**
 * Project one campaign forward over everybody currently on it.
 *
 * Exported separately from the route so a test can drive it with a made-up
 * account and a made-up set of enrollments, which is the only way to check the
 * interesting case — a cap that actually binds — without enrolling hundreds of
 * contacts.
 */
export function project(input: {
  account: Pick<AccountRow, 'daily_cap' | 'send_window' | 'warmup_enabled' | 'warmup_started_at' | 'warmup_start_cap' | 'warmup_step'>;
  /** Email steps in order, each with the wait that precedes it in ms. */
  steps: { waitMsBefore: number }[];
  /** One per enrolled contact: which email step they are on, and when it is due. */
  pending: { stepIndex: number; readyAt: number }[];
  now?: Date;
  /** Sends already made today, which the cap counts. */
  usedToday?: number;
}): CampaignProjection {
  const tz = input.account.send_window?.tz || 'UTC';
  const now = input.now ?? new Date();
  const queue = input.pending
    .filter((p) => p.stepIndex < input.steps.length)
    .map((p) => ({ ...p, readyAt: Math.max(p.readyAt, now.getTime()) }));
  const days: ProjectionDay[] = [];
  let lastFirstSend: string | null = null;
  let contentionFrom: string | null = null;
  let finishes: string | null = null;

  let cursor = new Date(now);
  for (let d = 0; d < HORIZON_DAYS && queue.length; d++) {
    const key = dayKey(cursor, tz);
    // Midday in the window's zone is a fair stand-in for "is this a sending
    // day": the window's hours are simulated as a whole-day capacity, and only
    // the days it is closed on change the answer at this resolution.
    const midday = new Date(`${key}T12:00:00Z`);
    const open = isWindowOpen(input.account.send_window, midday);
    if (open) {
      const cap = effectiveCap(input.account, midday);
      // Today's cap is already partly spent by whatever has gone out.
      let room = Math.max(0, cap - (d === 0 ? (input.usedToday ?? 0) : 0));
      const endOfDay = new Date(`${key}T23:59:59Z`).getTime();
      const due = queue
        .map((q, i) => ({ q, i }))
        .filter((x) => x.q.readyAt <= endOfDay)
        .sort((a, b) => a.q.readyAt - b.q.readyAt);
      // What wanted to go out today, before the cap had its say. The two
      // counts below are what "competing" actually means: the runner takes
      // the oldest-ready first, exactly as `processEnrollments` does, so on a
      // full day the losers are simply whatever was readiest last — and a day
      // where both kinds are waiting is the day the campaign stops being able
      // to start new people at the rate it was.
      const dueFirst = due.filter((x) => x.q.stepIndex === 0).length;
      const dueFollow = due.length - dueFirst;
      let first = 0, followUp = 0;
      const sentIdx: number[] = [];
      for (const { q, i } of due) {
        if (room <= 0) break;
        room -= 1;
        if (q.stepIndex === 0) first += 1; else followUp += 1;
        sentIdx.push(i);
      }
      // Advance everyone who sent, in one pass, so indices stay valid.
      const sent = new Set(sentIdx);
      for (const i of sentIdx) {
        const item = queue[i]!;
        const next = item.stepIndex + 1;
        item.stepIndex = next;
        if (next < input.steps.length) item.readyAt = midday.getTime() + input.steps[next]!.waitMsBefore;
      }
      for (let i = queue.length - 1; i >= 0; i--) {
        if (sent.has(i) && queue[i]!.stepIndex >= input.steps.length) queue.splice(i, 1);
      }
      if (first || followUp) {
        const full = due.length > first + followUp;
        days.push({ day: key, first, followUp, cap, full });
        if (first) lastFirstSend = key;
        finishes = key;
        // The day the shape of the campaign changes. Not "a day with both
        // kinds on it" — the runner sends the readiest first, so mixed days
        // are rare and land wherever the arithmetic happens to leave a
        // remainder. What matters is the first full day on which both kinds
        // were waiting, because from then on one of them is being held up by
        // the other.
        if (!contentionFrom && full && dueFirst > 0 && dueFollow > 0) contentionFrom = key;
      }
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return {
    days, enrollments: input.pending.length, lastFirstSend, finishes, contentionFrom,
    truncated: queue.length > 0,
  };
}

/** The same, read off a saved campaign. */
export async function projectCampaign(sequenceId: number): Promise<CampaignProjection | null> {
  const seq = await one<{ account_id: number | null }>('SELECT account_id FROM sequences WHERE id=$1', [sequenceId]);
  if (!seq?.account_id) return null;
  const account = await getAccount(seq.account_id);
  if (!account) return null;

  // The steps as the runner walks them: a wait step is not a send, it is the
  // gap before the next one, so the two are folded together here exactly as
  // `runEnrollment` folds them.
  const raw = await query<{ kind: string; wait_days: number; wait_hours: number }>(
    'SELECT kind, wait_days, wait_hours FROM sequence_steps WHERE sequence_id=$1 ORDER BY position, id',
    [sequenceId],
  );
  const steps: { waitMsBefore: number }[] = [];
  let pendingWait = 0;
  // Where each email step sits in the raw list, so an enrollment's
  // `current_step` — which counts every step, waits included — can be mapped
  // onto "which email is next".
  const emailAt: number[] = [];
  raw.forEach((r, i) => {
    if (r.kind === 'wait') { pendingWait += (r.wait_days ?? 0) * 86_400_000 + (r.wait_hours ?? 0) * 3_600_000; return; }
    steps.push({ waitMsBefore: pendingWait });
    emailAt.push(i);
    pendingWait = 0;
  });
  if (!steps.length) return null;

  const enrollments = await query<{ current_step: number; next_run_at: Date | null }>(
    `SELECT current_step, next_run_at FROM enrollments
      WHERE sequence_id=$1 AND status IN ('active','waiting_review')`,
    [sequenceId],
  );
  const now = new Date();
  const pending = enrollments.map((e) => ({
    // The next email at or after where they are now.
    stepIndex: Math.max(0, emailAt.findIndex((pos) => pos >= (e.current_step ?? 0))),
    readyAt: e.next_run_at ? new Date(e.next_run_at).getTime() : now.getTime(),
  })).filter((p) => p.stepIndex >= 0);

  const used = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM send_log WHERE account_id=$1 AND status='sent'
       AND sent_at >= date_trunc('day', now())`,
    [account.id],
  );
  return project({ account, steps, pending, now, usedToday: used?.n ?? 0 });
}
