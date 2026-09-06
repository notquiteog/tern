// End-to-end run of the mass-generation flow: a CSV of contacts becomes an
// AI campaign, the scheduler writes a different email for every one of them,
// the guard holds back anything unfit, and the approved ones leave through
// the account's pacing rather than all at once.
//
//   npx tsx --env-file=../.env.dev src/ai/campaign.eval.ts
//   N=12 MODE=auto npx tsx --env-file=../.env.dev src/ai/campaign.eval.ts
//
// It uses the real import parser, the real sequence tables and the real
// scheduler tick, so what it measures is the flow a person actually gets.
// Nothing is sent: the account is pointed at a JMAP URL that does not
// answer, so an auto campaign's sends fail at the transport and everything
// up to that point is still exercised.
import { one, pool, query } from '../db.js';
import { parseCsv, guessMapping } from '../util/csv.js';
import { getAiSettings, saveAiSettings } from './llm.js';
import { findTemplateArtifacts, describeHits } from './guard.js';
import { openReview } from '../services/mailVault.js';
import { htmlToText } from '../services/merge.js';
import { isWindowOpen, jitterMs, reserveSendSlot } from '../services/sending.js';
import { getAccount } from '../services/accounts.js';
import { tick } from '../workers/scheduler.js';

const N = Number(process.env.N || 8);
const MODE = (process.env.MODE || 'review') as 'review' | 'auto';
const MODEL = process.env.MODEL || 'qwen3.5:4b';
const TAG = `campaign-eval-${Date.now()}`;

const FIRST = ['Dana', 'Priya', 'Tomasz', 'Mariam', 'Noor', 'Kwame', 'Ines', 'Yuki', 'Farid', 'Beatriz', 'Oleg', 'Aroha'];
const LAST = ['Osei', 'Raman', 'Nowak', 'Haddad', 'Rahimi', 'Mensah', 'Sousa', 'Tanaka', 'Karimi', 'Alves', 'Petrov', 'Ngata'];
const CO = ['Northwind Supply', 'Westmere Trading', 'Kestrel Foods', 'Harbour Tools', 'Ridgeline Parts', 'Bluefin Marine', 'Oakhill Textiles', 'Cardo Freight', 'Lyra Optics', 'Pennine Plastics', 'Vela Logistics', 'Fernbank Timber'];
const TITLE = ['Head of Finance', 'Financial Controller', 'Managing Director', 'Operations Lead', 'Finance Manager', 'Owner'];

