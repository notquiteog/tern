// Live model evaluation. Unlike the unit tests, this one actually talks to
// the configured model and grades what comes back, so a change to a prompt,
// a default or the clean-up pass can be judged on the thing that matters:
// whether the mail a person would send is right.
//
//   npx tsx --env-file=../.env.dev src/ai/live.eval.ts
//   MODEL=qwen3.5:4b RUNS=3 npx tsx --env-file=../.env.dev src/ai/live.eval.ts
//   ONLY=thread,name npx tsx --env-file=../.env.dev src/ai/live.eval.ts
//
// Every case is graded by a deterministic check, never by another model, so
// the pass rate means the same thing on every run.
import { chat, getAiSettings, saveAiSettings } from './llm.js';
import { buildMessages, finalizeOutput, modeTuning, threadBudgetChars, type DraftInput } from './prompts.js';
import { findTemplateArtifacts, describeHits } from './guard.js';
import { pool } from '../db.js';

const MODEL = process.env.MODEL || 'qwen3.5:4b';
const RUNS = Number(process.env.RUNS || 3);
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const THINK = process.env.THINK; // 'on' | 'off' | unset (leave the stored setting alone)
const NUM_CTX = process.env.NUM_CTX ? Number(process.env.NUM_CTX) : undefined;
const MAX_TOKENS = process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined;

// ---------- graders ----------

type Check = (out: string) => string | null; // null = pass, string = why it failed

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

