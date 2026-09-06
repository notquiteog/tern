// Mailbox and email synchronisation. The local database is a cache of the
// server; the server is always right. Initial sync pages the newest N
// messages, then Email/changes keeps it current. A server that cannot
// calculate changes any more (state too old) triggers a full resync rather
// than a silent gap.
import { query, withTx } from '../db.js';
import { logger } from '../log.js';
import { config } from '../config.js';
import { publish } from '../events.js';
import { clientFor, connectAccount, getAccount, type AccountRow } from '../services/accounts.js';
import { JmapError, MAIL, CORE, type JmapClient } from './client.js';
import { onNewEmails } from '../services/automation.js';
import { notifyNewMail } from '../services/push.js';

const log = logger('sync');

const EMAIL_PROPS = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'sentAt',
  'messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo',
  'subject', 'preview', 'hasAttachment', 'bodyValues', 'textBody', 'htmlBody', 'attachments',
  'header:Auto-Submitted:asText', 'header:List-Unsubscribe:asText', 'header:List-Id:asText', 'header:List-Id:asRaw', 'header:Precedence:asText',
];
const MAILBOX_PROPS = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];

const running = new Map<number, Promise<SyncResult>>();
export interface SyncResult { created: number; updated: number; destroyed: number; full: boolean }

export function isSyncing(accountId: number): boolean {
  return running.has(accountId);
}

// One sync per account at a time. A second request while one is running
// coalesces onto the running one; callers that need "sync after my change"
// should call again once it resolves (syncManager does exactly that).
export function syncAccount(accountId: number, opts: { full?: boolean } = {}): Promise<SyncResult> {
  const existing = running.get(accountId);
  if (existing) return existing;
  const p = doSync(accountId, opts).finally(() => running.delete(accountId));
  running.set(accountId, p);
  return p;
}

async function doSync(accountId: number, opts: { full?: boolean }): Promise<SyncResult> {
  const acc = await getAccount(accountId);
  if (!acc || !acc.enabled) return { created: 0, updated: 0, destroyed: 0, full: false };
  await query(`UPDATE accounts SET sync_status='syncing' WHERE id=$1`, [acc.id]);
  publish({ type: 'account', userId: acc.user_id, accountId: acc.id, status: 'syncing' });
  try {
    if (!acc.api_url || !acc.jmap_account_id) {
      await connectAccount(acc);
      Object.assign(acc, await getAccount(accountId));
    }
    const client = clientFor(acc);
    await syncMailboxes(acc, client);
    let result: SyncResult;
    if (opts.full || !acc.email_state) {
      result = await fullSync(acc, client);
    } else {
      try {
        result = await incrementalSync(acc, client);
      } catch (e) {
        if (e instanceof JmapError && (e.type === 'cannotCalculateChanges' || e.type === 'invalidArguments')) {
          log.warn(`account ${acc.id}: server cannot calculate changes, running a full resync`);
          result = await fullSync(acc, client);
        } else throw e;
      }
    }
    await query(`UPDATE accounts SET sync_status='idle', sync_error=NULL, last_sync_at=now(), initial_sync_done=true WHERE id=$1`, [acc.id]);
    publish({ type: 'sync', userId: acc.user_id, accountId: acc.id, created: result.created });
    publish({ type: 'account', userId: acc.user_id, accountId: acc.id, status: 'idle' });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e instanceof JmapError && e.type === 'unauthorized' ? 'auth_error' : 'error';
    log.error(`account ${acc.id} sync failed`, { err: msg });
    await query(`UPDATE accounts SET sync_status=$2, sync_error=$3 WHERE id=$1`, [acc.id, status, msg.slice(0, 500)]);
    if (status === 'auth_error') {
      // Force a fresh session next time; the stored URLs may be stale too.
      await query(`UPDATE accounts SET api_url=NULL WHERE id=$1`, [acc.id]);
    }
    publish({ type: 'account', userId: acc.user_id, accountId: acc.id, status, error: msg });
    throw e;
  }
}

async function syncMailboxes(acc: AccountRow, client: JmapClient): Promise<void> {
  const res = await client.one('Mailbox/get', { accountId: client.session!.accountId, ids: null, properties: MAILBOX_PROPS });
  const list: any[] = res.list ?? [];
  await withTx(async (c) => {
    const seen: string[] = [];
    for (const m of list) {
      seen.push(m.id);
      await c.query(
        `INSERT INTO mailboxes (account_id, jmap_id, name, parent_id, role, sort_order, total_emails, unread_emails, total_threads, unread_threads)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (account_id, jmap_id) DO UPDATE SET name=EXCLUDED.name, parent_id=EXCLUDED.parent_id, role=EXCLUDED.role, sort_order=EXCLUDED.sort_order,
           total_emails=EXCLUDED.total_emails, unread_emails=EXCLUDED.unread_emails, total_threads=EXCLUDED.total_threads, unread_threads=EXCLUDED.unread_threads`,
        [acc.id, m.id, m.name, m.parentId ?? null, m.role ?? null, m.sortOrder ?? 0, m.totalEmails ?? 0, m.unreadEmails ?? 0, m.totalThreads ?? 0, m.unreadThreads ?? 0],
      );
    }
    if (seen.length) await c.query(`DELETE FROM mailboxes WHERE account_id=$1 AND NOT (jmap_id = ANY($2))`, [acc.id, seen]);
    await c.query(`UPDATE accounts SET mailbox_state=$2 WHERE id=$1`, [acc.id, res.state ?? null]);
  });
}

