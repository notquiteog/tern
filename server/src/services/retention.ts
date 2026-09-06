// Automatic emptying of Trash and Junk, the way Gmail and Proton do it:
// anything that has sat in either for longer than the account's window is
// destroyed on the mail server and dropped from the cache. On by default at
// thirty days, per account, and switchable off.
//
// "How long it has sat there" is the message's received date, which is what
// every other mail service means by it and the only date JMAP gives us for
// free. A message received last year and deleted today is therefore purged
// on the next run: that matches Gmail, where the Trash window is measured
// from the message, not from the moment it was moved.
import { query } from '../db.js';
import { logger } from '../log.js';
import { publish } from '../events.js';
import { getAccount, type AccountRow } from './accounts.js';
import * as actions from '../jmap/actions.js';

const log = logger('retention');

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

export interface RetentionSettings { enabled: boolean; trashDays: number; junkDays: number }

export function retentionOf(acc: Pick<AccountRow, 'retention_enabled' | 'trash_retention_days' | 'junk_retention_days'>): RetentionSettings {
  return {
    enabled: acc.retention_enabled !== false,
    trashDays: clampDays(acc.trash_retention_days ?? 30),
    junkDays: clampDays(acc.junk_retention_days ?? 30),
  };
}

export function clampDays(n: number): number {
  if (!Number.isFinite(n)) return 30;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, Math.round(n)));
}

// The mailboxes automatic emptying applies to, each with its window.
async function purgeableBoxes(acc: AccountRow): Promise<{ ids: string[]; days: number[]; trash: Set<string> }> {
  const s = retentionOf(acc);
  const rows = await query<{ jmap_id: string; role: string }>(
    `SELECT jmap_id, role FROM mailboxes WHERE account_id=$1 AND role = ANY($2)`,
    [acc.id, ['trash', 'junk', 'spam']],
  );
  const ids: string[] = [], days: number[] = [], trash = new Set<string>();
  for (const r of rows) {
    ids.push(r.jmap_id);
    days.push(r.role === 'trash' ? s.trashDays : s.junkDays);
    if (r.role === 'trash') trash.add(r.jmap_id);
  }
  return { ids, days, trash };
}

// A message goes when *every* mailbox it is in is one of these and it is
// older than the longest window among them. Two consequences worth stating:
// a message that also sits somewhere else (it was labelled, or filed in
// Archive) is left alone, because emptying Trash should not destroy
// something the person kept; and one sitting in both Trash and Junk needs
// both windows to have passed, so the more generous setting wins.
async function expired(acc: AccountRow): Promise<{ jmap_id: string; mailbox_ids: string[] }[]> {
  const { ids, days } = await purgeableBoxes(acc);
  if (!ids.length) return [];
  return query<{ jmap_id: string; mailbox_ids: string[] }>(
    `WITH box(jmap_id, days) AS (SELECT * FROM unnest($2::text[], $3::int[]))
     SELECT e.jmap_id, e.mailbox_ids FROM emails e
      WHERE e.account_id=$1
        AND e.mailbox_ids && $2::text[]
        AND NOT EXISTS (SELECT 1 FROM unnest(e.mailbox_ids) m WHERE NOT (m = ANY($2::text[])))
        AND e.received_at < now() - ((SELECT max(b.days) FROM box b WHERE b.jmap_id = ANY(e.mailbox_ids)) || ' days')::interval
      ORDER BY e.received_at LIMIT 2000`,
    [acc.id, ids, days],
  );
}

export interface PurgeResult { trash: number; junk: number; [k: string]: number }

// Purges one account. Errors are the caller's to log: a mail server that is
// down should not stop the rest of housekeeping, and the next run retries.
export async function purgeAccount(acc: AccountRow): Promise<PurgeResult> {
  const s = retentionOf(acc);
  const out: PurgeResult = { trash: 0, junk: 0 };
  if (!s.enabled || !acc.enabled) return out;
  const { trash } = await purgeableBoxes(acc);
  const rows = await expired(acc);
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    await actions.destroyEmails(acc, slice.map((r) => r.jmap_id));
    // One in both is counted as trash: it is more deleted than it is spam.
    for (const r of slice) if (r.mailbox_ids.some((m) => trash.has(m))) out.trash++; else out.junk++;
  }
  await query('UPDATE accounts SET last_retention_at=now() WHERE id=$1', [acc.id]);
  if (out.trash || out.junk) {
    log.info(`purged account ${acc.id}`, out);
    publish({ type: 'sync', userId: acc.user_id, accountId: acc.id });
  }
  return out;
}

// Every account whose window has not been applied in the last day. Run from
// housekeeping, so a box that is off overnight catches up when it starts.
export async function runRetention(force = false): Promise<PurgeResult & { accounts: number }> {
  const due = await query<{ id: number }>(
    `SELECT id FROM accounts WHERE enabled AND retention_enabled AND initial_sync_done
       AND ($1::boolean OR last_retention_at IS NULL OR last_retention_at < now() - interval '20 hours')
     ORDER BY last_retention_at NULLS FIRST LIMIT 50`,
    [force],
  );
  const total: PurgeResult & { accounts: number } = { trash: 0, junk: 0, accounts: 0 };
  for (const { id } of due) {
    const acc = await getAccount(id);
    if (!acc) continue;
    try {
      const r = await purgeAccount(acc);
      total.trash += r.trash; total.junk += r.junk; total.accounts += 1;
    } catch (e) {
      log.warn(`retention failed for account ${id}`, { err: (e as Error).message });
    }
  }
  return total;
}

// What the next run would remove, for the settings page. Counting rather
// than destroying, so someone can see the effect before turning it on.
export async function previewRetention(acc: AccountRow): Promise<{ trash: number; junk: number }> {
  const { trash } = await purgeableBoxes(acc);
  const out = { trash: 0, junk: 0 };
  for (const r of await expired(acc)) {
    if (r.mailbox_ids.some((m) => trash.has(m))) out.trash++; else out.junk++;
  }
  return out;
}
