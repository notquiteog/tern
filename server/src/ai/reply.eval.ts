import { evalConsent } from './evalConsent.js';
// Replies, graded out of ten, on every path a person can ask for one.
//
// The report behind this: "when replying to a message ... it completely bugs
// out spitting out gibberish, it looks like it's pulling data from other email
// threads". Neither of the other live evaluations could have caught it.
// live.eval.ts builds its prompts from fixtures in memory, so the thread a
// reply is written from can never be the wrong one; and it never goes near the
// assistant, which is where most of the damage turned out to be.
//
// This one seeds a whole mailbox — five detailed conversations and two pieces
// of marketing mail, each carrying words that belong to it alone (see
// ai/replyFixtures.ts) — into the real mail cache, sealed as sync would, and
// asks for a reply to each conversation three ways:
//
//   composer   the AI panel's Reply: the route's own thread loader, prompt,
//              per-mode tuning and clean-up
//   assistant  "draft a reply to this" in a fresh assistant conversation with
//              the thread open — the real tool loop and the real draft_email
//   carryover  the same, in a conversation whose previous question was about
//              the newsletter, which is how one thread leaked into another
//
// Every draft is scored out of ten by ai/grade.ts — deterministically; the
// rubric is there — and the report gives X/10 per run, the mean and the worst
// per case, and which points went. A run that is garbled, borrows words from
// another conversation or is filed against the wrong one is a failure whatever
// it scored.
//
//   npx tsx --env-file=../.env.dev src/ai/reply.eval.ts
//   MODEL=qwen3:4b RUNS=2 npx tsx --env-file=../.env.dev src/ai/reply.eval.ts
//   ONLY=assistant,offer THINK=on VERBOSE=1 npx tsx --env-file=../.env.dev src/ai/reply.eval.ts
//
// With THINK=on the model's working-out is collected on every run and printed
// for any run that lost points: why a reply went wrong is usually sitting in
// what the model told itself on the way there.
//
// Settings it changes (MODEL, THINK, MAX_TOKENS) are put back when it
// finishes, and the mail and conversations it seeded are deleted unless KEEP=1.
import { one, pool, query } from '../db.js';
import { chat, getAiSettings, saveAiSettings, type AiSettings } from './llm.js';
import { buildMessages, finalizeOutput, modeTuning, type DraftInput } from './prompts.js';
import { sealEmail } from '../services/mailVault.js';
import { htmlToText } from '../services/merge.js';
import { getAccount } from '../services/accounts.js';
import { threadForDraft } from '../services/draftThread.js';
import { runAgent } from './agent.js';
import { appendMessage, createConversation } from './conversation.js';
import { gradeReply, type Grade } from './grade.js';
import { MAILBOX, REPLY_THREADS, renderThread, threadText, type DetailedThread } from './replyFixtures.js';
import { assertUndeliverable } from './sendGuard.js';

const RUNS = Number(process.env.RUNS || 3);
const MIN_MEAN = Number(process.env.MIN_MEAN || 8);
const MIN_RUN = Number(process.env.MIN_RUN || 6);
const PATHS = ['composer', 'assistant', 'carryover'] as const;
type Path = typeof PATHS[number];
// ONLY takes path names and thread ids, in any mix: "assistant,offer".
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const onlyPaths = ONLY.filter((o) => (PATHS as readonly string[]).includes(o));
const onlyThreads = ONLY.filter((o) => !(PATHS as readonly string[]).includes(o));

interface Outcome { draft: string | null; said: string; tools: string[]; thinking: string; ms: number; filedIn?: string | null; error?: string }
interface Result { path: Path; thread: string; run: number; grade: Grade; outcome: Outcome }

