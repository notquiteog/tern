// The one path every outgoing message takes: manual compose, reply, forward,
// "send later", and sequence steps. Builds the message, sends it, records it
// in send_log, and asks the sync manager to pull the sent copy back. Keeping
// this single keeps the daily cap, logging and reply matching consistent.
import { one, query } from '../db.js';
import { sendMessage, type Address, type OutgoingAttachment, type SendOutcome } from '../jmap/send.js';
import { clientFor, type AccountRow } from './accounts.js';
import { syncManager } from '../workers/syncManager.js';
import { publish } from '../events.js';
import { config } from '../config.js';
import { signPayload } from '../crypto.js';
import { escapeHtml } from './merge.js';
import { badRequest } from '../errors.js';

export interface ComposeInput {
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  html: string;
  text?: string;
  replyToEmailId?: number | null;
  forwardOfEmailId?: number | null;
  attachmentIds?: number[];
  includeSignature?: boolean;
  kind: 'compose' | 'reply' | 'forward' | 'scheduled' | 'sequence' | 'auto_reply';
  responderId?: number | null;
  contactId?: number | null;
  sequenceId?: number | null;
  stepId?: number | null;
  enrollmentId?: number | null;
  inReplyTo?: string | null;
  references?: string[];
  extraHeaders?: Record<string, string>;
  unsubscribeFooter?: boolean;
}

export interface SendLogRow {
  id: number; user_id: number; account_id: number; contact_id: number | null; sequence_id: number | null; step_id: number | null; enrollment_id: number | null;
  message_id: string | null; jmap_email_id: string | null; thread_id: string | null; to_email: string; subject: string; kind: string; status: string; error: string | null; sent_at: Date;
}

export function unsubscribeUrl(userId: number, contactId: number, accountId: number): string {
  return `${config.appUrl}/u/${signPayload(`u:${userId}:${contactId}:${accountId}`)}`;
}

