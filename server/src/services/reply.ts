// Who a reply goes to. The same rules serve the composer in the browser and
// the AI responders on the server, so an automated answer never addresses a
// different set of people than a person clicking Reply would.
//
//   reply:      Reply-To if present, else From. If that is only us (we are
//               replying to our own sent message), the original To instead.
//   reply all:  the same To, plus every other To and Cc recipient, minus our
//               own addresses and minus anyone already in To.
// Addresses compare case-insensitively; duplicates are dropped.
export interface Addr { name?: string | null; email: string }
export interface ReplySource { from?: Addr[] | null; replyTo?: Addr[] | null; to?: Addr[] | null; cc?: Addr[] | null }

const norm = (e: string | null | undefined) => String(e ?? '').trim().toLowerCase();

function dedupe(list: Addr[]): Addr[] {
  const seen = new Set<string>();
  const out: Addr[] = [];
  for (const a of list) {
    const e = norm(a?.email);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push({ name: a.name ?? null, email: a.email.trim() });
  }
  return out;
}

export function replyRecipients(m: ReplySource, myEmails: string | string[], all = false): { to: Addr[]; cc: Addr[] } {
  const me = new Set((Array.isArray(myEmails) ? myEmails : [myEmails]).map(norm).filter(Boolean));
  const notMe = (a: Addr) => !me.has(norm(a?.email));
  const valid = (a: Addr) => Boolean(a && typeof a.email === 'string' && a.email.includes('@'));
  const replyTo = (m.replyTo ?? []).filter(valid);
  const from = (m.from ?? []).filter(valid);
  const origTo = (m.to ?? []).filter(valid);
  const origCc = (m.cc ?? []).filter(valid);
  const primary = replyTo.length ? replyTo : from;
  let to = dedupe(primary.filter(notMe));
  // Our own message: answer the people we wrote to.
  if (!to.length) to = dedupe(origTo.filter(notMe));
  // Nobody but us anywhere (a note to self): reply to ourselves.
  if (!to.length) to = dedupe(primary.length ? primary : origTo);
  const cc = all ? dedupe([...origTo, ...origCc].filter(notMe).filter((a) => !to.some((t) => norm(t.email) === norm(a.email)))) : [];
  return { to, cc };
}

const RE_PREFIX = /^\s*((re|aw|sv|antw|vs|ref|r)\s*(\[\d+\])?\s*:\s*)+/i;
const FWD_PREFIX = /^\s*((fwd?|wg|tr|vl|enc|i)\s*:\s*)+/i;

export function replySubject(subject: string | null | undefined): string {
  const s = String(subject ?? '').trim();
  if (!s) return 'Re: (no subject)';
  if (/^re\s*:/i.test(s)) return s;
  return `Re: ${s.replace(RE_PREFIX, '')}`;
}

export function forwardSubject(subject: string | null | undefined): string {
  const s = String(subject ?? '').trim();
  if (!s) return 'Fwd: (no subject)';
  if (/^fwd?\s*:/i.test(s)) return s;
  return `Fwd: ${s.replace(FWD_PREFIX, '')}`;
}
