// Central configuration. Every knob is an environment variable with a safe
// default so the container runs with nothing but DATABASE_URL and two secrets,
// and install.sh only has to write the values that differ per deployment.
import os from 'node:os';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  env: env('NODE_ENV', 'development'),
  port: int('PORT', 3080),
  databaseUrl: env('DATABASE_URL', 'postgres://tern:tern@127.0.0.1:5480/tern'),
  // Signs session cookies and unsubscribe tokens. Rotating it logs everyone out.
  sessionSecret: env('SESSION_SECRET', 'dev-session-secret-change-me'),
  // 32-byte key (hex or base64) for AES-256-GCM on stored mailbox credentials.
  // Losing it means every connected account has to be re-entered; it is never
  // stored in the database for exactly that reason.
  encryptionKey: env('ENCRYPTION_KEY', 'dev-encryption-key-change-me-0000000000000'),
  // Public base URL, used in unsubscribe links and in emails to staff.
  appUrl: env('APP_URL', 'http://localhost:3080').replace(/\/+$/, ''),
  trustProxy: bool('TRUST_PROXY', true),
  secureCookies: bool('SECURE_COOKIES', env('APP_URL', 'http://localhost').startsWith('https://')),
  sessionDays: int('SESSION_DAYS', 30),
  // Sync
  syncPollSeconds: int('SYNC_POLL_SECONDS', 90),
  initialSyncLimit: int('INITIAL_SYNC_LIMIT', 3000),
  maxBodyBytes: int('MAX_BODY_BYTES', 1_000_000),
  // Permit plain-http JMAP session URLs. Needed for a Stalwart container on the
  // compose network; leave off when every mailbox is on the public internet.
  allowInsecureJmap: bool('ALLOW_INSECURE_JMAP', true),
  // AI
  ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  aiModel: env('AI_MODEL', ''),
  aiEnabled: bool('AI_ENABLED', true),
  // Bundled Stalwart (optional). When set, the "Stalwart (this server)" preset
  // in the add-account form fills the session URL in automatically.
  stalwartUrl: env('STALWART_URL', '').replace(/\/+$/, ''),
  stalwartHost: env('STALWART_HOST', ''),
  clientDist: env('CLIENT_DIST', ''),
  logLevel: env('LOG_LEVEL', 'info'),
  totalMemBytes: os.totalmem(),
  version: env('TERN_VERSION', '0.1.0'),
};

export type Config = typeof config;
