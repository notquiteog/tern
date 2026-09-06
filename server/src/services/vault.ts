// Encryption at rest for the mail cache (ENCRYPTION.md, layer 1).
//
// What this protects: a database dump, a leaked backup, a disk image, a
// compromised Postgres role. Someone holding those gets ciphertext and
// nothing else. What it does not protect against: root on the running box,
// because the app must decrypt to sync, search, thread and answer mail while
// nobody is signed in. That is the trade the product makes, and layer 3
// (sealed accounts) in ENCRYPTION.md is the answer for anyone who wants the
// server out entirely.
//
// Each user has a random 256-bit data key. The data key is stored wrapped
// with the server master key from `.env`, never in the clear, so rotating
// the master key re-wraps a few rows rather than re-encrypting every message.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, query } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { logger } from '../log.js';

const log = logger('vault');

// Unwrapped data keys, per process. Small: one entry per user, and a user
// with no traffic falls out after an hour.
interface CachedKey { key: Buffer; at: number }
const keys = new Map<number, CachedKey>();
const KEY_TTL_MS = 3600_000;
setInterval(() => { const now = Date.now(); for (const [k, v] of keys) if (now - v.at > KEY_TTL_MS) { v.key.fill(0); keys.delete(k); } }, 300_000).unref();

export function forgetKeys(userId?: number): void {
  if (userId === undefined) { for (const v of keys.values()) v.key.fill(0); keys.clear(); return; }
  const v = keys.get(userId);
  if (v) { v.key.fill(0); keys.delete(userId); }
}

// The user's data key, creating one on first use so accounts made before
// this shipped get a key the moment anything of theirs is written.
export async function dataKey(userId: number): Promise<Buffer> {
  const hit = keys.get(userId);
  if (hit) { hit.at = Date.now(); return hit.key; }
  const row = await one<{ dek_wrapped: string | null }>('SELECT dek_wrapped FROM users WHERE id=$1', [userId]);
  if (!row) throw new Error(`No such user ${userId}`);
  let key: Buffer;
  if (row.dek_wrapped) {
    key = Buffer.from(decrypt(row.dek_wrapped), 'base64');
    if (key.length !== 32) throw new Error(`Data key for user ${userId} is malformed`);
  } else {
    key = randomBytes(32);
    // Two requests racing to create the key must end with the same one, or
    // whichever wrote second would orphan the first's ciphertext.
    const claimed = await query<{ dek_wrapped: string }>(
      'UPDATE users SET dek_wrapped=$2 WHERE id=$1 AND dek_wrapped IS NULL RETURNING dek_wrapped',
      [userId, encrypt(key.toString('base64'))],
    );
    if (!claimed.length) {
      const again = await one<{ dek_wrapped: string }>('SELECT dek_wrapped FROM users WHERE id=$1', [userId]);
      key = Buffer.from(decrypt(again!.dek_wrapped), 'base64');
    }
  }
  keys.set(userId, { key, at: Date.now() });
  return key;
}

// ---------- Content ----------
// Values are AES-256-GCM under the user's data key, in the same
// `v1.iv.tag.ct` shape crypto.ts already uses for mailbox credentials, with
// a `k1.` prefix so a stored value says which key opens it. Reads accept
// plaintext too: an install upgrades in the background, and a row the
// backfill has not reached yet must still be readable.

const PREFIX = 'k1.';

// The pure halves take the key itself. Everything below them is a thin
// wrapper that looks the key up; keeping the split means the cryptography is
// testable, and reviewable, without a database in the way.
export function sealWith(key: Buffer, plain: string | null): string | null {
  if (plain === null || plain === undefined) return null;
  return PREFIX + gcm('encrypt', key, plain);
}

export function openWith(key: Buffer, stored: unknown): string | null {
  if (stored === null || stored === undefined) return null;
  // A column may still be JSONB on an install that is mid-migration, in which
  // case the driver hands back a parsed value rather than text. That is not
  // ciphertext; it is the plaintext this was meant to replace, so it is
  // returned as JSON rather than treated as an error.
  if (typeof stored !== 'string') return JSON.stringify(stored);
  if (!stored.startsWith(PREFIX)) return stored; // not yet encrypted
  try {
    return gcm('decrypt', key, stored.slice(PREFIX.length));
  } catch {
    return null;
  }
}

export async function seal(userId: number, plain: string | null): Promise<string | null> {
  if (plain === null || plain === undefined) return null;
  return sealWith(await dataKey(userId), plain);
}

export async function open(userId: number, stored: string | null): Promise<string | null> {
  if (stored === null || stored === undefined) return null;
  const out = openWith(await dataKey(userId), stored);
  // A value that will not open is a real problem (wrong ENCRYPTION_KEY, a
  // half-restored backup). Say so once per value rather than crashing a
  // whole mailbox view.
  if (out === null && isSealed(stored)) log.error('could not decrypt a stored value', { user: userId });
  return out;
}

export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// JSON columns (address lists, attachment metadata) travel as text.
export async function sealJson(userId: number, value: unknown): Promise<string | null> {
  if (value === null || value === undefined) return null;
  return seal(userId, JSON.stringify(value));
}
export async function openJson<T>(userId: number, stored: string | null, fallback: T): Promise<T> {
  const text = await open(userId, stored);
  if (text === null) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function gcm(mode: 'encrypt' | 'decrypt', key: Buffer, input: string): string {
  if (mode === 'encrypt') {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(input, 'utf8'), c.final()]);
    return `${b64(iv)}.${b64(c.getAuthTag())}.${b64(ct)}`;
  }
  const [iv, tag, ct] = input.split('.');
  // An empty string encrypts to empty ciphertext, which is legitimate; only
  // a missing part is malformed.
  if (!iv || !tag || ct === undefined) throw new Error('Malformed ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, unb64(iv));
  d.setAuthTag(unb64(tag));
  return Buffer.concat([d.update(unb64(ct)), d.final()]).toString('utf8');
}

