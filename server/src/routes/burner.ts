import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { burnerAccount, getBurner, removeBurner, rotateBurner } from '../services/burner.js';
import { stalwartEnabled } from '../services/stalwart.js';

export const burnerRouter = Router();
burnerRouter.use(requireAuth);

const view = (b: any) => (b ? { address: b.address, createdAt: b.created_at } : null);

burnerRouter.get('/', async (req, res) => {
  const acc = await burnerAccount(req.user!.id);
  const reason = !stalwartEnabled() ? 'This install has no bundled mail server.' : !acc ? 'Connect your mailbox on the bundled mail server first (Settings → Accounts).' : null;
  res.json({ available: !reason, reason, domain: config.stalwartDomain || null, burner: view(await getBurner(req.user!.id)), mailbox: acc?.email ?? null });
});

burnerRouter.post('/rotate', async (req, res) => {
  const b = await rotateBurner(req.user!.id);
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'burner.rotated',$2)`, [req.user!.id, b.address]);
  res.json({ burner: view(b) });
});

burnerRouter.delete('/', async (req, res) => {
  await removeBurner(req.user!.id);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'burner.removed')`, [req.user!.id]);
  res.json({ ok: true });
});
