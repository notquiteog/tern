// OpenPGP on the server: everything that needs only public keys. Parsing and
// validating uploaded keys, encrypting outgoing mail and exports to
// recipients' keys, the decryption challenges behind sign-in-with-key, and
// looking recipients' keys up over WKD and keys.openpgp.org.
//
// The server never has a usable private key. A user's private key is stored
// only in the passphrase-protected form OpenPGP itself produces (and wrapped
// once more with the server master key); decrypting and signing happen in
// the browser.
import * as openpgp from 'openpgp';
import { createHash, timingSafeEqual } from 'node:crypto';
import { one, query } from '../db.js';
import { decrypt, encrypt, randomToken } from '../crypto.js';
import { badRequest } from '../errors.js';
import { logger } from '../log.js';
import { describeKeyShape } from './pgpPackets.js';
import { getPeer, recommend, type PreferEncrypt, type Recommendation } from './autocrypt.js';

const log = logger('pgp');

export interface KeyInfo { armored: string; fingerprint: string; keyId: string; userIds: string[]; emails: string[]; algorithm: string; created: Date; expires: Date | null; version: number; algorithms: string[]; postQuantum: boolean; postQuantumAlgorithms: string[] }
export type PgpAuthMode = 'off' | 'second_factor' | 'passwordless';
export interface UserKeys { publicKey: string | null; fingerprint: string | null; privateKey: string | null; auth: PgpAuthMode; updatedAt: Date | null; autocrypt: { enabled: boolean; prefer: PreferEncrypt } }

export function extractEmail(userId: string): string | null {
  const m = userId.match(/<([^>]+)>/) ?? userId.match(/([^\s<>@]+@[^\s<>@]+)/);
  return m ? m[1].toLowerCase() : null;
}

// `raw` is the certificate as it arrived; the packet walker reads algorithm
// ids the library skipped (post-quantum subkeys) that key.write() would drop.
async function describe(key: openpgp.Key, raw?: string | Uint8Array): Promise<KeyInfo> {
  const exp = await key.getExpirationTime().catch(() => null);
  const expires = exp instanceof Date ? exp : null;
  if (expires && expires.getTime() < Date.now()) throw badRequest('This key has expired');
  try { await key.getEncryptionKey(); } catch { throw badRequest('This key cannot be used for encryption: no valid encryption subkey, or the key is revoked'); }
  const info = key.getAlgorithmInfo();
  const userIds = key.getUserIDs();
  let shape = { version: 0, algorithms: [] as string[], postQuantum: false, postQuantumAlgorithms: [] as string[] };
  try { shape = describeKeyShape(raw ?? key.toPublic().write()); } catch { /* cosmetic */ }
  return {
    armored: key.toPublic().armor(),
    fingerprint: key.getFingerprint(),
    keyId: key.getKeyID().toHex(),
    userIds,
    emails: userIds.map(extractEmail).filter((e): e is string => Boolean(e)),
    algorithm: `${info.algorithm}${info.curve ? ` ${info.curve}` : info.bits ? ` ${info.bits}` : ''}`,
    created: key.getCreationTime(),
    expires,
    ...shape,
  };
}

export async function readPublicKey(armored: string): Promise<KeyInfo> {
  let key: openpgp.Key;
  try { key = await openpgp.readKey({ armoredKey: armored.trim() }); } catch (e) { throw badRequest(`Not a valid OpenPGP key: ${(e as Error).message}`); }
  if (key.isPrivate()) throw badRequest('That is a private key. Paste it into the private key field instead.');
  return describe(key, armored.trim());
}

// A private key is accepted only in passphrase-protected form; the public
// half is derived from it so the pair can never disagree.
export async function readPrivateKey(armored: string): Promise<{ armored: string; info: KeyInfo }> {
  let key: openpgp.PrivateKey;
  try { key = await openpgp.readPrivateKey({ armoredKey: armored.trim() }); } catch (e) { throw badRequest(`Not a valid OpenPGP private key: ${(e as Error).message}`); }
  if (key.isDecrypted()) throw badRequest('The private key must be protected with a passphrase before it is stored');
  return { armored: key.armor(), info: await describe(key, armored.trim()) };
}

