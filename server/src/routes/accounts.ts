import { Router, type Request } from 'express';
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
import { decrypt, encrypt, verifyPassword } from '../crypto.js';
import { isManagedAccount, stalwartAccountFor } from '../services/provision.js';
import * as sw from '../services/stalwart.js';
import { assertPublicHost, isInternalOrigin } from '../util/netguard.js';
import { rateLimit } from '../util/rateLimit.js';
import { previewRetention, retentionOf, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from '../services/retention.js';

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

async function resolveCreds(c: z.infer<typeof credsSchema>) {
  const preset = PRESETS[c.provider];
  let sessionUrl = c.sessionUrl?.trim() || preset.sessionUrl;
  if (!sessionUrl && c.provider === 'stalwart' && config.stalwartUrl) sessionUrl = `${config.stalwartUrl}/.well-known/jmap`;
  if (!sessionUrl) throw badRequest('Session URL is required');
  // People paste the host, or the admin URL; be forgiving.
  if (!/^https?:\/\//i.test(sessionUrl)) sessionUrl = `https://${sessionUrl}`;
  if (!/\/(\.well-known\/jmap|jmap\/session|jmap)\/?$/.test(sessionUrl) && !sessionUrl.includes('/jmap')) sessionUrl = sessionUrl.replace(/\/+$/, '') + '/.well-known/jmap';
  sessionUrl = await validateSessionUrl(sessionUrl);
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

// What a desktop or phone mail app needs to open the same mailboxes: IMAP,
// SMTP and JMAP endpoints per connected account. Nothing secret is returned;
// the password is the one the person already uses for the mailbox.
export interface ClientSettings {
  accountId: number; name: string; email: string; provider: string; color: string;
  imap: { host: string; port: number; security: 'SSL/TLS' | 'STARTTLS'; username: string; guessed: boolean } | null;
  smtp: { host: string; port: number; security: 'SSL/TLS' | 'STARTTLS'; username: string; guessed: boolean; alt?: { port: number; security: 'SSL/TLS' | 'STARTTLS' } } | null;
  jmap: { sessionUrl: string; username: string } | null;
  password: 'mailbox' | 'app_password' | 'token';
  autoconfig: boolean;
  notes: string[];
  // Tern holds the mailbox password (HTTP Basic accounts) and can show it back.
  storedPassword: boolean;
  // On the bundled mail server: the password can be reset from here too.
  managed: boolean;
}
export function clientSettingsFor(a: AccountRow): ClientSettings {
  const email = a.email.toLowerCase();
  const domain = email.split('@')[1] ?? '';
  let sessionHost = '';
  try { sessionHost = new URL(a.session_url).hostname; } catch { /* stored URLs are validated */ }
  const base = { accountId: a.id, name: a.name, email: a.email, provider: a.provider, color: a.color, storedPassword: a.auth_type === 'basic', managed: isManagedAccount(a) };
  if (a.provider === 'fastmail') {
    return {
      ...base,
      imap: { host: 'imap.fastmail.com', port: 993, security: 'SSL/TLS', username: email, guessed: false },
      smtp: { host: 'smtp.fastmail.com', port: 465, security: 'SSL/TLS', username: email, guessed: false, alt: { port: 587, security: 'STARTTLS' } },
      jmap: { sessionUrl: 'https://api.fastmail.com/jmap/session', username: email },
      password: 'app_password',
      autoconfig: true,
      notes: ['Fastmail mail apps sign in with an app password, not your account password and not the API token Tern uses. Create one at Fastmail → Settings → Privacy & Security → Integrations → New app password, with access to Mail.', 'Most apps recognise Fastmail from the address alone and fill the servers in for you.'],
    };
  }
  if (a.provider === 'stalwart') {
    // The stored session URL may be the internal compose-network address; the public host is what the app needs.
    const internal = config.stalwartUrl && a.session_url.startsWith(config.stalwartUrl);
    const host = internal && config.stalwartHost ? config.stalwartHost : sessionHost || config.stalwartHost;
    const onThisServer = Boolean(internal || (config.stalwartHost && sessionHost === config.stalwartHost));
    return {
      ...base,
      imap: { host, port: 993, security: 'SSL/TLS', username: email, guessed: false },
      smtp: { host, port: 465, security: 'SSL/TLS', username: email, guessed: false, alt: { port: 587, security: 'STARTTLS' } },
      jmap: { sessionUrl: `https://${host}/.well-known/jmap`, username: email },
      password: 'mailbox',
      autoconfig: onThisServer && Boolean(config.stalwartDomain) && domain === config.stalwartDomain.toLowerCase(),
      notes: onThisServer
        ? ['Use the mailbox password shown under "Mailbox password" on this page; it was set when the address was created. You can also set a new one there. Tern updates itself, mail apps need the new password.', 'The user name is the full address.']
        : ['Sign in with the full address and the mailbox password (or an app password created in Stalwart).'],
    };
  }
  const guess = sessionHost || (domain ? `mail.${domain}` : '');
  return {
    ...base,
    imap: guess ? { host: guess, port: 993, security: 'SSL/TLS', username: a.auth_user || email, guessed: true } : null,
    smtp: guess ? { host: guess, port: 465, security: 'SSL/TLS', username: a.auth_user || email, guessed: true, alt: { port: 587, security: 'STARTTLS' } } : null,
    jmap: { sessionUrl: a.session_url, username: a.auth_user || email },
    password: a.auth_type === 'bearer' ? 'token' : 'mailbox',
    autoconfig: false,
    notes: ['The IMAP and SMTP hosts are a guess based on the JMAP server; confirm them with the provider. The JMAP session URL is exact.'],
  };
}

accountsRouter.get('/client-settings', async (req, res) => {
  const rows = await listAccounts(req.user!.id);
  res.json({ accounts: rows.map(clientSettingsFor) });
});

// Verify credentials without saving anything.
accountsRouter.post('/test', rateLimit({ name: 'account-test', perMinute: 12 }), async (req, res) => {
  const c = parse(credsSchema, req.body);
  const r = await resolveCreds(c);
  const client = new JmapClient({ sessionUrl: r.sessionUrl, authHeader: r.authType === 'bearer' ? bearerAuth(c.secret) : basicAuth(r.authUser ?? '', c.secret), pinOrigin: r.pinOrigin, allowPrivate: isInternalOrigin(r.sessionUrl), timeoutMs: 20_000 });
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
  const r = await resolveCreds(body);
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
  smtp: z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().max(320), pass: z.string().max(4000).optional() }).nullable().optional(),
  vacation: z.object({
    enabled: z.boolean(),
    subject: z.string().max(200).default(''),
    body: z.string().max(20000).default(''),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    onlyContacts: z.boolean().default(false),
    intervalDays: z.number().int().min(1).max(60).default(4),
  }).optional(),
  retentionEnabled: z.boolean().optional(),
  trashRetentionDays: z.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS).optional(),
  junkRetentionDays: z.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS).optional(),
  syncDrafts: z.boolean().optional(),
});

accountsRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  const b = parse(updateSchema, req.body);
  if (b.jitterMinS !== undefined && b.jitterMaxS !== undefined && b.jitterMinS > b.jitterMaxS) throw badRequest('Minimum delay must not exceed the maximum');
  if (b.vacation?.enabled && !b.vacation.body.trim()) throw badRequest('Write the auto-reply message before turning it on');
  if (b.vacation?.start && b.vacation.end && b.vacation.end < b.vacation.start) throw badRequest('The auto-reply must end after it starts');
  let smtp = acc.smtp;
  if (b.smtp === null) smtp = null;
  else if (b.smtp) {
    // The SMTP host is dialled with a stored credential; same rule as the session URL.
    if (b.smtp.host !== acc.smtp?.host) await assertPublicHost(b.smtp.host, { what: 'The SMTP host' });
    smtp = { host: b.smtp.host, port: b.smtp.port, secure: b.smtp.secure, user: b.smtp.user, pass_enc: b.smtp.pass ? encrypt(b.smtp.pass) : acc.smtp?.pass_enc ?? '' };
  }
  const credsChanged = b.secret !== undefined || b.sessionUrl !== undefined || b.authUser !== undefined || b.pinOrigin !== undefined;
  const sessionUrl = b.sessionUrl ? await validateSessionUrl(b.sessionUrl) : acc.session_url;
  await query(
    `UPDATE accounts SET name=COALESCE($2,name), color=COALESCE($3,color), signature_html=COALESCE($4,signature_html), daily_cap=COALESCE($5,daily_cap),
       jitter_enabled=COALESCE($6,jitter_enabled), jitter_min_s=COALESCE($7,jitter_min_s), jitter_max_s=COALESCE($8,jitter_max_s), send_window=COALESCE($9,send_window),
       sync_limit=COALESCE($10,sync_limit), enabled=COALESCE($11,enabled), auth_secret_enc=COALESCE($12,auth_secret_enc), auth_user=COALESCE($13,auth_user), session_url=$14,
       pin_origin=COALESCE($15,pin_origin), send_via=COALESCE($16,send_via), smtp=$17,
       api_url = CASE WHEN $18 THEN NULL ELSE api_url END, sync_status = CASE WHEN $18 THEN 'idle' ELSE sync_status END, sync_error = CASE WHEN $18 THEN NULL ELSE sync_error END,
       voice=COALESCE($19, voice), vacation=COALESCE($20, vacation),
       retention_enabled=COALESCE($21, retention_enabled), trash_retention_days=COALESCE($22, trash_retention_days),
       junk_retention_days=COALESCE($23, junk_retention_days), sync_drafts=COALESCE($24, sync_drafts)
     WHERE id=$1`,
    [id, b.name ?? null, b.color ?? null, b.signatureHtml ?? null, b.dailyCap ?? null, b.jitterEnabled ?? null, b.jitterMinS ?? null, b.jitterMaxS ?? null, b.sendWindow ? JSON.stringify(b.sendWindow) : null,
      b.syncLimit ?? null, b.enabled ?? null, b.secret ? encryptSecret(b.secret) : null, b.authUser ?? null, sessionUrl, b.pinOrigin ?? null, b.sendVia ?? null, smtp ? JSON.stringify(smtp) : null, credsChanged, b.voice ?? null, b.vacation ? JSON.stringify(b.vacation) : null,
      b.retentionEnabled ?? null, b.trashRetentionDays ?? null, b.junkRetentionDays ?? null, b.syncDrafts ?? null],
  );
  // Turning automatic emptying on or changing its window destroys mail on
  // the next run, so it is worth an audit entry of its own.
  if (b.retentionEnabled !== undefined || b.trashRetentionDays !== undefined || b.junkRetentionDays !== undefined) {
    await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'accounts.retention',$2,$3)`, [req.user!.id, acc.email, JSON.stringify({ enabled: b.retentionEnabled, trashDays: b.trashRetentionDays, junkDays: b.junkRetentionDays })]);
  }
  if (b.vacation) await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'accounts.vacation',$2,$3)`, [req.user!.id, acc.email, JSON.stringify({ enabled: b.vacation.enabled, start: b.vacation.start, end: b.vacation.end })]);
  if (credsChanged || b.enabled !== undefined) await syncManager.refresh(id);
  res.json({ account: publicAccount((await getUserAccount(req.user!.id, id))!) });
});

