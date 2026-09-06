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

// A memory limit as compose spells it: "2560m", "4g", "1024k", or plain bytes.
function bytes(name: string, fallback: number): number {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|ki|kib|m|mb|mi|mib|g|gb|gi|gib)?$/.exec(v);
  if (!m) return fallback;
  const mult: Record<string, number> = { b: 1, k: 1024, kb: 1024, ki: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mi: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gi: 1024 ** 3, gib: 1024 ** 3 };
  return Math.round(Number(m[1]) * (mult[m[2] ?? 'b'] ?? 1));
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
  // Let people connect mail servers on private or loopback addresses (a
  // JMAP server on the LAN). Off by default: otherwise any member could make
  // this server talk to the compose network (Ollama, Postgres, Stalwart's
  // management API). The bundled Stalwart is always allowed.
  allowPrivateHosts: bool('ALLOW_PRIVATE_NETWORK_HOSTS', false),
  // AI
  ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  aiModel: env('AI_MODEL', ''),
  aiEnabled: bool('AI_ENABLED', true),
  // What Ollama itself was started with. The app cannot change these — they
  // are read when the container starts — but it has to know them: the number
  // of requests it may have in flight at once is Ollama's slot count, and
  // what a slot costs in memory depends on how the KV cache is stored.
  // compose.yml passes the same values to both containers.
  ollamaNumParallel: int('OLLAMA_NUM_PARALLEL', 2),
  ollamaKvCacheType: env('OLLAMA_KV_CACHE_TYPE', 'f16'),
  // Ollama's container memory limit, written by install.sh ("2300m"). Used to
  // say how many parallel slots the box can actually pay for; 0 means unset,
  // and then no such claim is made.
  ollamaMemLimitBytes: bytes('OLLAMA_MEM_LIMIT', 0),
  // Bundled Stalwart (optional). When set, the "Stalwart (this server)" preset
  // in the add-account form fills the session URL in automatically.
  stalwartUrl: env('STALWART_URL', '').replace(/\/+$/, ''),
  stalwartHost: env('STALWART_HOST', ''),
  stalwartDomain: env('STALWART_DOMAIN', ''),
  // Admin credentials written by install.sh; presence turns on mailbox provisioning.
  stalwartAdminUser: env('STALWART_ADMIN_USER', ''),
  stalwartAdminPassword: env('STALWART_ADMIN_PASSWORD', ''),
  // Public IPv4 of this box, written by install.sh; used for DNS verification.
  serverIp: env('SERVER_IP', ''),
  webHost: env('WEB_HOST', ''),
  clientDist: env('CLIENT_DIST', ''),
  logLevel: env('LOG_LEVEL', 'info'),
  totalMemBytes: os.totalmem(),
  version: env('TERN_VERSION', '0.1.0'),
};

export type Config = typeof config;
