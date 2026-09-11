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
import { config } from '../config.js';
import * as vectors from './vectorStore.js';
import { modelSlug, parseCollection } from './vectorStore.js';
import { embed, embedIdentity, getAiSettings, modelOfIdentity } from '../ai/llm.js';
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
 * The Qdrant collection for one user and one embedder.
 *
 * Both halves matter. The user, because vectors are rotated with a per-user
 * key and one collection holding several rotations gives HNSW a graph built
 * from distances that mean nothing across users — which costs recall *within*
 * a user, not just across them. The embedder, because vectors from two of them
 * are not comparable at all, so a change writes into a new collection rather
 * than poisoning the old one.
 *
 * The second argument is an `embedIdentity`, not a model name: provider, host
 * and model together. `all-minilm` on the Ollama next door and `all-minilm`
 * through a gateway are different embedders wearing the same string, and while
 * only the name was used they shared a collection and a manifest scope — so
 * changing where embeddings came from left every stored vector in place and
 * silently searched a space nothing was in any more.
 */
function vectorCollection(userId: number, identity: string): string {
  return vectors.collectionFor(userId, identity);
}

/**
 * Where a person's contact notes live, for one embedder.
 *
 * A separate collection from their mail rather than a flag on the points.
 * Point ids are the row's own id, and a contact 12 and an email 12 would
 * collide — and a `kind` filter on every search would be paying the filtered-
 * HNSW cost this whole layout exists to avoid.
 */
function contactCollection(userId: number, identity: string): string {
  return vectors.collectionFor(userId, `contacts|${identity}`);
}

/** Every collection that is current for this embedder, by slug. */
function keepSlugs(identity: string): Set<string> {
  const base = modelSlug(identity);
  if (!base) return new Set();
  return new Set([base, modelSlug(`contacts|${identity}`)]);
}

