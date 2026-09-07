// The AI responder end to end: a real thread in the mail cache, a real
// responder row, and the same `generateResponderReply` the scheduler calls.
// It checks the two things an automatic answer has to get right — who it is
// addressed to, and whether it still knows what was agreed twenty messages
// ago — plus the ones only this path has: the recipients it picks, the
// quoted original, and the guard that stands in front of send mode.
//
//   npx tsx --env-file=../.env.dev src/ai/responder.eval.ts
//   DEPTH=22 RUNS=3 npx tsx --env-file=../.env.dev src/ai/responder.eval.ts
import { one, pool, query } from '../db.js';
import { getAiSettings, saveAiSettings } from './llm.js';
import { findTemplateArtifacts, describeHits, findGreetingProblems } from './guard.js';
import { sealEmail, openEmail } from '../services/mailVault.js';
import { htmlToText } from '../services/merge.js';
import { getAccount } from '../services/accounts.js';
import { generateResponderReply } from '../workers/scheduler.js';
import { threadForCache, DANA, PRIYA, TOMASZ, maxDepth } from './fixtures.js';
import { countTokens } from './tokens.js';
import { assertUndeliverable } from './sendGuard.js';

const RUNS = Number(process.env.RUNS || 3);
const DEPTH = Number(process.env.DEPTH || 22);
const MODEL = process.env.MODEL || 'qwen3.5:4b';

// The other side writes from a client that puts the surname first — the
// shape a responder has to survive without greeting anyone "Hi Osei,".
const THEM = { name: 'Osei, Dana', email: DANA.email };
const CC = { name: PRIYA.name, email: PRIYA.email };

// The same conversation live.eval.ts uses, so a change to the fixture cannot
// improve one measurement and quietly leave the other behind. The version
// this replaced was 1,798 characters — 487 tokens over 24 messages — which
// meant the "does it still know what was agreed twenty messages ago" check
// was asking the model to recall something it could see in full.
function conversation(us: { name: string; email: string }, n: number): { from: any; text: string }[] {
  return threadForCache({ ...us, title: 'Founder', company: 'Brightledger' }, n)
    // The fixture's own display name for the other side is "Dana Osei"; the
    // responder path is specifically being tested against the surname-first
    // form a directory export produces.
    .map((m) => ({ from: m.from.email === DANA.email ? THEM : m.from, text: m.text }));
}

