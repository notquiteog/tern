import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './log.js';
import { HttpError } from './errors.js';
import { attachUser, csrfGuard } from './auth.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { accountsRouter } from './routes/accounts.js';
import { mailRouter } from './routes/mail.js';
import { contactsRouter } from './routes/contacts.js';
import { templatesRouter } from './routes/templates.js';
import { sequencesRouter } from './routes/sequences.js';
import { reviewRouter } from './routes/review.js';
import { rulesRouter } from './routes/rules.js';
import { aiRouter } from './routes/ai.js';
import { settingsRouter, logoRouter, manifestRouter, iconsRouter } from './routes/settings.js';
import { pushRouter } from './routes/push.js';
import { burnerRouter } from './routes/burner.js';
import { eventsRouter } from './routes/events.js';
import { publicRouter } from './routes/public.js';
import { respondersRouter } from './routes/responders.js';
import { stalwartRouter } from './routes/stalwart.js';
import { avatarsRouter } from './routes/avatars.js';
import { brandRouter, bimiRouter } from './routes/brand.js';
import { pgpRouter } from './routes/pgp.js';

const log = logger('http');

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use('/u', express.urlencoded({ extended: false }), publicRouter);
  app.use('/bimi', bimiRouter);
  app.use('/logo', logoRouter);
  app.use('/manifest.webmanifest', manifestRouter);
  app.use('/icons', iconsRouter);
  app.get('/healthz', (_req, res) => { res.json({ ok: true, version: config.version }); });
  // Caddy asks here before issuing an on-demand certificate, so only names
  // that belong to this install get certificates.
  app.get('/api/caddy/ask', (req, res) => {
    const d = String(req.query.domain ?? '').toLowerCase();
    const allowed = new Set<string>();
    if (config.webHost) allowed.add(config.webHost.toLowerCase());
    if (config.stalwartHost) allowed.add(config.stalwartHost.toLowerCase());
    if (config.stalwartDomain) for (const p of ['mta-sts', 'autoconfig', 'autodiscover', 'ua-auto-config']) allowed.add(`${p}.${config.stalwartDomain.toLowerCase()}`);
    res.status(allowed.has(d) ? 200 : 404).end();
  });

  app.use('/api', express.json({ limit: '40mb' }), attachUser, csrfGuard);
  app.use('/api/setup', setupRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/mail', mailRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/templates', templatesRouter);
  app.use('/api/sequences', sequencesRouter);
  app.use('/api/review', reviewRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/responders', respondersRouter);
  app.use('/api/stalwart', stalwartRouter);
  app.use('/api/avatars', avatarsRouter);
  app.use('/api/brand', brandRouter);
  app.use('/api/pgp', pgpRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/burner', burnerRouter);
  app.use('/api/events', eventsRouter);
  app.all('/api/{*rest}', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

  // Static client with SPA fallback. In the container the bundle lives next
  // to the server; in development Vite serves it and this is never hit.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = config.clientDist || path.resolve(here, '../../client/dist');
  if (fs.existsSync(dist)) {
    // Only Vite's hashed bundles are immutable; index.html, theme-init.js,
    // fonts and icons keep short-lived caching so an update is picked up on
    // the next load rather than in a year.
    app.use(express.static(dist, { index: false, setHeaders: (res, p) => { res.setHeader('Cache-Control', p.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : p.endsWith('.woff2') ? 'public, max-age=604800' : 'no-cache'); } }));
    app.get('{*rest}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'");
      res.sendFile(path.join(dist, 'index.html'));
    });
  } else {
    log.warn(`client bundle not found at ${dist}; only the API is served`);
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    const anyErr = err as any;
    if (anyErr?.type === 'entity.too.large') { res.status(413).json({ error: 'That upload is too large' }); return; }
    if (anyErr?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Malformed JSON' }); return; }
    log.error(`unhandled error on ${req.method} ${req.path}`, { err: anyErr?.message ?? String(err), stack: anyErr?.stack });
    res.status(500).json({ error: anyErr?.message ?? 'Something went wrong' });
  });
  return app;
}
