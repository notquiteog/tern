// Memoisation for the one query in the mail list that is genuinely expensive
// and genuinely repeated: the per-thread aggregate behind the inbox's
// category counts.
//
// Those counts are the same whichever tab is open, so clicking through
// Primary → Transactions → Updates → Promotions recomputed the identical
// aggregate four times. They are also the same for every page of a tab.
//
// Correctness comes first: an entry is keyed to a version that moves the
// moment anything about that account's mail changes, so an archived
// conversation cannot leave a stale number behind. The time limit is a second
// line only, for anything that writes to `emails` without saying so.
import { logger } from '../log.js';

const log = logger('mailcache');

export interface CategoryCounts { [category: string]: { n: number; unread: number } }

// Belt and braces: even a version that somehow stops moving cannot hold a
// count for longer than this.
const TTL_MS = 30_000;
// A busy install with several people searching should not be able to grow
// this without bound; the oldest entries go first.
const MAX_ENTRIES = 300;

const versions = new Map<number, number>();
const entries = new Map<string, { at: number; version: string; value: CategoryCounts }>();

// Called from every path that writes to `emails`. Cheap on purpose: a counter
// in a Map, in a process the rest of the app already assumes is the only one.
export function touchAccount(accountId: number): void {
  versions.set(accountId, (versions.get(accountId) ?? 0) + 1);
}
export function touchAccounts(accountIds: Iterable<number>): void {
  for (const id of accountIds) touchAccount(id);
}

// The combined version of every account a query covers. Any one of them
// moving invalidates the entry, which is what "this list is out of date"
// actually means when the list spans several mailboxes.
export function versionOf(accountIds: number[]): string {
  return accountIds.map((id) => `${id}:${versions.get(id) ?? 0}`).join(',');
}

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, v] of entries) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
  if (oldestKey) entries.delete(oldestKey);
}

export async function rememberCounts(key: string, accountIds: number[], compute: () => Promise<CategoryCounts>): Promise<CategoryCounts> {
  const version = versionOf(accountIds);
  const hit = entries.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await compute();
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) evictOldest();
  entries.set(key, { at: Date.now(), version, value });
  return value;
}

// Exported for tests and for the CLI's diagnostics.
export function cacheStats(): { entries: number; accounts: number } {
  return { entries: entries.size, accounts: versions.size };
}
export function clearMailCache(): void {
  entries.clear();
  log.info('mail cache cleared');
}
