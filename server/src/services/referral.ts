// The person a "wrong person" reply points at, read out of the reply itself.
//
// ── Why this is not a model ─────────────────────────────────────────────────
//
// `wrong_person` is the one campaign reply whose next action is obvious and
// mechanical: somebody has said "not me, ask Priya" and named an address. The
// work is finding the name and the address in a sentence, which is the same
// pattern matching `enrich.ts` already does on signature blocks, and the same
// argument applies — a regular expression gives the same answer every time,
// costs nothing, and cannot invent a colleague who was never mentioned.
//
// ── Why it insists on a cue ─────────────────────────────────────────────────
//
// Every reply carries addresses that are not referrals. The sender's own
// address is in their signature, their company's `sales@` is under it, and a
// footer can carry three more. Picking up every address in the message would
// mean offering to add a mailing list as a contact, so an address only counts
// when the sentence it sits in actually hands somebody over — "try", "speak
// to", "now looks after this" — or when it is written next to a name, which
// is the other form a handover takes. False positives are the expensive
// mistake here: this ends in a card somebody is asked to trust.
//
// ── Why it proposes and never writes ────────────────────────────────────────
//
// Same rule as enrichment. The reply is a guess about what somebody meant,
// the card shows the sentence it was read from so the guess can be checked,
// and a contact is created only when a person says so. Enrolling a colleague
// who was named once in a decline, without anybody looking, is precisely the
// behaviour that gets a sending domain blocked.
import { ownWords } from './replyIntent.js';

export interface Referral {
  /** The address they named. Empty when the sentence gave a name and no address. */
  email: string;
  /** The name as it was written. Empty when the sentence gave an address and no name. */
  name: string;
  first_name: string;
  last_name: string;
  /** The sentence it was read from, so the card can show its working. */
  quote: string;
}

