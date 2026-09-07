// The AI features that do not write prose.
//
//   npx tsx --env-file=../.env.dev src/ai/structured.eval.ts
//   MODEL=phi4:14b RUNS=20 ONLY=intent npx tsx --env-file=../.env.dev src/ai/structured.eval.ts
//
// live.eval.ts grades the composer, the responder and the campaigns — every
// path whose output is an email. These are the other five, and until now not
// one of them had a live case: commitment extraction, plain-English rules,
// plain-English search, reply classification and the brief's paragraph.
//
// They are graded harder than the prose ones, because they can be. Each
// produces a structure with a right answer: a rule either has the right
// condition or it does not, a search query either uses a real operator or it
// searches for the operator as literal text, a label is either on the list or
// it is not. Nothing here is a matter of taste, so nothing here is graded by
// another model.
import { evalConsent } from './evalConsent.js';
import { chat, getAiSettings, saveAiSettings } from './llm.js';
import { pool } from '../db.js';
import { buildCommitmentMessages, parseCommitments, type ParsedCommitment } from '../services/commitments.js';
import { buildRuleMessages, buildSearchMessages, cleanQuery, parseRule, type DraftRule } from '../services/nlRules.js';
import { deterministicIntent, parseIntent, ROUTE_OF, type ReplyIntent } from '../services/replyIntent.js';
import { tidyParagraph } from '../services/brief.js';
import { realisticThread, ALEX, DANA, PRIYA } from './fixtures.js';

const MODEL = process.env.MODEL || 'qwen3.5:4b';
const RUNS = Number(process.env.RUNS || 10);
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const NUM_CTX = process.env.NUM_CTX ? Number(process.env.NUM_CTX) : undefined;
const THINK = process.env.THINK;

interface Case {
  id: string;
  tags: string[];
  /** Runs the real shipped path and returns whatever failed, empty when clean. */
  run: () => Promise<string[]>;
}

const fail = (...why: (string | null)[]) => why.filter((w): w is string => Boolean(w));

// ---------- commitment extraction ----------
//
// The thread is the shared fixture, so what is being asked is "out of a real
// 24-message conversation, which sentences were promises?" — with a known
// answer: Alex owes a start plan, Priya owed a CSV export (and sent it), and
// nobody promised anything on a date more than two years out.
function commitmentLines(n: number): string[] {
  const mine = ALEX.email.toLowerCase();
  return realisticThread(n).map((m) => {
    const who = m.who.email.toLowerCase() === mine ? 'THE USER' : m.who.name;
    return `--- ${who}, ${m.date}\n${m.text.replace(/^\s*>.*$/gm, '').trim().slice(0, 1500)}`;
  });
}

async function extractCommitments(): Promise<ParsedCommitment[]> {
  const raw = await chat({
    messages: buildCommitmentMessages(ALEX.email, 'Northwind Supply — coming off Sage', commitmentLines(24)),
    maxTokens: 500, temperature: 0.1, noThink: true, consent: evalConsent(),
  });
  return parseCommitments(raw);
}

