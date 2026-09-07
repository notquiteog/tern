// End-to-end run of the mass-generation flow: a CSV of contacts becomes an
// AI campaign, the scheduler writes a different email for every one of them,
// the guard holds back anything unfit, and the approved ones leave through
// the account's pacing rather than all at once.
//
//   npx tsx --env-file=../.env.dev src/ai/campaign.eval.ts
//   N=12 RUNS=2 MODE=auto npx tsx --env-file=../.env.dev src/ai/campaign.eval.ts
//   ONLY=isolation,name npx tsx --env-file=../.env.dev src/ai/campaign.eval.ts
//
// It uses the real import parser, the real sequence tables and the real
// scheduler tick, so what it measures is the flow a person actually gets.
//
// Nothing is sent. Every contact is at `.invalid`, which RFC 6761 guarantees
// can never resolve, and `assertNothingCanBeDelivered` asserts that before
// anything runs — the previous version of this file relied on the dev JMAP
// URL not answering, which is a coincidence rather than a safeguard and is
// false whenever the dev mail server happens to be up.
import { one, pool, query } from '../db.js';
import { parseCsv, guessMapping } from '../util/csv.js';
import { getAiSettings, saveAiSettings } from './llm.js';
import { findTemplateArtifacts, describeHits, findGreetingProblems } from './guard.js';
import { openReview } from '../services/mailVault.js';
import { htmlToText } from '../services/merge.js';
import { isWindowOpen, jitterMs, reserveSendSlot } from '../services/sending.js';
import { getAccount } from '../services/accounts.js';
import { tick, campaignRecipient } from '../workers/scheduler.js';
import { assertNothingCanBeDelivered } from './sendGuard.js';
import { firstNameOf } from './names.js';
import { campaignMetrics } from '../services/campaigns.js';

const N = Number(process.env.N || 8);
const RUNS = Number(process.env.RUNS || 1);
const MODE = (process.env.MODE || 'review') as 'review' | 'auto';
const MODEL = process.env.MODEL || 'qwen3.5:4b';
const ONLY = new Set((process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean));

// ---------- the audience ----------
//
// Real CRM rows, which means the name column is not always a name. Every
// awkward shape here is one ai/names.ts has to resolve or refuse, and the
// campaign has to greet correctly or neutrally — never with a guess.
interface Row { email: string; first: string; last: string; company: string; title: string; notes: string; expect: string }

// Notes as a person actually types them into a CRM: lower case, abbreviated,
// half a sentence, a stray quote, a fact that matters buried in the middle.
// The old fixture had one tidy clause, which is not what the model meets.
const NOTES = [
  `met at the leeds show — runs 3 whs, says "month end is the painful part". uses sage still (!). wants to talk again after their yr end but cant remember when that is. NB do not cc her boss`,
  `inbound from the website form. small op, maybe 8 ppl. mentioned they'd looked at xero + quickbooks and bounced off both. price sensitive i think. follow up w/ case study?`,
  `intro'd by Dana at northwind. hasnt replied to 2 emails. might be the wrong addr - check w/ dana before chasing again. seemed keen on the phone in march`,
  `long-standing. renewed last yr no fuss. finance lead changed in feb (new person = Ines?) so relationship needs rebuilding. do NOT assume they remember us`,
  `warehouse mgr not finance — wrong contact really but he's the one who replies. said "send me something i can forward upstairs". keep it short, he wont read past para 2`,
  `ex-customer, left in 2024 over an invoicing mess that was arguably our fault. worth a careful re-approach. absolutely do not mention the old ticket`,
  `trade show scan, barely qualified. no idea if they even do their own books. treat as cold`,
  `refered by their accountant. 2 sites, growing fast, currently on spreadsheets which is why the accountant is worried. good fit. timing: after april`,
];

