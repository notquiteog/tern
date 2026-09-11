// The last line of defence before automated mail leaves: nothing a model or
// a template engine left behind may reach a real inbox. Unrendered merge
// fields, bracketed placeholders, echoed prompt scaffolding and "as an AI"
// disclaimers are all things a person would catch at a glance and a
// responder in send mode never would. Anything flagged here is diverted to
// the review queue instead of being sent.
import { htmlToText } from '../services/merge.js';
import { firstNameOf } from './names.js';

export interface GuardHit {
  kind: 'merge_field' | 'placeholder' | 'prompt_leak' | 'ai_disclosure' | 'filler' | 'no_body'
    // The salutation names somebody who is not the recipient, or names
    // somebody when no name was known. See `findGreetingProblems`.
    | 'wrong_name'
    // A figure, a date or a duration the message was never given. See
    // `findInventedSpecifics`.
    | 'invented_figure' | 'invented_date' | 'invented_term'
    // "as attached" on a message with nothing attached.
    | 'false_attachment'
    // Not prose: markup, a script the conversation never used, a sentence
    // that runs on for a paragraph, a phrase on a loop, or an ending cut off
    // mid-word. See `findGarbledText`.
    | 'garbled';
  sample: string;
}

// A generation that came back as nothing, or as nothing but the greeting the
// salutation pass writes when the model produces an empty draft. It carries
// no placeholder for the other checks to catch, so on its own it would sail
// through and land in somebody's inbox as "Hi Dana,".
const GREETING_ONLY_RE = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^\n]{0,40}$/i;
const SIGNOFF_RE = /^(?:best|thanks|thank you|many thanks|regards|kind regards|warm regards|cheers|sincerely|yours|all the best|talk soon|speak soon)\b[^\n]{0,16}$/i;
// A sign-off name: one to three capitalised words on a line of their own.
const NAME_LINE_RE = /^[-\u2013\u2014]?\s*\p{Lu}[\p{L}'\u2019.-]*(?:\s+\p{Lu}[\p{L}'\u2019.-]*){0,2}[,.]?$/u;

function bodyIsEmpty(body: string): boolean {
  const lines = body.replace(/\u00a0/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  const start = GREETING_ONLY_RE.test(lines[0]) ? 1 : 0;
  let end = lines.length;
  while (end > start) {
    const last = lines[end - 1];
    // A closing word is never the message. A bare name only counts as a
    // sign-off when there is something above it, so a one-line reply
    // ("Ok.", "Tuesday.") is left alone.
    if (SIGNOFF_RE.test(last) || (end - 1 > start && NAME_LINE_RE.test(last))) { end--; continue; }
    break;
  }
  return end <= start;
}

// {{first_name}}, {{ company | there }}, {% if %}, ${name}, {first_name}: a
// template that was never rendered, or was rendered by the wrong engine.
const MERGE_RE = /\{\{[^}\n]{0,80}\}\}|\{%[^%\n]{0,80}%\}|\$\{[a-zA-Z_][^}\n]{0,60}\}|\{(?:first|last|full)?_?name\}|\{company\}|\{email\}|\{title\}/g;
// {Hi|Hello|Hey}: spin syntax that was not resolved.
const SPIN_RE = /\{[^{}\n|]{1,40}(?:\|[^{}\n|]{0,40}){1,8}\}/g;
// [Your Name], [Company], [insert date], <Name>, <insert product>, __NAME__, [X]
const PLACEHOLDER_WORDS = 'your|name|first|last|company|insert|recipient|sender|date|time|day|link|url|product|service|title|role|job|email|address|phone|city|country|placeholder|details?|topic|subject|number|amount|price|offer|x{1,3}|tbd|todo|fill|here';
const BRACKET_RE = new RegExp(`\\[\\s*(?:${PLACEHOLDER_WORDS})(?:[\\s'’-][^\\]\\n]{0,40})?\\s*\\]|<\\s*(?:${PLACEHOLDER_WORDS})(?:[\\s'’-][^>\\n]{0,40})?\\s*>|__[A-Z][A-Z_]{1,30}__`, 'gi');
// Lines the prompt builder writes; if they show up in the output the model
// echoed its instructions instead of answering them.
const PROMPT_RE = /^(?:\s*(?:recipient facts|conversation so far|sender'?s voice|subject of this email|brief \/ template|extra direction|what the reply should do|write to |you are writing as|tone:|keep it to|goal:|direction:|draft:|email:|system prompt|user prompt|instruction(?:s)?:)|\s*-{3,}\s*from\b)/im;
// The same leak, but mid-sentence rather than at the start of a line.
//
// The line-anchored pattern above catches a model that echoes its prompt as a
// block. It does not catch one that argues with the prompt inside the email —
// which is what a reasoning-capable model does when the instructions look
// contradictory to it, and it produced this, in a campaign preview the guard
// then called ready to send:
//
//   "Hi Dana," should not precede the text as per strict instruction about no
//   other name usage but the prompt requires it exactly. Wait, re-reading
//   rule: ... Okay. So start directly with Hi Dana,. Proceeding.
//
// Every phrase here is one that belongs to writing *about* the task rather
// than doing it. They are matched anywhere, because that is where they turn up.
const REASONING_RE = new RegExp(
  [
    // Talking about the instructions.
    '\\b(?:as per (?:the )?(?:strict )?instructions?|per the (?:strict )?instructions?|the (?:prompt|instruction|rule|brief) (?:requires|says|states|asks|wants)|re-?reading (?:the )?(?:rule|prompt|instruction)|the user (?:wrote|said|asked)|user wrote:|as instructed above)\\b',
    // Thinking out loud.
    '\\b(?:wait,? (?:re-?read|let me|no|actually)|let me (?:check|re-?read|reconsider|think)|hold on,? (?:let me|that)|on second thought|okay[,.]? so\\b|alright[,.]? so\\b|hmm[,.]|i should (?:probably )?(?:start|write|use|avoid|make sure)|proceeding\\.|conflict resolved|that\\u2019?s fine[,.]? conflict)\\b',
    // Naming the machinery.
    '\\b(?:word limit|character limit|token limit|the system prompt|sender voice preference|voice preference:|output format|per the format)\\b',
    // Planning the email instead of writing it: what a small model that
    // thinks in its answer produces when it has been told not to think. Each
    // phrase is from a measured draft (qwen3:4b with `think: false`), where
    // the plan was all there was.
    "\\b(?:we (?:are|need to) writ(?:e|ing) a (?:reply|response|email) to (?:the|her|his|their|\\w+'s) (?:latest|last) message|let'?s draft\\b|let me count\\b|the user says\\b|okay,? let'?s see\\b)",
  ].join('|'),
  'i',
);
const AI_RE = /\b(?:as an ai(?: language model| assistant)?|i am an ai\b|i'?m an ai\b|as a language model|i(?:'m| am) (?:just )?(?:a|an) (?:ai|artificial intelligence|language model|virtual assistant|chatbot)|this (?:message|email|reply) was (?:generated|written) by (?:an )?ai\b|\[assistant\]|\[end of (?:email|reply|message)\])/i;
const FILLER_RE = /\blorem ipsum\b|\bplaceholder text\b|\bsample text\b/i;

// Quoted replies carry the other side's text, which is theirs to have
// written however they like; only what we are about to say is inspected.
function withoutQuotes(text: string, html?: string | null): string {
  let t = text;
  if (html) {
    const cut = html.search(/<(?:div|blockquote)[^>]*class="[^"]*tern-quote/i);
    if (cut >= 0) t = htmlToText(html.slice(0, cut));
  }
  return t.split('\n').filter((l) => !l.trim().startsWith('>')).join('\n');
}

