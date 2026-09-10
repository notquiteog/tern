// A contact's details, read off the bottom of mail they already sent you.
//
// ── Why this is not a model ─────────────────────────────────────────────────
//
// A sign-off block has a shape. It sits at the foot of a message, after the
// last paragraph and often after a delimiter the RFCs actually specify; its
// lines are short; it contains the sender's own name, and then a job title, a
// company, a phone number and a URL, in roughly that order, in a form people
// have been writing the same way for thirty years. Reading it is pattern
// matching, and pattern matching is what a regular expression is for.
//
// Using a model here would cost a generation per contact, produce a different
// answer on Tuesday than it did on Monday, and be wrong in the specific way
// models are wrong about this — inventing a plausible job title for somebody
// whose signature only had a phone number. So: no model, no capability that
// reaches one, and a result that is the same every time it runs.
//
// ── Why it proposes and never writes ────────────────────────────────────────
//
// Because it is guessing, and it says so. "Head of Operations" on a line of
// its own is *probably* a job title and is sometimes the name of a department
// somebody was forwarding about. Every suggestion is returned with the message
// it came from, the person accepts the ones that are right, and a contact
// record is never silently rewritten by something that read an email.
import { query } from '../db.js';
import { logger } from '../log.js';
import { openEmails } from './mailVault.js';
import { htmlToText } from './merge.js';

const log = logger('enrich');

export type EnrichField = 'title' | 'company' | 'phone' | 'website';

export interface Suggestion {
  field: EnrichField;
  value: string;
  /** What the contact record says now, so the card can show the swap. */
  current: string;
  /** Where it was read, so the person can go and check. */
  source: { emailId: number; accountId: number; threadId: string; subject: string; date: string };
}

/** How many of their messages to look at. The newest signature wins. */
const SCAN_MESSAGES = 6;

// A message body ends and a signature begins at the standard delimiter, or at
// the last plausible sign-off line. Both are tried; the delimiter is trusted
// where it appears because it is the one unambiguous marker there is.
const SIG_DELIMITER = /^-{2}\s*$/m;
const SIGNOFF_RE = /^(?:best|best wishes|thanks|thank you|many thanks|regards|kind regards|warm regards|cheers|sincerely|yours(?: sincerely| faithfully)?|all the best|talk soon|speak soon)\b[\s,.!-]*$/i;

// Lines that are never a person's details, however much they look like them.
const NOISE_RE = /(unsubscribe|confidential|privacy|disclaimer|registered (?:office|in )|company (?:no|number)|vat |sent from my |this e-?mail|do not reply|view this email|©|\ball rights reserved\b)/i;

const PHONE_RE = /(?:^|[\s:|·•])(\+?\d[\d\s().-]{7,20}\d)(?:$|[\s|·•])/;
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s|·•,]*)?)/i;
const EMAIL_IN_LINE_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// The vocabulary of a job title. Deliberately a list rather than a heuristic
// about capitalisation: "Head of Operations" and "senior engineer" are both
// titles, and "Meridian Logistics Ltd" is not, and no rule about capital
// letters separates those three.
const TITLE_WORDS = /\b(?:ceo|cto|coo|cfo|cmo|founder|co-?founder|owner|partner|principal|president|chair(?:man|woman|person)?|director|head|lead|manager|supervisor|officer|engineer|developer|designer|architect|analyst|consultant|advisor|adviser|specialist|coordinator|administrator|assistant|associate|executive|editor|writer|producer|scientist|researcher|accountant|solicitor|lawyer|attorney|surveyor|buyer|controller|strategist|marketer|recruiter|nurse|doctor|professor|teacher|technician|operative|representative|rep|vp|svp|evp)\b/i;
// The vocabulary of a company. Same reasoning — and split in two, because
// several of these words are equally at home in a job title. "Head of Design"
// and "Northwind Studio" both match the full list, so a rule that consulted it
// first would file the title as the company and then have nothing left to call
// the company. The strong half is the words that only ever name an
// organisation; the full list is the fallback when nothing else decides it.
const COMPANY_STRONG = /\b(?:ltd|limited|llc|l\.l\.c|inc|inc\.|incorporated|plc|gmbh|s\.?a\.?r\.?l|b\.?v|pty|corp|corporation|co\.|company|group|holdings|associates|studio|studios|agency|labs|laboratories|systems|solutions|technologies|ventures|collective|foundation|trust|institute|university|college|school|hospital|clinic|council|society)\b/i;
const COMPANY_WORDS = new RegExp(`${COMPANY_STRONG.source}|\\b(?:partners|services|technology|consulting|capital|media|design|works)\\b`, 'i');

