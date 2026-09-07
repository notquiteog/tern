// Proof of work for signed-in requests that cost the server real money:
// generation, embedding a mailbox, transcription, importing an archive.
//
// Why not a rate limit. A counter says "you have had your forty this minute"
// and then refuses, which is the wrong answer twice over: it punishes the
// person working quickly through their inbox exactly as hard as the script
// hammering the box, and it gives an admin nothing between "allowed" and
// "denied". Work is a dial rather than a gate. The first requests in a
// window are almost free — a few milliseconds the browser spends while the
// button is still animating — and the cost climbs with what this person has
// already asked for and with what the box is currently carrying. A person
// notices nothing; a loop pays quadratically for its own enthusiasm.
//
// It is also the answer to a problem a rate limit cannot address at all: the
// expensive thing here is a local model with a fixed number of slots, so the
// resource being defended is shared between everyone signed in. Making the
// client burn CPU before it may queue is the only throttle that scales with
// how contended the model actually is.
//
// The challenge is signed, single use, bound to the purpose *and the
// session*, and short-lived, so it cannot be pre-computed, shared between
// people, or replayed. That is the same design as the sign-in proof of work
// in pow.ts, and this file deliberately borrows its primitives rather than
// inventing a second scheme.
import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { signPayload, verifyPayload } from '../crypto.js';
import { badRequest } from '../errors.js';
import { leadingZeroBits } from '../pow.js';
import { activeSessions } from '../ai/session.js';

export const WORK_PURPOSES = ['ai', 'brief', 'search', 'index', 'voice', 'import'] as const;
export type WorkPurpose = (typeof WORK_PURPOSES)[number];

// Where each purpose starts, in leading zero bits. 8 bits is 256 hashes:
// under a millisecond, and invisible. 14 is ~16k hashes, a few tens of
// milliseconds. The ceiling is what a determined loop pays per request.
const BASE_BITS: Record<WorkPurpose, number> = {
  ai: 10,      // one generation
  brief: 16,   // reads a whole mailbox and writes a page; rare by design
  search: 8,   // interactive, and typed at
  index: 12,   // starts a background pass over an archive
  voice: 10,   // one clip
  import: 18,  // reads a file of unbounded size
};
const MAX_BITS = 24;
const TTL_MS = 5 * 60_000;
const WINDOW_MS = 5 * 60_000;

interface Recent { times: number[] }
const recent = new Map<string, Recent>();
const spent = new Map<string, number>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of spent) if (v < now) spent.delete(k);
  for (const [k, r] of recent) {
    r.times = r.times.filter((t) => now - t < WINDOW_MS);
    if (!r.times.length) recent.delete(k);
  }
}
setInterval(prune, 60_000).unref();

// How busy the model is right now, as extra bits for everyone. A box with
// every slot in use asks a little more of the next request to arrive, which
// is the difference between a queue that grows and one that does not.
function loadBits(): number {
  const busy = activeSessions();
  if (busy <= 1) return 0;
  return Math.min(4, Math.floor(Math.log2(busy)) + 1);
}

export function workDifficulty(purpose: WorkPurpose, who: string): number {
  prune();
  const key = `${purpose}|${who}`;
  const used = recent.get(key)?.times.length ?? 0;
  // Free for the first few, then one bit — a doubling — per request after
  // that. Ten requests in five minutes costs about 2^17 hashes on the tenth,
  // which is a fraction of a second. A hundred costs more than the loop is
  // willing to pay.
  const climb = used <= 3 ? 0 : Math.min(10, used - 3);
  return Math.min(MAX_BITS, BASE_BITS[purpose] + climb + loadBits());
}

export interface WorkChallenge { challenge: string; difficulty: number; expiresAt: string }

export function issueWork(purpose: WorkPurpose, who: string): WorkChallenge {
  const difficulty = workDifficulty(purpose, who);
  const payload = JSON.stringify({ p: purpose, s: who, d: difficulty, t: Date.now(), n: randomBytes(12).toString('hex') });
  return { challenge: signPayload(payload), difficulty, expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
}

export function verifyWork(purpose: WorkPurpose, who: string, challenge: unknown, nonce: unknown): void {
  if (typeof challenge !== 'string' || typeof nonce !== 'string') throw work('work_required', 'This request needs browser verification');
  if (nonce.length > 64 || challenge.length > 600) throw work('work_invalid', 'Browser verification failed; try again');
  const payload = verifyPayload(challenge);
  if (!payload) throw work('work_invalid', 'Browser verification failed; try again');
  let c: { p: string; s: string; d: number; t: number; n: string };
  try { c = JSON.parse(payload); } catch { throw work('work_invalid', 'Browser verification failed; try again'); }
  if (c.p !== purpose || c.s !== who) throw work('work_invalid', 'Browser verification does not match this request; try again');
  if (Date.now() - c.t > TTL_MS) throw work('work_invalid', 'Browser verification expired; try again');
  if (spent.has(c.n)) throw work('work_invalid', 'Browser verification was already used; try again');
  const digest = createHash('sha256').update(`${challenge}.${nonce}`).digest();
  if (leadingZeroBits(digest) < c.d) throw work('work_invalid', 'Browser verification failed; try again');
  spent.set(c.n, c.t + TTL_MS);
  const key = `${purpose}|${who}`;
  const r = recent.get(key) ?? { times: [] };
  r.times.push(Date.now());
  recent.set(key, r);
}

// Who the work is bound to: the session, so a stolen challenge is useless in
// another browser, and so one person's spending does not raise the price for
// everybody else.
export function workSubject(req: Request): string {
  return req.sessionId ? `s${req.sessionId.slice(0, 24)}` : `u${req.user?.id ?? 0}`;
}

// Route middleware. The solution rides in headers rather than the body so it
// works the same on a JSON post, a streaming upload and an SSE GET.
export function powGuard(purpose: WorkPurpose) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      verifyWork(purpose, workSubject(req), req.get('X-Work-Challenge'), req.get('X-Work-Nonce'));
      next();
    } catch (e) { next(e); }
  };
}

function work(code: string, message: string) {
  const e = badRequest(message);
  e.code = code;
  return e;
}

export function resetWorkGuard(): void { recent.clear(); spent.clear(); }