async function fullSync(acc: AccountRow, client: JmapClient): Promise<SyncResult> {
  const accountId = client.session!.accountId;
  const limit = acc.sync_limit || config.initialSyncLimit;
  const pageSize = 100;
  let position = 0;
  let created = 0, updated = 0;
  let state: string | null = null;
  const keep: string[] = [];
  // Capture the state before paging: anything that changes during the walk
  // shows up in the next Email/changes call instead of being lost.
  const first = await client.one('Email/get', { accountId, ids: [], properties: ['id'] });
  state = first.state;
  while (position < limit) {
    const [[, q], [, g]] = await client.call([
      ['Email/query', { accountId, sort: [{ property: 'receivedAt', isAscending: false }], position, limit: Math.min(pageSize, limit - position), calculateTotal: false }, 'q'],
      ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: EMAIL_PROPS, fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: config.maxBodyBytes }, 'g'],
    ]);
    const ids: string[] = q.ids ?? [];
    if (!ids.length) break;
    const r = await upsertEmails(acc, g.list ?? [], { runAutomation: acc.initial_sync_done });
    created += r.created; updated += r.updated;
    keep.push(...ids);
    position += ids.length;
    if (ids.length < pageSize) break;
  }
  // Rows the server no longer lists (deleted, or older than the window
  // after a resync) are dropped so the cache never shows ghosts.
  const del = await query<{ n: number }>(
    `WITH d AS (DELETE FROM emails WHERE account_id=$1 AND NOT (jmap_id = ANY($2)) RETURNING 1) SELECT count(*)::int AS n FROM d`,
    [acc.id, keep],
  );
  await query(`UPDATE accounts SET email_state=$2 WHERE id=$1`, [acc.id, state]);
  return { created, updated, destroyed: del[0]?.n ?? 0, full: true };
}

async function incrementalSync(acc: AccountRow, client: JmapClient): Promise<SyncResult> {
  const accountId = client.session!.accountId;
  let since = acc.email_state!;
  let created = 0, updated = 0, destroyed = 0;
  for (let guard = 0; guard < 50; guard++) {
    const ch = await client.one('Email/changes', { accountId, sinceState: since, maxChanges: 500 });
    const changedIds: string[] = [...new Set([...(ch.created ?? []), ...(ch.updated ?? [])])];
    for (let i = 0; i < changedIds.length; i += 100) {
      const chunk = changedIds.slice(i, i + 100);
      const g = await client.one('Email/get', { accountId, ids: chunk, properties: EMAIL_PROPS, fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: config.maxBodyBytes });
      const r = await upsertEmails(acc, g.list ?? [], { runAutomation: true });
      created += r.created; updated += r.updated;
      // Ids the server reports as changed but cannot return were deleted in between.
      const gone: string[] = g.notFound ?? [];
      if (gone.length) destroyed += await deleteEmails(acc, gone);
    }
    if (ch.destroyed?.length) destroyed += await deleteEmails(acc, ch.destroyed);
    since = ch.newState;
    await query(`UPDATE accounts SET email_state=$2 WHERE id=$1`, [acc.id, since]);
    if (!ch.hasMoreChanges) break;
  }
  return { created, updated, destroyed, full: false };
}

async function deleteEmails(acc: AccountRow, jmapIds: string[]): Promise<number> {
  const r = await query<{ n: number }>(`WITH d AS (DELETE FROM emails WHERE account_id=$1 AND jmap_id = ANY($2) RETURNING 1) SELECT count(*)::int AS n FROM d`, [acc.id, jmapIds]);
  return r[0]?.n ?? 0;
}

// Some servers (Stalwart among them) return List-Id only in its raw form.
export function listIdOf(e: any): string | null {
  const v = e['header:List-Id:asText'] ?? e['header:List-Id:asRaw'] ?? e['header:List-Id'] ?? null;
  const t = v === null || v === undefined ? '' : String(v).trim();
  return t ? t.slice(0, 500) : null;
}

interface BodyPart { partId?: string; blobId?: string; type?: string; charset?: string; name?: string; size?: number; cid?: string; disposition?: string }

