// All cryptography comes from Node's crypto module: scrypt for passwords,
// AES-256-GCM for stored mailbox credentials, HMAC-SHA1 for TOTP and
// HMAC-SHA256 for signed unsubscribe tokens. No extra packages.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';

function scrypt(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

// ---------- Passwords ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: 16384, r: 8, p: 1 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A constant hash for the "user does not exist" path so login timing is the
// same whether or not the username is real.
let dummyHashPromise: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing');
  return dummyHashPromise;
}

// ---------- Symmetric encryption for credentials ----------

function keyBytes(): Buffer {
  const k = config.encryptionKey;
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, 'hex');
  // Anything else is stretched to 32 bytes. Fine for a generated random
  // string; for a human-chosen string it is only as strong as the string.
  return createHash('sha256').update(k).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
}

export function decrypt(token: string): string {
  const [v, iv, tag, ct] = token.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), fromB64url(iv));
  decipher.setAuthTag(fromB64url(tag));
  return Buffer.concat([decipher.update(fromB64url(ct)), decipher.final()]).toString('utf8');
}

// ---------- Tokens ----------

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}
export function randomId(): string {
  return randomBytes(16).toString('hex');
}

// Signed, non-secret tokens (unsubscribe links). Payload is readable; the
// signature stops anyone from forging a token for someone else's contact.
export function signPayload(payload: string): string {
  const sig = createHmac('sha256', config.sessionSecret).update(payload).digest();
  return `${b64url(Buffer.from(payload, 'utf8'))}.${b64url(sig)}`;
}
export function verifyPayload(token: string): string | null {
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const payload = fromB64url(p).toString('utf8');
  const expected = createHmac('sha256', config.sessionSecret).update(payload).digest();
  const got = fromB64url(s);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return payload;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------- TOTP (RFC 6238) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}
function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
export function totpCode(secretB32: string, at = Date.now()): string {
  return hotp(base32Decode(secretB32), Math.floor(at / 30000));
}
// Returns the time step the code matched, or null. A step at or before
// `lastStep` is refused: a code is good once, so one read over a shoulder
// or from a screenshot cannot be replayed inside its 30-second window.
export function matchTotp(secretB32: string, code: string, lastStep: number | null = null, window = 1, at = Date.now()): number | null {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(at / 30000);
  let matched: number | null = null;
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secret, step + i);
    // Every candidate is compared so timing does not reveal which step matched.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c)) && matched === null) matched = step + i;
  }
  if (matched !== null && lastStep !== null && matched <= lastStep) return null;
  return matched;
}
export function verifyTotp(secretB32: string, code: string, window = 1): boolean {
  return matchTotp(secretB32, code, null, window) !== null;
}
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
