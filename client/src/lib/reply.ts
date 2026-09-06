// Reply and forward seeds: who a reply goes to, the subject prefixes, and the
// quoted original. The addressing rules are the same ones the server's AI
// responders use (server/src/services/reply.ts), kept in step by the tests.
import { addrFull, escapeHtml, fmtDateTime, type Addr } from './format';
import { sanitizeForEditor } from './sanitize';

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

//   reply:      Reply-To if present, else From. If that is only us (we are
//               replying to our own sent message), the original To instead.
//   reply all:  the same To, plus every other To and Cc recipient, minus our
//               own addresses and minus anyone already in To.
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
  if (!to.length) to = dedupe(origTo.filter(notMe));
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

export interface QuotableMessage { received_at: string; sent_at?: string | null; from_addr?: Addr[] | null; to_addr?: Addr[] | null; cc_addr?: Addr[] | null; subject?: string | null; body_html?: string | null; body_text?: string | null }

// The original's HTML is someone else's; it is cleaned before it becomes
// part of a message we write, so the draft saved to the server is clean too.
function bodyOf(m: QuotableMessage): string {
  if (m.body_html) return sanitizeForEditor(m.body_html);
  if (m.body_text) return `<div style="white-space:pre-wrap">${escapeHtml(m.body_text)}</div>`;
  return '';
}

// "On <date>, <person> wrote:" and the original indented, the way every
// client since Gmail has done it. The wrapper class marks where the
// person's own words end.
export function buildQuoteHtml(m: QuotableMessage): string {
  const header = `On ${fmtDateTime(m.sent_at ?? m.received_at)}, ${escapeHtml(addrFull(m.from_addr?.[0]))} wrote:`;
  return `<div class="tern-quote"><div class="tern-quote-head" style="color:#5b6274;font-size:12.5px;margin:0 0 6px">${header}</div><blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d0d4e0">${bodyOf(m)}</blockquote></div>`;
}

export function buildForwardHtml(m: QuotableMessage): string {
  const rows = [
    ['From', escapeHtml(addrFull(m.from_addr?.[0]))],
    ['Date', escapeHtml(fmtDateTime(m.sent_at ?? m.received_at))],
    ['Subject', escapeHtml(m.subject || '(no subject)')],
    ['To', escapeHtml((m.to_addr ?? []).map(addrFull).join(', '))],
    ...(m.cc_addr?.length ? [['Cc', escapeHtml(m.cc_addr.map(addrFull).join(', '))]] : []),
  ];
  return `<div class="tern-quote"><div class="tern-quote-head" style="color:#5b6274;font-size:12.5px;margin:0 0 10px">---------- Forwarded message ---------<br>${rows.map(([k, v]) => `${k}: ${v}`).join('<br>')}</div>${bodyOf(m)}</div>`;
}

// A List-Unsubscribe header: "<mailto:...>, <https://...>" in any order.
export function parseListUnsubscribe(header: string | null | undefined): { mailto: string | null; subject: string | null; url: string | null } {
  const out = { mailto: null as string | null, subject: null as string | null, url: null as string | null };
  if (!header) return out;
  for (const m of String(header).matchAll(/<([^>]+)>/g)) {
    const v = m[1].trim();
    if (/^mailto:/i.test(v) && !out.mailto) {
      const [addr, qs] = v.slice(7).split('?');
      out.mailto = decodeURIComponent(addr);
      const sub = qs ? new URLSearchParams(qs).get('subject') : null;
      out.subject = sub ? sub : null;
    } else if (/^https?:\/\//i.test(v) && !out.url) out.url = v;
  }
  return out;
}