/**
 * The signature block at the foot of a plain-text body, if there is one.
 *
 * Bounded at twelve lines because a legitimate sign-off is four or five and
 * anything longer is a corporate footer — the legal paragraph, the environmental
 * plea, the list of offices — which contains nothing about the person and a
 * great deal that pattern-matches as though it did.
 */
export function signatureBlock(text: string): string[] {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  // Trailing blank lines and quoted material go first: a reply carries the
  // whole conversation below it, and every signature in it but the newest
  // belongs to somebody else or to an older version of this person's job.
  const body: string[] = [];
  for (const raw of lines) {
    if (/^\s*>/.test(raw)) break;
    if (/^\s*(?:on .{0,80}wrote:|-{3,}\s*original message|from:\s)/i.test(raw)) break;
    body.push(raw);
  }

  let start = -1;
  const joined = body.join('\n');
  const delim = joined.match(SIG_DELIMITER);
  if (delim?.index !== undefined) {
    start = joined.slice(0, delim.index).split('\n').length;
  } else {
    // No delimiter, so find the last sign-off line and take what follows.
    for (let i = body.length - 1; i >= 0 && i >= body.length - 15; i--) {
      if (SIGNOFF_RE.test(body[i]!.trim())) { start = i + 1; break; }
    }
  }
  if (start < 0) return [];

  const block = body
    .slice(start, start + 14)
    .map((l) => l.replace(/^\s*[-–—*|]\s*/, '').trim())
    .filter(Boolean)
    .filter((l) => !NOISE_RE.test(l))
    // A line long enough to be a sentence is a sentence.
    .filter((l) => l.length <= 90);
  return block.slice(0, 12);
}

/**
 * What a signature block says about its author.
 *
 * The first line is skipped when it looks like the sender's own name: it is
 * the commonest first line there is, and mistaking it for a job title is the
 * commonest way a parser like this embarrasses itself.
 */
export function readSignature(block: string[], senderName?: string | null): Partial<Record<EnrichField, string>> {
  const out: Partial<Record<EnrichField, string>> = {};
  const name = String(senderName ?? '').trim().toLowerCase();
  const lines = block.filter((l, i) => !(i === 0 && name && l.toLowerCase() === name));

  for (const line of lines) {
    if (!out.phone) {
      const m = line.match(PHONE_RE);
      // Nine digits is the shortest real number worth trusting; below that it
      // is an extension, a date or a reference number.
      if (m && (m[1].match(/\d/g)?.length ?? 0) >= 9) out.phone = m[1].trim();
    }
    if (!out.website && !EMAIL_IN_LINE_RE.test(line)) {
      const m = line.match(URL_RE);
      // A bare domain that is really the tail of an address, or an image file
      // somebody's client inlined, is not a website.
      if (m && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(m[1])) out.website = m[1].replace(/[.,;]$/, '');
    }
  }

  // Title and company are taken from the short lines that are not a phone
  // number, a URL or an address — the two or three lines in the middle of a
  // signature that are prose. A line naming both ("Head of Ops, Meridian Ltd")
  // is split on its separator, which is the shape most people write.
  const prose = lines.filter((l) => !PHONE_RE.test(l) && !URL_RE.test(l) && !EMAIL_IN_LINE_RE.test(l) && l.length >= 2 && l.length <= 70);
  for (const line of prose) {
    const parts = line.split(/\s*(?:[|·•]|,\s|\sat\s|\s[-–—]\s)\s*/).map((p) => p.trim()).filter(Boolean);

    // "Head of Design | Northwind Studio" is the shape most people write, and
    // it decides itself: whichever half names a job is the job, and the other
    // half is where they do it. The title vocabulary is consulted FIRST,
    // because several company words are also perfectly good title words and
    // asking the other way round files "Head of Design" as the company.
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      const aTitle = TITLE_WORDS.test(a);
      const bTitle = TITLE_WORDS.test(b);
      if (aTitle !== bTitle) {
        const [title, company] = aTitle ? [a, b] : [b, a];
        out.title ??= title;
        out.company ??= company;
        continue;
      }
      // Both or neither read as a job. Fall back to the words that can only
      // name an organisation; if that does not separate them either, say
      // nothing rather than guessing which is which.
      const aCo = COMPANY_STRONG.test(a);
      const bCo = COMPANY_STRONG.test(b);
      if (aCo !== bCo) {
        const [company, title] = aCo ? [a, b] : [b, a];
        out.company ??= company;
        if (TITLE_WORDS.test(title)) out.title ??= title;
      }
      continue;
    }

    for (const part of parts) {
      if (!out.title && TITLE_WORDS.test(part) && !COMPANY_STRONG.test(part)) { out.title = part; continue; }
      if (!out.company && COMPANY_WORDS.test(part)) { out.company = part; continue; }
    }
  }
  return out;
}

