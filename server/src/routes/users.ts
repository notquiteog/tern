import { Router } from 'express';
import { one, query } from '../db.js';
import { hashPassword } from '../crypto.js';
import { destroyUserSessions, publicUser, requireAdmin, type UserRow } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, conflict, notFound } from '../errors.js';

export const usersRouter = Router();
usersRouter.use(requireAdmin);

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
