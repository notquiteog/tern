// The calendar API (F13).
//
// Two routers, deliberately. `calendarRouter` sits behind the session and the
// CSRF header like everything else under /api. `calendarWebhookRouter` is
// mounted before those, because a change notification comes from Google or
// Microsoft rather than from a browser: it carries no session, cannot carry
// an X-Requested-With header, and is authenticated by the secret the channel
// was created with instead.
import { Router, raw } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z, idParam } from '../util/validate.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { rateLimit } from '../util/rateLimit.js';
import { requireCapability } from '../services/capabilities.js';
import { signPayload, verifyPayload } from '../crypto.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { query } from '../db.js';
import { calendarSync, pushPossible } from '../workers/calendarSync.js';
import * as caldav from '../services/calendar/caldav.js';
import { fetchIcs } from '../services/calendar/ics.js';
import {
  agendaFor, busyIn, createEvent, createSource, deleteEvent, deleteSource, eventsIn, getCalendar, getEvent,
  getSource, othersBusyIn, refreshCalendars, sourceForChannel, sourceSummaries, syncSource, updateCalendar, updateEvent,
} from '../services/calendar/index.js';
import { authorizeUrl, exchangeCode, getCalendarSettings, redirectUri, saveCalendarSettings, type OAuthProvider } from '../services/calendar/oauth.js';
import * as google from '../services/calendar/google.js';
import * as graph from '../services/calendar/microsoft.js';

const log = logger('calendar-api');

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

// Reading a calendar is reading somebody's own data rather than mining their
// mail, but it is still a feature that has to be turned on: it reaches
// outside the building to a third party, and the consent switch is where a
// person says that is all right.
const needsCalendar = requireCapability('calendar');

// ---------- Overview ----------

calendarRouter.get('/', needsCalendar, async (req, res) => {
  const s = await getCalendarSettings();
  res.json({
    sources: await sourceSummaries(req.user!.id),
    providers: {
      // A provider with no app registered cannot be offered, and the page
      // says why rather than showing a button that fails.
      google: Boolean(s.google.clientId && s.google.clientSecret),
      microsoft: Boolean(s.microsoft.clientId && s.microsoft.clientSecret),
      caldav: true,
      ics: true,
    },
    push: pushPossible(),
  });
});

// ---------- Connecting ----------

const davBody = z.object({
  label: z.string().max(120).optional(),
  url: z.string().url().max(500),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(500),
});