// ---------- Who the email is addressed to ----------
//
// ai/names.ts decides which name may be used; this asserts that the finished
// email actually used it. The two halves are deliberately separate: a rule
// applied only on the way in is a rule a regression can quietly remove, and
// the salutation is the one mistake every recipient notices.
//
// What is checked is the salutation and any later line that opens as one. A
// name in the middle of a sentence is just writing — "as Tomasz mentioned" is
// fine in a mail to Dana — so only vocative use is inspected.

export interface GreetingExpectation {
  /** The first name the salutation must use, or '' when none resolved. */
  first: string;
  /**
   * Names that must never be greeted: the sender, and everybody else on the
   * thread. In a long conversation this is the trap — a name mentioned
   * repeatedly and quoted below the fold, which was never the recipient.
   */
  forbidden?: (string | null | undefined)[];
}

// As in prompts.ts: the punctuation that ends a salutation is not only ASCII.
// With a fullwidth comma unmatched, the capture below took forty characters
// of the sentence after the name and then reported the recipient's own email
// as addressed to the wrong person.
const SALUTATION_RE = /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening|day))\b[\s,\uFF0C]*([^\n,\uFF0C\u3001;\uFF1B:\uFF1A!\uFF01?\uFF1F.]{0,40})/i;
// Greetings that name nobody. Any of these is a correct answer when no name
// resolved, and none of them counts as a name when one did.
const NEUTRAL_WORDS = new Set(['', 'there', 'all', 'team', 'everyone', 'everybody', 'both', 'folks', 'friend', 'friends', 'colleagues', 'sir', 'madam', 'sir or madam', 'to whom it may concern']);

