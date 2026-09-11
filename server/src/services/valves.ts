// The valves that make "send automatically" defensible.
//
// Auto mode sends what a model wrote without anybody reading it. The argument
// for offering that at all has been the guard: every draft is checked for an
// invented figure, an unfilled merge field, a missing ask. But the guard reads
// one message at a time, and the thing that actually signals a campaign going
// wrong is not visible in any single message — it is the shape of what comes
// back. A list bought rather than built bounces. A brief that reads as spam
// gets people leaving in numbers. Both are obvious by the thirtieth send and
// invisible in the first.
//
// ── Why it pauses rather than warns ─────────────────────────────────────────
//
// A warning is a thing somebody reads afterwards. The whole premise of auto
// mode is that nobody is watching, so the only response that means anything is
// to stop, which is also cheap to undo: a paused campaign resumes with one
// button and keeps its enrollments and its place in every sequence.
//
// ── Why it applies to every campaign, not only auto ones ────────────────────
//
// A review-mode campaign sends less of itself without a person, but the
// address reputation it spends is the same address reputation, and somebody
// approving drafts one at a time is if anything less likely to notice that the
// bounce rate across the whole run has reached one in ten. The valve is
// cheaper for them than for anybody, because they are already in the app.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { publish } from '../events.js';
import { notifyCampaignPaused } from './push.js';

const log = logger('valves');

/**
 * How many sends a bounce rate needs before it means anything.
 *
 * One bounce out of the first two sends is fifty per cent and is not evidence
 * of anything. Twenty is the point at which a rate over the threshold is
 * describing the list rather than describing luck — and a campaign that really
 * is sending to dead addresses will have tripped it long before it has done
 * any serious damage.
 */
export const MIN_SAMPLE = 20;

/** How long "several unsubscribes in a day" counts over. */
export const UNSUB_WINDOW_HOURS = 24;

export interface ValveReading {
  sent: number;
  bounced: number;
  bouncePct: number;
  unsubscribedToday: number;
  /** The sentence to show, or null when nothing is wrong. */
  tripped: string | null;
}

/**
 * Read both valves for one campaign.
 *
 * Exported separately from the acting-on-it so the campaign page can show the
 * numbers that are being watched without having to reproduce the arithmetic,
 * and so a test can drive the decision without a scheduler.
 */
export async function readValves(sequenceId: number): Promise<ValveReading> {
  const seq = await one<{ pause_on_bounce_pct: number; pause_on_unsubscribes: number }>(
    'SELECT pause_on_bounce_pct, pause_on_unsubscribes FROM sequences WHERE id=$1',
    [sequenceId],
  );
  const r = await one<{ sent: number; bounced: number; unsubs: number }>(
    `SELECT
       (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=$1 AND l.status='sent') AS sent,
       (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=$1 AND l.bounced_at IS NOT NULL) AS bounced,
       (SELECT count(*)::int FROM enrollments e WHERE e.sequence_id=$1 AND e.status='unsubscribed'
          AND e.finished_at > now() - ($2 || ' hours')::interval) AS unsubs`,
    [sequenceId, String(UNSUB_WINDOW_HOURS)],
  );
  return verdict(
    { sent: r?.sent ?? 0, bounced: r?.bounced ?? 0, unsubscribedToday: r?.unsubs ?? 0 },
    { bouncePct: seq?.pause_on_bounce_pct ?? 0, unsubscribes: seq?.pause_on_unsubscribes ?? 0 },
  );
}

/**
 * The decision itself, with no database in it.
 *
 * Split out so the thresholds can be tested directly: a valve is a thing that
 * stops somebody's campaign, and "does 1 bounce out of 2 trip an 8% limit"
 * should be answerable without standing up a schema.
 */
export function verdict(
  counts: { sent: number; bounced: number; unsubscribedToday: number },
  limits: { bouncePct: number; unsubscribes: number },
): ValveReading {
  const { sent, bounced, unsubscribedToday } = counts;
  const bouncePct = sent ? Math.round((1000 * bounced) / sent) / 10 : 0;

  // Zero means off for either threshold, which is how somebody who knows their
  // list turns a valve off without having to find a separate switch for it.
  let tripped: string | null = null;
  if (limits.bouncePct > 0 && sent >= MIN_SAMPLE && bouncePct >= limits.bouncePct) {
    tripped = `${bounced} of ${sent} sends bounced (${bouncePct}%), over the ${limits.bouncePct}% limit for this campaign. The list probably has dead addresses in it.`;
  } else if (limits.unsubscribes > 0 && unsubscribedToday >= limits.unsubscribes) {
    tripped = `${unsubscribedToday} people unsubscribed in the last ${UNSUB_WINDOW_HOURS} hours, at or over the limit of ${limits.unsubscribes}. The brief is probably landing badly.`;
  }
  return { sent, bounced, bouncePct, unsubscribedToday, tripped };
}

/**
 * Read the valves and stop the campaign if either has tripped.
 *
 * Called after a bounce and after an unsubscribe are recorded — the two events
 * that can move either number — rather than on a timer, so a campaign stops
 * within a sync of going wrong instead of within an hour of it.
 *
 * Returns whether it paused anything. Safe to call repeatedly: the update is
 * conditional on the campaign still being active, so the second call through
 * changes no rows and notifies nobody.
 */
export async function checkValves(sequenceId: number): Promise<boolean> {
  const seq = await one<{ id: number; user_id: number; name: string; status: string }>(
    'SELECT id, user_id, name, status FROM sequences WHERE id=$1',
    [sequenceId],
  );
  if (!seq || seq.status !== 'active') return false;
  const reading = await readValves(sequenceId);
  if (!reading.tripped) return false;

  const paused = await query<{ id: number }>(
    `UPDATE sequences SET status='paused', pause_reason=$2, paused_at=now(), updated_at=now()
      WHERE id=$1 AND status='active' RETURNING id`,
    [sequenceId, reading.tripped.slice(0, 500)],
  );
  // Somebody else got here first. Not an error, and not a second notification.
  if (!paused.length) return false;

  // The enrollments stop too. Pausing the campaign alone would leave every
  // active enrollment with a `next_run_at` in the future, so the run would
  // resume by itself the moment anybody set the status back without
  // understanding why it changed.
  await query(
    `UPDATE enrollments SET status='paused', next_run_at=NULL, error=$2, updated_at=now()
      WHERE sequence_id=$1 AND status IN ('active','waiting_review')`,
    [sequenceId, reading.tripped.slice(0, 500)],
  );

  log.warn('campaign paused by a valve', { sequence: sequenceId, reason: reading.tripped });
  publish({ type: 'enrollment', userId: seq.user_id, sequenceId, enrollmentId: 0, status: 'paused' });
  try { await notifyCampaignPaused(seq.user_id, sequenceId, seq.name, reading.tripped); }
  catch (e) { log.error('valve notification failed', { err: (e as Error).message }); }
  return true;
}