// Tried before it is stored, so a wrong password is a message on the form
// rather than a connection that sits in the list failing for ever.
calendarRouter.post('/sources/caldav', needsCalendar, rateLimit({ name: 'cal-connect', perMinute: 6, message: 'Too many connection attempts; wait a moment' }), async (req, res) => {
  const b = parse(davBody, req.body);
  const settings = await getCalendarSettings();
  const allowPrivate = settings.allowPrivateHosts || config.allowPrivateHosts;
  let found;
  try {
    found = await caldav.checkAccess(b.url, { username: b.username, password: b.password }, allowPrivate);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  if (!found.calendars.length) throw badRequest('Those credentials worked, but no calendars were found at that address');

  const source = await createSource(req.user!.id, {
    kind: 'caldav',
    label: b.label?.trim() || new URL(b.url).hostname,
    baseUrl: found.home,
    username: b.username,
    secret: b.password,
    pollSeconds: settings.pollSeconds,
  });
  await refreshCalendars(source);
  calendarSync.add(source.id, source.pollSeconds);
  await audit(req.user!.id, 'calendar.connected', { kind: 'caldav', host: new URL(b.url).hostname });
  res.json({ source: (await sourceSummaries(req.user!.id)).find((s) => s.id === source.id) });
});

calendarRouter.post('/sources/ics', needsCalendar, rateLimit({ name: 'cal-connect', perMinute: 6, message: 'Too many connection attempts; wait a moment' }), async (req, res) => {
  const b = parse(z.object({ label: z.string().max(120).optional(), url: z.string().max(500) }), req.body);
  const settings = await getCalendarSettings();
  const url = b.url.trim().replace(/^webcal:/i, 'https:');
  let probe;
  try {
    probe = await fetchIcs(url, { allowPrivate: settings.allowPrivateHosts || config.allowPrivateHosts });
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const source = await createSource(req.user!.id, {
    kind: 'ics',
    label: b.label?.trim() || probe.name || new URL(url).hostname,
    baseUrl: url,
    pollSeconds: Math.max(settings.pollSeconds, 900),
  });
  await refreshCalendars(source);
  calendarSync.add(source.id, source.pollSeconds);
  await audit(req.user!.id, 'calendar.connected', { kind: 'ics', host: new URL(url).hostname });
  res.json({ source: (await sourceSummaries(req.user!.id)).find((s) => s.id === source.id) });
});

// ---------- OAuth ----------

// State is signed rather than stored: it carries who started the flow and
// when, so a callback cannot be replayed against a different account and
// there is no table to clean up.
function makeState(userId: number, provider: OAuthProvider): string {
  return signPayload(JSON.stringify({ u: userId, p: provider, t: Date.now() }));
}

function readState(state: string): { userId: number; provider: OAuthProvider } | null {
  const payload = verifyPayload(state);
  if (!payload) return null;
  try {
    const j = JSON.parse(payload);
    if (typeof j.u !== 'number' || (j.p !== 'google' && j.p !== 'microsoft')) return null;
    // Ten minutes is longer than any consent screen takes and short enough
    // that a leaked URL in a browser history is not a way in later.
    if (Date.now() - Number(j.t) > 10 * 60_000) return null;
    return { userId: j.u, provider: j.p };
  } catch { return null; }
}

calendarRouter.get('/oauth/:provider/start', needsCalendar, async (req, res) => {
  const provider = String(req.params.provider);
  if (provider !== 'google' && provider !== 'microsoft') throw notFound('No such provider');
  res.json({ url: await authorizeUrl(provider, makeState(req.user!.id, provider)) });
});

// The provider sends the browser back here. It is a top-level GET, so the
// session cookie rides along (SameSite=Lax) and the person is identified
// both by it and by the signed state; both have to agree.
calendarRouter.get('/oauth/:provider/callback', async (req, res) => {
  const provider = String(req.params.provider);
  const back = (msg: string, ok = false) => res.redirect(`/settings/calendars?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
  if (provider !== 'google' && provider !== 'microsoft') return back('Unknown calendar provider');
  if (typeof req.query.error === 'string') return back(req.query.error === 'access_denied' ? 'The request was declined' : String(req.query.error).slice(0, 120));

  const state = readState(String(req.query.state ?? ''));
  if (!state) return back('That sign-in took too long or was tampered with; try again');
  if (!req.user || req.user.id !== state.userId) return back('Sign in to Tern first, then connect the calendar again');
  const code = String(req.query.code ?? '');
  if (!code) return back('The provider sent no authorisation code');

  try {
    const token = await exchangeCode(provider, code);
    if (!token.refreshToken) {
      // Without one the connection dies in an hour and cannot be renewed.
      return back('That account did not grant offline access, so the connection could not be kept. Try again and accept the consent screen.');
    }
    const source = await createSource(state.userId, {
      kind: provider,
      label: provider === 'google' ? 'Google Calendar' : 'Outlook',
      token,
      pollSeconds: (await getCalendarSettings()).pollSeconds,
    });
    await refreshCalendars(source);
    calendarSync.add(source.id, source.pollSeconds);
    await audit(state.userId, 'calendar.connected', { kind: provider });
    return back(provider === 'google' ? 'Google Calendar' : 'Outlook', true);
  } catch (e) {
    log.warn('oauth callback failed', { provider, err: (e as Error).message });
    return back((e as Error).message.slice(0, 200));
  }
});

// ---------- Sources and calendars ----------

calendarRouter.post('/sources/:id/sync', needsCalendar, rateLimit({ name: 'cal-sync', perMinute: 20, message: 'Wait a moment before syncing again' }), async (req, res) => {
  const id = idParam(String(req.params.id));
  if (!(await getSource(id, req.user!.id))) throw notFound('No such calendar connection');
  const out = await syncSource(id);
  res.json({ ...out, sources: await sourceSummaries(req.user!.id) });
});

calendarRouter.delete('/sources/:id', needsCalendar, async (req, res) => {
  const id = idParam(req.params.id);
  const source = await getSource(id, req.user!.id);
  if (!source) throw notFound('No such calendar connection');
  // Best effort: a channel left behind expires by itself, and a provider we
  // can no longer reach must not stop somebody disconnecting.
  try {
    if (source.kind === 'google' || source.kind === 'microsoft') {
      for (const c of await query<{ channel_id: string; channel_resource: string | null }>(
        'SELECT channel_id, channel_resource FROM calendars WHERE source_id=$1 AND channel_id IS NOT NULL', [id],
      )) {
        const auth = { token: source.token!, onRefresh: async () => {} };
        if (source.kind === 'google' && c.channel_resource) await google.unwatch(auth, c.channel_id, c.channel_resource);
        if (source.kind === 'microsoft') await graph.unsubscribe(auth, c.channel_id);
      }
    }
  } catch { /* the channel expires on its own */ }
  calendarSync.remove(id);
  await deleteSource(req.user!.id, id);
  await audit(req.user!.id, 'calendar.disconnected', { kind: source.kind });
  res.json({ ok: true, sources: await sourceSummaries(req.user!.id) });
});

calendarRouter.patch('/calendars/:id', needsCalendar, async (req, res) => {
  const b = parse(z.object({
    selected: z.boolean().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).nullable().optional(),
    isDefault: z.boolean().optional(),
  }), req.body);
  const cal = await updateCalendar(req.user!.id, idParam(req.params.id), b);
  if (!cal) throw notFound('No such calendar');
  res.json({ calendar: cal, sources: await sourceSummaries(req.user!.id) });
});

// ---------- Reading ----------

const rangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  calendarIds: z.string().max(200).optional(),
});

// A window is capped rather than refused: a client asking for five years gets
// the first year of it, which is a slow page rather than an error.
const MAX_RANGE_MS = 400 * 86_400_000;

calendarRouter.get('/events', needsCalendar, async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Math.min(q.to ? new Date(q.to).getTime() : from.getTime() + 42 * 86_400_000, from.getTime() + MAX_RANGE_MS));
  const calendarIds = q.calendarIds?.split(',').map((n) => Number(n)).filter(Number.isFinite);
  res.json({ events: await eventsIn(req.user!.id, from, to, { calendarIds }) });
});

calendarRouter.get('/events/:id', needsCalendar, async (req, res) => {
  const ev = await getEvent(req.user!.id, idParam(req.params.id));
  if (!ev) throw notFound('No such event');
  // The raw iCalendar is the record but is of no use to the browser, and it
  // carries properties nothing here models; it stays on the server.
  const { ical, ...safe } = ev;
  res.json({ event: safe });
});

calendarRouter.get('/agenda', needsCalendar, async (req, res) => {
  const day = typeof req.query.day === 'string' ? new Date(req.query.day) : new Date();
  if (Number.isNaN(day.getTime())) throw badRequest('That is not a date');
  const tz = typeof req.query.tz === 'string' ? req.query.tz.slice(0, 64) : undefined;
  res.json({ events: await agendaFor(req.user!.id, day, tz) });
});

// Times only, never titles: this is what the assistant and the brief consult.
calendarRouter.get('/freebusy', needsCalendar, async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const from = q.from ? new Date(q.from) : new Date();
  const to = new Date(Math.min(q.to ? new Date(q.to).getTime() : from.getTime() + 14 * 86_400_000, from.getTime() + MAX_RANGE_MS));
  const busy = await busyIn(req.user!.id, from, to);
  res.json({ busy: busy.map((b) => ({ startsAt: new Date(b.from).toISOString(), endsAt: new Date(b.to).toISOString() })) });
});

// Somebody else's free/busy, for proposing a time that suits everybody.
// Times only, from whichever connected account can answer; addresses nobody
// can speak for come back named rather than silently treated as free.
calendarRouter.get('/freebusy/others', needsCalendar, rateLimit({ name: 'cal-freebusy', perMinute: 30, message: 'Too many availability lookups; wait a moment' }), async (req, res) => {
  const q = parse(rangeQuery.extend({ emails: z.string().max(1200) }), req.query);
  const from = q.from ? new Date(q.from) : new Date();
  const to = new Date(Math.min(q.to ? new Date(q.to).getTime() : from.getTime() + 14 * 86_400_000, from.getTime() + MAX_RANGE_MS));
  const emails = q.emails.split(',').map((e) => e.trim()).filter((e) => e.includes('@')).slice(0, 20);
  const out = await othersBusyIn(req.user!.id, emails, from, to);
  res.json({
    busy: Object.fromEntries(Object.entries(out.busy).map(([email, blocks]) => [
      email, blocks.map((b) => ({ startsAt: new Date(b.from).toISOString(), endsAt: new Date(b.to).toISOString() })),
    ])),
    unknown: out.unknown,
  });
});

// ---------- Writing ----------

// Which occurrences a change applies to. Only meaningful on a series, and
// the service ignores it on a one-off rather than refusing the request.
const scopeBody = {
  scope: z.enum(['all', 'this', 'future']).optional(),
  occurrence: z.string().datetime().optional(),
  /** Write to the guests. Off unless asked for. */
  notify: z.boolean().optional(),
};

const eventBody = z.object({
  ...scopeBody,
  calendarId: z.number().int().optional(),
  summary: z.string().max(500).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().max(64).nullable().optional(),
  rrule: z.string().max(500).nullable().optional(),
  transparent: z.boolean().optional(),
  attendees: z.array(z.object({ email: z.string().email().max(320), name: z.string().max(200).nullable().optional() })).max(100).optional(),
  // Minutes before the start. Several are accepted because a file can carry
  // several; the earliest is the one that produces a notification.
  alarms: z.array(z.number().int().min(0).max(20160)).max(5).optional(),
});

calendarRouter.post('/events', needsCalendar, rateLimit({ name: 'cal-write', perMinute: 60, message: 'Too many calendar changes at once' }), async (req, res) => {
  const b = parse(eventBody, req.body);
  const ev = await createEvent(req.user!.id, b);
  const { ical, ...safe } = ev;
  res.json({ event: safe });
});

calendarRouter.patch('/events/:id', needsCalendar, rateLimit({ name: 'cal-write', perMinute: 60, message: 'Too many calendar changes at once' }), async (req, res) => {
  const b = parse(eventBody.partial(), req.body);
  const { scope, occurrence, ...fields } = b;
  const ev = await updateEvent(req.user!.id, idParam(String(req.params.id)), fields, { scope, occurrence });
  const { ical, ...safe } = ev;
  res.json({ event: safe });
});

// Scope and notify travel as query parameters because a DELETE with a body
// is accepted by some proxies and dropped by others.
calendarRouter.delete('/events/:id', needsCalendar, async (req, res) => {
  const q = parse(z.object({
    scope: z.enum(['all', 'this', 'future']).optional(),
    occurrence: z.string().datetime().optional(),
    notify: z.enum(['1', 'true', '0', 'false']).optional(),
  }), req.query);
  const invitations = await deleteEvent(req.user!.id, idParam(String(req.params.id)), {
    scope: q.scope, occurrence: q.occurrence, notify: q.notify === '1' || q.notify === 'true',
  });
  res.json({ ok: true, invitations });
});

// ---------- Admin ----------

export const calendarAdminRouter = Router();
calendarAdminRouter.use(requireAuth, requireAdmin);

calendarAdminRouter.get('/', async (_req, res) => {
  const s = await getCalendarSettings();
  res.json({
    settings: {
      google: { clientId: s.google.clientId, hasSecret: Boolean(s.google.clientSecret) },
      microsoft: { clientId: s.microsoft.clientId, hasSecret: Boolean(s.microsoft.clientSecret), tenant: s.microsoft.tenant },
      pollSeconds: s.pollSeconds,
      webhooks: s.webhooks,
      allowPrivateHosts: s.allowPrivateHosts,
    },
    // The exact strings an operator has to paste into each console. Getting
    // these wrong is the single most common way an OAuth app fails, so they
    // are shown rather than described.
    redirectUris: { google: redirectUri('google'), microsoft: redirectUri('microsoft') },
    pushPossible: pushPossible(),
    appUrl: config.appUrl,
  });
});

calendarAdminRouter.put('/', async (req, res) => {
  const b = parse(z.object({
    google: z.object({ clientId: z.string().max(300).optional(), clientSecret: z.string().max(300).nullable().optional() }).optional(),
    microsoft: z.object({ clientId: z.string().max(300).optional(), clientSecret: z.string().max(300).nullable().optional(), tenant: z.string().max(120).optional() }).optional(),
    pollSeconds: z.number().int().min(60).max(3600).optional(),
    webhooks: z.boolean().optional(),
    allowPrivateHosts: z.boolean().optional(),
  }), req.body);

  // A blank secret means "keep the stored one"; null means "clear it". The
  // secret itself is never sent back to a browser, so a form cannot echo it.
  const current = await getCalendarSettings();
  const merge = (was: { clientSecret: string }, patch?: { clientSecret?: string | null }) => {
    if (!patch || patch.clientSecret === undefined || patch.clientSecret === '') return was.clientSecret;
    return patch.clientSecret === null ? '' : patch.clientSecret;
  };
  const next = await saveCalendarSettings({
    ...b,
    google: b.google ? { clientId: b.google.clientId ?? current.google.clientId, clientSecret: merge(current.google, b.google) } : undefined,
    microsoft: b.microsoft
      ? { clientId: b.microsoft.clientId ?? current.microsoft.clientId, clientSecret: merge(current.microsoft, b.microsoft), tenant: b.microsoft.tenant ?? current.microsoft.tenant }
      : undefined,
  });
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'calendar.settings_updated',$2)`, [
    req.user!.id,
    JSON.stringify({ ...b, google: b.google ? { ...b.google, clientSecret: b.google.clientSecret ? '(set)' : undefined } : undefined, microsoft: b.microsoft ? { ...b.microsoft, clientSecret: b.microsoft.clientSecret ? '(set)' : undefined } : undefined }),
  ]);
  await calendarSync.refreshAll();
  res.json({
    settings: {
      google: { clientId: next.google.clientId, hasSecret: Boolean(next.google.clientSecret) },
      microsoft: { clientId: next.microsoft.clientId, hasSecret: Boolean(next.microsoft.clientSecret), tenant: next.microsoft.tenant },
      pollSeconds: next.pollSeconds, webhooks: next.webhooks, allowPrivateHosts: next.allowPrivateHosts,
    },
  });
});

// ---------- Webhooks ----------
//
// Mounted before the session and the CSRF header, because these come from
// Google and Microsoft rather than from a browser. Neither carries event
// data — both say only "something in this resource changed" — so the worst a
// forged one can do is cause a sync that would have happened anyway. They are
// still checked against the secret the channel was created with, and answer
// 200 either way: a provider that gets an error disables the channel.

export const calendarWebhookRouter = Router();

calendarWebhookRouter.post('/google', raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  res.status(200).end();
  try {
    const channelId = String(req.header('x-goog-channel-id') ?? '');
    const raw = req.header('x-goog-channel-token');
  const token = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    const state = String(req.header('x-goog-resource-state') ?? '');
    // The handshake Google sends when a channel is created.
    if (!channelId || state === 'sync') return;
    const hit = await sourceForChannel(channelId, token);
    if (!hit) { log.debug('ignored a google notification for an unknown channel'); return; }
    calendarSync.request(hit.sourceId, 1500);
  } catch (e) {
    log.warn('google webhook failed', { err: (e as Error).message });
  }
});

calendarWebhookRouter.post('/microsoft', raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  // Graph validates a new subscription by calling it with a token that must
  // be echoed back as plain text, within seconds, before it will deliver
  // anything.
  const validation = req.query.validationToken ?? req.query.validationtoken;
  if (typeof validation === 'string') {
    res.type('text/plain').status(200).send(validation.slice(0, 2000));
    return;
  }
  res.status(202).end();
  try {
    const body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '{}'));
    const seen = new Set<number>();
    for (const n of body?.value ?? []) {
      const hit = await sourceForChannel(String(n?.subscriptionId ?? ''), n?.clientState ?? null);
      if (!hit || seen.has(hit.sourceId)) continue;
      seen.add(hit.sourceId);
      calendarSync.request(hit.sourceId, 1500);
    }
  } catch (e) {
    log.warn('microsoft webhook failed', { err: (e as Error).message });
  }
});

async function audit(userId: number, action: string, details: unknown): Promise<void> {
  await query('INSERT INTO audit_log (user_id, action, details) VALUES ($1,$2,$3)', [userId, action, JSON.stringify(details)]);
}

// Re-exported so the settings page can show what a calendar is allowed to do.
export { getCalendar };
