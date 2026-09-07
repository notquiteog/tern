// F3: the impersonation guard.
//
// This is the attack that empties bank accounts of people who run a business
// out of a real mailbox. Not malware, not a dodgy link — a message from
// somebody you have been talking to for months, with the right display name
// and a domain one character out, asking you to pay a different account. The
// existing link-mismatch check and the BIMI tick do not touch it, because
// nothing about the message is malformed. It is the *identity* that is wrong.
//
// So: no model, no cloud, no reputation service. Every check below is a
// comparison against what this mailbox already knows, run once as the
// message is synced, from headers that are already fetched. It costs nothing
// and it needs no network.
//
// The output is deliberately small. One banner, never stacked, with the
// specific reason — "Ana Duarte usually writes from corp.example" beats any
// number of yellow triangles. Mail that passes every check gets nothing at
// all, because a warning on everything is a warning on nothing.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { dataKey, openWith, sealWith } from './vault.js';
import { allowed } from './capabilities.js';

const log = logger('guard');

export const GUARD_FLAGS = [
  'display_name_mismatch',
  'lookalike_domain',
  'reply_to_offsite',
  'thread_sender_changed',
  'first_contact',
  'unauthenticated',
] as const;
export type GuardFlag = (typeof GUARD_FLAGS)[number];

// Ordered worst first: the banner shows one line, and it should be the one
// that matters. A hijacked thread beats a lookalike domain beats a name that
// does not match, and "we have not met" is context rather than an alarm.
export const FLAG_SEVERITY: Record<GuardFlag, number> = {
  thread_sender_changed: 5,
  lookalike_domain: 4,
  display_name_mismatch: 3,
  reply_to_offsite: 2,
  unauthenticated: 1,
  first_contact: 0,
};

export interface GuardDetail {
  /** The domain or address this one is pretending to be, when there is one. */
  expected?: string;
  actual?: string;
  /** For a name mismatch: the name that matched somebody else. */
  name?: string;
  /** How many messages this mailbox has had from the address it resembles. */
  seen?: number;
}

export interface GuardResult { flags: GuardFlag[]; detail: GuardDetail }

// ---------- Domain comparison ----------

// Confusable characters, folded to what they are pretending to be. This is
// not the whole Unicode confusables table — that is thousands of entries and
// most of them never appear in a domain — but it is the part attackers
// actually use, plus the ASCII pairs that fool a person reading quickly.
const CONFUSABLES: Record<string, string> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
  'ı': 'i', 'і': 'i', 'ӏ': 'l', 'ⅼ': 'l',
  'ο': 'o', 'о': 'o', 'օ': 'o', '𝗈': 'o',
  'а': 'a', 'ɑ': 'a', 'α': 'a',
  'е': 'e', 'ε': 'e',
  'с': 'c', 'ϲ': 'c',
  'р': 'p', 'ρ': 'p',
  'ѕ': 's', 'ѡ': 'w', 'у': 'y', 'γ': 'y',
  'х': 'x', 'κ': 'k', 'м': 'm', 'н': 'h', 'τ': 't', 'ν': 'v', 'ɡ': 'g',
  'rn': 'm', 'vv': 'w', 'cl': 'd',
};

