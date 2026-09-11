import { evalConsent } from './evalConsent.js';
// Live model evaluation. Unlike the unit tests, this one actually talks to
// the configured model and grades what comes back, so a change to a prompt,
// a default or the clean-up pass can be judged on the thing that matters:
// whether the mail a person would send is right.
//
//   npx tsx --env-file=../.env.dev src/ai/live.eval.ts
//   MODEL=qwen3.5:4b RUNS=20 npx tsx --env-file=../.env.dev src/ai/live.eval.ts
//   ONLY=thread,name npx tsx --env-file=../.env.dev src/ai/live.eval.ts
//
// Every case is graded by a deterministic check, never by another model, so
// the pass rate means the same thing on every run.
import { chat, getAiSettings, saveAiSettings } from './llm.js';
import { buildMessages, cleanOutput, finalizeOutput, modeTuning, type DraftInput } from './prompts.js';
import { findTemplateArtifacts, describeHits, findInventedSpecifics, findGreetingProblems, extractSpecifics } from './guard.js';
import { resolveRecipient, candidatesFromContact } from './names.js';
import { threadForPrompt, ALEX as F_ALEX, DANA as F_DANA, PRIYA as F_PRIYA, TOMASZ as F_TOMASZ } from './fixtures.js';
import { countTokens } from './tokens.js';
import { tidyGist } from '../services/summaries.js';
import { pool } from '../db.js';

const MODEL = process.env.MODEL || 'qwen3.5:4b';
// Ten runs, not three. Every case here is flaky at some rate and three runs
// cannot tell 2/3 from 7/10; the model is local and the electricity is the
// only cost, so the sample size is set by what makes the number mean
// something rather than by what is quick.
const RUNS = Number(process.env.RUNS || 10);
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const THINK = process.env.THINK; // 'on' | 'off' | unset (leave the stored setting alone)
// The depth sweep: DEPTHS=5,10,20,30,50 runs the thread cases at each depth
// and prints where quality falls off, per mode.
const DEPTHS = (process.env.DEPTHS || '').split(',').map((d) => Number(d.trim())).filter((n) => n > 0);
const MAX_TOKENS = process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined;

// ---------- graders ----------

type Check = (out: string) => string | null; // null = pass, string = why it failed

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// `\b` is an ASCII word boundary: it does not fire after a Cyrillic or CJK
// character, so the first version of this grader failed every non-Latin name
// while the model was greeting it perfectly. The boundary is expressed as
// "not followed by another letter" instead, which is script-agnostic.
const greets = (name: string): Check => (out) => {
  const l = firstLine(out);
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = `(?!\\p{L})`;
  return new RegExp(`^(hi|hello|hey|dear)\\s+${n}${boundary}`, 'iu').test(l) || new RegExp(`^${n}${boundary}`, 'iu').test(l)
    ? null
    : `greeting is "${l.slice(0, 60)}", expected to address ${name}`;
};

// Only the salutation itself is inspected: "Hi Dana, I'm Alex from
// Brightledger" is a correct greeting that happens to introduce the sender.
const greetsNobodyElse = (right: string, wrong: string[]): Check => (out) => {
  const salutation = firstLine(out).split(',')[0];
  for (const w of wrong) if (new RegExp(`\\b${w}\\b`, 'i').test(salutation)) return `salutation names ${w}: "${salutation.slice(0, 60)}"`;
  return null;
};

// The wrong person's name anywhere in the body, not just the greeting.
const neverNames = (wrong: string[]): Check => (out) => {
  for (const w of wrong) if (new RegExp(`\\b${w}\\b`, 'i').test(out)) return `body names ${w}`;
  return null;
};

const clean: Check = (out) => {
  const hits = findTemplateArtifacts({ text: out });
  return hits.length ? `guard: ${describeHits(hits)}` : null;
};

const nonEmpty: Check = (out) => (out.trim().length > 20 ? null : `output too short (${out.trim().length} chars)`);

// A subject line is not a body. The floor above is twenty characters, which
// is right for an email and wrong here: "New office address" is eighteen and
// is a perfectly good subject. Once the prompt stopped naming a word count
// the model started writing shorter ones, and this check failed them. What a
// subject must not be is empty or a single word.
const atLeastWords = (n: number): Check => (out) => {
  const w = out.trim().split(/\s+/).filter(Boolean).length;
  return w >= n ? null : `only ${w} word${w === 1 ? '' : 's'}: "${out.trim().slice(0, 40)}"`;
};

// Reasoning that reached the draft. Tags are the easy half; the hard half is
// a model narrating the task in prose, which is what actually turned up in a
// campaign preview. The prose half lives in guard.ts so the eval and the send
// path cannot disagree about what counts.
const noThinkTags: Check = (out) => {
  if (/<\/?think(ing)?>|^\s*(okay|alright),? (so|let)\b|thinking process/i.test(out)) return `reasoning leaked into the draft: "${out.slice(0, 80)}"`;
  const leak = findTemplateArtifacts({ text: out }).find((h) => h.kind === 'prompt_leak');
  return leak ? `reasoning leaked into the draft: "${leak.sample}"` : null;
};

