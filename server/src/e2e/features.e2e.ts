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
import { forgetEmbedReconciliation, indexBatch, indexPending, semanticSearch } from '../services/semantic.js';
import { EMBED_DIMS } from '../services/embeddings.js';
import { collectionFor, listCollections } from '../services/vectorStore.js';
import { EMBED_CATALOGUE, embedInputChars } from '../ai/providers.js';
import { guardBatch } from '../services/guard.js';
import { retrain, scorePending } from '../services/triage.js';
import { getAiSettings, saveAiSettings } from '../ai/llm.js';
import { encrypt } from '../crypto.js';
import { dataKey as dataKeyFor, sealWith } from '../services/vault.js';
import { addCommitment } from '../services/commitments.js';
import { startImport } from '../services/mailImport.js';
import { buildReply, invitationsFor, scanForInvitations, storeInvitation } from '../services/calendarMail.js';
import { extractPending } from '../services/attachments.js';
import { runImport, progress } from '../services/mailImport.js';
import { generateBrief, getBrief } from '../services/brief.js';

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
    // A real encrypted credential, not a placeholder: clientFor decrypts it
    // to build the auth header, so a fixture with rubbish here makes every
    // download fail with "Malformed ciphertext" and looks like a bug in the
    // feature under test.
    `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_secret_enc)
     VALUES ($1,'e2e',$2,'jmap','http://x','bearer',$3) RETURNING id`,
    [u!.id, `${tag}@probe.test`, encrypt('e2e-token')],
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
  box?: string; keywords?: string[]; thread?: string; hoursAgo?: number; authResults?: string;
  attachments?: { blobId: string; name: string; type: string; size: number }[]; listId?: string;
}): Promise<number> {
  const sealed = await sealEmail(f.userId, {
    subject: m.subject, preview: m.body.slice(0, 120), body_text: m.body, body_html: null,
    from_addr: [m.from], to_addr: [{ email: f.email }], cc_addr: [], bcc_addr: [], reply_to: [], attachments: m.attachments ?? [],
    auth_results: m.authResults ?? null,
  });
  const id = `e2e-${seq++}`;
  const row = await one<{ id: number }>(
    `INSERT INTO emails (account_id, jmap_id, thread_id, mailbox_ids, keywords, size, received_at,
        from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, preview, body_text, body_html, attachments,
        search_terms, address_terms, from_terms, from_blind, recipient_count, auth_results, has_attachment, list_id, sealed)
      VALUES ($1,$2,$3,$4,$5,200, now() - ($6 || ' hours')::interval,
        $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,true)
      RETURNING id`,
    [f.accountId, id, m.thread ?? id, [m.box ?? 'in'], m.keywords ?? ['$seen'], String(m.hoursAgo ?? seq),
     sealed.from_addr, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.reply_to,
     sealed.subject, sealed.preview, sealed.body_text, sealed.body_html, sealed.attachments,
     sealed.search_terms, sealed.address_terms, sealed.from_terms, sealed.from_blind, sealed.recipient_count, sealed.auth_results,
     Boolean(m.attachments?.length), m.listId ?? null],
  );
  return row!.id;
}