// ---------- reply classification ----------
//
// A labelled corpus. This is the gap named in the last report: the five
// model-decided labels had no test because there was no corpus, so here is
// one — replies in the shapes a campaign actually gets back, each with the
// label a person would give it.
const REPLIES: { text: string; want: ReplyIntent; note: string }[] = [
  { want: 'interested', note: 'plain yes', text: 'Yes, this sounds useful. Could you send over some times for next week? Happy to do 15 minutes.' },
  { want: 'interested', note: 'yes, buried under politeness', text: 'Thanks for getting in touch. We have been meaning to sort our month end out for a while, so yes — I would be interested in seeing how it works. Who would be the right person your end to set something up with?' },
  { want: 'question', note: 'a specific question', text: 'Before we go further — does this work with Sage 50, or only the cloud version? That is the thing that has stopped us before.' },
  { want: 'question', note: 'pricing question', text: 'What does it actually cost once the free period ends? I would need a number before I could take it anywhere internally.' },
  { want: 'not_interested', note: 'polite decline', text: 'Thanks for thinking of us, but we are happy with our current accountants and are not looking to change.' },
  { want: 'not_interested', note: 'blunt decline', text: 'Not for us.' },
  { want: 'not_now', note: 'defer with a reason', text: 'We are in the middle of our year end so this is terrible timing. Could you come back to me in the new year? Genuinely interested, just not now.' },
  { want: 'not_now', note: 'defer, vague', text: 'Leave it with me for a few months — too much on at the moment.' },
  { want: 'wrong_person', note: 'points at somebody else', text: 'I am not the right person for this I am afraid, I look after the warehouse. You want Priya Raman, she does the ledger.' },
  { want: 'wrong_person', note: 'no longer here', text: 'Dana left the company in March. I would try the general finance address.' },
  // These two never reach the model: they are decided in code.
  { want: 'stop', note: 'unsubscribe', text: 'Please stop emailing me. Take me off your list.' },
  { want: 'auto_reply', note: 'out of office', text: 'I am out of the office until 14 September with limited access to email. For anything urgent please contact Priya.' },
];

// ---------- the cases ----------

