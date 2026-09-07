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
    | 'false_attachment';
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

const SALUTATION_RE = /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening|day))\b[\s,]*([^\n,:!?.]{0,40})/i;
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
    const who = m[1].trim().replace(/[,:!?.]+$/, '');
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
  let total = 0, current = 0, seen = false;
  for (const w of phrase.toLowerCase().split(/[\s-]+/)) {
    if (w === 'and' || !w) continue;
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
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`, 'gi'))) add('date', `day:${monthIndex(m[2])}-${Number(m[1])}`, m[0]);
  for (const m of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))) add('date', `day:${monthIndex(m[1])}-${Number(m[2])}`, m[0]);
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
const ATTACHMENT_CLAIM_RE = /\b(?:attached|attachment|attaching|enclosed|enclosing|see the (?:attached|enclosed)|please find (?:attached|enclosed))\b/i;

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

export function findInventedSpecifics(body: string, expect: SpecificsExpectation): GuardHit[] {
  const hits: GuardHit[] = [];
  const known = new Set(extractSpecifics(expect.facts).map((s) => s.token));
  const seen = new Set<string>();
  const kindOf: Record<SpecificKind, GuardHit['kind']> = { figure: 'invented_figure', date: 'invented_date', term: 'invented_term' };
  for (const s of extractSpecifics(body)) {
    if (known.has(s.token) || seen.has(s.token)) continue;
    seen.add(s.token);
    hits.push({ kind: kindOf[s.kind], sample: s.sample.slice(0, 60) });
  }
  if (!expect.hasAttachment) {
    const m = body.match(ATTACHMENT_CLAIM_RE);
    if (m) hits.push({ kind: 'false_attachment', sample: m[0] });
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
  // Last resort: only when nothing more specific explains why this is not
  // fit to send, so the reason a person sees is the actionable one.
  if (!hits.length && bodyIsEmpty(bodyOnly)) push('no_body', bodyOnly.trim().replace(/\s+/g, ' ').slice(0, 40) || '(nothing)');
  return hits;
}

export function describeHits(hits: GuardHit[]): string {
  const label: Record<GuardHit['kind'], string> = {
    merge_field: 'unrendered merge field', placeholder: 'placeholder', prompt_leak: 'prompt text',
    ai_disclosure: 'AI self-reference', filler: 'filler text', no_body: 'no message body, only',
    wrong_name: 'wrong recipient', invented_figure: 'a figure it was never given',
    invented_date: 'a date it was never given', invented_term: 'a term it was never given',
    false_attachment: 'a reference to an attachment that is not there',
  };
  return hits.map((h) => `${label[h.kind]} "${h.sample}"`).join('; ');
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