const greets = (name: string): Check => (out) => {
  const l = firstLine(out);
  return new RegExp(`^(hi|hello|hey|dear)\\s+${name}\\b`, 'i').test(l) || new RegExp(`^${name}\\b`, 'i').test(l)
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

const noThinkTags: Check = (out) => (/<\/?think(ing)?>|^\s*(okay|alright),? (so|let)\b|thinking process/i.test(out) ? `reasoning leaked into the draft: "${out.slice(0, 80)}"` : null);

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

// ---------- the people in the scenarios ----------

const ALEX = { name: 'Alex Rivera', email: 'alex@brightledger.example' };
const DANA = { name: 'Dana Osei', email: 'dana@northwind.example', company: 'Northwind Supply', title: 'Head of Finance' };

// A long, detailed conversation. The facts a good reply needs are stated
// early and never repeated, which is exactly what a small context window
// throws away first.
function deepThread(n = 24): { from: string; date: string; text: string }[] {
  const A = `Alex Rivera <${ALEX.email}>`;
  const D = `Dana Osei <${DANA.email}>`;
  const M = 'Priya Raman <priya@northwind.example>';
  const base = [
    { from: D, text: `Hi Alex,\n\nWe met at the Leeds finance meetup last month. We run Northwind Supply — 42 people, three warehouses, and our books are a mess since we moved off Sage in March. Could Brightledger help?` },
    { from: A, text: `Hi Dana,\n\nGreat to hear from you. Yes — the migration off Sage is the part we do most often. Rough shape: a two week clean-up, then monthly close.` },
    { from: D, text: `That sounds right. Two constraints before we go further: our fiscal year ends 30 September, and our board meets on the second Tuesday of every month, so nothing can be in flight during that week.` },
    { from: A, text: `Understood. September year end and the second Tuesday blackout are both fine. I'll keep them in the plan.` },
    { from: D, text: `Also, Priya Raman is our financial controller and she will be your day to day contact once we start. I am copying her in from here.` },
    { from: M, text: `Hello Alex, Priya here. I own the ledger day to day. Happy to answer anything technical.` },
    { from: A, text: `Welcome Priya. First question: are the March to June entries in Sage or already exported?` },
    { from: M, text: `Exported to CSV, but the VAT codes did not come across cleanly. About 1,900 rows are affected.` },
    { from: A, text: `That is the usual failure. We remap VAT codes with a script and reconcile against the filed returns.` },
    { from: D, text: `How long does the remap take on 1,900 rows?` },
    { from: A, text: `Two days, and a third for Priya to spot check.` },
    { from: D, text: `Good. What does it cost?` },
    { from: A, text: `The clean-up is a fixed 4,800 pounds. Monthly close after that is 950 a month on a rolling three month term.` },
    { from: D, text: `Our budget holder is fine with the monthly. The 4,800 needs sign off from our MD, Tomasz.` },
    { from: A, text: `No rush. Happy to do a short call with Tomasz if that helps him decide.` },
    { from: D, text: `Let me ask him. Separately — do you support multi currency? We buy from a supplier in Poland in euros.` },
    { from: A, text: `Yes. Euro purchases are handled with a monthly revaluation at the ECB rate.` },
    { from: M, text: `That works. One more thing: we need the warehouse cost centres kept separate in the chart of accounts, not merged.` },
    { from: A, text: `Noted — three cost centres, kept separate.` },
    { from: M, text: `Thanks. I will send the CSV export tomorrow.` },
    { from: D, text: `Tomasz has approved the 4,800. We would like to start after the board meeting.` },
    { from: A, text: `Excellent news. I will draft a start plan.` },
    { from: M, text: `CSV is sent — 1,900 VAT rows as discussed, plus the euro supplier ledger.` },
    { from: D, text: `Alex — before you send the plan, can you confirm the two dates we gave you right at the start, and remind me what the monthly figure was? I want it all in one message for Tomasz.` },
  ];
  const out = base.slice(0, n);
  const start = new Date('2026-06-01T09:00:00Z');
  return out.map((m, i) => ({ from: m.from, date: new Date(start.getTime() + i * 86400_000).toDateString(), text: m.text }));
}

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
      mentionsAny(['30 september', 'september 30', '30th september', 'september'], 'the fiscal year end'),
      mentionsAny(['second tuesday', '2nd tuesday'], 'the board meeting blackout'),
      mentions(['950'], 'the monthly figure'),
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
    checks: [nonEmpty, noThinkTags, clean, greets('Dana'), greetsNobodyElse('Dana', ['Alex', 'Priya', 'Tomasz'])],
  },
  {
    id: 'reply/replying-to-priya',
    tags: ['thread', 'name'],
    input: {
      mode: 'reply',
      instruction: 'Thank her for the CSV and say you will confirm the VAT remap when it is done.',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: { name: 'Priya Raman', email: 'priya@northwind.example', company: 'Northwind Supply', title: 'Financial Controller' },
      subject: 'Northwind bookkeeping',
      thread: deepThread(23),
    },
    checks: [nonEmpty, noThinkTags, clean, greets('Priya'), greetsNobodyElse('Priya', ['Dana', 'Alex', 'Tomasz'])],
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
    checks: [linesBetween(2, 3), everyLineUnder(18), noGreetingLine, neverNames(['Dana Osei']), clean],
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
    checks: [linesBetween(2, 3), everyLineUnder(18), noGreetingLine, clean],
  },
  {
    id: 'summarize/deep-thread',
    tags: ['thread', 'summary', 'context'],
    input: {
      mode: 'summarize',
      senderName: ALEX.name, senderEmail: ALEX.email,
      thread: deepThread(24),
    },
    checks: [nonEmpty, noThinkTags, matches(/\bnext\s*:/i, 'no "Next:" line'), mentionsAny(['4,800', '4800', '950'], 'either money figure')],
  },
  {
    id: 'subject/from-draft',
    tags: ['subject'],
    input: {
      mode: 'subject',
      draft: 'Hi Dana,\n\nThanks for the CSV. The VAT remap on the 1,900 rows starts Monday and should take two days, with a third for Priya to spot check.\n\nAlex',
    },
    checks: [nonEmpty, exactlyLines(1), wordsUnder(9), matches(/^[^"']/, 'subject is quoted'), matches(/[^.!]$/, 'subject ends with punctuation')],
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
      template: 'We just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they would like a 15 minute walkthrough next week.',
      subject: 'Same-day reports',
      length: 'medium',
    },
    maxTokens: 600,
    checks: [nonEmpty, noThinkTags, clean, greets('Dana'), greetsNobodyElse('Dana', ['Alex']), mentionsAny(['walkthrough', 'walk through', '15 minute', 'fifteen minute'], 'the ask'), wordsUnder(160)],
  },
  {
    id: 'personalize/no-name',
    tags: ['campaign', 'name'],
    input: {
      mode: 'personalize',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: { email: 'accounts@westmere.example', company: 'Westmere Trading' },
      template: 'We just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they would like a 15 minute walkthrough next week.',
      length: 'short',
    },
    maxTokens: 600,
    // Company is known, the person is not: a name here would be invented.
    checks: [nonEmpty, noThinkTags, clean, greetsNoName],
  },
  {
    id: 'personalize/hostile-brief',
    tags: ['campaign', 'guard'],
    input: {
      mode: 'personalize',
      senderName: ALEX.name, senderEmail: ALEX.email,
      recipient: DANA,
      // A brief that a careless model will copy verbatim, placeholders and all.
      template: 'Tell them about our new service. Mention [product name] and say it costs [price]. Sign off as [Your Name].',
      length: 'short',
    },
    maxTokens: 600,
    // Whatever the model does, the guard must catch anything left over: this
    // case passes when the output is clean, and its failure is the point of
    // the review queue.
    checks: [nonEmpty, noThinkTags, greets('Dana')],
  },
];

// ---------- runner ----------

interface Result { id: string; run: number; ms: number; failures: string[]; output: string; raw?: string; error?: string }

async function runCase(c: Case, run: number, s: { numCtx: number; maxTokens: number }): Promise<Result> {
  const t0 = Date.now();
  try {
    // Exactly what the routes and the scheduler do: per-mode tuning, and a
    // conversation sized to the context window.
    const tuning = modeTuning(c.input.mode);
    const maxTokens = c.maxTokens ?? tuning.maxTokens;
    const temperature = c.temperature ?? tuning.temperature;
    const input = { ...c.input, threadChars: Math.min(threadBudgetChars(s.numCtx, maxTokens ?? s.maxTokens), tuning.threadChars ?? Infinity) };
    // A fixed seed per run number, so a grading pass can be repeated and
    // compared: the same case in run 2 asks the model exactly what it asked
    // it in run 2 yesterday. Nothing a person triggers sets a seed — their
    // "try again" has to be able to come back different.
    const raw = await chat({ messages: buildMessages(input), maxTokens, temperature, stop: tuning.stop, seed: 1000 + run });
    const out = finalizeOutput(raw, c.input.mode, { recipient: c.input.recipient, senderName: c.input.senderName, senderEmail: c.input.senderEmail });
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
  if (NUM_CTX) patch.numCtx = NUM_CTX;
  if (MAX_TOKENS) patch.maxTokens = MAX_TOKENS;
  await saveAiSettings(patch as any);
  const s = await getAiSettings();
  console.log(`model=${s.model} think=${s.allowThinking} num_ctx=${s.numCtx} max_tokens=${s.maxTokens} temp=${s.temperature} top_p=${s.topP} top_k=${s.topK} runs=${RUNS}\n`);

  const cases = ONLY.length ? CASES.filter((c) => ONLY.some((o) => c.id.includes(o) || c.tags.includes(o))) : CASES;
  const results: Result[] = [];
  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      const r = await runCase(c, run, s);
      results.push(r);
      const mark = r.failures.length ? 'FAIL' : 'ok  ';
      console.log(`${mark} ${c.id} #${run} ${(r.ms / 1000).toFixed(1)}s${r.failures.length ? '\n       ' + r.failures.join('\n       ') : ''}`);
      if (r.failures.length && process.env.VERBOSE) console.log(`       --- output ---\n${r.output.split('\n').map((l) => '       | ' + l).join('\n')}`);
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
    writeFileSync(process.env.JSON_OUT, JSON.stringify({ model: s.model, think: s.allowThinking, numCtx: s.numCtx, maxTokens: s.maxTokens, results }, null, 2));
  }
  await pool.end();
  process.exit(totalPass === results.length ? 0 : 1);
}

void main();
