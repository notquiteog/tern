// Pushing Tern's drafts into the mail server's Drafts mailbox, so a draft
// begun here is visible in Thunderbird, Apple Mail or the provider's own
// webmail. One direction only: Tern is the editor, the server's Drafts
// folder is a mirror.
//
// JMAP has no way to edit a message in place, so every push imports fresh
// bytes and destroys the copy it replaces. That makes the work worth
// batching: a draft is marked dirty when it is saved and pushed from the
// scheduler once it has been quiet for a moment, rather than on each
// keystroke of autosave.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { clientFor, type AccountRow, getAccount } from './accounts.js';
import { mailboxByRole } from '../jmap/actions.js';
import { buildMime, type Address, type OutgoingAttachment } from '../jmap/send.js';
import { inlineUploadIds, rewriteInlineUploads } from './compose.js';
import { openDraft, type OpenedDraft } from './mailVault.js';
import { scrubMedia } from './scrub.js';
import { touchAccount } from './mailCache.js';

const log = logger('draftsync');

// How long a draft must sit unedited before it is pushed. Long enough that a
// burst of autosaves is one push, short enough that switching to a phone
// finds the draft there.
export const QUIET_MS = 30_000;

export interface DraftRow {
  id: number; user_id: number; account_id: number | null;
  kind: string; reply_to_email_id: number | null; forward_of_email_id: number | null; forward_blob_ids: string[];
  thread_id: string | null;
  to_addr: Address[]; cc_addr: Address[]; bcc_addr: Address[];
  subject: string; body_html: string; attachment_ids: number[];
  jmap_id: string | null; jmap_blob_id: string | null; synced_at: Date | null; sync_error: string | null; sync_dirty: boolean;
  updated_at: Date;
}

export function draftSyncEnabled(acc: AccountRow): boolean {
  return acc.sync_drafts !== false && acc.enabled;
}

// Marks a draft as needing a push. Called wherever a draft is written; the
// scheduler does the talking to the mail server.
export async function markDirty(draftId: number): Promise<void> {
  await query('UPDATE drafts SET sync_dirty=true WHERE id=$1', [draftId]);
}

// The bytes for one draft: the same MIME builder the sender uses, so what
// another client opens is what Tern would have sent, minus the send.
async function buildDraftMime(acc: AccountRow, d: OpenedDraft<DraftRow>): Promise<Buffer> {
  let html = d.body_html || '<p></p>';
  const attachments: OutgoingAttachment[] = [];
  const inlineIds = inlineUploadIds(html);
  if (inlineIds.length) {
    const rows = await query<any>('SELECT id, filename, content_type, data FROM uploads WHERE id = ANY($1) AND user_id=$2', [inlineIds, d.user_id]);
    const cids = new Map<number, string>();
    for (const r of rows) {
      const cid = `img${r.id}.draft@${acc.email.split('@')[1] || 'tern'}`;
      cids.set(r.id, cid);
      attachments.push({ filename: r.filename, content: r.data, contentType: r.content_type, cid });
    }
    // An unpushed upload URL would point back at this server and would not
    // load anywhere else, so inline images become cid parts as they do on send.
    html = rewriteInlineUploads(html, (id) => cids.get(id) ?? null);
  }
  if (d.attachment_ids?.length) {
    const rows = await query<any>('SELECT id, filename, content_type, data FROM uploads WHERE id = ANY($1) AND user_id=$2', [d.attachment_ids, d.user_id]);
    for (const r of rows) attachments.push({ filename: r.filename, content: r.data, contentType: r.content_type });
  }
  for (const a of attachments) a.content = scrubMedia(a.content, a.contentType, a.filename).data;

  // Threading headers, so a reply drafted here lands in the right thread in
  // whichever client opens it.
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (d.reply_to_email_id) {
    const orig = await one<any>('SELECT message_id, references_ids FROM emails WHERE id=$1', [d.reply_to_email_id]);
    if (orig?.message_id?.length) {
      inReplyTo = orig.message_id[0];
      references = [...(orig.references_ids ?? []), orig.message_id[0]].slice(-20);
    }
  }
  const { raw } = await buildMime({
    from: { name: acc.name, email: acc.email },
    to: d.to_addr ?? [], cc: d.cc_addr ?? [], bcc: d.bcc_addr ?? [],
    subject: d.subject ?? '',
    html,
    inReplyTo,
    references,
    attachments,
  });
  return raw;
}

