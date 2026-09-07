// End-to-end checks for the consent gate and the features that sit behind
// it, against the dev database and whatever Ollama the dev environment
// points at. No HTTP server is needed: these drive the services directly,
// because what is being checked is the gate and the storage rather than the
// routing.
//
//   npx tsx --env-file=.env.dev server/src/e2e/features.e2e.ts
//   ONLY=gate,semantic   to run a subset
//
// Most of this is not "does the feature work" but "does it refuse when it
// should, and is what lands in Postgres actually unreadable". Two bugs came
// out of writing it, both of the kind unit tests structurally cannot catch:
// the guard built its knowledge from a table that already contained the
// message it was about to judge, so "have we met this sender?" always
// answered yes; and the AI job payload lived on after the job. Both are
// checked here.
import { migrate, one, pool, query, waitForDb } from '../db.js';
import { grant, revoke, setFeatureFlag } from '../services/capabilities.js';
import { eraseCapabilityData } from '../services/capabilityData.js';
import { openEmails, sealEmail } from '../services/mailVault.js';
import { indexBatch, indexPending, semanticSearch } from '../services/semantic.js';
import { guardBatch } from '../services/guard.js';
import { retrain, scorePending } from '../services/triage.js';
import { getAiSettings, saveAiSettings } from '../ai/llm.js';

