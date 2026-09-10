// What each capability is holding, and how to make it hold nothing.
//
// Turning a switch off has to mean something. If revoking consent only
// stopped new work, an index built from a year of somebody's mail would sit
// there afterwards, and the switch would be a promise the product does not
// keep. So revoking erases, in the same request, and this file is the single
// list of what belongs to what.
//
// Keeping the list here rather than beside each feature is on purpose: the
// question "what does this capability still hold?" has to be answerable
// without reading nine other files, and a new feature that forgets to answer
// it shows up as a missing case rather than as silent leftovers.
import { query } from '../db.js';
import { eraseSemanticIndex } from './semantic.js';
import { logger } from '../log.js';
import type { Capability } from './capabilities.js';

const log = logger('capability-data');

// One SQL statement per capability, each returning the rows it destroyed.
// A capability that keeps nothing is absent, which is how the UI knows not
// to warn before switching it off.
const ERASE: Partial<Record<Capability, string[]>> = {
  'ai.summaries': [
    `DELETE FROM thread_summaries s USING accounts a WHERE a.id=s.account_id AND a.user_id=$1`,
  ],
  semantic: [
    `DELETE FROM email_vectors v USING accounts a WHERE a.id=v.account_id AND a.user_id=$1`,
    `UPDATE emails e SET embedded=false FROM accounts a WHERE a.id=e.account_id AND a.user_id=$1 AND e.embedded`,
  ],
  triage: [
    `DELETE FROM triage_models WHERE user_id=$1`,
    `UPDATE emails e SET priority=NULL FROM accounts a WHERE a.id=e.account_id AND a.user_id=$1 AND e.priority IS NOT NULL`,
  ],
  guard: [
    `UPDATE emails e SET guard_flags='{}', guard_detail=NULL, guard_checked=false
       FROM accounts a WHERE a.id=e.account_id AND a.user_id=$1 AND e.guard_checked`,
  ],
  attachments: [
    `DELETE FROM attachment_text t USING accounts a WHERE a.id=t.account_id AND a.user_id=$1`,
    `UPDATE emails e SET attachments_extracted=false FROM accounts a WHERE a.id=e.account_id AND a.user_id=$1 AND e.attachments_extracted`,
  ],
  commitments: [
    `DELETE FROM commitments WHERE user_id=$1`,
    `DELETE FROM commitment_scans s USING accounts a WHERE a.id=s.account_id AND a.user_id=$1`,
  ],
  brief: [`DELETE FROM briefs WHERE user_id=$1`],
  calendar: [
    `DELETE FROM calendar_events WHERE user_id=$1`,
    // The connections go with the data (F13). Leaving a source behind would
    // mean a background worker still holding a credential and still talking
    // to Google on behalf of somebody who has just said stop; the cascade
    // takes the calendars, objects and instances with it.
    `DELETE FROM calendar_sources WHERE user_id=$1`,
    `DELETE FROM calendars WHERE user_id=$1`,
  ],
  'ai.responders': [
    // The responders themselves are the person's own configuration and are
    // left alone; what goes is the work queued on their behalf, which is a
    // copy of mail waiting to be read by a model that may no longer read it.
    `DELETE FROM ai_jobs WHERE user_id=$1 AND kind='responder' AND status='pending'`,
  ],
  import: [`DELETE FROM mail_imports WHERE user_id=$1 AND status IN ('pending','running')`],
  // The whole transcript, and every draft and picture proposed inside it. The
  // messages go with the conversation by cascade; this names both anyway,
  // because a row orphaned by a cascade that was later relaxed would be a
  // mailbox quoted in clear that nobody is looking for.
  'ai.assistant': [
    `DELETE FROM ai_messages WHERE user_id=$1`,
    `DELETE FROM ai_conversations WHERE user_id=$1`,
  ],
};

// How many rows each capability is holding for this person, for the line
// under the switch that says what turning it off would destroy.
const COUNT: Partial<Record<Capability, string>> = {
  'ai.summaries': `SELECT count(*)::int AS n FROM thread_summaries s JOIN accounts a ON a.id=s.account_id WHERE a.user_id=$1`,
  semantic: `SELECT count(*)::int AS n FROM email_vectors v JOIN accounts a ON a.id=v.account_id WHERE a.user_id=$1`,
  triage: `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id WHERE a.user_id=$1 AND e.priority IS NOT NULL`,
  guard: `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id WHERE a.user_id=$1 AND array_length(e.guard_flags,1) > 0`,
  attachments: `SELECT count(*)::int AS n FROM attachment_text t JOIN accounts a ON a.id=t.account_id WHERE a.user_id=$1`,
  commitments: `SELECT count(*)::int AS n FROM commitments WHERE user_id=$1 AND status='open'`,
  brief: `SELECT count(*)::int AS n FROM briefs WHERE user_id=$1`,
  calendar: `SELECT (SELECT count(*) FROM calendar_events WHERE user_id=$1)
                  + (SELECT count(*) FROM calendar_objects WHERE user_id=$1) AS n`,
  // Conversations rather than messages: "12 conversations" is a number
  // somebody recognises, and "418 messages" is not the same warning.
  'ai.assistant': `SELECT count(*)::int AS n FROM ai_conversations WHERE user_id=$1`,
};

export async function capabilityFootprint(userId: number): Promise<Partial<Record<Capability, number>>> {
  const out: Partial<Record<Capability, number>> = {};
  for (const [cap, sql] of Object.entries(COUNT) as [Capability, string][]) {
    try {
      const rows = await query<{ n: number }>(sql, [userId]);
      out[cap] = rows[0]?.n ?? 0;
    } catch (e) {
      log.warn(`could not count what ${cap} holds`, { err: (e as Error).message });
    }
  }
  return out;
}

export async function eraseCapabilityData(userId: number, cap: Capability): Promise<number> {
  const statements = ERASE[cap];
  if (!statements) return 0;
  let erased = 0;
  for (const sql of statements) {
    try {
      const rows = await query(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`, [userId]);
      erased += (rows[0] as any)?.n ?? 0;
    } catch (e) {
      log.error(`could not erase ${cap} data`, { user: userId, err: (e as Error).message });
      throw e;
    }
  }
  // The vectors are not rows any more.
  //
  // `ERASE.semantic` deletes the manifest and marks the mail unindexed, which
  // was a total erase while the vectors WERE those rows. Since they moved to
  // Qdrant it deletes the bookkeeping and leaves every vector in place — and
  // `CAPABILITY_META.semantic.erases` says "the whole meaning index", which the
  // Features page shows in the confirmation dialog before somebody revokes.
  //
  // Not inside the SQL loop, and not allowed to fail the erase: refusing to
  // honour a consent revocation because a vector service is unreachable is the
  // wrong failure. `eraseSemanticIndex` never throws, logs loudly when it
  // cannot reach the index, and returns what it managed to drop.
  if (cap === 'semantic') {
    const dropped = await eraseSemanticIndex(userId);
    if (dropped) log.info(`dropped ${dropped} vector collections after semantic was turned off`, { user: userId });
  }
  log.info(`erased ${erased} rows after ${cap} was turned off`, { user: userId });
  return erased;
}

// Used by account deletion, which must leave nothing behind whatever was
// consented to. The per-capability statements are keyed on the user, so
// running the lot is the same thing as a cascade with a receipt.
export async function eraseAllCapabilityData(userId: number): Promise<number> {
  let total = 0;
  for (const cap of Object.keys(ERASE) as Capability[]) total += await eraseCapabilityData(userId, cap);
  return total;
}