/** Whether a collection slug is one this embedder writes to now. */
export function isCurrentSlug(identity: string, slug: string): boolean {
  return keepSlugs(identity).has(slug);
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

async function reconcileEmbedModel(identity: string): Promise<void> {
  if (!identity || reconciledFor === identity) return;
  reconciledFor = identity;
  const queued = await invalidateVectorsFrom(identity);
  if (queued) log.info('the embedder no longer matches the index; queued a rebuild', { identity, messages: queued });
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
  const settings = await getAiSettings();
  const configuredModel = settings.embedModel;
  await reconcileEmbedModel(embedIdentity(settings));
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
  // Built from the model the embedder actually answered with, over the
  // endpoint the settings resolved to.
  const identity = embedIdentity(settings, model);
  const collection = vectorCollection(userId, identity);
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
        // The manifest's `model` column carries the whole identity, because it
        // is the scope every read filters on — see `vectorCollection`.
        [row.id, row.accountId, points[0]!.vector.length, identity],
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
export async function invalidateVectorsFrom(identity: string): Promise<number> {
  // The manifest first, the index second, and the order is the same argument
  // `indexBatch` makes pointing the other way. A message marked for rebuild
  // whose old collection still exists is recoverable — the next pass rewrites
  // it. A collection dropped before the mark, with the UPDATE then failing,
  // leaves messages flagged as indexed with nothing behind them, and nothing
  // will ever look for them again.
  const rows = await query<{ id: number }>(
    `UPDATE emails SET embedded=false
      WHERE embedded AND id IN (SELECT email_id FROM email_vectors WHERE model <> $1)
      RETURNING id`,
    [identity],
  );
  await dropCollectionsNotFrom(identity);
  return rows.length;
}

/**
 * Drop every collection built by an embedder this install is no longer using.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 *
 * Because the model is in the collection name, which is what makes a model
 * change safe — a new embedder writes into a new collection instead of
 * poisoning the old one. The half that was missing is the other end of that
 * bargain: nothing ever dropped the old one.
 *
 * The result was a leak that grew rather than a stale row. Switching embedder
 * left `tern_u<id>_<old model>` holding a complete set of every user's
 * mail-derived vectors, under a model nothing would query again, indefinitely
 * — and every subsequent change added another full copy per user. Postgres
 * self-heals here, because the manifest row is overwritten by `ON CONFLICT
 * (email_id) DO UPDATE`; Qdrant had no equivalent, so the two stores disagreed
 * about what "changing the embedder" meant.
 *
 * ── Why it is safe to drop immediately ──────────────────────────────────────
 *
 * Because nothing can read those vectors any more. `semanticSearch` scopes by
 * `v.model = $4`, so from the instant the setting changes the old collection
 * serves no query — keeping it does not soften the gap during a rebuild, it
 * only decides whether the data is still on disk while it is already unused.
 *
 * ── What it will not touch ──────────────────────────────────────────────────
 *
 * Anything it cannot parse as one of ours. This Qdrant may be shared with
 * something else on the same box, and a sweep that assumed every collection it
 * could see belonged to Tern would be a sweep that deletes a stranger's data.
 * `parseCollection` returns null for those and they are skipped.
 *
 * Never throws. An unreachable index must not stop an admin changing the
 * embedder — the SQL above has already run, the rebuild is queued, and the
 * next model change or a capability revocation sweeps whatever was missed.
 */
export async function dropCollectionsNotFrom(identity: string): Promise<number> {
  // Two collections per user per embedder now: their mail, and their contact
  // notes. Both are current under the same identity, so the keep-set has to
  // name both — a sweep that knew only about mail would drop the contact
  // index on every pass and rebuild it on the next, for ever.
  const keep = keepSlugs(identity);
  // An empty slug would match every collection with no model segment, which is
  // not a model change — it is a missing setting, and dropping the index on
  // one would be a spectacular way to react to it.
  if (!keep.size) return 0;
  let dropped = 0;
  try {
    for (const name of await vectors.listCollections()) {
      const parsed = parseCollection(name);
      if (!parsed || keep.has(parsed.slug)) continue;
      try {
        await vectors.dropCollection(name);
        dropped += 1;
      } catch (err) {
        log.error('could not drop a superseded vector collection', { name, err: String(err) });
      }
    }
  } catch (err) {
    log.error('the vector index could not be reached to drop superseded collections; they remain', {
      identity, err: String(err),
    });
    return dropped;
  }
  if (dropped) log.info(`dropped ${dropped} vector collections built by a previous embedder`, { identity });
  return dropped;
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
  const settings = await getAiSettings();
  const { vectors: embedded, dims, model } = await embed([query_], { userId, capability: 'semantic' }, undefined, 'query');
  if (!embedded[0]?.length || !dims) return [];
  const identity = embedIdentity(settings, model);
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
  const found = await vectors.search(vectorCollection(userId, identity), Array.from(needle), {
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

/**
 * Drop everything this person's meaning index holds.
 *
 * The Postgres half of an erase is a DELETE that the cascade would have done
 * anyway. This is the half that stopped being automatic when the vectors left
 * Postgres, and the distinction matters because the promise is different from
 * the one the read path keeps:
 *
 * * For a **deleted email**, the promise is that you cannot get at it. The
 *   join in `semanticSearch` keeps that by construction — an orphaned point
 *   joins to no row and can surface nothing.
 * * For a **revoked capability or a deleted account**, the promise is
 *   *erasure*, and invisible is not erased. The vectors have to go.
 *
 * Collection names carry the user id (`tern_u<id>_<model>`), so this is a
 * prefix scan over what the index reports rather than a list Tern has to keep
 * in step. One collection per model the mailbox has been indexed under, and
 * all of them go.
 *
 * **Never throws.** A consent revocation that fails because a vector service
 * is unreachable is the wrong failure: the caller's SQL should still run, the
 * person should still be un-consented, and the leftovers are a sweep's problem.
 * What is dropped is returned so the caller can log the difference.
 */
export async function eraseSemanticIndex(userId: number): Promise<number> {
  const prefix = `tern_u${userId}_`;
  let dropped = 0;
  try {
    const all = await vectors.listCollections();
    for (const name of all.filter((n) => n === prefix.slice(0, -1) || n.startsWith(prefix))) {
      try {
        await vectors.dropCollection(name);
        dropped += 1;
      } catch (err) {
        log.error('could not drop a vector collection', { name, err: String(err) });
      }
    }
  } catch (err) {
    // The index could not even be asked. Say so loudly — this is the path
    // where somebody has withdrawn consent and their vectors are still there.
    log.error('the vector index could not be reached to erase it; vectors remain', {
      user: userId, err: String(err),
    });
    return 0;
  }
  if (dropped) log.info(`dropped ${dropped} vector collections`, { user: userId });
  return dropped;
}

/**
 * Drop collections whose user no longer exists.
 *
 * `eraseSemanticIndex` handles the cases Tern can see coming — a revoked
 * capability, a deleted account. This is for the ones it could not: rows
 * removed before the erase path existed, a database restored from a backup
 * taken before some accounts were created, an account deleted while the index
 * was unreachable. Thirty-nine such collections were found on the development
 * box from end-to-end runs whose users were long gone.
 *
 * The read path already refuses to surface them — an orphaned point joins to
 * no row. This is about them not being on the disk, which is a different
 * promise and the one that matters after somebody asks to be forgotten.
 *
 * Deliberately conservative about what it considers an orphan: only names that
 * parse as Tern's own, and only ids with no row in `users`. A collection it
 * cannot parse is left alone and reported — somebody else's data in the same
 * Qdrant is not this function's to delete.
 */
export async function sweepOrphanedCollections(): Promise<{ dropped: number; kept: number }> {
  let names: string[];
  try {
    names = await vectors.listCollections();
  } catch (err) {
    log.warn('could not list vector collections to sweep', { err: String(err) });
    return { dropped: 0, kept: 0 };
  }

  const live = new Set(
    (await query<{ id: number }>('SELECT id FROM users')).map((r) => r.id),
  );
  let dropped = 0;
  let kept = 0;
  for (const name of names) {
    const m = /^tern_u(\d+)_/.exec(name);
    if (!m) { kept += 1; continue; }
    if (live.has(Number(m[1]))) { kept += 1; continue; }
    try {
      await vectors.dropCollection(name);
      dropped += 1;
    } catch (err) {
      log.error('could not drop an orphaned collection', { name, err: String(err) });
    }
  }
  if (dropped) log.info(`swept ${dropped} orphaned vector collections`, { kept });
  return { dropped, kept };
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

// ---------- Looking at the index, and emptying it ----------
//
// The index has always been something that happened to an install rather than
// something anybody could see or steer: it filled in the background, it
// rebuilt itself when the embedder changed, and if it went wrong the only
// instrument was `indexPending` on the settings page saying a number that was
// not going down.
//
// These are the two operations an operator actually needs. `indexStatus`
// answers "what is in there, and does it match what this install is
// configured to use" — including, deliberately, collections that are NOT
// ours, so that a shared Qdrant is legible rather than mysterious.
// `resetIndex` throws it away and queues the rebuild.

export interface CollectionView {
  name: string;
  /** Null when the name is not one of Tern's. */
  userId: number | null;
  points: number;
  dims: number;
  /**
   * `current`    the collection this install writes to and reads from now.
   * `superseded` Tern's, but built by an embedder no longer configured.
   * `orphaned`   Tern's, for a user who no longer exists.
   * `foreign`    not Tern's at all. Listed so a shared index is legible, and
   *              never touched by anything here.
   */
  state: 'current' | 'superseded' | 'orphaned' | 'foreign';
}

export interface IndexStatus {
  reachable: boolean;
  url: string;
  /** What went wrong, when it did. Empty otherwise. */
  detail: string;
  /** The whole embedder identity, and the readable half of it. */
  identity: string;
  model: string;
  users: { userId: number; username: string; indexed: number; pending: number; collection: string }[];
  collections: CollectionView[];
}

/**
 * What is in the index, and whether it matches what this install would write.
 *
 * Never throws on an unreachable index: "Qdrant is down" is the single most
 * useful thing this can report, and a status endpoint that 500s when the thing
 * it reports on is down tells an operator nothing they did not already fear.
 */
export async function indexStatus(): Promise<IndexStatus> {
  const settings = await getAiSettings();
  const identity = embedIdentity(settings);
  const health = await vectors.reachable();

  const users = await query<{ id: number; username: string; indexed: number; pending: number }>(
    `SELECT u.id, u.username,
            (SELECT count(*)::int FROM email_vectors v JOIN accounts a ON a.id=v.account_id
              WHERE a.user_id=u.id AND v.model=$1) AS indexed,
            (SELECT count(*)::int FROM emails e JOIN accounts a ON a.id=e.account_id
              WHERE a.user_id=u.id AND NOT e.embedded) AS pending
       FROM users u ORDER BY u.id`,
    [identity],
  );

  const out: IndexStatus = {
    reachable: health.ok,
    url: config.qdrantUrl,
    detail: health.ok ? '' : health.detail,
    identity,
    model: modelOfIdentity(identity),
    users: users.map((u) => ({
      userId: u.id, username: u.username, indexed: u.indexed, pending: u.pending,
      collection: vectorCollection(u.id, identity),
    })),
    collections: [],
  };
  if (!health.ok) return out;

  const live = new Set(users.map((u) => u.id));
  const current = keepSlugs(identity);
  let names: string[] = [];
  try { names = await vectors.listCollections(); } catch { return out; }
  for (const name of names) {
    const parsed = parseCollection(name);
    let info: { points: number; dims: number } | null = null;
    // One bad collection must not cost the whole listing: an operator looking
    // at this is usually looking at it because something is wrong.
    try { info = await vectors.collectionInfo(name); } catch { /* reported as zeroes */ }
    const state: CollectionView['state'] = !parsed ? 'foreign'
      : !live.has(parsed.userId) ? 'orphaned'
        : current.has(parsed.slug) ? 'current' : 'superseded';
    out.collections.push({
      name, userId: parsed?.userId ?? null,
      points: info?.points ?? 0, dims: info?.dims ?? 0, state,
    });
  }
  // Ours first, and within that the ones that need attention before the ones
  // that do not.
  const rank = { orphaned: 0, superseded: 1, current: 2, foreign: 3 };
  out.collections.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  return out;
}

export interface ResetResult { collectionsDropped: number; manifestRows: number; queued: number }

/**
 * Throw the index away and queue it to be built again.
 *
 * ── Why this is safe, and what it costs ─────────────────────────────────────
 *
 * Vectors are derived data. Everything here can be made again from mail that
 * is still in Postgres, so the worst case of running it is time: meaning
 * search is thin until the background pass catches up, and ordinary word
 * search is unaffected throughout. That is the whole risk, and it is why this
 * can be offered as a button rather than as a documented recovery procedure.
 *
 * ── Why the order is this way round ─────────────────────────────────────────
 *
 * The manifest is cleared first and the collections dropped second, the same
 * argument `invalidateVectorsFrom` makes. A message marked for rebuild whose
 * collection still exists is recoverable — the next pass overwrites it. A
 * collection dropped while the manifest still claims the message is indexed
 * leaves a row nothing will ever look for again.
 *
 * ── What it will not touch ──────────────────────────────────────────────────
 *
 * Collections it cannot parse as Tern's. This Qdrant may be shared, and a
 * reset that emptied everything it could see would be a reset that deletes a
 * stranger's data. Scoped to one user, it will not touch another user's
 * collections either.
 */
export async function resetIndex(opts: { userId?: number } = {}): Promise<ResetResult> {
  const scoped = typeof opts.userId === 'number';
  const manifest = scoped
    ? await query<{ email_id: number }>(
      `DELETE FROM email_vectors v USING accounts a
        WHERE a.id=v.account_id AND a.user_id=$1 RETURNING v.email_id`,
      [opts.userId],
    )
    : await query<{ email_id: number }>('DELETE FROM email_vectors RETURNING email_id');
  const queued = scoped
    ? await query<{ id: number }>(
      `UPDATE emails e SET embedded=false FROM accounts a
        WHERE a.id=e.account_id AND a.user_id=$1 AND e.embedded RETURNING e.id`,
      [opts.userId],
    )
    : await query<{ id: number }>('UPDATE emails SET embedded=false WHERE embedded RETURNING id');
  // Contacts are indexed into their own collection off the same manifest
  // idea, so a reset that left them behind would drop their vectors and go on
  // believing they were indexed.
  if (scoped) {
    await query('DELETE FROM contact_vectors WHERE user_id=$1', [opts.userId]);
    await query('UPDATE contacts SET embedded=false WHERE user_id=$1 AND embedded', [opts.userId]);
  } else {
    await query('DELETE FROM contact_vectors');
    await query('UPDATE contacts SET embedded=false WHERE embedded');
  }

  let dropped = 0;
  try {
    for (const name of await vectors.listCollections()) {
      const parsed = parseCollection(name);
      if (!parsed) continue;
      if (scoped && parsed.userId !== opts.userId) continue;
      try { await vectors.dropCollection(name); dropped += 1; }
      catch (err) { log.error('could not drop a collection during a reset', { name, err: String(err) }); }
    }
  } catch (err) {
    // The rebuild is already queued and the manifest is already clear, so an
    // unreachable index leaves the install in a state that heals itself: the
    // next pass rewrites into whatever is there, and the sweep removes the
    // rest. Reported rather than thrown for exactly that reason.
    log.error('the vector index could not be reached during a reset; collections remain', { err: String(err) });
  }
  // The per-process memo of which collections exist is now wrong.
  vectors.forgetEnsuredCollections();
  forgetEmbedReconciliation();
  log.warn('the vector index was reset', { user: opts.userId ?? 'all', dropped, queued: queued.length });
  return { collectionsDropped: dropped, manifestRows: manifest.length, queued: queued.length };
}

// ---------- Contacts ----------
//
// The search vector covers notes and custom fields, so "Sage" finds everybody
// whose plan is Sage. What it cannot do is find "people who mentioned
// month-end pain", because nobody wrote that phrase — they wrote "always
// chasing invoices in the last week of the month". Word search and meaning
// search fail in opposite directions, which is the whole argument for having
// both, and contacts were the one place only one of them was pointed.

/** What of a contact is worth embedding. Everything somebody typed, nothing generated. */
export function contactText(c: { first_name?: string; last_name?: string; company?: string; title?: string; notes?: string; fields?: Record<string, unknown> }): string {
  const fields = Object.entries(c.fields ?? {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim())
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  // The notes first and at full length: they are the only free text a person
  // wrote about this contact, and the only part a meaning search can find
  // something in that a word search could not.
  return [
    String(c.notes ?? '').trim(),
    [c.first_name, c.last_name].filter(Boolean).join(' '),
    [c.title, c.company].filter(Boolean).join(', '),
    ...fields,
  ].filter(Boolean).join('\n').slice(0, 4000);
}

export async function contactIndexPending(userId: number): Promise<number> {
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE user_id=$1 AND NOT embedded', [userId]);
  return r?.n ?? 0;
}

/**
 * One batch of contacts for one person.
 *
 * Mirrors `indexBatch` deliberately, down to the order of the two writes: the
 * index first and the manifest second, so a failure between them leaves a
 * point with no manifest row — which the next pass rewrites — rather than a
 * manifest row with no point, which nothing would ever look for again.
 */
export async function indexContactsBatch(userId: number, limit = INDEX_BATCH): Promise<{ done: number; remaining: number }> {
  if (!(await allowed(userId, 'semantic'))) return { done: 0, remaining: 0 };
  const settings = await getAiSettings();
  const rows = await query<any>(
    `SELECT id, first_name, last_name, company, title, notes, fields FROM contacts
      WHERE user_id=$1 AND NOT embedded ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit],
  );
  if (!rows.length) return { done: 0, remaining: 0 };

  const texts = rows.map((c) => contactText(c));
  // A contact with nothing written about them still gets marked, or the pass
  // finds them again for ever. A name alone is not worth a vector: the word
  // index already finds a name, and embedding one produces a point that
  // matches every other name.
  const usable = texts.map((t, i) => ({ t, i })).filter((x) => x.t.length > 24);
  if (!usable.length) {
    await query('UPDATE contacts SET embedded=true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    return { done: rows.length, remaining: await contactIndexPending(userId) };
  }

  const { vectors: embedded, model, dims } = await embed(usable.map((x) => x.t), { userId, capability: 'semantic' }, undefined, 'document');
  if (!embedded.length || !dims) return { done: 0, remaining: await contactIndexPending(userId) };
  const rot = await rotationFor_(userId, dims);
  const identity = embedIdentity(settings, model);
  const collection = contactCollection(userId, identity);

  const points: { emailId: number; accountId: number; vector: number[] }[] = [];
  const indexed: number[] = [];
  for (let k = 0; k < usable.length; k++) {
    const v = embedded[k];
    if (!Array.isArray(v) || !v.length) continue;
    const row = rows[usable[k].i];
    // `accountId` is the store's filter field and a contact belongs to no
    // account, so 0 stands for "this person's, all of them" — the contact
    // search passes the same 0 and nothing else can match it.
    points.push({ emailId: row.id, accountId: 0, vector: Array.from(project(rot, v)) });
    indexed.push(row.id);
  }
  if (points.length) {
    await vectors.ensureCollection(collection, points[0]!.vector.length);
    await vectors.upsert(collection, points);
    for (const id of indexed) {
      await query(
        `INSERT INTO contact_vectors (contact_id, user_id, dims, model) VALUES ($1,$2,$3,$4)
         ON CONFLICT (contact_id) DO UPDATE SET dims=EXCLUDED.dims, model=EXCLUDED.model, created_at=now()`,
        [id, userId, points[0]!.vector.length, identity],
      );
    }
  }
  await query('UPDATE contacts SET embedded=true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
  const remaining = await contactIndexPending(userId);
  log.info(`indexed ${rows.length} contacts`, { user: userId, remaining });
  return { done: rows.length, remaining };
}

export interface ContactHit { id: number; score: number }

/**
 * Contacts whose notes mean something like this.
 *
 * Ids and scores only, joined back to `contacts` by the caller — the same
 * split mail search uses, and for the same reason: a point that outlived its
 * contact joins to no row and disappears before anything is rendered.
 */
export async function searchContacts(userId: number, text: string, opts: { limit?: number; minScore?: number } = {}): Promise<ContactHit[]> {
  const q = String(text ?? '').trim();
  if (!q) return [];
  if (!(await allowed(userId, 'semantic'))) return [];
  const settings = await getAiSettings();
  const { vectors: embedded, dims, model } = await embed([q], { userId, capability: 'semantic' }, undefined, 'query');
  if (!embedded[0]?.length || !dims) return [];
  const rot = await rotationFor_(userId, dims);
  const needle = project(rot, embedded[0]);
  const found = await vectors.search(contactCollection(userId, embedIdentity(settings, model)), Array.from(needle), {
    accountIds: [0],
    limit: opts.limit ?? 50,
    minScore: opts.minScore ?? 0.28,
  });
  if (!found.length) return [];
  // Scoped to this person's own rows, whatever the index said.
  const live = await query<{ id: number }>(
    'SELECT id FROM contacts WHERE user_id=$1 AND id = ANY($2)',
    [userId, found.map((h) => h.emailId)],
  );
  const ok = new Set(live.map((r) => r.id));
  return found.filter((h) => ok.has(h.emailId)).map((h) => ({ id: h.emailId, score: h.score }));
}