const mentions = (words: string[], label = ''): Check => (out) => {
  const hay = out.toLowerCase();
  const missing = words.filter((w) => !hay.includes(w.toLowerCase()));
  return missing.length ? `missing ${label || 'fact'}: ${missing.join(', ')}` : null;
};

// Hyphens and spacing are the model's choice, not a mistake: "fifteen-minute
// walk-through" says the same thing as "fifteen minute walkthrough".
const flat = (s: string) => s.toLowerCase().replace(/[\u2010-\u2015-]/g, ' ').replace(/\s+/g, ' ');
const mentionsAny = (words: string[], label: string): Check => (out) => {
  const hay = flat(out);
  const loose = flat(out).replace(/ /g, '');
  return words.some((w) => hay.includes(flat(w)) || loose.includes(flat(w).replace(/ /g, ''))) ? null : `no sign of ${label} (looked for ${words.join('/')})`;
};

// What the product actually promises when the recipient's name is unknown:
// a greeting that names nobody. Which neutral wording the model picks is
// its own business.
const NEUTRAL_GREETING = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening|day))\b[\s,!.:]*(?:there|all|team|everyone|folks|friend|sir|madam|sir or madam|colleagues?)?\b[\s,!.:]*/i;
const greetsNoName: Check = (out) => {
  const line = firstLine(out);
  const m = line.match(NEUTRAL_GREETING);
  if (!m) return `does not open with a greeting: "${line.slice(0, 60)}"`;
  const rest = line.slice(m[0].length);
  // A name would sit right after the greeting, before the first sentence break.
  const invented = rest.split(/[,.!?:]/)[0].trim();
  if (m[0].trim().length < line.trim().length && /^[A-Z][a-z]+$/.test(invented)) return `invented a name: "${line.slice(0, 60)}"`;
  return null;
};

const exactlyLines = (n: number): Check => (out) => {
  const lines = out.split('\n').filter((l) => l.trim());
  return lines.length === n ? null : `expected ${n} lines, got ${lines.length}`;
};

// Quick replies are offered as a set to pick from and unusable ones are
// dropped rather than patched, so the contract is "two or three, all of them
// worth clicking" rather than a fixed count.
const linesBetween = (lo: number, hi: number): Check => (out) => {
  const lines = out.split('\n').filter((l) => l.trim());
  return lines.length >= lo && lines.length <= hi ? null : `expected ${lo}-${hi} suggestions, got ${lines.length}`;
};

const everyLineUnder = (words: number): Check => (out) => {
  for (const l of out.split('\n').filter((x) => x.trim())) {
    if (l.trim().split(/\s+/).length > words) return `line over ${words} words: "${l.slice(0, 60)}"`;
  }
  return null;
};

const noGreetingLine: Check = (out) => (/^\s*(hi|hello|hey|dear)\b/i.test(out) ? `starts with a greeting: "${firstLine(out)}"` : null);

const wordsUnder = (n: number): Check => (out) => {
  const w = out.trim().split(/\s+/).length;
  return w <= n ? null : `${w} words, expected under ${n}`;
};

const noSubjectLine: Check = (out) => (/^\s*subject\s*:/im.test(out) ? 'a Subject: line leaked into the body' : null);

const matches = (re: RegExp, why: string): Check => (out) => (re.test(out) ? null : why);

// ---------- graders the old set was missing ----------
//
// The pass rate before these existed was 17/17, and the outputs behind it
// contained an invented "rolling three-year term" where the thread said three
// months, an invented "$150 per month" where the brief said [price], an
// invented "Tuesday at 10am", and three separate references to an attachment
// that does not exist. None of that is a writing problem the model can be
// asked out of; all of it is checkable against the facts it was given.

// Nothing specific in the answer that was not in what it was shown. Uses the
// same code the send guard uses, so the eval measures the shipped behaviour
// rather than a second opinion about it.
// `describing: true` for the modes whose output is *about* a conversation
// rather than an email in one. A summary that says "Priya is attaching the
// CSV" is reporting what somebody else did; only a message we are about to
// send can promise an attachment it does not have.
const inventsNothing = (facts: () => string, opts: { describing?: boolean } = {}): Check => (out) => {
  const hits = findInventedSpecifics(out, { facts: facts(), hasAttachment: Boolean(opts.describing) });
  return hits.length ? `invented: ${describeHits(hits)}` : null;
};

// A quick reply goes into the composer the moment somebody clicks it, and it
// is shown only the tail of a thread. Repeating a date the other person just
// proposed is exactly what a useful suggestion does; introducing one that is
// nowhere in the conversation is a commitment nobody made.
const noUnseenSpecifics = (facts: () => string): Check => (out) => {
  const hits = findInventedSpecifics(out, { facts: facts(), hasAttachment: true });
  return hits.length ? `states a specific that is nowhere in the conversation: ${describeHits(hits)}` : null;
};

