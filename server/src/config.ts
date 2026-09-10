// Central configuration. Every knob is an environment variable with a safe
// default so the container runs with nothing but DATABASE_URL and two secrets,
// and install.sh only has to write the values that differ per deployment.
import os from 'node:os';

// What the environment actually says, or undefined. A value still wearing its
// compose placeholder — `${OLLAMA_NUM_PARALLEL:-2}`, which podman-compose
// leaves alone when the variable is not in .env — is not a value: it is a
// variable that was never set, and treating it as one crashed the container
// on boot rather than falling back to the default beside it.
function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === '' || /^\$[{(]/.test(t)) return undefined;
  return t;
}

function env(name: string, fallback?: string): string {
  const v = raw(name);
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = raw(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = raw(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// A memory limit as compose spells it: "2560m", "4g", "1024k", or plain bytes.
function bytes(name: string, fallback: number): number {
  const v = (raw(name) ?? '').toLowerCase();
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
  // Where a local Tor proxy listens, for installs that turn on Tor routing in
  // Admin → AI model. 9150 is Arti's default; the C tor daemon uses 9050. See
  // util/tor.ts for why the other port is never tried as a fallback.
  torSocksHost: env('TOR_SOCKS_HOST', '127.0.0.1'),
  torSocksPort: int('TOR_SOCKS_PORT', 9150),
  aiModel: env('AI_MODEL', ''),
  // The small model that turns a message into a vector for meaning search.
  // A separate setting because it is a different, much smaller model from
  // the one that writes, and an install may want one without the other.
  // The floor meaning search is built and tested against — see
  // ai/models.ts FLOOR_EMBED and docs/SETUP.md.
  //
  // This was `all-minilm`: 384 wide, a 512-token window, and chosen when the
  // target included a 4.5 GB VPS. It retrieves worst on exactly the case the
  // feature exists for, wording that shares no words with what is being
  // searched. Costs no more disk than the small one either — every vector is
  // stored at the same width whatever produced it.
  //
  // Moving this is only safe because `reconcileEmbedModel` notices a changed
  // embedder however it changed. Without it, an install that had never saved
  // AI settings would switch model on restart, re-index nothing, and have
  // meaning search return nothing for ever after: rows made by the old model
  // are excluded by name, and nothing would have queued the rebuild.
  aiEmbedModel: env('AI_EMBED_MODEL', 'qwen3-embedding:4b'),
  aiEnabled: bool('AI_ENABLED', true),
  // ---------- The vector index ----------
  //
  // Qdrant, and not optional: compose starts it on every deployment, dev and
  // production alike. Vectors used to live in Postgres and were scanned in
  // full on every search — measured at 94 ms over 50,000 messages and 383 ms
  // over 200,000, of which 82% was shipping rows into Node rather than the
  // arithmetic. An index does not make the maths faster; it stops the rows
  // being sent at all.
  //
  // The default address is the compose service name, so an ordinary install
  // needs none of these set. They exist for the operator whose index is
  // somewhere else.
  qdrantUrl: env('QDRANT_URL', 'http://qdrant:6333').replace(/\/+$/, ''),
  // Empty is allowed and means an index with no authentication, which is
  // correct on the compose network and wrong anywhere else. install.sh always
  // generates one; the container refuses to start without it.
  qdrantApiKey: env('QDRANT_API_KEY', ''),
  qdrantTlsInsecure: bool('QDRANT_TLS_INSECURE', false),
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
  // Optional transcription container for dictation (F9). Empty means the
  // feature is unavailable and says so rather than failing at the microphone.
  // Anything speaking the OpenAI /v1/audio/transcriptions shape works;
  // compose.voice.yml runs whisper.cpp behind its own small server.
  whisperUrl: env('WHISPER_URL', '').replace(/\/+$/, ''),
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
  // Public IPv6, if the box has one. Optional: when it is empty the DNS check
  // falls back to whatever AAAA the mail host publishes.
  serverIpv6: env('SERVER_IPV6', ''),
  webHost: env('WEB_HOST', ''),
  clientDist: env('CLIENT_DIST', ''),
  logLevel: env('LOG_LEVEL', 'info'),
  totalMemBytes: os.totalmem(),
  version: env('TERN_VERSION', '0.1.0'),
};

export type Config = typeof config;