// What automatic emptying would remove on its next run, so the switch can
// say "12 messages" before anyone turns it on.
accountsRouter.get('/:id/retention-preview', async (req, res) => {
  const acc = await getUserAccount(req.user!.id, idParam(req.params.id));
  if (!acc) throw notFound('Account not found');
  res.json({ settings: retentionOf(acc), ...(await previewRetention(acc)) });
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

// ---------- Mailbox password self-service ----------
// Tern keeps the mailbox password (encrypted) to talk JMAP, so it can hand
// it back for a phone or desktop app. Both actions re-check the person's
// Tern password and are written to the audit log.

async function reauth(req: Request, password: string): Promise<void> {
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Your Tern password is incorrect');
}

accountsRouter.post('/:id/mailbox-password/reveal', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  const b = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  await reauth(req, b.password);
  if (acc.auth_type !== 'basic') throw badRequest('This account signs in with an API token, not a password');
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'accounts.mailbox_password_viewed',$2)`, [req.user!.id, acc.email]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ username: acc.auth_user ?? acc.email, password: decrypt(acc.auth_secret_enc) });
});

accountsRouter.post('/:id/mailbox-password/reset', async (req, res) => {
  const id = idParam(req.params.id);
  const acc = await getUserAccount(req.user!.id, id);
  if (!acc) throw notFound('Account not found');
  const b = parse(z.object({ password: z.string().min(1).max(200), newPassword: z.string().min(12).max(200).optional() }), req.body);
  await reauth(req, b.password);
  if (!isManagedAccount(acc)) throw badRequest('Only mailboxes on the bundled mail server can be reset here; change the password with your provider instead');
  const target = await stalwartAccountFor(acc);
  if (!target) throw notFound('Your mailbox was not found on the mail server');
  const password = b.newPassword ?? sw.generateMailboxPassword();
  await sw.setMailboxPassword(target.id, password);
  // Every Tern connection to this mailbox (yours, or a shared one) keeps working.
  const updated = await query<{ id: number }>(`UPDATE accounts SET auth_secret_enc=$2, api_url=NULL, sync_status='idle', sync_error=NULL WHERE provider='stalwart' AND lower(email)=lower($1) RETURNING id`, [acc.email, encryptSecret(password)]);
  for (const a of updated) await syncManager.refresh(a.id);
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'accounts.mailbox_password_reset',$2,$3)`, [req.user!.id, acc.email, JSON.stringify({ chosen: Boolean(b.newPassword), updatedAccounts: updated.length })]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, username: acc.email, password, updatedAccounts: updated.length });
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