export async function getUserKeys(userId: number): Promise<UserKeys> {
  const r = await one<any>('SELECT pgp_public_key, pgp_fingerprint, pgp_private_key_enc, pgp_auth, pgp_updated_at, autocrypt_enabled, autocrypt_prefer FROM users WHERE id=$1', [userId]);
  return { publicKey: r?.pgp_public_key ?? null, fingerprint: r?.pgp_fingerprint ?? null, privateKey: r?.pgp_private_key_enc ? decrypt(r.pgp_private_key_enc) : null, auth: (r?.pgp_auth ?? 'off') as PgpAuthMode, updatedAt: r?.pgp_updated_at ?? null, autocrypt: { enabled: r?.autocrypt_enabled ?? true, prefer: (r?.autocrypt_prefer ?? 'nopreference') as PreferEncrypt } };
}

export async function saveUserKeys(userId: number, publicKey: string, fingerprint: string, privateKey: string | null | undefined): Promise<void> {
  // `undefined` keeps the stored private key; `null` removes it.
  await query(
    `UPDATE users SET pgp_public_key=$2, pgp_fingerprint=$3, pgp_private_key_enc = CASE WHEN $5 THEN pgp_private_key_enc ELSE $4 END, pgp_updated_at=now() WHERE id=$1`,
    [userId, publicKey, fingerprint, privateKey ? encrypt(privateKey) : null, privateKey === undefined],
  );
}

export async function clearUserKeys(userId: number): Promise<void> {
  await query(`UPDATE users SET pgp_public_key=NULL, pgp_fingerprint=NULL, pgp_private_key_enc=NULL, pgp_auth='off', pgp_updated_at=now() WHERE id=$1`, [userId]);
}

// ---------- Encryption ----------

async function keysFrom(armoredKeys: string[]): Promise<openpgp.Key[]> {
  const seen = new Set<string>();
  const out: openpgp.Key[] = [];
  for (const a of armoredKeys) {
    const k = await openpgp.readKey({ armoredKey: a });
    if (seen.has(k.getFingerprint())) continue;
    seen.add(k.getFingerprint());
    out.push(k);
  }
  return out;
}

export async function encryptText(text: string, armoredKeys: string[]): Promise<string> {
  const encryptionKeys = await keysFrom(armoredKeys);
  if (!encryptionKeys.length) throw badRequest('No key to encrypt to');
  return openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys, format: 'armored' });
}

export async function encryptStream(stream: ReadableStream<string>, armoredKeys: string[]): Promise<ReadableStream<string>> {
  const encryptionKeys = await keysFrom(armoredKeys);
  return openpgp.encrypt({ message: await openpgp.createMessage({ text: stream }), encryptionKeys, format: 'armored' }) as unknown as Promise<ReadableStream<string>>;
}

// ---------- Recipients' keys ----------

// `recommendation` is set only for keys learned through Autocrypt: those
// follow the Autocrypt decision procedure instead of "encrypt whenever a
// key is on file".
export interface RecipientKey { email: string; fingerprint: string; publicKey: string; source: string; recommendation?: Recommendation }

export async function recipientKeys(userId: number, emails: string[]): Promise<Map<string, RecipientKey>> {
  const list = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (!list.length) return new Map();
  const rows = await query<RecipientKey>(
    `SELECT lower(email) AS email, pgp_fingerprint AS fingerprint, pgp_public_key AS "publicKey", 'contact' AS source FROM contacts WHERE user_id=$1 AND lower(email) = ANY($2) AND pgp_public_key IS NOT NULL
     UNION ALL SELECT email, fingerprint, public_key AS "publicKey", source FROM pgp_keys WHERE user_id=$1 AND email = ANY($2)`,
    [userId, list],
  );
  const out = new Map<string, RecipientKey>();
  for (const r of rows) if (!out.has(r.email)) out.set(r.email, r);
  // Writing to one of your own mailboxes: your own key is the recipient's key.
  let missing = list.filter((e) => !out.has(e));
  if (!missing.length) return out;
  const mine = await getUserKeys(userId);
  const own = await query<{ email: string }>('SELECT lower(email) AS email FROM accounts WHERE user_id=$1 AND lower(email) = ANY($2)', [userId, missing]);
  if (own.length && mine.publicKey && mine.fingerprint) for (const o of own) out.set(o.email, { email: o.email, fingerprint: mine.fingerprint, publicKey: mine.publicKey, source: 'own key' });
  // Keys that arrived in Autocrypt headers, with the spec's recommendation.
  missing = list.filter((e) => !out.has(e));
  for (const e of missing) {
    const peer = await getPeer(userId, e);
    const r = recommend(peer, mine.autocrypt.prefer);
    if (r.key && r.fingerprint && r.source) out.set(e, { email: e, fingerprint: r.fingerprint, publicKey: r.key, source: r.source, recommendation: r.recommendation });
  }
  return out;
}