// The verbs and phrases people actually use to hand somebody over. A sentence
// with one of these and an address in it is a referral; a sentence with an
// address and none of them is a signature.
const CUE_RE = /\b(?:try|tr(?:y|ies)\s+\w+|contact|email|e-mail|speak (?:to|with)|talk (?:to|with)|reach out to|ask|forward (?:this |it )?(?:to|on)|copy(?: in)?|cc'?d?|loop in|redirect|pass (?:this |it )?(?:to|on)|best person|right person|handles?|handling|looks? after|looking after|deals? with|took over|taken over|replaced me|in charge of|responsible for|my colleague|colleague|successor|instead)\b/i;

// The other form a handover takes: no verb, just the name and the address
// written together. `Priya Raman <priya@x.example>` is unambiguous enough on
// its own that requiring a cue as well would lose the clearest case there is.
const NAME_THEN_ADDR = /([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s*[<(]\s*([^\s<>()]+@[^\s<>()]+\.[^\s<>()]+?)\s*[>)]/gu;
// And its mirror: `priya@x.example (Priya Raman)`.
const ADDR_THEN_NAME = /([^\s<>()]+@[^\s<>()]+\.[^\s<>()]+?)\s*\(\s*([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s*\)/gu;

const ADDR_RE = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[A-Za-z]{2,}/g;

// A name sitting directly after a handover verb: "try Priya", "speak to Sam
// Okafor", "ask Dr Eze". Stops at the punctuation that ends the phrase so
// "try Priya, priya@..." does not read the address as part of the name.
const NAME_AFTER_CUE = /\b(?:try|contact|email|e-mail|speak to|speak with|talk to|talk with|reach out to|ask|forward (?:this |it )?to|pass (?:this |it )?to|loop in|copy in|cc)\s+((?:[A-Z][\p{L}'’-]+|Dr|Mr|Mrs|Ms|Prof)(?:\.?\s+[A-Z][\p{L}'’-]+){0,2})(?=[\s,.;:!?]|$)/u;

// The mirror word order: the name first, the handover verb after it. "Priya
// Raman, she handles renewals now" is as common a way of pointing at somebody
// as "try Priya", and the optional pronoun is what makes it read naturally.
const NAME_BEFORE_CUE = /\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s*(?:,\s*)?(?:(?:s?he|they)\s+)?(?:handles?|is handling|looks? after|is looking after|deals? with|took over|has taken over|owns|is (?:the )?(?:right|best) person|is responsible for|is in charge of)\b/u;

// Words that start with a capital because they start a sentence, not because
// they are somebody's name. Without this, "Try sending it to..." reads
// "Sending" as a first name.
const NOT_A_NAME = /^(?:the|a|an|our|my|his|her|their|this|that|these|those|someone|somebody|anyone|it|us|them|him|her|me|you|sending|asking|emailing|contacting|team|support|sales|info|accounts|reception|head|office|company)$/i;

// Addresses that are a department rather than a person. They are still worth
// offering — "ask accounts@" is a real answer to a wrong-person reply — but
// they never carry a personal name, so no name is guessed for them.
const ROLE_LOCAL = /^(?:info|sales|support|help|contact|admin|office|accounts?|billing|hello|enquiries|inquiries|team|hr|careers|jobs|press|marketing|noreply|no-reply|donotreply|postmaster|mailer-daemon|bounce|notifications?)$/i;

// A capitalised run can start one word too early: "Try Priya Raman" is three
// capitalised words in a row and only two of them are a name. Leading words
// that are a verb or a pronoun are dropped rather than the whole match being
// rejected, because the rest of it is still the name.
const LEADING_JUNK = /^(?:try|tries|contact|email|e-mail|ask|cc|copy|forward|pass|loop|speak|talk|reach|redirect|instead|please|thanks|thank|hi|hello|regards|dear)$/i;

function cleanName(raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  while (words.length && (LEADING_JUNK.test(words[0]!) || NOT_A_NAME.test(words[0]!))) words.shift();
  return words.slice(0, 3).join(' ');
}

function splitName(name: string): { first_name: string; last_name: string } {
  // Titles are not first names. "Dr Eze" is a surname with an honorific, and
  // putting "Dr" in the first-name column would greet them as "Hi Dr".
  const parts = name.replace(/^(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+/i, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: '', last_name: '' };
  return { first_name: parts[0]!, last_name: parts.slice(1).join(' ') };
}

// Sentence-ish. Splitting on line breaks as well as full stops matters
// because signatures and handovers are both written as bare lines.
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ReferralOptions {
  /**
   * Addresses that are never a referral however they are written: the
   * replier's own, and every address this install sends from. Without the
   * second, a reply quoting our own footer offers to add us to our own
   * address book.
   */
  exclude?: (string | null | undefined)[];
}

/**
 * Every handover a reply makes, most explicit first.
 *
 * Returns an empty list far more often than not, which is the intended
 * behaviour: a decline that names nobody has nothing to offer, and inventing
 * a suggestion for it would be worse than staying quiet.
 */
export function parseReferral(text: string | null | undefined, opts: ReferralOptions = {}): Referral[] {
  // Only their own words. Below a quote marker is our own message coming
  // back, and every address in it is one we already have.
  const body = ownWords(text, 20);
  if (!body) return [];
  const blocked = new Set(
    (opts.exclude ?? []).filter(Boolean).map((e) => String(e).toLowerCase()),
  );
  const found = new Map<string, Referral>();
  const seenNames = new Set<string>();

  const add = (email: string, name: string, quote: string) => {
    const addr = email.toLowerCase().replace(/[.,;:]+$/, '');
    if (addr && blocked.has(addr)) return;
    // The clearest reading of an address wins: a later sentence that mentions
    // it again without a name must not overwrite the one that named them.
    const key = addr || `name:${name.toLowerCase()}`;
    const prev = found.get(key);
    if (prev && (prev.name || !name)) return;
    const clean = ROLE_LOCAL.test(addr.split('@')[0] ?? '') ? '' : cleanName(name);
    found.set(key, { email: addr, name: clean, ...splitName(clean), quote: quote.slice(0, 300) });
    if (clean) seenNames.add(clean.toLowerCase());
  };

  for (const s of sentences(body)) {
    // A name written against its address needs no cue; it is the handover.
    for (const m of s.matchAll(NAME_THEN_ADDR)) add(m[2]!, m[1]!.trim(), s);
    for (const m of s.matchAll(ADDR_THEN_NAME)) add(m[1]!, m[2]!.trim(), s);

    const cued = CUE_RE.test(s);
    if (!cued) continue;

    // After the verb first, because "try Priya" is the least ambiguous form
    // there is; the mirror order only gets a look when that finds nothing.
    const cuedName = cleanName(s.match(NAME_AFTER_CUE)?.[1] ?? '') || cleanName(s.match(NAME_BEFORE_CUE)?.[1] ?? '');
    const addrs = [...(s.match(ADDR_RE) ?? [])].filter((a) => !blocked.has(a.toLowerCase()));
    if (addrs.length) {
      // One address in a handover sentence belongs to the person the sentence
      // names. Several, and there is no way to say which name goes with
      // which, so the addresses stand on their own.
      for (const a of addrs) add(a, addrs.length === 1 ? cuedName : '', s);
      continue;
    }
    // Named, but no address given. Still worth a card — "they said to try
    // Priya and did not say how" is a question a person can answer in
    // seconds, and is otherwise lost in the pile.
    if (cuedName) add('', cuedName, s);
  }

  // A name-only referral that a later sentence gave an address for is the
  // same person twice.
  return [...found.values()]
    .filter((r) => r.email || !seenNamesHasAddressed(r, found))
    .sort((a, b) => Number(Boolean(b.email && b.name)) - Number(Boolean(a.email && a.name)))
    .slice(0, 5);
}

function seenNamesHasAddressed(r: Referral, found: Map<string, Referral>): boolean {
  if (!r.name) return false;
  for (const other of found.values()) {
    if (other !== r && other.email && other.name.toLowerCase() === r.name.toLowerCase()) return true;
  }
  return false;
}
