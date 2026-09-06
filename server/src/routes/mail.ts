import { Router, raw } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z, addressSchema } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { clientFor, getUserAccount, listAccounts, type AccountRow } from '../services/accounts.js';
import * as actions from '../jmap/actions.js';
import { syncManager } from '../workers/syncManager.js';
import { markDirty, removeDraft } from '../services/draftSync.js';
import { openDraft, openDraftWith, openEmailWith, openEmails, sealDraft } from '../services/mailVault.js';
import { dataKey, open, seal } from '../services/vault.js';

// The outbox payload is one sealed JSON blob. Everything that reads a queued
// message goes through here.
async function openPayload(userId: number, stored: string | null): Promise<any> {
  const text = await open(userId, stored);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
import { wakeOutboxAt } from '../workers/scheduler.js';
import { composeAndSend, inlineUploadIds } from '../services/compose.js';
import { jitterMs } from '../services/sending.js';
import { parseSearch, buildSearchSql } from '../services/search.js';
import { brandDomains } from '../services/brand.js';
import { describeScrub, scrubMedia } from '../services/scrub.js';
import { rateLimit } from '../util/rateLimit.js';

export const mailRouter = Router();
mailRouter.use(requireAuth);

async function userAccounts(userId: number, param: string | undefined): Promise<AccountRow[]> {
  const all = await listAccounts(userId);
  if (!param || param === 'all') return all;
  const ids = new Set(param.split(',').map(Number));
  return all.filter((a) => ids.has(a.id));
}

async function roleIds(accountIds: number[], role: string): Promise<string[]> {
  const rows = await query<{ jmap_id: string }>('SELECT jmap_id FROM mailboxes WHERE account_id = ANY($1) AND role=$2', [accountIds, role]);
  return rows.map((r) => r.jmap_id);
}

// A draft Tern pushed to the mail server's Drafts folder syncs back into the
// cache like any other message. It is the same draft the person is editing
// here, so it is hidden from every list, thread and count; the local row is
// the one they see. Written as a predicate over an alias so it can be
// dropped into each query.
const notDraftMirror = (alias: string) => `NOT EXISTS (SELECT 1 FROM drafts dm WHERE dm.account_id=${alias}.account_id AND dm.jmap_id=${alias}.jmap_id)`;

// Attachment details for a draft's staged uploads, so a reopened draft shows
// its files instead of silently dropping them.
const DRAFT_ATTACHMENTS = `(SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'filename', u.filename, 'size', u.size, 'content_type', u.content_type) ORDER BY u.id), '[]'::jsonb) FROM uploads u WHERE u.id = ANY(d.attachment_ids)) AS attachments,
  (SELECT x.attachments FROM emails x WHERE x.id = d.forward_of_email_id) AS sealed_forward_attachments`;

// A draft's own fields are opened by openDraftWith; the attachment list of
// the message it forwards came from a sealed row, so it is opened here and
// filtered down to the parts the draft actually carries.
async function withDraftContent(userId: number, rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const dek = await dataKey(userId);
  return rows.map((d) => {
    const opened = openDraftWith(dek, d);
    const all = openEmailWith(dek, { attachments: d.sealed_forward_attachments ?? null }).attachments as any[];
    const wanted = new Set(d.forward_blob_ids ?? []);
    opened.forward_attachments = all.filter((a: any) => a?.blobId && wanted.has(a.blobId));
    delete opened.sealed_forward_attachments;
    return opened;
  });
}

// ---------- Thread list ----------

mailRouter.get('/threads', async (req, res) => {
  const accounts = await userAccounts(req.user!.id, String(req.query.accounts ?? 'all'));
  if (!accounts.length) { res.json({ threads: [], total: 0, page: 1, pageSize: 50 }); return; }
  const accountIds = accounts.map((a) => a.id);
  const box = String(req.query.box ?? 'inbox');
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.size ?? 50)));
  const q = String(req.query.q ?? '').trim();
  const filter = String(req.query.f ?? '');

  const where: string[] = ['e.account_id = ANY($1)', notDraftMirror('e')];
  const params: unknown[] = [accountIds];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const trashJunk = [...(await roleIds(accountIds, 'trash')), ...(await roleIds(accountIds, 'junk')), ...(await roleIds(accountIds, 'spam'))];

  if (box.startsWith('mailbox:')) {
    const [, accStr, jmapId] = box.split(':');
    where.push(`e.account_id = ${p(Number(accStr))} AND ${p(jmapId)} = ANY(e.mailbox_ids)`);
  } else {
    switch (box) {
      case 'inbox': where.push(`e.mailbox_ids && ${p(await roleIds(accountIds, 'inbox'))}::text[]`); break;
      case 'starred': where.push('e.is_flagged'); if (trashJunk.length) where.push(`NOT (e.mailbox_ids && ${p(trashJunk)}::text[])`); break;
      case 'unread': where.push('e.is_unread'); if (trashJunk.length) where.push(`NOT (e.mailbox_ids && ${p(trashJunk)}::text[])`); break;
      case 'sent': where.push(`e.mailbox_ids && ${p(await roleIds(accountIds, 'sent'))}::text[]`); break;
      case 'drafts': where.push(`e.mailbox_ids && ${p(await roleIds(accountIds, 'drafts'))}::text[]`); break;
      case 'junk': where.push(`e.mailbox_ids && ${p([...(await roleIds(accountIds, 'junk')), ...(await roleIds(accountIds, 'spam'))])}::text[]`); break;
      case 'trash': where.push(`e.mailbox_ids && ${p(await roleIds(accountIds, 'trash'))}::text[]`); break;
      case 'archive': {
        const inbox = await roleIds(accountIds, 'inbox');
        const others = [...trashJunk, ...(await roleIds(accountIds, 'sent')), ...(await roleIds(accountIds, 'drafts'))];
        where.push(`NOT (e.mailbox_ids && ${p([...inbox, ...others])}::text[])`);
        break;
      }
      case 'snoozed': where.push(`EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id=e.account_id AND s.thread_id=e.thread_id AND NOT s.restored)`); break;
      case 'all': if (trashJunk.length) where.push(`NOT (e.mailbox_ids && ${p(trashJunk)}::text[])`); break;
      case 'attachments': where.push('e.has_attachment'); if (trashJunk.length) where.push(`NOT (e.mailbox_ids && ${p(trashJunk)}::text[])`); break;
      default: throw badRequest('Unknown mailbox');
    }
    if (box !== 'snoozed') where.push(`NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id=e.account_id AND s.thread_id=e.thread_id AND NOT s.restored)`);
  }
  if (filter === 'unread') where.push('e.is_unread');
  else if (filter === 'read') where.push('NOT e.is_unread');
  else if (filter === 'starred') where.push('e.is_flagged');
  else if (filter === 'attachments') where.push('e.has_attachment');
  if (q) {
    const parsed = parseSearch(q);
    const sql = await buildSearchSql(parsed, accountIds, p, req.user!.id);
    where.push(...sql);
  }

  const whereSql = where.join(' AND ');
  // Membership in the box decides which threads appear; the count, the
  // latest message and the ordering come from the whole conversation, the
  // way Gmail does it, so a reply you sent still bumps the thread.
  const agg = `SELECT e.account_id, e.thread_id, bool_or(e.is_unread) AS unread, bool_or(e.is_flagged) AS starred, bool_or(e.has_attachment) AS has_attachment, bool_or(e.is_draft) AS has_draft
               FROM emails e WHERE ${whereSql} GROUP BY e.account_id, e.thread_id`;
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM (${agg}) t`, params);
  // Subjects, previews, addresses and attachment names are ciphertext, so
  // the database can no longer assemble them. It returns the sealed blobs of
  // the thread and they are opened here, once per page.
  const rows = await query<any>(
    `SELECT t.*,
       (SELECT max(x.received_at) FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS last_at,
       (SELECT count(*)::int FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS n,
       (SELECT jsonb_build_object('id', x.id, 'jmap_id', x.jmap_id, 'subject', x.subject, 'preview', x.preview, 'from', x.from_addr, 'to', x.to_addr, 'received_at', x.received_at)
          FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id ORDER BY x.received_at DESC LIMIT 1) AS latest,
       (SELECT array_agg(x.from_addr) FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS sealed_participants,
       (SELECT array_agg(x.attachments ORDER BY x.received_at DESC) FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id AND x.has_attachment) AS sealed_attachments,
       (SELECT array_agg(DISTINCT m) FROM emails x, unnest(x.mailbox_ids) m WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS mailbox_ids,
       (SELECT s.until_at FROM snoozes s WHERE s.account_id=t.account_id AND s.thread_id=t.thread_id AND NOT s.restored LIMIT 1) AS snoozed_until,
       EXISTS (SELECT 1 FROM muted_threads mt WHERE mt.account_id=t.account_id AND mt.thread_id=t.thread_id) AS muted,
       (SELECT c.id FROM contact_threads ct JOIN contacts c ON c.id=ct.contact_id WHERE ct.account_id=t.account_id AND ct.thread_id=t.thread_id LIMIT 1) AS contact_id
     FROM (${agg}) t ORDER BY last_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  const dek = await dataKey(req.user!.id);
  for (const r of rows) {
    if (r.latest) {
      const opened = openEmailWith(dek, { subject: r.latest.subject, preview: r.latest.preview, from_addr: r.latest.from, to_addr: r.latest.to });
      r.latest = { ...r.latest, subject: opened.subject, preview: opened.preview, from: opened.from_addr, to: opened.to_addr };
    }
    const seen = new Set<string>();
    r.participants = (r.sealed_participants ?? []).flatMap((blob: string) => openEmailWith(dek, { from_addr: blob }).from_addr)
      .filter((a: any) => a?.email && !seen.has(String(a.email).toLowerCase()) && seen.add(String(a.email).toLowerCase()));
    // The same four names the list showed before: real attachments only, not
    // inline images or the parts of a PGP envelope.
    const names: string[] = [];
    for (const blob of r.sealed_attachments ?? []) {
      for (const a of openEmailWith(dek, { attachments: blob }).attachments as any[]) {
        if (!a?.name || names.length >= 4) continue;
        if (a.cid && a.disposition !== 'attachment') continue;
        if (String(a.type ?? '').startsWith('application/pgp-') || ['encrypted.asc', 'signature.asc'].includes(a.name)) continue;
        names.push(a.name);
      }
    }
    r.attachments = names.length ? names : null;
    delete r.sealed_participants; delete r.sealed_attachments;
  }
  // The sender's contact photo, looked up from the now-decrypted address.
  const senderEmails = [...new Set(rows.map((r: any) => String(r.latest?.from?.[0]?.email ?? '').toLowerCase()).filter(Boolean))];
  const avatarRows = senderEmails.length
    ? await query<{ email: string; id: number; v: number }>(`SELECT lower(email) AS email, id, (extract(epoch FROM avatar_updated_at) * 1000)::bigint AS v FROM contacts WHERE user_id=$1 AND avatar_updated_at IS NOT NULL AND lower(email) = ANY($2)`, [req.user!.id, senderEmails])
    : [];
  const avatarByEmail = new Map(avatarRows.map((a) => [a.email, a]));
  const me = req.user!;
  const myEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
  const brands = await brandDomains();
  res.json({
    threads: rows.map((r) => {
      const fromEmail = String(r.latest?.from?.[0]?.email ?? '').toLowerCase();
      const fromDomain = fromEmail.split('@')[1] ?? '';
      const contactAvatar = avatarByEmail.get(fromEmail);
      const avatarUrl = contactAvatar ? `/api/avatars/contact/${contactAvatar.id}?v=${contactAvatar.v}` : myEmails.has(fromEmail) && me.avatar_updated_at ? `/api/avatars/user/${me.id}?v=${new Date(me.avatar_updated_at).getTime()}` : brands.has(fromDomain) ? `/bimi/${fromDomain}.svg?v=${brands.get(fromDomain)}` : null;
      return { ...r, key: `${r.account_id}:${r.thread_id}`, avatar_url: avatarUrl };
    }),
    total: total?.n ?? 0, page, pageSize,
  });
});

// ---------- Thread detail ----------

mailRouter.get('/threads/:accountId/:threadId', async (req, res) => {
  const acc = await getUserAccount(req.user!.id, idParam(req.params.accountId));
  if (!acc) throw notFound('Account not found');
  const threadId = String(req.params.threadId);
  // from_email was a generated column over the plaintext sender; openEmails
  // recomputes it from the opened address list.
  const sealedMessages = await query<any>(
    `SELECT id, jmap_id, blob_id, thread_id, mailbox_ids, keywords, size, received_at, sent_at, message_id, in_reply_to, references_ids, from_addr, to_addr, cc_addr, bcc_addr, reply_to,
            subject, preview, has_attachment, body_text, body_html, attachments, is_unread, is_flagged, is_draft, list_unsubscribe, list_id, auto_submitted
     FROM emails e WHERE account_id=$1 AND thread_id=$2 AND ${notDraftMirror('e')} ORDER BY received_at ASC`,
    [acc.id, threadId],
  );
  if (!sealedMessages.length) throw notFound('Thread not found');
  const messages = await openEmails(req.user!.id, sealedMessages);
  // Profile pictures: a contact's photo for their address, the user's own for the account's address.
  const senders = [...new Set(messages.map((m: any) => m.from_email).filter(Boolean))];
  const photos = await query<{ email: string; id: number; v: number }>(`SELECT lower(email) AS email, id, (extract(epoch FROM avatar_updated_at) * 1000)::bigint AS v FROM contacts WHERE user_id=$1 AND avatar_updated_at IS NOT NULL AND lower(email) = ANY($2)`, [req.user!.id, senders]);
  const photoMap = new Map(photos.map((p) => [p.email, `/api/avatars/contact/${p.id}?v=${p.v}`]));
  if (req.user!.avatar_updated_at) photoMap.set(acc.email.toLowerCase(), `/api/avatars/user/${req.user!.id}?v=${new Date(req.user!.avatar_updated_at).getTime()}`);
  const brands = await brandDomains();
  for (const m of messages) {
    const d = String(m.from_email ?? '').split('@')[1] ?? '';
    (m as any).avatar_url = photoMap.get(m.from_email ?? '') ?? (brands.has(d) ? `/bimi/${d}.svg?v=${brands.get(d)}` : null);
  }
  const mailboxes = await query<any>('SELECT jmap_id, name, role, color FROM mailboxes WHERE account_id=$1', [acc.id]);
  const contact = await one<any>(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.title, c.status, c.tags, c.notes, c.fields, c.last_replied_at, c.last_contacted_at, (CASE WHEN c.avatar_updated_at IS NULL THEN NULL ELSE (extract(epoch FROM c.avatar_updated_at) * 1000)::bigint END) AS avatar_version FROM contacts c WHERE c.user_id=$1 AND (c.id = (SELECT contact_id FROM contact_threads WHERE account_id=$2 AND thread_id=$3 LIMIT 1) OR lower(c.email) = ANY($4)) ORDER BY (c.id = (SELECT contact_id FROM contact_threads WHERE account_id=$2 AND thread_id=$3 LIMIT 1)) DESC LIMIT 1`,
    [req.user!.id, acc.id, threadId, [...new Set(messages.flatMap((m: any) => [...(m.from_addr ?? []), ...(m.to_addr ?? [])].map((a: any) => String(a.email ?? '').toLowerCase())).filter((e: string) => e && e !== acc.email.toLowerCase()))]],
  );
  const enrollments = contact ? await query<any>(
    `SELECT e.id, e.status, e.current_step, e.next_run_at, s.name AS sequence_name, s.id AS sequence_id FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE e.contact_id=$1 ORDER BY e.created_at DESC LIMIT 5`,
    [contact.id],
  ) : [];
  const sends = await query<any>('SELECT id, kind, subject, sent_at, replied_at, bounced_at, status, error FROM send_log WHERE account_id=$1 AND thread_id=$2 ORDER BY sent_at', [acc.id, threadId]);
  const snooze = await one<any>('SELECT until_at FROM snoozes WHERE account_id=$1 AND thread_id=$2 AND NOT restored', [acc.id, threadId]);
  const muted = await one('SELECT 1 FROM muted_threads WHERE account_id=$1 AND thread_id=$2', [acc.id, threadId]);
  const drafts = await withDraftContent(req.user!.id, await query<any>(`SELECT d.*, r.name AS responder_name, ${DRAFT_ATTACHMENTS} FROM drafts d LEFT JOIN responders r ON r.id=d.responder_id WHERE d.user_id=$1 AND d.account_id=$2 AND d.thread_id=$3 ORDER BY d.updated_at DESC`, [req.user!.id, acc.id, threadId]));
  const pendingJobs = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ai_jobs WHERE user_id=$1 AND kind='responder' AND status IN ('pending','running') AND payload->>'threadId'=$2 AND (payload->>'accountId')::bigint=$3`, [req.user!.id, threadId, acc.id]);
  res.json({ account: { id: acc.id, email: acc.email, name: acc.name, color: acc.color, signature_html: acc.signature_html }, messages, mailboxes, contact, enrollments, sends, snoozedUntil: snooze?.until_at ?? null, muted: Boolean(muted), drafts, aiPending: pendingJobs?.n ?? 0 });
});


// ---------- Actions ----------

const actionSchema = z.object({
  accountId: z.number().int(),
  jmapIds: z.array(z.string()).optional(),
  threadIds: z.array(z.string()).optional(),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'spam', 'inbox', 'delete', 'label', 'unlabel', 'snooze', 'unsnooze', 'move', 'mute', 'unmute', 'restore']),
  mailboxId: z.string().optional(),
  until: z.string().optional(),
  // For 'restore': where each message was before the action being undone.
  items: z.array(z.object({ jmapId: z.string(), mailboxIds: z.array(z.string()) })).max(2000).optional(),
});

