// Gmail-style search operators over the local cache. Anything that is not
// an operator becomes a websearch_to_tsquery over subject and body.
import { query } from '../db.js';

export interface ParsedSearch {
  text: string;
  from?: string; to?: string; subject?: string;
  unread?: boolean; starred?: boolean; attachment?: boolean;
  label?: string; before?: string; after?: string;
  newerDays?: number; olderDays?: number;
  larger?: number;
}

export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { text: '' };
  const rest: string[] = [];
  const tokens = q.match(/(?:[a-z_]+:(?:"[^"]*"|\S+))|"[^"]*"|\S+/gi) ?? [];
  for (const t of tokens) {
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

export async function buildSearchSql(s: ParsedSearch, accountIds: number[], p: (v: unknown) => string): Promise<string[]> {
  const where: string[] = [];
  if (s.text) where.push(`e.search_tsv @@ websearch_to_tsquery('simple', ${p(s.text)})`);
  if (s.from) where.push(`(e.from_addr::text ILIKE ${p('%' + s.from + '%')})`);
  if (s.to) where.push(`((e.to_addr::text || e.cc_addr::text) ILIKE ${p('%' + s.to + '%')})`);
  if (s.subject) where.push(`e.subject ILIKE ${p('%' + s.subject + '%')}`);
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
