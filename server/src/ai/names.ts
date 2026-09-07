// Who the email is to, decided in code.
//
// The greeting is the first thing a reader sees and the cheapest thing to get
// wrong. Handed a `From` header a small model will greet the surname, the
// address, the sender, a person quoted below the fold, or a placeholder the
// template engine never filled in — and every one of those tells the reader
// at a glance that nobody was home. None of it is a writing problem, so none
// of it is solved by asking the model more nicely: a name either resolves
// from data we hold or it does not, and when it does not the honest answer is
// a greeting that names nobody.
//
// This file is the decision. `resolveRecipient` takes every candidate the
// callers can offer, in order of how much they are worth trusting, and
// returns the one name that may be used — or nothing. `guard.ts` then asserts
// afterwards that the email actually used it, because a rule that is only
// applied on the way in is a rule that a regression can quietly remove.

export type NameSource =
  // A contact row: somebody typed this in, or an import mapped it to a named
  // column. The best thing we have.
  | 'contact'
  // The display name on the message we are answering.
  | 'display'
  // A name typed into the composer for a one-off recipient.
  | 'manual'
  // A sign-off read out of the body of their own message.
  | 'signature';

export interface NameCandidate { value?: string | null; source: NameSource }

export interface RecipientFacts {
  /** Where the mail is going. Used to reject role addresses and the sender. */
  email?: string | null;
  /** Who is writing. A greeting in the sender's own name is a failure, not a name. */
  senderName?: string | null;
  senderEmail?: string | null;
  /** The recipient's company, so "Northwind Supply" in the name column is refused. */
  company?: string | null;
  /**
   * People who appear in the conversation but are not the recipient. Nothing
   * here may ever become the greeting, whoever suggested it.
   */
  others?: (string | null | undefined)[];
}

export interface ResolvedName {
  /** The name as a person would write it, or '' when none resolved. */
  full: string;
  /** The word to greet them by, or '' — which callers turn into "Hi there,". */
  first: string;
  /** Which candidate won, for a log or an eval report. */
  source: NameSource | 'none';
  /** Why nothing resolved, when nothing did. */
  why: string;
}

// ---------- what is not a name ----------

// A template that was never rendered, or a fallback nobody replaced. These
// arrive in the name column of a CSV more often than anyone would like.
const PLACEHOLDER_RE = /\{\{|\}\}|\{%|\$\{|^\[.*\]$|^<.*>$|^__.*__$|^%[a-z_]+%$/i;
// Words that are a greeting's fallback rather than somebody's name.
const NOT_A_NAME = new Set([
  '', '-', '--', '.', 'n/a', 'na', 'none', 'null', 'nil', 'undefined', 'unknown', 'blank', 'empty', 'tbd', 'tba', 'todo', 'test',
  'there', 'all', 'team', 'everyone', 'everybody', 'folks', 'friend', 'friends', 'colleagues', 'colleague', 'both',
  'sir', 'madam', 'sir or madam', 'madame', 'mister', 'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof',
  'customer', 'client', 'subscriber', 'member', 'user', 'admin', 'administrator', 'owner', 'contact', 'recipient', 'sender',
  'first name', 'firstname', 'first_name', 'last name', 'lastname', 'full name', 'fullname', 'name', 'your name', 'company',
  'info', 'hello', 'hi', 'hey', 'accounts', 'sales', 'support', 'enquiries', 'inquiries', 'billing', 'finance', 'office',
  'noreply', 'no reply', 'no-reply', 'do not reply', 'donotreply', 'mailer daemon', 'postmaster', 'webmaster',
]);
// Local parts that are a function rather than a person. A greeting is never
// derived from one, and a display name that only repeats one is refused.
const ROLE_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|donotreply|noreply|reply|bounce|mailer-?daemon|postmaster|webmaster|abuse|hostmaster|root|admin|administrator|info|hello|hi|contact|contacts|enquir\w*|inquir\w*|sales|support|help|helpdesk|service|services|accounts?|accounting|ar|ap|billing|invoices?|finance|payroll|hr|jobs|careers|recruit\w*|marketing|press|media|team|office|mail|email|orders?|shop|store|newsletter|news|notifications?|notify|alerts?|updates?|security|privacy|legal|compliance|dpo|feedback|survey|events?|training|partners?|resellers?|affiliates?|api|dev|devops|it|sysadmin|ops|operations)(?:[._-]?\d*)?$/i;

const HONORIFIC_RE = /^(?:mr|mrs|ms|miss|mx|dr|doctor|prof|professor|sir|dame|rev|reverend|fr|father|capt|captain|sgt|sergeant|lt|col|gen|hon|eng|ing)\.?\s+/i;
const CREDENTIALS_RE = /[,(]\s*(?:ph\.?d|d\.?phil|m\.?d|dds|dvm|mba|cpa|aca|acca|acma|cima|cfa|frm|esq|jr|sr|ii|iii|iv|v|bsc|msc|beng|meng|ma|ba|llb|llm|rn|pe|pmp|cissp|mcse|aws)\b[^,]*$/i;
// Emoji, pictographs, dingbats, variation selectors and zero-width joiners.
// A display name is allowed to contain them; a greeting is not.
const DECOR_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E000}-\u{F8FF}]/gu;
// Latin, Greek and Cyrillic scripts have a first name to pick out. Han,
// Hiragana, Katakana, Hangul and Thai names are written as one unit and are
// greeted whole; splitting them on a space that is not there, or taking a
// family name for a given one, is worse than using the lot.
const UNSPLIT_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

