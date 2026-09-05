import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { PRESETS, connectAccount, encryptSecret, getUserAccount, listAccounts, publicAccount, validateSessionUrl, type AccountRow } from '../services/accounts.js';
import { JmapClient, basicAuth, bearerAuth, jmapErrorMessage, SUBMISSION, CORE, MAIL } from '../jmap/client.js';
import { syncManager } from '../workers/syncManager.js';
import { syncAccount } from '../jmap/sync.js';
import { config } from '../config.js';
import { describeWindow, isWindowOpen, nextWindowOpen, sentToday } from '../services/sending.js';
import { encrypt } from '../crypto.js';

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

const windowSchema = z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(24), days: z.array(z.number().int().min(0).max(6)), tz: z.string().min(1).max(64) });

const credsSchema = z.object({
  provider: z.enum(['fastmail', 'stalwart', 'jmap']),
  sessionUrl: z.string().optional(),
  authType: z.enum(['bearer', 'basic']).optional(),
  authUser: z.string().max(200).optional(),
  secret: z.string().min(1).max(4000),
  pinOrigin: z.boolean().optional(),
});

function resolveCreds(c: z.infer<typeof credsSchema>) {
  const preset = PRESETS[c.provider];
  let sessionUrl = c.sessionUrl?.trim() || preset.sessionUrl;
  if (!sessionUrl && c.provider === 'stalwart' && config.stalwartUrl) sessionUrl = `${config.stalwartUrl}/.well-known/jmap`;
  if (!sessionUrl) throw badRequest('Session URL is required');
  // People paste the host, or the admin URL; be forgiving.
  if (!/\/(\.well-known\/jmap|jmap\/session|jmap)\/?$/.test(sessionUrl) && !sessionUrl.includes('/jmap')) sessionUrl = sessionUrl.replace(/\/+$/, '') + '/.well-known/jmap';
  sessionUrl = validateSessionUrl(sessionUrl);
  const authType = c.authType ?? preset.authType;
  if (authType === 'basic' && !c.authUser) throw badRequest('Username is required for password authentication');
  const pinOrigin = c.pinOrigin ?? preset.pinOrigin;
  return { sessionUrl, authType, authUser: c.authUser ?? null, pinOrigin };
}

accountsRouter.get('/presets', (_req, res) => {
  res.json({ presets: PRESETS, localStalwart: config.stalwartUrl ? { sessionUrl: `${config.stalwartUrl}/.well-known/jmap`, host: config.stalwartHost } : null });
});

accountsRouter.get('/', async (req, res) => {
  const rows = await listAccounts(req.user!.id);
  res.json({ accounts: rows.map((a) => ({ ...publicAccount(a), push: syncManager.status(a.id) })) });
});

// Verify credentials without saving anything.
accountsRouter.post('/test', async (req, res) => {
  const c = parse(credsSchema, req.body);
  const r = resolveCreds(c);
  const client = new JmapClient({ sessionUrl: r.sessionUrl, authHeader: r.authType === 'bearer' ? bearerAuth(c.secret) : basicAuth(r.authUser ?? '', c.secret), pinOrigin: r.pinOrigin, timeoutMs: 20_000 });
  try {
    const s = await client.fetchSession();
    let identities: { name: string; email: string }[] = [];
    try {
      const idr = await client.one('Identity/get', { accountId: s.accountId, ids: null }, [CORE, MAIL, SUBMISSION]);
      identities = (idr.list ?? []).map((i: any) => ({ name: i.name, email: i.email }));
    } catch { /* optional */ }
    res.json({ ok: true, username: s.username, email: identities[0]?.email ?? (s.username.includes('@') ? s.username : r.authUser ?? ''), identities, hasSubmission: s.hasSubmission, hasPush: Boolean(s.eventSourceUrl), apiUrl: s.apiUrl });
  } catch (e) {
    res.status(400).json({ ok: false, error: jmapErrorMessage(e) });
  }
});

const createSchema = credsSchema.extend({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  signatureHtml: z.string().max(20000).optional(),
});

accountsRouter.post('/', async (req, res) => {
  const body = parse(createSchema, req.body);
  const r = resolveCreds(body);
  const dup = await one('SELECT 1 FROM accounts WHERE user_id=$1 AND lower(email)=lower($2)', [req.user!.id, body.email]);
  if (dup) throw conflict('That mailbox is already connected');
  const rows = await query<AccountRow>(
    `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_user, auth_secret_enc, pin_origin, color, signature_html)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.user!.id, body.name, body.email.toLowerCase(), body.provider, r.sessionUrl, r.authType, r.authUser, encryptSecret(body.secret), r.pinOrigin, body.color ?? '#4f6df5', body.signatureHtml ?? ''],
  );
  const acc = rows[0];
  try {
    await connectAccount(acc);
  } catch (e) {
    await query('DELETE FROM accounts WHERE id=$1', [acc.id]);
    throw badRequest(`Could not connect: ${jmapErrorMessage(e)}`);
  }
  syncManager.add(acc.id);
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'accounts.created',$2,$3)`, [req.user!.id, String(acc.id), JSON.stringify({ email: acc.email, provider: acc.provider })]);
  res.json({ account: publicAccount((await getUserAccount(req.user!.id, acc.id))!) });
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  signatureHtml: z.string().max(20000).optional(),
  voice: z.string().max(4000).optional(),
  dailyCap: z.number().int().min(0).max(5000).optional(),
  jitterEnabled: z.boolean().optional(),
  jitterMinS: z.number().int().min(0).max(86400).optional(),
  jitterMaxS: z.number().int().min(0).max(86400).optional(),
  sendWindow: windowSchema.optional(),
  syncLimit: z.number().int().min(100).max(50000).optional(),
  enabled: z.boolean().optional(),
  secret: z.string().min(1).max(4000).optional(),
  authUser: z.string().max(200).optional(),
  sessionUrl: z.string().optional(),
  pinOrigin: z.boolean().optional(),
  sendVia: z.enum(['jmap', 'smtp']).optional(),
  smtp: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), secure: z.boolean(), user: z.string(), pass: z.string().optional() }).nullable().optional(),
});

accountsRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  const b = parse(updateSchema, req.body);
  if (b.jitterMinS !== undefined && b.jitterMaxS !== undefined && b.jitterMinS > b.jitterMaxS) throw badRequest('Minimum delay must not exceed the maximum');
  let smtp = acc.smtp;
  if (b.smtp === null) smtp = null;
  else if (b.smtp) smtp = { host: b.smtp.host, port: b.smtp.port, secure: b.smtp.secure, user: b.smtp.user, pass_enc: b.smtp.pass ? encrypt(b.smtp.pass) : acc.smtp?.pass_enc ?? '' };
  const credsChanged = b.secret !== undefined || b.sessionUrl !== undefined || b.authUser !== undefined || b.pinOrigin !== undefined;
  const sessionUrl = b.sessionUrl ? validateSessionUrl(b.sessionUrl) : acc.session_url;
  await query(
    `UPDATE accounts SET name=COALESCE($2,name), color=COALESCE($3,color), signature_html=COALESCE($4,signature_html), daily_cap=COALESCE($5,daily_cap),
       jitter_enabled=COALESCE($6,jitter_enabled), jitter_min_s=COALESCE($7,jitter_min_s), jitter_max_s=COALESCE($8,jitter_max_s), send_window=COALESCE($9,send_window),
       sync_limit=COALESCE($10,sync_limit), enabled=COALESCE($11,enabled), auth_secret_enc=COALESCE($12,auth_secret_enc), auth_user=COALESCE($13,auth_user), session_url=$14,
       pin_origin=COALESCE($15,pin_origin), send_via=COALESCE($16,send_via), smtp=$17,
       api_url = CASE WHEN $18 THEN NULL ELSE api_url END, sync_status = CASE WHEN $18 THEN 'idle' ELSE sync_status END, sync_error = CASE WHEN $18 THEN NULL ELSE sync_error END,
       voice=COALESCE($19, voice)
     WHERE id=$1`,
    [id, b.name ?? null, b.color ?? null, b.signatureHtml ?? null, b.dailyCap ?? null, b.jitterEnabled ?? null, b.jitterMinS ?? null, b.jitterMaxS ?? null, b.sendWindow ? JSON.stringify(b.sendWindow) : null,
      b.syncLimit ?? null, b.enabled ?? null, b.secret ? encryptSecret(b.secret) : null, b.authUser ?? null, sessionUrl, b.pinOrigin ?? null, b.sendVia ?? null, smtp ? JSON.stringify(smtp) : null, credsChanged, b.voice ?? null],
  );
  if (credsChanged || b.enabled !== undefined) await syncManager.refresh(id);
  res.json({ account: publicAccount((await getUserAccount(req.user!.id, id))!) });
});

accountsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  syncManager.remove(id);
  await query('DELETE FROM accounts WHERE id=$1', [id]);
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'accounts.deleted',$2,$3)`, [req.user!.id, String(id), JSON.stringify({ email: acc.email })]);
  res.json({ ok: true });
});

accountsRouter.post('/:id/resync', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  const full = Boolean(req.body?.full);
  if (full) await query('UPDATE accounts SET email_state=NULL, api_url=NULL WHERE id=$1', [id]);
  syncAccount(id, { full }).catch(() => {});
  res.json({ ok: true });
});

accountsRouter.get('/:id/stats', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  const today = await sentToday(acc);
  const week = await one<{ sent: number; replied: number; bounced: number; failed: number }>(
    `SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied, count(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced, count(*) FILTER (WHERE status='failed')::int AS failed
     FROM send_log WHERE account_id=$1 AND sent_at > now() - interval '7 days'`,
    [id],
  );
  const now = new Date();
  res.json({
    sentToday: today,
    dailyCap: acc.daily_cap,
    windowOpen: isWindowOpen(acc.send_window, now),
    nextWindowOpen: nextWindowOpen(acc.send_window, now),
    windowText: describeWindow(acc.send_window),
    nextSendAt: acc.next_send_at,
    week,
    push: syncManager.status(id),
  });
});
