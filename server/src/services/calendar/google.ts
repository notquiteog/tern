// Google Calendar, over its own REST API rather than over CalDAV.
//
// Google does still speak CalDAV, but the v3 API is the path that has the
// two things "live sync" actually needs: opaque sync tokens, so a poll costs
// one request that usually returns an empty list, and push channels, so most
// polls do not happen at all.
//
// Fidelity: events are converted to iCalendar and stored as iCalendar, the
// same as every other source. Google makes that honest rather than lossy —
// its `recurrence` field is already a list of RRULE/EXDATE/RDATE lines, and
// `iCalUID` is the real UID — so a Google event and a CalDAV event become
// the same kind of row, and one code path reads both.
import { logger } from '../../log.js';
import { newEvent, vtimeOf, writeCalendar, type VEvent } from './vevent.js';
import { usableZone } from './vevent.js';
import { civilToUtc, instantOf } from './recurrence.js';
import { freshToken } from './oauth.js';
import type { OAuthToken } from './store.js';

const log = logger('gcal');
const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleAuth { token: OAuthToken; onRefresh: (t: OAuthToken) => Promise<void> }

export class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly auth = false, readonly staleToken = false) { super(message); }
}

async function api(auth: GoogleAuth, path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<any> {
  const access = await freshToken('google', auth.token, auth.onRefresh);
  const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${access}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* raw body */ }
    // 410 is Google's "your sync token is too old"; the caller starts again
    // rather than treating it as a failure.
    throw new GoogleError(message, res.status, res.status === 401 || res.status === 403, res.status === 410);
  }
  return text ? JSON.parse(text) : null;
}

export interface GoogleCalendar { id: string; name: string; color: string | null; timezone: string | null; readOnly: boolean; primary: boolean }

export async function listCalendars(auth: GoogleAuth): Promise<GoogleCalendar[]> {
  const out: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const j = await api(auth, '/users/me/calendarList', { query: { pageToken, maxResults: '250', showHidden: 'false' } });
    for (const c of j?.items ?? []) {
      out.push({
        id: String(c.id),
        name: String(c.summaryOverride ?? c.summary ?? c.id),
        color: c.backgroundColor ?? null,
        timezone: c.timeZone ?? null,
        readOnly: !['owner', 'writer'].includes(String(c.accessRole ?? '')),
        primary: Boolean(c.primary),
      });
    }
    pageToken = j?.nextPageToken;
  } while (pageToken && out.length < 500);
  return out;
}

export interface GoogleSync { changed: { id: string; ical: string; etag: string | null }[]; removed: string[]; syncToken: string | null; full: boolean }

/**
 * What changed in one calendar.
 *
 * `singleEvents=false` is deliberate: it returns the series master with its
 * recurrence rules and the exceptions as separate items, which is the shape
 * this stores. Asking Google to expand instead would hand back thousands of
 * rows and lose the rule that generated them, so a later edit could not say
 * "all future occurrences".
 */
