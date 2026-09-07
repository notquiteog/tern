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
import { embed } from '../ai/llm.js';
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
export function embeddableText(m: { subject?: string | null; body_text?: string | null; body_html?: string | null; preview?: string | null }): string {
  const body = (m.body_text || htmlToText(m.body_html || '') || m.preview || '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/^\s*On .{0,120}wrote:\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const subject = String(m.subject ?? '').trim();
  // Two thousand characters is about what a small embedding model can hold
  // without truncation, and the top of an email is where its subject matter
  // lives.
  return `${subject}\n\n${body}`.slice(0, 2000).trim();
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

// ---------- Indexing ----------

export async function indexPending(userId: number): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND NOT e.embedded`,
    [userId],
  );
  return r?.n ?? 0;
}

// One batch for one person. Returns how many were written, so the caller can
// keep going while there is work and stop asking when there is not.
export async function indexBatch(userId: number, limit = INDEX_BATCH): Promise<{ done: number; remaining: number }> {
  if (!(await allowed(userId, 'semantic'))) return { done: 0, remaining: 0 };
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
  const texts = opened.map((m) => embeddableText(m));
  // A message with nothing in it still gets marked, or the pass would find
  // it again for ever.
  const usable = texts.map((t, i) => ({ t, i })).filter((x) => x.t.length > 8);
  if (!usable.length) {
    await query('UPDATE emails SET embedded=true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    return { done: rows.length, remaining: await indexPending(userId) };
  }

  const { vectors, model, dims } = await embed(usable.map((x) => x.t), { userId, capability: 'semantic' });
  if (!vectors.length || !dims) return { done: 0, remaining: await indexPending(userId) };
  const rot = await rotationFor_(userId, dims);

  for (let k = 0; k < usable.length; k++) {
    const v = vectors[k];
    if (!Array.isArray(v) || !v.length) continue;
    const row = rows[usable[k].i];
    const stored = project(rot, v);
    await query(
      `INSERT INTO email_vectors (email_id, account_id, vec, dims, model)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email_id) DO UPDATE SET vec=EXCLUDED.vec, dims=EXCLUDED.dims, model=EXCLUDED.model, created_at=now()`,
      [row.id, row.account_id, toBuffer(stored), stored.length, model],
    );
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
// The rows are marked for re-indexing rather than deleted: search keeps
// answering from what is there while the background pass rebuilds them, which
// is a much better failure than an empty index for the length of a rebuild.
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
  const { vectors, dims } = await embed([query_], { userId, capability: 'semantic' });
  if (!vectors[0]?.length || !dims) return [];
  const rot = await rotationFor_(userId, dims);
  const needle = project(rot, vectors[0]);

  const rows = await query<{ email_id: number; account_id: number; thread_id: string; vec: Buffer }>(
    `SELECT v.email_id, v.account_id, e.thread_id, v.vec
       FROM email_vectors v
       JOIN emails e ON e.id = v.email_id
       JOIN accounts a ON a.id = v.account_id
      WHERE a.user_id = $1 AND v.account_id = ANY($2) AND v.dims = $3
        AND ($4::text[] IS NULL OR e.mailbox_ids && $4::text[])`,
    [userId, accountIds, needle.length, opts.mailboxIds?.length ? opts.mailboxIds : null],
  );

  const minScore = opts.minScore ?? 0.28;
  const hits: SemanticHit[] = [];
  for (const r of rows) {
    const score = similarity(needle, fromBuffer(r.vec));
    if (score >= minScore) hits.push({ emailId: r.email_id, accountId: r.account_id, threadId: r.thread_id, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.limit ?? 60);
}

// "More like this": the same scan, with a message that is already indexed as
// the needle. No model call at all, so it is free and instant.
export async function similarTo(userId: number, emailId: number, limit = 10): Promise<SemanticHit[]> {
  const seed = await one<{ vec: Buffer; dims: number; account_id: number }>(
    `SELECT v.vec, v.dims, v.account_id FROM email_vectors v
       JOIN accounts a ON a.id=v.account_id
      WHERE v.email_id=$1 AND a.user_id=$2`,
    [emailId, userId],
  );
  if (!seed) return [];
  const needle = fromBuffer(seed.vec);
  const rows = await query<{ email_id: number; account_id: number; thread_id: string; vec: Buffer }>(
    `SELECT v.email_id, v.account_id, e.thread_id, v.vec
       FROM email_vectors v JOIN emails e ON e.id=v.email_id JOIN accounts a ON a.id=v.account_id
      WHERE a.user_id=$1 AND v.dims=$2 AND v.email_id <> $3`,
    [userId, seed.dims, emailId],
  );
  return rows
    .map((r) => ({ emailId: r.email_id, accountId: r.account_id, threadId: r.thread_id, score: similarity(needle, fromBuffer(r.vec)) }))
    .filter((h) => h.score >= 0.4)
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
