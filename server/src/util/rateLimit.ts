// A small per-user rate limit for endpoints that do real work on request:
// connecting to a mail server someone typed in, asking the model for a
// draft, looking a key up on the internet, streaming a full data export.
// Sign-in is covered by the proof of work; this is for signed-in people and
// keeps one runaway tab or script from monopolising the box. In memory,
// per process, which matches the single-container deployment.
import type { NextFunction, Request, Response } from 'express';
import { tooMany } from '../errors.js';
import { sha256hex } from '../crypto.js';
import { clientIp } from '../auth.js';

interface Bucket { times: number[] }
const buckets = new Map<string, Bucket>();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, b] of buckets) { b.times = b.times.filter((t) => t > cutoff); if (!b.times.length) buckets.delete(k); }
}, 60_000).unref();

export interface LimitOptions { perMinute: number; name: string; message?: string }

export function take(key: string, perMinute: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { times: [] };
  b.times = b.times.filter((t) => now - t < windowMs);
  if (b.times.length >= perMinute) { buckets.set(key, b); return false; }
  b.times.push(now);
  buckets.set(key, b);
  return true;
}

export function rateLimit(opts: LimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Signed-in requests are counted per user; anonymous ones per (hashed) address.
    const who = req.user ? `u${req.user.id}` : `a${sha256hex(clientIp(req)).slice(0, 16)}`;
    if (!take(`${opts.name}|${who}`, opts.perMinute)) {
      res.setHeader('Retry-After', '60');
      return next(tooMany(opts.message ?? 'Too many requests; slow down a little and try again'));
    }
    next();
  };
}

export function resetRateLimits(): void { buckets.clear(); }