const CASES: Case[] = [
  {
    id: 'commitments/finds-the-real-ones',
    tags: ['commitments'],
    run: async () => {
      const got = await extractCommitments();
      const all = got.map((c) => `${c.kind}:${c.what}`).join(' | ').toLowerCase();
      return fail(
        got.length === 0 ? 'found nothing in a thread full of promises' : null,
        got.length > 8 ? `found ${got.length} commitments; a 24-message thread does not contain that many` : null,
        // The start plan is the clearest owed item in the conversation.
        // Tomasz asked for sign-off at message 14 and gave it at message 21.
        // Listing it as outstanding is a ledger entry that is not true, which
        // is worse than a missing one: every entry then has to be checked.
        /sign[- ]?off|approv/i.test(all) && /awaiting/.test(all) ? `lists a settled item as outstanding: ${all.slice(0, 120)}` : null,
        !got.some((c) => c.kind === 'owed') ? `found nothing the user owes, in a thread where they promised a start plan (found: ${all.slice(0, 120)})` : null,
        // Every item has to be a sentence, not a fragment or a whole paragraph.
        got.some((c) => c.what.length < 6) ? 'produced a fragment' : null,
        got.some((c) => c.what.length > 200) ? 'produced a paragraph rather than an item' : null,
      );
    },
  },
  {
    id: 'commitments/dates-are-plausible',
    tags: ['commitments'],
    run: async () => {
      const got = await extractCommitments();
      const now = Date.now();
      return fail(
        // cleanDue already drops anything out of range; this asserts it is
        // actually doing so rather than that the model behaved.
        ...got.filter((c) => c.due).map((c) => {
          const t = new Date(c.due!).getTime();
          const days = (t - now) / 86_400_000;
          return days < -2 || days > 730 ? `due date ${c.due} is ${Math.round(days)} days away` : null;
        }),
        got.some((c) => c.who && c.who.length > 120) ? 'counterparty is a paragraph' : null,
        got.some((c) => c.who && /^(the user|me|you|unknown|n\/a)$/i.test(c.who)) ? 'counterparty is a placeholder' : null,
      );
    },
  },
  {
    id: 'commitments/kinds-are-the-right-way-round',
    tags: ['commitments'],
    run: async () => {
      const got = await extractCommitments();
      // Alex is THE USER. The start plan is something Alex owes; the CSV was
      // something Alex was waiting on. Getting these backwards turns the
      // ledger into a list of other people's problems.
      const plan = got.find((c) => /plan/i.test(c.what));
      return fail(
        plan && plan.kind !== 'owed' ? `the start plan is marked "${plan.kind}"; Alex promised it` : null,
        got.every((c) => c.kind === 'owed') && got.length > 2 ? 'every item is "owed"; the model is not distinguishing' : null,
      );
    },
  },
  {
    id: 'rules/archive-from-sender',
    tags: ['rules'],
    run: async () => {
      const labels = [{ id: 'l1', name: 'Finance' }, { id: 'l2', name: 'Newsletters' }];
      const raw = await chat({ messages: buildRuleMessages(labels, 'archive anything from noreply@shipping.example'), maxTokens: 400, temperature: 0.1, noThink: true, consent: evalConsent() });
      let r: DraftRule;
      try { r = parseRule(raw, labels); } catch (e) { return [`did not parse: ${(e as Error).message}`]; }
      return fail(
        !r.conditions.some((c) => c.field === 'from' && String(c.value ?? '').includes('noreply@shipping.example')) ? `no condition on the sender: ${JSON.stringify(r.conditions)}` : null,
        !r.actions.some((a) => a.type === 'archive') ? `no archive action: ${JSON.stringify(r.actions)}` : null,
        r.actions.some((a) => a.type === 'trash' || a.type === 'spam') ? 'added a destructive action nobody asked for' : null,
      );
    },
  },
  {
    id: 'rules/label-by-subject',
    tags: ['rules'],
    run: async () => {
      const labels = [{ id: 'l1', name: 'Finance' }, { id: 'l2', name: 'Newsletters' }];
      const raw = await chat({ messages: buildRuleMessages(labels, 'label emails with invoice in the subject as Finance and mark them read'), maxTokens: 400, temperature: 0.1, noThink: true, consent: evalConsent() });
      let r: DraftRule;
      try { r = parseRule(raw, labels); } catch (e) { return [`did not parse: ${(e as Error).message}`]; }
      const label = r.actions.find((a) => a.type === 'label');
      return fail(
        !r.conditions.some((c) => c.field === 'subject' && /invoice/i.test(String(c.value ?? ''))) ? `no subject condition: ${JSON.stringify(r.conditions)}` : null,
        !label ? 'no label action' : null,
        // The label has to be one that exists. A rule pointing at a mailbox
        // id the server does not have is a rule that silently does nothing.
        label && label.mailboxId !== 'l1' ? `label points at "${label.mailboxId}", not the Finance mailbox` : null,
        !r.actions.some((a) => a.type === 'mark_read') ? 'dropped "mark them read"' : null,
      );
    },
  },
  {
    id: 'rules/vague-sentence-stays-safe',
    tags: ['rules'],
    run: async () => {
      const labels = [{ id: 'l1', name: 'Finance' }];
      const raw = await chat({ messages: buildRuleMessages(labels, 'make my inbox nicer'), maxTokens: 400, temperature: 0.1, noThink: true, consent: evalConsent() });
      // A vague sentence is allowed to produce a guess: what comes back is a
      // *draft* the person confirms before it is saved, so an interpretation
      // is useful and a refusal is only correct when there is nothing to
      // interpret. What is not allowed is a draft that is invalid or
      // destructive — a rule pointing at a label that does not exist does
      // nothing silently, and one that trashes mail from a sentence this
      // vague is not something to put in front of somebody to click Save on.
      let r: DraftRule;
      try { r = parseRule(raw, labels); } catch { return []; }
      const label = r.actions.find((a) => a.type === 'label');
      return fail(
        r.actions.some((a) => a.type === 'trash' || a.type === 'spam') ? `invented a destructive action from "make my inbox nicer": ${JSON.stringify(r.actions)}` : null,
        label && label.mailboxId !== 'l1' ? `label points at "${label.mailboxId}", which is not a mailbox this account has` : null,
        !r.conditions.length ? 'a rule with no condition can never match anything' : null,
      );
    },
  },
  {
    id: 'search/uses-real-operators',
    tags: ['search'],
    run: async () => {
      const raw = await chat({ messages: buildSearchMessages('unread emails from dana last week with an attachment'), maxTokens: 120, temperature: 0.1, noThink: true, consent: evalConsent() });
      const q = cleanQuery(raw);
      return fail(
        !q ? 'produced nothing usable' : null,
        !/from:/i.test(q) ? `no from: operator in "${q}"` : null,
        !/is:unread/i.test(q) ? `no is:unread in "${q}"` : null,
        !/has:attachment/i.test(q) ? `no has:attachment in "${q}"` : null,
        q.length > 120 ? `query is ${q.length} chars; it is a sentence, not a query` : null,
        // cleanQuery drops unknown operators, so anything with a colon that
        // survived is real. A leftover would be searched for as literal text.
        /\b(?:before|after|older|newer|size|attachment):/i.test(q) && !/^(?:newer_than|older_than|larger):/i.test(q) ? `invented an operator: "${q}"` : null,
      );
    },
  },
  {
    id: 'search/plain-words-stay-plain',
    tags: ['search'],
    run: async () => {
      const raw = await chat({ messages: buildSearchMessages('the vat remap conversation'), maxTokens: 120, temperature: 0.1, noThink: true, consent: evalConsent() });
      const q = cleanQuery(raw);
      return fail(
        !q ? 'produced nothing usable' : null,
        !/vat|remap/i.test(q) ? `lost the actual words: "${q}"` : null,
        q.split(/\s+/).length > 8 ? `${q.split(/\s+/).length} tokens for a three-word search: "${q}"` : null,
      );
    },
  },
  {
    id: 'brief/paragraph-is-a-paragraph',
    tags: ['brief'],
    run: async () => {
      // The brief hands the model facts it has already computed and asks only
      // for the sentence at the top. The failure is it re-rendering the list.
      const facts = [
        'Needs a reply: Dana Osei — asked you to confirm the two dates and the monthly figure',
        'Needs a reply: Priya Raman — sent the CSV export, four files',
        'You owe: a start plan for Northwind, promised yesterday',
        'Waiting on: Tomasz Nowak — nothing outstanding, he approved the £4,800',
        'Can be cleared in one action: 34 newsletters',
      ].join('\n');
      const raw = await chat({
        messages: [
          { role: 'system', content: 'You write the one-paragraph summary at the top of a daily briefing. Two or three sentences, plain and specific, in the second person. No lists, no headings, no greeting.' },
          { role: 'user', content: `Today is ${new Date().toDateString()}.\n\n${facts}` },
        ],
        maxTokens: 220, temperature: 0.3, noThink: true, consent: evalConsent(),
      });
      const p = tidyParagraph(raw);
      return fail(
        !p ? 'produced nothing' : null,
        p.split('\n').filter((l) => l.trim()).length > 1 ? 'wrote more than one paragraph' : null,
        /^[-*•\d]/.test(p.trim()) ? 'wrote a list' : null,
        p.split(/\s+/).length > 90 ? `${p.split(/\s+/).length} words; it is meant to be two or three sentences` : null,
        !/dana|priya|northwind|plan/i.test(p) ? 'named nothing from the facts it was given' : null,
      );
    },
  },
];