function stripDecoration(s: string): string {
  return s.replace(DECOR_RE, ' ').replace(/\s+/g, ' ').trim();
}

// The name a greeting can use, tidied the way a person would write it, or ''
// when what came in was not a name at all.
//
// Kept as its own export because `prompts.ts` and `guard.ts` both need the
// same answer, and because everything it refuses is a case that was seen
// arriving from a real mailbox rather than imagined.
export function cleanRecipientName(raw?: string | null): string {
  let n = String(raw ?? '').trim();
  // Quotes a header or an export put round the whole thing.
  n = n.replace(/^["'“‘«]+|["'”’»]+$/g, '').trim();
  if (!n) return '';
  if (n.length > 80) return '';
  if (PLACEHOLDER_RE.test(n)) return '';
  // A display name that is really an address tells a greeting nothing, and
  // the local part is a login rather than a name: "hey dana.osei0," is the
  // failure this refuses, not a fallback it should reach for.
  if (/@/.test(n)) return '';
  if (/https?:\/\/|www\./i.test(n)) return '';
  n = stripDecoration(n);
  // "Dana Osei | Northwind Supply", "Dana Osei - Finance", "Dana Osei (Northwind)"
  n = n.split(/\s*[|/–—]\s*|\s+-\s+|\s*·\s*|\s*,\s*(?=(?:head|director|manager|owner|founder|ceo|cfo|cto|coo|vp|partner)\b)/i)[0];
  n = n.replace(/\s*\([^)]*\)\s*$/, '').trim();
  n = n.replace(CREDENTIALS_RE, '').trim();
  n = n.replace(HONORIFIC_RE, '').trim();
  // "Osei, Dana" and "SMITH, JOHN": the surname-first form every directory
  // export uses. Only two parts, or it is a list of people.
  const comma = n.match(/^([^,]+),\s*([^,]+)$/);
  if (comma) n = `${comma[2].trim()} ${comma[1].trim()}`;
  n = n.replace(/[,;:.]+$/, '').trim();
  // Digits belong to a login, an employee number or a spreadsheet artefact.
  if (/\d/.test(n)) return '';
  if (!/\p{L}/u.test(n)) return '';
  // More than four words is a sentence, a company or two people.
  if (n.split(/\s+/).length > 4) return '';
  if (NOT_A_NAME.has(n.toLowerCase())) return '';
  // SHOUTING or all lower case: written the way a person would write it.
  // Scripts without case are unaffected, which is the point of the guard.
  if (n === n.toUpperCase() || n === n.toLowerCase()) {
    n = n.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());
  }
  return n;
}

// The word to greet them by. Empty when there is nothing usable, which the
// callers turn into "Hi there," rather than a guess.
export function firstNameOf(raw?: string | null): string {
  const full = cleanRecipientName(raw);
  if (!full) return '';
  // A name written as one unit is greeted as one unit.
  if (UNSPLIT_SCRIPT_RE.test(full)) return full;
  const first = full.split(/\s+/)[0] ?? '';
  // A single initial ("J Smith") is not something to greet somebody by.
  if (/^\p{L}\.?$/u.test(first)) {
    const rest = full.split(/\s+/).slice(1).join(' ');
    return rest && !/^\p{L}\.?$/u.test(rest) ? rest.split(/\s+/)[0] : '';
  }
  return /\p{L}/u.test(first) ? first : '';
}

const norm = (s?: string | null) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const localPart = (email?: string | null) => String(email ?? '').split('@')[0] ?? '';

// Is this address a function rather than a person? A greeting is never
// derived for one, but a real display name on it is still used: "Dana Osei
// <accounts@northwind.example>" is Dana writing from the shared box.
export function isRoleAddress(email?: string | null): boolean {
  const l = localPart(email).toLowerCase();
  return Boolean(l) && ROLE_LOCAL_RE.test(l);
}

// Two names that are the same person, allowing for one of them being just
// the first name. Used to refuse the sender's own name and to spot a third
// party being greeted.
function sameName(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '), ys = y.split(' ');
  // "Alex" against "Alex Rivera": the same person as far as a greeting goes.
  if (xs.length === 1 || ys.length === 1) return xs[0] === ys[0];
  // "Alex Rivera" against "A. Rivera".
  return xs[xs.length - 1] === ys[ys.length - 1] && xs[0][0] === ys[0][0];
}