async function main(): Promise<void> {
  const before = await getAiSettings();
  const patch: Partial<AiSettings> = {};
  if (process.env.MODEL) patch.model = process.env.MODEL;
  if (process.env.THINK === 'on' || process.env.THINK === 'off') patch.allowThinking = process.env.THINK === 'on';
  if (process.env.MAX_TOKENS) patch.maxTokens = Number(process.env.MAX_TOKENS);
  // The assistant's eighteen tool schemas take about 4,400 tokens of the
  // window before anybody says anything, so the window is worth varying.
  if (Object.keys(patch).length) await saveAiSettings(patch);
  const s = await getAiSettings();

  const accRow = await one<any>('SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1');
  if (!accRow) throw new Error('no account in the dev database');
  const acc = (await getAccount(accRow.id))!;
  const me = { name: acc.name, email: acc.email };
  // Refuses to run on a production install, and does so before a single
  // message is seeded rather than at the first generation.
  evalConsent(acc.user_id);
  // Nothing here is sent, but the fixture addresses are asserted
  // undeliverable rather than assumed to be.
  const everyone = MAILBOX.flatMap((t) => renderThread(t, me).flatMap((m) => [m.from, ...m.to, ...m.cc]));
  assertUndeliverable([...new Set(everyone.map((p) => p.email).filter((e) => e !== me.email))], 'the fixture mailbox');

  console.log(`account ${acc.email}  model ${s.model}  think ${s.allowThinking}  max_tokens ${s.maxTokens || 'uncapped'}  presence ${s.presencePenalty}  runs ${RUNS}\n`);

  // ---------- the mailbox, sealed as sync would seal it ----------
  const tag = `replyeval${Date.now().toString(36)}`;
  const threadIds = new Map<string, string>();
  for (const t of MAILBOX) {
    const threadId = `${tag}-${t.id}`;
    threadIds.set(t.id, threadId);
    for (const [i, m] of renderThread(t, me).entries()) {
      const sealed = await sealEmail(acc.user_id, {
        subject: i ? `Re: ${t.subject}` : t.subject,
        preview: (m.text || htmlToText(m.html)).slice(0, 120),
        body_text: m.text, body_html: m.html,
        from_addr: [m.from], to_addr: m.to, cc_addr: m.cc, bcc_addr: [], reply_to: [], attachments: [],
      });
      await query(
        `INSERT INTO emails (account_id, jmap_id, thread_id, mailbox_ids, keywords, size, received_at, sent_at, message_id, subject, preview, body_text, body_html,
                             from_addr, to_addr, cc_addr, bcc_addr, reply_to, attachments, search_terms, address_terms, from_terms, sealed)
         VALUES ($1,$2,$3,'{}','{}',$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true) ON CONFLICT DO NOTHING`,
        [acc.id, `${threadId}-${i}`, threadId, (m.text || m.html).length, m.at, [`<${threadId}-${i}@probe.test>`],
         sealed.subject, sealed.preview, sealed.body_text, sealed.body_html, sealed.from_addr, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.reply_to,
         sealed.attachments, sealed.search_terms, sealed.address_terms, sealed.from_terms],
      );
    }
    console.log(`seeded ${t.id.padEnd(10)} ${renderThread(t, me).length} message(s), ${threadText(t, me).length.toLocaleString()} chars`);
  }
  console.log('');

  const conversations: number[] = [];

  // ---------- the three ways of asking ----------

  async function composer(t: DetailedThread, run: number): Promise<Outcome> {
    const task = t.task!;
    const tuning = modeTuning('reply');
    const { thread } = await threadForDraft(acc.user_id, acc.id, threadIds.get(t.id)!);
    const input: DraftInput = {
      mode: 'reply', instruction: task.instruction, length: task.length ?? 'medium',
      senderName: acc.name, senderEmail: acc.email,
      recipient: { name: task.recipient.name, email: task.recipient.email },
      subject: `Re: ${t.subject}`, thread, systemPrompt: s.systemPrompt, voice: acc.voice,
      threadChars: tuning.threadChars ?? Infinity,
    };
    let thinking = '';
    const t0 = Date.now();
    const raw = await chat({
      messages: buildMessages(input), maxTokens: tuning.maxTokens, temperature: tuning.temperature, stop: tuning.stop,
      seed: 1000 + run, owner: acc.user_id, onThinking: (p) => { thinking += p; },
      // The composer's own gate, since that is the path being measured.
      consent: { ...evalConsent(acc.user_id), capability: 'ai.compose' },
    });
    const draft = finalizeOutput(raw, 'reply', { recipient: input.recipient, senderName: input.senderName, senderEmail: input.senderEmail });
    return { draft, said: '', tools: [], thinking, ms: Date.now() - t0 };
  }

  async function ask(conversationId: number, message: string, threadId: string): Promise<Outcome> {
    await appendMessage(acc.user_id, conversationId, { role: 'user', content: message });
    const out: Outcome = { draft: null, said: '', tools: [], thinking: '', ms: 0 };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 300_000);
    const t0 = Date.now();
    try {
      for await (const ev of runAgent({
        userId: acc.user_id, conversationId, view: { thread: { accountId: acc.id, threadId } },
        signal: abort.signal, onThinking: (p) => { out.thinking += p; },
      })) {
        if (ev.type === 'token') out.said += ev.text;
        if (ev.type === 'tool' && ev.state === 'running') out.tools.push(ev.name);
        if (ev.type === 'saved' && ev.proposal?.kind === 'draft') { out.draft = ev.proposal.body; out.filedIn = ev.proposal.threadId; }
      }
    } finally {
      clearTimeout(timer);
      out.ms = Date.now() - t0;
    }
    return out;
  }

  async function assistant(t: DetailedThread, carry: boolean): Promise<Outcome> {
    const target = threadIds.get(t.id)!;
    const conversationId = await createConversation(acc.user_id, 'reply evaluation');
    conversations.push(conversationId);
    if (carry) await ask(conversationId, 'What is this offer about, and is the discount worth it?', threadIds.get('newsletter')!);
    const out = await ask(conversationId, `Draft a reply to this. ${t.task!.instruction}`, target);
    // A draft proposed for some other thread would open in the wrong
    // conversation; report which one by its fixture name.
    if (out.filedIn && out.filedIn !== target) out.filedIn = [...threadIds].find(([, v]) => v === out.filedIn)?.[0] ?? out.filedIn;
    else out.filedIn = null;
    return out;
  }

  // ---------- run and grade ----------

  const results: Result[] = [];
  const paths = PATHS.filter((p) => !onlyPaths.length || onlyPaths.includes(p));
  const threads = REPLY_THREADS.filter((t) => !onlyThreads.length || onlyThreads.includes(t.id));
  try {
    for (const t of threads) {
      const foreignMarks = MAILBOX.filter((o) => o.id !== t.id).flatMap((o) => o.marks);
      for (const path of paths) {
        for (let run = 1; run <= RUNS; run++) {
          let outcome: Outcome;
          try {
            outcome = path === 'composer' ? await composer(t, run) : await assistant(t, path === 'carryover');
          } catch (e) {
            outcome = { draft: null, said: '', tools: [], thinking: '', ms: 0, error: (e as Error).message };
          }
          const grade = gradeReply({ draft: outcome.draft, task: t.task!, threadText: threadText(t, me), foreignMarks, extraFacts: t.task!.instruction, wrongThread: outcome.filedIn });
          if (outcome.error) grade.critical.unshift(`threw: ${outcome.error}`);
          results.push({ path, thread: t.id, run, grade, outcome });
          report(results[results.length - 1]!);
        }
      }
    }
  } finally {
    if (!process.env.KEEP) {
      if (conversations.length) {
        await query('DELETE FROM ai_messages WHERE conversation_id = ANY($1)', [conversations]);
        await query('DELETE FROM ai_conversations WHERE id = ANY($1)', [conversations]);
      }
      await query('DELETE FROM emails WHERE account_id=$1 AND jmap_id LIKE $2', [acc.id, `${tag}%`]);
    }
    if (Object.keys(patch).length) {
      const restore: Partial<AiSettings> = {};
      for (const k of Object.keys(patch) as (keyof AiSettings)[]) (restore as any)[k] = before[k];
      await saveAiSettings(restore);
    }
  }

  // ---------- the summary ----------
  const cell = (path: Path, thread: string) => {
    const rs = results.filter((r) => r.path === path && r.thread === thread);
    if (!rs.length) return { text: '-', mean: 10, worst: 10, critical: 0 };
    const scores = rs.map((r) => r.grade.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const worst = Math.min(...scores);
    const critical = rs.filter((r) => r.grade.critical.length).length;
    return { text: `${mean.toFixed(1)} / ${worst}${critical ? ` !${critical}` : ''}`, mean, worst, critical };
  };
  console.log(`\n---- X/10: mean / worst of ${RUNS} run(s), !n = runs with a critical failure ----`);
  console.log(`${''.padEnd(12)}${paths.map((p) => p.padStart(16)).join('')}`);
  let failed = false;
  for (const t of threads) {
    const cells = paths.map((p) => cell(p, t.id));
    for (const c of cells) if (c.mean < MIN_MEAN || c.worst < MIN_RUN || c.critical) failed = true;
    console.log(`${t.id.padEnd(12)}${cells.map((c) => c.text.padStart(16)).join('')}`);
  }
  const all = results.map((r) => r.grade.score);
  console.log(`\noverall ${(all.reduce((a, b) => a + b, 0) / Math.max(1, all.length)).toFixed(2)}/10 over ${all.length} replies`);

  console.log('\n---- where the points went ----');
  const byCriterion = new Map<string, { lost: number; runs: number; why: Set<string> }>();
  for (const r of results) for (const c of r.grade.criteria) {
    if (c.points >= c.max) continue;
    const e = byCriterion.get(c.id) ?? { lost: 0, runs: 0, why: new Set<string>() };
    e.lost += c.max - c.points; e.runs += 1; if (c.why) e.why.add(`${r.path}/${r.thread}: ${c.why}`);
    byCriterion.set(c.id, e);
  }
  if (!byCriterion.size) console.log('nothing lost');
  for (const [id, e] of [...byCriterion].sort((a, b) => b[1].lost - a[1].lost)) {
    console.log(`${id.padEnd(16)} -${e.lost} over ${e.runs} run(s)`);
    for (const w of [...e.why].slice(0, 4)) console.log(`${''.padEnd(18)}${w.slice(0, 160)}`);
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: every case needs a mean of ${MIN_MEAN}+, no run under ${MIN_RUN}, and no critical failure`);

  if (process.env.JSON_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.JSON_OUT, JSON.stringify({ model: s.model, think: s.allowThinking, maxTokens: s.maxTokens, results }, null, 2));
  }
  await pool.end();
  process.exit(failed ? 1 : 0);
}

function report(r: Result): void {
  const { grade: g, outcome: o } = r;
  const lost = g.criteria.filter((c) => c.points < c.max);
  console.log(`${String(g.score).padStart(4)}/10  ${r.path.padEnd(9)} ${r.thread.padEnd(10)} #${r.run}  ${(o.ms / 1000).toFixed(1)}s${o.tools.length ? `  tools: ${o.tools.join(', ')}` : ''}`);
  for (const c of g.critical) console.log(`          !! ${c.slice(0, 200)}`);
  for (const c of lost) console.log(`          -${c.max - c.points} ${c.id}: ${(c.why ?? '').slice(0, 200)}`);
  const poor = g.score < MIN_RUN || g.critical.length > 0;
  if (poor || process.env.VERBOSE) {
    const shown = o.draft ?? (o.said.trim() ? `(no draft; the assistant said:)\n${o.said.trim()}` : '(nothing)');
    console.log(shown.slice(0, 1800).split('\n').map((l) => `          | ${l}`).join('\n'));
    if (o.thinking && (poor || lost.length)) {
      console.log(`          --- thinking (${o.thinking.length.toLocaleString()} chars) ---`);
      console.log(o.thinking.slice(0, 1500).split('\n').map((l) => `          : ${l}`).join('\n'));
    }
  }
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
