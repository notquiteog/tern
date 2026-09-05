// Outbound mail. The message is built once as raw MIME (nodemailer's stream
// transport, no network) so JMAP submission and the SMTP fallback send the
// identical bytes, with the Message-ID we generated and will later match
// replies against. JMAP is preferred: the sent copy lands in the mailbox's
// Sent folder as part of the same request and threads correctly everywhere.
import nodemailer from 'nodemailer';
import { createRequire } from 'node:module';
import { clientFor, type AccountRow } from '../services/accounts.js';
import { decrypt, randomToken } from '../crypto.js';
import { mailboxByRole } from './actions.js';
import { SUBMISSION, CORE, MAIL, type JmapClient } from './client.js';
import { logger } from '../log.js';
import { htmlToText } from '../services/merge.js';

const log = logger('send');
// nodemailer's MIME node is the only builder we need for PGP envelopes; it is
// not on the package's public type surface, hence the require.
const MimeNode: any = createRequire(import.meta.url)('nodemailer/lib/mime-node');

export interface Address { name?: string | null; email: string }
export interface OutgoingAttachment { filename: string; content: Buffer; contentType: string; cid?: string }
// A message the browser or the server already protected with OpenPGP.
//   encrypted: `armored` is the ciphertext of a complete inner MIME part (RFC 3156 multipart/encrypted)
//   signed:    `inner` is the exact MIME part that was signed, `signature` the detached signature
export interface PgpPayload { mode: 'encrypted' | 'signed'; armored?: string; inner?: string; signature?: string }
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
  pgp?: PgpPayload | null;
}
export interface SendOutcome { messageId: string; jmapEmailId: string | null; threadId: string | null; via: 'jmap' | 'smtp' }

const toNm = (a: Address) => ({ name: a.name ?? '', address: a.email });
const bracket = (id: string) => (id.startsWith('<') ? id : `<${id}>`);
export const stripBrackets = (id: string) => id.replace(/^<|>$/g, '');

export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'localhost';
  return `<${randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, '')}.${Date.now().toString(36)}@${domain}>`;
}

// The part that gets encrypted or signed: text and HTML alternatives plus
// attachments, without the envelope headers the builder adds to a root node.
export async function buildInnerMime(msg: { html: string; text?: string; attachments?: OutgoingAttachment[] }): Promise<string> {
  const alt = new MimeNode('multipart/alternative');
  alt.createChild('text/plain; charset=utf-8').setContent(msg.text ?? htmlToText(msg.html));
  alt.createChild('text/html; charset=utf-8').setContent(msg.html);
  let root = alt;
  if (msg.attachments?.length) {
    root = new MimeNode('multipart/mixed');
    root.appendChild(alt);
    for (const a of msg.attachments) {
      const n = root.createChild(a.contentType);
      n.setHeader('Content-Disposition', `${a.cid ? 'inline' : 'attachment'}; filename="${a.filename.replace(/["\r\n]/g, '_')}"`);
      if (a.cid) n.setHeader('Content-ID', `<${a.cid}>`);
      n.setContent(a.content);
    }
  }
  const built = (await root.build()).toString('utf8');
  const split = built.indexOf('\r\n\r\n');
  const headers = built.slice(0, split).split('\r\n').filter((l: string) => !/^(Date|Message-ID|MIME-Version):/i.test(l));
  return headers.join('\r\n') + built.slice(split);
}

function pgpEnvelope(msg: OutgoingMessage, messageId: string): any {
  const pgp = msg.pgp!;
  const root = new MimeNode(pgp.mode === 'encrypted' ? 'multipart/encrypted; protocol="application/pgp-encrypted"' : 'multipart/signed; protocol="application/pgp-signature"; micalg="pgp-sha256"');
  const headers: Record<string, unknown> = { From: [toNm(msg.from)], To: msg.to.map(toNm), Subject: msg.subject, 'Message-ID': messageId, ...(msg.headers ?? {}) };
  if (msg.cc?.length) headers.Cc = msg.cc.map(toNm);
  if (msg.replyTo?.length) headers['Reply-To'] = msg.replyTo.map(toNm);
  if (msg.inReplyTo) headers['In-Reply-To'] = bracket(msg.inReplyTo);
  if (msg.references?.length) headers.References = msg.references.map(bracket).join(' ');
  root.setHeader(headers);
  if (pgp.mode === 'encrypted') {
    if (!pgp.armored) throw new Error('encrypted message without ciphertext');
    const v = root.createChild('application/pgp-encrypted'); v.setHeader('Content-Description', 'PGP/MIME version identification'); v.setHeader('Content-Transfer-Encoding', '7bit'); v.setContent('Version: 1\r\n');
    const c = root.createChild('application/octet-stream'); c.setHeader('Content-Description', 'OpenPGP encrypted message'); c.setHeader('Content-Disposition', 'inline; filename="encrypted.asc"'); c.setHeader('Content-Transfer-Encoding', '7bit'); c.setContent(pgp.armored.replace(/\r?\n/g, '\r\n'));
  } else {
    if (!pgp.inner || !pgp.signature) throw new Error('signed message without body or signature');
    root.createChild().setRaw(pgp.inner);
    const s = root.createChild('application/pgp-signature'); s.setHeader('Content-Description', 'OpenPGP digital signature'); s.setHeader('Content-Disposition', 'attachment; filename="signature.asc"'); s.setHeader('Content-Transfer-Encoding', '7bit'); s.setContent(pgp.signature.replace(/\r?\n/g, '\r\n'));
  }
  return root;
}

export async function buildMime(msg: OutgoingMessage): Promise<{ raw: Buffer; messageId: string }> {
  const messageId = msg.messageId ? bracket(msg.messageId) : newMessageId(msg.from.email);
  if (msg.pgp) {
    const raw: Buffer = await pgpEnvelope(msg, messageId).build();
    // Bcc never appears in the envelope headers; submission gets the full recipient list separately.
    return { raw, messageId };
  }
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