export function findGreetingProblems(body: string, expect: GreetingExpectation): GuardHit[] {
  const hits: GuardHit[] = [];
  const want = firstNameOf(expect.first) || expect.first.trim();
  const forbidden = (expect.forbidden ?? []).map((f) => firstNameOf(f)).filter(Boolean);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return hits;

  const named = (line: string): string | null => {
    const m = line.match(SALUTATION_RE);
    if (!m) return null;
    const who = m[1].trim().replace(/[,:!?.\uFF0C\u3001\uFF1A\uFF01\uFF1F]+$/, '');
    return NEUTRAL_WORDS.has(who.toLowerCase()) ? '' : who;
  };

  // The salutation itself.
  const first = named(lines[0]);
  if (first !== null) {
    const who = firstNameOf(first) || first;
    if (want) {
      if (who && who.toLowerCase() !== want.toLowerCase() && !who.toLowerCase().startsWith(want.toLowerCase())) {
        hits.push({ kind: 'wrong_name', sample: `greeting says "${lines[0].slice(0, 40)}", expected ${want}` });
      }
    } else if (who) {
      // Nothing resolved, so any name here was invented rather than looked up.
      hits.push({ kind: 'wrong_name', sample: `greeting invents a name: "${lines[0].slice(0, 40)}"` });
    }
  }
  // A second salutation further down, which is how a model that lost its place
  // starts writing to somebody else halfway through.
  for (const line of lines.slice(1)) {
    const who = named(line);
    if (!who) continue;
    const w = (firstNameOf(who) || who).toLowerCase();
    if (want && w === want.toLowerCase()) continue;
    hits.push({ kind: 'wrong_name', sample: `a second greeting: "${line.slice(0, 40)}"` });
    break;
  }
  // Anyone else on the thread, greeted anywhere.
  for (const f of forbidden) {
    if (want && f.toLowerCase() === want.toLowerCase()) continue;
    // "(?!\p{L})" rather than "\b": the ASCII word boundary never fires after
    // a Cyrillic or CJK character, so a name in one of those scripts would
    // never have matched here at all.
    const re = new RegExp(`^\\s*(?:hi|hello|hey|dear)[\\s,]*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'imu');
    if (re.test(body)) hits.push({ kind: 'wrong_name', sample: `greets ${f}, who is not the recipient` });
  }
  return hits;
}

// ---------- Facts the message was never given ----------
//
// A small model asked to write from a brief will fill a gap with something
// plausible rather than leave it: a price the brief never named, a day for a
// call nobody proposed, "as attached" on a message with nothing attached, or
// a "rolling three-year term" where the conversation said three months. None
// of that is caught by looking for placeholders — an invented price is worse
// than a leftover [price], because the placeholder gets held for review and
// the price gets sent.
//
// So for automated mail, where the set of facts is closed and known — the
// brief and the contact's own fields for a campaign, the conversation for a
// responder — every figure, date, time and contractual term in the body has
// to appear in those facts. This is only sound because the world is closed;
// it is never applied to mail a person wrote.

const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE_WORDS: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000 };

// "four thousand eight hundred" -> 4800. Used so that a model paraphrasing a
// figure correctly is not accused of inventing it.
function wordsToNumber(phrase: string): number | null {
  const words = phrase.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== 'and');
  // The spoken price. "nine fifty" is £950 and "three thirty" is £330 —
  // formally ungrammatical, universally understood, and read by a naive
  // left-to-right parser as 59 and 33. Accusing the model of inventing a
  // figure it had just repeated correctly is the wrong way to be wrong.
  if (words.length === 2 && NUM_WORDS[words[0]] >= 1 && NUM_WORDS[words[0]] <= 9 && NUM_WORDS[words[1]] >= 10 && NUM_WORDS[words[1]] % 10 === 0) {
    return NUM_WORDS[words[0]] * 100 + NUM_WORDS[words[1]];
  }
  let total = 0, current = 0, seen = false;
  for (const w of words) {
    if (w in NUM_WORDS) { current += NUM_WORDS[w]; seen = true; continue; }
    if (w in SCALE_WORDS) {
      const scale = SCALE_WORDS[w];
      if (scale === 100) current = (current || 1) * 100;
      else { total += (current || 1) * scale; current = 0; }
      seen = true;
      continue;
    }
    return null;
  }
  return seen ? total + current : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*';
const CURRENCY_WORD = '(?:pounds?|gbp|sterling|dollars?|usd|euros?|eur|pence|cents?)';
const NUM_WORD_RE = `(?:${[...Object.keys(NUM_WORDS), ...Object.keys(SCALE_WORDS), 'and'].join('|')})`;
const UNIT_RE = '(?:second|minute|hour|day|week|fortnight|month|quarter|year)';

export type SpecificKind = 'figure' | 'date' | 'term';
export interface Specific { kind: SpecificKind; token: string; sample: string }

// Every figure, date and contractual term in a piece of text, normalised so
// that the same fact written two ways compares equal: "£4,800" and "four
// thousand eight hundred pounds" both become "money:4800", "10am" and "10:00"
// both become "time:10:00", "3 months" and "three-month" both "term:3-month".
export function extractSpecifics(text: string): Specific[] {
  const out: Specific[] = [];
  const add = (kind: SpecificKind, token: string, sample: string) => { out.push({ kind, token, sample: sample.trim() }); };
  const t = text.replace(/ /g, ' ');

  // Money, digits: £4,800 / $150 / 4,800 pounds / 950 GBP / £11k / £1.2m.
  // The k and m suffixes matter: a model paraphrasing "about eleven thousand
  // pounds" as "£11k" is being accurate, and reading that as £11 would accuse
  // it of inventing a figure it had just repeated correctly.
  for (const m of t.matchAll(new RegExp(`([£$€]\\s?)(\\d[\\d,]*(?:\\.\\d+)?)\\s*([km])?(?![\\d\\p{L}])|(\\d[\\d,]*(?:\\.\\d+)?)\\s*([km])?\\s*${CURRENCY_WORD}\\b`, 'giu'))) {
    const digits = (m[2] ?? m[4] ?? '').replace(/,/g, '');
    const scale = (m[3] ?? m[5] ?? '').toLowerCase();
    if (!digits) continue;
    const n = Number(digits) * (scale === 'k' ? 1_000 : scale === 'm' ? 1_000_000 : 1);
    add('figure', `money:${n}`, m[0]);
  }
  // Money, words: "four thousand eight hundred pounds"
  for (const m of t.matchAll(new RegExp(`((?:${NUM_WORD_RE}[\\s-]+){1,8})${CURRENCY_WORD}\\b`, 'gi'))) {
    const n = wordsToNumber(m[1]);
    if (n !== null && n > 0) add('figure', `money:${n}`, m[0]);
  }
  // Percentages.
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|(?:per\s?cent|percent)\b)/gi)) add('figure', `pct:${Number(m[1])}`, m[0]);
  // Clock times: 10am, 10:00, 2.30pm, noon.
  for (const m of t.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midday|midnight)\b/gi)) {
    if (m[6]) { add('date', `time:${/midnight/i.test(m[6]) ? '00:00' : '12:00'}`, m[0]); continue; }
    let h = Number(m[1] ?? m[4]);
    const min = (m[2] ?? m[5] ?? '00').padStart(2, '0');
    const ap = (m[3] ?? '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    add('date', `time:${String(h).padStart(2, '0')}:${min}`, m[0]);
  }
  // Calendar dates: 30 September / September 30th / Sep 30 / 2026-09-30 / 30/09/2026
  // Within a line. "…ends 30 September⏎2. The board meets…" is a date and then
  // a list number, and reading it as "September 2" sent a correct reply back
  // as inventing a date.
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[^\\S\\n]+(?:of[^\\S\\n]+)?(${MONTH_RE})\\b`, 'gi'))) add('date', `day:${monthIndex(m[2])}-${Number(m[1])}`, m[0]);
  for (const m of t.matchAll(new RegExp(`\\b(${MONTH_RE})[^\\S\\n]+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))) add('date', `day:${monthIndex(m[1])}-${Number(m[2])}`, m[0]);
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add('date', `day:${MONTHS[Number(m[2]) - 1] ?? m[2]}-${Number(m[3])}`, m[0]);
  // A weekday on its own is usually a pleasantry ("have a good Monday") and
  // matching it would cost more in false positives than it is worth. A
  // weekday next to a part of the day is a proposal — "would Tuesday
  // afternoon work?" — and a proposal the brief never made is one the sender
  // has to honour.
  for (const m of t.matchAll(/\b(mon|tues?|wednes|thurs?|fri|satur|sun)day\s+(morning|afternoon|evening)\b|\b(morning|afternoon|evening)\s+of\s+(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/gi)) {
    const day = (m[1] ?? m[4] ?? '').toLowerCase().slice(0, 3);
    const part = (m[2] ?? m[3] ?? '').toLowerCase();
    add('date', `when:${day}-${part}`, m[0]);
  }
  // A recurring date: "the second Tuesday of every month", "the last Friday".
  // This is how a business states a blackout or a board meeting, and it was
  // the single weakest fact in the depth sweep — the responder lost it two
  // runs in three — because nothing in the extractor recognised the shape, so
  // it never reached the agreed-facts block that carries the others.
  for (const m of t.matchAll(/\b(first|second|third|fourth|last)\s+(mon|tues?|wednes|thurs?|fri|satur|sun)day\b/gi)) {
    add('date', `recur:${m[1].toLowerCase()}-${m[2].toLowerCase().slice(0, 3)}`, m[0]);
  }
  // Terms and durations: 3 months / three-month / two days / a fortnight
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,3}|${NUM_WORD_RE})[\\s-]+(${UNIT_RE})s?\\b`, 'gi'))) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
    if (n !== null && n > 0) add('term', `term:${n}-${m[2].toLowerCase()}`, m[0]);
  }
  return out;
}