function extractBodies(e: any): { text: string | null; html: string | null } {
  const values: Record<string, { value: string }> = e.bodyValues ?? {};
  const textParts: BodyPart[] = e.textBody ?? [];
  const htmlParts: BodyPart[] = e.htmlBody ?? [];
  const text = textParts.map((p) => (p.partId && values[p.partId]?.value) || '').filter(Boolean).join('\n\n') || null;
  let html: string | null = null;
  if (htmlParts.length) {
    html = htmlParts.map((p) => {
      const v = p.partId ? values[p.partId]?.value : undefined;
      if (v === undefined) return '';
      // JMAP lists plain-text parts under htmlBody when there is no HTML
      // alternative; those need escaping or they render as tag soup.
      return p.type === 'text/plain' ? `<div style="white-space:pre-wrap">${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : v;
    }).join('\n') || null;
  }
  return { text, html };
}

export async function upsertEmails(acc: AccountRow, list: any[], opts: { runAutomation: boolean }): Promise<{ created: number; updated: number }> {
  let created = 0, updated = 0;
  const fresh: any[] = [];
  await withTx(async (c) => {
    for (const e of list) {
      const { text, html } = extractBodies(e);
      const attachments = (e.attachments ?? []).map((p: BodyPart) => ({ blobId: p.blobId, name: p.name ?? null, type: p.type ?? 'application/octet-stream', size: p.size ?? 0, cid: p.cid ?? null, disposition: p.disposition ?? null }));
      const row = await c.query(
        `INSERT INTO emails (account_id, jmap_id, blob_id, thread_id, mailbox_ids, keywords, size, received_at, sent_at, message_id, in_reply_to, references_ids,
            from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, preview, has_attachment, body_text, body_html, attachments, auto_submitted, list_unsubscribe, list_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,now())
         ON CONFLICT (account_id, jmap_id) DO UPDATE SET blob_id=EXCLUDED.blob_id, thread_id=EXCLUDED.thread_id, mailbox_ids=EXCLUDED.mailbox_ids, keywords=EXCLUDED.keywords,
           size=EXCLUDED.size, received_at=EXCLUDED.received_at, sent_at=EXCLUDED.sent_at, message_id=EXCLUDED.message_id, in_reply_to=EXCLUDED.in_reply_to, references_ids=EXCLUDED.references_ids,
           from_addr=EXCLUDED.from_addr, to_addr=EXCLUDED.to_addr, cc_addr=EXCLUDED.cc_addr, bcc_addr=EXCLUDED.bcc_addr, reply_to=EXCLUDED.reply_to, subject=EXCLUDED.subject, preview=EXCLUDED.preview,
           has_attachment=EXCLUDED.has_attachment, body_text=COALESCE(EXCLUDED.body_text, emails.body_text), body_html=COALESCE(EXCLUDED.body_html, emails.body_html), attachments=EXCLUDED.attachments,
           auto_submitted=EXCLUDED.auto_submitted, list_unsubscribe=EXCLUDED.list_unsubscribe, list_id=EXCLUDED.list_id, updated_at=now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          acc.id, e.id, e.blobId ?? null, e.threadId ?? e.id, Object.keys(e.mailboxIds ?? {}), Object.keys(e.keywords ?? {}).filter((k) => e.keywords[k]),
          e.size ?? 0, e.receivedAt ?? new Date().toISOString(), e.sentAt ?? null, e.messageId ?? [], e.inReplyTo ?? [], e.references ?? [],
          JSON.stringify(e.from ?? []), JSON.stringify(e.to ?? []), JSON.stringify(e.cc ?? []), JSON.stringify(e.bcc ?? []), JSON.stringify(e.replyTo ?? []),
          e.subject ?? '', (e.preview ?? '').slice(0, 500), Boolean(e.hasAttachment), text, html, JSON.stringify(attachments), e['header:Auto-Submitted:asText'] ?? null,
          (e['header:List-Unsubscribe:asText'] ?? null) && String(e['header:List-Unsubscribe:asText']).slice(0, 2000), listIdOf(e),
        ],
      );
      if (row.rows[0].inserted) { created++; fresh.push({ ...e, _id: row.rows[0].id, _text: text }); } else updated++;
    }
  });
  if (opts.runAutomation && fresh.length) {
    try { await onNewEmails(acc, fresh); } catch (err) { log.error('automation failed', { err: (err as Error).message }); }
    try { await notifyNewMail(acc, fresh); } catch (err) { log.error('push failed', { err: (err as Error).message }); }
  }
  return { created, updated };
}

export async function fetchOneEmail(acc: AccountRow, jmapId: string): Promise<void> {
  const client = clientFor(acc);
  const g = await client.one('Email/get', { accountId: client.session!.accountId, ids: [jmapId], properties: EMAIL_PROPS, fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: config.maxBodyBytes });
  await upsertEmails(acc, g.list ?? [], { runAutomation: false });
}

export { CORE, MAIL };
