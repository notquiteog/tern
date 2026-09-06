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
import { findTemplateArtifacts, describeHits } from './guard.js';
import { sealEmail, openEmail } from '../services/mailVault.js';
import { htmlToText } from '../services/merge.js';
import { getAccount } from '../services/accounts.js';
import { generateResponderReply } from '../workers/scheduler.js';

const RUNS = Number(process.env.RUNS || 3);
const DEPTH = Number(process.env.DEPTH || 22);
const MODEL = process.env.MODEL || 'qwen3.5:4b';

// The other side writes from a client that puts the surname first — the
// shape a responder has to survive without greeting anyone "Hi Osei,".
const THEM = { name: 'Osei, Dana', email: 'dana@northwind.example' };
const CC = { name: 'Priya Raman', email: 'priya@northwind.example' };

function conversation(us: { name: string; email: string }, n: number): { from: any; text: string }[] {
  const D = THEM, P = CC, A = { name: us.name, email: us.email };
  const base: { from: any; text: string }[] = [
    { from: D, text: 'Hi, we met at the Leeds finance meetup. Northwind Supply, 42 people, three warehouses. Our books are a mess since we came off Sage in March. Can you help?' },
    { from: A, text: 'Yes — coming off Sage is the job we do most. A two week clean-up, then monthly close.' },
    { from: D, text: 'Two things to hold on to: our fiscal year ends 30 September, and the board meets on the second Tuesday of every month, so nothing can be in flight that week.' },
    { from: A, text: 'Noted: 30 September year end, second Tuesday blackout. Both in the plan.' },
    { from: D, text: 'Priya Raman is our financial controller and will be your day to day contact. Copying her in.' },
    { from: P, text: 'Hello, Priya here. I own the ledger day to day.' },
    { from: A, text: 'Welcome Priya. Are the March to June entries still in Sage or exported?' },
    { from: P, text: 'Exported to CSV, but the VAT codes came across wrong. About 1,900 rows.' },
    { from: A, text: 'The usual failure. We remap the VAT codes and reconcile against the filed returns.' },
    { from: D, text: 'How long for 1,900 rows?' },
    { from: A, text: 'Two days, and a third for Priya to spot check.' },
    { from: D, text: 'And the cost?' },
    { from: A, text: 'The clean-up is a fixed 4,800 pounds. Monthly close after that is 950 a month, rolling three month term.' },
    { from: D, text: 'The monthly is fine. The 4,800 needs sign off from Tomasz, our MD.' },
    { from: A, text: 'No rush. Happy to speak to Tomasz if it helps.' },
    { from: D, text: 'Separately — multi currency? We buy from a supplier in Poland in euros.' },
    { from: A, text: 'Yes, euro purchases revalue monthly at the ECB rate.' },
    { from: P, text: 'Good. The three warehouse cost centres need to stay separate in the chart of accounts.' },
    { from: A, text: 'Understood, three cost centres kept separate.' },
    { from: P, text: 'Thanks. CSV export goes over tomorrow.' },
    { from: D, text: 'Tomasz has approved the 4,800. We would like to start after the board meeting.' },
    { from: A, text: 'Good news. I will draft a start plan.' },
    { from: P, text: 'CSV is sent — the 1,900 VAT rows plus the euro supplier ledger.' },
    { from: D, text: 'Before the plan goes out, can you put the two dates we gave you at the very start and the monthly figure in one message? I want to forward it to Tomasz.' },
  ];
  // Keep the opening and the closing question whatever depth is asked for.
  if (n >= base.length) return base;
  return [...base.slice(0, 4), ...base.slice(base.length - (n - 4))];
}

async function main(): Promise<void> {
  await saveAiSettings({ model: MODEL, enabled: true });
  const s = await getAiSettings();
  const accRow = await one<any>(`SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1`);
  if (!accRow) throw new Error('no account in the dev database');
  const acc = (await getAccount(accRow.id))!;
  const us = { name: acc.name, email: acc.email };
  console.log(`account ${acc.email}  model ${s.model}  num_ctx ${s.numCtx}  think ${s.allowThinking}  thread depth ${DEPTH}  runs ${RUNS}\n`);

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
  console.log(`seeded thread ${threadId}: ${msgs.length} messages, last db id ${lastId}`);

  const responder = {
    id: 0, mode: 'review', instructions: 'Answer the question in the latest message.', tone: 'friendly', length: 'medium',
    reply_all: true, humanize: true,
  };
  const email = await openEmail(acc.user_id, (await one<any>('SELECT * FROM emails WHERE id=$1', [lastId]))!);

  let pass = 0;
  for (let run = 1; run <= RUNS; run++) {
    const t0 = Date.now();
    const gen = await generateResponderReply(responder, acc, email);
    const text = gen.text;
    const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    const fails: string[] = [];

    // 1. the greeting names Dana, tidied out of "Osei, Dana"
    if (!/^(hi|hello|hey|dear)\s+dana\b/i.test(firstLine)) fails.push(`greeting: "${firstLine.slice(0, 60)}"`);
    if (/\bosei\b/i.test(firstLine.split(',')[0])) fails.push('greeting used the surname');
    // 2. the facts agreed at the start of a long thread
    const hay = text.toLowerCase();
    if (!/30 september|september 30|30th september/.test(hay)) fails.push('lost the fiscal year end');
    if (!/second tuesday|2nd tuesday/.test(hay)) fails.push('lost the board blackout');
    if (!hay.includes('950')) fails.push('lost the monthly figure');
    // 3. reply-all recipients: Dana to, Priya cc'd, never ourselves
    const addrs = gen.to.map((a) => a.email.toLowerCase());
    if (addrs[0] !== THEM.email) fails.push(`first recipient is ${addrs[0]}`);
    if (!addrs.includes(CC.email)) fails.push('reply-all did not keep Priya');
    if (addrs.includes(acc.email.toLowerCase())) fails.push('addressed to ourselves');
    // 4. the original is quoted as text, and the quote is not inspected as ours
    if (!gen.html.includes('tern-quote')) fails.push('the original was not quoted');
    if (gen.html.includes('<p>Before the plan goes out')) fails.push('the original was quoted as its own HTML');
    // 5. the guard, as send mode would run it
    const hits = findTemplateArtifacts({ subject: gen.subject, html: gen.html });
    if (hits.length) fails.push(`guard would hold this: ${describeHits(hits)}`);
    if (!/^re:/i.test(gen.subject)) fails.push(`subject is "${gen.subject}"`);

    if (!fails.length) pass++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} run ${run} ${((Date.now() - t0) / 1000).toFixed(1)}s${fails.length ? '\n      ' + fails.join('\n      ') : ''}`);
    if (fails.length || process.env.VERBOSE) console.log(text.split('\n').map((l) => '      | ' + l).join('\n'));
    if (run === 1 && !process.env.VERBOSE) console.log(`      to: ${gen.to.map((a) => a.email).join(', ')}\n      subject: ${gen.subject}\n${htmlToText(gen.html).split('\n').slice(0, 12).map((l) => '      | ' + l).join('\n')}`);
  }
  console.log(`\n${pass}/${RUNS} clean auto-replies   (thread ${threadId} left in the database)`);
  await pool.end();
  process.exit(pass === RUNS ? 0 : 1);
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
