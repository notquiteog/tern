import pg from 'pg';
import { config } from './config.js';
import { logger } from './log.js';
import { migrations } from './migrations.js';

const log = logger('db');

// NUMERIC/BIGINT come back as strings by default; the schema uses plain
// integers everywhere money is not involved, and bigint ids fit in a JS
// number for any realistic mailbox, so parse them.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err) => log.error('idle client error', { err }));

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as any[]);
  return res.rows as T[];
}

export async function one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// Migrations are TypeScript modules rather than .sql files so the esbuild
// bundle is self-contained: the container image copies dist/ and nothing else.
export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // Serialize concurrent starts (two replicas, or the CLI racing the server).
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7245001)');
    const applied = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r: any) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      log.info(`applying migration ${m.id}`);
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    await client.query('SELECT pg_advisory_unlock(7245001)');
  } finally {
    client.release();
  }
}

export async function waitForDb(maxSeconds = 60): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (Date.now() - started > maxSeconds * 1000) throw e;
      log.warn('database not ready, retrying', { err: (e as Error).message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
