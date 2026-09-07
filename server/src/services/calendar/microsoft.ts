// Outlook and Microsoft 365, over Graph.
//
// There is no CalDAV option here at all: Microsoft removed it from Exchange
// Online years ago, and personal outlook.com accounts go through the same
// Graph endpoints as work ones. So this is not a preference — it is the only
// door.
//
// The awkward part of Graph, and the reason this file is longer than the
// Google one: recurrence is a structured object rather than an RRULE, so it
// has to be translated in both directions. And the delta endpoint that
// reports deletions (`calendarView/delta`) returns *expanded occurrences*,
// while the shape stored here is the series master. So delta is used for
// "what changed", and anything it names as part of a series causes the
// master to be fetched whole.
import { logger } from '../../log.js';
import { newEvent, usableZone, vtimeOf, writeCalendar, type VEvent } from './vevent.js';
import { freshToken } from './oauth.js';
import type { OAuthToken } from './store.js';

const log = logger('graph');
const API = 'https://graph.microsoft.com/v1.0';

export interface GraphAuth { token: OAuthToken; onRefresh: (t: OAuthToken) => Promise<void> }

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly auth = false, readonly staleToken = false) { super(message); }
}

async function api(auth: GraphAuth, path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<any> {
  const access = await freshToken('microsoft', auth.token, auth.onRefresh);
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
    let code = '';
    try { const j = JSON.parse(text); message = j?.error?.message ?? message; code = String(j?.error?.code ?? ''); } catch { /* raw body */ }
    throw new GraphError(message, res.status, res.status === 401 || res.status === 403, code === 'resyncRequired' || res.status === 410);
  }
  return text ? JSON.parse(text) : null;
}

export interface GraphCalendar { id: string; name: string; color: string | null; timezone: string | null; readOnly: boolean; primary: boolean }

export async function listCalendars(auth: GraphAuth): Promise<GraphCalendar[]> {
  const j = await api(auth, '/me/calendars', { query: { $top: '100', $select: 'id,name,color,hexColor,canEdit,isDefaultCalendar,owner' } });
  return (j?.value ?? []).map((c: any) => ({
    id: String(c.id),
    name: String(c.name ?? 'Calendar'),
    color: c.hexColor || null,
    timezone: null,
    readOnly: c.canEdit === false,
    primary: Boolean(c.isDefaultCalendar),
  }));
}

export interface GraphSync { changed: { id: string; ical: string; etag: string | null }[]; removed: string[]; deltaLink: string | null; full: boolean }

/**
 * What changed in one calendar, since a delta link.
 *
 * `calendarView/delta` needs a bounded window and hands back occurrences.
 * Anything that belongs to a series is resolved to its master and fetched
 * once, so a weekly meeting produces one stored object rather than fifty.
 */