async function main(): Promise<void> {
  await saveAiSettings({ model: MODEL, enabled: true });
  const s = await getAiSettings();
  const accRow = await one<any>(`SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1`);
  if (!accRow) throw new Error('no account in the dev database');
  const acc = (await getAccount(accRow.id))!;
  const us = { name: acc.name, email: acc.email };
  // Nothing here is sent, but the fixture addresses are asserted
  // undeliverable rather than assumed to be.
  assertUndeliverable([THEM.email, CC.email], 'the fixture participants');
  console.log(`account ${acc.email}  model ${s.model}  num_ctx ${s.numCtx}  think ${s.allowThinking}  thread depth ${DEPTH} of ${maxDepth()}  runs ${RUNS}`);

  // ---------- seed the thread into the mail cache, sealed as sync would ----------
  const threadId = `respeval${Date.now().toString(36)}`;
  const msgs = conversation(us, DEPTH);
  const start = new Date('2026-06-01T09:00:00Z');
  let lastId = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const outbound = m.from.email === us.email;
    const to = outbound ? [THEM, CC] : [{ name: us.name, email: us.email }, ...(m.from.email === THEM.email ? [CC] : [THEM])];
    const sealed = await sealEmail(acc.user_id, {
      subject: 'Northwind Supply — coming off Sage',
      preview: m.text.slice(0, 120),
      body_text: m.text,
      body_html: `<p>${m.text}</p>`,
      from_addr: [m.from], to_addr: to, cc_addr: [], bcc_addr: [], reply_to: [],
      attachments: [],
    });
    const row = await one<{ id: number }>(
      `INSERT INTO emails (account_id, jmap_id, thread_id, mailbox_ids, keywords, size, received_at, sent_at, message_id, subject, preview, body_text, body_html,
                           from_addr, to_addr, cc_addr, bcc_addr, reply_to, attachments, search_terms, address_terms, from_terms, sealed)
       VALUES ($1,$2,$3,'{}','{}',$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true)
       ON CONFLICT DO NOTHING RETURNING id`,
      [acc.id, `${threadId}-${i}`, threadId, m.text.length, new Date(start.getTime() + i * 86400_000), [`<${threadId}-${i}@probe.test>`],
       sealed.subject, sealed.preview, sealed.body_text, sealed.body_html, sealed.from_addr, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.reply_to,
       sealed.attachments, sealed.search_terms, sealed.address_terms, sealed.from_terms],
    );
    if (row) lastId = row.id;
  }
  const joined = msgs.map((m) => m.text).join('\n');
  console.log(`seeded thread ${threadId}: ${msgs.length} messages, ${joined.length.toLocaleString()} chars, ${await countTokens(joined, s.model)} tokens, last db id ${lastId}`);

  const responder = {
    id: 0, mode: 'review', instructions: 'Answer the question in the latest message.', tone: 'friendly', length: 'medium',
    reply_all: true, humanize: true,
  };
  const email = await openEmail(acc.user_id, 'ai.responders', (await one<any>('SELECT * FROM emails WHERE id=$1', [lastId]))!);

  // Named checks, so a failure says which promise broke rather than only that
  // one did — the same shape live.eval.ts and campaign.eval.ts use.
  const CHECKS: { id: string; why: (g: Awaited<ReturnType<typeof generateResponderReply>>) => string | null }[] = [
    {
      id: 'greeting/uses-the-given-name',
      why: (g) => {
        const l = g.text.split('\n').map((x) => x.trim()).find(Boolean) ?? '';
        if (!/^(hi|hello|hey|dear)\s+dana(?!\p{L})/iu.test(l)) return `greeting is "${l.slice(0, 60)}"`;
        return /\bosei\b/i.test(l.split(',')[0]) ? 'greeting used the surname' : null;
      },
    },
    // Tomasz is named throughout the conversation and quoted below the fold,
    // and has never written a message. Greeting him is the failure a long
    // thread invites; so is greeting Priya, who wrote three of the last six.
    { id: 'greeting/nobody-else', why: (g) => { const h = findGreetingProblems(g.text, { first: 'Dana', forbidden: [TOMASZ.name, PRIYA.name] }); return h.length ? describeHits(h) : null; } },
    { id: 'recall/fiscal-year-end', why: (g) => (/30 september|september 30|30th september/i.test(g.text) ? null : 'lost the fiscal year end') },
    { id: 'recall/board-blackout', why: (g) => (/second tuesday|2nd tuesday/i.test(g.text) ? null : 'lost the board blackout') },
    { id: 'recall/monthly-figure', why: (g) => (g.text.includes('950') ? null : 'lost the monthly figure') },
    // Stated at message 14 and reversed at message 21. Getting it backwards is
    // a different failure from forgetting it: "Tomasz still needs to sign off"
    // is confidently, specifically wrong about the state of the deal.
    { id: 'recall/not-superseded', why: (g) => (/\b(?:needs?|awaiting|pending|require[sd]?)\b[^.]{0,40}\b(?:sign[- ]?off|approval|approve)/i.test(g.text) ? 'says the £4,800 still needs approval; it was approved' : null) },
    { id: 'facts/invents-nothing', why: (g) => { const h = findTemplateArtifacts({ subject: g.subject, html: g.html, specifics: g.guard.specifics }); const bad = h.filter((x) => x.kind.startsWith('invented') || x.kind === 'false_attachment'); return bad.length ? describeHits(bad) : null; } },
    { id: 'recipients/to-is-the-writer', why: (g) => (g.to.map((a) => a.email.toLowerCase())[0] === THEM.email ? null : `first recipient is ${g.to[0]?.email}`) },
    { id: 'recipients/reply-all-keeps-cc', why: (g) => (g.to.map((a) => a.email.toLowerCase()).includes(CC.email) ? null : 'reply-all did not keep Priya') },
    { id: 'recipients/never-ourselves', why: (g) => (g.to.map((a) => a.email.toLowerCase()).includes(acc.email.toLowerCase()) ? 'addressed to ourselves' : null) },
    { id: 'quote/original-included', why: (g) => (g.html.includes('tern-quote') ? null : 'the original was not quoted') },
    { id: 'quote/not-as-its-own-html', why: (g) => (/<p>Before you send the start plan/.test(g.html) ? 'the original was quoted as its own HTML' : null) },
    { id: 'guard/would-not-be-held', why: (g) => { const h = findTemplateArtifacts({ subject: g.subject, html: g.html, ...g.guard }); return h.length ? `send mode would hold this: ${describeHits(h)}` : null; } },
    { id: 'subject/is-a-reply', why: (g) => (/^re:/i.test(g.subject) ? null : `subject is "${g.subject}"`) },
  ];

  const byCase = new Map<string, number>();
  let pass = 0;
  for (let run = 1; run <= RUNS; run++) {
    const t0 = Date.now();
    const gen = await generateResponderReply(responder, acc, email);
    const text = gen.text;
    const fails: string[] = [];
    for (const c of CHECKS) {
      const why = c.why(gen);
      if (why) fails.push(`${c.id}: ${why}`);
      else byCase.set(c.id, (byCase.get(c.id) ?? 0) + 1);
    }

    if (!fails.length) pass++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} run ${run} ${((Date.now() - t0) / 1000).toFixed(1)}s${fails.length ? '\n      ' + fails.join('\n      ') : ''}`);
    if (fails.length || process.env.VERBOSE) console.log(text.split('\n').map((l) => '      | ' + l).join('\n'));
    if (run === 1 && !process.env.VERBOSE) console.log(`      to: ${gen.to.map((a) => a.email).join(', ')}\n      subject: ${gen.subject}\n${htmlToText(gen.html).split('\n').slice(0, 12).map((l) => '      | ' + l).join('\n')}`);
  }

  console.log('\n---- per check ----');
  for (const c of CHECKS) console.log(`${byCase.get(c.id) ?? 0}/${RUNS}  ${c.id}`);
  console.log(`\n${pass}/${RUNS} clean auto-replies   (thread ${threadId} left in the database)`);
  await pool.end();
  process.exit(pass === RUNS ? 0 : 1);
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