export async function saveRecipientKey(userId: number, email: string, info: KeyInfo, source: string): Promise<RecipientKey> {
  const e = email.toLowerCase();
  await query('UPDATE contacts SET pgp_public_key=$3, pgp_fingerprint=$4, updated_at=now() WHERE user_id=$1 AND lower(email)=$2', [userId, e, info.armored, info.fingerprint]);
  await query(
    `INSERT INTO pgp_keys (user_id, email, fingerprint, public_key, source) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, email) DO UPDATE SET fingerprint=EXCLUDED.fingerprint, public_key=EXCLUDED.public_key, source=EXCLUDED.source, created_at=now()`,
    [userId, e, info.fingerprint, info.armored, source],
  );
  return { email: e, fingerprint: info.fingerprint, publicKey: info.armored, source };
}

export async function removeRecipientKey(userId: number, email: string): Promise<void> {
  const e = email.toLowerCase();
  await query('UPDATE contacts SET pgp_public_key=NULL, pgp_fingerprint=NULL WHERE user_id=$1 AND lower(email)=$2', [userId, e]);
  await query('DELETE FROM pgp_keys WHERE user_id=$1 AND email=$2', [userId, e]);
}

// Web Key Directory (advanced then direct method), then keys.openpgp.org.
// Only a key that carries the address as a user ID is accepted.
const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
export function zbase32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ZBASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31];
  return out;
}

async function fetchKey(url: string, binary: boolean): Promise<openpgp.Key | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'follow', headers: { Accept: binary ? 'application/octet-stream' : 'application/pgp-keys, text/plain' } });
    if (!res.ok) return null;
    if (binary) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) return null;
      return await openpgp.readKey({ binaryKey: buf });
    }
    const text = await res.text();
    if (!text.includes('BEGIN PGP PUBLIC KEY BLOCK')) return null;
    return await openpgp.readKey({ armoredKey: text });
  } catch (e) {
    log.debug('key lookup failed', { url: url.split('?')[0], err: (e as Error).message });
    return null;
  }
}

export async function lookupKey(email: string): Promise<{ info: KeyInfo; source: string } | null> {
  const e = email.trim().toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain) return null;
  const hash = zbase32(createHash('sha1').update(local).digest());
  const candidates: [string, boolean, string][] = [
    [`https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${encodeURIComponent(local)}`, true, 'wkd'],
    [`https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${encodeURIComponent(local)}`, true, 'wkd'],
    [`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(e)}`, false, 'keys.openpgp.org'],
  ];
  for (const [url, binary, source] of candidates) {
    const key = await fetchKey(url, binary);
    if (!key || key.isPrivate()) continue;
    try {
      const info = await describe(key);
      if (!info.emails.includes(e)) continue;
      return { info, source };
    } catch { /* expired or unusable; try the next source */ }
  }
  return null;
}

// ---------- Sign-in challenges ----------
// A random token encrypted to the user's public key. Whoever can return the
// plaintext holds the private key. Single use, five minutes.

interface Challenge { userId: number; token: string; purpose: string; expires: number }
const challenges = new Map<string, Challenge>();
setInterval(() => { const now = Date.now(); for (const [k, c] of challenges) if (c.expires < now) challenges.delete(k); }, 60_000).unref();

export const CHALLENGE_PREFIX = 'tern-auth:';

export async function createChallenge(userId: number, publicKey: string, purpose: 'login' | 'passwordless' | 'enable'): Promise<{ id: string; armored: string }> {
  const token = randomToken(24);
  const id = randomToken(16);
  const armored = await encryptText(`${CHALLENGE_PREFIX}${token}`, [publicKey]);
  challenges.set(id, { userId, token, purpose, expires: Date.now() + 5 * 60_000 });
  return { id, armored };
}

// For a username that has no key or no passwordless sign-in: a challenge
// nobody can answer, so the response reveals nothing about the account.
export async function createDecoyChallenge(): Promise<{ id: string; armored: string }> {
  const { publicKey } = await openpgp.generateKey({ userIDs: [{ name: 'nobody' }], format: 'armored' });
  return createChallenge(0, publicKey, 'passwordless');
}

export function verifyChallenge(id: string | undefined, response: string | undefined, purpose: Challenge['purpose']): number | null {
  if (!id || !response) return null;
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.purpose !== purpose || c.expires < Date.now() || c.userId === 0) return null;
  const given = response.trim().replace(new RegExp(`^${CHALLENGE_PREFIX}`), '');
  const a = Buffer.from(given), b = Buffer.from(c.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return c.userId;
}