export async function appSettings(): Promise<{ unsubscribeText: string; physicalAddress: string; defaultTimezone: string }> {
  const row = await one<{ value: any }>(`SELECT value FROM settings WHERE key='app'`);
  return { unsubscribeText: 'If you would rather not hear from me again, just reply "stop" or use this link:', physicalAddress: '', defaultTimezone: 'UTC', ...(row?.value ?? {}) };
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function normalizeAddresses(list: unknown, field: string): Address[] {
  if (!Array.isArray(list)) return [];
  const out: Address[] = [];
  for (const a of list) {
    const email = typeof a === 'string' ? a : a?.email;
    if (typeof email !== 'string' || !isValidEmail(email.trim())) throw badRequest(`Invalid ${field} address: ${String(email)}`);
    out.push({ name: typeof a === 'object' && a?.name ? String(a.name) : null, email: email.trim() });
  }
  return out;
}

export async function composeAndSend(acc: AccountRow, input: ComposeInput): Promise<{ log: SendLogRow; outcome: SendOutcome }> {
  const to = normalizeAddresses(input.to, 'to');
  const cc = normalizeAddresses(input.cc ?? [], 'cc');
  const bcc = normalizeAddresses(input.bcc ?? [], 'bcc');
  if (!to.length && !cc.length && !bcc.length) throw badRequest('Add at least one recipient');

  let inReplyTo = input.inReplyTo ?? null;
  let references = input.references ?? [];
  if (input.replyToEmailId) {
    const orig = await one<any>('SELECT message_id, references_ids, in_reply_to FROM emails WHERE id=$1 AND account_id=$2', [input.replyToEmailId, acc.id]);
    if (orig?.message_id?.length) {
      inReplyTo = orig.message_id[0];
      references = [...(orig.references_ids ?? []), orig.message_id[0]].slice(-20);
    }
  }

  const attachments: OutgoingAttachment[] = [];
  if (input.attachmentIds?.length) {
    const rows = await query<any>('SELECT id, filename, content_type, data FROM uploads WHERE id = ANY($1) AND user_id=$2', [input.attachmentIds, acc.user_id]);
    for (const r of rows) attachments.push({ filename: r.filename, content: r.data, contentType: r.content_type });
  }
  if (input.forwardOfEmailId) {
    const orig = await one<any>('SELECT attachments FROM emails WHERE id=$1 AND account_id=$2', [input.forwardOfEmailId, acc.id]);
    const client = clientFor(acc);
    for (const a of orig?.attachments ?? []) {
      if (!a.blobId) continue;
      const res = await client.download(a.blobId, a.name ?? 'attachment', a.type ?? 'application/octet-stream');
      attachments.push({ filename: a.name ?? 'attachment', content: Buffer.from(await res.arrayBuffer()), contentType: a.type ?? 'application/octet-stream', cid: a.cid ?? undefined });
    }
  }

  let html = input.html || '<p></p>';
  if (input.includeSignature !== false && acc.signature_html?.trim()) {
    html += `<div class="tern-signature" style="margin-top:16px">${acc.signature_html}</div>`;
  }
  const headers: Record<string, string> = { ...(input.extraHeaders ?? {}) };
  if (input.unsubscribeFooter && input.contactId) {
    const s = await appSettings();
    const url = unsubscribeUrl(acc.user_id, input.contactId, acc.id);
    headers['List-Unsubscribe'] = `<${url}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    html += `<p style="margin-top:24px;font-size:12px;color:#6b7280">${escapeHtml(s.unsubscribeText)} <a href="${url}" style="color:#6b7280">${url}</a>${s.physicalAddress ? `<br>${escapeHtml(s.physicalAddress)}` : ''}</p>`;
  }

  const primary = to[0]?.email ?? cc[0]?.email ?? bcc[0]?.email ?? '';
  let outcome: SendOutcome;
  try {
    outcome = await sendMessage(acc, {
      from: { name: acc.name, email: acc.email },
      to, cc, bcc,
      subject: input.subject ?? '',
      html,
      text: input.text,
      inReplyTo,
      references,
      headers,
      attachments,
    });
  } catch (e) {
    const msg = (e as Error).message;
    await query(
      `INSERT INTO send_log (user_id, account_id, contact_id, sequence_id, step_id, enrollment_id, to_email, subject, kind, status, error, responder_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10,$11)`,
      [acc.user_id, acc.id, input.contactId ?? null, input.sequenceId ?? null, input.stepId ?? null, input.enrollmentId ?? null, primary, input.subject ?? '', input.kind, msg.slice(0, 500), input.responderId ?? null],
    );
    publish({ type: 'send', userId: acc.user_id, accountId: acc.id, contactId: input.contactId ?? null, ok: false, subject: input.subject, error: msg });
    throw e;
  }

  const rows = await query<SendLogRow>(
    `INSERT INTO send_log (user_id, account_id, contact_id, sequence_id, step_id, enrollment_id, message_id, jmap_email_id, thread_id, to_email, subject, kind, status, responder_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13) RETURNING *`,
    [acc.user_id, acc.id, input.contactId ?? null, input.sequenceId ?? null, input.stepId ?? null, input.enrollmentId ?? null, outcome.messageId, outcome.jmapEmailId, outcome.threadId, primary, input.subject ?? '', input.kind, input.responderId ?? null],
  );
  const log = rows[0];

  // Housekeeping: uploads are single-use, contacts remember the touch, the
  // sent copy is pulled back so the thread view shows it right away.
  if (input.attachmentIds?.length) await query('DELETE FROM uploads WHERE id = ANY($1) AND user_id=$2', [input.attachmentIds, acc.user_id]);
  const allRecipients = [...to, ...cc, ...bcc].map((a) => a.email.toLowerCase());
  await query(`UPDATE contacts SET last_contacted_at=now(), updated_at=now() WHERE user_id=$1 AND (id=$2 OR lower(email) = ANY($3))`, [acc.user_id, input.contactId ?? -1, allRecipients]);
  if (outcome.threadId) {
    await query(
      `INSERT INTO contact_threads (contact_id, account_id, thread_id) SELECT id, $2, $3 FROM contacts WHERE user_id=$1 AND (id=$4 OR lower(email) = ANY($5)) ON CONFLICT DO NOTHING`,
      [acc.user_id, acc.id, outcome.threadId, input.contactId ?? -1, allRecipients],
    );
  }
  syncManager.requestSync(acc.id, 1500);
  publish({ type: 'send', userId: acc.user_id, accountId: acc.id, contactId: input.contactId ?? null, ok: true, subject: input.subject });
  return { log, outcome };
}