export async function syncCalendar(auth: GraphAuth, calendarId: string, opts: { deltaLink?: string | null; window: { from: Date; to: Date } }): Promise<GraphSync> {
  const changed: GraphSync['changed'] = [];
  const removed: string[] = [];
  const masters = new Set<string>();
  const singles: any[] = [];
  let deltaLink: string | null = null;
  let full = !opts.deltaLink;

  let url: string | null = opts.deltaLink ?? null;
  let first = true;
  let pages = 0;

  while (pages++ < 100) {
    let j: any;
    try {
      j = url
        ? await api(auth, url, { headers: { Prefer: 'odata.maxpagesize=200' } })
        : await api(auth, `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`, {
          query: { startDateTime: opts.window.from.toISOString(), endDateTime: opts.window.to.toISOString() },
          headers: { Prefer: 'odata.maxpagesize=200' },
        });
    } catch (e) {
      if (e instanceof GraphError && e.staleToken && url) {
        log.info('graph delta expired; resyncing in full', { calendar: calendarId.slice(0, 24) });
        url = null; full = true; first = true;
        changed.length = 0; removed.length = 0; masters.clear(); singles.length = 0;
        continue;
      }
      throw e;
    }
    first = false;
    for (const item of j?.value ?? []) {
      const id = String(item.id ?? '');
      if (!id) continue;
      if (item['@removed']) {
        // Graph does not say which series a removed occurrence belonged to,
        // so a removal that is not a whole event is handled by re-fetching
        // whatever masters this page did name.
        removed.push(id);
        continue;
      }
      const type = String(item.type ?? 'singleInstance');
      if (type === 'seriesMaster') { masters.add(id); continue; }
      if (item.seriesMasterId) { masters.add(String(item.seriesMasterId)); continue; }
      singles.push(item);
    }
    const next: string | undefined = j?.['@odata.nextLink'];
    deltaLink = j?.['@odata.deltaLink'] ?? deltaLink;
    if (!next) break;
    url = next;
  }
  void first;

  for (const item of singles) {
    const ev = toVEvent(item);
    if (!ev) continue;
    changed.push({ id: String(item.id), ical: writeCalendar([ev]), etag: item['@odata.etag'] ?? null });
  }
  // A series is fetched whole — master plus its exceptions — so the stored
  // file carries the rule rather than a list of occurrences.
  for (const masterId of masters) {
    const got = await getSeries(auth, masterId).catch((e) => {
      if (e instanceof GraphError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    });
    if (got) changed.push({ id: masterId, ical: got.ical, etag: got.etag });
    else removed.push(masterId);
  }
  return { changed, removed, deltaLink, full };
}

/** A series master and its exceptions, as one iCalendar file. */
export async function getSeries(auth: GraphAuth, eventId: string): Promise<{ ical: string; etag: string | null } | null> {
  const item = await api(auth, `/me/events/${encodeURIComponent(eventId)}`);
  if (!item) return null;
  const master = toVEvent(item);
  if (!master) return null;
  const overrides: VEvent[] = [];
  if (item.recurrence) {
    // Exceptions are the instances whose type says they were changed or
    // cancelled; the rest are generated by the rule and need no row.
    const start = item.start?.dateTime ? new Date(`${item.start.dateTime}Z`) : new Date();
    const inst = await api(auth, `/me/events/${encodeURIComponent(eventId)}/instances`, {
      query: {
        startDateTime: new Date(start.getTime() - 86_400_000).toISOString(),
        endDateTime: new Date(start.getTime() + 550 * 86_400_000).toISOString(),
        $top: '250',
      },
    }).catch(() => null);
    for (const i of inst?.value ?? []) {
      const type = String(i.type ?? '');
      if (type !== 'exception') continue;
      const o = toVEvent(i);
      if (!o) continue;
      o.uid = master.uid;
      const orig = i.originalStart ? new Date(`${String(i.originalStart).replace(/Z?$/, '')}Z`) : null;
      if (orig && !Number.isNaN(orig.getTime())) o.recurrenceId = vtimeOf(orig);
      if (o.recurrenceId) overrides.push(o);
    }
  }
  return { ical: writeCalendar([master, ...overrides]), etag: item['@odata.etag'] ?? null };
}

// ---------- Conversion ----------

// Graph writes {dateTime: "2026-09-07T09:00:00.0000000", timeZone: "UTC"},
// where the dateTime carries no offset and the zone is beside it.
function timeOf(v: any, allDay: boolean): { at: Date; tzid: string | null } | null {
  if (!v?.dateTime) return null;
  const zone = usableZone(v.timeZone === 'tzone://Microsoft/Custom' ? null : v.timeZone);
  const raw = String(v.dateTime).replace(/(\.\d+)?Z?$/, '');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) {
    const at = new Date(v.dateTime);
    return Number.isNaN(at.getTime()) ? null : { at, tzid: zone };
  }
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (allDay || !zone || zone === 'UTC') return { at: new Date(asUtc), tzid: allDay ? null : zone };
  // The fields are a wall clock in `zone`; resolve them there.
  const off = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts: Record<string, number> = {};
  for (const p of off.formatToParts(new Date(asUtc))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return { at: new Date(asUtc - (shown - asUtc)), tzid: zone };
}

export function toVEvent(item: any): VEvent | null {
  const allDay = Boolean(item.isAllDay);
  const start = timeOf(item.start, allDay);
  if (!start) return null;
  const e = newEvent(String(item.iCalUId ?? item.iCalUid ?? item.id ?? ''));
  e.summary = item.subject ?? null;
  // Graph gives HTML unless asked otherwise; the plain text preview beside
  // it is the honest thing to store in a DESCRIPTION.
  e.description = item.bodyPreview ?? (item.body?.contentType === 'text' ? item.body?.content : null) ?? null;
  e.location = item.location?.displayName ?? null;
  e.url = item.webLink ?? null;
  e.status = item.isCancelled ? 'CANCELLED' : 'CONFIRMED';
  e.transparent = String(item.showAs ?? '') === 'free';
  e.start = vtimeOf(start.at, { allDay, tzid: start.tzid });
  const end = timeOf(item.end, allDay);
  if (end) e.end = vtimeOf(end.at, { allDay, tzid: end.tzid });
  if (item.organizer?.emailAddress?.address) {
    e.organizer = { email: String(item.organizer.emailAddress.address).toLowerCase(), name: item.organizer.emailAddress.name ?? null };
  }
  for (const a of item.attendees ?? []) {
    const email = a?.emailAddress?.address;
    if (!email) continue;
    e.attendees.push({
      email: String(email).toLowerCase(),
      name: a.emailAddress.name ?? null,
      role: a.type === 'optional' ? 'OPT-PARTICIPANT' : a.type === 'resource' ? 'NON-PARTICIPANT' : 'REQ-PARTICIPANT',
      partstat: ({ accepted: 'ACCEPTED', declined: 'DECLINED', tentativelyAccepted: 'TENTATIVE', notResponded: 'NEEDS-ACTION', none: 'NEEDS-ACTION' } as Record<string, string>)[String(a.status?.response ?? '')] ?? 'NEEDS-ACTION',
      rsvp: false,
      cutype: a.type === 'resource' ? 'RESOURCE' : null,
    });
  }
  if (item.recurrence) e.rrule = toRrule(item.recurrence);
  return e;
}

const GRAPH_DAYS: Record<string, string> = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' };
const INDEXES: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/** Graph's recurrence object as an RRULE. */
export function toRrule(rec: any): string | null {
  const p = rec?.pattern;
  const r = rec?.range;
  if (!p?.type) return null;
  const parts: string[] = [];
  const days = (p.daysOfWeek ?? []).map((d: string) => GRAPH_DAYS[String(d).toLowerCase()]).filter(Boolean);
  const interval = Math.max(1, Number(p.interval ?? 1) || 1);

  switch (String(p.type)) {
    case 'daily': parts.push('FREQ=DAILY'); break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      if (p.firstDayOfWeek) parts.push(`WKST=${GRAPH_DAYS[String(p.firstDayOfWeek).toLowerCase()] ?? 'MO'}`);
      break;
    case 'absoluteMonthly':
      parts.push('FREQ=MONTHLY', `BYMONTHDAY=${Number(p.dayOfMonth ?? 1)}`);
      break;
    case 'relativeMonthly': {
      parts.push('FREQ=MONTHLY');
      const nth = INDEXES[String(p.index ?? 'first').toLowerCase()] ?? 1;
      if (days.length) parts.push(`BYDAY=${days.map((d: string) => `${nth}${d}`).join(',')}`);
      break;
    }
    case 'absoluteYearly':
      parts.push('FREQ=YEARLY', `BYMONTH=${Number(p.month ?? 1)}`, `BYMONTHDAY=${Number(p.dayOfMonth ?? 1)}`);
      break;
    case 'relativeYearly': {
      parts.push('FREQ=YEARLY', `BYMONTH=${Number(p.month ?? 1)}`);
      const nth = INDEXES[String(p.index ?? 'first').toLowerCase()] ?? 1;
      if (days.length) parts.push(`BYDAY=${days.map((d: string) => `${nth}${d}`).join(',')}`);
      break;
    }
    default: return null;
  }
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (r?.type === 'numbered' && Number(r.numberOfOccurrences) > 0) parts.push(`COUNT=${Number(r.numberOfOccurrences)}`);
  else if (r?.type === 'endDate' && r.endDate) parts.push(`UNTIL=${String(r.endDate).replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

/** The other direction, for a write. Returns null when the rule is one Graph cannot express. */
export function fromRrule(rrule: string | null, startsAt: Date): Record<string, unknown> | null {
  if (!rrule) return null;
  const parts: Record<string, string> = {};
  for (const bit of rrule.replace(/^RRULE:/i, '').split(';')) {
    const eq = bit.indexOf('=');
    if (eq > 0) parts[bit.slice(0, eq).toUpperCase()] = bit.slice(eq + 1);
  }
  const back = Object.fromEntries(Object.entries(GRAPH_DAYS).map(([k, v]) => [v, k]));
  const byDay = (parts.BYDAY ?? '').split(',').map((d) => /^([+-]?\d)?(\w\w)$/.exec(d.trim())).filter(Boolean) as RegExpExecArray[];
  const days = byDay.map((m) => back[m[2].toUpperCase()]).filter(Boolean);
  const nth = byDay[0]?.[1] ? Number(byDay[0][1]) : null;
  const indexName = nth === -1 ? 'last' : (['', 'first', 'second', 'third', 'fourth'][nth ?? 0] || 'first');
  const interval = Number(parts.INTERVAL ?? 1) || 1;

  let pattern: Record<string, unknown> | null = null;
  switch ((parts.FREQ ?? '').toUpperCase()) {
    case 'DAILY': pattern = { type: 'daily', interval }; break;
    case 'WEEKLY':
      pattern = { type: 'weekly', interval, daysOfWeek: days.length ? days : [Object.values(GRAPH_DAYS)[startsAt.getUTCDay()] && back[Object.values(GRAPH_DAYS)[startsAt.getUTCDay()]]] };
      break;
    case 'MONTHLY':
      pattern = parts.BYMONTHDAY
        ? { type: 'absoluteMonthly', interval, dayOfMonth: Number(parts.BYMONTHDAY.split(',')[0]) }
        : days.length ? { type: 'relativeMonthly', interval, daysOfWeek: days, index: indexName } : null;
      break;
    case 'YEARLY':
      pattern = parts.BYMONTHDAY
        ? { type: 'absoluteYearly', interval, month: Number(parts.BYMONTH ?? startsAt.getUTCMonth() + 1), dayOfMonth: Number(parts.BYMONTHDAY.split(',')[0]) }
        : days.length ? { type: 'relativeYearly', interval, month: Number(parts.BYMONTH ?? startsAt.getUTCMonth() + 1), daysOfWeek: days, index: indexName } : null;
      break;
    default: return null;
  }
  if (!pattern) return null;

  const startDate = startsAt.toISOString().slice(0, 10);
  let range: Record<string, unknown> = { type: 'noEnd', startDate };
  if (parts.COUNT) range = { type: 'numbered', startDate, numberOfOccurrences: Number(parts.COUNT) };
  else if (parts.UNTIL) {
    const u = parts.UNTIL;
    range = { type: 'endDate', startDate, endDate: `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` };
  }
  return { pattern, range };
}

// ---------- Writing ----------

export function toGraph(e: VEvent): Record<string, unknown> {
  const time = (t: NonNullable<VEvent['start']>) => ({
    dateTime: t.at.toISOString().replace(/\.\d+Z$/, ''),
    timeZone: 'UTC',
  });
  return {
    subject: e.summary ?? '',
    body: e.description ? { contentType: 'text', content: e.description } : undefined,
    location: e.location ? { displayName: e.location } : undefined,
    start: e.start ? time(e.start) : undefined,
    end: e.end ? time(e.end) : e.start ? time(e.start) : undefined,
    isAllDay: e.start?.allDay ?? false,
    showAs: e.transparent ? 'free' : 'busy',
    recurrence: e.start ? fromRrule(e.rrule, e.start.at) ?? undefined : undefined,
    attendees: e.attendees.length
      ? e.attendees.map((a) => ({
        emailAddress: { address: a.email, name: a.name ?? undefined },
        type: a.role === 'OPT-PARTICIPANT' ? 'optional' : 'required',
      }))
      : undefined,
  };
}

export async function createEvent(auth: GraphAuth, calendarId: string, e: VEvent): Promise<{ id: string; etag: string | null }> {
  const j = await api(auth, `/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(toGraph(e)) });
  return { id: String(j.id), etag: j['@odata.etag'] ?? null };
}