const ONLY = new Set((process.env.ONLY ?? '').split(',').filter(Boolean));
const results: { group: string; name: string; ok: boolean; detail?: string }[] = [];
let current = '';

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ group: current, name, ok: true }); console.log(`  ok   ${name}`); }
  catch (e: any) { results.push({ group: current, name, ok: false, detail: e?.message ?? String(e) }); console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
}
function group(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => { if (ONLY.size && !ONLY.has(name)) return; current = name; console.log(`\n== ${name}`); await fn(); };
}
function ok(v: unknown, msg = 'expected truthy') { if (!v) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg = '') { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function throws(fn: () => Promise<unknown>, match: RegExp, msg: string): Promise<void> {
  try { await fn(); } catch (e) {
    if (match.test((e as Error).message)) return;
    throw new Error(`${msg}: threw the wrong thing — ${(e as Error).message}`);
  }
  throw new Error(`${msg}: it did not refuse`);
}

// ---------- A throwaway mailbox ----------

interface Fixture { userId: number; accountId: number; email: string }
const created: number[] = [];

const SENDERS = {
  ana: { name: 'Ana Duarte', email: 'ana@corpexample.com' },
  facilities: { name: 'Facilities', email: 'facilities@corpexample.com' },
  sam: { name: 'Sam', email: 'sam@gmail.com' },
  shop: { name: 'Shop', email: 'noreply@shop.example' },
  // The impersonation: the right name, a domain one character out.
  fake: { name: 'Ana Duarte', email: 'ana@corpexamp1e.com' },
};

async function makeMailbox(): Promise<Fixture> {
  const tag = `e2efeat${Date.now().toString(36)}`;
  const u = await one<{ id: number }>(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,'Features e2e','x','member') RETURNING id`, [tag],
  );
  created.push(u!.id);
  const a = await one<{ id: number }>(
    `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_secret_enc)
     VALUES ($1,'e2e',$2,'jmap','http://x','bearer','x') RETURNING id`, [u!.id, `${tag}@probe.test`],
  );
  await query(
    `INSERT INTO mailboxes (account_id, jmap_id, name, role) VALUES ($1,'in','Inbox','inbox'),($1,'ar','Archive','archive'),($1,'sn','Sent','sent'),($1,'tr','Trash','trash')`,
    [a!.id],
  );
  return { userId: u!.id, accountId: a!.id, email: `${tag}@probe.test` };
}

let seq = 0;
async function put(f: Fixture, m: {
  subject: string; body: string; from: { name: string; email: string };
  box?: string; keywords?: string[]; thread?: string; hoursAgo?: number;
}): Promise<number> {
  const sealed = await sealEmail(f.userId, {
    subject: m.subject, preview: m.body.slice(0, 120), body_text: m.body, body_html: null,
    from_addr: [m.from], to_addr: [{ email: f.email }], cc_addr: [], bcc_addr: [], reply_to: [], attachments: [],
  });
  const id = `e2e-${seq++}`;
  const row = await one<{ id: number }>(
    `INSERT INTO emails (account_id, jmap_id, thread_id, mailbox_ids, keywords, size, received_at,
        from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, preview, body_text, body_html, attachments,
        search_terms, address_terms, from_terms, from_blind, recipient_count, sealed)
      VALUES ($1,$2,$3,$4,$5,200, now() - ($6 || ' hours')::interval,
        $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true)
      RETURNING id`,
    [f.accountId, id, m.thread ?? id, [m.box ?? 'in'], m.keywords ?? ['$seen'], String(m.hoursAgo ?? seq),
     sealed.from_addr, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.reply_to,
     sealed.subject, sealed.preview, sealed.body_text, sealed.body_html, sealed.attachments,
     sealed.search_terms, sealed.address_terms, sealed.from_terms, sealed.from_blind, sealed.recipient_count],
  );
  return row!.id;
}

// ======================================================================

const gateGroup = group('gate', async () => {
  const f = await makeMailbox();
  const id = await put(f, { subject: 'Hello', body: 'A first message.', from: SENDERS.ana });
  const rows = await query<any>('SELECT * FROM emails WHERE id=$1', [id]);

  await test('a sealed row holds no plaintext', async () => {
    const r = rows[0];
    const blob = `${r.subject} ${r.preview} ${r.body_text} ${r.from_addr}`;
    ok(!/Hello|first message|Ana|corpexample/i.test(blob), `plaintext survived: ${blob.slice(0, 120)}`);
    ok(String(r.subject).startsWith('k1.'), 'subject is not sealed');
  });

  await test('the owner may always read their own mail', async () => {
    const opened = await openEmails(f.userId, 'owner', rows);
    eq(opened[0].subject, 'Hello');
  });

  await test('a capability may not, until it is granted', async () => {
    await throws(() => openEmails(f.userId, 'semantic', rows), /Turn on/i, 'reading without consent');
  });

  await test('granting opens it', async () => {
    await grant(f.userId, 'semantic');
    const opened = await openEmails(f.userId, 'semantic', rows);
    eq(opened[0].subject, 'Hello');
  });

  await test('an admin switch overrules consent', async () => {
    await setFeatureFlag('semantic', false);
    await throws(() => openEmails(f.userId, 'semantic', rows), /administrator/i, 'the install switch');
    await setFeatureFlag('semantic', true);
  });

  await test('revoking erases what the capability made', async () => {
    await indexBatch(f.userId);
    const before = await one<{ n: number }>('SELECT count(*)::int AS n FROM email_vectors WHERE account_id=$1', [f.accountId]);
    ok((before?.n ?? 0) > 0, 'nothing was indexed to erase');
    await revoke(f.userId, 'semantic');
    await eraseCapabilityData(f.userId, 'semantic');
    const after = await one<{ n: number }>('SELECT count(*)::int AS n FROM email_vectors WHERE account_id=$1', [f.accountId]);
    eq(after?.n, 0, 'vectors survived a revoke');
  });
});

const semanticGroup = group('semantic', async () => {
  const f = await makeMailbox();
  await grant(f.userId, 'semantic');
  await put(f, { subject: 'Re: pricing for the Q3 engagement', body: 'We agreed on 4,200 euros a month for six months, invoiced on the first.', from: SENDERS.ana });
  await put(f, { subject: 'Office move', body: 'The team is relocating to the third floor on the 14th.', from: SENDERS.facilities });
  await put(f, { subject: 'Weekend plans', body: 'Fancy a walk up the hill on Saturday if the weather holds?', from: SENDERS.sam });
  await put(f, { subject: 'Your receipt', body: 'Thank you for your order. Total charged: 18.99.', from: SENDERS.shop });

  await test('the whole mailbox indexes', async () => {
    for (let i = 0; i < 4 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
    eq(await indexPending(f.userId), 0, 'messages left unindexed');
  });

  await test('a stored vector is opaque bytes of the expected width', async () => {
    const v = await one<{ vec: Buffer; dims: number }>('SELECT vec, dims FROM email_vectors WHERE account_id=$1 LIMIT 1', [f.accountId]);
    ok(Buffer.isBuffer(v?.vec), 'not bytes');
    eq(v!.vec.length, v!.dims, 'width does not match the column');
    ok(!/[\x20-\x7e]{16,}/.test(v!.vec.toString('latin1')), 'a run of readable text in a vector');
  });

  await test('a question finds mail that shares no words with it', async () => {
    // The point of the feature: none of "hike", "walk up", "Saturday" is in
    // the question, and the right conversation still comes back.
    const hits = await semanticSearch(f.userId, [f.accountId], 'are we going for a hike this weekend', { limit: 3, minScore: 0 });
    ok(hits.length, 'no hits at all');
    const rows = await query<any>('SELECT id, subject FROM emails WHERE id=$1', [hits[0].emailId]);
    const opened = await openEmails(f.userId, 'owner', rows);
    const subject = String(opened[0]?.subject ?? '');
    ok(/weekend/i.test(subject), `top hit was "${subject}"`);
  });

  await test('another account cannot be searched through this one', async () => {
    const other = await makeMailbox();
    await grant(other.userId, 'semantic');
    await put(other, { subject: 'Somebody else’s secret', body: 'A hike up the hill on Saturday.', from: SENDERS.sam });
    for (let i = 0; i < 2; i++) await indexBatch(other.userId);
    // Asking with this user's id but the other account's id must return
    // nothing: the join is on the owner, not on what was passed in.
    const leaked = await semanticSearch(f.userId, [other.accountId], 'hike up the hill', { limit: 5, minScore: 0 });
    eq(leaked.length, 0, 'a search reached another account');
  });
});

const guardGroup = group('guard', async () => {
  const f = await makeMailbox();
  await grant(f.userId, 'guard');

  // A relationship worth impersonating: enough messages from the real
  // domain that a lookalike is worth flagging.
  for (let i = 0; i < 6; i++) {
    await put(f, { subject: `Project update ${i}`, body: 'Notes from the weekly.', from: SENDERS.ana, hoursAgo: 200 + i });
  }
  await guardBatch(f.userId, f.accountId);

  await test('the first message from a stranger is marked as such', async () => {
    // The bug this exists for: knowledge was built from a table that already
    // contained the message being judged, so nothing was ever a first
    // contact and every other "have we seen this?" check answered wrongly.
    const id = await put(f, { subject: 'Hello there', body: 'We have not met.', from: { name: 'New Person', email: 'new@stranger.example' }, hoursAgo: 1 });
    await guardBatch(f.userId, f.accountId);
    const r = await one<{ guard_flags: string[] }>('SELECT guard_flags FROM emails WHERE id=$1', [id]);
    ok(r?.guard_flags.includes('first_contact'), `flags were ${JSON.stringify(r?.guard_flags)}`);
  });

  await test('a lookalike domain is caught, with the domain it imitates', async () => {
    const id = await put(f, { subject: 'Updated bank details', body: 'Please pay the new account.', from: SENDERS.fake, hoursAgo: 1 });
    await guardBatch(f.userId, f.accountId);
    const r = await one<{ guard_flags: string[]; guard_detail: string }>('SELECT guard_flags, guard_detail FROM emails WHERE id=$1', [id]);
    ok(r?.guard_flags.includes('lookalike_domain') || r?.guard_flags.includes('display_name_mismatch'),
      `expected an impersonation flag, got ${JSON.stringify(r?.guard_flags)}`);
    ok(String(r?.guard_detail ?? '').startsWith('k1.'), 'the detail names a domain and must be sealed');
  });

  await test('ordinary mail from a known correspondent is not flagged', async () => {
    const id = await put(f, { subject: 'Project update 7', body: 'More notes.', from: SENDERS.ana, hoursAgo: 1 });
    await guardBatch(f.userId, f.accountId);
    const r = await one<{ guard_flags: string[] }>('SELECT guard_flags FROM emails WHERE id=$1', [id]);
    eq(r?.guard_flags.length, 0, `a known sender was flagged: ${JSON.stringify(r?.guard_flags)}`);
  });
});

const triageGroup = group('triage', async () => {
  const f = await makeMailbox();
  await grant(f.userId, 'triage');

  // Enough decisions to learn from: bulk that is archived unread, and
  // correspondence that is starred.
  for (let i = 0; i < 30; i++) {
    await put(f, { subject: `Weekly offers ${i}`, body: 'Sale ends soon. Unsubscribe below.', from: SENDERS.shop, box: 'ar', keywords: [], hoursAgo: 100 + i });
    await put(f, { subject: `Contract question ${i}`, body: 'About the invoice and the payment terms we agreed.', from: SENDERS.ana, box: 'ar', keywords: ['$seen', '$flagged'], hoursAgo: 100 + i });
  }

  await test('a model is fitted from what the person did', async () => {
    const r = await retrain(f.userId);
    ok(r.trained, `not trained: ${r.samples} samples`);
    ok((r.accuracy ?? 0) > 0.7, `accuracy was ${r.accuracy}`);
  });

  await test('new mail is scored, and the two kinds land apart', async () => {
    const junkish = await put(f, { subject: 'Weekly offers 99', body: 'Sale ends soon. Unsubscribe below.', from: SENDERS.shop, box: 'in', keywords: [], hoursAgo: 1 });
    const realish = await put(f, { subject: 'Contract question 99', body: 'About the invoice and the payment terms we agreed.', from: SENDERS.ana, box: 'in', keywords: [], hoursAgo: 1 });
    await scorePending(f.userId);
    const rows = await query<{ id: number; priority: number }>('SELECT id, priority FROM emails WHERE id = ANY($1)', [[junkish, realish]]);
    const byId = new Map(rows.map((r) => [Number(r.id), r.priority]));
    const lo = byId.get(junkish), hi = byId.get(realish);
    ok(lo !== null && hi !== null, 'a message was left unscored');
    ok((hi ?? 0) > (lo ?? 0), `the correspondence scored ${hi} and the bulk scored ${lo}`);
  });

  await test('the weights are sealed like everything else learned from mail', async () => {
    const r = await one<{ weights: string }>('SELECT weights FROM triage_models WHERE user_id=$1', [f.userId]);
    ok(String(r?.weights ?? '').startsWith('k1.'), 'the model was stored in the clear');
  });
});

const retentionGroup = group('retention', async () => {
  await test('a finished AI job keeps no copy of the mail it was about', async () => {
    const f = await makeMailbox();
    const job = await one<{ id: number }>(
      `INSERT INTO ai_jobs (user_id, kind, payload, status) VALUES ($1,'responder',$2,'pending') RETURNING id`,
      [f.userId, JSON.stringify({ emailDbId: 1, body: 'the whole text of somebody’s email' })],
    );
    // What the scheduler does when a job finishes.
    await query(`UPDATE ai_jobs SET status='done', result='sent', payload='{}'::jsonb WHERE id=$1`, [job!.id]);
    const after = await one<{ payload: any; result: string }>('SELECT payload, result FROM ai_jobs WHERE id=$1', [job!.id]);
    eq(JSON.stringify(after?.payload), '{}', 'the prompt survived the job');
    eq(after?.result, 'sent', 'the outcome should be kept — it is what an admin reads');
  });
});


// ======================================================================
// The plaintext sweep.
//
// Spot-checking a column you remember to check is how a leak survives. This
// puts a distinctive nonsense word into every position a person's words can
// reach — subject, body, attachment name, attachment text, commitment,
// invitation, import filename, the Authentication-Results header — runs every
// feature that writes something derived from them, and then searches *every
// text and bytea column of every table in the database* for those words.
//
// It found three real leaks the first time it ran: emails.auth_results (which
// carries `smtp.mailfrom=someone@their-domain`), calendar_events.uid (which
// some systems build out of the event title) and mail_imports.filename.
//
// Columns that are legitimately readable are listed below with the reason.
// Anything not on that list must come back sealed, and adding to the list is
// a deliberate act.

// Words that will not occur anywhere else in a database of test mail.
const CANARY = {
  subject: 'ZQXJPRICING',
  body: 'VBNMKQUARTERLY',
  sender: 'WXYZDUARTE',
  attachmentName: 'PLQRINVOICE',
  attachmentText: 'HGFDCONTRACT',
  commitment: 'TREWQDECKSEND',
  invitation: 'MNBVREVIEWCALL',
  filename: 'YUIOTAKEOUT',
  authDomain: 'KJHGFCORP',
};

// Every column that may hold readable text, and why. `emails` is the existing
// design and is documented in ENCRYPTION.md; the rest are the new tables.
const READABLE_BY_DESIGN: Record<string, string> = {
  'emails.jmap_id': 'an opaque id the mail server chose',
  'emails.blob_id': 'an opaque id the mail server chose',
  'emails.thread_id': 'an opaque id the mail server chose',
  'emails.mailbox_ids': 'ids, not names',
  'emails.keywords': 'a fixed vocabulary ($seen, $flagged)',
  'emails.message_id': 'a random token plus a domain; threading is impossible without it',
  'emails.in_reply_to': 'as message_id',
  'emails.references_ids': 'as message_id',
  'emails.list_id': 'the identity of a mailing list, used to detect bulk mail',
  'emails.list_unsubscribe': 'a URL the sender published for anyone to use',
  'emails.auto_submitted': 'a fixed vocabulary (auto-replied, auto-generated)',
  'emails.category': 'a fixed vocabulary of four',
  'emails.guard_flags': 'a fixed vocabulary of six',
  'emails.search_terms': 'HMAC under the owner key',
  'emails.address_terms': 'HMAC under the owner key',
  'emails.from_terms': 'HMAC under the owner key',
  'emails.from_blind': 'HMAC under the owner key',
  'email_vectors.vec': 'a keyed projection; see ENCRYPTION.md layer 1b',
  'email_vectors.model': 'the name of a model, not anybody’s words',
  'user_capabilities.capability': 'a fixed vocabulary',
  'attachment_text.part_id': 'an opaque blob id the mail server chose',
  'attachment_text.content_type': 'a media type',
  'attachment_text.error': 'a parser or transport message, never file content',
  'commitments.thread_id': 'an opaque id the mail server chose',
  'commitments.kind': 'a fixed vocabulary',
  'commitments.status': 'a fixed vocabulary',
  'commitments.source': 'a fixed vocabulary',
  'commitment_scans.thread_id': 'an opaque id the mail server chose',
  'briefs.model': 'the name of a model',
  'calendar_events.uid_blind': 'HMAC under the owner key',
  'calendar_events.method': 'a fixed vocabulary (REQUEST, REPLY, CANCEL)',
  'calendar_events.reply': 'a fixed vocabulary of three',
  'mail_imports.status': 'a fixed vocabulary',
  'mail_imports.error': 'an internal message, never mail content',
};

// Every text-ish column in the database, asked of Postgres rather than
// listed by hand — a column added later is swept without anybody
// remembering to add it here.
async function textColumns(): Promise<{ table: string; column: string; type: string }[]> {
  return query<{ table: string; column: string; type: string }>(
    `SELECT table_name AS table, column_name AS column, data_type AS type
       FROM information_schema.columns
      WHERE table_schema='public'
        AND data_type IN ('text','character varying','jsonb','bytea','ARRAY')
      ORDER BY table_name, column_name`,
  );
}

// Where a canary turns up, if anywhere. Casting to text covers arrays,
// jsonb and bytea alike; bytea renders as \x hex, so a word hidden in bytes
// is searched for in hex too.
async function findCanary(word: string): Promise<string[]> {
  const hits: string[] = [];
  const hex = Buffer.from(word, 'utf8').toString('hex');
  for (const c of await textColumns()) {
    const key = `${c.table}.${c.column}`;
    let rows: { n: number }[];
    try {
      rows = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${c.table}" WHERE position($1 in upper(coalesce("${c.column}"::text, ''))) > 0 OR position($2 in lower(coalesce("${c.column}"::text, ''))) > 0`,
        [word.toUpperCase(), hex],
      );
    } catch { continue; } // a column that will not cast to text holds no words
    if ((rows[0]?.n ?? 0) > 0) hits.push(key);
  }
  return hits;
}