function monthIndex(name: string): string {
  const k = name.slice(0, 3).toLowerCase();
  return MONTHS.includes(k) ? k : name.toLowerCase();
}

// "Please find attached", "the attached plan", "enclosed". A model writing
// about a document it has no way to send is promising the reader something
// that is not there.
const ATTACHMENT_CLAIM_RE = /\b(?:attached|attachment|attachments|attaching|enclosed|enclosing|see the (?:attached|enclosed)|please find (?:attached|enclosed))\b/i;

/**
 * A mention that DENIES an attachment rather than promising one.
 *
 * The claim test is a bare word, and a word has no polarity: "No attachment,
 * as requested" was read as a promise of a document and held, which is the
 * opposite of what it says. Measured on a real draft — the conversation asked
 * for the terms in one message it could forward rather than as the proposal,
 * the model said so, and the guard called it an invented attachment.
 *
 * Deliberately narrow. The negation has to be right in front of the word, so
 * "please find attached" and "the attached plan" are untouched; only the
 * handful of ways a writer says there is nothing attached are let through.
 */
const ATTACHMENT_DENIAL_RE = /\b(?:no|not|without|nothing|never|isn't|aren't|won't|cannot|can't)\b[^.;!?]{0,24}?\b(?:attached|attachment|attachments|enclosed)\b/i;