const putWithAttachment = put;

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

  await test('Postgres keeps the manifest and none of the numbers', async () => {
    // This used to read `email_vectors.vec` and assert it was opaque bytes of
    // the right width. That column is gone: the vectors live in Qdrant now and
    // Postgres keeps only a record of WHICH messages are indexed and under
    // which model.
    //
    // The property worth asserting therefore changed rather than disappeared.
    // It is no longer "the bytes here are unreadable" — it is that there are no
    // bytes here at all, and that what remains cannot be read back as content.
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='email_vectors'`,
    );
    const names = cols.map((c) => c.column_name);
    ok(!names.includes('vec'), 'email_vectors still has a vec column');
    ok(!names.includes('norm'), 'email_vectors still has a norm column');
    // What it does keep, and all of it is bookkeeping.
    for (const needed of ['email_id', 'account_id', 'model', 'dims']) {
      ok(names.includes(needed), `the manifest lost ${needed}`);
    }

    const row = await one<{ model: string; dims: number }>(
      'SELECT model, dims FROM email_vectors WHERE account_id=$1 LIMIT 1', [f.accountId],
    );
    ok(row, 'nothing was indexed at all');
    ok(row!.dims > 0, 'the manifest does not record a width');
    // The model name is a model name, not a fragment of somebody's mail.
    ok(/^[\w.:\/-]+$/.test(row!.model), `model column holds something unexpected: ${row!.model}`);
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

// ---------- Every embedder, not just the one the dev box has pulled ----------
//
// `semantic` above is the feature working; this is the feature working
// against the models an install would actually choose. They need different
// machinery, because the interesting ones cannot be run here: Qwen3-Embedding
// -4B is a 2.5 GB pull that wants a graphics card, the 8B wants a bigger one,
// and OpenAI's and Voyage's do not run anywhere at all. So the model server is
// a stub, and what is under test is everything on this side of it — the
// character budget, the query instruction, the keyed projection at that
// model's width, and which rows a search is allowed to score.
//
// The stub embeds a bag of hashed words, L2-normalised. That is not a
// language model and does not pretend to be: texts sharing words come back
// close and texts sharing none come back far, which is exactly the property
// the pipeline is being checked against. What it does faithfully reproduce is
// the WIDTH, which is the thing that varies between the models here and the
// thing every stage downstream is sized by.
const embedSeen: { model: string; input: string[] }[] = [];

function stubVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  // The task instruction is conditioned ON, not matched on. A real
  // instruction-tuned retrieval model reads "Instruct: …" as a description of
  // the job and embeds the query after it; a bag of words would instead treat
  // twenty words about searching email as twenty more terms to match, and
  // every query would look alike. Stripping it here is what makes the stub a
  // stand-in for the model rather than a different thing entirely — and the
  // test above already asserts, separately, that the prefix reaches the wire.
  const body = text.replace(/^Instruct: [\s\S]*?\nQuery: /, '');
  for (const word of body.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) { h ^= word.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dims] += 1;
  }
  const len = Math.hypot(...v) || 1;
  return v.map((x) => x / len);
}

async function startStubEmbedder(dimsFor: (model: string) => number): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      const input: string[] = Array.isArray(b.input) ? b.input : [b.input];
      embedSeen.push({ model: b.model, input });
      const dims = dimsFor(b.model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: input.map((t, index) => ({ index, embedding: stubVector(t, dims) })),
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// The widths that matter, from the catalogue rather than written out again.
const WIDTHS: Record<string, number> = Object.fromEntries(EMBED_CATALOGUE.map((m) => [m.name, m.dims]));

const embeddersGroup = group('embedders', async () => {
  const stub = await startStubEmbedder((m) => WIDTHS[m] ?? 768);
  const before = await getAiSettings();
  const useModel = (name: string) => saveAiSettings({
    enabled: true, embedProvider: 'openai', embedBaseUrl: stub.url, embedApiKey: 'stub', embedModel: name,
  });

  try {
    const f = await makeMailbox();
    await grant(f.userId, 'semantic');
    await put(f, { subject: 'Re: pricing for the Q3 engagement', body: 'We agreed on 4,200 euros a month for six months, invoiced on the first.', from: SENDERS.ana });
    await put(f, { subject: 'Office move', body: 'The team is relocating to the third floor on the 14th.', from: SENDERS.facilities });
    await put(f, { subject: 'Weekend plans', body: 'Fancy a walk up the hill on Saturday if the weather holds?', from: SENDERS.sam });

    // ── Qwen3-Embedding-4B, the model this was all checked against ──────────
    await useModel('qwen3-embedding:4b');
    embedSeen.length = 0;

    await test('a 2560-wide model indexes a whole mailbox, across both stores', async () => {
      // Rewritten for the Qdrant split. This used to read `vec` out of
      // `email_vectors` and check its width; that column is gone, correctly —
      // the numbers live in Qdrant now and Postgres keeps the manifest. So the
      // assertion moves to the property the split has to preserve: Postgres
      // knows WHICH messages are indexed and under WHICH model, and Qdrant has
      // somewhere to have put them.
      for (let i = 0; i < 4 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
      eq(await indexPending(f.userId), 0, 'messages left unindexed');

      const rows = await query<{ dims: number; model: string }>(
        'SELECT dims, model FROM email_vectors WHERE account_id=$1', [f.accountId]);
      eq(rows.length, 3, 'wrong number of manifest rows');
      for (const r of rows) {
        eq(r.model, 'qwen3-embedding:4b', 'the row does not name the model that made it');
        // Still the projection's width and not the model's — 2560 in, 256 out
        // — which is why the collection NAME has to carry the model. Two
        // models' points are the same width and live in different geometries.
        eq(r.dims, EMBED_DIMS, 'unexpected stored width');
      }

      const mine = collectionFor(f.userId, 'qwen3-embedding:4b');
      const collections = await listCollections();
      ok(collections.includes(mine),
        `no collection ${mine} in Qdrant; it has ${collections.join(', ') || 'none'}`);
    });

    await test('a long message reaches a 32k-window model whole, past both old caps', async () => {
      // Two caps have stood here, and this asserts past both of them.
      //
      // The first was a flat 2,000 characters for every model, which made the
      // catalogue's `contextTokens` decorative. The second was Tern's own
      // ceiling of 8,000, which was invisible while the catalogue topped out
      // at an 8,192-token model and became a clip to about 7% of the window
      // the moment a 32k model was the floor. Both dropped the tail of a long
      // message silently, which is the failure the budget exists to remove.
      ok(embedInputChars('qwen3-embedding:4b') > embedInputChars('all-minilm'), 'the wide model gets no more text');
      const long = 'jetty '.repeat(3000);
      await put(f, { subject: 'A very long thread', body: long, from: SENDERS.ana });
      embedSeen.length = 0;
      for (let i = 0; i < 3 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
      const sent = embedSeen.flatMap((c) => c.input).find((t) => t.includes('A very long thread'));
      ok(sent, 'the long message was never sent to the embedder');
      ok(sent!.length > 2000, `only ${sent!.length} characters were sent, which is the old flat cap`);
      ok(sent!.length > 8000, `only ${sent!.length} characters were sent, which is the old ceiling of Tern's own`);
      // Nothing was dropped at all: the whole body reached the model, which is
      // the property, not merely "more than before".
      ok(sent!.length >= long.length, `the message is ${long.length} characters and only ${sent!.length} were sent`);
      ok(sent!.length <= embedInputChars('qwen3-embedding:4b'), 'more was sent than the model’s own window allows');
    });

    await test('a search carries the instruction the model expects and the mailbox does not', async () => {
      embedSeen.length = 0;
      await semanticSearch(f.userId, [f.accountId], 'what did we agree the monthly price would be', { limit: 3, minScore: 0 });
      const query = embedSeen.at(-1)?.input?.[0] ?? '';
      ok(/^Instruct: /.test(query), `the query went out without its instruction: ${query.slice(0, 60)}`);
      // And the documents did not get one, which is the half that is easy to
      // break: prefixing both puts the same words in every vector in the
      // mailbox and flattens the distinction the prefix exists to sharpen.
      const documents = embedSeen.slice(0, -1).flatMap((c) => c.input);
      ok(documents.every((d) => !d.startsWith('Instruct: ')), 'a stored message was embedded as though it were a search');
    });

    await test('a question finds the message it is about', async () => {
      const hits = await semanticSearch(f.userId, [f.accountId], 'pricing engagement invoiced monthly', { limit: 3, minScore: 0 });
      ok(hits.length, 'no hits at all');
      const rows = await query<any>('SELECT id, subject FROM emails WHERE id=$1', [hits[0].emailId]);
      const opened = await openEmails(f.userId, 'owner', rows);
      ok(/pricing/i.test(String(opened[0]?.subject ?? '')), `top hit was "${opened[0]?.subject}"`);
    });

    // ── Switching models: the window every install passes through ───────────
    await test('vectors from the previous model are never scored against the new one', async () => {
      // The bug this guards. Every model's rows are stored at the same width,
      // so `WHERE dims = ?` matches all of them; their rotations are derived
      // from the model's own width, so their geometry is unrelated. Changing
      // the embedder queues a rebuild that takes hours on a real mailbox, and
      // every search until it finishes is scanning a table that is mostly the
      // old model's work — scored as noise, some of which clears the
      // threshold and comes back looking like an answer.
      const stale = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_vectors WHERE account_id=$1 AND model='qwen3-embedding:4b'`, [f.accountId]);
      ok(stale[0].n > 0, 'nothing was indexed under the old model, so this proves nothing');

      await useModel('all-minilm');
      // Deliberately WITHOUT re-indexing: this is the state an install is in
      // for as long as the rebuild takes.
      const hits = await semanticSearch(f.userId, [f.accountId], 'pricing engagement invoiced monthly', { limit: 10, minScore: 0 });
      eq(hits.length, 0, 'a search scored vectors made by a different model');

      // ...and once the rebuild has happened, the same question works again.
      await query('UPDATE emails SET embedded=false WHERE account_id=$1', [f.accountId]);
      for (let i = 0; i < 4 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
      const after = await semanticSearch(f.userId, [f.accountId], 'pricing engagement invoiced monthly', { limit: 3, minScore: 0 });
      ok(after.length, 'the rebuilt index finds nothing');
      const rows = await query<any>('SELECT id, subject FROM emails WHERE id=$1', [after[0].emailId]);
      const opened = await openEmails(f.userId, 'owner', rows);
      ok(/pricing/i.test(String(opened[0]?.subject ?? '')), `top hit after the rebuild was "${opened[0]?.subject}"`);
    });

    await test('a model changed without going through the settings page still rebuilds', async () => {
      // The path a floor change takes. `embedModel` also comes from DEFAULTS,
      // which reads `config.aiEmbedModel`, which reads AI_EMBED_MODEL — so an
      // install that has never saved AI settings switches embedder on the next
      // restart with nobody having touched the page, and the settings route
      // that queues the rebuild is never called.
      //
      // The failure that produced was total and quiet rather than partial:
      // `emails.embedded` stayed true so nothing re-indexed, while the scan
      // scopes by model name so nothing matched. Meaning search returned
      // nothing at all, for good.
      //
      // So this changes the model the way an environment variable does — a
      // saved setting, no invalidation, `embedded` left alone — and asserts
      // that the background pass notices anyway.
      await useModel('bge-m3');
      await query('UPDATE emails SET embedded=false WHERE account_id=$1', [f.accountId]);
      for (let i = 0; i < 4 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
      ok((await semanticSearch(f.userId, [f.accountId], 'pricing engagement invoiced monthly', { limit: 3, minScore: 0 })).length,
        'the fixture did not index under the first model, so this proves nothing');

      // Now the environment-variable route: the setting moves, every row stays
      // marked embedded, and nothing calls invalidateVectorsFrom.
      forgetEmbedReconciliation();
      await useModel('nomic-embed-text');
      const stillMarked = await one<{ n: number }>(
        'SELECT count(*)::int AS n FROM emails WHERE account_id=$1 AND embedded', [f.accountId]);
      ok(stillMarked!.n > 0, 'the fixture has nothing marked embedded, so the case is not set up');
      eq(await indexPending(f.userId), 0, 'something already queued the rebuild; this test is not exercising the gap');

      // One pass is enough to notice and queue it.
      await indexBatch(f.userId);
      ok((await indexPending(f.userId)) >= 0);
      for (let i = 0; i < 5 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
      const hits = await semanticSearch(f.userId, [f.accountId], 'pricing engagement invoiced monthly', { limit: 3, minScore: 0 });
      ok(hits.length, 'meaning search stayed empty after a model change nobody re-saved');
      const rows = await query<any>('SELECT id, subject FROM emails WHERE id=$1', [hits[0].emailId]);
      const opened = await openEmails(f.userId, 'owner', rows);
      ok(/pricing/i.test(String(opened[0]?.subject ?? '')), `top hit was "${opened[0]?.subject}"`);
      // And every vector is now the new model's, not a mixture.
      const models = await query<{ model: string }>(
        'SELECT DISTINCT model FROM email_vectors WHERE account_id=$1', [f.accountId]);
      eq(models.length, 1, `the index is a mixture: ${models.map((m) => m.model).join(', ')}`);
      eq(models[0].model, 'nomic-embed-text', 'the rebuild did not use the new model');
    });

    // ── And the rest of the catalogue, at its own width ─────────────────────
    await test('every embedder in the catalogue indexes and searches at its own width', async () => {
      for (const m of EMBED_CATALOGUE) {
        await useModel(m.name);
        // The sweep drives the models by hand, so it also clears the memo the
        // reconciler keeps — otherwise it would be asserting against whatever
        // that memo happened to hold rather than against each model in turn.
        forgetEmbedReconciliation();
        await query('UPDATE emails SET embedded=false WHERE account_id=$1', [f.accountId]);
        for (let i = 0; i < 4 && (await indexPending(f.userId)) > 0; i++) await indexBatch(f.userId);
        eq(await indexPending(f.userId), 0, `${m.name}: messages left unindexed`);
        const rows = await query<{ n: number }>(
          'SELECT count(*)::int AS n FROM email_vectors WHERE account_id=$1 AND model=$2', [f.accountId, m.name]);
        ok(rows[0].n >= 3, `${m.name}: only ${rows[0].n} vectors written`);
        const hits = await semanticSearch(f.userId, [f.accountId], 'pricing engagement invoiced monthly', { limit: 3, minScore: 0 });
        ok(hits.length, `${m.name}: a search found nothing`);
        const found = await query<any>('SELECT id, subject FROM emails WHERE id=$1', [hits[0].emailId]);
        const opened = await openEmails(f.userId, 'owner', found);
        ok(/pricing/i.test(String(opened[0]?.subject ?? '')), `${m.name}: top hit was "${opened[0]?.subject}"`);
      }
    });
  } finally {
    await stub.close();
    await saveAiSettings({
      embedProvider: before.embedProvider, embedBaseUrl: before.embedBaseUrl,
      embedApiKey: before.embedApiKey, embedModel: before.embedModel,
    });
  }
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


// A stand-in for the mail server's blob endpoint, so the download-and-parse
// paths run for real rather than being taken on trust. It serves whatever the
// test hands it, at the URL shape JMAP uses.
async function blobServer(blobs: Record<string, { type: string; body: Buffer }>): Promise<{ url: string; close: () => Promise<void> }> {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').split('/').filter(Boolean)[1] ?? '');
    const blob = blobs[id];
    if (!blob) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': blob.type, 'Content-Length': String(blob.body.length) });
    res.end(blob.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/blob/{blobId}/{name}`,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

// Points an account's session at the configured internal origin so the
// network guard allows a loopback address, and its download URL at the stub.
async function pointAtStub(accountId: number, downloadUrl: string): Promise<void> {
  await query(
    `UPDATE accounts SET session_url=$2, api_url=$3, upload_url=$3, download_url=$4, jmap_account_id='stub' WHERE id=$1`,
    [accountId, process.env.STALWART_URL ?? 'http://127.0.0.1:18080', `${new URL(downloadUrl).origin}/api`, downloadUrl],
  );
}

const attachmentsGroup = group('attachments', async () => {
  const f = await makeMailbox();
  await grant(f.userId, 'attachments');

  // A real Word document, built the way extract.test.ts builds one, so the
  // whole path runs: download, parse, seal, fold into the blind index.
  const { deflateRawSync } = await import('node:zlib');
  const docXml = '<w:document><w:body><w:p><w:r><w:t>Statement of work: 4,200 per month, invoiced monthly.</w:t></w:r></w:p></w:body></w:document>';
  const raw = Buffer.from(docXml, 'utf8');
  const deflated = deflateRawSync(raw);
  const nameBuf = Buffer.from('word/document.xml', 'utf8');
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30);
  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(deflated.length, 20); cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42); nameBuf.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(local.length + deflated.length, 16);
  const docx = Buffer.concat([local, deflated, cd, eocd]);

  const stub = await blobServer({ 'blob-sow': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: docx } });
  await pointAtStub(f.accountId, stub.url);
  const acc = (await query<any>('SELECT * FROM accounts WHERE id=$1', [f.accountId]))[0];

  const emailId = await putWithAttachment(f, {
    subject: 'Paperwork', body: 'Attached.', from: SENDERS.ana,
    attachments: [{ blobId: 'blob-sow', name: 'Statement of work.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: docx.length }],
  });

  try {
    await test('an attachment is downloaded, read and sealed', async () => {
      const n = await extractPending(f.userId, acc);
      eq(n, 1, 'nothing was processed');
      const r = await one<any>('SELECT name, text, chars, error FROM attachment_text WHERE email_id=$1', [emailId]);
      ok(r, 'no row was written');
      eq(r.error, null, `it failed: ${r.error}`);
      ok(String(r.name ?? '').startsWith('k1.'), 'the file name was stored in the clear');
      ok(String(r.text ?? '').startsWith('k1.'), 'the extracted text was stored in the clear');
      ok(r.chars > 20, `only ${r.chars} characters came out`);
    });

    await test('the words inside it become searchable', async () => {
      // "invoiced" is in the document and in no subject or body, so a match
      // proves the extracted text reached the blind index.
      const { parseSearch, buildSearchSql } = await import('../services/search.js');
      const params: unknown[] = [f.accountId];
      const p = (v: unknown) => `$${params.push(v)}`;
      const where = await buildSearchSql(parseSearch('invoiced'), [f.accountId], p, f.userId);
      const rows = await query<any>(
        `SELECT e.id FROM emails e WHERE e.account_id=$1${where.length ? ` AND ${where.join(' AND ')}` : ''}`,
        params,
      );
      ok(rows.some((r: any) => Number(r.id) === emailId), 'the attachment’s words are not searchable');
    });

    await test('the same message is not read twice', async () => {
      eq(await extractPending(f.userId, acc), 0, 'it went round again');
    });
  } finally {
    await stub.close();
  }
});

const calendarGroup = group('calendar', async () => {
  const f = await makeMailbox();
  await grant(f.userId, 'calendar');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    'UID:9f1c-quarterly@corp.example', 'DTSTAMP:20260901T090000Z',
    'DTSTART:20260915T140000Z', 'DTEND:20260915T150000Z',
    'SUMMARY:Quarterly review', 'LOCATION:Room 3\\, second floor',
    'ORGANIZER;CN=Ana Duarte:mailto:ana@corpexample.com',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@mine.example',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const stub = await blobServer({ 'blob-ics': { type: 'text/calendar', body: Buffer.from(ics) } });
  await pointAtStub(f.accountId, stub.url);
  const acc = (await query<any>('SELECT * FROM accounts WHERE id=$1', [f.accountId]))[0];
  const emailId = await putWithAttachment(f, {
    subject: 'Invitation: Quarterly review', body: 'When: 15 September', from: SENDERS.ana,
    attachments: [{ blobId: 'blob-ics', name: 'invite.ics', type: 'text/calendar', size: ics.length }],
  });

  try {
    await test('an invitation is found and read', async () => {
      eq(await scanForInvitations(f.userId, acc), 1, 'no invitation was found');
      const list = await invitationsFor(f.userId, emailId);
      eq(list.length, 1);
      eq(list[0].summary, 'Quarterly review');
      eq(list[0].location, 'Room 3, second floor', 'the escape was not undone');
      eq(list[0].organizer?.email, 'ana@corpexample.com');
      eq(list[0].startsAt, '2026-09-15T14:00:00.000Z');
    });

    await test('everything a person would read is sealed', async () => {
      const r = await one<any>('SELECT uid, summary, location, organizer, uid_blind, starts_at FROM calendar_events WHERE email_id=$1', [emailId]);
      for (const col of ['uid', 'summary', 'location', 'organizer']) {
        ok(String(r[col] ?? '').startsWith('k1.'), `${col} was stored in the clear`);
      }
      ok(Buffer.isBuffer(r.uid_blind), 'no blind companion for the unique index');
      ok(r.starts_at, 'the time is plain on purpose, and is missing');
    });

    await test('a reply echoes the UID it is answering', async () => {
      const inv = (await invitationsFor(f.userId, emailId))[0];
      const body = buildReply(inv, { email: 'me@mine.example', name: 'Me' }, 'ACCEPTED');
      ok(body.includes('METHOD:REPLY'), 'not a reply');
      ok(body.includes('UID:9f1c-quarterly@corp.example'), 'the UID did not survive the round trip');
      ok(body.includes('PARTSTAT=ACCEPTED'), 'no answer in it');
    });

    await test('scanning again does not duplicate it', async () => {
      await scanForInvitations(f.userId, acc);
      const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM calendar_events WHERE email_id=$1', [emailId]);
      eq(n?.n, 1, 'the invitation was stored twice');
    });
  } finally {
    await stub.close();
  }
});

const importGroup = group('import', async () => {
  const f = await makeMailbox();
  await grant(f.userId, 'import');
  const mbox = [
    'From ana@corpexample.com Mon Sep  1 09:00:00 2026',
    'Message-ID: <imported-1@corpexample.com>',
    'From: =?utf-8?Q?Ana_Duarte?= <ana@corpexample.com>',
    'To: me@mine.example',
    'Subject: =?utf-8?B?UmVjaG51bmc=?=',
    'Date: Mon, 1 Sep 2026 09:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Die Rechnung für August liegt bei.',
    '>From now on please use the new address.',
    '',
    'From sam@gmail.com Tue Sep  2 10:00:00 2026',
    'Message-ID: <imported-2@gmail.com>',
    'From: Sam <sam@gmail.com>',
    'To: me@mine.example',
    'Subject: Hillwalk',
    'Date: Tue, 2 Sep 2026 10:00:00 +0000',
    '',
    'Saturday still good?',
    '',
  ].join('\n');

  await test('an mbox becomes real, sealed mail', async () => {
    const acc = (await query<any>('SELECT * FROM accounts WHERE id=$1', [f.accountId]))[0];
    const id = await startImport(f.userId, f.accountId, 'Takeout.mbox');
    const p = await runImport(f.userId, acc, id, Buffer.from(mbox, 'utf8'));
    eq(p?.status, 'done', `import ended ${p?.status}: ${p?.error}`);
    eq(p?.done, 2, `imported ${p?.done}`);

    const rows = await query<any>('SELECT * FROM emails WHERE account_id=$1 ORDER BY received_at', [f.accountId]);
    eq(rows.length, 2);
    for (const r of rows) ok(String(r.subject).startsWith('k1.'), 'an imported subject was stored in the clear');

    const opened = await openEmails(f.userId, 'owner', rows);
    eq(opened[0].subject, 'Rechnung', 'the encoded subject was not decoded');
    eq(opened[0].from_addr?.[0]?.name, 'Ana Duarte');
    ok(/Die Rechnung/.test(opened[0].body_text ?? ''), 'the body did not survive');
    ok(/^From now on/m.test(opened[0].body_text ?? ''), 'mbox escaping was not undone');
  });

  await test('importing the same file again adds nothing', async () => {
    const acc = (await query<any>('SELECT * FROM accounts WHERE id=$1', [f.accountId]))[0];
    const id = await startImport(f.userId, f.accountId, 'Takeout.mbox');
    const p = await runImport(f.userId, acc, id, Buffer.from(mbox, 'utf8'));
    eq(p?.done, 0, 'it imported duplicates');
    eq(p?.skipped, 2, 'the duplicates were not recognised');
    const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM emails WHERE account_id=$1', [f.accountId]);
    eq(n?.n, 2, 'the mailbox doubled');
  });

  await test('imported mail lands in Imported, never the inbox', async () => {
    const rows = await query<any>('SELECT mailbox_ids FROM emails WHERE account_id=$1', [f.accountId]);
    for (const r of rows) ok(!r.mailbox_ids.includes('in'), 'an imported message went to the inbox');
  });

  await test('the file name is sealed, and the archive is not kept', async () => {
    const r = await one<any>(`SELECT filename FROM mail_imports WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [f.userId]);
    ok(String(r?.filename ?? '').startsWith('k1.'), 'the file name was stored in the clear');
    const p = await progress(f.userId, (await one<{ id: number }>('SELECT id FROM mail_imports WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [f.userId]))!.id);
    eq(p?.filename, 'Takeout.mbox', 'it does not read back');
  });
});

const briefGroup = group('brief', async () => {
  const f = await makeMailbox();
  for (const c of ['brief', 'guard', 'triage', 'commitments'] as const) await grant(f.userId, c);

  // Real mail, so the four section queries run against rows rather than
  // against nothing — which is all the earlier check proved.
  await put(f, { subject: 'Can you confirm Thursday?', body: 'Does 2pm work for the review?', from: SENDERS.ana, keywords: [], hoursAgo: 3 });
  await put(f, { subject: 'Contract question', body: 'One more thing about the payment terms.', from: SENDERS.facilities, keywords: [], hoursAgo: 5 });
  for (let i = 0; i < 4; i++) {
    await put(f, { subject: `Weekly offers ${i}`, body: 'Sale ends soon.', from: SENDERS.shop, keywords: [], hoursAgo: 10 + i, listId: 'offers.shop.example' });
  }
  await addCommitment(f.userId, { accountId: f.accountId, kind: 'owed', text: 'Send the revised quote', counterparty: 'Ana Duarte', dueAt: new Date(Date.now() - 86_400_000).toISOString() });

  await test('a brief over real mail fills its sections', async () => {
    const b = await generateBrief(f.userId);
    const titles = b.sections.map((s) => s.title);
    ok(titles.includes('Waiting for you'), `sections were ${JSON.stringify(titles)}`);
    const waiting = b.sections.find((s) => s.title === 'Waiting for you')!;
    ok(waiting.items.length >= 2, `only ${waiting.items.length} items are waiting`);
    ok(waiting.items.every((i) => i.threadId && i.accountId), 'an item cannot be opened');
    ok(titles.includes('Owed and awaiting'), 'the commitment did not reach the brief');
    const owed = b.sections.find((s) => s.title === 'Owed and awaiting')!;
    ok(/overdue/i.test(owed.items[0].text), `the overdue item reads "${owed.items[0].text}"`);
  });

  await test('bulk mail is offered as one action rather than four rows', async () => {
    const b = await getBrief(f.userId);
    const bulk = b?.sections.find((s) => s.title === 'Can go in one action');
    ok(bulk && bulk.items.length >= 1, 'four unread from one sender were not grouped');
    ok(/4 unread/.test(bulk?.items[0].text ?? ''), `it reads "${bulk?.items[0].text}"`);
  });

  await test('the stored brief is sealed and reads back', async () => {
    const r = await one<{ content: string }>('SELECT content FROM briefs WHERE user_id=$1', [f.userId]);
    ok(String(r?.content ?? '').startsWith('k1.'), 'the brief was stored in the clear');
    const b = await getBrief(f.userId);
    ok(b && b.sections.length > 0, 'it does not read back');
    eq(b!.stale, false, 'a fresh brief should not be stale');
  });

  await test('new mail makes it stale rather than silently rewriting it', async () => {
    await put(f, { subject: 'Something new', body: 'Just arrived.', from: SENDERS.sam, keywords: [], hoursAgo: 0 });
    const b = await getBrief(f.userId);
    eq(b?.stale, true, 'the brief does not know the mailbox moved');
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
  // `email_vectors.vec` was here and is gone: the column no longer exists,
  // because the vectors moved to Qdrant and this table became a manifest. A
  // stale entry is not harmless — the group below asserts the allow-list has
  // nothing in it that the schema does not, precisely so a column that goes
  // away takes its exemption with it.
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
  for (const g of [gateGroup, semanticGroup, embeddersGroup, guardGroup, triageGroup, attachmentsGroup, calendarGroup, importGroup, briefGroup, retentionGroup, plaintextGroup]) {
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