// The reply corpus becomes one case per reply, so a failure says which shape
// of reply was misread rather than that the classifier scored 8 out of 12.
for (const r of REPLIES) {
  CASES.push({
    id: `intent/${r.want}-${r.note.replace(/[^a-z]+/gi, '-').toLowerCase()}`,
    tags: ['intent'],
    run: async () => {
      const certain = deterministicIntent({ text: r.text });
      if (certain) {
        return fail(certain !== r.want ? `decided "${certain}" in code, expected "${r.want}"` : null);
      }
      if (r.want === 'stop' || r.want === 'auto_reply') return [`"${r.want}" must be decided in code and was not`];
      const raw = await chat({
        messages: [
          { role: 'system', content: [
            'You label a reply to a sales email. Answer with one word from this list and nothing else:',
            '',
            'interested — they want to talk, or ask for a call, demo or more detail',
            'question — they ask something specific that needs an answer',
            'not_now — interested but say later, or ask to be contacted at another time',
            'not_interested — they decline',
            'wrong_person — it is not their area, they point at somebody else, or that person has left',
            '',
            'If none of them clearly fits, answer: unclear',
            'Answer with the single word only. No punctuation, no explanation.',
          ].join('\n') },
          { role: 'user', content: `Subject: Same-day bookkeeping reports\n\n${r.text}` },
        ],
        maxTokens: 8, temperature: 0, noThink: true, consent: evalConsent(),
      });
      const got = parseIntent(raw);
      return fail(
        got !== r.want ? `read as "${got}", expected "${r.want}" (routes to ${ROUTE_OF[got]} instead of ${ROUTE_OF[r.want]})` : null,
      );
    },
  });
}