function b64(b: Buffer): string { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(s: string): Buffer { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// ---------- Blind index ----------
// A tsvector over plaintext would defeat the whole exercise: the index would
// hold every word of every message in the clear. Instead each searchable
// token becomes HMAC-SHA256(search key, token), truncated to 12 bytes, and a
// query hashes its words the same way and matches with `&&` on a GIN index.
//
// What this gives: exact word match and prefix match (the first 3, 5 and 8
// characters are indexed as their own terms). What it costs, and the
// SECURITY.md text says so: no relevance ranking, no stemming, no phrase
// search, no mid-word substring. The index still leaks the *number* of
// distinct terms in a message and lets someone with the database confirm a
// guessed word if they also have the key; without the key it is opaque.

const SEARCH_INFO = 'tern-search-v1';
const ADDRESS_INFO = 'tern-address-v1';

// Separate keys for bodies and for addresses, both derived from the data
// key, so a term that matches a word cannot be confused with one that
// matches a sender.
export function searchKey(dek: Buffer): Buffer {
  return createHmac('sha256', dek).update(SEARCH_INFO).digest();
}
export function addressKey(dek: Buffer): Buffer {
  return createHmac('sha256', dek).update(ADDRESS_INFO).digest();
}

// Words as the index stores them: lowercased, unicode-normalised, stripped
// of punctuation, and long runs cut off so one pathological token cannot
// bloat a row.
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  const words = text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}_+@.'-]+/u);
  for (const raw of words) {
    const w = raw.replace(/^[.'-]+|[.'-]+$/g, '');
    if (w.length < 2 || w.length > 60) continue;
    out.add(w);
    // An address is also findable by its parts, so "ana@corp.example"
    // answers a search for "ana" or "corp".
    if (w.includes('@') || w.includes('.')) {
      for (const part of w.split(/[@.]/)) if (part.length >= 2 && part.length <= 60) out.add(part);
    }
    if (out.size > 4000) break;
  }
  return [...out];
}

// Prefixes let "invo" find "invoice" without leaking the word itself. A
// word is indexed whole and under every shorter bucket, so a query can try
// the exact hash and the bucket that fits its length and hit either.
function withPrefixes(word: string): string[] {
  const out = [word];
  for (const n of [3, 5, 8]) if (word.length > n) out.push(`${n}:${word.slice(0, n)}`);
  return out;
}

export function indexTermsWith(key: Buffer, text: string): Buffer[] {
  const terms = new Set<string>();
  for (const w of tokenize(text)) for (const t of withPrefixes(w)) terms.add(t);
  return [...terms].map((t) => hmac12(key, t));
}
export async function indexTerms(userId: number, text: string): Promise<Buffer[]> {
  return indexTermsWith(searchKey(await dataKey(userId)), text);
}

// One group of alternatives per word the person typed: the exact hash, and
// the prefix bucket that fits, so "invo" reaches "invoice" and "cat" still
// finds "cat". The caller ANDs the groups, matching each with `&&`, which is
// what makes a two-word search mean both words rather than either.
export function queryTermGroupsWith(key: Buffer, text: string): Buffer[][] {
  const groups: Buffer[][] = [];
  for (const w of tokenize(text)) {
    const alts = new Set<string>([w]);
    for (const n of [8, 5, 3]) {
      if (w.length >= n) { alts.add(`${n}:${w.slice(0, n)}`); break; }
    }
    groups.push([...alts].map((t) => hmac12(key, t)));
  }
  return groups;
}
export async function queryTermGroups(userId: number, text: string): Promise<Buffer[][]> {
  return queryTermGroupsWith(searchKey(await dataKey(userId)), text);
}

// Addresses have their own key so a term that matches a body word cannot be
// confused with one that matches a sender, and so `from:` can be exact.
export function addressTermsWith(key: Buffer, addresses: string[]): Buffer[] {
  const out = new Set<string>();
  for (const a of addresses) {
    const e = String(a ?? '').trim().toLowerCase();
    if (!e) continue;
    out.add(e);
    const [local, domain] = e.split('@');
    if (domain) { out.add(domain); if (local) out.add(local); }
  }
  return [...out].map((t) => hmac12(key, t));
}
export async function addressTerms(userId: number, addresses: string[]): Promise<Buffer[]> {
  return addressTermsWith(addressKey(await dataKey(userId)), addresses);
}

// The query side is deliberately narrower than the index side. The index
// holds the whole address, its domain and its local part, so `from:corp.example`
// and `from:ana` both work. A needle that is itself a full address must match
// only that address, though, or everyone at a domain would answer for
// everyone else.
export function addressQueryWith(key: Buffer, needle: string): Buffer[] {
  const e = String(needle ?? '').trim().toLowerCase();
  if (!e) return [];
  return [hmac12(key, e)];
}
export async function addressQuery(userId: number, needle: string): Promise<Buffer[]> {
  return addressQueryWith(addressKey(await dataKey(userId)), needle);
}

function hmac12(key: Buffer, term: string): Buffer {
  return createHmac('sha256', key).update(term).digest().subarray(0, 12);
}

// Exported for tests: two term lists overlap in constant time per pair.
export function termsOverlap(a: Buffer[], b: Buffer[]): boolean {
  for (const x of a) for (const y of b) if (x.length === y.length && timingSafeEqual(x, y)) return true;
  return false;
}