// A domain reduced to what it looks like at a glance. Punycode is decoded to
// nothing on purpose: an `xn--` label is not readable by a person, so the
// skeleton keeps it whole and the comparison below treats it as its own
// thing rather than pretending to know what it renders as.
export function skeleton(domain: string): string {
  let d = String(domain ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Two-character substitutions first, or "rn" would be folded letter by letter.
  d = d.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
  let out = '';
  for (const ch of d) out += CONFUSABLES[ch] ?? ch;
  // Hyphens are free in a lookalike ("corp-example.com" for "corpexample.com").
  return out.replace(/-/g, '');
}

// Levenshtein, bounded: anything further than `max` apart returns max+1
// without finishing, because the only question asked here is "is this within
// one or two edits".
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// The registrable part, near enough: the last two labels, or three when the
// second-to-last is one of the common two-part suffixes. Getting this exactly
// right needs the public suffix list, which is a megabyte that would have to
// be kept current; being wrong here costs a warning that names one label too
// many, which is survivable, and being absent costs the check entirely.
const TWO_PART = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'gob', 'nom']);
export function registrable(domain: string): string {
  const parts = String(domain ?? '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  // The label immediately before the top-level one. In "corpexample.co.uk"
  // that is "co", which means the name is a label further left; in
  // "mail.corpexample.com" it is "corpexample", which means the name is
  // already there and everything to its left is a subdomain.
  const beforeTld = parts[parts.length - 2];
  return TWO_PART.has(beforeTld) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

// The name itself, without its suffix: "corpexample" out of
// "corpexample.co.uk". How much of a domain is actually chosen by whoever
// registered it, which is what the comparison below has to reason about.
export function registrableName(domain: string): string {
  return registrable(domain).split('.')[0] ?? '';
}

// Is `candidate` pretending to be `known`? Two domains that are genuinely
// different come out far apart; the interesting cases are the ones that are
// identical once you stop reading carefully.
export function looksLike(candidate: string, known: string): boolean {
  const c = registrable(candidate), k = registrable(known);
  if (!c || !k || c === k) return false;
  const sc = skeleton(c), sk = skeleton(k);
  // Identical to the eye but not to the resolver: the strongest case there
  // is, and the only one a short domain gets.
  if (sc === sk) return true;
  // Below that, edit distance — but measured against the chosen part of the
  // name rather than the whole string, because ".com" is four characters of
  // free similarity that every domain on the internet shares. "xero" and
  // "zero" are one edit apart and unrelated; "corpexample" and "corpexarnple"
  // are one edit apart and one of them does not exist. The difference is how
  // much name there is to be wrong about.
  const nc = skeleton(registrableName(candidate)), nk = skeleton(registrableName(known));
  const shortest = Math.min(nc.length, nk.length);
  if (shortest < 7) return false;
  const max = shortest >= 12 ? 2 : 1;
  return editDistance(nc, nk, max) <= max;
}

// ---------- Authentication-Results ----------

export interface AuthVerdict { dkim: 'pass' | 'fail' | null; spf: 'pass' | 'fail' | null; dmarc: 'pass' | 'fail' | null }

export function parseAuthResults(header: string | null | undefined): AuthVerdict {
  const out: AuthVerdict = { dkim: null, spf: null, dmarc: null };
  const h = String(header ?? '').toLowerCase();
  if (!h) return out;
  for (const key of ['dkim', 'spf', 'dmarc'] as const) {
    const m = new RegExp(`\\b${key}\\s*=\\s*([a-z]+)`).exec(h);
    if (!m) continue;
    if (m[1] === 'pass') out[key] = 'pass';
    else if (['fail', 'softfail', 'permerror', 'temperror', 'none'].includes(m[1])) out[key] = m[1] === 'none' ? null : 'fail';
  }
  return out;
}

// ---------- The check ----------

export interface GuardInput {
  fromEmail: string;
  fromName: string | null;
  replyToEmails: string[];
  authResults: string | null;
  threadId: string;
  accountId: number;
  /** Addresses this mailbox owns, so a message from oneself is never flagged. */
  mine: Set<string>;
}

// What the mailbox knows, gathered once per batch rather than per message.
export interface GuardKnowledge {
  /** Domain → how many messages have come from it, and one example address. */
  domains: Map<string, { count: number; example: string }>;
  /** Lowercased display name → the address that usually carries it. */
  names: Map<string, { email: string; count: number }>;
  /** Addresses seen at least once, so "first contact" is a real answer. */
  addresses: Set<string>;
}

export function checkMessage(input: GuardInput, known: GuardKnowledge, thread: { fromEmails: string[] }): GuardResult {
  const flags: GuardFlag[] = [];
  const detail: GuardDetail = {};
  const from = input.fromEmail.toLowerCase();
  if (!from || input.mine.has(from)) return { flags, detail };
  const domain = from.split('@')[1] ?? '';

  // 1. Have we met? Context rather than an accusation, but it is the thing
  //    that makes every other flag below matter.
  if (!known.addresses.has(from)) flags.push('first_contact');

  // 2. A name we know, on an address we do not. The classic: "Ana Duarte
  //    <ana.duarte.finance@gmail.com>".
  const name = String(input.fromName ?? '').trim().toLowerCase();
  if (name.length > 3 && !known.addresses.has(from)) {
    const hit = known.names.get(name);
    if (hit && hit.email !== from && hit.count >= 2) {
      flags.push('display_name_mismatch');
      detail.name = input.fromName ?? undefined;
      detail.expected = hit.email;
      detail.actual = from;
      detail.seen = hit.count;
    }
  }

  // 3. A domain pretending to be one we correspond with.
  if (domain && !known.domains.has(domain)) {
    for (const [d, info] of known.domains) {
      if (info.count < 3) continue; // one stray message is not a relationship
      if (!looksLike(domain, d)) continue;
      flags.push('lookalike_domain');
      detail.expected = d;
      detail.actual = domain;
      detail.seen = info.count;
      break;
    }
  }

  // 4. Reply-To leaving the sender's domain. Legitimate for mailing lists and
  //    ticketing systems, so it is the mildest of the flags and never shown
  //    on its own for list mail.
  for (const rt of input.replyToEmails) {
    const rd = String(rt).toLowerCase().split('@')[1] ?? '';
    if (rd && domain && registrable(rd) !== registrable(domain)) {
      flags.push('reply_to_offsite');
      detail.actual = rt.toLowerCase();
      break;
    }
  }

  // 5. The conversation changed hands. Everybody who has written in this
  //    thread so far, against whoever just did: a new domain appearing
  //    partway through an existing exchange is the shape of a hijack.
  const priorDomains = new Set(
    thread.fromEmails.map((e) => registrable(String(e).toLowerCase().split('@')[1] ?? '')).filter(Boolean),
  );
  for (const m of input.mine) priorDomains.delete(registrable(m.split('@')[1] ?? ''));
  if (priorDomains.size && domain && !priorDomains.has(registrable(domain))) {
    // Only when the new domain resembles one already in the thread, or the
    // thread had exactly one other party. Otherwise every conversation that
    // gains a participant would be an alarm.
    const resembles = [...priorDomains].find((d) => looksLike(domain, d));
    if (resembles || priorDomains.size === 1) {
      flags.push('thread_sender_changed');
      detail.expected = resembles ?? [...priorDomains][0];
      detail.actual = domain;
    }
  }

  // 6. Authentication. Only interesting when the domain normally passes:
  //    "this one message from a domain you trust did not authenticate" is a
  //    signal, whereas "a domain with no DMARC did not pass DMARC" is noise.
  const auth = parseAuthResults(input.authResults);
  if ((auth.dmarc === 'fail' || auth.dkim === 'fail') && known.domains.get(domain)?.count) {
    flags.push('unauthenticated');
  }

  flags.sort((a, b) => FLAG_SEVERITY[b] - FLAG_SEVERITY[a]);
  return { flags, detail };
}

// ---------- Running it over a mailbox ----------

// What this account already knows, from the columns that are not secret plus
// the sealed sender list, which is opened with the owner's own key. This is
// the only place the guard needs plaintext, and it needs it about senders
// rather than about bodies.
// `exclude` is the batch about to be checked. Without it the mailbox
// "knows" the very message under test — it is in the table by the time the
// check runs — so a first message from a stranger would count as a sender
// this account already knows, and every check that asks "have we seen this
// before?" would answer yes about the thing it was asked to be suspicious
// of. Excluding the batch is what makes those questions mean anything.
export async function knowledgeFor(userId: number, accountId: number, exclude: number[] = []): Promise<GuardKnowledge> {
  const dek = await dataKey(userId);
  const rows = await query<{ from_addr: string; n: number }>(
    `SELECT from_addr, count(*)::int AS n
       FROM emails
      WHERE account_id=$1 AND received_at > now() - interval '400 days'
        AND ($2::bigint[] IS NULL OR NOT (id = ANY($2::bigint[])))
      GROUP BY from_addr
      ORDER BY n DESC
      LIMIT 4000`,
    [accountId, exclude.length ? exclude : null],
  );
  const domains = new Map<string, { count: number; example: string }>();
  const names = new Map<string, { email: string; count: number }>();
  const addresses = new Set<string>();
  for (const r of rows) {
    let list: { name?: string | null; email?: string }[] = [];
    try { list = JSON.parse(openWith(dek, r.from_addr) ?? '[]'); } catch { continue; }
    const a = list[0];
    const email = String(a?.email ?? '').toLowerCase();
    if (!email) continue;
    addresses.add(email);
    const domain = email.split('@')[1] ?? '';
    if (domain) {
      const d = domains.get(domain);
      if (d) d.count += r.n; else domains.set(domain, { count: r.n, example: email });
    }
    const name = String(a?.name ?? '').trim().toLowerCase();
    if (name.length > 3) {
      const existing = names.get(name);
      if (!existing || existing.count < r.n) names.set(name, { email, count: r.n });
    }
  }
  return { domains, names, addresses };
}

// One pass over whatever has not been checked. Runs on the scheduler tick,
// bounded, and stops the moment consent is withdrawn.
export async function guardBatch(userId: number, accountId: number, limit = 200): Promise<number> {
  if (!(await allowed(userId, 'guard'))) return 0;
  const rows = await query<any>(
    `SELECT id, thread_id, from_addr, reply_to, auth_results, received_at
       FROM emails WHERE account_id=$1 AND NOT guard_checked
       ORDER BY received_at DESC LIMIT $2`,
    [accountId, limit],
  );
  if (!rows.length) return 0;

  const dek = await dataKey(userId);
  const known = await knowledgeFor(userId, accountId, rows.map((r) => r.id));
  const acc = await one<{ email: string }>('SELECT email FROM accounts WHERE id=$1', [accountId]);
  const mine = new Set([String(acc?.email ?? '').toLowerCase()].filter(Boolean));

  // Everyone who has written in each of the threads involved, before the
  // message being checked. One query for the batch.
  const threadIds = [...new Set(rows.map((r) => r.thread_id))];
  const threadRows = await query<{ thread_id: string; from_addr: string; received_at: Date }>(
    'SELECT thread_id, from_addr, received_at FROM emails WHERE account_id=$1 AND thread_id = ANY($2) ORDER BY received_at ASC',
    [accountId, threadIds],
  );
  const byThread = new Map<string, { email: string; at: number }[]>();
  for (const t of threadRows) {
    let email = '';
    try { email = String(JSON.parse(openWith(dek, t.from_addr) ?? '[]')[0]?.email ?? '').toLowerCase(); } catch { /* unreadable */ }
    if (!email) continue;
    const list = byThread.get(t.thread_id) ?? [];
    list.push({ email, at: new Date(t.received_at).getTime() });
    byThread.set(t.thread_id, list);
  }

  for (const r of rows) {
    let from: any = {}, replyTo: any[] = [];
    try { from = JSON.parse(openWith(dek, r.from_addr) ?? '[]')[0] ?? {}; } catch { /* unreadable */ }
    try { replyTo = JSON.parse(openWith(dek, r.reply_to) ?? '[]'); } catch { /* unreadable */ }
    const at = new Date(r.received_at).getTime();
    const priorInThread = (byThread.get(r.thread_id) ?? []).filter((m) => m.at < at).map((m) => m.email);
    const result = checkMessage(
      {
        fromEmail: String(from?.email ?? ''),
        fromName: from?.name ?? null,
        replyToEmails: replyTo.map((a: any) => String(a?.email ?? '')).filter(Boolean),
        // Sealed like the addresses beside it: an Authentication-Results
        // header names the sending domain and usually the envelope address.
        authResults: openWith(dek, r.auth_results),
        threadId: r.thread_id,
        accountId,
        mine,
      },
      known,
      { fromEmails: priorInThread },
    );
    await query(
      'UPDATE emails SET guard_flags=$2, guard_detail=$3, guard_checked=true WHERE id=$1',
      [r.id, result.flags, result.flags.length ? sealDetail(dek, result.detail) : null],
    );
  }
  log.info(`guard checked ${rows.length} messages`, { account: accountId });
  return rows.length;
}

function sealDetail(dek: Buffer, detail: GuardDetail): string | null {
  const json = JSON.stringify(detail);
  if (json === '{}') return null;
  // The detail names domains and people, which is exactly the sort of thing
  // the rest of the row is sealed for.
  return sealWith(dek, json);
}

// One message's flags, opened. Lives here rather than in the route so the
// raw data key stays inside the handful of files that are allowed to touch
// it — capabilities.test.ts enforces that list.
export async function guardFor(userId: number, emailId: number): Promise<{ flags: GuardFlag[]; detail: GuardDetail } | null> {
  const row = await one<{ guard_flags: string[]; guard_detail: string | null }>(
    `SELECT e.guard_flags, e.guard_detail FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE e.id=$1 AND a.user_id=$2`,
    [emailId, userId],
  );
  if (!row) return null;
  let detail: GuardDetail = {};
  if (row.guard_detail) {
    try { detail = JSON.parse(openWith(await dataKey(userId), row.guard_detail) ?? '{}'); } catch { /* unreadable */ }
  }
  return { flags: (row.guard_flags ?? []) as GuardFlag[], detail };
}

// The sentence shown above a message. Built here rather than in the browser
// so the wording is the same in a notification, a digest and the reading
// pane, and so a flag that has no safe phrasing simply produces nothing.
export function describe(flags: GuardFlag[], detail: GuardDetail): string | null {
  const top = flags[0];
  switch (top) {
    case 'thread_sender_changed':
      return `Someone new joined this conversation from ${detail.actual}${detail.expected ? `, which is not ${detail.expected}` : ''}. Check before replying.`;
    case 'lookalike_domain':
      return `${detail.actual} looks like ${detail.expected}, which you have exchanged ${detail.seen} messages with. It is not the same domain.`;
    case 'display_name_mismatch':
      return `You know ${detail.name} as ${detail.expected}. This message came from ${detail.actual}.`;
    case 'reply_to_offsite':
      return `A reply to this message would go to ${detail.actual}, not to the sender's address.`;
    case 'unauthenticated':
      return 'This message failed the checks its own domain publishes. It may not be from who it says.';
    case 'first_contact':
      return null; // shown as a quiet label, not a warning
    default:
      return null;
  }
}