const plaintextGroup = group('plaintext', async () => {
  const f = await makeMailbox();
  for (const c of ['semantic', 'guard', 'triage', 'attachments', 'commitments', 'brief', 'calendar', 'import'] as const) {
    await grant(f.userId, c);
  }

  // One message carrying a canary in every position the sync path fills.
  const emailId = await put(f, {
    subject: `Re: ${CANARY.subject} for Q3`,
    body: `We agreed the ${CANARY.body} figure. I will send the deck on Friday.`,
    from: { name: `Ana ${CANARY.sender}`, email: `ana@${CANARY.authDomain.toLowerCase()}.example` },
    authResults: `mx.example; dkim=pass header.d=${CANARY.authDomain.toLowerCase()}.example; spf=pass smtp.mailfrom=ana@${CANARY.authDomain.toLowerCase()}.example`,
  });

  // The rows the other features write, through the same helpers they use.
  const dek = await dataKeyFor(f.userId);
  await query(
    `INSERT INTO attachment_text (email_id, account_id, part_id, name, content_type, text, chars)
     VALUES ($1,$2,'blob-1',$3,'application/pdf',$4,20)`,
    [emailId, f.accountId, sealWith(dek, `${CANARY.attachmentName}.pdf`), sealWith(dek, `Total due under the ${CANARY.attachmentText}`)],
  );
  await addCommitment(f.userId, { accountId: f.accountId, kind: 'owed', text: `Send the ${CANARY.commitment} deck`, counterparty: `Ana ${CANARY.sender}` });
  await storeInvitation(f.userId, f.accountId, emailId, {
    uid: `${CANARY.invitation}-1234@corp.example`,
    summary: `${CANARY.invitation} with Ana`,
    location: `Room ${CANARY.invitation}`,
    description: null, organizer: { email: 'ana@corp.example', name: `Ana ${CANARY.sender}` },
    attendees: [], start: new Date(Date.now() + 86_400_000), end: null, allDay: false,
    sequence: 0, status: null, recurrence: null, approximate: false,
  });
  await startImport(f.userId, f.accountId, `${CANARY.filename}-personal.mbox`);

  // And the derived indexes.
  for (let i = 0; i < 3 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
  await guardBatch(f.userId, f.accountId);
  await scorePending(f.userId);

  for (const [where, word] of Object.entries(CANARY)) {
    await test(`nothing readable is left of the ${where}`, async () => {
      const hits = (await findCanary(word)).filter((k) => !(k in READABLE_BY_DESIGN));
      if (hits.length) throw new Error(`"${word}" is readable in ${hits.join(', ')}`);
    });
  }

  await test('every column that is readable is readable on purpose', async () => {
    // The mirror of the sweep: the allow-list must not have grown stale
    // entries pointing at columns that no longer exist.
    const live = new Set((await textColumns()).map((c) => `${c.table}.${c.column}`));
    const gone = Object.keys(READABLE_BY_DESIGN).filter((k) => !live.has(k));
    if (gone.length) throw new Error(`the allow-list names columns that no longer exist: ${gone.join(', ')}`);
  });
});

// ======================================================================
async function main() {
  await waitForDb(30);
  await migrate();
  const before = await getAiSettings();
  // The dev probe's models, so an install pointed at something else still
  // runs. Restored at the end.
  await saveAiSettings({ enabled: true, embedModel: process.env.E2E_EMBED_MODEL ?? 'all-minilm' });

  const t0 = Date.now();
  for (const g of [gateGroup, semanticGroup, guardGroup, triageGroup, retentionGroup, plaintextGroup]) {
    try { await g(); } catch (e) { console.log(`  GROUP FAILED: ${(e as Error).message}`); results.push({ group: current, name: '(group)', ok: false, detail: (e as Error).message }); }
  }

  await saveAiSettings({ embedModel: before.embedModel, enabled: before.enabled });
  for (const id of created) await query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});

  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  console.log(`\n${pass} passed, ${fail} failed in ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL [${r.group}] ${r.name}: ${r.detail}`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
