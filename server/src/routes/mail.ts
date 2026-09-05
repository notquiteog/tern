import { Router, raw } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z, addressSchema } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { clientFor, getUserAccount, listAccounts, type AccountRow } from '../services/accounts.js';
import * as actions from '../jmap/actions.js';
import { syncManager } from '../workers/syncManager.js';
import { composeAndSend } from '../services/compose.js';
import { jitterMs } from '../services/sending.js';
import { parseSearch, buildSearchSql } from '../services/search.js';
import { brandDomains } from '../services/brand.js';
import { describeScrub, scrubMedia } from '../services/scrub.js';

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

  const where: string[] = ['e.account_id = ANY($1)'];
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
    const sql = await buildSearchSql(parsed, accountIds, p);
    where.push(...sql);
  }

  const whereSql = where.join(' AND ');
  // Membership in the box decides which threads appear; the count, the
  // latest message and the ordering come from the whole conversation, the
  // way Gmail does it, so a reply you sent still bumps the thread.
  const agg = `SELECT e.account_id, e.thread_id, bool_or(e.is_unread) AS unread, bool_or(e.is_flagged) AS starred, bool_or(e.has_attachment) AS has_attachment, bool_or(e.is_draft) AS has_draft
               FROM emails e WHERE ${whereSql} GROUP BY e.account_id, e.thread_id`;
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM (${agg}) t`, params);
  const rows = await query<any>(
    `SELECT t.*,
       (SELECT max(x.received_at) FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS last_at,
       (SELECT count(*)::int FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS n, 
       (SELECT jsonb_build_object('id', x.id, 'jmap_id', x.jmap_id, 'subject', x.subject, 'preview', x.preview, 'from', x.from_addr, 'to', x.to_addr, 'received_at', x.received_at)
          FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id ORDER BY x.received_at DESC LIMIT 1) AS latest,
       (SELECT jsonb_agg(DISTINCT x.from_addr->0) FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id AND jsonb_typeof(x.from_addr->0) = 'object') AS participants,
       (SELECT array_agg(DISTINCT m) FROM emails x, unnest(x.mailbox_ids) m WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id) AS mailbox_ids,
       (SELECT s.until_at FROM snoozes s WHERE s.account_id=t.account_id AND s.thread_id=t.thread_id AND NOT s.restored LIMIT 1) AS snoozed_until,
       (SELECT c.id FROM contact_threads ct JOIN contacts c ON c.id=ct.contact_id WHERE ct.account_id=t.account_id AND ct.thread_id=t.thread_id LIMIT 1) AS contact_id,
       (SELECT jsonb_build_object('id', c.id, 'v', (extract(epoch FROM c.avatar_updated_at) * 1000)::bigint) FROM contacts c
          WHERE c.user_id=${p(req.user!.id)} AND c.avatar_updated_at IS NOT NULL AND lower(c.email) = (SELECT x.from_email FROM emails x WHERE x.account_id=t.account_id AND x.thread_id=t.thread_id ORDER BY x.received_at DESC LIMIT 1) LIMIT 1) AS avatar
     FROM (${agg}) t ORDER BY last_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  const me = req.user!;
  const myEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
  const brands = await brandDomains();
  res.json({
    threads: rows.map((r) => {
      const fromEmail = String(r.latest?.from?.[0]?.email ?? '').toLowerCase();
      const fromDomain = fromEmail.split('@')[1] ?? '';
      const avatarUrl = r.avatar?.id ? `/api/avatars/contact/${r.avatar.id}?v=${r.avatar.v}` : myEmails.has(fromEmail) && me.avatar_updated_at ? `/api/avatars/user/${me.id}?v=${new Date(me.avatar_updated_at).getTime()}` : brands.has(fromDomain) ? `/bimi/${fromDomain}.svg?v=${brands.get(fromDomain)}` : null;
      const { avatar: _a, ...rest } = r;
      return { ...rest, key: `${r.account_id}:${r.thread_id}`, avatar_url: avatarUrl };
    }),
    total: total?.n ?? 0, page, pageSize,
  });
});

// ---------- Thread detail ----------

