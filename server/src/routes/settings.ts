import { Router, raw } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { config } from '../config.js';
import { appSettings } from '../services/compose.js';
import { clearLogo, getBranding, getIcon, getLogo, ICON_NAMES, LOGO_MAX_BYTES, LOGO_TYPES, manifest, publicBranding, setAppName, setIcons, setLogo } from '../services/branding.js';
import { badRequest, notFound } from '../errors.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', async (req, res) => {
  const admin = req.user!.role === 'admin';
  res.json({ app: await appSettings(), appUrl: config.appUrl, version: config.version, stalwart: admin && config.stalwartUrl ? { host: config.stalwartHost, adminUrl: config.stalwartHost ? `https://${config.stalwartHost}/admin` : null } : null });
});

settingsRouter.put('/', requireAdmin, async (req, res) => {
  const b = parse(z.object({ unsubscribeText: z.string().max(500).optional(), physicalAddress: z.string().max(500).optional(), defaultTimezone: z.string().max(64).optional() }), req.body);
  const current = await appSettings();
  const next = { ...current, ...b };
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ('app', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(next)]);
  res.json({ app: next });
});

// ---- Name and logo of the web app itself (admins) ----
function brandingView(b: Awaited<ReturnType<typeof getBranding>>) {
  return { ...publicBranding(b), logoType: b.logo?.type ?? null, logoBytes: b.logo?.bytes ?? null, maxBytes: LOGO_MAX_BYTES, iconBg: b.iconBg, hasIcons: Boolean(b.icons) };
}
settingsRouter.get('/branding', requireAdmin, async (_req, res) => {
  res.json({ branding: brandingView(await getBranding()) });
});
settingsRouter.put('/branding', requireAdmin, async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1, 'Give the app a name').max(40) }), req.body);
  const next = await setAppName(b.name);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'branding.name',$2)`, [req.user!.id, JSON.stringify({ name: next.name })]);
  res.json({ branding: brandingView(next) });
});
const logoBody = raw({ type: [...LOGO_TYPES], limit: LOGO_MAX_BYTES });
settingsRouter.post('/branding/logo', requireAdmin, logoBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as the request body with its content type (SVG, PNG, JPEG or WebP)');
  let result;
  try { result = await setLogo(req.body, String(req.headers['content-type'] ?? '')); } catch (e) { throw badRequest((e as Error).message); }
  const { branding, prepared } = result;
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'branding.logo',$2)`, [req.user!.id, JSON.stringify({ type: prepared.type, bytes: prepared.bytes, originalBytes: prepared.originalBytes })]);
  res.json({ branding: brandingView(branding), bytes: prepared.bytes, originalBytes: prepared.originalBytes, note: prepared.note });
});
// Home-screen icons, rendered by the browser from the logo: {iconBg, icons: {name: dataUrl}}.
settingsRouter.post('/branding/icons', requireAdmin, async (req, res) => {
  const b = parse(z.object({ iconBg: z.string().regex(/^#[0-9a-fA-F]{6}$/), icons: z.record(z.string(), z.string().max(800_000)) }), req.body);
  const icons: Record<string, Buffer> = {};
  for (const name of ICON_NAMES) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(b.icons[name] ?? '');
    if (!m) throw badRequest(`Missing or invalid icon ${name}`);
    icons[name] = Buffer.from(m[1], 'base64');
  }
  let next;
  try { next = await setIcons(b.iconBg, icons); } catch (e) { throw badRequest((e as Error).message); }
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'branding.icons',$2)`, [req.user!.id, JSON.stringify({ iconBg: b.iconBg })]);
  res.json({ branding: brandingView(next) });
});
settingsRouter.delete('/branding/logo', requireAdmin, async (req, res) => {
  const next = await clearLogo();
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'branding.logo_removed')`, [req.user!.id]);
  res.json({ branding: brandingView(next) });
});

// Public: the web app manifest and the home-screen icons. Custom icons come
// from the database; otherwise the request falls through to the static
// defaults shipped with the client.
export const manifestRouter = Router();
manifestRouter.get('/', async (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(JSON.stringify(manifest(await getBranding(), config.version)));
});
export const iconsRouter = Router();
iconsRouter.get('/:name', async (req, res, next) => {
  const name = String(req.params.name);
  if (!(ICON_NAMES as readonly string[]).includes(name)) { next(); return; }
  const icon = await getIcon(name);
  if (!icon) { next(); return; }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(icon);
});

// Public: the logo file, referenced from the setup/status payload as /logo?v=N.
export const logoRouter = Router();
logoRouter.get('/', async (_req, res) => {
  const logo = await getLogo();
  if (!logo) throw notFound('No logo set');
  res.setHeader('Content-Type', logo.type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (logo.type === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.send(logo.data);
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