export interface SpecificsExpectation {
  /**
   * Everything the message was allowed to know: the brief, the contact's own
   * fields, or the conversation. Anything specific in the body that is not
   * here was invented.
   */
  facts: string;
  /** Whether the outgoing message really carries an attachment. */
  hasAttachment?: boolean;
}

// Weekdays named anywhere in the facts, in any form. Used only to judge a
// proposed "Thursday morning": when the conversation says "could we do
// Thursday?" and "mornings work best", answering "Thursday morning" is
// combining two things it was told, not inventing a third. Requiring the
// exact adjacent phrase called that an invention, which it plainly is not.
const WEEKDAY_RE = /\b(mon|tues?|wednes|thurs?|fri|satur|sun)day/gi;
function weekdaysIn(text: string): Set<string> {
  return new Set([...text.matchAll(WEEKDAY_RE)].map((m) => m[1].toLowerCase().slice(0, 3)));
}

// Whether a duration in the body is foreign to the conversation, rather than
// merely phrased differently from it. See the note at the call site.
const NUM_WORD_OF: Record<number, string[]> = {
  1: ['one', 'a', 'single'], 2: ['two', 'couple'], 3: ['three'], 4: ['four'], 5: ['five'], 6: ['six'],
  7: ['seven'], 8: ['eight'], 9: ['nine'], 10: ['ten'], 11: ['eleven'], 12: ['twelve'],
};
function termIsForeign(token: string, facts: string, knownTerms: Set<string>): boolean {
  if (knownTerms.has(token)) return false;
  const [, rest] = token.split(':');
  const [numStr, unit] = rest.split('-');
  const n = Number(numStr);
  const hay = facts.toLowerCase();
  // The unit has to have come up at all.
  if (!new RegExp(`\\b${unit}s?\\b`, 'i').test(hay)) return true;
  // And the number, as a digit or as a word.
  const forms = [String(n), ...(NUM_WORD_OF[n] ?? [])];
  return !forms.some((f) => new RegExp(`\\b${f}\\b`, 'i').test(hay));
}

export function findInventedSpecifics(body: string, expect: SpecificsExpectation): GuardHit[] {
  const hits: GuardHit[] = [];
  const known = new Set(extractSpecifics(expect.facts).map((s) => s.token));
  const knownDays = weekdaysIn(expect.facts);
  const knownTerms = new Set([...known].filter((t) => t.startsWith('term:')));
  const seen = new Set<string>();
  const kindOf: Record<SpecificKind, GuardHit['kind']> = { figure: 'invented_figure', date: 'invented_date', term: 'invented_term' };
  for (const s of extractSpecifics(body)) {
    if (s.token.startsWith('when:') && knownDays.has(s.token.slice(5).split('-')[0])) continue;
    // Durations get recombined in a way money does not. A conversation that
    // says "two days of my time, and a third for Priya" is fairly summarised
    // as "three days" and "one day", neither of which appears in it verbatim.
    // So a term counts as invented only when it is genuinely foreign: either
    // the unit is never mentioned at all, or the number is. That still
    // catches the case this check was written for — "a rolling three-year
    // term" where the conversation said three months — because "year" never
    // appears.
    if (s.token.startsWith('term:') && !termIsForeign(s.token, expect.facts, knownTerms)) continue;
    if (known.has(s.token) || seen.has(s.token)) continue;
    seen.add(s.token);
    hits.push({ kind: kindOf[s.kind], sample: s.sample.slice(0, 60) });
  }
  // A message that promises a document it cannot send. Skipped when the facts
  // themselves are about an attachment: a summary of a thread in which
  // somebody attached a CSV is describing their attachment, not inventing one.
  if (!expect.hasAttachment && !ATTACHMENT_CLAIM_RE.test(expect.facts)) {
    const m = body.match(ATTACHMENT_CLAIM_RE);
    // Saying there is nothing attached is not promising one — see
    // `ATTACHMENT_DENIAL_RE`.
    if (m && !ATTACHMENT_DENIAL_RE.test(body)) hits.push({ kind: 'false_attachment', sample: m[0] });
  }
  return hits;
}