// Imports the draft and drops the copy it replaces. The order matters: the
// new one exists before the old one goes, so a crash in between leaves a
// duplicate rather than nothing.
export async function pushDraft(sealed: DraftRow): Promise<'pushed' | 'skipped'> {
  if (!sealed.account_id) return 'skipped';
  const acc = await getAccount(sealed.account_id);
  if (!acc || acc.user_id !== sealed.user_id || !draftSyncEnabled(acc)) return 'skipped';
  // The row arrives as it sits in the database: subject, body and recipients
  // are ciphertext. Building a message needs the plaintext.
  const d = await openDraft(sealed.user_id, sealed);
  // An entirely empty draft is not worth a message on the server; it is what
  // an abandoned "new mail" window leaves behind.
  if (!(d.subject ?? '').trim() && !stripHtml(d.body_html ?? '').trim() && !(d.to_addr ?? []).length) return 'skipped';
  const box = await mailboxByRole(acc.id, 'drafts');
  if (!box) return 'skipped';

  const client = clientFor(acc);
  await client.ensureSession();
  const accountId = client.session!.accountId;
  const raw = await buildDraftMime(acc, d);
  const blob = await client.upload(raw, 'message/rfc822');
  const res = await client.one('Email/import', {
    accountId,
    emails: { m: { blobId: blob.blobId, mailboxIds: { [box.jmap_id]: true }, keywords: { $draft: true, $seen: true } } },
  });
  const created = res.created?.m;
  if (!created) {
    const err = res.notCreated?.m;
    // A server that already holds these exact bytes says so; that is success.
    if (err?.type === 'alreadyExists' && err.existingId) {
      await query('UPDATE drafts SET jmap_id=$2, jmap_blob_id=$3, synced_at=now(), sync_dirty=false, sync_error=NULL WHERE id=$1', [d.id, err.existingId, blob.blobId]);
      return 'pushed';
    }
    throw new Error(`${err?.type ?? 'unknown'}${err?.description ? ' - ' + err.description : ''}`);
  }
  if (d.jmap_id && d.jmap_id !== created.id) {
    try { await client.one('Email/set', { accountId, destroy: [d.jmap_id] }); } catch { /* the old copy may be gone already */ }
    await query('DELETE FROM emails WHERE account_id=$1 AND jmap_id=$2', [acc.id, d.jmap_id]);
      touchAccount(acc.id);
  }
  await query('UPDATE drafts SET jmap_id=$2, jmap_blob_id=$3, synced_at=now(), sync_dirty=false, sync_error=NULL WHERE id=$1', [d.id, created.id, blob.blobId]);
  return 'pushed';
}

// Removes the server's copy. Called when a draft is deleted and when one is
// sent, so the Drafts folder does not keep a stale twin of a sent message.
export async function removeDraft(userId: number, draft: { account_id: number | null; jmap_id: string | null }): Promise<void> {
  if (!draft.jmap_id || !draft.account_id) return;
  const acc = await getAccount(draft.account_id);
  if (!acc || acc.user_id !== userId) return;
  try {
    const client = clientFor(acc);
    await client.ensureSession();
    await client.one('Email/set', { accountId: client.session!.accountId, destroy: [draft.jmap_id] });
    await query('DELETE FROM emails WHERE account_id=$1 AND jmap_id=$2', [acc.id, draft.jmap_id]);
  } catch (e) {
    log.warn('could not remove the server copy of a draft', { err: (e as Error).message });
  }
}

// One pass over the drafts that need pushing. Errors are recorded on the row
// and the draft stays dirty, so a mail server that is down is retried later
// without blocking the rest of the tick.
export async function pushDirtyDrafts(limit = 20): Promise<{ pushed: number; failed: number }> {
  const rows = await query<DraftRow>(
    `SELECT d.* FROM drafts d JOIN accounts a ON a.id = d.account_id
      WHERE d.sync_dirty AND a.enabled AND a.sync_drafts AND d.updated_at < now() - ($1 || ' milliseconds')::interval
      ORDER BY d.updated_at LIMIT $2`,
    [String(QUIET_MS), limit],
  );
  let pushed = 0, failed = 0;
  for (const d of rows) {
    try {
      if (await pushDraft(d) === 'pushed') pushed++;
      else await query('UPDATE drafts SET sync_dirty=false, sync_error=NULL WHERE id=$1', [d.id]);
    } catch (e) {
      failed++;
      const msg = (e as Error).message.slice(0, 300);
      await query('UPDATE drafts SET sync_error=$2 WHERE id=$1', [d.id, msg]);
      log.warn(`draft ${d.id} could not be pushed`, { err: msg });
    }
  }
  return { pushed, failed };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim();
}
