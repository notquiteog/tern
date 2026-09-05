// Proof of work for the sign-in, registration and first-run forms.
//
// The app sits behind a reverse proxy on a box whose visitors may all share
// one address (a VPN, a corporate NAT) or none (a botnet), so throttling by
// IP is not something we can rely on. Instead every attempt costs the client
// some CPU: it asks for a challenge, finds a nonce whose SHA-256 has enough
// leading zero bits, and submits both with the form. A challenge is signed,
// bound to a purpose and a username, single use, and short-lived, so work
// cannot be pre-computed, shared between usernames, or replayed.
//
// The difficulty is adaptive: a handful of bits for a quiet server (tens of
// milliseconds in a browser), climbing with recent failures for the same
// username and with the global request rate, up to a cap that keeps a real
// person waiting a few seconds at most while making a guessing run cost
// millions of hashes per try.
import { createHash, randomBytes } from 'node:crypto';
import { signPayload, verifyPayload } from './crypto.js';
import { badRequest } from './errors.js';

export type PowPurpose = 'login' | 'register' | 'setup';

const BASE_BITS: Record<PowPurpose, number> = { login: 15, register: 18, setup: 15 };
const MAX_BITS = 22;
const TTL_MS = 10 * 60_000;
const FAIL_WINDOW_MS = 15 * 60_000;

// Recent failures per username (any address) and per-minute issue rate.
const failures = new Map<string, number[]>();
const issued: number[] = [];
const used = new Map<string, number>();

function prune(): void {
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  for (const [k, list] of failures) {
    const keep = list.filter((t) => now - t < FAIL_WINDOW_MS);
    if (keep.length) failures.set(k, keep); else failures.delete(k);
  }
  while (issued.length && now - issued[0] > 60_000) issued.shift();
}
setInterval(prune, 30_000).unref();

export function difficultyFor(purpose: PowPurpose, username: string): number {
  prune();
  let bits = BASE_BITS[purpose];
  const recent = failures.get(`${purpose}|${username.toLowerCase()}`)?.length ?? 0;
  // The first couple of typos are free; after that each failure doubles the work.
  if (recent > 2) bits += Math.min(7, recent - 2);
  // A server-wide surge (many usernames at once) raises the floor for everyone.
  const perMinute = issued.length;
  if (perMinute > 30) bits += Math.min(4, Math.ceil(Math.log2(perMinute / 30)));
  return Math.min(MAX_BITS, bits);
}

export interface PowChallenge { challenge: string; difficulty: number; expiresAt: string }

export function issueChallenge(purpose: PowPurpose, username: string): PowChallenge {
  const difficulty = difficultyFor(purpose, username);
  const payload = JSON.stringify({ p: purpose, u: username.toLowerCase(), d: difficulty, t: Date.now(), n: randomBytes(12).toString('hex') });
  issued.push(Date.now());
  return { challenge: signPayload(payload), difficulty, expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
}

export function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export interface PowSolution { challenge: string; nonce: string }

// Throws a 400 with a stable code the client can react to: `pow_required`
// when missing, `pow_invalid` when the challenge is stale, spent, for another
// purpose or username, or the nonce does not meet the difficulty.
export function verifySolution(purpose: PowPurpose, username: string, sol: PowSolution | undefined): void {
  if (!sol || typeof sol.challenge !== 'string' || typeof sol.nonce !== 'string') throw pow('pow_required', 'Browser verification is required');
  if (sol.nonce.length > 64 || sol.challenge.length > 600) throw pow('pow_invalid', 'Browser verification failed; try again');
  const payload = verifyPayload(sol.challenge);
  if (!payload) throw pow('pow_invalid', 'Browser verification failed; try again');
  let c: { p: string; u: string; d: number; t: number; n: string };
  try { c = JSON.parse(payload); } catch { throw pow('pow_invalid', 'Browser verification failed; try again'); }
  if (c.p !== purpose || c.u !== username.toLowerCase()) throw pow('pow_invalid', 'Browser verification does not match this form; try again');
  if (Date.now() - c.t > TTL_MS) throw pow('pow_invalid', 'Browser verification expired; try again');
  if (used.has(c.n)) throw pow('pow_invalid', 'Browser verification was already used; try again');
  const digest = createHash('sha256').update(`${sol.challenge}.${sol.nonce}`).digest();
  if (leadingZeroBits(digest) < c.d) throw pow('pow_invalid', 'Browser verification failed; try again');
  used.set(c.n, c.t + TTL_MS);
}

export function recordFailure(purpose: PowPurpose, username: string): void {
  const k = `${purpose}|${username.toLowerCase()}`;
  failures.set(k, [...(failures.get(k) ?? []), Date.now()]);
}
export function clearFailures(purpose: PowPurpose, username: string): void {
  failures.delete(`${purpose}|${username.toLowerCase()}`);
}

function pow(code: string, message: string) {
  const e = badRequest(message);
  e.code = code;
  return e;
}

// Exposed for tests: solve a challenge the slow way.
export function solveForTest(challenge: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const d = createHash('sha256').update(`${challenge}.${i}`).digest();
    if (leadingZeroBits(d) >= difficulty) return String(i);
  }
}
