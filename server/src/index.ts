import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './log.js';
import { migrate, pool, waitForDb } from './db.js';
import { syncManager } from './workers/syncManager.js';
import { startScheduler, stopScheduler } from './workers/scheduler.js';
import { recommendModel } from './ai/models.js';

const log = logger('main');

async function main(): Promise<void> {
  if (config.env === 'production' && (config.sessionSecret.startsWith('dev-') || config.encryptionKey.startsWith('dev-'))) {
    throw new Error('SESSION_SECRET and ENCRYPTION_KEY must be set in production');
  }
  await waitForDb();
  await migrate();
  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`Tern ${config.version} listening on :${config.port}`, { appUrl: config.appUrl, memGiB: Math.round((config.totalMemBytes / 1024 ** 3) * 10) / 10, recommendedModel: recommendModel(config.totalMemBytes).model });
  });
  server.keepAliveTimeout = 65_000;
  await syncManager.start();
  startScheduler();

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    stopScheduler();
    syncManager.stop();
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('fatal', { err: e?.message ?? String(e), stack: e?.stack });
  process.exit(1);
});