function audience(n: number): Row[] {
  const people: [string, string, string][] = [
    ['Dana', 'Osei', 'Northwind Supply'], ['Priya', 'Raman', 'Westmere Trading'], ['Tomasz', 'Nowak', 'Kestrel Foods'],
    ['Mariam', 'Haddad', 'Harbour Tools'], ['Noor', 'Rahimi', 'Ridgeline Parts'], ['Kwame', 'Mensah', 'Bluefin Marine'],
    ['Ines', 'Sousa', 'Oakhill Textiles'], ['Yuki', 'Tanaka', 'Cardo Freight'], ['Farid', 'Karimi', 'Lyra Optics'],
    ['Beatriz', 'Alves', 'Pennine Plastics'], ['Oleg', 'Petrov', 'Vela Logistics'], ['Aroha', 'Ngata', 'Fernbank Timber'],
  ];
  const titles = ['Head of Finance', 'Financial Controller', 'Managing Director', 'Operations Lead', 'Finance Manager', 'Owner'];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const [f, l, co] = people[i % people.length];
    rows.push({
      email: `${f.toLowerCase()}.${l.toLowerCase()}${i}@example.invalid`,
      first: f, last: l, company: co, title: titles[i % titles.length],
      notes: NOTES[i % NOTES.length], expect: f,
    });
  }
  // The rows a real import actually contains, appended so they are always
  // present whatever N is. Each one is a shape the greeting must survive.
  const awkward: Row[] = [
    // A blank name column: the commonest malformed export there is.
    { email: 'accounts0@example.invalid', first: '', last: '', company: 'Halewood Bros', title: 'Accounts', notes: NOTES[0], expect: '' },
    // A placeholder the exporting system left behind.
    { email: 'placeholder0@example.invalid', first: '{{first_name}}', last: '', company: 'Trent Valley Supplies', title: '', notes: NOTES[1], expect: '' },
    // The company in the first-name column, from a one-column "Account name".
    { email: 'company0@example.invalid', first: 'Marchmont Wholesale', last: '', company: 'Marchmont Wholesale', title: '', notes: NOTES[2], expect: '' },
    // Surname first, which every directory export produces.
    { email: 'surname0@example.invalid', first: '', last: '', company: 'Ashgrove Foods', title: 'Owner', notes: NOTES[3], expect: 'John', nameOverride: 'SMITH, JOHN' } as Row & { nameOverride?: string },
    // A login in the name column.
    { email: 'login0@example.invalid', first: 'dana.osei0', last: '', company: 'Brightwater Ltd', title: '', notes: NOTES[4], expect: '' },
    // A role address with no person behind it.
    { email: 'noreply0@example.invalid', first: 'Accounts', last: 'Team', company: 'Kingsley Packaging', title: '', notes: NOTES[5], expect: '' },
  ];
  return [...rows, ...awkward];
}

