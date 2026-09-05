// Sessions and request guards. Server-side sessions in Postgres so a password
// change or an admin disabling an account takes effect on the next request,
// not when a token happens to expire.
import type { NextFunction, Request, Response } from 'express';
import { one, query } from './db.js';
import { config } from './config.js';
import { randomToken } from './crypto.js';
import { forbidden, tooMany, unauthorized } from './errors.js';

export const COOKIE = 'tern_sid';

export interface UserRow {
  id: number; username: string; display_name: string; password_hash: string; role: 'admin' | 'member';
  totp_secret: string | null; totp_enabled: boolean; recovery_codes: string[]; prefs: Record<string, unknown>;
  disabled: boolean; password_changed_at: Date; created_at: Date; last_login_at: Date | null;
  avatar?: Buffer | null; avatar_type?: string | null; avatar_updated_at?: Date | null;
}
export type PublicUser = Omit<UserRow, 'password_hash' | 'totp_secret' | 'recovery_codes' | 'avatar' | 'avatar_type'> & { avatar_version: number | null };

export function publicUser(u: UserRow): PublicUser {
  const { password_hash, totp_secret, recovery_codes, avatar, avatar_type, ...rest } = u;
  return { ...rest, avatar_version: u.avatar_updated_at ? new Date(u.avatar_updated_at).getTime() : null };
}

declare module 'express-serve-static-core' {
  interface Request { user?: UserRow; sessionId?: string }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function setSessionCookie(res: Response, id: string | null): void {
  const parts = [`${COOKIE}=${id ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  parts.push(id ? `Max-Age=${config.sessionDays * 86400}` : 'Max-Age=0');
  res.append('Set-Cookie', parts.join('; '));
}

export async function createSession(userId: number, userAgent: string | undefined): Promise<string> {
  const id = randomToken(32);
  await query(`INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)`, [id, userId, String(config.sessionDays), (userAgent ?? '').slice(0, 300)]);
  return id;
}

export async function destroySession(id: string): Promise<void> {
  await query('DELETE FROM sessions WHERE id=$1', [id]);
}

export async function destroyUserSessions(userId: number, except?: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id=$1 AND ($2::text IS NULL OR id <> $2)', [userId, except ?? null]);
}

// Loads the user for the request if a valid session cookie is present.
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid) return next();
  const row = await one<UserRow & { sid: string; last_seen_at: Date }>(
    `SELECT u.id, u.username, u.display_name, u.password_hash, u.role, u.totp_secret, u.totp_enabled, u.recovery_codes, u.prefs, u.disabled, u.password_changed_at, u.created_at, u.last_login_at, u.avatar_updated_at, s.id AS sid, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=$1 AND s.expires_at > now()`,
    [sid],
  );
  if (!row || row.disabled) return next();
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [sid]).catch(() => {});
  }
  const { sid: _s, last_seen_at: _l, ...user } = row;
  req.user = user as UserRow;
  req.sessionId = sid;
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Admin access required'));
  next();
}

// Browser forms cannot set custom headers cross-site, so requiring one on
// every state-changing call closes CSRF without tokens to rotate.
export function csrfGuard(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/u/')) return next();
  if (req.headers['x-requested-with'] !== 'tern') return next(forbidden('Missing X-Requested-With header'));
  next();
}

// Login throttling per username and per address, in memory. A restart
// clears it, which is acceptable for a single-container deployment.
const attempts = new Map<string, { count: number; until: number }>();
export function checkLoginAllowed(key: string): void {
  const a = attempts.get(key);
  if (a && a.count >= 8 && Date.now() < a.until) throw tooMany('Too many failed sign-ins. Try again in a few minutes.');
}
export function recordLoginFailure(key: string): void {
  const a = attempts.get(key) ?? { count: 0, until: 0 };
  a.count += 1;
  a.until = Date.now() + 15 * 60_000;
  attempts.set(key, a);
}
export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

export function clientIp(req: Request): string {
  return (config.trustProxy && (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()) || req.socket.remoteAddress || '';
}
