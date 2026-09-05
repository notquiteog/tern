// Outbound mail. The message is built once as raw MIME (nodemailer's stream
// transport, no network) so JMAP submission and the SMTP fallback send the
// identical bytes, with the Message-ID we generated and will later match
// replies against. JMAP is preferred: the sent copy lands in the mailbox's
// Sent folder as part of the same request and threads correctly everywhere.
import nodemailer from 'nodemailer';
import { clientFor, type AccountRow } from '../services/accounts.js';
import { decrypt, randomToken } from '../crypto.js';
import { mailboxByRole } from './actions.js';
import { SUBMISSION, CORE, MAIL, type JmapClient } from './client.js';
import { logger } from '../log.js';
import { htmlToText } from '../services/merge.js';

const log = logger('send');

export interface Address { name?: string | null; email: string }
export interface OutgoingAttachment { filename: string; content: Buffer; contentType: string; cid?: string }
export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: OutgoingAttachment[];
  messageId?: string;
}
export interface SendOutcome { messageId: string; jmapEmailId: string | null; threadId: string | null; via: 'jmap' | 'smtp' }

const toNm = (a: Address) => ({ name: a.name ?? '', address: a.email });
const bracket = (id: string) => (id.startsWith('<') ? id : `<${id}>`);
export const stripBrackets = (id: string) => id.replace(/^<|>$/g, '');

export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'localhost';
  return `<${randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, '')}.${Date.now().toString(36)}@${domain}>`;
}

export async function buildMime(msg: OutgoingMessage): Promise<{ raw: Buffer; messageId: string }> {
  const messageId = msg.messageId ? bracket(msg.messageId) : newMessageId(msg.from.email);
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await transport.sendMail({
    from: toNm(msg.from),
    to: msg.to.map(toNm),
    cc: msg.cc?.map(toNm),
    bcc: msg.bcc?.map(toNm),
    replyTo: msg.replyTo?.map(toNm),
    subject: msg.subject,
    text: msg.text ?? htmlToText(msg.html),
    html: msg.html,
    messageId,
    inReplyTo: msg.inReplyTo ? bracket(msg.inReplyTo) : undefined,
    references: msg.references?.length ? msg.references.map(bracket).join(' ') : undefined,
    headers: msg.headers,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid, contentDisposition: a.cid ? 'inline' : 'attachment' })),
    date: new Date(),
  });
  return { raw: info.message as Buffer, messageId };
}

async function ensureIdentity(acc: AccountRow, client: JmapClient): Promise<string> {
  if (acc.identity_id) return acc.identity_id;
  const accountId = client.session!.accountId;
  const res = await client.one('Identity/get', { accountId, ids: null }, [CORE, MAIL, SUBMISSION]);
  const list: any[] = res.list ?? [];
  let id: string | undefined = list.find((i) => i.email?.toLowerCase() === acc.email.toLowerCase())?.id ?? list.find((i) => i.email === '*')?.id;
  if (!id) {
    const created = await client.one('Identity/set', { accountId, create: { i: { name: acc.name, email: acc.email } } }, [CORE, MAIL, SUBMISSION]);
    id = created.created?.i?.id ?? list[0]?.id;
  }
  if (!id) throw new Error('The mail server has no sending identity for this address');
  const { query } = await import('../db.js');
  await query('UPDATE accounts SET identity_id=$2 WHERE id=$1', [acc.id, id]);
  acc.identity_id = id;
  return id;
}

async function importRaw(acc: AccountRow, client: JmapClient, raw: Buffer, mailboxJmapId: string, keywords: Record<string, boolean>): Promise<{ id: string; threadId: string }> {
  const accountId = client.session!.accountId;
  const blob = await client.upload(raw, 'message/rfc822');
  const res = await client.one('Email/import', { accountId, emails: { m: { blobId: blob.blobId, mailboxIds: { [mailboxJmapId]: true }, keywords } } });
  const created = res.created?.m;
  if (!created) {
    const err = res.notCreated?.m;
    throw new Error(`Server refused the message: ${err?.type}${err?.description ? ' - ' + err.description : ''}`);
  }
  return { id: created.id, threadId: created.threadId };
}

export async function sendMessage(acc: AccountRow, msg: OutgoingMessage): Promise<SendOutcome> {
  const { raw, messageId } = await buildMime(msg);
  const rcpt = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])].map((a) => a.email);
  const client = clientFor(acc);
  await client.ensureSession();
  const useSmtp = acc.send_via === 'smtp' && acc.smtp;

  if (!useSmtp && client.session!.hasSubmission !== false) {
    const accountId = client.session!.accountId;
    const drafts = (await mailboxByRole(acc.id, 'drafts')) ?? (await mailboxByRole(acc.id, 'sent')) ?? (await mailboxByRole(acc.id, 'inbox'));
    const sent = (await mailboxByRole(acc.id, 'sent')) ?? drafts;
    if (!drafts || !sent) throw new Error('Mailbox list is empty; sync the account first');
    const identityId = await ensureIdentity(acc, client);
    const imported = await importRaw(acc, client, raw, drafts.jmap_id, { $seen: true, $draft: true });
    const res = await client.one(
      'EmailSubmission/set',
      {
        accountId,
        create: { s: { emailId: imported.id, identityId, envelope: { mailFrom: { email: msg.from.email }, rcptTo: rcpt.map((email) => ({ email })) } } },
        onSuccessUpdateEmail: { '#s': { mailboxIds: { [sent.jmap_id]: true }, 'keywords/$draft': null, 'keywords/$seen': true } },
      },
      [CORE, MAIL, SUBMISSION],
    );
    if (!res.created?.s) {
      const err = res.notCreated?.s;
      // Leave nothing behind: a failed submission should not linger as a draft.
      try { await client.one('Email/set', { accountId, destroy: [imported.id] }); } catch { /* best effort */ }
      throw new Error(`Send rejected: ${err?.type}${err?.description ? ' - ' + err.description : ''}`);
    }
    log.info(`sent via jmap`, { account: acc.id, to: rcpt.length, messageId });
    return { messageId: stripBrackets(messageId), jmapEmailId: imported.id, threadId: imported.threadId, via: 'jmap' };
  }

  if (!acc.smtp) throw new Error('This mail server does not support JMAP submission and no SMTP fallback is configured');
  const transport = nodemailer.createTransport({
    host: acc.smtp.host, port: acc.smtp.port, secure: acc.smtp.secure,
    auth: { user: acc.smtp.user, pass: decrypt(acc.smtp.pass_enc) },
    requireTLS: !acc.smtp.secure,
  });
  await transport.sendMail({ envelope: { from: msg.from.email, to: rcpt }, raw });
  log.info(`sent via smtp`, { account: acc.id, to: rcpt.length, messageId });
  let jmapEmailId: string | null = null, threadId: string | null = null;
  try {
    const sent = await mailboxByRole(acc.id, 'sent');
    if (sent) {
      const imported = await importRaw(acc, client, raw, sent.jmap_id, { $seen: true });
      jmapEmailId = imported.id; threadId = imported.threadId;
    }
  } catch (e) {
    log.warn('could not file the sent copy', { err: (e as Error).message });
  }
  return { messageId: stripBrackets(messageId), jmapEmailId, threadId, via: 'smtp' };
}
