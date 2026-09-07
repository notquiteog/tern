// OAuth for the two providers that have no other way in.
//
// Google and Microsoft both require an app registration, and a self-hosted
// product has exactly two options for that: ship credentials of its own, or
// have each operator register their own. Tern does the second. Shipping a
// client id would make this project the party Google and Microsoft hold
// responsible for everyone's calendar access, put every install behind one
// verification review and one rate limit, and route consent screens through
// a name the person has no relationship with. An operator registering their
// own app takes ten minutes, keeps the trust relationship between the
// company and the people actually using it, and means Tern never holds a
// credential that could be revoked out from under every install at once.
//
// So the client id and secret are admin settings, and the connect button
// says what to do when they are not set.
import { one, query } from '../../db.js';
import { config } from '../../config.js';
import { badRequest } from '../../errors.js';
import { logger } from '../../log.js';
import type { OAuthToken } from './store.js';

const log = logger('calendar-oauth');

export interface ProviderApp { clientId: string; clientSecret: string; tenant?: string }

export interface CalendarSettings {
  google: ProviderApp;
  microsoft: ProviderApp;
  /** How often a source is polled when it has no push channel. */
  pollSeconds: number;
  /** Ask the providers for webhooks. Needs a public HTTPS address. */
  webhooks: boolean;
  /** Let members connect a CalDAV server on this network. */
  allowPrivateHosts: boolean;
}

const DEFAULTS: CalendarSettings = {
  google: { clientId: '', clientSecret: '' },
  microsoft: { clientId: '', clientSecret: '', tenant: 'common' },
  pollSeconds: 300,
  webhooks: true,
  allowPrivateHosts: false,
};

let cache: { at: number; value: CalendarSettings } | null = null;

export async function getCalendarSettings(): Promise<CalendarSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await one<{ value: Partial<CalendarSettings> }>(`SELECT value FROM settings WHERE key='calendar'`);
  const v = row?.value ?? {};
  const value: CalendarSettings = {
    ...DEFAULTS, ...v,
    google: { ...DEFAULTS.google, ...(v.google ?? {}) },
    microsoft: { ...DEFAULTS.microsoft, ...(v.microsoft ?? {}) },
  };
  cache = { at: Date.now(), value };
  return value;
}

export async function saveCalendarSettings(patch: Partial<CalendarSettings>): Promise<CalendarSettings> {
  const current = await getCalendarSettings();
  const next: CalendarSettings = {
    ...current, ...patch,
    google: { ...current.google, ...(patch.google ?? {}) },
    microsoft: { ...current.microsoft, ...(patch.microsoft ?? {}) },
  };
  next.pollSeconds = Math.min(3600, Math.max(60, next.pollSeconds));
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('calendar', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(next)],
  );
  cache = null;
  return next;
}

export function forgetCalendarSettings(): void { cache = null; }

// ---------- The two providers ----------

export type OAuthProvider = 'google' | 'microsoft';

export const SCOPES: Record<OAuthProvider, string> = {
  // Read and write events, and read the list of calendars. Nothing about the
  // person beyond that: no profile, no contacts, no mail.
  google: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
  microsoft: 'offline_access https://graph.microsoft.com/Calendars.ReadWrite',
};

export function redirectUri(provider: OAuthProvider): string {
  return `${config.appUrl}/api/calendar/oauth/${provider}/callback`;
}

function endpoints(provider: OAuthProvider, tenant: string) {
  return provider === 'google'
    ? { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' }
    : {
      auth: `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/token`,
    };
}

export async function appFor(provider: OAuthProvider): Promise<ProviderApp> {
  const s = await getCalendarSettings();
  const app = provider === 'google' ? s.google : s.microsoft;
  if (!app.clientId || !app.clientSecret) {
    throw badRequest(`${provider === 'google' ? 'Google' : 'Microsoft'} calendar is not set up on this server. An administrator needs to register an app and enter its client ID and secret under Admin → Calendar.`);
  }
  return app;
}

export async function authorizeUrl(provider: OAuthProvider, state: string): Promise<string> {
  const app = await appFor(provider);
  const { auth } = endpoints(provider, app.tenant ?? 'common');
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: SCOPES[provider],
    state,
  });
  if (provider === 'google') {
    // Without both of these Google returns no refresh token on a repeat
    // authorisation, and the connection dies silently an hour later.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'true');
  } else {
    params.set('response_mode', 'query');
  }
  return `${auth}?${params}`;
}

async function tokenRequest(provider: OAuthProvider, body: URLSearchParams): Promise<OAuthToken> {
  const app = await appFor(provider);
  const { token } = endpoints(provider, app.tenant ?? 'common');
  body.set('client_id', app.clientId);
  body.set('client_secret', app.clientSecret);
  const res = await fetch(token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // The provider's own message is far more useful than a status code:
    // "invalid_grant" means the person revoked access, which is a thing to
    // say plainly rather than retry for ever.
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = `${j.error ?? ''} ${j.error_description ?? ''}`.trim() || detail; } catch { /* keep the raw body */ }
    throw badRequest(`${provider === 'google' ? 'Google' : 'Microsoft'} refused the sign-in: ${detail}`);
  }
  const j = JSON.parse(text);
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: String(j.refresh_token ?? ''),
    expiresAt: Date.now() + Math.max(60, Number(j.expires_in ?? 3600)) * 1000,
    scope: j.scope,
  };
}

export async function exchangeCode(provider: OAuthProvider, code: string): Promise<OAuthToken> {
  return tokenRequest(provider, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider),
  }));
}

/**
 * A valid access token, refreshing when the one we hold is close to expiry.
 *
 * `onRefresh` writes the new pair back, because Microsoft rotates the refresh
 * token on every use: keeping the old one means the connection works until
 * the access token expires and then never again.
 */
export async function freshToken(provider: OAuthProvider, token: OAuthToken, onRefresh: (t: OAuthToken) => Promise<void>): Promise<string> {
  if (token.accessToken && token.expiresAt > Date.now() + 120_000) return token.accessToken;
  if (!token.refreshToken) throw badRequest('That calendar connection has expired and needs to be reconnected');
  const next = await tokenRequest(provider, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    ...(provider === 'microsoft' ? { scope: SCOPES.microsoft } : {}),
  }));
  // Google does not return the refresh token on a refresh; the old one stays
  // good. Microsoft does, and the new one replaces it.
  if (!next.refreshToken) next.refreshToken = token.refreshToken;
  await onRefresh(next);
  log.debug('refreshed a calendar token', { provider });
  return next.accessToken;
}
