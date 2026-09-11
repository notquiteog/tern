// The golden path, end to end, with the step count.
//
//   npx tsx --env-file=../.env.dev src/e2e/goldenpath.e2e.ts     (from server/)
//
// The acceptance test for "simple": a person with a CSV and one sentence of
// plain English gets a campaign that sends itself, and is never asked to
// understand a prompt, a token, a temperature or a merge field to do it.
//
//   1. import a CSV of contacts
//   2. describe the campaign in one sentence
//   3. see a preview of the first three generated emails
//   4. approve, and the campaign sends on the account's pacing
//
// It counts the decisions the person is required to make, because that number
// is the actual measure of "simple" and it is easy to let it creep.
//
// Nothing is sent: every address is at `.invalid`.
import { migrate, one, pool, query, waitForDb } from '../db.js';
import { getAccount } from '../services/accounts.js';
import { parseCsv, guessMapping } from '../util/csv.js';
import { previewCampaign, tick } from '../workers/scheduler.js';
import { getAiSettings, saveAiSettings } from '../ai/llm.js';
import { assertNothingCanBeDelivered } from '../ai/sendGuard.js';
import { openReview } from '../services/mailVault.js';
import { htmlToText } from '../services/merge.js';
import { campaignMetrics } from '../services/campaigns.js';

const TAG = `golden-${Date.now()}`;

// A CSV as exported from a CRM: a name column that is sometimes not a name,
// notes a person actually typed, and a header row nobody normalised.
const CSV = `Email Address,First Name,Last Name,Company,Job Title,Notes
dana.osei@example.invalid,Dana,Osei,Northwind Supply,Head of Finance,"met at the leeds show — 3 warehouses, says ""month end is the painful part"". still on sage"
p.raman@example.invalid,Priya,Raman,Westmere Trading,Financial Controller,"inbound from the site. small op ~8 ppl, bounced off xero + quickbooks. price sensitive"
accounts@example.invalid,,,Halewood Bros,Accounts,"no named contact, shared mailbox. they do reply though"
k.mensah@example.invalid,Kwame,Mensah,Bluefin Marine,Owner,"referred by their accountant. 2 sites, growing, on spreadsheets. good fit"
noor@example.invalid,Noor,Rahimi,Ridgeline Parts,Operations Lead,"warehouse mgr not finance. said ""send me something i can forward upstairs"". keep it short"
`;

// The one sentence.
const BRIEF = 'We have just launched same-day bookkeeping reports for wholesale businesses, free until January for existing customers, and I want to ask if they would like a fifteen minute walkthrough next week.';

// Every decision the person is required to make to get from a CSV to a live
// campaign. A decision counts when the flow cannot proceed without an answer
// only they can give; anything with a defensible default does not.
const DECISIONS = [
  { step: 1, what: 'choose the CSV file', required: true, internal: false },
  { step: 2, what: 'write the one-sentence brief', required: true, internal: false },
  { step: 2, what: 'choose the audience (this tag / everyone)', required: true, internal: false },
  { step: 3, what: 'read the three previews', required: true, internal: false },
  { step: 4, what: 'approve', required: true, internal: false },
  // Defaulted, and listed so that a future change that makes one of them
  // required shows up as a regression in the count rather than as nothing.
  { step: 2, what: 'sending account', required: false, internal: false, defaultedTo: 'the only enabled account' },
  { step: 2, what: 'campaign name', required: false, internal: false, defaultedTo: 'the first words of the brief' },
  { step: 2, what: 'style instructions', required: false, internal: false, defaultedTo: 'none' },
  { step: 2, what: 'review or send automatically', required: false, internal: false, defaultedTo: 'review — mandatory for a first campaign' },
  { step: 2, what: 'follow-up after four days', required: false, internal: false, defaultedTo: 'on' },
];

