// Gmail-style search operators over the local cache. Since the cache is
// encrypted at rest (ENCRYPTION.md layer 1), free text and addresses are
// matched against the blind index in `emails.search_terms` and
// `address_terms` rather than a tsvector over plaintext: the words a person
// searches for are hashed with their own key and compared as opaque terms.
//
// What that changes, and it is worth being plain about it: matching is by
// whole word and by prefix, there is no relevance ranking (results are newest
// first), no stemming, and no phrase search — quoting words still requires
// all of them, but not adjacently. Everything that is not text (dates, flags,
// mailboxes, size) is unchanged, because those columns are not secret.
import { query } from '../db.js';
import { addressQuery, queryTermGroups } from './vault.js';

export interface ParsedSearch {
  text: string;
  exclude?: string;
  from?: string; to?: string; subject?: string;
  unread?: boolean; starred?: boolean; attachment?: boolean;
  label?: string; before?: string; after?: string;
  newerDays?: number; olderDays?: number;
  larger?: number;
}

export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { text: '' };
  const rest: string[] = [];
  const tokens = q.match(/(?:-?[a-z_]+:(?:"[^"]*"|\S+))|-?"[^"]*"|\S+/gi) ?? [];
  const excluded: string[] = [];
  for (const t of tokens) {
    // A leading dash excludes the word. The full-text search this replaced
    // understood the same notation, and the advanced search form still emits
    // it, so it has to keep working against the blind index.
    if (t.length > 1 && t.startsWith('-') && !/^-[a-z_]+:/i.test(t)) { excluded.push(t.slice(1).replace(/^"|"$/g, '')); continue; }
    const m = t.match(/^([a-z_]+):(.+)$/i);
    if (!m) { rest.push(t); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^"|"$/g, '');
    switch (key) {
      case 'from': out.from = val; break;
      case 'to': out.to = val; break;
      case 'subject': out.subject = val; break;
      case 'is': if (val === 'unread') out.unread = true; else if (val === 'read') out.unread = false; else if (val === 'starred' || val === 'flagged') out.starred = true; break;
      case 'has': if (val === 'attachment') out.attachment = true; break;
      case 'label': case 'in': out.label = val; break;
      case 'before': out.before = val; break;
      case 'after': out.after = val; break;
      case 'newer_than': { const d = parseDays(val); if (d) out.newerDays = d; break; }
      case 'older_than': { const d = parseDays(val); if (d) out.olderDays = d; break; }
      case 'larger': out.larger = parseSize(val); break;
      default: rest.push(t);
    }
  }
  out.text = rest.join(' ').trim();
  const ex = excluded.join(' ').trim();
  if (ex) out.exclude = ex;
  return out;
}

function parseDays(v: string): number | null {
  const m = v.match(/^(\d+)([dwmy])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return { d: n, w: n * 7, m: n * 30, y: n * 365 }[m[2].toLowerCase()] ?? null;
}
function parseSize(v: string): number {
  const m = v.match(/^(\d+)([km]?)b?$/i);
  if (!m) return 0;
  return Number(m[1]) * ({ '': 1, k: 1024, m: 1024 * 1024 }[m[2].toLowerCase()] ?? 1);
}

export async function buildSearchSql(s: ParsedSearch, accountIds: number[], p: (v: unknown) => string, userId: number): Promise<string[]> {
  const where: string[] = [];
  if (s.text) {
    // One clause per word, each an overlap against that word's alternatives
    // (its exact hash and its prefix bucket). ANDing the clauses is what makes
    // a two-word search mean both words.
    const groups = await queryTermGroups(userId, s.text);
    if (!groups.length) where.push('false');
    for (const g of groups) where.push(`e.search_terms && ${p(g)}::bytea[]`);
  }
  // `subject:` no longer narrows to the subject line: the index does not
  // record which field a term came from, so it behaves as a word search.
  // Better an honest superset than a filter that silently drops matches.
  if (s.subject) {
    const groups = await queryTermGroups(userId, s.subject);
    if (!groups.length) where.push('false');
    for (const g of groups) where.push(`e.search_terms && ${p(g)}::bytea[]`);
  }
  if (s.exclude) {
    // Every excluded word is one NOT clause: a message matching any of them
    // is out, which is what a person means by "not this".
    for (const g of await queryTermGroups(userId, s.exclude)) where.push(`NOT (e.search_terms && ${p(g)}::bytea[])`);
  }
  if (s.from) {
    const terms = await addressQuery(userId, s.from);
    where.push(terms.length ? `e.from_terms && ${p(terms)}::bytea[]` : 'false');
  }
  if (s.to) {
    // `to:` matches any recipient, and the address index covers all of them,
    // so a message the person was cc'd on answers too, as it did before.
    const terms = await addressQuery(userId, s.to);
    where.push(terms.length ? `e.address_terms && ${p(terms)}::bytea[]` : 'false');
  }
  if (s.unread !== undefined) where.push(s.unread ? 'e.is_unread' : 'NOT e.is_unread');
  if (s.starred) where.push('e.is_flagged');
  if (s.attachment) where.push('e.has_attachment');
  if (s.before) where.push(`e.received_at < ${p(s.before)}::timestamptz`);
  if (s.after) where.push(`e.received_at >= ${p(s.after)}::timestamptz`);
  if (s.newerDays) where.push(`e.received_at >= now() - (${p(String(s.newerDays))} || ' days')::interval`);
  if (s.olderDays) where.push(`e.received_at < now() - (${p(String(s.olderDays))} || ' days')::interval`);
  if (s.larger) where.push(`e.size > ${p(s.larger)}`);
  if (s.label) {
    const rows = await query<{ jmap_id: string }>(`SELECT jmap_id FROM mailboxes WHERE account_id = ANY($1) AND (lower(name) = lower($2) OR role = lower($2))`, [accountIds, s.label]);
    where.push(rows.length ? `e.mailbox_ids && ${p(rows.map((r) => r.jmap_id))}::text[]` : 'false');
  }
  return where;
}