export interface GuardInput {
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  /**
   * Who this is to. Given, the salutation is asserted against it — see
   * `findGreetingProblems`. Absent, the greeting is not inspected, which is
   * what an ordinary template send wants.
   */
  greeting?: GreetingExpectation;
  /**
   * The closed set of facts this message was written from. Given, every
   * figure, date and term in the body has to appear in it — see
   * `findInventedSpecifics`. Only ever supplied for automated mail.
   */
  specifics?: SpecificsExpectation;
}

export function findTemplateArtifacts(input: GuardInput): GuardHit[] {
  const hits: GuardHit[] = [];
  const subject = input.subject ?? '';
  const bodyOnly = withoutQuotes(input.text ?? (input.html ? htmlToText(input.html) : ''), input.html);
  const text = `${subject}\n${bodyOnly}`;
  const seen = new Set<string>();
  const push = (kind: GuardHit['kind'], sample: string) => {
    const s = sample.trim().slice(0, 80);
    const key = `${kind}:${s.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, sample: s });
  };
  for (const m of text.matchAll(MERGE_RE)) push('merge_field', m[0]);
  for (const m of text.matchAll(SPIN_RE)) push('merge_field', m[0]);
  for (const m of text.matchAll(BRACKET_RE)) push('placeholder', m[0]);
  const prompt = text.match(PROMPT_RE);
  if (prompt) push('prompt_leak', prompt[0]);
  const reasoning = bodyOnly.match(REASONING_RE);
  if (reasoning) push('prompt_leak', reasoning[0]);
  const ai = text.match(AI_RE);
  if (ai) push('ai_disclosure', ai[0]);
  const filler = text.match(FILLER_RE);
  if (filler) push('filler', filler[0]);
  // Who it is addressed to, and whether it stuck to the facts it was given.
  // Both are opt-in: a caller that knows the recipient and the brief asks for
  // them, and a plain template send does not have either to offer.
  if (input.greeting) for (const h of findGreetingProblems(bodyOnly, input.greeting)) push(h.kind, h.sample);
  if (input.specifics) for (const h of findInventedSpecifics(`${subject}\n${bodyOnly}`, input.specifics)) push(h.kind, h.sample);
  // Whether it is prose at all. Only for generated mail — the same callers
  // that pass a greeting or the facts — because a template a person wrote is
  // theirs to punctuate however they like, and a run-on sentence in it is a
  // style, not a malfunction.
  if (input.greeting || input.specifics) for (const h of findGarbledText(bodyOnly, { context: input.specifics?.facts })) push(h.kind, h.sample);
  // Last resort: only when nothing more specific explains why this is not
  // fit to send, so the reason a person sees is the actionable one.
  if (!hits.length && bodyIsEmpty(bodyOnly)) push('no_body', bodyOnly.trim().replace(/\s+/g, ' ').slice(0, 40) || '(nothing)');
  return hits;
}

// ---------- Text that is not prose ----------
//
// What this exists for, from a real report. Asked for a reply, a model wrote:
//
//   Hello? Hi there,</p> We've officially opened our new Same Day Bookkeeping
//   service ... </br></div><ul class="ql-syntax ql-line末</li>We'd love if
//   your team could join us ... through next Friday noon EST when all offers
//   expire immediately after that deadline passes unless extended later due
//   demand spikes from early adopters across multiple markets globally
//   including yours specifically since last quarter showed strong growth
//   potential in similar sectors like retail finance insurance healthcare
//   technology media entertainment sports education government non profit ...
//
// Nothing else in this file objects to that. There is no merge field, no
// placeholder and no prompt text in it, and against a brief that mentions a
// launch and a discount there is not even an invented figure. It is simply
// not an email. Five signs, none of which ordinary mail shows:
//
//   markup    an HTML tag in what is plain text by the time anything here
//             reads it. A `</p>` in it was written by the model.
//   script    a writing system that appears nowhere in what the message was
//             written from — the stray 末 above. Only judged against a
//             context, so a reply in Japanese to a Japanese thread is fine.
//   run-on    fifty words without a full stop, comma, colon or line break.
//             The longest honest run in the drafts measured while writing
//             this was 31; the report above runs past a hundred.
//   loop      the same four words four times, or one word four times
//             running: a model stuck in a repetition.
//   cut off   a last line of eight words or more that never ends: a
//             generation that ran until something stopped it.
//
// A hit is a reason not to present or send the text, not a thing to repair:
// there is no sensible edit that turns the example above into an email.

const MARKUP_RE = /<\/?(?:p|br|div|span|ul|ol|li|a|b|i|u|em|strong|table|tbody|thead|tr|td|th|h[1-6]|html|body|head|style|script|img|font|blockquote|pre|code|hr|section|header|footer)\b[^<>\n]{0,120}>?/i;
// Latin is the default and never flagged; these are the systems a stray
// token from a multilingual model's vocabulary usually belongs to.
// Han and the two kana are one family: Japanese writes all three in one
// sentence, so a thread whose only Japanese is a name in kanji is answered
// with "田中さん" and neither half is foreign to the other.
const SCRIPTS: [string, RegExp][] = [
  ['Chinese or Japanese', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['Korean', /\p{Script=Hangul}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
];
const RUN_ON_WORDS = 50;
const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean);

export interface GarbleExpectation {
  /** What the message was written from. Only used to judge whether a writing system is foreign to it. */
  context?: string;
}

export function findGarbledText(body: string, expect: GarbleExpectation = {}): GuardHit[] {
  const hits: GuardHit[] = [];
  const text = String(body ?? '');
  if (!text.trim()) return hits;
  const push = (sample: string) => hits.push({ kind: 'garbled', sample });

  const tag = text.match(MARKUP_RE);
  if (tag) push(`markup ${tag[0].slice(0, 40)}`);

  if (expect.context !== undefined) {
    for (const [name, re] of SCRIPTS) {
      if (!re.test(text) || re.test(expect.context)) continue;
      const at = text.search(re);
      push(`${name} script the conversation never used: "${text.slice(Math.max(0, at - 12), at + 4)}"`);
      break;
    }
  }

  // Punctuation, a line break or a dash between words ends a run; a hyphen
  // inside a word does not.
  let longest: string[] = [];
  for (const seg of text.split(/[.!?,;:…()\n]|\s[-—–]\s|[—–]/)) {
    const w = wordsIn(seg);
    if (w.length > longest.length) longest = w;
  }
  if (longest.length >= RUN_ON_WORDS) push(`${longest.length} words without a stop: "…${longest.slice(-8).join(' ')}"`);

  const words = wordsIn(text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' '));
  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= words.length; i++) {
    const g = words.slice(i, i + 4).join(' ');
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const loop = [...grams.entries()].find(([, n]) => n >= 4);
  let stutter = '';
  for (let i = 1, run = 1; i < words.length && !stutter; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 4) stutter = words[i];
  }
  if (loop) push(`a phrase on a loop: "${loop[0]}" ×${loop[1]}`);
  else if (stutter) push(`"${stutter}" four times running`);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (wordsIn(last).length >= 8 && !/[.!?…:)"'’”\]]$/.test(last) && !SIGNOFF_RE.test(last)) {
    push(`ends mid-sentence: "…${wordsIn(last).slice(-6).join(' ')}"`);
  }
  return hits;
}

// ---------- The brief, before a word is generated ----------
//
// The single worst result in the evaluation: given a brief that still says
// "Mention [product name] and say it costs [price]", qwen3.5:4b invents
// $150, and mistral-small:24b — five times the size — invents $197. Neither
// leaves the placeholder in. Both fill it in with something plausible and
// wrong, which is strictly worse than leaving it, because a placeholder is
// caught downstream and a price is sent.
//
// So the brief is checked first. A gap in the instructions is a gap the
// person has to close, and telling them once about the brief beats holding
// forty generated emails that each invented a different number. This runs
// against the *rendered* brief, so a real merge field that resolved is fine
// and one that did not is exactly what wants catching.
export function findBriefProblems(brief: string): GuardHit[] {
  const hits: GuardHit[] = [];
  const seen = new Set<string>();
  const push = (kind: GuardHit['kind'], sample: string) => {
    const t = sample.trim().slice(0, 60);
    if (seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    hits.push({ kind, sample: t });
  };
  for (const m of brief.matchAll(MERGE_RE)) push('merge_field', m[0]);
  for (const m of brief.matchAll(SPIN_RE)) push('merge_field', m[0]);
  for (const m of brief.matchAll(BRACKET_RE)) push('placeholder', m[0]);
  return hits;
}

// What to tell the person, in their terms rather than the guard's.
export function describeBriefProblems(hits: GuardHit[]): string {
  const what = hits.map((h) => `"${h.sample}"`).join(', ');
  return `The brief still has ${what} in it. Fill that in — a small model does not leave a gap like that alone, it invents something plausible to put there.`;
}

export function describeHits(hits: GuardHit[]): string {
  const label: Record<GuardHit['kind'], string> = {
    merge_field: 'unrendered merge field', placeholder: 'placeholder', prompt_leak: 'prompt text',
    ai_disclosure: 'AI self-reference', filler: 'filler text', no_body: 'no message body, only',
    wrong_name: 'wrong recipient', invented_figure: 'a figure it was never given',
    invented_date: 'a date it was never given', invented_term: 'a term it was never given',
    false_attachment: 'a reference to an attachment that is not there',
    garbled: 'garbled text,',
  };
  return hits.map((h) => `${label[h.kind]} "${h.sample}"`).join('; ');
}

// ---------- Reading the brief before a draft is spent on it ----------
//
// The guard already knows every way a campaign draft goes wrong: an invented
// figure, an invented date, a promise of an attachment, no ask. Nearly all of
// them are decided by the brief rather than by the model — a brief that says
// "mention our pricing" and contains no prices has one outcome, and a small
// model asked for a price it was never given does not leave a gap, it invents
// something plausible.
//
// Running that same vocabulary over the brief itself says so in a tenth of a
// second, instead of forty seconds of generation followed by a held draft and
// a person working backwards from "invented figure" to the sentence that
// caused it.
//
// ── Why these are notes and not errors ──────────────────────────────────────
//
// `findBriefProblems` throws, because an unrendered merge field in a brief is
// certainly wrong. These are not certain: "have a look and let me know" is an
// ask that no keyword list contains, and a brief that mentions a discount may
// be describing one the reader already has. So they are shown beside the
// button, they never block it, and the wording says what the guard will
// probably do rather than what is definitely wrong.

export interface BriefNote {
  /** The guard outcome this predicts, so the wording and the hold agree. */
  kind: 'no_ask' | 'invented_figure' | 'invented_date' | 'false_attachment' | 'merge_field' | 'placeholder';
  note: string;
  sample?: string;
}

// An ask, in the forms people actually write one. Deliberately wide: a false
// "there is no ask here" on a brief that has one is the annoying failure, and
// a missed one costs only a note that was not shown.
const ASK_RE = /\b(?:ask|asking|book|booking|reply|replies|respond|call|calls?\b|meet|meeting|demo|chat|speak|talk|catch up|get in touch|let me know|worth a|interested|introduc|send (?:them|me|over)|share|schedule|set up|sign up|try|trial|visit|register|join|download|forward|put (?:us|me) in touch|happy to|free to|available)\b|\?/i;

// Words that promise something specific a brief has to supply. Each pairs with
// the kind of specific `extractSpecifics` would have to find for the model to
// have been told it.
const WANTS_FIGURE_RE = /\b(?:pric(?:e|es|ing)|cost|costs|fee|fees|rate|rates|discount|saving|savings|percent|percentage|roi|budget|quote|cheaper|per (?:seat|user|month|year)|how much)\b/i;
const WANTS_DATE_RE = /\b(?:deadline|expires?|expiry|cut ?off|by (?:the )?end of|next week|this week|next month|launch(?:es|ing)?|webinar|event|offer ends|closing|available (?:on|from)|starts? on|renewal)\b/i;

/**
 * What the guard will probably say about drafts written from this brief.
 *
 * Deterministic and cheap enough to run on every keystroke's worth of pause.
 * Returns an empty list far more often than not, which is the point: a brief
 * with nothing wrong with it should say nothing at all.
 */
export function coachBrief(brief: string): BriefNote[] {
  const text = String(brief ?? '').trim();
  if (text.length < 20) return [];
  const notes: BriefNote[] = [];

  // The certain ones first, in the guard's own words. These are the same hits
  // `findBriefProblems` throws on, surfaced early so the fix happens here
  // rather than at the moment somebody presses send.
  for (const h of findBriefProblems(text)) {
    notes.push({
      kind: h.kind === 'placeholder' ? 'placeholder' : 'merge_field',
      sample: h.sample,
      note: h.kind === 'placeholder'
        ? `“${h.sample}” is a placeholder. A small model fills a gap like that in rather than leaving it alone.`
        : `“${h.sample}” is a merge field. Briefs are instructions, not templates — write the value, or describe it.`,
    });
  }

  const specifics = extractSpecifics(text);
  const has = (k: SpecificKind) => specifics.some((sp) => sp.kind === k);

  // The one the whole idea started from: a brief with nothing to do in it.
  if (!ASK_RE.test(text)) {
    notes.push({ kind: 'no_ask', note: 'There is no ask in this brief. Every draft from it will describe something and stop, which is the commonest reason a campaign gets no replies.' });
  }

  // Asked for a number it was never given.
  const figure = text.match(WANTS_FIGURE_RE);
  if (figure && !has('figure')) {
    notes.push({ kind: 'invented_figure', sample: figure[0], note: `This asks for something about ${figure[0]} and gives no number. The guard holds a draft that invents a figure, so most of these will be held — put the real number in the brief.` });
  }

  // Asked for timing it was never given.
  const when = text.match(WANTS_DATE_RE);
  if (when && !has('date')) {
    notes.push({ kind: 'invented_date', sample: when[0], note: `This mentions “${when[0]}” without a date. A model asked to be specific about time and given none will invent one, and the guard holds that.` });
  }

  // A promise the send cannot keep.
  const attach = text.match(ATTACHMENT_CLAIM_RE);
  if (attach && !ATTACHMENT_DENIAL_RE.test(text)) {
    notes.push({ kind: 'false_attachment', sample: attach[0], note: `This mentions something “${attach[0]}”. Campaign mail carries no attachment, so a draft that says so is held. Link to it instead.` });
  }
  return notes;
}

export class TemplateGuardError extends Error {
  hits: GuardHit[];
  constructor(hits: GuardHit[]) {
    super(`Held back: the message still contains ${describeHits(hits)}`);
    this.name = 'TemplateGuardError';
    this.hits = hits;
  }
}

// Throws when an automated message is not fit to send. Mail a person wrote
// or approved is theirs to send as they like, placeholders and all.
export function assertSendable(input: GuardInput): void {
  const hits = findTemplateArtifacts(input);
  if (hits.length) throw new TemplateGuardError(hits);
}
