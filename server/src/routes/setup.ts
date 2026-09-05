import { Router } from 'express';
import { one, query } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../crypto.js';
import { createSession, publicUser, setSessionCookie, type UserRow } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { conflict } from '../errors.js';
import { recommendModel } from '../ai/models.js';
import { authSettings } from './users.js';

export const setupRouter = Router();

async function needsSetup(): Promise<boolean> {
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return (r?.n ?? 0) === 0;
}

setupRouter.get('/status', async (_req, res) => {
  const auth = await authSettings();
  res.json({
    needsSetup: await needsSetup(),
    registrationOpen: auth.allowRegistration,
    version: config.version,
    appUrl: config.appUrl,
    aiEnabled: config.aiEnabled,
    stalwart: config.stalwartUrl ? { url: config.stalwartUrl, host: config.stalwartHost } : null,
    recommendedModel: recommendModel(config.totalMemBytes).model,
    totalMemGiB: Math.round((config.totalMemBytes / 1024 ** 3) * 10) / 10,
  });
});

const setupSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/, 'letters, numbers, dots, dashes'),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
});

// Creates the first admin. Refuses once any user exists, so it can be left
// mounted without becoming a way to add accounts.
setupRouter.post('/', async (req, res) => {
  if (!(await needsSetup())) throw conflict('Setup is already complete');
  const body = parse(setupSchema, req.body);
  const rows = await query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'admin') RETURNING *`,
    [body.username.toLowerCase(), body.displayName, await hashPassword(body.password)],
  );
  const sid = await createSession(rows[0].id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'setup.admin_created',$2)`, [rows[0].id, JSON.stringify({ username: body.username })]);
  res.json({ user: publicUser(rows[0]) });
});
