// How long anything derived from mail is kept, in one place, with defaults
// chosen to be the shortest each feature can actually work with.
//
// This is separate from services/retention.ts, which empties Trash and Junk
// on the mail server. That is about the person's own mail. This is about the
// copies and by-products Tern makes while doing its job: queued prompts,
// decided reviews, sent copies, a cached brief, closed commitments, the
// audit log. None of it is mail anybody asked to keep, so the question for
// each row is not "when should this expire" but "what breaks if it is gone
// sooner", and the default is the answer to that.
//
// The two that are hours rather than days are the ones that hold mail
// content: a finished AI job's prompt, and the review queue's copy of the
// message being answered. Both are emptied of their content the moment they
// stop being needed — see the `ai_job_payloads` sweep in the scheduler — so
// the window below is for the row, not for the text.
import { one, query } from '../db.js';

export interface RetentionPolicy {
  /** Sent copies in the outbox. The mailbox has the real one. */
  outboxDays: number;
  /** Reviews after they have been accepted or rejected. */
  reviewDays: number;
  /** Finished AI jobs, in hours. Their payloads are wiped immediately. */
  aiJobHours: number;
  /** The audit log, which is the record of who did what. */
  auditDays: number;
  /** A generated brief, which is a cache of a page. */
  briefDays: number;
  /** Commitments after they are done or dropped. */
  commitmentDays: number;
  /** Invitations after the meeting has passed. */
  calendarDays: number;
}

// Deliberately low. Every one of these was longer before the audit that
// produced this file, and each was shortened to the point where the feature
// still works: an outbox copy is only there for "show me what I sent while
// the mailbox catches up", a decided review is only there so somebody can
// see what they approved last week, and a finished AI job is only there so a
// failure can be read after the fact.
export const RETENTION_DEFAULTS: RetentionPolicy = {
  outboxDays: 2,
  reviewDays: 7,
  aiJobHours: 12,
  auditDays: 90,
  briefDays: 7,
  commitmentDays: 14,
  calendarDays: 60,
};

// Floors, so an admin cannot set a value that breaks the feature it belongs
// to — an outbox emptied after an hour would lose a scheduled send.
const MIN: RetentionPolicy = {
  outboxDays: 1, reviewDays: 1, aiJobHours: 1, auditDays: 7,
  briefDays: 1, commitmentDays: 1, calendarDays: 1,
};
const MAX: RetentionPolicy = {
  outboxDays: 90, reviewDays: 365, aiJobHours: 720, auditDays: 3650,
  briefDays: 90, commitmentDays: 365, calendarDays: 3650,
};

let cache: { at: number; value: RetentionPolicy } | null = null;

export async function retentionSettings(): Promise<RetentionPolicy> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const row = await one<{ value: Partial<RetentionPolicy> }>(`SELECT value FROM settings WHERE key='retention'`);
  const value = clamp({ ...RETENTION_DEFAULTS, ...(row?.value ?? {}) });
  cache = { at: Date.now(), value };
  return value;
}

export async function saveRetentionSettings(patch: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
  const next = clamp({ ...(await retentionSettings()), ...patch });
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('retention', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(next)],
  );
  cache = null;
  return next;
}

export function forgetRetentionSettings(): void { cache = null; }

export function clamp(p: RetentionPolicy): RetentionPolicy {
  const out = {} as RetentionPolicy;
  for (const key of Object.keys(RETENTION_DEFAULTS) as (keyof RetentionPolicy)[]) {
    const n = Number(p[key]);
    out[key] = Number.isFinite(n) ? Math.min(MAX[key], Math.max(MIN[key], Math.round(n))) : RETENTION_DEFAULTS[key];
  }
  return out;
}

export const RETENTION_BOUNDS = { min: MIN, max: MAX };

// What each window is holding right now, so the admin page can show the cost
// of a setting rather than just its number.
export async function retentionFootprint(): Promise<Record<string, number>> {
  const rows = await query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM outbox WHERE status IN ('sent','cancelled')) AS outbox,
      (SELECT count(*)::int FROM review_queue WHERE status <> 'pending') AS reviews,
      (SELECT count(*)::int FROM ai_jobs WHERE status IN ('done','failed','skipped')) AS ai_jobs,
      (SELECT count(*)::int FROM ai_jobs WHERE status IN ('done','failed','skipped') AND payload <> '{}'::jsonb) AS ai_jobs_with_content,
      (SELECT count(*)::int FROM audit_log) AS audit_log,
      (SELECT count(*)::int FROM briefs) AS briefs,
      (SELECT count(*)::int FROM commitments WHERE status <> 'open') AS closed_commitments,
      (SELECT count(*)::int FROM calendar_events) AS calendar_events,
      -- Synced calendars (F13). These are counted but never aged out, and
      -- the distinction matters: everything else on this page is data Tern
      -- derived and can rebuild, while a calendar's events are somebody
      -- else's records that this server holds a copy of. Deleting them on a
      -- schedule would make the calendar wrong rather than smaller — the
      -- next sync would simply fetch them again. What does get trimmed is
      -- the expanded occurrences outside the rolling window, which the
      -- calendar worker prunes on its own.
      (SELECT count(*)::int FROM calendar_objects) AS calendar_events_synced,
      (SELECT count(*)::int FROM calendar_instances) AS calendar_occurrences
  `);
  return rows[0] ?? {};
}