// The one name this email may use, out of everything the callers know.
//
// Candidates are tried in the order given, which is the order they deserve
// to be trusted in, and every one of them has to survive the same set of
// refusals. Nothing is invented and nothing is derived from an address.
export function resolveRecipient(candidates: NameCandidate[], facts: RecipientFacts = {}): ResolvedName {
  const senderNames = [facts.senderName, localPart(facts.senderEmail)].filter(Boolean) as string[];
  const others = (facts.others ?? []).map((o) => cleanRecipientName(o)).filter(Boolean);
  const company = norm(facts.company);
  let why = 'no name was given';
  for (const c of candidates) {
    const raw = String(c.value ?? '').trim();
    if (!raw) continue;
    const full = cleanRecipientName(raw);
    if (!full) { why = `"${raw.slice(0, 40)}" is not a usable name`; continue; }
    // The sender's own name. A model handed a thread greets the person it is
    // writing as about as often as the person it is writing to.
    if (senderNames.some((s) => sameName(full, s))) { why = `"${full}" is the sender's own name`; continue; }
    // The company in the name column, which is what a one-column CSV export
    // of "Account name" produces.
    if (company && norm(full) === company) { why = `"${full}" is the company, not a person`; continue; }
    // Somebody else on the thread. This is the trap a long conversation sets:
    // a name that is mentioned repeatedly, quoted below the fold, and never
    // once the person being written to.
    const other = others.find((o) => sameName(full, o));
    if (other) { why = `"${full}" is another person on the thread, not the recipient`; continue; }
    // A display name that only restates a role address is the mailbox's
    // label rather than anybody's name.
    if (facts.email && isRoleAddress(facts.email) && sameName(full, localPart(facts.email))) {
      why = `"${full}" is the name of a shared mailbox`;
      continue;
    }
    const first = firstNameOf(full);
    if (!first) { why = `"${full}" has no first name to greet by`; continue; }
    return { full, first, source: c.source, why: '' };
  }
  return { full: '', first: '', source: 'none', why };
}

// The candidate list a contact row offers, in trust order. One place, so the
// composer, the campaigns and the responders all agree about what a contact's
// name is.
export function candidatesFromContact(c: { first_name?: string | null; last_name?: string | null; name?: string | null } | null | undefined): NameCandidate[] {
  if (!c) return [];
  const joined = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return [
    { value: joined, source: 'contact' },
    { value: c.name, source: 'contact' },
    // A last-name-only row still greets nobody, but a first-name-only one is
    // perfectly good.
    { value: c.first_name, source: 'contact' },
  ];
}

// A sign-off in the body of their own message: "Thanks, Dana" or a signature
// block whose first line is a name. Read only from the message we are
// answering, and only used when nothing better exists.
//
// Deliberately conservative: a name in a signature block sits on its own
// line, above a title or an address, or after a valediction at the end.
const VALEDICTION_LINE = /^(?:best(?:\s+(?:regards|wishes))?|regards|kind regards|warm(?:ly|est)?(?:\s+regards)?|thanks(?:\s+again)?|many thanks|thank you|cheers|sincerely|yours(?:\s+\w+)?|all the best|speak soon|talk soon)[,.!]?$/i;
const NAME_LINE = /^[\p{Lu}\p{Lo}][\p{L}'’.-]*(?:\s+[\p{Lu}\p{Lo}][\p{L}'’.-]*){0,3}$/u;

export function signatureNameOf(body?: string | null): string {
  const lines = String(body ?? '')
    .split('\n')
    .map((l) => l.trim())
    // Their quoted text is somebody else's sign-off, not theirs.
    .filter((l) => !l.startsWith('>'));
  // Search the last 12 non-empty lines: a signature block lives at the end.
  const tail = lines.filter(Boolean).slice(-12);
  for (let i = 0; i < tail.length; i++) {
    if (!VALEDICTION_LINE.test(tail[i])) continue;
    // "Best regards," then the name on the next line.
    const next = tail[i + 1];
    if (next && NAME_LINE.test(next)) {
      const n = cleanRecipientName(next);
      if (n) return n;
    }
  }
  // "Thanks, Dana" on one line.
  for (const l of [...tail].reverse()) {
    const m = l.match(/^(?:best(?:\s+regards)?|regards|kind regards|thanks(?:\s+again)?|many thanks|thank you|cheers|sincerely|all the best)[,]\s+([\p{Lu}\p{Lo}][\p{L}'’.-]*(?:\s+[\p{Lu}\p{Lo}][\p{L}'’.-]*){0,3})[.!]?$/u);
    if (m) {
      const n = cleanRecipientName(m[1]);
      if (n) return n;
    }
  }
  return '';
}
