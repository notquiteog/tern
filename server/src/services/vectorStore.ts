// The vector index: Qdrant, one collection per user.
//
// ── Why a collection per user, and when that stops being right ─────────────
//
// Vectors are rotated with a per-user key before they are stored (see
// `services/embeddings.ts`). The rotation is orthogonal, so cosine similarity
// is preserved exactly — but it means one user's vectors live in a different
// space from another's.
//
// That rules out the obvious layout of one collection with a `user_id` filter,
// and for a stronger reason than wasted work. HNSW builds its graph from the
// distances between the points it holds; with several rotations mixed in, the
// neighbourhood structure is built from distances that mean nothing across
// users. A filtered search then walks a graph whose edges were chosen by
// meaningless comparisons, so recall drops *within* the user being searched,
// not merely across the others. Filtered HNSW is also weakest exactly where
// this filter sits — highly selective, one user out of N.
//
// Two things fall out for free: closing an account drops a collection instead
// of scanning for points, and re-keying a user is a rebuild rather than a
// surgical rewrite.
//
// **The bound worth writing down:** collections are not free — each carries
// segment and index overhead — so this is right for an install with tens of
// users and wrong for one with tens of thousands. Tern's shape is a small team
// on one box. If that changes, the answer is not "add a filter", it is to stop
// rotating per user or to shard collections by group, and both are decisions
// with their own costs.
//
// ── The collection name carries the model ─────────────────────────────────
//
// Vectors made by one embedding model cannot be compared with another's, and
// the width differs too. Putting the model in the name means a model change
// writes into a new collection rather than poisoning the old one, and the old
// one can be dropped when nothing points at it. It is the same property
// cryptostore gets from an alias swap, arrived at more cheaply because Tern
// already re-indexes the whole mailbox on a model change
// (`reconcileEmbedModel` in `semantic.ts`).
import { config } from '../config.js';
import { outboundFetch, type TlsTrust } from '../util/outbound.js';
import { logger } from '../log.js';

const log = logger('vectors');

/** One neighbour, as the index reports it. Content comes from Postgres. */
export interface VectorHit { emailId: number; score: number }

function trust(): TlsTrust {
  return { insecure: config.qdrantTlsInsecure };
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(config.qdrantApiKey ? { 'api-key': config.qdrantApiKey } : {}),
  };
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${config.qdrantUrl}${path}`;
  const res = await outboundFetch(url, { ...init, headers: headers() }, trust());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`qdrant ${init.method ?? 'GET'} ${path} answered ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * The collection one user's vectors live in, for one embedding model.
 *
 * The model is slugged rather than hashed so an operator looking at
 * `GET /collections` can see what is there. Qdrant accepts a wide range of
 * names; this keeps to a narrow one so nothing has to be escaped.
 */
export function collectionFor(userId: number, model: string): string {
  const slug = String(model).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `tern_u${userId}_${slug}`;
}

/** Collections this process has already ensured, so a batch does not re-ask. */
const ensured = new Set<string>();

export function forgetEnsuredCollections(): void { ensured.clear(); }

/**
 * Create the collection if it is not there.
 *
 * `Cosine` because that is what the scores mean everywhere else in Tern, and
 * because the keyed rotation preserves it exactly — a dot-product distance
 * would not survive the per-vector normalisation the store does.
 */
export async function ensureCollection(name: string, dims: number): Promise<void> {
  if (ensured.has(name)) return;
  const res = await outboundFetch(`${config.qdrantUrl}/collections/${name}`, { headers: headers() }, trust());
  if (res.ok) { ensured.add(name); return; }
  if (res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`qdrant could not be asked about ${name}: ${res.status} ${body.slice(0, 200)}`);
  }
  await call(`/collections/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: dims, distance: 'Cosine' } }),
  });
  log.info('created a vector collection', { name, dims });
  ensured.add(name);
}

/**
 * Write vectors.
 *
 * The payload is deliberately almost empty. Everything a caller needs to show
 * — subject, sender, thread, mailbox — is in Postgres, and asking Qdrant to
 * carry a copy would mean keeping two records of the same fact in step. The
 * one field here is `account_id`, because filtering by account has to happen
 * *inside* the search or the top-k comes back full of another account's mail.
 */
export async function upsert(
  name: string,
  points: { emailId: number; accountId: number; vector: number[] }[],
): Promise<void> {
  if (!points.length) return;
  await call(`/collections/${name}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({
      points: points.map((p) => ({
        id: p.emailId,
        vector: p.vector,
        payload: { account_id: p.accountId },
      })),
    }),
  });
}

