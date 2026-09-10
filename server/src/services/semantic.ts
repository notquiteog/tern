// F1: meaning search over the encrypted cache.
//
// The blind index answers "which messages contain this word". It cannot
// answer "which conversation was the one where we settled the price",
// because the words in the question are not the words in the mail. That is
// what this adds, and it adds it without putting anything readable on disk:
// every vector goes through the keyed projection in embeddings.ts first.
//
// The search is a full scan. That sounds wrong and is not: a stored vector
// is 256 bytes, so fifty thousand messages is twelve megabytes, and a dot
// product over twelve megabytes of Int8Array is a few milliseconds. An
// approximate index would buy nothing at this size and would cost an
// extension, a build step and a second thing to keep in sync with deletes.
//
// Results are always the intersection of what the person can see and what
// the index knows: the scan is scoped to their own accounts by SQL, then the
// rows are opened with their own key. There is no path here that can reach
// another account, and the vectors of one account are meaningless under
// another's rotation anyway.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import * as vectors from './vectorStore.js';
import { embed, getAiSettings } from '../ai/llm.js';
import { embedInputChars } from '../ai/providers.js';
import { dataKey } from './vault.js';
import { fromBuffer, project, rotationFor, similarity, toBuffer, type Rotation } from './embeddings.js';
import { openEmails } from './mailVault.js';
import { htmlToText } from './merge.js';
import { allowed } from './capabilities.js';

const log = logger('semantic');

// How many messages are turned into vectors in one pass. Small on purpose:
// the pass runs on the scheduler tick beside everything else, and a box
// whose model is also answering somebody should not stall for a minute
// because a mailbox is being indexed.
export const INDEX_BATCH = 12;