mailRouter.get('/threads/:accountId/:threadId', async (req, res) => {
  const acc = await getUserAccount(req.user!.id, idParam(req.params.accountId));
  if (!acc) throw notFound('Account not found');
  const threadId = String(req.params.threadId);
  const messages = await query<any>(
    `SELECT id, jmap_id, blob_id, thread_id, mailbox_ids, keywords, size, received_at, sent_at, message_id, in_reply_to, references_ids, from_addr, to_addr, cc_addr, bcc_addr, reply_to,
            subject, preview, has_attachment, body_text, body_html, attachments, is_unread, is_flagged, is_draft, from_email
     FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC`,
    [acc.id, threadId],
  );
  if (!messages.length) throw notFound('Thread not found');
  // Profile pictures: a contact's photo for their address, the user's own for the account's address.
  const senders = [...new Set(messages.map((m: any) => m.from_email).filter(Boolean))];
  const photos = await query<{ email: string; id: number; v: number }>(`SELECT lower(email) AS email, id, (extract(epoch FROM avatar_updated_at) * 1000)::bigint AS v FROM contacts WHERE user_id=$1 AND avatar_updated_at IS NOT NULL AND lower(email) = ANY($2)`, [req.user!.id, senders]);
  const photoMap = new Map(photos.map((p) => [p.email, `/api/avatars/contact/${p.id}?v=${p.v}`]));
  if (req.user!.avatar_updated_at) photoMap.set(acc.email.toLowerCase(), `/api/avatars/user/${req.user!.id}?v=${new Date(req.user!.avatar_updated_at).getTime()}`);
  const brands = await brandDomains();
  for (const m of messages) {
    const d = String(m.from_email ?? '').split('@')[1] ?? '';
    (m as any).avatar_url = photoMap.get(m.from_email) ?? (brands.has(d) ? `/bimi/${d}.svg?v=${brands.get(d)}` : null);
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
  const drafts = await query<any>(`SELECT d.*, r.name AS responder_name FROM drafts d LEFT JOIN responders r ON r.id=d.responder_id WHERE d.user_id=$1 AND d.account_id=$2 AND d.thread_id=$3 ORDER BY d.updated_at DESC`, [req.user!.id, acc.id, threadId]);
  const pendingJobs = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ai_jobs WHERE user_id=$1 AND kind='responder' AND status IN ('pending','running') AND payload->>'threadId'=$2 AND (payload->>'accountId')::bigint=$3`, [req.user!.id, threadId, acc.id]);
  res.json({ account: { id: acc.id, email: acc.email, name: acc.name, color: acc.color }, messages, mailboxes, contact, enrollments, sends, snoozedUntil: snooze?.until_at ?? null, drafts, aiPending: pendingJobs?.n ?? 0 });
});

// ---------- Actions ----------

const actionSchema = z.object({
  accountId: z.number().int(),
  jmapIds: z.array(z.string()).optional(),
  threadIds: z.array(z.string()).optional(),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'spam', 'inbox', 'delete', 'label', 'unlabel', 'snooze', 'unsnooze', 'move']),
  mailboxId: z.string().optional(),
  until: z.string().optional(),
});

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
  if (!ids.length && !['snooze', 'unsnooze'].includes(b.action)) { res.json({ ok: true, count: 0 }); return; }
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
  }
  syncManager.requestSync(acc.id, 1200);
  res.json({ ok: true, count: ids.length });
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
  const draftsN = await one<{ n: number }>(`SELECT count(*)::int AS n FROM emails WHERE account_id = ANY($1) AND mailbox_ids && $2::text[]`, [ids, drafts]);
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
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
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

mailRouter.post('/uploads', rawBody, async (req, res) => {
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

// The bytes back, for a browser that signs or encrypts the message itself.
mailRouter.get('/uploads/:id', async (req, res) => {
  const u = await one<any>('SELECT filename, content_type, data FROM uploads WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  if (!u) throw notFound('Upload not found');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(u.filename)}`);
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
  attachmentIds: z.array(z.number().int()).default([]),
  includeSignature: z.boolean().default(true),
  draftId: z.number().int().nullable().optional(),
  scheduleAt: z.string().nullable().optional(),
  humanize: z.boolean().default(false),
  contactId: z.number().int().nullable().optional(),
  encrypt: z.enum(['always', 'if_possible']).nullable().optional(),
  pgp: z.object({ mode: z.enum(['encrypted', 'signed']), armored: z.string().max(30_000_000).optional(), inner: z.string().max(30_000_000).optional(), signature: z.string().max(20_000).optional() }).nullable().optional(),
});

mailRouter.post('/send', async (req, res) => {
  const b = parse(sendSchema, req.body);
  const acc = await getUserAccount(req.user!.id, b.accountId);
  if (!acc) throw notFound('Account not found');
  const kind = b.replyToEmailId ? 'reply' : b.forwardOfEmailId ? 'forward' : 'compose';
  const payload = { to: b.to as any, cc: b.cc as any, bcc: b.bcc as any, subject: b.subject, html: b.html, replyToEmailId: b.replyToEmailId ?? null, forwardOfEmailId: b.forwardOfEmailId ?? null, attachmentIds: b.attachmentIds, includeSignature: b.includeSignature, kind, contactId: b.contactId ?? null, encrypt: b.encrypt ?? null, pgp: b.pgp ?? null } as const;
  if (b.scheduleAt || b.humanize) {
    let sendAt = b.scheduleAt ? new Date(b.scheduleAt) : new Date();
    if (Number.isNaN(sendAt.getTime())) throw badRequest('Invalid schedule time');
    if (!b.scheduleAt && b.humanize) sendAt = new Date(Date.now() + Math.max(jitterMs(acc), 15_000));
    const rows = await query<any>('INSERT INTO outbox (user_id, account_id, payload, send_at) VALUES ($1,$2,$3,$4) RETURNING id, send_at', [req.user!.id, acc.id, JSON.stringify({ ...payload, humanize: b.humanize && Boolean(b.scheduleAt) }), sendAt]);
    if (b.draftId) await query('DELETE FROM drafts WHERE id=$1 AND user_id=$2', [b.draftId, req.user!.id]);
    res.json({ ok: true, scheduled: true, outboxId: rows[0].id, sendAt: rows[0].send_at });
    return;
  }
  const { outcome } = await composeAndSend(acc, { ...payload });
  if (b.draftId) await query('DELETE FROM drafts WHERE id=$1 AND user_id=$2', [b.draftId, req.user!.id]);
  res.json({ ok: true, messageId: outcome.messageId, threadId: outcome.threadId, via: outcome.via });
});

