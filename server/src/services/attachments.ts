// F5: the text inside an attachment, made searchable.
//
// Before this, everything the index knew about an invoice was that a file
// called invoice.pdf existed. Now the words in it join the same blind index
// as the body — hashed under the owner's key, never in the clear — and the
// text itself is sealed beside the message so a reply can quote a figure
// from the attachment rather than asking for it again.
//
// The parsing is in extract.ts and has no idea any of this exists. This file
// is the part that talks to the mail server and the database: which files to
// fetch, how much to spend, and what to write down.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { clientFor } from './accounts.js';
import type { AccountRow } from './accounts.js';
import { canExtract, extract, MAX_INPUT_BYTES } from './extract.js';
import { dataKey, indexTermsWith, openWith, searchKey, sealWith } from './vault.js';
import { openEmails } from './mailVault.js';
import { allowed } from './capabilities.js';

const log = logger('attachments');

// Messages per pass, and files per message. Both small: this runs on the
// scheduler tick, each file is a download and a parse, and a mailbox with a
// decade of attachments should trickle rather than stall.
export const EXTRACT_BATCH = 4;
const MAX_PARTS_PER_MESSAGE = 8;

export interface AttachmentRef { blobId: string; name: string | null; type: string; size: number }

export async function extractPending(userId: number, acc: AccountRow, limit = EXTRACT_BATCH): Promise<number> {
  if (!(await allowed(userId, 'attachments'))) return 0;
  const rows = await query<any>(
    `SELECT id, attachments, search_terms FROM emails
      WHERE account_id=$1 AND has_attachment AND NOT attachments_extracted
      ORDER BY received_at DESC LIMIT $2`,
    [acc.id, limit],
  );
  if (!rows.length) return 0;

  const opened = await openEmails(userId, 'attachments', rows);
  const dek = await dataKey(userId);
  const sk = searchKey(dek);

  for (let i = 0; i < opened.length; i++) {
    const row = rows[i];
    const parts: AttachmentRef[] = (opened[i].attachments as AttachmentRef[] ?? [])
      .filter((p) => p?.blobId && canExtract(p.type ?? '', p.name))
      .slice(0, MAX_PARTS_PER_MESSAGE);

    const found: string[] = [];
    for (const part of parts) {
      // The file's own name is content — "Redundancy letter Ana.pdf" says
      // plenty — so it travels sealed, like the text.
      const sealedName = part.name ? sealWith(dek, part.name) : null;
      if (part.size > MAX_INPUT_BYTES) {
        await record(row.id, acc.id, part, sealedName, null, 'larger than the reading limit');
        continue;
      }
      let buf: Buffer;
      try {
        const res = await clientFor(acc).download(part.blobId, part.name ?? 'attachment', part.type ?? 'application/octet-stream');
        if (!res.ok) { await record(row.id, acc.id, part, sealedName, null, `download failed: HTTP ${res.status}`); continue; }
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        await record(row.id, acc.id, part, sealedName, null, (e as Error).message.slice(0, 200));
        continue;
      }
      const out = extract(buf, part.type ?? '', part.name);
      // The bytes are gone from here either way; only the words are kept, and
      // those are sealed.
      buf.fill(0);
      if (out.text) found.push(out.text);
      await record(row.id, acc.id, part, sealedName, out.text ? sealWith(dek, out.text) : null, out.note ?? null, out.text.length);
    }

    // The extracted words join the message's own blind index, so one search
    // covers the body and everything attached to it. Existing terms are kept:
    // this adds to the row rather than replacing what sealEmail wrote.
    if (found.length) {
      const extra = indexTermsWith(sk, found.join('\n').slice(0, 400_000));
      await query(
        `UPDATE emails SET search_terms = (
            SELECT array_agg(DISTINCT t) FROM unnest(search_terms || $2::bytea[]) AS t
          ), attachments_extracted = true WHERE id = $1`,
        [row.id, extra],
      );
    } else {
      await query('UPDATE emails SET attachments_extracted=true WHERE id=$1', [row.id]);
    }
  }
  log.info(`read the attachments on ${rows.length} messages`, { account: acc.id });
  return rows.length;
}

async function record(emailId: number, accountId: number, part: AttachmentRef, sealedName: string | null, sealedText: string | null, error: string | null, chars = 0): Promise<void> {
  await query(
    `INSERT INTO attachment_text (email_id, account_id, part_id, name, content_type, text, chars, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (email_id, part_id) DO UPDATE SET text=EXCLUDED.text, chars=EXCLUDED.chars, error=EXCLUDED.error, created_at=now()`,
    // The blob id is the part key; the name is sealed; the media type is
    // not content and stays readable so a listing can group by it.
    [emailId, accountId, part.blobId, sealedName, part.type ?? '', sealedText, chars, error],
  );
}

// What was read out of one message's attachments, for the reading pane and
// for a model that has been asked to answer about them.
export async function textFor(userId: number, emailId: number): Promise<{ name: string | null; type: string; text: string; chars: number; error: string | null }[]> {
  const rows = await query<any>(
    `SELECT t.name, t.content_type, t.text, t.chars, t.error
       FROM attachment_text t JOIN accounts a ON a.id=t.account_id
      WHERE t.email_id=$1 AND a.user_id=$2 ORDER BY t.id`,
    [emailId, userId],
  );
  if (!rows.length) return [];
  const dek = await dataKey(userId);
  return rows.map((r) => ({
    name: r.name ? openWith(dek, r.name) : null,
    type: r.content_type,
    text: r.text ? openWith(dek, r.text) ?? '' : '',
    chars: r.chars,
    error: r.error,
  }));
}

export async function pendingCount(userId: number): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND e.has_attachment AND NOT e.attachments_extracted`,
    [userId],
  );
  return r?.n ?? 0;
}