// What of a message is embedded. Subject first because it carries the most
// meaning per token, then the body with quoted replies stripped — a thread
// where every message re-quotes the last one would otherwise embed the same
// paragraph twenty times and every message in it would look identical.
//
// How MUCH of it is the embedder's business rather than a constant: see
// `embedInputChars`. This was a flat 2,000 characters for every model, which
// meant an install that had pulled a 32k-window embedder was paying for a
// window it was never sent. The budget is passed in rather than looked up here
// so one index pass uses one number for every message in it, whatever the
// settings do mid-pass.
export function embeddableText(m: { subject?: string | null; body_text?: string | null; body_html?: string | null; preview?: string | null }, maxChars = 2000): string {
  const body = (m.body_text || htmlToText(m.body_html || '') || m.preview || '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/^\s*On .{0,120}wrote:\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const subject = String(m.subject ?? '').trim();
  // The top of an email is where its subject matter lives, so what falls off
  // the end is the least of it whatever the budget turns out to be.
  return `${subject}\n\n${body}`.slice(0, Math.max(200, maxChars)).trim();
}

const rotations = new Map<string, Rotation>();
async function rotationFor_(userId: number, dims: number): Promise<Rotation> {
  const key = `${userId}:${dims}`;
  const hit = rotations.get(key);
  if (hit) return hit;
  const rot = rotationFor(await dataKey(userId), dims);
  rotations.set(key, rot);
  return rot;
}
export function forgetRotations(): void { rotations.clear(); }

/**
 * The Qdrant collection for one user and one embedding model.
 *
 * Both halves matter. The user, because vectors are rotated with a per-user
 * key and one collection holding several rotations gives HNSW a graph built
 * from distances that mean nothing across users — which costs recall *within*
 * a user, not just across them. The model, because vectors from two models are
 * not comparable at all, so a model change writes into a new collection rather
 * than poisoning the old one.
 */
function vectorCollection(userId: number, model: string): string {
  return vectors.collectionFor(userId, model);
}

// ---------- Indexing ----------

export async function indexPending(userId: number): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND NOT e.embedded`,
    [userId],
  );
  return r?.n ?? 0;
}

/**
 * Notice that the embedding model has changed, however it changed, and queue
 * the rebuild.
 *
 * ── Why this is not left to the settings route ──────────────────────────────
 *
 * Because that route is only one of the ways it changes. `PUT /api/ai/settings`
 * calls `invalidateVectorsFrom` when an admin picks a different embedder, and
 * that was the whole of the mechanism — but `embedModel` also comes from
 * `DEFAULTS`, which reads `config.aiEmbedModel`, which reads `AI_EMBED_MODEL`.
 * An install that has never saved AI settings has no stored value at all, so
 * changing that environment variable — or shipping a new default in the
 * installer — switches the embedder on the next restart with nobody having
 * touched the page.
 *
 * That path wrote no invalidation. `emails.embedded` stayed true, so the
 * background pass had nothing to do, while `semanticSearch` scopes its scan by
 * model name and therefore matched none of the existing rows. Meaning search
 * returned nothing at all, and kept returning nothing until somebody happened
 * to re-save the setting by hand.
 *
 * Before the scan was scoped it failed the other way — the old vectors were
 * scored under a rotation that was not theirs and came back as noise — so this
 * is not a regression that scoping introduced, it is the second half of that
 * fix. The check belongs here, where indexing actually happens, because then
 * it holds for every route into a model change including the ones nobody has
 * written yet.
 *
 * Cheap: memoised per model for the life of the process, so an ordinary tick
 * does nothing, and the one UPDATE it can run is the same one the settings
 * route has always run.
 */
let reconciledFor: string | null = null;

/** Tests only: the memo is process-wide state. */
export function forgetEmbedReconciliation(): void { reconciledFor = null; }

async function reconcileEmbedModel(model: string): Promise<void> {
  if (!model || reconciledFor === model) return;
  reconciledFor = model;
  const queued = await invalidateVectorsFrom(model);
  if (queued) log.info('the embedding model no longer matches the index; queued a rebuild', { model, messages: queued });
}

// One batch for one person. Returns how many were written, so the caller can
// keep going while there is work and stop asking when there is not.
export async function indexBatch(userId: number, limit = INDEX_BATCH): Promise<{ done: number; remaining: number }> {
  if (!(await allowed(userId, 'semantic'))) return { done: 0, remaining: 0 };
  // Before choosing what to work on rather than after: a model change that
  // arrived any way other than through the settings page has to become pending
  // work here, or nothing downstream will ever see it.
  // The model the SETTINGS name. What actually made the vectors comes back
  // from `embed` below and is what gets written to the row — they agree, but
  // only one of them is a measurement, and the row must carry that one.
  const configuredModel = (await getAiSettings()).embedModel;
  await reconcileEmbedModel(configuredModel);
  const rows = await query<any>(
    `SELECT e.id, e.account_id, e.subject, e.preview, e.body_text, e.body_html
       FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND NOT e.embedded
      ORDER BY e.received_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  if (!rows.length) return { done: 0, remaining: 0 };

  const opened = await openEmails(userId, 'semantic', rows);
  const budget = embedInputChars(configuredModel);
  const texts = opened.map((m) => embeddableText(m, budget));
  // A message with nothing in it still gets marked, or the pass would find
  // it again for ever.
  const usable = texts.map((t, i) => ({ t, i })).filter((x) => x.t.length > 8);
  if (!usable.length) {
    await query('UPDATE emails SET embedded=true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    return { done: rows.length, remaining: await indexPending(userId) };
  }

  // Documents. Named rather than left to the default, because the pair below
  // is the whole point: a retrieval model embeds the thing being searched for
  // and the things being searched through differently, and until this argument
  // existed both went out identically.
  const { vectors: embedded, model, dims } = await embed(usable.map((x) => x.t), { userId, capability: 'semantic' }, undefined, 'document');
  if (!embedded.length || !dims) return { done: 0, remaining: await indexPending(userId) };
  const rot = await rotationFor_(userId, dims);

  // Vectors go to Qdrant; Postgres keeps a manifest row saying WHICH messages
  // are indexed and under which model, and no longer the vector itself.
  //
  // The split is what makes both halves cheap. The manifest is what
  // `indexPending` counts and what `invalidateVectorsFrom` marks, both of which
  // are pure bookkeeping and want to be a SQL statement rather than a
  // conversation with another service. The vector is what search needs, and it
  // wants to be somewhere that can answer top-k without shipping every
  // candidate back.
  //
  // It also keeps the cascade: `email_vectors.email_id` still references
  // `emails(id) ON DELETE CASCADE`, so deleting a message still removes its
  // manifest row without Qdrant having to take part in the transaction.
  const collection = vectorCollection(userId, model);
  const points: { emailId: number; accountId: number; vector: number[] }[] = [];
  const indexed: { id: number; accountId: number }[] = [];
  for (let k = 0; k < usable.length; k++) {
    const v = embedded[k];
    if (!Array.isArray(v) || !v.length) continue;
    const row = rows[usable[k].i];
    const stored = project(rot, v);
    // `project` already normalises to length 127 before quantising, so the
    // int8 values are the vector — Cosine over them is exact, not an
    // approximation, and no scale has to travel alongside. `Array.from`
    // because JSON has no typed arrays.
    points.push({ emailId: row.id, accountId: row.account_id, vector: Array.from(stored) });
    indexed.push({ id: row.id, accountId: row.account_id });
  }
  if (points.length) {
    // The index first, the manifest second, and deliberately in that order: a
    // manifest row with no point is a message that silently never matches,
    // while a point with no manifest row is found by the next sweep and
    // rewritten. Failing between them should leave the recoverable one.
    await vectors.ensureCollection(collection, points[0]!.vector.length);
    await vectors.upsert(collection, points);
    for (const row of indexed) {
      await query(
        `INSERT INTO email_vectors (email_id, account_id, dims, model)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (email_id) DO UPDATE SET dims=EXCLUDED.dims, model=EXCLUDED.model, created_at=now()`,
        [row.id, row.accountId, points[0]!.vector.length, model],
      );
    }
  }
  await query('UPDATE emails SET embedded=true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
  const remaining = await indexPending(userId);
  log.info(`indexed ${rows.length} messages`, { user: userId, remaining });
  return { done: rows.length, remaining };
}

// Vectors made by one model are not comparable with another's: the cosine
// distance between an all-minilm vector and a nomic-embed-text one is noise,
// not similarity. So changing the embedding model invalidates everything
// already indexed — and leaving those rows alone would not break search
// visibly, it would quietly make it worse, which is harder to notice and
// harder to explain.
//
// The rows are marked for re-indexing rather than deleted, so a message that
// has been re-embedded is findable again immediately instead of at the end of
// the pass. What is not yet rebuilt is simply not scored — see
// `semanticSearch` for why matching it would be worse than missing it.
//
// Two callers. The settings route calls it the moment an admin picks a
// different embedder, which is what lets the page say how much work that just
// asked for; `reconcileEmbedModel` above calls it for every other way the
// model can change, none of which pass through a route at all.
export async function invalidateVectorsFrom(model: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE emails SET embedded=false
      WHERE embedded AND id IN (SELECT email_id FROM email_vectors WHERE model <> $1)
      RETURNING id`,
    [model],
  );
  return rows.length;
}

// ---------- Searching ----------

export interface SemanticHit { emailId: number; accountId: number; threadId: string; score: number }

// The scan. `accountIds` has already been filtered to this person's accounts
// by the caller; the join re-checks it anyway, because a search route is
// exactly where a mistake of that kind would be worth making.
export async function semanticSearch(
  userId: number,
  accountIds: number[],
  text: string,
  opts: { limit?: number; minScore?: number; mailboxIds?: string[] } = {},
): Promise<SemanticHit[]> {
  const query_ = String(text ?? '').trim();
  if (!query_ || !accountIds.length) return [];
  const { vectors: embedded, dims, model } = await embed([query_], { userId, capability: 'semantic' }, undefined, 'query');
  if (!embedded[0]?.length || !dims) return [];
  const rot = await rotationFor_(userId, dims);
  const needle = project(rot, embedded[0]);

  // The index answers, and Postgres says what the answers are.
  //
  // Qdrant returns ids and scores and nothing else. Everything shown — the
  // subject, the sender, the thread, the mailbox — comes from the join below,
  // and that is not merely tidy: **a point that outlived its email joins to no
  // row and disappears before anything is rendered.** The cascade's guarantee
  // that deleting a message takes its vector with it therefore holds by
  // construction rather than by a sweep having run recently, and Qdrant never
  // has to take part in a delete that must not fail.
  //
  // Scoping by model is still load-bearing and is now free: the model is in
  // the collection NAME, so a needle can only ever be compared with vectors
  // made by the same embedder. Under the old table it was a WHERE clause that
  // `dims` could not stand in for — every vector was projected to the same
  // width, so an all-minilm row and a Qwen3 row were both 256 bytes and `dims`
  // matched both, while the geometry did not.
  const minScore = opts.minScore ?? 0.28;
  const want = opts.limit ?? 60;
  // Over-fetch when a mailbox filter is in play. The mailbox a message is in
  // changes whenever anyone moves mail, so it is deliberately NOT in the
  // index's payload — keeping it there would mean writing to Qdrant on every
  // move. The cost is that the filter is applied after the top-k, so the top-k
  // has to be big enough to survive it.
  const filtered = Boolean(opts.mailboxIds?.length);
  const found = await vectors.search(vectorCollection(userId, model), Array.from(needle), {
    accountIds,
    limit: filtered ? Math.min(want * 8, 1000) : want,
    minScore,
  });
  if (!found.length) return [];

  const byId = new Map(found.map((h) => [h.emailId, h.score]));
  const rows = await query<{ email_id: number; account_id: number; thread_id: string }>(
    `SELECT e.id AS email_id, e.account_id, e.thread_id
       FROM emails e JOIN accounts a ON a.id = e.account_id
      WHERE a.user_id = $1 AND e.id = ANY($2) AND e.account_id = ANY($3)
        AND ($4::text[] IS NULL OR e.mailbox_ids && $4::text[])`,
    [userId, [...byId.keys()], accountIds, opts.mailboxIds?.length ? opts.mailboxIds : null],
  );

  return rows
    .map((r) => ({
      emailId: r.email_id,
      accountId: r.account_id,
      threadId: r.thread_id,
      score: byId.get(r.email_id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, want);
}

// "More like this": the index recommends from a point it already holds.
//
// No embedding call, and — since the vectors moved to Qdrant — no round trip
// carrying one either. Tern names the seed by id and the index does the rest,
// which is the reason the vectors were free to leave Postgres: nothing here
// needs to know the width, the rotation, or what the numbers are.
//
// The manifest row is still consulted, for the model and the account: the
// model decides which collection to ask, and asking the wrong one would
// compare a needle against vectors from a different embedder and return
// confident nonsense.
export async function similarTo(userId: number, emailId: number, limit = 10): Promise<SemanticHit[]> {
  const seed = await one<{ model: string; account_id: number }>(
    `SELECT v.model, v.account_id FROM email_vectors v
       JOIN accounts a ON a.id=v.account_id
      WHERE v.email_id=$1 AND a.user_id=$2`,
    [emailId, userId],
  );
  if (!seed) return [];

  const accounts = await query<{ id: number }>(
    'SELECT id FROM accounts WHERE user_id=$1', [userId],
  );
  const found = await vectors.recommend(vectorCollection(userId, seed.model), emailId, {
    accountIds: accounts.map((a) => a.id),
    limit,
    minScore: 0.4,
  });
  if (!found.length) return [];

  // The same join as `semanticSearch`, for the same reason: a point whose
  // message is gone joins to nothing and never reaches the caller.
  const byId = new Map(found.map((h) => [h.emailId, h.score]));
  const rows = await query<{ email_id: number; account_id: number; thread_id: string }>(
    `SELECT e.id AS email_id, e.account_id, e.thread_id
       FROM emails e JOIN accounts a ON a.id = e.account_id
      WHERE a.user_id = $1 AND e.id = ANY($2)`,
    [userId, [...byId.keys()]],
  );
  return rows
    .map((r) => ({ emailId: r.email_id, accountId: r.account_id, threadId: r.thread_id, score: byId.get(r.email_id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Retrieval for the model: the few messages most related to a question,
// opened and trimmed, for the brief and for a reply that needs to remember
// something from six months ago.
export async function relatedContext(userId: number, accountIds: number[], question: string, take = 4): Promise<{ subject: string; from: string; date: string; text: string }[]> {
  const hits = await semanticSearch(userId, accountIds, question, { limit: take });
  if (!hits.length) return [];
  const rows = await query<any>(
    'SELECT id, subject, from_addr, received_at, body_text, body_html, preview FROM emails WHERE id = ANY($1)',
    [hits.map((h) => h.emailId)],
  );
  const opened = await openEmails(userId, 'semantic', rows);
  const order = new Map(hits.map((h, i) => [h.emailId, i]));
  return opened
    .sort((a: any, b: any) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
    .map((m: any) => ({
      subject: m.subject ?? '',
      from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(),
      date: new Date(m.received_at).toDateString(),
      text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').slice(0, 1200),
    }));
}
