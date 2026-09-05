import { Router } from 'express';
import { one, query } from '../db.js';
import { config } from '../config.js';
import { dummyHash, generateRecoveryCodes, generateTotpSecret, hashPassword, otpauthUrl, sha256hex, verifyPassword, verifyTotp } from '../crypto.js';
import { checkLoginAllowed, clearLoginFailures, clientIp, createSession, destroySession, destroyUserSessions, publicUser, recordLoginFailure, requireAuth, setSessionCookie, type UserRow } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { authSettings } from './users.js';

export const authRouter = Router();

const registerSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/, 'letters, numbers, dots, dashes'),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  invite: z.string().max(200).optional(),
});

// Self-registration is off unless an admin opens it or hands out an invite
// link. Either way the new account gets the role the admin decided on.
authRouter.post('/register', async (req, res) => {
  const body = parse(registerSchema, req.body);
  const settings = await authSettings();
  let role: 'admin' | 'member' = settings.defaultRole;
  let invite: any = null;
  if (body.invite) {
    invite = await one<any>('SELECT * FROM invites WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [body.invite]);
    if (!invite) throw badRequest('This invite link is invalid or has expired');
    role = invite.role;
  } else if (!settings.allowRegistration) {
    throw forbidden('Registration is by invitation only');
  }
  const username = body.username.toLowerCase();
  if (await one('SELECT 1 FROM users WHERE username=$1', [username])) throw badRequest('That username is taken');
  const rows = await query<UserRow>(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`, [username, body.displayName, await hashPassword(body.password), role]);
  if (invite) await query('UPDATE invites SET used_by=$2, used_at=now() WHERE id=$1', [invite.id, rows[0].id]);
  const sid = await createSession(rows[0].id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'auth.registered',$2)`, [rows[0].id, JSON.stringify({ via: invite ? 'invite' : 'open', role })]);
  res.json({ user: publicUser(rows[0]) });
});

authRouter.get('/invite/:token', async (req, res) => {
  const inv = await one<any>('SELECT role, note, expires_at FROM invites WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [String(req.params.token)]);
  if (!inv) throw notFound('This invite link is invalid or has expired');
  res.json({ valid: true, role: inv.role, note: inv.note, expiresAt: inv.expires_at });
});

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200), code: z.string().max(32).optional() });

// One response for "no such user", "wrong password" and "disabled", and
// bcrypt-equivalent work in every branch, so the login form cannot be used
// to enumerate usernames.
authRouter.post('/login', async (req, res) => {
  const body = parse(loginSchema, req.body);
  const username = body.username.toLowerCase().trim();
  const key = `${username}|${clientIp(req)}`;
  checkLoginAllowed(key);
  const user = await one<UserRow>('SELECT * FROM users WHERE username=$1', [username]);
  const ok = user ? await verifyPassword(body.password, user.password_hash) : (await verifyPassword(body.password, await dummyHash()), false);
  if (!ok || !user || user.disabled) {
    recordLoginFailure(key);
    throw unauthorized('Incorrect username or password');
  }
  if (user.totp_enabled && user.totp_secret) {
    if (!body.code) { res.json({ mfaRequired: true }); return; }
    const code = body.code.trim();
    let passed = verifyTotp(user.totp_secret, code);
    if (!passed) {
      const hashed = sha256hex(code.toLowerCase());
      if (user.recovery_codes.includes(hashed)) {
        passed = true;
        await query('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id=$1', [user.id, hashed]);
      }
    }
    if (!passed) { recordLoginFailure(key); throw unauthorized('That code was not accepted'); }
  }
  clearLoginFailures(key);
  const sid = await createSession(user.id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', async (req, res) => {
  if (req.sessionId) await destroySession(req.sessionId);
  setSessionCookie(res, null);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const accounts = await query<{ n: number }>('SELECT count(*)::int AS n FROM accounts WHERE user_id=$1', [req.user!.id]);
  const { stalwartEnabled } = await import('../services/stalwart.js');
  res.json({ user: publicUser(req.user!), accountCount: accounts[0]?.n ?? 0, version: config.version, stalwartProvisioning: stalwartEnabled() && req.user!.role === 'admin' });
});

authRouter.put('/prefs', requireAuth, async (req, res) => {
  const prefs = parse(z.record(z.string(), z.unknown()), req.body);
  const rows = await query<UserRow>(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1 RETURNING *`, [req.user!.id, JSON.stringify(prefs)]);
  res.json({ user: publicUser(rows[0]) });
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const body = parse(z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }), req.body);
  if (!(await verifyPassword(body.current, req.user!.password_hash))) throw badRequest('Current password is incorrect');
  await query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [req.user!.id, await hashPassword(body.next)]);
  await destroyUserSessions(req.user!.id, req.sessionId);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.password_changed')`, [req.user!.id]);
  res.json({ ok: true });
});

// TOTP: setup stores a pending secret; enable verifies one code and turns it
// on with fresh recovery codes shown exactly once.
authRouter.post('/totp/setup', requireAuth, async (req, res) => {
  const secret = generateTotpSecret();
  await query('UPDATE users SET totp_secret=$2, totp_enabled=false WHERE id=$1', [req.user!.id, secret]);
  res.json({ secret, otpauth: otpauthUrl('Tern', req.user!.username, secret) });
});

authRouter.post('/totp/enable', requireAuth, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
  const user = await one<UserRow>('SELECT * FROM users WHERE id=$1', [req.user!.id]);
  if (!user?.totp_secret) throw badRequest('Run setup first');
  if (!verifyTotp(user.totp_secret, code)) throw badRequest('That code was not accepted. Check the time on your device.');
  const codes = generateRecoveryCodes();
  await query('UPDATE users SET totp_enabled=true, recovery_codes=$2 WHERE id=$1', [user.id, codes.map((c) => sha256hex(c.toLowerCase()))]);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.totp_enabled')`, [user.id]);
  res.json({ ok: true, recoveryCodes: codes });
});

authRouter.post('/totp/disable', requireAuth, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  await query(`UPDATE users SET totp_enabled=false, totp_secret=NULL, recovery_codes='{}' WHERE id=$1`, [req.user!.id]);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.totp_disabled')`, [req.user!.id]);
  res.json({ ok: true });
});

authRouter.post('/totp/recovery', requireAuth, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  const codes = generateRecoveryCodes();
  await query('UPDATE users SET recovery_codes=$2 WHERE id=$1 AND totp_enabled', [req.user!.id, codes.map((c) => sha256hex(c.toLowerCase()))]);
  res.json({ recoveryCodes: codes });
});

authRouter.get('/sessions', requireAuth, async (req, res) => {
  const rows = await query('SELECT id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id=$1 AND expires_at > now() ORDER BY last_seen_at DESC', [req.user!.id]);
  res.json({ sessions: rows.map((r) => ({ ...r, current: r.id === req.sessionId, id: r.id.slice(0, 8) + '…', fullId: r.id === req.sessionId ? null : r.id })) });
});

authRouter.post('/sessions/revoke', requireAuth, async (req, res) => {
  const { id, all } = parse(z.object({ id: z.string().optional(), all: z.boolean().optional() }), req.body);
  if (all) await destroyUserSessions(req.user!.id, req.sessionId);
  else if (id) await query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  res.json({ ok: true });
});