// ---------- Outbox (scheduled) ----------

mailRouter.get('/outbox', async (req, res) => {
  const rows = await query<any>(`SELECT o.id, o.account_id, o.send_at, o.status, o.error, o.attempts, o.created_at, o.payload->>'subject' AS subject, o.payload->'to' AS to_addr, o.payload->>'humanize' AS humanize FROM outbox o WHERE o.user_id=$1 AND o.status IN ('scheduled','sending','failed') ORDER BY o.send_at`, [req.user!.id]);
  res.json({ outbox: rows });
});

mailRouter.delete('/outbox/:id', async (req, res) => {
  await query(`UPDATE outbox SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status IN ('scheduled','failed')`, [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
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
  threadId: z.string().nullable().optional(),
  to: z.array(addressSchema).default([]),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(2_000_000).default(''),
  attachmentIds: z.array(z.number().int()).default([]),
});

mailRouter.get('/drafts', async (req, res) => {
  const rows = await query<any>('SELECT d.*, r.name AS responder_name FROM drafts d LEFT JOIN responders r ON r.id=d.responder_id WHERE d.user_id=$1 ORDER BY d.updated_at DESC', [req.user!.id]);
  res.json({ drafts: rows });
});

mailRouter.post('/drafts', async (req, res) => {
  const b = parse(draftSchema, req.body);
  const vals = [req.user!.id, b.accountId ?? null, b.kind, b.replyToEmailId ?? null, b.threadId ?? null, JSON.stringify(b.to), JSON.stringify(b.cc), JSON.stringify(b.bcc), b.subject, b.html, b.attachmentIds];
  const rows = b.id
    ? await query<any>(`UPDATE drafts SET account_id=$2, kind=$3, reply_to_email_id=$4, thread_id=$5, to_addr=$6, cc_addr=$7, bcc_addr=$8, subject=$9, body_html=$10, attachment_ids=$11, updated_at=now() WHERE id=$12 AND user_id=$1 RETURNING *`, [...vals, b.id])
    : await query<any>(`INSERT INTO drafts (user_id, account_id, kind, reply_to_email_id, thread_id, to_addr, cc_addr, bcc_addr, subject, body_html, attachment_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, vals);
  if (!rows.length) throw notFound('Draft not found');
  res.json({ draft: rows[0] });
});

mailRouter.delete('/drafts/:id', async (req, res) => {
  await query('DELETE FROM drafts WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

// ---------- Address autocomplete ----------

mailRouter.get('/suggest', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q.length < 1) { res.json({ suggestions: [] }); return; }
  const accounts = await listAccounts(req.user!.id);
  const like = `%${q}%`;
  const contacts = await query<any>(`SELECT email, first_name, last_name, company FROM contacts WHERE user_id=$1 AND (lower(email) LIKE $2 OR lower(first_name||' '||last_name) LIKE $2 OR lower(company) LIKE $2) ORDER BY last_contacted_at DESC NULLS LAST LIMIT 8`, [req.user!.id, like]);
  const recent = await query<any>(
    `SELECT DISTINCT ON (lower(a->>'email')) a->>'email' AS email, a->>'name' AS name FROM emails e, jsonb_array_elements(e.from_addr || e.to_addr || e.cc_addr) a
     WHERE e.account_id = ANY($1) AND (lower(a->>'email') LIKE $2 OR lower(coalesce(a->>'name','')) LIKE $2) AND a->>'email' IS NOT NULL LIMIT 8`,
    [accounts.map((a) => a.id), like],
  );
  const seen = new Set<string>();
  const out: { email: string; name: string; source: string }[] = [];
  for (const c of contacts) { const e = c.email.toLowerCase(); if (!seen.has(e)) { seen.add(e); out.push({ email: c.email, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company, source: 'contact' }); } }
  for (const r of recent) { const e = String(r.email).toLowerCase(); if (!seen.has(e)) { seen.add(e); out.push({ email: r.email, name: r.name ?? '', source: 'recent' }); } }
  res.json({ suggestions: out.slice(0, 10) });
});