export async function syncCalendar(auth: GoogleAuth, calendarId: string, opts: { syncToken?: string | null; window?: { from: Date; to: Date } } = {}): Promise<GoogleSync> {
  const changed: GoogleSync['changed'] = [];
  const removed: string[] = [];
  // Masters and their exceptions arrive as separate items; an exception has
  // to be written into the same file as its master, so they are gathered
  // first and assembled at the end.
  const byUid = new Map<string, { master: VEvent | null; overrides: VEvent[]; id: string; etag: string | null }>();

  let pageToken: string | undefined;
  let syncToken = opts.syncToken ?? null;
  let nextSyncToken: string | null = null;
  let full = !opts.syncToken;

  const base: Record<string, string | undefined> = { maxResults: '2500', singleEvents: 'false', showDeleted: 'true' };
  // A time window is only legal on a first sync; with a token Google decides
  // the scope itself.
  if (!syncToken && opts.window) { base.timeMin = opts.window.from.toISOString(); base.timeMax = opts.window.to.toISOString(); }

  do {
    let j: any;
    try {
      j = await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: { ...base, pageToken, syncToken: syncToken ?? undefined },
      });
    } catch (e) {
      if (e instanceof GoogleError && e.staleToken && syncToken) {
        // Start again from scratch, which is what Google asks for.
        log.info('google sync token expired; resyncing in full', { calendar: calendarId.slice(0, 24) });
        syncToken = null; pageToken = undefined; full = true;
        byUid.clear(); changed.length = 0; removed.length = 0;
        if (opts.window) { base.timeMin = opts.window.from.toISOString(); base.timeMax = opts.window.to.toISOString(); }
        continue;
      }
      throw e;
    }
    for (const item of j?.items ?? []) {
      const id = String(item.id ?? '');
      if (!id) continue;
      if (item.status === 'cancelled' && !item.recurringEventId) { removed.push(id); continue; }
      const uid = String(item.iCalUID ?? item.recurringEventId ?? id);
      const ev = toVEvent(item);
      if (!ev) continue;
      const slot: { master: VEvent | null; overrides: VEvent[]; id: string; etag: string | null } =
        byUid.get(uid) ?? { master: null, overrides: [], id, etag: item.etag ?? null };
      if (ev.recurrenceId) slot.overrides.push(ev);
      else { slot.master = ev; slot.id = id; slot.etag = item.etag ?? null; }
      byUid.set(uid, slot);
    }
    pageToken = j?.nextPageToken;
    nextSyncToken = j?.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  for (const [uid, slot] of byUid) {
    // An exception whose master was not in this page: the caller re-fetches
    // the master by UID rather than storing a fragment.
    if (!slot.master) { changed.push({ id: slot.id, ical: '', etag: null }); continue; }
    slot.master.uid = uid;
    for (const o of slot.overrides) o.uid = uid;
    changed.push({ id: slot.id, ical: writeCalendar([slot.master, ...slot.overrides]), etag: slot.etag });
  }
  return { changed: changed.filter((c) => c.ical), removed, syncToken: nextSyncToken, full };
}