// The salutation, judged by the shipped guard rather than by a regex that only
// this file believes in.
const addressed = (first: string, forbidden: string[]): Check => (out) => {
  const hits = findGreetingProblems(out, { first, forbidden });
  return hits.length ? describeHits(hits) : null;
};

// A decision that was reversed later in the thread. Forgetting it and getting
// it backwards are different failures and are reported separately: "Tomasz
// still needs to approve the £4,800" is confidently, specifically wrong about
// the state of the deal, which is worse than not mentioning him.
const notSuperseded = (stale: RegExp, why: string): Check => (out) => (stale.test(out) ? `states the superseded position: ${why}` : null);

// An email is paragraphs. A model that collapses the greeting, the body and
// the sign-off onto one line has produced something nobody would send, and
// the old grader set had nothing that noticed.
const hasParagraphs: Check = (out) => {
  const lines = out.split('\n').filter((l) => l.trim());
  if (lines.length >= 3) return null;
  return out.trim().split(/\s+/).length > 45 ? `the whole email is on ${lines.length} line(s)` : null;
};

// The facts the thread cases are allowed to use.
// A fact stated in message N of the conversation only exists once the thread
// is at least N+1 messages deep. Asserting it at depth 5 is asking the model
// to recall something nobody has said yet, and the first version of this
// sweep did exactly that — `reply/deep-thread-facts` failed at every depth
// including 5, where the monthly figure has not been mentioned.
const statedAt = (msgIndex: number, check: Check): Check => (out) => ((sweepDepth ?? 24) <= msgIndex ? null : check(out));

// The facts a thread case is allowed to use. The depth sweep sets
// `sweepDepth` so that "did it invent this?" is judged against the
// conversation the model was actually shown, not against a longer one.
let sweepDepth: number | null = null;
const threadFacts = (n = 24) => () => deepThread(sweepDepth ?? n).map((m) => m.text).join('\n');

// ---------- the people in the scenarios ----------

const ALEX = { name: F_ALEX.name, email: F_ALEX.email };
const DANA = { name: F_DANA.name, email: F_DANA.email, company: F_DANA.company, title: F_DANA.title };
const PRIYA = { name: F_PRIYA.name, email: F_PRIYA.email, company: F_PRIYA.company, title: F_PRIYA.title };
// Named eleven times in the thread, quoted below the fold, and never once a
// participant. Greeting him is the failure a long conversation invites.
const TOMASZ = F_TOMASZ;

// The conversation every thread case runs against. It lives in ai/fixtures.ts
// because responder.eval.ts needs the same one, and because the version this
// replaced was 596 tokens of telegram-style one-liners that never filled a
// context window and therefore never tested the thing it claimed to.
function deepThread(n = 24): { from: string; date: string; text: string }[] {
  return threadForPrompt(n);
}

const CAMPAIGN_BRIEF = 'We just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they would like a 15 minute walkthrough next week.';
// A brief with no holes in it, but vague enough to invite invention: it
// mentions pricing and a discount without giving either. The holed version —
// "say it costs [price]" — is no longer a live case because the product now
// refuses to generate from it at all (see `findBriefProblems`); what is left
// to measure is whether a *complete* brief that gestures at a number gets one
// invented anyway.
const HOSTILE_BRIEF = 'Tell them about our new bookkeeping service and that there is an introductory discount for wholesale customers. Ask them to reply if they would like the details.';

const SHORT_THREAD = [
  { from: `Dana Osei <${DANA.email}>`, date: 'Mon Jun 01 2026', text: 'Hi Alex,\n\nCould we do a 20 minute call on Thursday about the Q3 report? Morning works best for me.' },
];

// ---------- cases ----------

interface Case {
  id: string;
  tags: string[];
  input: DraftInput;
  maxTokens?: number;
  temperature?: number;
  checks: Check[];
}