function csvFor(n: number): string {
  const rows = [['email', 'first name', 'last name', 'company', 'job title', 'notes']];
  for (let i = 0; i < n; i++) {
    const f = FIRST[i % FIRST.length], l = LAST[i % LAST.length];
    rows.push([
      `${f.toLowerCase()}.${l.toLowerCase()}${i}@example.invalid`,
      f, l, CO[i % CO.length], TITLE[i % TITLE.length],
      // A note with a comma and a quote, because a real export has them.
      `Met at the Leeds show; runs ${1 + (i % 4)} warehouses, says "the month end is the painful part".`,
    ]);
  }
  return rows.map((r) => r.map((c) => (/[",\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
}

const BRIEF = `We have just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they would like a 15 minute walkthrough next week.`;

async function main(): Promise<void> {
  await saveAiSettings({ model: MODEL, enabled: true });
  const s = await getAiSettings();

  const acc = await one<any>(`SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1`);
  if (!acc) throw new Error('no account in the dev database');
  const userId = Number(acc.user_id);
  console.log(`account ${acc.email} (user ${userId})  model ${s.model}  mode ${MODE}  contacts ${N}`);
  console.log(`pacing: cap ${acc.daily_cap}/day, jitter ${acc.jitter_enabled ? `${acc.jitter_min_s}-${acc.jitter_max_s}s` : 'off'}, window ${acc.send_window?.start ?? '-'}-${acc.send_window?.end ?? '-'} ${acc.send_window?.tz ?? ''} (open now: ${isWindowOpen(acc.send_window)})\n`);

  // ---------- 1. the CSV, through the real parser and mapping guesser ----------
  const csv = csvFor(N);
  const parsed = parseCsv(csv);
  const mapping = guessMapping(parsed.headers);
  console.log(`1. CSV: ${parsed.rows.length} rows, delimiter ${JSON.stringify(parsed.delimiter)}`);
  console.log(`   headers ${parsed.headers.join(' | ')}`);
  console.log(`   guessed mapping ${JSON.stringify(mapping)}`);
  // guessMapping answers field -> header; the importer then reads that column.
  const col = (field: string) => (mapping[field] ? parsed.headers.indexOf(mapping[field]) : -1);
  const idx = { email: col('email'), first_name: col('first_name'), last_name: col('last_name'), company: col('company'), title: col('title'), notes: col('notes') };
  if (idx.email < 0) throw new Error(`the mapping guesser did not find an email column: ${JSON.stringify(mapping)}`);
  if (idx.first_name < 0) console.log('   ! no first-name column was guessed — every greeting would be "Hi there,"');

  const contactIds: number[] = [];
  for (const r of parsed.rows) {
    const row = await one<{ id: number }>(
      `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, notes, tags, source, consent_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import','eval')
       ON CONFLICT (user_id, email) DO UPDATE SET tags=EXCLUDED.tags RETURNING id`,
      [userId, r[idx.email], r[idx.first_name] ?? '', r[idx.last_name] ?? '', r[idx.company] ?? '', r[idx.title] ?? '', r[idx.notes] ?? '', [TAG]],
    );
    if (row) contactIds.push(row.id);
  }
  console.log(`   imported ${contactIds.length} contacts, tagged ${TAG}\n`);

  // ---------- 2. the campaign the UI builds ----------
  const seq = (await one<any>(
    `INSERT INTO sequences (user_id, account_id, name, description, status, ai_mode, stop_on_reply, unsubscribe_footer) VALUES ($1,$2,$3,$4,'active',$5,true,true) RETURNING *`,
    [userId, acc.id, `Eval campaign ${TAG}`, `AI campaign. Brief: ${BRIEF}`, MODE],
  ))!;
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize, ai_instructions) VALUES ($1,0,'email','',$2,true,$3)`,
    [seq.id, `<p>${BRIEF}</p>`, 'Under 110 words, no exclamation marks.']);
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, wait_days) VALUES ($1,1,'wait',4)`, [seq.id]);
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize, ai_instructions, reply_in_thread) VALUES ($1,2,'email','',$2,true,$3,true)`,
    [seq.id, '<p>Short, friendly follow-up to the previous email. Ask if they had a chance to read it and restate the single most useful point in one sentence.</p>', 'Under 110 words, no exclamation marks.']);
  for (const cid of contactIds) {
    await query(`INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at) VALUES ($1,$2,$3,'active',0,now()) ON CONFLICT (sequence_id, contact_id) DO NOTHING`, [seq.id, cid, acc.id]);
  }
  console.log(`2. campaign ${seq.id} live, ${contactIds.length} enrolled, ai_mode=${MODE}\n`);

  // ---------- 3. generation, one scheduler tick at a time ----------
  console.log('3. generating…');
  const t0 = Date.now();
  for (let pass = 1; pass <= 12; pass++) {
    const left = await one<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND status='active' AND next_run_at <= now()`, [seq.id]);
    if (!left?.n) break;
    await tick();
    const done = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND created_at > to_timestamp($2)`, [userId, t0 / 1000]);
    process.stdout.write(`   pass ${pass}: ${done?.n ?? 0} generated (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  const secs = (Date.now() - t0) / 1000;

  // ---------- 4. what came out ----------
  const rows = await query<any>(`SELECT * FROM review_queue WHERE user_id=$1 AND created_at > to_timestamp($2) ORDER BY id`, [userId, t0 / 1000]);
  const items = [];
  for (const r of rows) items.push({ row: r, open: (await openReview(userId, r))! });
  console.log(`\n4. ${items.length} emails in ${secs.toFixed(0)}s (${(secs / Math.max(1, items.length)).toFixed(1)}s each)`);

  const byContact = new Map(contactIds.map((id) => [id, null as any]));
  let greetedRight = 0, greetedWrong: string[] = [], held: string[] = [], duplicates = 0;
  const bodies = new Set<string>();
  for (const { row, open } of items) {
    const c = await one<any>('SELECT * FROM contacts WHERE id=$1', [row.contact_id]);
    byContact.set(row.contact_id, open);
    const text = htmlToText(open.body_html ?? '');
    const firstLine = text.split('\n').map((l: string) => l.trim()).find(Boolean) ?? '';
    const first = String(c?.first_name ?? '').trim();
    if (first && new RegExp(`^(hi|hello|hey|dear)\\s+${first}\\b`, 'i').test(firstLine)) greetedRight++;
    else greetedWrong.push(`${c?.email}: "${firstLine.slice(0, 50)}" (expected ${first})`);
    if (row.hold_reason) held.push(`${c?.email}: ${row.hold_reason}`);
    const key = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (bodies.has(key)) duplicates++;
    bodies.add(key);
    // The guard runs again here on what is stored, as the send path would.
    const hits = findTemplateArtifacts({ subject: open.subject, html: open.body_html });
    if (hits.length && !row.hold_reason) held.push(`${c?.email}: NOT HELD but ${describeHits(hits)}`);
  }
  console.log(`   greeting names the right person: ${greetedRight}/${items.length}`);
  for (const w of greetedWrong.slice(0, 6)) console.log(`   ! ${w}`);
  console.log(`   held by the guard: ${held.length}`);
  for (const h of held.slice(0, 6)) console.log(`   ! ${h}`);
  console.log(`   identical bodies (personalisation failed): ${duplicates}`);
  const missing = [...byContact.entries()].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.log(`   ! ${missing.length} contacts produced nothing`);
  if (items[0]) console.log(`\n   --- sample ---\n${htmlToText(items[0].open.body_html ?? '').split('\n').map((l: string) => '   | ' + l).join('\n')}`);

  // ---------- 5. the delay before anything leaves ----------
  console.log('\n5. send pacing');
  const a = (await getAccount(acc.id))!;
  const gaps = Array.from({ length: 8 }, () => Math.round(jitterMs(a) / 1000));
  console.log(`   randomised gaps between sends (s): ${gaps.join(', ')}`);
  const slot = await reserveSendSlot(a);
  console.log(`   next slot: ${slot.ok ? `allowed, wait ${Math.round(slot.waitMs / 1000)}s` : `refused (${slot.reason}), retry ${slot.retryAt.toISOString()}`}`);
  const outbox = await query<any>(`SELECT status, count(*)::int AS n FROM outbox WHERE user_id=$1 GROUP BY status`, [userId]);
  console.log(`   outbox: ${outbox.map((o: any) => `${o.status}=${o.n}`).join(', ') || 'empty'}`);
  const cap = a.daily_cap, avgGap = (a.jitter_enabled ? (a.jitter_min_s + a.jitter_max_s) / 2 : 0);
  console.log(`   at cap ${cap}/day and an average ${avgGap}s gap, ${items.length} approved emails would take about ${((items.length * avgGap) / 60).toFixed(0)} minutes to leave, over ${Math.ceil(items.length / Math.max(1, cap))} day(s)`);

  const enr = await query<any>(`SELECT status, count(*)::int AS n FROM enrollments WHERE sequence_id=$1 GROUP BY status`, [seq.id]);
  console.log(`\n   enrollments: ${enr.map((e: any) => `${e.status}=${e.n}`).join(', ')}`);
  console.log(`\n(left in the database: sequence ${seq.id}, tag ${TAG})`);
  await pool.end();
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
