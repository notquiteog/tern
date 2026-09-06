import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { notifyUser, subscribe, subscriptionCount, unsubscribe, vapidKeys } from '../services/push.js';

export const pushRouter = Router();
pushRouter.use(requireAuth);

pushRouter.get('/vapid', async (_req, res) => {
  res.json({ publicKey: (await vapidKeys()).publicKey });
});

pushRouter.get('/status', async (req, res) => {
  res.json({ subscriptions: await subscriptionCount(req.user!.id) });
});

const subSchema = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(200) }) });

pushRouter.post('/subscribe', async (req, res) => {
  const b = parse(subSchema, req.body);
  await subscribe(req.user!.id, b, String(req.headers['user-agent'] ?? '').slice(0, 300) || null);
  res.json({ ok: true, subscriptions: await subscriptionCount(req.user!.id) });
});

pushRouter.post('/unsubscribe', async (req, res) => {
  const b = parse(z.object({ endpoint: z.string().url().max(2000) }), req.body);
  await unsubscribe(req.user!.id, b.endpoint);
  res.json({ ok: true, subscriptions: await subscriptionCount(req.user!.id) });
});

// A notification to this user's devices, so people can see it works.
pushRouter.post('/test', async (req, res) => {
  const sent = await notifyUser(req.user!.id, { title: 'Notifications are on', body: 'New mail will show up here.', url: '/mail/inbox', tag: 'test' });
  res.json({ ok: true, sent });
});
