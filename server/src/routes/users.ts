import { Router } from 'express';
import { one, query } from '../db.js';
import { hashPassword } from '../crypto.js';
import { destroyUserSessions, publicUser, requireAdmin, type UserRow } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { randomToken } from '../crypto.js';
import { config } from '../config.js';

export interface AuthSettings { allowRegistration: boolean; defaultRole: 'admin' | 'member' }
export async function authSettings(): Promise<AuthSettings> {
  const row = await one<{ value: Partial<AuthSettings> }>(`SELECT value FROM settings WHERE key='auth'`);
  return { allowRegistration: false, defaultRole: 'member', ...(row?.value ?? {}) };
}

export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get('/auth-settings', async (_req, res) => {
  res.json({ settings: await authSettings() });
});
usersRouter.put('/auth-settings', async (req, res) => {
  const b = parse(z.object({ allowRegistration: z.boolean().optional(), defaultRole: z.enum(['admin', 'member']).optional() }), req.body);
  const next = { ...(await authSettings()), ...b };
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ('auth', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(next)]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'users.auth_settings',$2)`, [req.user!.id, JSON.stringify(next)]);
  res.json({ settings: next });
});

usersRouter.get('/invites', async (_req, res) => {
  const rows = await query<any>(`SELECT i.*, u.username AS used_by_username FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.id DESC LIMIT 100`);
  res.json({ invites: rows.map((i) => ({ ...i, url: `${config.appUrl}/register?invite=${i.token}` })) });
});
usersRouter.post('/invites', async (req, res) => {
  const b = parse(z.object({ role: z.enum(['admin', 'member']).default('member'), note: z.string().max(200).default(''), days: z.number().int().min(1).max(365).default(7) }), req.body);
  const rows = await query<any>(`INSERT INTO invites (token, role, note, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval) RETURNING *`, [randomToken(24), b.role, b.note, req.user!.id, String(b.days)]);
  res.json({ invite: { ...rows[0], url: `${config.appUrl}/register?invite=${rows[0].token}` } });
});
usersRouter.delete('/invites/:id', async (req, res) => {
  await query('DELETE FROM invites WHERE id=$1', [idParam(req.params.id)]);
  res.json({ ok: true });
});

usersRouter.get('/', async (_req, res) => {
  const rows = await query<UserRow & { account_count: number }>(
    `SELECT u.*, (SELECT count(*)::int FROM accounts a WHERE a.user_id=u.id) AS account_count FROM users u ORDER BY u.id`,
  );
  res.json({ users: rows.map((r) => ({ ...publicUser(r), account_count: r.account_count })) });
});

const createSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/, 'letters, numbers, dots, dashes'),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  role: z.enum(['admin', 'member']).default('member'),
});

usersRouter.post('/', async (req, res) => {
  const body = parse(createSchema, req.body);
  const exists = await one('SELECT 1 FROM users WHERE username=$1', [body.username.toLowerCase()]);
  if (exists) throw conflict('That username is taken');
  const rows = await query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`,
    [body.username.toLowerCase(), body.displayName, await hashPassword(body.password), body.role],
  );
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'users.created',$2)`, [req.user!.id, String(rows[0].id)]);
  res.json({ user: publicUser(rows[0]) });
});

usersRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const body = parse(z.object({ displayName: z.string().min(1).max(120).optional(), role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional() }), req.body);
  if (id === req.user!.id && (body.role === 'member' || body.disabled)) throw badRequest('You cannot demote or disable your own account');
  const rows = await query<UserRow>(
    `UPDATE users SET display_name=COALESCE($2, display_name), role=COALESCE($3, role), disabled=COALESCE($4, disabled) WHERE id=$1 RETURNING *`,
    [id, body.displayName ?? null, body.role ?? null, body.disabled ?? null],
  );
  if (!rows.length) throw notFound('User not found');
  if (body.disabled) await destroyUserSessions(id);
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'users.updated',$2,$3)`, [req.user!.id, String(id), JSON.stringify(body)]);
  res.json({ user: publicUser(rows[0]) });
});

usersRouter.post('/:id/password', async (req, res) => {
  const id = idParam(req.params.id);
  const { password } = parse(z.object({ password: z.string().min(10).max(200) }), req.body);
  const rows = await query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1 RETURNING id', [id, await hashPassword(password)]);
  if (!rows.length) throw notFound('User not found');
  await destroyUserSessions(id);
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'users.password_reset',$2)`, [req.user!.id, String(id)]);
  res.json({ ok: true });
});

usersRouter.delete('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  if (id === req.user!.id) throw badRequest('You cannot delete your own account');
  const rows = await query('DELETE FROM users WHERE id=$1 RETURNING id', [id]);
  if (!rows.length) throw notFound('User not found');
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'users.deleted',$2)`, [req.user!.id, String(id)]);
  res.json({ ok: true });
});