function csvFor(rows: Row[]): string {
  const out = [['email', 'first name', 'last name', 'company', 'job title', 'notes']];
  for (const r of rows) {
    const over = (r as Row & { nameOverride?: string }).nameOverride;
    out.push([r.email, over ?? r.first, r.last, r.company, r.title, r.notes]);
  }
  return out.map((r) => r.map((c) => (/[",\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
}

const BRIEF = `We have just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they would like a 15 minute walkthrough next week.`;

// ---------- graders ----------
//
// One named check per promise, so a run says which promise broke. Every one
// is deterministic and none of them asks another model for an opinion.
interface Item { email: string; row: any; contact: any; subject: string; text: string }
interface Case { id: string; note: string; run: (items: Item[]) => string[] }

const failuresOf = (items: Item[], f: (i: Item) => string | null): string[] =>
  items.map((i) => { const why = f(i); return why ? `${i.email}: ${why}` : ''; }).filter(Boolean);

const CASES: Case[] = [
  {
    id: 'name/greets-the-right-person',
    note: 'the salutation names the contact, or nobody when the row has no usable name',
    run: (items) => failuresOf(items, (i) => {
      const want = firstNameOf(campaignRecipient({ name: 'Alex Rivera', email: 'alex@brightledger.example' } as any, i.contact).full);
      const hits = findGreetingProblems(i.text, { first: want, forbidden: ['Alex Rivera'] });
      return hits.length ? describeHits(hits) : null;
    }),
  },
  {
    id: 'name/never-invents-one',
    note: 'a row with a blank, placeholder or role name gets a neutral greeting, never a guess',
    run: (items) => failuresOf(items, (i) => {
      const want = campaignRecipient({ name: 'Alex Rivera', email: 'alex@brightledger.example' } as any, i.contact);
      if (want.first) return null;
      const line = i.text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      const hits = findGreetingProblems(i.text, { first: '' });
      return hits.length ? `${describeHits(hits)} — "${line.slice(0, 50)}"` : null;
    }),
  },
  {
    id: 'isolation/no-other-contact-leaks-in',
    note: 'one contact\'s name, company or notes never appear in another contact\'s email',
    // The failure mode that destroys trust fastest, and the one a batch
    // generator is uniquely able to commit: a shared prompt, a cached
    // completion, or a model that remembers the previous row.
    run: (items) => {
      const out: string[] = [];
      for (const i of items) {
        const hay = `${i.subject}\n${i.text}`.toLowerCase();
        for (const other of items) {
          if (other.email === i.email) continue;
          // This contact's own material, which includes their notes: a CRM
          // note that says "intro'd by Dana at Northwind" makes Dana a
          // legitimate thing to mention in *this* person's email, and
          // counting it as a leak from the contact who happens to be called
          // Dana would be measuring the fixture rather than the code.
          const own = `${i.contact.first_name ?? ''} ${i.contact.last_name ?? ''} ${i.contact.company ?? ''} ${i.contact.title ?? ''} ${i.contact.notes ?? ''}`.toLowerCase();
          for (const [what, value] of [['first name', other.contact.first_name], ['company', other.contact.company]] as [string, string][]) {
            const v = String(value ?? '').trim().toLowerCase();
            // Only distinctive values, and never one this contact shares.
            if (v.length < 4 || own.includes(v)) continue;
            if (new RegExp(`(?<!\\p{L})${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u').test(hay)) {
              out.push(`${i.email}: contains ${other.email}'s ${what} "${value}"`);
            }
          }
        }
      }
      return [...new Set(out)];
    },
  },
  {
    id: 'facts/invents-nothing',
    note: 'no figure, date or term that is not in the brief or the contact\'s own fields',
    run: (items) => failuresOf(items, (i) => {
      const facts = [BRIEF, i.contact.company, i.contact.title, i.contact.notes].filter(Boolean).join('\n');
      const hits = findTemplateArtifacts({ subject: i.subject, text: i.text, specifics: { facts, hasAttachment: false } })
        .filter((h) => h.kind.startsWith('invented') || h.kind === 'false_attachment');
      return hits.length ? describeHits(hits) : null;
    }),
  },
  {
    id: 'guard/nothing-unfit-slipped-through',
    note: 'anything the guard would catch was actually held rather than left pending',
    run: (items) => failuresOf(items, (i) => {
      const hits = findTemplateArtifacts({ subject: i.subject, text: i.text });
      return hits.length && !i.row.hold_reason ? `NOT HELD but ${describeHits(hits)}` : null;
    }),
  },
  {
    id: 'personalisation/bodies-differ',
    note: 'every contact gets a different email, not one email with the name swapped',
    run: (items) => {
      const seen = new Map<string, string>();
      const out: string[] = [];
      for (const i of items) {
        // Compare with the contact's own details removed, so "different" means
        // genuinely different prose rather than a different merge field.
        let key = i.text.toLowerCase();
        for (const v of [i.contact.first_name, i.contact.last_name, i.contact.company, i.contact.title].filter(Boolean)) {
          key = key.split(String(v).toLowerCase()).join('·');
        }
        key = key.replace(/\s+/g, ' ').trim();
        const prev = seen.get(key);
        if (prev) out.push(`${i.email}: identical to ${prev} once the merge fields are removed`);
        else seen.set(key, i.email);
      }
      return out;
    },
  },
  {
    id: 'brief/keeps-the-ask',
    note: 'the walkthrough the brief ends with survives into every email',
    run: (items) => failuresOf(items, (i) => (/walk\s?-?through|walk through/i.test(i.text) ? null : 'the ask is missing')),
  },
];

async function main(): Promise<void> {
  await saveAiSettings({ model: MODEL, enabled: true });
  const s = await getAiSettings();

  const accRow = await one<any>(`SELECT * FROM accounts WHERE enabled ORDER BY id LIMIT 1`);
  if (!accRow) throw new Error('no account in the dev database');
  const acc = (await getAccount(accRow.id))!;
  const userId = Number(acc.user_id);
  // Before anything else: prove nothing here can be delivered.
  await assertNothingCanBeDelivered(acc, ['example.invalid']);
  console.log(`account ${acc.email} (user ${userId})  model ${s.model}  num_ctx ${s.numCtx}  mode ${MODE}  runs ${RUNS}`);
  console.log(`pacing: cap ${acc.daily_cap}/day, jitter ${acc.jitter_enabled ? `${acc.jitter_min_s}-${acc.jitter_max_s}s` : 'off'}, window ${acc.send_window?.start ?? '-'}-${acc.send_window?.end ?? '-'} ${acc.send_window?.tz ?? ''} (open now: ${isWindowOpen(acc.send_window)})\n`);

  const scores = new Map<string, { pass: number; total: number; why: string[] }>();
  let lastSeq = 0;

  for (let run = 1; run <= RUNS; run++) {
    const TAG = `campaign-eval-${Date.now()}`;
    const rows = audience(N);

    // ---------- 1. the CSV, through the real parser and mapping guesser ----------
    const parsed = parseCsv(csvFor(rows));
    const mapping = guessMapping(parsed.headers);
    const col = (field: string) => (mapping[field] ? parsed.headers.indexOf(mapping[field]) : -1);
    const idx = { email: col('email'), first_name: col('first_name'), last_name: col('last_name'), company: col('company'), title: col('title'), notes: col('notes') };
    if (idx.email < 0) throw new Error(`the mapping guesser did not find an email column: ${JSON.stringify(mapping)}`);
    if (run === 1) {
      console.log(`1. CSV: ${parsed.rows.length} rows, delimiter ${JSON.stringify(parsed.delimiter)}`);
      console.log(`   guessed mapping ${JSON.stringify(mapping)}`);
    }
    const contactIds: number[] = [];
    for (const r of parsed.rows) {
      const row = await one<{ id: number }>(
        `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, notes, tags, source, consent_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import','eval')
         ON CONFLICT (user_id, email) DO UPDATE SET tags=EXCLUDED.tags, first_name=EXCLUDED.first_name, notes=EXCLUDED.notes RETURNING id`,
        [userId, r[idx.email], r[idx.first_name] ?? '', r[idx.last_name] ?? '', r[idx.company] ?? '', r[idx.title] ?? '', r[idx.notes] ?? '', [TAG]],
      );
      if (row) contactIds.push(row.id);
    }

    // ---------- 2. the campaign the UI builds ----------
    const seq = (await one<any>(
      `INSERT INTO sequences (user_id, account_id, name, description, status, ai_mode, stop_on_reply, unsubscribe_footer) VALUES ($1,$2,$3,$4,'active',$5,true,true) RETURNING *`,
      [userId, acc.id, `Eval campaign ${TAG}`, `AI campaign. Brief: ${BRIEF}`, MODE],
    ))!;
    lastSeq = seq.id;
    await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize, ai_instructions) VALUES ($1,0,'email','',$2,true,$3)`,
      [seq.id, `<p>${BRIEF}</p>`, 'Under 110 words, no exclamation marks.']);
    await query(`INSERT INTO sequence_steps (sequence_id, position, kind, wait_days) VALUES ($1,1,'wait',4)`, [seq.id]);
    await query(`INSERT INTO sequence_steps (sequence_id, position, kind, subject, body_html, ai_personalize, ai_instructions, reply_in_thread) VALUES ($1,2,'email','',$2,true,$3,true)`,
      [seq.id, '<p>Short, friendly follow-up to the previous email. Ask if they had a chance to read it and restate the single most useful point in one sentence.</p>', 'Under 110 words, no exclamation marks.']);
    for (const cid of contactIds) {
      await query(`INSERT INTO enrollments (sequence_id, contact_id, account_id, status, current_step, next_run_at) VALUES ($1,$2,$3,'active',0,now()) ON CONFLICT (sequence_id, contact_id) DO NOTHING`, [seq.id, cid, acc.id]);
    }
    console.log(`${run === 1 ? '2. ' : ''}run ${run}: campaign ${seq.id}, ${contactIds.length} enrolled, ai_mode=${MODE}`);

    // ---------- 3. generation, one scheduler tick at a time ----------
    const t0 = Date.now();
    for (let pass = 1; pass <= 24; pass++) {
      const left = await one<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND status='active' AND next_run_at <= now()`, [seq.id]);
      if (!left?.n) break;
      await tick();
    }
    const secs = (Date.now() - t0) / 1000;

    // ---------- 4. what came out ----------
    const queued = await query<any>(`SELECT * FROM review_queue WHERE user_id=$1 AND enrollment_id IN (SELECT id FROM enrollments WHERE sequence_id=$2) ORDER BY id`, [userId, seq.id]);
    const items: Item[] = [];
    for (const r of queued) {
      const open = await openReview(userId, r);
      const contact = await one<any>('SELECT * FROM contacts WHERE id=$1', [r.contact_id]);
      if (!open || !contact) continue;
      items.push({ email: contact.email, row: r, contact, subject: open.subject ?? '', text: htmlToText(open.body_html ?? '') });
    }
    console.log(`   ${items.length}/${contactIds.length} generated in ${secs.toFixed(0)}s (${(secs / Math.max(1, items.length)).toFixed(1)}s each)`);

    for (const c of CASES) {
      if (ONLY.size && ![...ONLY].some((o) => c.id.includes(o))) continue;
      const why = c.run(items);
      const rec = scores.get(c.id) ?? { pass: 0, total: 0, why: [] };
      rec.total++;
      if (!why.length) rec.pass++;
      else rec.why.push(...why.slice(0, 4));
      scores.set(c.id, rec);
      console.log(`   ${why.length ? 'FAIL' : 'ok  '} ${c.id}${why.length ? `\n         ${why.slice(0, 4).join('\n         ')}${why.length > 4 ? `\n         (+${why.length - 4} more)` : ''}` : ''}`);
    }
    if (items[0] && run === 1) console.log(`\n   --- sample ---\n${items[0].text.split('\n').map((l) => '   | ' + l).join('\n')}`);

    // ---------- 5. per-campaign metrics ----------
    const m = await campaignMetrics(seq.id);
    console.log(`\n   metrics: ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }

  // ---------- 6. pacing ----------
  const a = (await getAccount(acc.id))!;
  const gaps = Array.from({ length: 8 }, () => Math.round(jitterMs(a) / 1000));
  const slot = await reserveSendSlot(a);
  console.log(`\npacing: randomised gaps (s) ${gaps.join(', ')}`);
  console.log(`        next slot: ${slot.ok ? `allowed, wait ${Math.round(slot.waitMs / 1000)}s` : `refused (${slot.reason}), retry ${slot.retryAt.toISOString()}`}`);
  const cap = a.daily_cap, avgGap = (a.jitter_enabled ? (a.jitter_min_s + a.jitter_max_s) / 2 : 0);
  console.log(`        a 1,000-row list at cap ${cap}/day and an average ${avgGap}s gap takes ${Math.ceil(1000 / Math.max(1, cap))} day(s) to send`);

  console.log('\n---- summary ----');
  let green = 0;
  for (const [id, r] of scores) {
    if (r.pass === r.total) green++;
    console.log(`${r.pass}/${r.total}  ${id}${r.why.length ? `  — ${[...new Set(r.why)].slice(0, 2).join(' | ')}` : ''}`);
  }
  console.log(`\ncases fully green: ${green}/${scores.size}   (sequence ${lastSeq} and everything it made left in the database)`);
  await pool.end();
  process.exit(green === scores.size ? 0 : 1);
}

void main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