// Actions that move mail somewhere can be undone from the toast in the
// browser: the response carries where every message was before.
const UNDOABLE = new Set(['archive', 'trash', 'spam', 'inbox', 'label', 'unlabel', 'snooze', 'move', 'mute']);

async function resolveIds(acc: AccountRow, b: z.infer<typeof actionSchema>): Promise<string[]> {
  const ids = new Set(b.jmapIds ?? []);
  if (b.threadIds?.length) {
    const rows = await query<{ jmap_id: string }>('SELECT jmap_id FROM emails WHERE account_id=$1 AND thread_id = ANY($2)', [acc.id, b.threadIds]);
    for (const r of rows) ids.add(r.jmap_id);
  }
  return [...ids];
}

mailRouter.post('/actions', async (req, res) => {
  const b = parse(actionSchema, req.body);
  const acc = await getUserAccount(req.user!.id, b.accountId);
  if (!acc) throw notFound('Account not found');
  const ids = await resolveIds(acc, b);
  if (!ids.length && !['snooze', 'unsnooze', 'restore', 'mute', 'unmute'].includes(b.action)) { res.json({ ok: true, count: 0 }); return; }
  const before = UNDOABLE.has(b.action) && ids.length ? await query<{ jmap_id: string; mailbox_ids: string[]; thread_id: string }>('SELECT jmap_id, mailbox_ids, thread_id FROM emails WHERE account_id=$1 AND jmap_id = ANY($2)', [acc.id, ids]) : [];
  switch (b.action) {
    case 'read': await actions.setKeyword(acc, ids, '$seen', true); break;
    case 'unread': await actions.setKeyword(acc, ids, '$seen', false); break;
    case 'star': await actions.setKeyword(acc, ids, '$flagged', true); break;
    case 'unstar': await actions.setKeyword(acc, ids, '$flagged', false); break;
    case 'archive': await actions.archive(acc, ids); break;
    case 'trash': await actions.trash(acc, ids); break;
    case 'spam': await actions.spam(acc, ids); break;
    case 'inbox': await actions.toInbox(acc, ids); break;
    case 'delete': await actions.destroyEmails(acc, ids); break;
    case 'label': if (!b.mailboxId) throw badRequest('mailboxId required'); await actions.addToMailbox(acc, ids, b.mailboxId); break;
    case 'move': if (!b.mailboxId) throw badRequest('mailboxId required'); await actions.moveToOnly(acc, ids, b.mailboxId); break;
    case 'unlabel': {
      if (!b.mailboxId) throw badRequest('mailboxId required');
      const arch = await actions.ensureArchive(acc);
      await actions.removeFromMailbox(acc, ids, b.mailboxId, arch.jmap_id);
      break;
    }
    case 'snooze': {
      if (!b.until || !b.threadIds?.length) throw badRequest('until and threadIds required');
      const until = new Date(b.until);
      if (Number.isNaN(until.getTime()) || until.getTime() < Date.now()) throw badRequest('Snooze time must be in the future');
      for (const t of b.threadIds) {
        await query(`INSERT INTO snoozes (user_id, account_id, thread_id, until_at, restored) VALUES ($1,$2,$3,$4,false) ON CONFLICT (account_id, thread_id) DO UPDATE SET until_at=EXCLUDED.until_at, restored=false`, [req.user!.id, acc.id, t, until]);
      }
      await actions.archive(acc, ids);
      break;
    }
    case 'unsnooze': {
      if (!b.threadIds?.length) throw badRequest('threadIds required');
      await query('UPDATE snoozes SET restored=true WHERE account_id=$1 AND thread_id = ANY($2)', [acc.id, b.threadIds]);
      await actions.toInbox(acc, ids);
      break;
    }
    case 'mute': {
      const threads = b.threadIds?.length ? b.threadIds : [...new Set(before.map((r) => r.thread_id))];
      if (!threads.length) throw badRequest('threadIds required');
      for (const t of threads) await query('INSERT INTO muted_threads (user_id, account_id, thread_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user!.id, acc.id, t]);
      if (ids.length) await actions.archive(acc, ids);
      break;
    }
    case 'unmute': {
      const threads = b.threadIds?.length ? b.threadIds : [...new Set(before.map((r) => r.thread_id))];
      await query('DELETE FROM muted_threads WHERE account_id=$1 AND thread_id = ANY($2)', [acc.id, threads]);
      break;
    }
    case 'restore': {
      if (!b.items?.length) throw badRequest('items required');
      await actions.restoreMailboxes(acc, b.items);
      const threads = [...new Set((await query<{ thread_id: string }>('SELECT DISTINCT thread_id FROM emails WHERE account_id=$1 AND jmap_id = ANY($2)', [acc.id, b.items.map((i) => i.jmapId)])).map((r) => r.thread_id))];
      if (threads.length) {
        await query('UPDATE snoozes SET restored=true WHERE account_id=$1 AND thread_id = ANY($2) AND NOT restored', [acc.id, threads]);
        await query('DELETE FROM muted_threads WHERE account_id=$1 AND thread_id = ANY($2)', [acc.id, threads]);
      }
      break;
    }
  }
  syncManager.requestSync(acc.id, 1200);
  const undo = before.length ? { accountId: acc.id, items: before.map((r) => ({ jmapId: r.jmap_id, mailboxIds: r.mailbox_ids })) } : null;
  res.json({ ok: true, count: ids.length, undo });
});

// Everything in Trash or Junk, gone for good, across the user's accounts.
mailRouter.post('/empty', async (req, res) => {
  const b = parse(z.object({ box: z.enum(['trash', 'junk']), accountId: z.number().int().optional() }), req.body);
  const accounts = (await listAccounts(req.user!.id)).filter((a) => !b.accountId || a.id === b.accountId);
  let count = 0;
  for (const acc of accounts) {
    const roles = b.box === 'trash' ? ['trash'] : ['junk', 'spam'];
    const boxes = (await query<{ jmap_id: string }>('SELECT jmap_id FROM mailboxes WHERE account_id=$1 AND role = ANY($2)', [acc.id, roles])).map((r) => r.jmap_id);
    if (!boxes.length) continue;
    const rows = await query<{ jmap_id: string }>('SELECT jmap_id FROM emails WHERE account_id=$1 AND mailbox_ids && $2::text[]', [acc.id, boxes]);
    for (let i = 0; i < rows.length; i += 200) {
      const slice = rows.slice(i, i + 200).map((r) => r.jmap_id);
      await actions.destroyEmails(acc, slice);
      count += slice.length;
    }
    syncManager.requestSync(acc.id, 1200);
  }
  res.json({ ok: true, count });
});

// ---------- Mailboxes / labels ----------

mailRouter.get('/mailboxes', async (req, res) => {
  const accounts = await listAccounts(req.user!.id);
  const rows = await query<any>('SELECT * FROM mailboxes WHERE account_id = ANY($1) ORDER BY account_id, sort_order, name', [accounts.map((a) => a.id)]);
  res.json({ mailboxes: rows });
});

mailRouter.post('/mailboxes', async (req, res) => {
  const b = parse(z.object({ accountId: z.number().int(), name: z.string().min(1).max(200), parentId: z.string().nullable().optional() }), req.body);
  const acc = await getUserAccount(req.user!.id, b.accountId);
  if (!acc) throw notFound('Account not found');
  const mb = await actions.createMailbox(acc, b.name, b.parentId ?? null);
  res.json({ mailbox: mb });
});

mailRouter.put('/mailboxes/:accountId/:jmapId', async (req, res) => {
  const acc = await getUserAccount(req.user!.id, idParam(req.params.accountId));
  if (!acc) throw notFound('Account not found');
  const b = parse(z.object({ name: z.string().min(1).max(200).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }), req.body);
  if (b.name) await actions.renameMailbox(acc, String(req.params.jmapId), b.name);
  if (b.color !== undefined) await query('UPDATE mailboxes SET color=$3 WHERE account_id=$1 AND jmap_id=$2', [acc.id, String(req.params.jmapId), b.color]);
  res.json({ ok: true });
});

mailRouter.delete('/mailboxes/:accountId/:jmapId', async (req, res) => {
  const acc = await getUserAccount(req.user!.id, idParam(req.params.accountId));
  if (!acc) throw notFound('Account not found');
  await actions.destroyMailbox(acc, String(req.params.jmapId));
  res.json({ ok: true });
});

// ---------- Counts for the sidebar ----------

mailRouter.get('/counts', async (req, res) => {
  const accounts = await listAccounts(req.user!.id);
  const ids = accounts.map((a) => a.id);
  const inbox = await roleIds(ids, 'inbox');
  const drafts = await roleIds(ids, 'drafts');
  const unread = await query<{ account_id: number; n: number }>(`SELECT account_id, count(DISTINCT thread_id)::int AS n FROM emails WHERE account_id = ANY($1) AND is_unread AND mailbox_ids && $2::text[] AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id=emails.account_id AND s.thread_id=emails.thread_id AND NOT s.restored) GROUP BY account_id`, [ids, inbox]);
  const draftsN = await one<{ n: number }>(`SELECT count(*)::int AS n FROM emails e WHERE account_id = ANY($1) AND mailbox_ids && $2::text[] AND ${notDraftMirror('e')}`, [ids, drafts]);
  const localDrafts = await one<{ n: number }>(`SELECT count(*)::int AS n FROM drafts WHERE user_id=$1`, [req.user!.id]);
  const snoozed = await one<{ n: number }>(`SELECT count(*)::int AS n FROM snoozes WHERE user_id=$1 AND NOT restored`, [req.user!.id]);
  const scheduled = await one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE user_id=$1 AND status='scheduled'`, [req.user!.id]);
  const review = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [req.user!.id]);
  const labels = await query<{ account_id: number; jmap_id: string; n: number }>(`SELECT m.account_id, m.jmap_id, count(DISTINCT e.thread_id)::int AS n FROM mailboxes m JOIN emails e ON e.account_id=m.account_id AND m.jmap_id = ANY(e.mailbox_ids) AND e.is_unread WHERE m.account_id = ANY($1) AND m.role IS NULL GROUP BY m.account_id, m.jmap_id`, [ids]);
  res.json({
    inboxUnread: Object.fromEntries(unread.map((u) => [u.account_id, u.n])),
    inboxUnreadTotal: unread.reduce((s, u) => s + u.n, 0),
    drafts: (draftsN?.n ?? 0) + (localDrafts?.n ?? 0),
    snoozed: snoozed?.n ?? 0,
    scheduled: scheduled?.n ?? 0,
    review: review?.n ?? 0,
    labelUnread: Object.fromEntries(labels.map((l) => [`${l.account_id}:${l.jmap_id}`, l.n])),
  });
});

// ---------- Attachments / blobs ----------

mailRouter.get('/blob/:accountId/:blobId', async (req, res) => {
  const acc = await getUserAccount(req.user!.id, idParam(req.params.accountId));
  if (!acc) throw notFound('Account not found');
  const name = String(req.query.name ?? 'attachment');
  const type = String(req.query.type ?? 'application/octet-stream');
  const client = clientFor(acc);
  const upstream = await client.download(String(req.params.blobId), name, type);
  const safeType = /^(image\/(png|jpe?g|gif|webp|bmp|svg\+xml)|application\/pdf|text\/plain|audio\/|video\/)/.test(type) ? type : 'application/octet-stream';
  const inline = !req.query.download && safeType !== 'application/octet-stream' && safeType !== 'image/svg+xml' && safeType !== 'text/plain';
  res.setHeader('Content-Type', safeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', name));
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  const reader = upstream.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
});

const rawBody = raw({ type: () => true, limit: '25mb' });

// Both forms of the filename: the RFC 5987 one every current browser reads,
// and a plain ASCII fallback for the rest. Never characters that could end
// the header or the quoted string.
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'attachment';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

mailRouter.post('/uploads', rateLimit({ name: 'uploads', perMinute: 120 }), rawBody, async (req, res) => {
  const filename = String(req.query.filename ?? 'file').slice(0, 255);
  const type = String(req.query.type ?? 'application/octet-stream').slice(0, 120);
  const raw: Buffer = req.body;
  if (!Buffer.isBuffer(raw) || !raw.length) throw badRequest('Empty upload');
  // Photos and videos lose their metadata here, before they are ever stored.
  const scrub = scrubMedia(raw, type, filename);
  const data = scrub.data;
  const rows = await query<any>('INSERT INTO uploads (user_id, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, content_type, size', [req.user!.id, filename, type, data.length, data]);
  res.json({ upload: { ...rows[0], scrubbed: scrub.handled ? { changed: scrub.changed, removed: scrub.removed, savedBytes: raw.length - data.length, note: describeScrub(scrub) } : null } });
});

// The bytes back: for a browser that signs or encrypts the message itself,
// and (with ?inline=1) for an image that was inserted into the editor.
mailRouter.get('/uploads/:id', async (req, res) => {
  const u = await one<any>('SELECT filename, content_type, data FROM uploads WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  if (!u) throw notFound('Upload not found');
  const inlineImage = Boolean(req.query.inline) && /^image\/(png|jpe?g|gif|webp|bmp)$/.test(u.content_type);
  res.setHeader('Content-Type', inlineImage ? u.content_type : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', inlineImage ? 'private, max-age=3600' : 'private, no-store');
  res.setHeader('Content-Disposition', contentDisposition(inlineImage ? 'inline' : 'attachment', u.filename));
  res.send(u.data);
});

mailRouter.delete('/uploads/:id', async (req, res) => {
  await query('DELETE FROM uploads WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

// ---------- Send ----------

const sendSchema = z.object({
  accountId: z.number().int(),
  to: z.array(addressSchema).default([]),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(2_000_000).default(''),
  replyToEmailId: z.number().int().nullable().optional(),
  forwardOfEmailId: z.number().int().nullable().optional(),
  forwardBlobIds: z.array(z.string()).max(200).nullable().optional(),
  attachmentIds: z.array(z.number().int()).default([]),
  includeSignature: z.boolean().default(true),
  draftId: z.number().int().nullable().optional(),
  scheduleAt: z.string().nullable().optional(),
  humanize: z.boolean().default(false),
  // Held briefly so the sender can change their mind; sent as the plain
  // reply or compose it is, not logged as a scheduled message.
  undoWindow: z.boolean().default(false),
  contactId: z.number().int().nullable().optional(),
  encrypt: z.enum(['always', 'if_possible']).nullable().optional(),
  pgp: z.object({ mode: z.enum(['encrypted', 'signed']), armored: z.string().max(30_000_000).optional(), inner: z.string().max(30_000_000).optional(), signature: z.string().max(20_000).optional() }).nullable().optional(),
});

mailRouter.post('/send', async (req, res) => {
  const b = parse(sendSchema, req.body);
  const acc = await getUserAccount(req.user!.id, b.accountId);
  if (!acc) throw notFound('Account not found');
  const kind = b.replyToEmailId ? 'reply' : b.forwardOfEmailId ? 'forward' : 'compose';
  const recipients = [...b.to, ...b.cc, ...b.bcc];
  if (!recipients.length) throw badRequest('Add at least one recipient');
  const payload = { to: b.to as any, cc: b.cc as any, bcc: b.bcc as any, subject: b.subject, html: b.html, replyToEmailId: b.replyToEmailId ?? null, forwardOfEmailId: b.forwardOfEmailId ?? null, forwardBlobIds: b.forwardBlobIds ?? null, attachmentIds: b.attachmentIds, includeSignature: b.includeSignature, kind, contactId: b.contactId ?? null, encrypt: b.encrypt ?? null, pgp: b.pgp ?? null } as const;
  if (b.scheduleAt || b.humanize) {
    let sendAt = b.scheduleAt ? new Date(b.scheduleAt) : new Date();
    if (Number.isNaN(sendAt.getTime())) throw badRequest('Invalid schedule time');
    if (b.undoWindow && sendAt.getTime() > Date.now() + 120_000) throw badRequest('The undo window cannot be longer than two minutes');
    if (!b.scheduleAt && b.humanize) sendAt = new Date(Date.now() + Math.max(jitterMs(acc), 15_000));
    const sealedPayload = await seal(req.user!.id, JSON.stringify({ ...payload, humanize: b.humanize && Boolean(b.scheduleAt), undoWindow: b.undoWindow, draftId: b.draftId ?? null }));
    const uploadIds = [...new Set([...(b.attachmentIds ?? []), ...inlineUploadIds(b.html ?? '')])];
    const rows = await query<any>('INSERT INTO outbox (user_id, account_id, payload, send_at, upload_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id, send_at', [req.user!.id, acc.id, sealedPayload, sendAt, uploadIds]);
    if (b.draftId) await discardDraft(req.user!.id, b.draftId);
    if (b.undoWindow) wakeOutboxAt(sendAt);
    res.json({ ok: true, scheduled: true, outboxId: rows[0].id, sendAt: rows[0].send_at });
    return;
  }
  const { outcome } = await composeAndSend(acc, { ...payload });
  if (b.draftId) await discardDraft(req.user!.id, b.draftId);
  res.json({ ok: true, messageId: outcome.messageId, threadId: outcome.threadId, via: outcome.via });
});

// ---------- Outbox (scheduled) ----------

mailRouter.get('/outbox', async (req, res) => {
  const rows = await query<any>(`SELECT o.id, o.account_id, o.send_at, o.status, o.error, o.attempts, o.created_at, o.payload FROM outbox o WHERE o.user_id=$1 AND o.status IN ('scheduled','sending','failed') ORDER BY o.send_at`, [req.user!.id]);
  // The payload is sealed, so subject and recipients are read out here rather
  // than picked from JSONB in the query.
  const outbox = await Promise.all(rows.map(async ({ payload, ...rest }) => {
    const p = await openPayload(req.user!.id, payload);
    return { ...rest, subject: p.subject ?? '', to_addr: p.to ?? [], humanize: p.humanize ?? false };
  }));
  res.json({ outbox });
});

// Cancelling a queued message hands it back as a draft, so an undone send
// or a scheduled message that is no longer wanted loses nothing.
mailRouter.delete('/outbox/:id', async (req, res) => {
  const rows = await query<any>(`UPDATE outbox SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status IN ('scheduled','failed') RETURNING account_id, payload`, [idParam(req.params.id), req.user!.id]);
  if (!rows.length) {
    const existing = await one<{ status: string }>('SELECT status FROM outbox WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
    res.json({ ok: true, cancelled: false, status: existing?.status ?? 'gone', draft: null });
    return;
  }
  const p = await openPayload(req.user!.id, rows[0].payload);
  let draft: any = null;
  try {
    const threadId = p.replyToEmailId || p.forwardOfEmailId ? (await one<{ thread_id: string }>('SELECT thread_id FROM emails WHERE id=$1', [p.replyToEmailId || p.forwardOfEmailId]))?.thread_id ?? null : null;
    const kind = p.kind === 'reply' ? 'reply' : p.kind === 'forward' ? 'forward' : 'new';
    const sealed = await sealDraft(req.user!.id, { subject: p.subject ?? '', body_html: p.pgp ? '' : (p.html ?? ''), to_addr: p.to ?? [], cc_addr: p.cc ?? [], bcc_addr: p.bcc ?? [] });
    const inserted = await query<any>(
      `INSERT INTO drafts (user_id, account_id, kind, reply_to_email_id, forward_of_email_id, forward_blob_ids, thread_id, to_addr, cc_addr, bcc_addr, subject, body_html, attachment_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.user!.id, rows[0].account_id, kind, p.replyToEmailId ?? null, p.forwardOfEmailId ?? null, Array.isArray(p.forwardBlobIds) ? p.forwardBlobIds : [], threadId, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.subject, sealed.body_html, Array.isArray(p.attachmentIds) ? p.attachmentIds : []],
    );
    draft = inserted[0] ? await openDraft(req.user!.id, inserted[0]) : null;
    if (draft) draft.attachments = await query<any>('SELECT id, filename, size, content_type FROM uploads WHERE id = ANY($1) AND user_id=$2 ORDER BY id', [draft.attachment_ids, req.user!.id]);
  } catch { /* the message is cancelled either way */ }
  res.json({ ok: true, cancelled: true, draft });
});

