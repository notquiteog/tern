// Encrypting a cache that already exists. An install upgrading to at-rest
// encryption has mail in the clear; this walks it in small batches from the
// scheduler so the app keeps working throughout. Reads do not care which
// state a row is in — an unsealed value has no "k1." prefix and the vault
// hands it back unchanged — so there is no cutover moment.
import { one, query, withTx } from '../db.js';
import { logger } from '../log.js';
import { sealEmail } from './mailVault.js';
import { sealWith, dataKey } from './vault.js';

const log = logger('backfill');

export interface BackfillProgress { done: number; remaining: number; finished: boolean }

// How many messages one pass converts. Small enough that a pass is quick and
// the transaction is short; the scheduler calls it every tick until nothing
// is left.
const BATCH = 200;

export async function backfillBatch(limit = BATCH): Promise<BackfillProgress> {
  const rows = await query<any>(
    `SELECT e.id, a.user_id, e.subject, e.preview, e.body_text, e.body_html,
            e.from_addr, e.to_addr, e.cc_addr, e.bcc_addr, e.reply_to, e.attachments
       FROM emails e JOIN accounts a ON a.id = e.account_id
      WHERE NOT e.sealed ORDER BY e.id LIMIT $1`,
    [limit],
  );
  if (!rows.length) {
    const left = await one<{ n: number }>('SELECT count(*)::int AS n FROM emails WHERE NOT sealed');
    return { done: 0, remaining: left?.n ?? 0, finished: (left?.n ?? 0) === 0 };
  }
  let done = 0;
  for (const r of rows) {
    try {
      const sealed = await sealEmail(r.user_id, {
        subject: r.subject ?? '',
        preview: r.preview ?? '',
        body_text: r.body_text ?? null,
        body_html: r.body_html ?? null,
        from_addr: parse(r.from_addr), to_addr: parse(r.to_addr), cc_addr: parse(r.cc_addr), bcc_addr: parse(r.bcc_addr), reply_to: parse(r.reply_to),
        attachments: parse(r.attachments),
      });
      await query(
        `UPDATE emails SET subject=$2, preview=$3, body_text=$4, body_html=$5, from_addr=$6, to_addr=$7, cc_addr=$8, bcc_addr=$9, reply_to=$10,
           attachments=$11, search_terms=$12, address_terms=$13, from_terms=$14, sealed=true WHERE id=$1 AND NOT sealed`,
        [r.id, sealed.subject, sealed.preview, sealed.body_text, sealed.body_html, sealed.from_addr, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.reply_to,
          sealed.attachments, sealed.search_terms, sealed.address_terms, sealed.from_terms],
      );
      done++;
    } catch (e) {
      // One unreadable row must not stall the walk. Marking it sealed is
      // wrong, so it is left for a later pass and reported.
      log.warn(`could not encrypt email ${r.id}`, { err: (e as Error).message });
    }
  }
  const left = await one<{ n: number }>('SELECT count(*)::int AS n FROM emails WHERE NOT sealed');
  return { done, remaining: left?.n ?? 0, finished: (left?.n ?? 0) === 0 };
}

// Drafts and queued messages are few, so they convert in one go the first
// time round rather than needing their own progress tracking.
export async function backfillDraftsAndOutbox(): Promise<{ drafts: number; outbox: number; reviews: number }> {
  let drafts = 0, outbox = 0, reviews = 0;
  const draftRows = await query<any>(`SELECT id, user_id, subject, body_html, to_addr, cc_addr, bcc_addr FROM drafts WHERE subject NOT LIKE 'k1.%' OR body_html NOT LIKE 'k1.%' LIMIT 500`);
  for (const d of draftRows) {
    try {
      const dek = await dataKey(d.user_id);
      await query('UPDATE drafts SET subject=$2, body_html=$3, to_addr=$4, cc_addr=$5, bcc_addr=$6 WHERE id=$1', [
        d.id,
        d.subject?.startsWith('k1.') ? d.subject : sealWith(dek, d.subject ?? ''),
        d.body_html?.startsWith('k1.') ? d.body_html : sealWith(dek, d.body_html ?? ''),
        d.to_addr?.startsWith('k1.') ? d.to_addr : sealWith(dek, d.to_addr ?? '[]'),
        d.cc_addr?.startsWith('k1.') ? d.cc_addr : sealWith(dek, d.cc_addr ?? '[]'),
        d.bcc_addr?.startsWith('k1.') ? d.bcc_addr : sealWith(dek, d.bcc_addr ?? '[]'),
      ]);
      drafts++;
    } catch (e) { log.warn(`could not encrypt draft ${d.id}`, { err: (e as Error).message }); }
  }
  const reviewRows = await query<any>(`SELECT id, user_id, subject, body_html, context, to_addr FROM review_queue WHERE subject NOT LIKE 'k1.%' OR body_html NOT LIKE 'k1.%' LIMIT 500`);
  for (const r of reviewRows) {
    try {
      const dek = await dataKey(r.user_id);
      const keep = (v: string | null, fallback: string | null) => (v === null || v === undefined ? fallback : v.startsWith('k1.') ? v : sealWith(dek, v));
      await query('UPDATE review_queue SET subject=$2, body_html=$3, context=$4, to_addr=$5 WHERE id=$1', [
        r.id, keep(r.subject, ''), keep(r.body_html, ''), keep(r.context, null), keep(r.to_addr, null),
      ]);
      reviews++;
    } catch (e) { log.warn(`could not encrypt review item ${r.id}`, { err: (e as Error).message }); }
  }
  const outRows = await query<any>(`SELECT id, user_id, payload FROM outbox WHERE payload IS NOT NULL AND payload NOT LIKE 'k1.%' LIMIT 500`);
  for (const o of outRows) {
    try {
      await query('UPDATE outbox SET payload=$2 WHERE id=$1', [o.id, sealWith(await dataKey(o.user_id), o.payload)]);
      outbox++;
    } catch (e) { log.warn(`could not encrypt outbox ${o.id}`, { err: (e as Error).message }); }
  }
  return { drafts, outbox, reviews };
}

// Whether there is anything left to do at all, so the scheduler can stop
// asking once an install is fully converted.
export async function backfillPending(): Promise<number> {
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM emails WHERE NOT sealed');
  return r?.n ?? 0;
}

// Converts everything, for `tern cli encrypt-cache`. Same batches, no pauses.
export async function backfillAll(onProgress?: (p: BackfillProgress) => void): Promise<number> {
  let total = 0;
  await backfillDraftsAndOutbox();
  for (;;) {
    const p = await backfillBatch();
    total += p.done;
    onProgress?.(p);
    if (p.finished || p.done === 0) break;
  }
  return total;
}

function parse(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Re-wrapping every data key under a new master key, for ENCRYPTION_KEY
// rotation: the mail itself is untouched, only the few rows that wrap the
// keys. Takes the old key explicitly because config already holds the new one.
export async function rewrapDataKeys(decryptWithOld: (wrapped: string) => string): Promise<number> {
  const users = await query<{ id: number; dek_wrapped: string }>('SELECT id, dek_wrapped FROM users WHERE dek_wrapped IS NOT NULL');
  let n = 0;
  await withTx(async (c) => {
    const { encrypt } = await import('../crypto.js');
    for (const u of users) {
      const raw = decryptWithOld(u.dek_wrapped);
      await c.query('UPDATE users SET dek_wrapped=$2 WHERE id=$1', [u.id, encrypt(raw)]);
      n++;
    }
  });
  return n;
}
