// Profile pictures for users and photos for contacts. Stored in Postgres,
// served with private caching; the client downsizes to 256px before upload
// so nothing here needs an image library.
import { Router, raw } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';

export const avatarsRouter = Router();
avatarsRouter.use(requireAuth);

const imageBody = raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: '1mb' });
const OK_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function send(res: any, row: { avatar: Buffer | null; avatar_type: string | null } | null) {
  if (!row?.avatar) throw notFound('No picture');
  res.setHeader('Content-Type', row.avatar_type ?? 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(row.avatar);
}

avatarsRouter.get('/user/:id', async (req, res) => {
  send(res, await one<any>('SELECT avatar, avatar_type FROM users WHERE id=$1', [idParam(req.params.id)]));
});

avatarsRouter.get('/contact/:id', async (req, res) => {
  send(res, await one<any>('SELECT avatar, avatar_type FROM contacts WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]));
});

avatarsRouter.post('/me', imageBody, async (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0];
  if (!OK_TYPES.has(type) || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Send a PNG, JPEG, WebP or GIF image');
  await query('UPDATE users SET avatar=$2, avatar_type=$3, avatar_updated_at=now() WHERE id=$1', [req.user!.id, req.body, type]);
  const u = await one<{ avatar_updated_at: Date }>('SELECT avatar_updated_at FROM users WHERE id=$1', [req.user!.id]);
  res.json({ ok: true, avatar_version: u ? new Date(u.avatar_updated_at).getTime() : null });
});

avatarsRouter.delete('/me', async (req, res) => {
  await query('UPDATE users SET avatar=NULL, avatar_type=NULL, avatar_updated_at=NULL WHERE id=$1', [req.user!.id]);
  res.json({ ok: true });
});

avatarsRouter.post('/contact/:id', imageBody, async (req, res) => {
  const id = idParam(req.params.id);
  const type = String(req.headers['content-type'] ?? '').split(';')[0];
  if (!OK_TYPES.has(type) || !Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Send a PNG, JPEG, WebP or GIF image');
  const r = await query<{ avatar_updated_at: Date }>('UPDATE contacts SET avatar=$3, avatar_type=$4, avatar_updated_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING avatar_updated_at', [id, req.user!.id, req.body, type]);
  if (!r.length) throw notFound('Contact not found');
  res.json({ ok: true, avatar_version: new Date(r[0].avatar_updated_at).getTime() });
});

avatarsRouter.delete('/contact/:id', async (req, res) => {
  await query('UPDATE contacts SET avatar=NULL, avatar_type=NULL, avatar_updated_at=NULL WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});