mailRouter.post('/outbox/:id/now', async (req, res) => {
  await query(`UPDATE outbox SET status='scheduled', send_at=now(), attempts=0 WHERE id=$1 AND user_id=$2 AND status IN ('scheduled','failed')`, [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

// ---------- Drafts (local) ----------

const draftSchema = z.object({
  id: z.number().int().nullable().optional(),
  accountId: z.number().int().nullable().optional(),
  kind: z.enum(['new', 'reply', 'reply_all', 'forward']).default('new'),
  replyToEmailId: z.number().int().nullable().optional(),
  forwardOfEmailId: z.number().int().nullable().optional(),
  forwardBlobIds: z.array(z.string()).max(200).default([]),
  threadId: z.string().nullable().optional(),
  to: z.array(addressSchema).default([]),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(2_000_000).default(''),
  attachmentIds: z.array(z.number().int()).default([]),
});

mailRouter.get('/drafts', async (req, res) => {
  const rows = await withDraftContent(req.user!.id, await query<any>(`SELECT d.*, r.name AS responder_name, ${DRAFT_ATTACHMENTS} FROM drafts d LEFT JOIN responders r ON r.id=d.responder_id WHERE d.user_id=$1 ORDER BY d.updated_at DESC`, [req.user!.id]));
  res.json({ drafts: rows });
});

mailRouter.post('/drafts', async (req, res) => {
  const b = parse(draftSchema, req.body);
  const sealed = await sealDraft(req.user!.id, { subject: b.subject, body_html: b.html, to_addr: b.to, cc_addr: b.cc, bcc_addr: b.bcc });
  // The body is about to become ciphertext, so the inline images it points at
  // are noted here or the daily sweep would collect them.
  const inlineIds = inlineUploadIds(b.html ?? '');
  const vals = [req.user!.id, b.accountId ?? null, b.kind, b.replyToEmailId ?? null, b.threadId ?? null, sealed.to_addr, sealed.cc_addr, sealed.bcc_addr, sealed.subject, sealed.body_html, b.attachmentIds, b.forwardOfEmailId ?? null, b.forwardBlobIds, inlineIds];
  const rows = b.id
    ? await query<any>(`UPDATE drafts SET account_id=$2, kind=$3, reply_to_email_id=$4, thread_id=$5, to_addr=$6, cc_addr=$7, bcc_addr=$8, subject=$9, body_html=$10, attachment_ids=$11, forward_of_email_id=$12, forward_blob_ids=$13, inline_upload_ids=$14, updated_at=now() WHERE id=$15 AND user_id=$1 RETURNING *`, [...vals, b.id])
    : await query<any>(`INSERT INTO drafts (user_id, account_id, kind, reply_to_email_id, thread_id, to_addr, cc_addr, bcc_addr, subject, body_html, attachment_ids, forward_of_email_id, forward_blob_ids, inline_upload_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, vals);
  if (!rows.length) throw notFound('Draft not found');
  await markDirty(rows[0].id);
  res.json({ draft: await openDraft(req.user!.id, rows[0]) });
});

mailRouter.delete('/drafts/:id', async (req, res) => {
  await discardDraft(req.user!.id, idParam(req.params.id));
  res.json({ ok: true });
});

// Deleting a draft here deletes the copy on the mail server too, so the two
// do not drift. The local row goes either way: a mail server that refuses is
// logged, not a reason to keep a draft the person deleted.
async function discardDraft(userId: number, draftId: number): Promise<void> {
  const rows = await query<{ account_id: number | null; jmap_id: string | null }>('DELETE FROM drafts WHERE id=$1 AND user_id=$2 RETURNING account_id, jmap_id', [draftId, userId]);
  if (rows[0]) await removeDraft(userId, rows[0]);
}

// ---------- Address autocomplete ----------

mailRouter.get('/suggest', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q.length < 1) { res.json({ suggestions: [] }); return; }
  const accounts = await listAccounts(req.user!.id);
  const like = `%${q}%`;
  const contacts = await query<any>(`SELECT email, first_name, last_name, company FROM contacts WHERE user_id=$1 AND (lower(email) LIKE $2 OR lower(first_name||' '||last_name) LIKE $2 OR lower(company) LIKE $2) ORDER BY last_contacted_at DESC NULLS LAST LIMIT 8`, [req.user!.id, like]);
  // Addresses are ciphertext, so this cannot be a LIKE over the table. The
  // last few hundred messages are opened instead, which is where an
  // autocomplete's useful answers live anyway.
  const recentRows = await query<{ from_addr: string; to_addr: string; cc_addr: string }>(
    `SELECT from_addr, to_addr, cc_addr FROM emails WHERE account_id = ANY($1) ORDER BY received_at DESC LIMIT 400`,
    [accounts.map((a) => a.id)],
  );
  const dek = await dataKey(req.user!.id);
  const recent: { email: string; name: string }[] = [];
  const recentSeen = new Set<string>();
  for (const row of recentRows) {
    const opened = openEmailWith(dek, row);
    for (const a of [...(opened.from_addr ?? []), ...(opened.to_addr ?? []), ...(opened.cc_addr ?? [])] as any[]) {
      const e = String(a?.email ?? '').toLowerCase();
      if (!e || recentSeen.has(e)) continue;
      if (!e.includes(q) && !String(a?.name ?? '').toLowerCase().includes(q)) continue;
      recentSeen.add(e);
      recent.push({ email: a.email, name: a.name ?? '' });
      if (recent.length >= 8) break;
    }
    if (recent.length >= 8) break;
  }
  const seen = new Set<string>();
  const out: { email: string; name: string; source: string }[] = [];
  for (const c of contacts) { const e = c.email.toLowerCase(); if (!seen.has(e)) { seen.add(e); out.push({ email: c.email, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company, source: 'contact' }); } }
  for (const r of recent) { const e = String(r.email).toLowerCase(); if (!seen.has(e)) { seen.add(e); out.push({ email: r.email, name: r.name ?? '', source: 'recent' }); } }
  res.json({ suggestions: out.slice(0, 10) });
});