/**
 * Nearest neighbours, filtered to the accounts asked for.
 *
 * Returns ids and scores and nothing else — the caller joins back to Postgres,
 * which is what keeps a point that outlived its email from ever surfacing
 * content. An orphaned vector joins to no row and disappears before anything
 * is rendered, so the cascade's privacy guarantee holds by construction rather
 * than by a sweep having run recently.
 */
export async function search(
  name: string,
  vector: number[],
  opts: { accountIds: number[]; limit: number; minScore: number },
): Promise<VectorHit[]> {
  const res = await outboundFetch(
    `${config.qdrantUrl}/collections/${name}/points/search`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        vector,
        limit: opts.limit,
        score_threshold: opts.minScore,
        with_payload: false,
        with_vector: false,
        filter: { must: [{ key: 'account_id', match: { any: opts.accountIds } }] },
      }),
    },
    trust(),
  );
  // A collection that does not exist yet is not an error: it is a mailbox
  // nobody has indexed. Answering "no matches" is the truth, and creating it
  // here would write an empty collection on every search of an unindexed
  // account.
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`qdrant search on ${name} answered ${res.status}: ${body.slice(0, 300)}`);
  }
  const body = await res.json() as { result?: { id?: unknown; score?: unknown }[] };
  return (body.result ?? [])
    .map((r) => ({ emailId: Number(r.id), score: Number(r.score) }))
    .filter((h) => Number.isFinite(h.emailId) && Number.isFinite(h.score));
}

/**
 * "More like this", from a point already in the index.
 *
 * Qdrant is asked to recommend from the stored vector rather than Tern
 * fetching it and searching by value — which is the whole reason the vectors
 * can leave Postgres at all. There is no round trip carrying an embedding, and
 * nothing here has to know the width or the rotation.
 *
 * A seed that is not in the collection comes back empty rather than as an
 * error: it means the message has not been indexed yet, which is an ordinary
 * state and not a fault.
 */
export async function recommend(
  name: string,
  seedEmailId: number,
  opts: { accountIds: number[]; limit: number; minScore: number },
): Promise<VectorHit[]> {
  const res = await outboundFetch(
    `${config.qdrantUrl}/collections/${name}/points/recommend`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        positive: [seedEmailId],
        limit: opts.limit,
        score_threshold: opts.minScore,
        with_payload: false,
        with_vector: false,
        filter: { must: [{ key: 'account_id', match: { any: opts.accountIds } }] },
      }),
    },
    trust(),
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // A seed the collection does not hold is a 400 here, and it is not a
    // failure worth propagating: "no similar messages" is the honest answer.
    if (res.status === 400) return [];
    throw new Error(`qdrant recommend on ${name} answered ${res.status}: ${body.slice(0, 300)}`);
  }
  const body = await res.json() as { result?: { id?: unknown; score?: unknown }[] };
  return (body.result ?? [])
    .map((r) => ({ emailId: Number(r.id), score: Number(r.score) }))
    .filter((h) => Number.isFinite(h.emailId) && Number.isFinite(h.score) && h.emailId !== seedEmailId);
}

/** Forget specific messages — used when mail is deleted while the index is up. */
export async function deletePoints(name: string, emailIds: number[]): Promise<void> {
  if (!emailIds.length) return;
  await call(`/collections/${name}/points/delete?wait=true`, {
    method: 'POST',
    body: JSON.stringify({ points: emailIds }),
  });
}

/** Drop a whole collection — a closed account, or a model that has moved on. */
export async function dropCollection(name: string): Promise<void> {
  const res = await outboundFetch(`${config.qdrantUrl}/collections/${name}`, { method: 'DELETE', headers: headers() }, trust());
  ensured.delete(name);
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`qdrant could not drop ${name}: ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Every collection Tern owns, newest listing from the server. */
export async function listCollections(): Promise<string[]> {
  const body = await call('/collections') as { result?: { collections?: { name?: unknown }[] } };
  return (body.result?.collections ?? [])
    .map((c) => String(c.name ?? ''))
    .filter((n) => n.startsWith('tern_u'));
}

/** Is the index reachable? Used by the settings page and by `bin/tern`. */
export async function reachable(): Promise<{ ok: boolean; detail: string }> {
  try {
    await call('/collections');
    return { ok: true, detail: config.qdrantUrl };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
