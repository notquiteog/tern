import { Router } from 'express';
import { one, query, withTx } from '../db.js';
import { assertPasswordOk } from '../util/password.js';
import { config } from '../config.js';
import { hashPassword } from '../crypto.js';
import { createSession, publicUser, setSessionCookie, type UserRow } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { conflict } from '../errors.js';
import { recommendModel } from '../ai/models.js';
import { authSettings } from './users.js';
import { stalwartEnabled } from '../services/stalwart.js';
import { verifySolution } from '../pow.js';
import { getBranding, publicBranding } from '../services/branding.js';
import { localPartFor, mailboxExists, provisionMailbox, provisioningEnabled } from '../services/provision.js';

export const setupRouter = Router();

async function needsSetup(): Promise<boolean> {
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return (r?.n ?? 0) === 0;
}

// Public, unauthenticated. Until the first admin exists it describes the
// install for the setup screen; afterwards it says only what the sign-in
// page needs, so an anonymous visitor learns nothing about the box.
setupRouter.get('/status', async (_req, res) => {
  const auth = await authSettings();
  const fresh = await needsSetup();
  const branding = publicBranding(await getBranding());
  res.setHeader('Cache-Control', 'no-store');
  if (!fresh) { res.json({ needsSetup: false, registrationOpen: auth.allowRegistration, version: config.version, branding }); return; }
  res.json({
    needsSetup: true,
    branding,
    registrationOpen: auth.allowRegistration,
    version: config.version,
    appUrl: config.appUrl,
    aiEnabled: config.aiEnabled,
    stalwart: config.stalwartUrl ? { host: config.stalwartHost, domain: config.stalwartDomain, provisioning: stalwartEnabled() } : null,
    recommendedModel: recommendModel(config.totalMemBytes).model,
    totalMemGiB: Math.round((config.totalMemBytes / 1024 ** 3) * 10) / 10,
  });
});

const setupSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/, 'letters, numbers, dots, dashes'),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  pow: z.object({ challenge: z.string().max(600), nonce: z.string().max(64) }).optional(),
});

// Creates the first admin. Refuses once any user exists, so it can be left
// mounted without becoming a way to add accounts.
setupRouter.post('/', async (req, res) => {
  if (!(await needsSetup())) throw conflict('Setup is already complete');
  const body = parse(setupSchema, req.body);
  verifySolution('setup', body.username, body.pow);
  assertPasswordOk(body.password, body.username);
  const hash = await hashPassword(body.password);
  // Two first-run submissions racing each other must not both make an admin:
  // the count is re-checked under a lock in the same transaction as the insert.
  const rows = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7245002)');
    const n = await c.query('SELECT count(*)::int AS n FROM users');
    if (n.rows[0].n > 0) throw conflict('Setup is already complete');
    const r = await c.query(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'admin') RETURNING *`, [body.username.toLowerCase(), body.displayName, hash]);
    return r.rows as UserRow[];
  });
  const sid = await createSession(rows[0].id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'setup.admin_created',$2)`, [rows[0].id, JSON.stringify({ username: body.username })]);
  // The first admin gets a mailbox as well, unless the installer already
  // made one under that name; setup must never be blocked by the mail server.
  let mailbox = null;
  try {
    const local = localPartFor(body.username);
    if (local && (await provisioningEnabled()) && !(await mailboxExists(local))) mailbox = await provisionMailbox(rows[0]);
  } catch { /* reported in the log by provisionMailbox */ }
  res.json({ user: publicUser(rows[0]), mailbox });
});
