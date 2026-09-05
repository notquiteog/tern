import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { config } from '../config.js';
import { appSettings } from '../services/compose.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', async (_req, res) => {
  res.json({ app: await appSettings(), appUrl: config.appUrl, version: config.version, stalwart: config.stalwartUrl ? { host: config.stalwartHost, adminUrl: config.stalwartHost ? `https://${config.stalwartHost}/admin` : null } : null });
});

settingsRouter.put('/', requireAdmin, async (req, res) => {
  const b = parse(z.object({ unsubscribeText: z.string().max(500).optional(), physicalAddress: z.string().max(500).optional(), defaultTimezone: z.string().max(64).optional() }), req.body);
  const current = await appSettings();
  const next = { ...current, ...b };
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ('app', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(next)]);
  res.json({ app: next });
});

settingsRouter.get('/audit', requireAdmin, async (_req, res) => {
  const rows = await query<any>('SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200');
  res.json({ entries: rows });
});

settingsRouter.get('/stats', async (req, res) => {
  const uid = req.user!.id;
  const accounts = await query<any>(`SELECT id, name, email, color, daily_cap, send_window, sync_status, last_sync_at FROM accounts WHERE user_id=$1 ORDER BY id`, [uid]);
  const perAccount = [];
  for (const a of accounts) {
    const tz = String(a.send_window?.tz ?? 'UTC').replace(/[^A-Za-z0-9_+\-/]/g, '');
    const today = await one<{ n: number }>(`SELECT count(*)::int AS n FROM send_log WHERE account_id=$1 AND status='sent' AND sent_at >= (date_trunc('day', now() AT TIME ZONE '${tz}') AT TIME ZONE '${tz}')`, [a.id]);
    perAccount.push({ ...a, sentToday: today?.n ?? 0 });
  }
  const week = await one<any>(`SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied, count(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced, count(*) FILTER (WHERE status='failed')::int AS failed FROM send_log WHERE user_id=$1 AND sent_at > now() - interval '7 days'`, [uid]);
  const daily = await query<any>(`SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(s.sent,0) AS sent, coalesce(s.replied,0) AS replied FROM generate_series(now()::date - 13, now()::date, '1 day') d LEFT JOIN (SELECT sent_at::date AS day, count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied FROM send_log WHERE user_id=$1 AND sent_at > now() - interval '14 days' GROUP BY 1) s ON s.day = d::date ORDER BY d`, [uid]);
  const enrollments = await one<any>(`SELECT count(*) FILTER (WHERE e.status='active')::int AS active, count(*) FILTER (WHERE e.status='waiting_review')::int AS waiting_review, count(*) FILTER (WHERE e.status='replied')::int AS replied FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE s.user_id=$1`, [uid]);
  const review = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [uid]);
  const recent = await query<any>(`SELECT l.id, l.kind, l.subject, l.to_email, l.sent_at, l.status, l.error, l.replied_at, l.bounced_at, a.email AS account_email, a.color FROM send_log l JOIN accounts a ON a.id=l.account_id WHERE l.user_id=$1 ORDER BY l.sent_at DESC LIMIT 15`, [uid]);
  res.json({ accounts: perAccount, week, daily, enrollments, reviewPending: review?.n ?? 0, recent });
});