export async function updateEvent(auth: GraphAuth, eventId: string, e: VEvent, etag?: string | null): Promise<{ etag: string | null; conflict: boolean }> {
  try {
    const j = await api(auth, `/me/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH', body: JSON.stringify(toGraph(e)),
      headers: etag ? { 'If-Match': etag } : {},
    });
    return { etag: j?.['@odata.etag'] ?? null, conflict: false };
  } catch (err) {
    if (err instanceof GraphError && err.status === 412) return { etag: null, conflict: true };
    throw err;
  }
}

export async function deleteEvent(auth: GraphAuth, eventId: string): Promise<void> {
  try {
    await api(auth, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (e) {
    if (e instanceof GraphError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

// ---------- Somebody else's free/busy ----------

// Graph's getSchedule returns a string of digit codes, one per interval:
// 0 free, 1 tentative, 2 busy, 3 out of office, 4 working elsewhere. The
// ones that mean "do not book me" are 2 and 3; tentative is deliberately
// treated as free, because a maybe should not block a proposal.
const BLOCKING = new Set(['2', '3']);

export async function freeBusy(auth: GraphAuth, emails: string[], from: Date, to: Date): Promise<Map<string, { from: number; to: number }[]>> {
  const out = new Map<string, { from: number; to: number }[]>();
  if (!emails.length) return out;
  const slotMinutes = 30;
  const j = await api(auth, '/me/calendar/getSchedule', {
    method: 'POST',
    body: JSON.stringify({
      schedules: emails.slice(0, 50),
      startTime: { dateTime: from.toISOString().replace(/\.\d+Z$/, ''), timeZone: 'UTC' },
      endTime: { dateTime: to.toISOString().replace(/\.\d+Z$/, ''), timeZone: 'UTC' },
      availabilityViewInterval: slotMinutes,
    }),
  });
  for (const entry of j?.value ?? []) {
    const email = String(entry?.scheduleId ?? '').toLowerCase();
    if (!email || entry?.error) continue;
    // Prefer the itemised list where Graph gives one; the digit string is
    // the fallback, and rounds everything to the interval.
    const items = entry?.scheduleItems;
    if (Array.isArray(items) && items.length) {
      out.set(email, items
        .filter((i: any) => BLOCKING.has(({ busy: '2', oof: '3', tentative: '1', free: '0', workingElsewhere: '4' } as Record<string, string>)[String(i?.status ?? 'busy')] ?? '2'))
        .map((i: any) => ({ from: new Date(`${String(i.start?.dateTime).replace(/Z?$/, '')}Z`).getTime(), to: new Date(`${String(i.end?.dateTime).replace(/Z?$/, '')}Z`).getTime() }))
        .filter((b: any) => Number.isFinite(b.from) && Number.isFinite(b.to)));
      continue;
    }
    const view = String(entry?.availabilityView ?? '');
    const blocks: { from: number; to: number }[] = [];
    for (let i = 0; i < view.length; i++) {
      if (!BLOCKING.has(view[i])) continue;
      const start = from.getTime() + i * slotMinutes * 60_000;
      const last = blocks[blocks.length - 1];
      if (last && last.to === start) last.to = start + slotMinutes * 60_000;
      else blocks.push({ from: start, to: start + slotMinutes * 60_000 });
    }
    out.set(email, blocks);
  }
  return out;
}

// ---------- Push ----------

export interface GraphSubscription { id: string; expiresAt: Date }

/**
 * A change notification for one calendar.
 *
 * Graph subscriptions are short-lived — three days at the outside for
 * calendars — and are renewed by the sweep. The notification carries no
 * event data, only that something moved, and `clientState` comes back with
 * it so a forged POST can be told apart from a real one.
 */
export async function subscribe(auth: GraphAuth, calendarId: string, opts: { address: string; clientState: string }): Promise<GraphSubscription | null> {
  try {
    const expiry = new Date(Date.now() + 2 * 86_400_000);
    const j = await api(auth, '/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        changeType: 'created,updated,deleted',
        notificationUrl: opts.address,
        resource: `/me/calendars/${calendarId}/events`,
        expirationDateTime: expiry.toISOString(),
        clientState: opts.clientState,
      }),
    });
    return { id: String(j.id), expiresAt: new Date(j.expirationDateTime ?? expiry) };
  } catch (e) {
    // Graph validates the callback synchronously; an install Microsoft
    // cannot reach simply keeps polling.
    log.info('graph declined a subscription; polling instead', { err: (e as Error).message });
    return null;
  }
}

export async function renew(auth: GraphAuth, subscriptionId: string): Promise<Date | null> {
  try {
    const expiry = new Date(Date.now() + 2 * 86_400_000);
    const j = await api(auth, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'PATCH', body: JSON.stringify({ expirationDateTime: expiry.toISOString() }),
    });
    return new Date(j?.expirationDateTime ?? expiry);
  } catch { return null; }
}

export async function unsubscribe(auth: GraphAuth, subscriptionId: string): Promise<void> {
  try { await api(auth, `/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' }); } catch { /* expires by itself */ }
}