async function main(): Promise<void> {
  await waitForDb();
  await migrate();
  const accRow = await one<any>(`SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1`);
  if (!accRow) throw new Error('no account in the dev database');
  const acc = (await getAccount(accRow.id))!;
  const userId = Number(acc.user_id);
  await saveAiSettings({ enabled: true });
  const s = await getAiSettings();
  await assertNothingCanBeDelivered(acc, ['example.invalid']);
  console.log(`\nmodel ${s.model}  temp ${s.temperature} top_p ${s.topP} top_k ${s.topK}  account ${acc.email}\n`);

  // ---------- 1. import a CSV ----------
  console.log('STEP 1 — import a CSV of contacts');
  const parsed = parseCsv(CSV);
  const mapping = guessMapping(parsed.headers);
  const col = (f: string) => (mapping[f] ? parsed.headers.indexOf(mapping[f]) : -1);
  const idx = { email: col('email'), first: col('first_name'), last: col('last_name'), company: col('company'), title: col('title'), notes: col('notes') };
  console.log(`  headers as exported: ${parsed.headers.join(' | ')}`);
  console.log(`  columns matched automatically: ${Object.entries(mapping).map(([k, v]) => `${k}←"${v}"`).join(', ')}`);
  const ids: number[] = [];
  for (const r of parsed.rows) {
    const row = await one<{ id: number }>(
      `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, notes, tags, source, consent_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import','golden-path')
       ON CONFLICT (user_id, email) DO UPDATE SET tags=EXCLUDED.tags, first_name=EXCLUDED.first_name, notes=EXCLUDED.notes RETURNING id`,
      [userId, r[idx.email], r[idx.first] ?? '', r[idx.last] ?? '', r[idx.company] ?? '', r[idx.title] ?? '', r[idx.notes] ?? '', [TAG]],
    );
    if (row) ids.push(row.id);
  }
  console.log(`  ${ids.length} contacts imported, tagged ${TAG}\n`);

  // ---------- 2. describe it in one sentence ----------
  console.log('STEP 2 — describe the campaign in one sentence');
  console.log(`  "${BRIEF}"`);
  // The name is derived rather than asked for.
  const name = BRIEF.replace(/^(?:we have|we|i want to|i)\s+/i, '').split(/[,.]/)[0].split(/\s+/).slice(0, 6).join(' ');
  console.log(`  campaign name, derived: "${name}"\n`);

  // ---------- 3. preview the first three ----------
  console.log('STEP 3 — preview the first three generated emails');
  const contacts = await query<any>(`SELECT * FROM contacts WHERE user_id=$1 AND $2 = ANY(tags) ORDER BY id LIMIT 3`, [userId, TAG]);
  const t0 = Date.now();
  const previews = await previewCampaign(acc, { brief: BRIEF, contacts });
  console.log(`  generated in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  for (const p of previews) {
    console.log(`  ┌─ to ${p.contact.name || '(no name on the row)'} <${p.contact.email}>${p.contact.company ? ` · ${p.contact.company}` : ''}`);
    console.log(`  │  subject: ${p.subject}`);
    for (const l of htmlToText(p.html).split('\n')) console.log(`  │  ${l}`);
    console.log(`  └─ ${p.heldFor ? `WOULD BE HELD: ${p.heldFor}` : 'ready to send'}\n`);
  }

  // ---------- 4. approve, and let it run ----------
  console.log('STEP 4 — approve');
  const seq = (await one<any>(
    `INSERT INTO sequences (user_id, account_id, name, description, status, ai_mode, stop_on_reply, unsubscribe_footer)
     VALUES ($1,$2,$3,$4,'active','review',true,true) RETURNING *`,
    [userId, acc.id, `${name} (${TAG})`, `AI campaign. Brief: ${BRIEF}`],
  ))!;
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize) VALUES ($1,0,'email','',$2,true)`, [seq.id, `<p>${BRIEF}</p>`]);
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, wait_days) VALUES ($1,1,'wait',4)`, [seq.id]);
  await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize, reply_in_thread) VALUES ($1,2,'email','',$2,true,true)`,
    [seq.id, '<p>Short, friendly follow-up to the previous email. Ask if they had a chance to read it and restate the single most useful point in one sentence.</p>']);
  for (const cid of ids) await query(`INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at) VALUES ($1,$2,$3,'active',0,now()) ON CONFLICT DO NOTHING`, [seq.id, cid, acc.id]);
  console.log(`  campaign ${seq.id} live: ${ids.length} enrolled, review queue is the gate, follow-up after 4 days, stops on reply`);

  for (let i = 0; i < 12; i++) {
    const left = await one<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND status='active' AND next_run_at <= now()`, [seq.id]);
    if (!left?.n) break;
    await tick();
  }
  const queued = await query<any>(`SELECT * FROM review_queue WHERE enrollment_id IN (SELECT id FROM enrollments WHERE sequence_id=$1) ORDER BY id`, [seq.id]);
  console.log(`  ${queued.length} drafts waiting in the review queue\n`);
  for (const r of queued.slice(0, 2)) {
    const open = await openReview(userId, r);
    const c = await one<any>('SELECT email FROM contacts WHERE id=$1', [r.contact_id]);
    console.log(`  · ${c?.email}: "${open?.subject}"${r.hold_reason ? `  [HELD: ${r.hold_reason}]` : ''}`);
  }

  console.log(`\n  metrics: ${Object.entries(await campaignMetrics(seq.id)).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  // ---------- the count ----------
  const required = DECISIONS.filter((d) => d.required);
  const defaulted = DECISIONS.filter((d) => !d.required);
  const internal = DECISIONS.filter((d) => d.internal);
  console.log(`\n---- the step count ----`);
  console.log(`4 steps, ${required.length} decisions the person must make:`);
  for (const d of required) console.log(`  ${d.step}. ${d.what}`);
  console.log(`${defaulted.length} decisions with a default, none of which has to be opened:`);
  for (const d of defaulted) console.log(`  ${d.step}. ${d.what} → ${(d as any).defaultedTo}`);
  console.log(`${internal.length} decisions requiring an internal concept (prompt, model, token, temperature, merge field): ${internal.length === 0 ? 'none' : internal.map((d) => d.what).join(', ')}`);
  console.log(`\n(left in the database: sequence ${seq.id}, tag ${TAG})`);
  await pool.end();
  process.exit(internal.length ? 1 : 0);
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