/**
 * Everything worth suggesting for one contact.
 *
 * A field the contact record already has is never suggested, even when the
 * signature disagrees: somebody typed that value in, and quietly offering to
 * replace it with something read out of an email is not the same act as
 * offering to fill in a blank.
 */
export async function suggestFor(userId: number, contactId: number): Promise<Suggestion[]> {
  const rows = await query<any>(
    `SELECT c.email, c.title, c.company, c.phone, c.website FROM contacts c WHERE c.id=$1 AND c.user_id=$2`,
    [contactId, userId],
  );
  const c = rows[0];
  if (!c) return [];

  // Their messages, newest first, through the contact_threads join that the
  // drawer already uses — so this reads exactly the conversations the page is
  // already willing to show, and nothing wider.
  const mail = await query<any>(
    `SELECT e.id, e.account_id, e.thread_id, e.subject, e.from_addr, e.received_at, e.body_text, e.body_html
       FROM emails e
       JOIN contact_threads ct ON ct.account_id=e.account_id AND ct.thread_id=e.thread_id
       JOIN accounts a ON a.id=e.account_id
      WHERE ct.contact_id=$1 AND a.user_id=$2 AND NOT e.is_draft
      ORDER BY e.received_at DESC LIMIT 40`,
    [contactId, userId],
  );
  if (!mail.length) return [];

  const opened = await openEmails(userId, 'enrich', mail) as any[];
  const addr = String(c.email).toLowerCase();
  // Only mail they sent. A message *to* them carries the reader's own
  // signature, and filling in somebody's job title from your own sign-off is
  // the single most obvious way to get this wrong.
  const theirs = opened.filter((m) => m.from_addr?.[0]?.email?.toLowerCase() === addr).slice(0, SCAN_MESSAGES);
  if (!theirs.length) return [];

  const out: Suggestion[] = [];
  const taken = new Set<EnrichField>();
  for (const m of theirs) {
    const text = m.body_text || htmlToText(m.body_html || '');
    if (!text) continue;
    const found = readSignature(signatureBlock(text), m.from_addr?.[0]?.name);
    for (const field of ['title', 'company', 'phone', 'website'] as EnrichField[]) {
      const value = found[field];
      if (!value || taken.has(field)) continue;
      // Already filled in by hand: leave it alone.
      if (String(c[field] ?? '').trim()) continue;
      taken.add(field);
      out.push({
        field,
        value,
        current: String(c[field] ?? ''),
        source: {
          emailId: m.id,
          accountId: m.account_id,
          threadId: m.thread_id,
          subject: m.subject || '(no subject)',
          date: new Date(m.received_at).toISOString(),
        },
      });
    }
    if (taken.size === 4) break;
  }
  if (out.length) log.info('read a signature', { user: userId, contact: contactId, fields: out.length });
  return out;
}