/** One event and its exceptions, by Google's own id. Used to fill a gap. */
export async function getEvent(auth: GoogleAuth, calendarId: string, eventId: string): Promise<{ ical: string; etag: string | null } | null> {
  const item = await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  if (!item || item.status === 'cancelled') return null;
  const master = toVEvent(item);
  if (!master) return null;
  master.uid = String(item.iCalUID ?? item.id);
  const overrides: VEvent[] = [];
  if (item.recurrence?.length) {
    const inst = await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/instances`, { query: { maxResults: '250', showDeleted: 'true' } });
    for (const i of inst?.items ?? []) {
      if (!i.originalStartTime) continue;
      const o = toVEvent(i);
      if (o?.recurrenceId) { o.uid = master.uid; overrides.push(o); }
    }
  }
  return { ical: writeCalendar([master, ...overrides]), etag: item.etag ?? null };
}

// ---------- Conversion ----------

// Google's {date} or {dateTime, timeZone} pair.
function timeOf(v: any, fallbackZone?: string | null): { at: Date; allDay: boolean; tzid: string | null } | null {
  if (!v) return null;
  if (v.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v.date));
    if (!m) return null;
    return { at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), allDay: true, tzid: null };
  }
  if (!v.dateTime) return null;
  const at = new Date(v.dateTime);
  if (Number.isNaN(at.getTime())) return null;
  return { at, allDay: false, tzid: usableZone(v.timeZone ?? fallbackZone ?? null) };
}

export function toVEvent(item: any): VEvent | null {
  const start = timeOf(item.start);
  if (!start) return null;
  const e = newEvent(String(item.iCalUID ?? item.id ?? ''));
  e.summary = item.summary ?? null;
  e.description = item.description ?? null;
  e.location = item.location ?? null;
  e.url = item.htmlLink ?? null;
  e.status = item.status === 'cancelled' ? 'CANCELLED' : item.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED';
  e.transparent = item.transparency === 'transparent';
  e.sequence = Number(item.sequence ?? 0) || 0;
  e.start = vtimeOf(start.at, { allDay: start.allDay, tzid: start.tzid });
  const end = timeOf(item.end);
  if (end) e.end = vtimeOf(end.at, { allDay: end.allDay, tzid: end.tzid });
  if (item.organizer?.email) e.organizer = { email: String(item.organizer.email).toLowerCase(), name: item.organizer.displayName ?? null };
  for (const a of item.attendees ?? []) {
    if (!a?.email) continue;
    e.attendees.push({
      email: String(a.email).toLowerCase(),
      name: a.displayName ?? null,
      role: a.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT',
      partstat: ({ accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE', needsAction: 'NEEDS-ACTION' } as Record<string, string>)[String(a.responseStatus ?? '')] ?? 'NEEDS-ACTION',
      rsvp: false,
      cutype: a.resource ? 'RESOURCE' : null,
    });
  }
  // Already iCalendar: RRULE/EXRULE/RDATE/EXDATE lines, verbatim.
  for (const line of item.recurrence ?? []) {
    const l = String(line);
    if (/^RRULE:/i.test(l)) e.rrule = l.slice(6);
    else if (/^EXDATE/i.test(l)) e.exdates.push(...parseDateLines(l));
    else if (/^RDATE/i.test(l)) e.rdates.push(...parseDateLines(l));
  }
  if (item.originalStartTime) {
    const o = timeOf(item.originalStartTime);
    if (o) e.recurrenceId = vtimeOf(o.at, { allDay: o.allDay, tzid: o.tzid });
  }
  return e;
}

// EXDATE;TZID=Europe/London:20260302T090000,20260309T090000
function parseDateLines(line: string): Date[] {
  const colon = line.indexOf(':');
  if (colon < 0) return [];
  const head = line.slice(0, colon);
  const tz = /TZID=([^;:]+)/i.exec(head)?.[1] ?? null;
  const zone = usableZone(tz);
  const out: Date[] = [];
  for (const raw of line.slice(colon + 1).split(',')) {
    const v = raw.trim();
    const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (d) { out.push(new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]))); continue; }
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
    if (!m) continue;
    const civil = { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +m[6] };
    // A Z-suffixed value is already an instant; a zoned one is a wall clock
    // and is resolved in its zone exactly as a DTSTART is, or the excluded
    // occurrence misses the one it was meant to remove by an hour.
    out.push(new Date(m[7] || !zone ? civilToUtc(civil) : instantOf(civil, zone)));
  }
  return out;
}

// ---------- Writing ----------

/** A VEvent as Google's JSON, for a create or an update. */
export function toGoogle(e: VEvent): Record<string, unknown> {
  const time = (t: NonNullable<VEvent['start']>) => (t.allDay
    ? { date: new Date(t.at).toISOString().slice(0, 10) }
    : { dateTime: t.at.toISOString(), timeZone: t.tzid ?? 'UTC' });
  const recurrence: string[] = [];
  if (e.rrule) recurrence.push(`RRULE:${e.rrule.replace(/^RRULE:/i, '')}`);
  if (e.exdates.length) recurrence.push(`EXDATE:${e.exdates.map((d) => `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`).join(',')}`);
  if (e.rdates.length) recurrence.push(`RDATE:${e.rdates.map((d) => `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`).join(',')}`);
  return {
    iCalUID: e.uid,
    summary: e.summary ?? undefined,
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    start: e.start ? time(e.start) : undefined,
    end: e.end ? time(e.end) : e.start ? time(e.start) : undefined,
    transparency: e.transparent ? 'transparent' : 'opaque',
    status: e.status ? String(e.status).toLowerCase() : undefined,
    recurrence: recurrence.length ? recurrence : undefined,
    attendees: e.attendees.length
      ? e.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined, optional: a.role === 'OPT-PARTICIPANT' || undefined }))
      : undefined,
  };
}

export async function createEvent(auth: GoogleAuth, calendarId: string, e: VEvent): Promise<{ id: string; etag: string | null }> {
  const j = await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', body: JSON.stringify(toGoogle(e)),
  });
  return { id: String(j.id), etag: j.etag ?? null };
}

export async function updateEvent(auth: GoogleAuth, calendarId: string, eventId: string, e: VEvent, etag?: string | null): Promise<{ etag: string | null; conflict: boolean }> {
  try {
    const j = await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(toGoogle(e)),
      // Google honours If-Match on an etag, which is what keeps two clients
      // from overwriting each other.
      headers: etag ? { 'If-Match': etag } : {},
    });
    return { etag: j?.etag ?? null, conflict: false };
  } catch (err) {
    if (err instanceof GoogleError && err.status === 412) return { etag: null, conflict: true };
    throw err;
  }
}

export async function deleteEvent(auth: GoogleAuth, calendarId: string, eventId: string): Promise<void> {
  try {
    await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (e) {
    // Already gone is the outcome that was wanted.
    if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

// ---------- Somebody else's free/busy ----------

/**
 * When the named people are busy, as far as their calendars will say.
 *
 * Free/busy is the only cross-person query any of these providers offers,
 * and it is the right one: it returns opaque blocks of time and nothing
 * about what is in them. Somebody outside the organisation, or with their
 * calendar closed, comes back with an error rather than with times — which
 * is a fact worth passing on rather than swallowing, because "no busy
 * periods" and "would not say" are very different answers.
 */
export async function freeBusy(auth: GoogleAuth, emails: string[], from: Date, to: Date): Promise<Map<string, { from: number; to: number }[]>> {
  const out = new Map<string, { from: number; to: number }[]>();
  if (!emails.length) return out;
  const j = await api(auth, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      items: emails.slice(0, 50).map((id) => ({ id })),
    }),
  });
  for (const [email, entry] of Object.entries<any>(j?.calendars ?? {})) {
    if (entry?.errors?.length) continue;
    out.set(email.toLowerCase(), (entry?.busy ?? []).map((b: any) => ({ from: new Date(b.start).getTime(), to: new Date(b.end).getTime() })));
  }
  return out;
}

// ---------- Push ----------

export interface Channel { id: string; resourceId: string; expiresAt: Date | null }

/**
 * Ask Google to call us when this calendar changes.
 *
 * The channel is a POST to our address carrying no event data at all — only
 * "something changed" — so the webhook is a nudge to sync rather than a way
 * in. It expires (a week at most) and is renewed by the sweep.
 */
export async function watch(auth: GoogleAuth, calendarId: string, opts: { channelId: string; address: string; token: string }): Promise<Channel | null> {
  try {
    const j = await api(auth, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: 'POST',
      body: JSON.stringify({ id: opts.channelId, type: 'web_hook', address: opts.address, token: opts.token, params: { ttl: '604800' } }),
    });
    return { id: String(j.id), resourceId: String(j.resourceId), expiresAt: j.expiration ? new Date(Number(j.expiration)) : null };
  } catch (e) {
    // A webhook needs a public HTTPS address Google can reach and verify. An
    // install behind a LAN, or on plain http, simply keeps polling.
    log.info('google declined a push channel; polling instead', { err: (e as Error).message });
    return null;
  }
}

export async function unwatch(auth: GoogleAuth, channelId: string, resourceId: string): Promise<void> {
  try {
    await api(auth, 'https://www.googleapis.com/calendar/v3/channels/stop', {
      method: 'POST', body: JSON.stringify({ id: channelId, resourceId }),
    });
  } catch { /* the channel expires on its own soon enough */ }
}