const CASES: Case[] = [
  {
    id: 'compose/known-recipient',
    tags: ['name', 'compose'],
    input: {
      mode: 'compose',
      instruction: 'Introduce Brightledger and ask for a 15 minute call next week about their Sage migration.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      length: 'medium',
    },
    checks: [nonEmpty, noThinkTags, clean, greets('Dana'), greetsNobodyElse('Dana', ['Alex', 'Priya', 'Tomasz']), noSubjectLine],
  },
  {
    id: 'compose/unknown-recipient',
    tags: ['name', 'compose'],
    input: {
      mode: 'compose',
      instruction: 'Ask whether they are the right person to talk to about bookkeeping.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: { email: 'hello@northwind.example' },
    },
    // No name is known: nothing may be invented.
    checks: [nonEmpty, noThinkTags, clean, greetsNoName],
  },
  {
    id: 'reply/short-thread',
    tags: ['name', 'reply'],
    input: {
      mode: 'reply',
      instruction: 'Say Thursday works and propose 10am.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      subject: 'Q3 report call',
      thread: SHORT_THREAD,
    },
    checks: [nonEmpty, noThinkTags, clean, greets('Dana'), greetsNobodyElse('Dana', ['Alex']), mentionsAny(['thursday'], 'the day that was asked about'), mentionsAny(['10', 'ten'], 'the proposed time')],
  },
  {
    id: 'reply/deep-thread-facts',
    tags: ['thread', 'reply', 'context'],
    input: {
      mode: 'reply',
      instruction: 'Answer the question in the last message.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      subject: 'Northwind bookkeeping',
      thread: deepThread(24),
      length: 'medium',
    },
    // The two dates were given in message 3 of 24; the monthly figure in
    // message 13. A reply that cannot see them will invent or omit them.
    checks: [
      nonEmpty, noThinkTags, clean, greets('Dana'),
      // Each fact is asserted only from the depth at which it has been said.
      // The message indices come from ai/fixtures.ts GRADED_FACTS.
      statedAt(2, mentionsAny(['30 september', 'september 30', '30th september'], 'the fiscal year end')),
      statedAt(2, mentionsAny(['second tuesday', '2nd tuesday'], 'the board meeting blackout')),
      statedAt(12, mentions(['950'], 'the monthly figure')),
      inventsNothing(threadFacts()),
      // Stated at message 13, reversed at message 20: only a thread deep
      // enough to contain the reversal can get it backwards.
      statedAt(20, notSuperseded(/\b(?:needs?|awaiting|pending|require[sd]?)\b[^.]{0,40}\b(?:sign[- ]?off|approval|approve)/i, 'Tomasz approved the £4,800 in message 21')),
      hasParagraphs,
    ],
  },
  {
    id: 'reply/deep-thread-name',
    tags: ['thread', 'name', 'context'],
    input: {
      mode: 'reply',
      instruction: 'Confirm you have everything you need and say the plan follows tomorrow.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      subject: 'Northwind bookkeeping',
      thread: deepThread(24),
    },
    // Priya wrote three of the last six messages: a model that greets the
    // most recent writer rather than the recipient gets this wrong.
    checks: [
      nonEmpty, noThinkTags, clean, greets('Dana'),
      addressed('Dana', [ALEX.name, PRIYA.name, TOMASZ.name]),
      inventsNothing(threadFacts()),
    ],
  },
  {
    id: 'reply/replying-to-priya',
    tags: ['thread', 'name'],
    input: {
      mode: 'reply',
      instruction: 'Thank her for the CSV and say you will confirm the VAT remap when it is done.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: PRIYA,
      subject: 'Northwind bookkeeping',
      thread: deepThread(23),
    },
    checks: [nonEmpty, noThinkTags, clean, greets('Priya'), addressed('Priya', [DANA.name, ALEX.name, TOMASZ.name]), inventsNothing(threadFacts(23))],
  },
  {
    id: 'quick_replies/short',
    tags: ['quick'],
    input: {
      mode: 'quick_replies',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      thread: SHORT_THREAD,
    },
    checks: [linesBetween(2, 3), everyLineUnder(18), noGreetingLine, neverNames(['Dana Osei']), clean, noUnseenSpecifics(() => SHORT_THREAD.map((m) => m.text).join('\n'))],
  },
  {
    id: 'quick_replies/deep-thread',
    tags: ['quick', 'thread'],
    input: {
      mode: 'quick_replies',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      thread: deepThread(24),
    },
    checks: [linesBetween(2, 3), everyLineUnder(18), noGreetingLine, clean, noUnseenSpecifics(threadFacts())],
  },
  {
    id: 'summarize/deep-thread',
    tags: ['thread', 'summary', 'context'],
    input: {
      mode: 'summarize',
      senderName: ALEX.name, senderEmail: ALEX.email,
      thread: deepThread(24),
    },
    checks: [nonEmpty, noThinkTags, matches(/\bnext\s*:/i, 'no "Next:" line'), statedAt(12, mentionsAny(['4,800', '4800', '950'], 'either money figure')), inventsNothing(threadFacts(), { describing: true })],
  },
  {
    id: 'subject/from-draft',
    tags: ['subject'],
    input: {
      mode: 'subject',
      draft: 'Hi Dana,\n\nThanks for the CSV. The VAT remap on the 1,900 rows starts Monday and should take two days, with a third for Priya to spot check.\n\nAlex',
    },
    checks: [atLeastWords(2), exactlyLines(1), wordsUnder(9), matches(/^[^"']/, 'subject is quoted'), matches(/[^.!]$/, 'subject ends with punctuation')],
  },
  {
    id: 'polish/typos',
    tags: ['edit'],
    input: {
      mode: 'polish',
      draft: 'Hi Dana,\n\nthanks for you\'re patience. we recieved the csv yesterday and its looking good, i will send the plan tommorow.\n\nAlex',
    },
    checks: [nonEmpty, noThinkTags, clean, matches(/received/i, 'did not fix "recieved"'), matches(/tomorrow/i, 'did not fix "tommorow"'), greets('Dana')],
  },
  {
    id: 'shorten/long-draft',
    tags: ['edit'],
    input: {
      mode: 'shorten',
      draft: 'Hi Dana,\n\nThank you very much for taking the time to send over the CSV export yesterday afternoon, it is very much appreciated and it arrived exactly when we needed it. As I mentioned in my previous message, the VAT remap covers approximately 1,900 rows and we expect this to take about two working days to complete end to end, after which Priya will need a further day in order to spot check the results before we sign it off.\n\nAlex',
    },
    checks: [nonEmpty, noThinkTags, clean, wordsUnder(70)],
  },
  {
    id: 'rewrite/direction',
    tags: ['edit'],
    input: {
      mode: 'rewrite',
      instruction: 'More direct, drop the hedging.',
      draft: 'Hi Dana,\n\nI was just wondering if you might possibly have had a chance to perhaps look at the plan I sent, but no worries at all if not.\n\nAlex',
    },
    checks: [nonEmpty, noThinkTags, clean, wordsUnder(90)],
  },
  {
    id: 'expand/thin-draft',
    tags: ['edit'],
    input: {
      mode: 'expand',
      draft: 'Hi Dana,\n\nThe remap is done. Numbers reconcile.\n\nAlex',
    },
    checks: [nonEmpty, noThinkTags, clean],
  },
  {
    id: 'personalize/campaign',
    tags: ['campaign', 'name'],
    input: {
      mode: 'personalize',
      instruction: 'Under 110 words, no exclamation marks.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      template: CAMPAIGN_BRIEF,
      subject: 'Same-day reports',
      length: 'medium',
    },
    maxTokens: 600,
    checks: [
      nonEmpty, noThinkTags, clean, greets('Dana'), addressed('Dana', [ALEX.name]),
      mentionsAny(['walkthrough', 'walk through', '15 minute', 'fifteen minute'], 'the ask'), wordsUnder(160),
      inventsNothing(() => CAMPAIGN_BRIEF), hasParagraphs,
    ],
  },
  {
    id: 'personalize/no-name',
    tags: ['campaign', 'name'],
    input: {
      mode: 'personalize',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: { email: 'accounts@westmere.example', company: 'Westmere Trading' },
      template: CAMPAIGN_BRIEF,
      length: 'short',
    },
    maxTokens: 600,
    // Company is known, the person is not: a name here would be invented.
    checks: [nonEmpty, noThinkTags, clean, greetsNoName],
  },
  {
    id: 'personalize/vague-brief',
    tags: ['campaign', 'guard'],
    input: {
      mode: 'personalize',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      // A brief that a careless model will copy verbatim, placeholders and all.
      template: HOSTILE_BRIEF,
      length: 'short',
    },
    maxTokens: 600,
    // Whatever the model does, the guard must catch anything left over: this
    // case passes when the output is clean, and its failure is the point of
    // the review queue.
    // The old version asserted only that something came back. The model duly
    // invented a product and a price and it passed, which is a worse outcome
    // than leaving the placeholder in — a placeholder is held for review, a
    // price is sent.
    checks: [nonEmpty, noThinkTags, greets('Dana'), clean, inventsNothing(() => HOSTILE_BRIEF)],
  },
  // ---------- the modes nothing was grading ----------
  //
  // `gist`, `reschedule` and `nudge` all ship, all reach a person, and none
  // of them had a single live case. The gist goes above every row of the
  // mail list; the other two write an email about a promise, from the ledger,
  // where getting the date wrong is worse than getting the greeting wrong
  // because nobody notices until it is missed.
  {
    id: 'gist/deep-thread',
    tags: ['thread', 'gist'],
    input: { mode: 'gist', thread: deepThread(24), subject: 'Northwind Supply — coming off Sage' },
    checks: [
      exactlyLines(1), wordsUnder(15), noGreetingLine,
      matches(/^[^"']/, 'the line is quoted'),
      matches(/[^.]$/, 'the line ends with a full stop'),
      // The subject is on the row above; a gist that restates it costs the
      // only line there is.
      (out) => (/coming off sage/i.test(out) ? 'just restates the subject' : null),
      (out) => (/^this (?:e-?mail|message|thread)/i.test(out) ? 'opens with "This email"' : null),
    ],
  },
  {
    id: 'gist/short-thread',
    tags: ['gist'],
    input: { mode: 'gist', thread: SHORT_THREAD, subject: 'Q3 report call' },
    checks: [exactlyLines(1), wordsUnder(15), noGreetingLine, matches(/[^.]$/, 'the line ends with a full stop')],
  },
  {
    id: 'reschedule/with-new-date',
    tags: ['commitment'],
    input: {
      mode: 'reschedule',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      commitment: {
        kind: 'owed',
        what: 'the VAT remap on the 1,900 rows',
        reason: 'the CSV export came through with the codes in a different order',
        was: 'Thursday 10 September',
        now: 'Tuesday 15 September',
      },
      tone: 'friendly',
    },
    maxTokens: 400,
    checks: [
      nonEmpty, noThinkTags, clean, greets('Dana'), addressed('Dana', [ALEX.name]),
      // The whole point of the email: the new date, stated.
      mentionsAny(['15 september', 'september 15', '15th september', 'tuesday 15'], 'the new date'),
      // The thing being apologised for has to be named.
      mentionsAny(['vat', 'remap'], 'what was promised'),
      // Not a wall of contrition, and no invented compensation.
      wordsUnder(130),
      (out) => ((out.match(/\b(?:sorry|apolog\w+)\b/gi) ?? []).length > 2 ? 'apologises more than twice' : null),
      (out) => (/\b(?:discount|refund|free of charge|no charge|on us|compensat\w+)\b/i.test(out) ? 'offered compensation nobody authorised' : null),
      inventsNothing(() => 'the VAT remap on the 1,900 rows. the CSV export came through with the codes in a different order. Thursday 10 September. Tuesday 15 September.'),
    ],
  },
  {
    id: 'reschedule/no-new-date',
    tags: ['commitment'],
    input: {
      mode: 'reschedule',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      commitment: { kind: 'owed', what: 'the reconciliation report', reason: 'I am still waiting on the bank export', was: 'Friday 12 September' },
    },
    maxTokens: 400,
    // There is no new date. Inventing one is the failure being tested.
    checks: [
      nonEmpty, noThinkTags, clean, greets('Dana'),
      inventsNothing(() => 'the reconciliation report. I am still waiting on the bank export. Friday 12 September.'),
      wordsUnder(130),
    ],
  },
  {
    id: 'nudge/awaiting',
    tags: ['commitment'],
    input: {
      mode: 'nudge',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: { name: 'Priya Raman', email: PRIYA.email },
      commitment: { kind: 'awaiting', what: 'the CSV export of the March to June entries', was: 'last Friday' },
    },
    maxTokens: 400,
    checks: [
      nonEmpty, noThinkTags, clean, greets('Priya'),
      mentionsAny(['csv', 'export'], 'what is being chased'),
      wordsUnder(110),
      // A nudge that opens by counting how late somebody is has already lost.
      (out) => (/\b(?:as per my (?:last|previous)|chasing again|still waiting|have not heard|haven'?t heard|following up again|third time|second time)\b/i.test(out) ? 'reproachful: reads as chasing rather than checking' : null),
      inventsNothing(() => 'the CSV export of the March to June entries. last Friday.'),
    ],
  },

  // ---------- Requirement A: the name, in every shape it really arrives in ----------
  //
  // Three people and one "Osei, Dana" was not coverage. Every case below is a
  // shape seen in real mail or in a real CSV export, and every one of them is
  // decided by ai/names.ts rather than by asking the model to be careful. The
  // rule they all test is the same: use the name when it resolves, and greet
  // nobody when it does not. Never guess.
  ...([
    // The display name is the sender's own name, which is what a badly built
    // "reply to" form produces. Greeting the sender is not an option.
    { id: 'name/sender-own-name', raw: 'Alex Rivera', expect: '' },
    // A login, not a name. "hey dana.osei0," is the failure being refused.
    { id: 'name/email-local-part', raw: 'dana.osei0', expect: '' },
    { id: 'name/address-as-name', raw: 'dana@northwind.example', expect: '' },
    // A template nobody rendered, and the fallbacks people type instead.
    { id: 'name/placeholder-bracket', raw: '[Your Name]', expect: '' },
    { id: 'name/placeholder-merge', raw: '{{first_name}}', expect: '' },
    { id: 'name/placeholder-word', raw: 'there', expect: '' },
    { id: 'name/blank-csv-column', raw: '   ', expect: '' },
    { id: 'name/malformed-csv-column', raw: 'N/A', expect: '' },
    // The company in the name column: a one-column export of "Account name".
    { id: 'name/company-in-name-column', raw: 'Northwind Supply', expect: '', company: 'Northwind Supply' },
    // Shapes that ARE names and must survive intact.
    { id: 'name/surname-first', raw: 'Osei, Dana', expect: 'Dana' },
    { id: 'name/shouting-surname-first', raw: 'SMITH, JOHN', expect: 'John' },
    { id: 'name/honorific-and-hyphen', raw: "Dr. Jane Smith-O'Brien", expect: 'Jane' },
    { id: 'name/company-in-parens', raw: 'John Smith (Acme)', expect: 'John' },
    { id: 'name/single-word', raw: 'Madonna', expect: 'Madonna' },
    { id: 'name/emoji-in-display-name', raw: '✨ Dana Osei 🚀', expect: 'Dana' },
    // Written as one unit: greeted whole rather than split on a space that is
    // not there, or on a family name mistaken for a given one.
    { id: 'name/cjk', raw: '田中優希', expect: '田中優希' },
    { id: 'name/cyrillic', raw: 'Дана Осеи', expect: 'Дана' },
  ] as { id: string; raw: string; expect: string; company?: string }[]).map((n): Case => ({
    id: n.id,
    tags: ['name', 'compose'],
    input: {
      mode: 'compose',
      instruction: 'Ask whether they are the right person to talk to about bookkeeping. Two sentences.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      // Exactly what the routes do: the raw value is resolved in code first,
      // and only the resolved name is ever put in front of the model.
      recipient: (() => {
        const r = resolveRecipient([{ value: n.raw, source: 'display' }], { email: 'contact@northwind.example', senderName: ALEX.name, senderEmail: ALEX.email, company: n.company });
        return { name: r.full || undefined, email: 'contact@northwind.example', company: n.company };
      })(),
      length: 'short',
    },
    maxTokens: 400,
    checks: [
      nonEmpty, noThinkTags, clean,
      // The guard's own answer, so the eval and the send path agree.
      addressed(n.expect, [ALEX.name, 'Priya', 'Tomasz']),
      // And, when nothing resolved, the greeting must actually be neutral
      // rather than merely "not one of the names we listed".
      ...(n.expect ? [greets(n.expect)] : [greetsNoName]),
    ],
  })),

  // A name that is only in the body of the conversation, never a participant.
  {
    id: 'name/third-party-in-thread',
    tags: ['name', 'thread'],
    input: {
      mode: 'reply',
      instruction: 'Confirm the start date works and that you will send the plan.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      subject: 'Northwind bookkeeping',
      thread: deepThread(24),
    },
    // Tomasz is named throughout and quoted below the fold. He has never
    // written a message.
    checks: [nonEmpty, noThinkTags, clean, greets('Dana'), addressed('Dana', [TOMASZ.name, PRIYA.name, ALEX.name])],
  },
  // A shared mailbox with a real person's display name on it: the person is
  // greeted, the mailbox is not.
  {
    id: 'name/role-address-with-person',
    tags: ['name', 'compose'],
    input: {
      mode: 'compose',
      instruction: 'Ask whether they are the right person to talk to about bookkeeping. Two sentences.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: (() => {
        const r = resolveRecipient([{ value: 'Dana Osei', source: 'display' }], { email: 'accounts@northwind.example', senderName: ALEX.name, senderEmail: ALEX.email });
        return { name: r.full || undefined, email: 'accounts@northwind.example' };
      })(),
      length: 'short',
    },
    maxTokens: 400,
    checks: [nonEmpty, noThinkTags, clean, greets('Dana'), addressed('Dana', [ALEX.name])],
  },
  // A role address with nothing but the role on it: nobody to greet.
  {
    id: 'name/noreply-address',
    tags: ['name', 'compose'],
    input: {
      mode: 'compose',
      instruction: 'Ask whether they are the right person to talk to about bookkeeping. Two sentences.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: (() => {
        const r = resolveRecipient([{ value: 'Accounts', source: 'display' }], { email: 'noreply@northwind.example', senderName: ALEX.name, senderEmail: ALEX.email });
        return { name: r.full || undefined, email: 'noreply@northwind.example' };
      })(),
      length: 'short',
    },
    maxTokens: 400,
    checks: [nonEmpty, noThinkTags, clean, greetsNoName, addressed('', [ALEX.name])],
  },
];

// ---------- runner ----------

interface Result { id: string; run: number; ms: number; failures: string[]; output: string; raw?: string; error?: string }

async function runCase(c: Case, run: number, s: { maxTokens: number }, depth?: number): Promise<Result> {
  const t0 = Date.now();
  try {
    // Exactly what the routes and the scheduler do: per-mode tuning, and a
    // conversation sized to the context window.
    const tuning = modeTuning(c.input.mode);
    const maxTokens = c.maxTokens ?? tuning.maxTokens;
    const temperature = c.temperature ?? tuning.temperature;
    // The depth sweep re-runs the thread cases against a longer or shorter
    // conversation. Everything else about the case is unchanged, so what the
    // sweep measures is depth and nothing else.
    const thread = depth && c.input.thread ? deepThread(depth) : c.input.thread;
    const input = { ...c.input, thread, threadChars: tuning.threadChars ?? Infinity };
    // A fixed seed per run number, so a grading pass can be repeated and
    // compared: the same case in run 2 asks the model exactly what it asked
    // it in run 2 yesterday. Nothing a person triggers sets a seed — their
    // "try again" has to be able to come back different.
    const raw = await chat({ messages: buildMessages(input), maxTokens, temperature, stop: tuning.stop, seed: 1000 + run, consent: evalConsent() });
    // Exactly the shipped clean-up for this mode. `gist` does not go through
    // finalizeOutput in the product — services/summaries.ts applies
    // `tidyGist` on top of `cleanOutput` — and an eval that skipped it was
    // failing the product for a trailing full stop the product removes.
    const out = c.input.mode === 'gist'
      ? tidyGist(cleanOutput(raw, 'gist'), c.input.subject)
      : finalizeOutput(raw, c.input.mode, { recipient: c.input.recipient, senderName: c.input.senderName, senderEmail: c.input.senderEmail });
    const failures = c.checks.map((k) => k(out)).filter((x): x is string => Boolean(x));
    return { id: c.id, run, ms: Date.now() - t0, failures, output: out, raw: failures.length ? raw : undefined };
  } catch (e) {
    return { id: c.id, run, ms: Date.now() - t0, failures: [`threw: ${(e as Error).message}`], output: '', error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const patch: Record<string, unknown> = { model: MODEL, enabled: true };
  if (THINK === 'on') patch.allowThinking = true;
  if (THINK === 'off') patch.allowThinking = false;
  if (MAX_TOKENS) patch.maxTokens = MAX_TOKENS;
  await saveAiSettings(patch as any);
  const s = await getAiSettings();
  console.log(`model=${s.model} think=${s.allowThinking} max_tokens=${s.maxTokens} temp=${s.temperature} top_p=${s.topP} top_k=${s.topK} runs=${RUNS}\n`);

  const cases = ONLY.length ? CASES.filter((c) => ONLY.some((o) => c.id.includes(o) || c.tags.includes(o))) : CASES;

  // Every mode the composer can ask for has to have a case here. This is the
  // check that would have caught `gist`, `reschedule` and `nudge` shipping
  // with no live coverage at all: all three reach a person, and none of them
  // had ever been run against a model in this harness.
  const ALL_MODES: DraftInput['mode'][] = ['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish', 'quick_replies', 'gist', 'reschedule', 'nudge'];
  const covered = new Set(CASES.map((c) => c.input.mode));
  const uncovered = ALL_MODES.filter((m) => !covered.has(m));
  if (uncovered.length) console.log(`!! ${uncovered.length} mode(s) with no case at all: ${uncovered.join(', ')}\n`);

  // How big the conversation actually is, in the units the model counts in.
  // Printed because the fixture this replaced was 596 tokens and every "deep
  // thread" result measured against it was passing for the wrong reason.
  for (const n of DEPTHS.length ? DEPTHS : [24]) {
    const t = deepThread(n);
    const joined = t.map((m) => `--- From ${m.from} on ${m.date}\n${m.text}`).join('\n');
    const tok = await countTokens(joined, s.model);
    console.log(`  depth ${String(n).padStart(2)}: ${t.length} messages, ${joined.length.toLocaleString()} chars, ${tok < 0 ? '?' : tok.toLocaleString()} tokens`);
  }
  console.log('');

  const results: Result[] = [];
  // ---------- the depth sweep ----------
  if (DEPTHS.length) {
    // Only the cases whose point is the conversation. A short-thread case
    // handed a 50-message thread is not the same case any more.
    const threadCases = cases.filter((c) => c.tags.includes('thread'));
    const grid: Record<string, Record<number, string>> = {};
    for (const depth of DEPTHS) {
      sweepDepth = depth;
      for (const c of threadCases) {
        let pass = 0;
        const why = new Set<string>();
        for (let run = 1; run <= RUNS; run++) {
          const r = await runCase(c, run, s, depth);
          results.push({ ...r, id: `${c.id}@${depth}` });
          if (!r.failures.length) pass++; else for (const f of r.failures) why.add(f);
          console.log(`${r.failures.length ? 'FAIL' : 'ok  '} ${c.id}@${depth} #${run} ${(r.ms / 1000).toFixed(1)}s${r.failures.length ? '\n       ' + r.failures.join('\n       ') : ''}`);
        }
        (grid[c.id] ??= {})[depth] = `${pass}/${RUNS}`;
      }
    }
    sweepDepth = null;
    console.log('\n---- depth curve (passes out of ' + RUNS + ') ----');
    const head = DEPTHS.map((d) => String(d).padStart(5)).join('');
    console.log(`${''.padEnd(32)}${head}`);
    for (const [id, row] of Object.entries(grid)) {
      console.log(`${id.padEnd(32)}${DEPTHS.map((d) => (row[d] ?? '-').padStart(5)).join('')}`);
    }
  } else {
    for (const c of cases) {
      for (let run = 1; run <= RUNS; run++) {
        const r = await runCase(c, run, s);
        results.push(r);
        const mark = r.failures.length ? 'FAIL' : 'ok  ';
        console.log(`${mark} ${c.id} #${run} ${(r.ms / 1000).toFixed(1)}s${r.failures.length ? '\n       ' + r.failures.join('\n       ') : ''}`);
        if (r.failures.length && process.env.VERBOSE) console.log(`       --- output ---\n${r.output.split('\n').map((l) => '       | ' + l).join('\n')}`);
      }
    }
  }

  console.log('\n---- summary ----');
  const byCase = new Map<string, Result[]>();
  for (const r of results) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);
  let passedCases = 0;
  for (const [id, rs] of byCase) {
    const passes = rs.filter((r) => !r.failures.length).length;
    if (passes === rs.length) passedCases++;
    const reasons = [...new Set(rs.flatMap((r) => r.failures))];
    console.log(`${passes}/${rs.length}  ${id}${reasons.length ? '  — ' + reasons.slice(0, 3).join(' | ') : ''}`);
  }
  const totalPass = results.filter((r) => !r.failures.length).length;
  const avg = results.reduce((a, r) => a + r.ms, 0) / results.length / 1000;
  console.log(`\ncases fully green: ${passedCases}/${byCase.size}   runs passed: ${totalPass}/${results.length}   avg ${avg.toFixed(1)}s/call`);
  if (process.env.JSON_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.JSON_OUT, JSON.stringify({ model: s.model, think: s.allowThinking, maxTokens: s.maxTokens, results }, null, 2));
  }
  await pool.end();
  process.exit(totalPass === results.length ? 0 : 1);
}

void main();