// ---------- runner ----------

async function main(): Promise<void> {
  const patch: Record<string, unknown> = { model: MODEL, enabled: true };
  if (THINK === 'on') patch.allowThinking = true;
  if (THINK === 'off') patch.allowThinking = false;
  if (NUM_CTX) patch.numCtx = NUM_CTX;
  await saveAiSettings(patch as never);
  const s = await getAiSettings();
  console.log(`model=${s.model} num_ctx=${s.numCtx} think=${s.allowThinking} runs=${RUNS}\n`);

  const cases = ONLY.length ? CASES.filter((c) => ONLY.some((o) => c.id.includes(o) || c.tags.includes(o))) : CASES;
  const score = new Map<string, { pass: number; total: number; why: Set<string>; ms: number }>();
  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      const t0 = Date.now();
      let why: string[];
      try { why = await c.run(); } catch (e) { why = [`threw: ${(e as Error).message}`]; }
      const rec = score.get(c.id) ?? { pass: 0, total: 0, why: new Set<string>(), ms: 0 };
      rec.total++; rec.ms += Date.now() - t0;
      if (!why.length) rec.pass++; else for (const w of why) rec.why.add(w);
      score.set(c.id, rec);
      if (process.env.VERBOSE) console.log(`${why.length ? 'FAIL' : 'ok  '} ${c.id} #${run}${why.length ? '  ' + why.join(' | ') : ''}`);
    }
    const r = score.get(c.id)!;
    console.log(`${r.pass === r.total ? 'ok  ' : 'FAIL'} ${r.pass}/${r.total}  ${c.id}  ${(r.ms / r.total / 1000).toFixed(1)}s${r.why.size ? '\n       ' + [...r.why].slice(0, 3).join('\n       ') : ''}`);
  }

  console.log('\n---- summary ----');
  const byTag = new Map<string, { pass: number; total: number }>();
  for (const c of cases) {
    const r = score.get(c.id)!;
    const tag = c.tags[0];
    const t = byTag.get(tag) ?? { pass: 0, total: 0 };
    t.pass += r.pass; t.total += r.total;
    byTag.set(tag, t);
  }
  for (const [tag, t] of byTag) console.log(`${String(t.pass).padStart(4)}/${String(t.total).padEnd(4)} ${tag}  (${Math.round((t.pass / t.total) * 100)}%)`);
  const green = [...score.values()].filter((r) => r.pass === r.total).length;
  const runs = [...score.values()].reduce((a, r) => a + r.pass, 0);
  const total = [...score.values()].reduce((a, r) => a + r.total, 0);
  console.log(`\ncases fully green: ${green}/${score.size}   runs passed: ${runs}/${total}`);
  if (process.env.JSON_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.JSON_OUT, JSON.stringify({ model: s.model, cases: [...score].map(([id, r]) => ({ id, pass: r.pass, total: r.total, why: [...r.why] })) }, null, 2));
  }
  await pool.end();
  process.exit(green === score.size ? 0 : 1);
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
