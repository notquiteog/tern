// The advanced search form and the search box speak the same language:
// Gmail-style operators that the server's parser understands.
export interface SearchFields { from: string; to: string; subject: string; words: string; not: string; has: '' | 'attachment'; within: '' | '1d' | '3d' | '7d' | '30d' | '90d' | '1y'; box: string; unread: boolean; starred: boolean }

export const EMPTY_SEARCH: SearchFields = { from: '', to: '', subject: '', words: '', not: '', has: '', within: '', box: '', unread: false, starred: false };

const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

export function buildSearchQuery(f: Partial<SearchFields>): string {
  const parts: string[] = [];
  const t = (v?: string) => (v ?? '').trim();
  if (t(f.from)) parts.push(`from:${quote(t(f.from))}`);
  if (t(f.to)) parts.push(`to:${quote(t(f.to))}`);
  if (t(f.subject)) parts.push(`subject:${quote(t(f.subject))}`);
  if (f.has === 'attachment') parts.push('has:attachment');
  if (f.unread) parts.push('is:unread');
  if (f.starred) parts.push('is:starred');
  if (f.within) parts.push(`newer_than:${f.within}`);
  if (t(f.box)) parts.push(`in:${quote(t(f.box))}`);
  if (t(f.words)) parts.push(t(f.words));
  if (t(f.not)) parts.push(...t(f.not).split(/\s+/).map((w) => (w.startsWith('-') ? w : `-${w}`)));
  return parts.join(' ');
}

export function parseSearchQuery(q: string): SearchFields {
  const f: SearchFields = { ...EMPTY_SEARCH };
  const rest: string[] = [];
  const nots: string[] = [];
  const tokens = (q ?? '').match(/(?:-?[a-z_]+:(?:"[^"]*"|\S+))|"[^"]*"|\S+/gi) ?? [];
  for (const tok of tokens) {
    const m = tok.match(/^([a-z_]+):(.+)$/i);
    if (!m) { if (tok.startsWith('-') && tok.length > 1) nots.push(tok.slice(1)); else rest.push(tok); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].replace(/^"|"$/g, '');
    if (key === 'from') f.from = val;
    else if (key === 'to') f.to = val;
    else if (key === 'subject') f.subject = val;
    else if (key === 'has' && val === 'attachment') f.has = 'attachment';
    else if (key === 'is' && val === 'unread') f.unread = true;
    else if (key === 'is' && (val === 'starred' || val === 'flagged')) f.starred = true;
    else if (key === 'newer_than' && ['1d', '3d', '7d', '30d', '90d', '1y'].includes(val)) f.within = val as SearchFields['within'];
    else if (key === 'in' || key === 'label') f.box = val;
    else rest.push(tok);
  }
  f.words = rest.join(' ');
  f.not = nots.join(' ');
  return f;
}
