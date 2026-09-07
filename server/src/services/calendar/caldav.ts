// CalDAV (RFC 4791), which is how Apple, Fastmail, Nextcloud, Radicale,
// SOGo and every self-hosted server speak. Not Google's preferred path, and
// not available for Microsoft 365 at all — those two have their own files.
//
// The sequence is fixed by the standard and is worth naming, because a
// server that fails at one of these steps fails in a way the person has to
// be told about:
//
//   1. PROPFIND / for `current-user-principal` — who the credentials are
//   2. PROPFIND that principal for `calendar-home-set` — where their
//      collections live
//   3. PROPFIND the home set, depth 1 — the collections themselves
//   4. REPORT `sync-collection` per collection (RFC 6578) — what changed
//      since the last token, falling back to a ctag comparison and a full
//      listing on a server that does not support it
//
// Live updates: there is no push in CalDAV. Apple has a proprietary APNs
// extension nobody else implements, so this polls — but a sync-collection
// REPORT with a token is one small request that usually returns nothing, so
// polling it every minute costs about as much as a heartbeat.
import { assertPublicUrl } from '../../util/netguard.js';
import { logger } from '../../log.js';
import { childrenNamed, find, findAll, parseXml, textOf, xmlEscape, type XmlNode } from './xml.js';

const log = logger('caldav');

export interface DavAuth { username: string; password: string }

export interface DavCalendar {
  href: string;
  name: string;
  color: string | null;
  timezone: string | null;
  readOnly: boolean;
  ctag: string | null;
  syncToken: string | null;
}

export interface DavObject { href: string; etag: string | null; ical: string }

const TIMEOUT_MS = 30_000;
const MAX_BODY = 8 * 1024 * 1024;

export class DavError extends Error {
  constructor(message: string, readonly status: number, readonly auth = false) { super(message); }
}

// Every request out of here goes through the same door: the URL is checked
// against the outbound guard first, because a CalDAV address is typed by a
// member and would otherwise be a way to make this server fetch its own
// compose network.
async function dav(url: string, auth: DavAuth, init: {
  method: string; body?: string; headers?: Record<string, string>; depth?: string; allowPrivate?: boolean;
}): Promise<{ status: number; text: string; headers: Headers }> {
  const u = await assertPublicUrl(url, { what: 'That calendar server', allowPrivate: init.allowPrivate });
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
    'User-Agent': 'Tern/1.0 CalDAV',
    ...(init.depth ? { Depth: init.depth } : {}),
    ...(init.body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
    ...init.headers,
  };
  const res = await fetch(u, { method: init.method, headers, body: init.body, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) {
    throw new DavError(res.status === 401 ? 'The calendar server rejected those credentials' : 'The calendar server refused access', res.status, true);
  }
  // A reply larger than this is a server behaving badly or a collection far
  // beyond what this is for; either way it is not read into memory.
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new DavError('The calendar server sent more than this can read', 413);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new DavError('The calendar server sent more than this can read', 413);
  return { status: res.status, text, headers: res.headers };
}

// Hrefs come back as paths far more often than as absolute URLs.
export function resolveHref(base: string, href: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

const D = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';

/** Steps 1 and 2: from a server address to the collection home of these credentials. */
export async function discoverHome(baseUrl: string, auth: DavAuth, allowPrivate = false): Promise<string> {
  const principal = await propfind(baseUrl, auth, ['<d:current-user-principal/>'], '0', allowPrivate);
  let principalHref = '';
  for (const r of findAll(principal, 'response')) {
    const h = find(r, 'current-user-principal');
    const href = textOf(h, 'href');
    if (href) { principalHref = resolveHref(baseUrl, href); break; }
  }
  // A server that does not answer that (or an address that already is the
  // principal) is asked about the home set directly, which is what a URL
  // pasted from Fastmail's settings page usually is.
  const target = principalHref || baseUrl;
  const home = await propfind(target, auth, ['<c:calendar-home-set/>'], '0', allowPrivate);
  for (const r of findAll(home, 'response')) {
    const set = find(r, 'calendar-home-set');
    const href = textOf(set, 'href');
    if (href) return resolveHref(target, href);
  }
  // Some servers (and plenty of hand-typed URLs) point straight at the home
  // collection. Trying it is better than refusing.
  return target;
}

/** Step 3: the collections in a home set. */
export async function listCalendars(homeUrl: string, auth: DavAuth, allowPrivate = false): Promise<DavCalendar[]> {
  const doc = await propfind(homeUrl, auth, [
    '<d:resourcetype/>', '<d:displayname/>', '<d:current-user-privilege-set/>',
    '<cs:getctag/>', '<d:sync-token/>', '<ic:calendar-color/>',
    '<c:supported-calendar-component-set/>', '<c:calendar-timezone/>',
  ], '1', allowPrivate);

  const out: DavCalendar[] = [];
  for (const r of findAll(doc, 'response')) {
    const href = textOf(r, 'href');
    if (!href) continue;
    const propstats = findAll(r, 'propstat').filter((p) => /200/.test(textOf(p, 'status')));
    const props = propstats.map((p) => find(p, 'prop')).filter(Boolean) as XmlNode[];
    const prop = props[0];
    if (!prop) continue;
    const type = props.map((p) => find(p, 'resourcetype')).find(Boolean);
    if (!type || !childrenNamed(type, 'calendar').length) continue;

    // A collection that holds only tasks or notes is not a calendar for our
    // purposes, and drawing its rows as meetings would be wrong.
    const comps = props.map((p) => find(p, 'supported-calendar-component-set')).find(Boolean);
    if (comps) {
      const names = childrenNamed(comps, 'comp').map((c) => (c.attrs.name ?? '').toUpperCase());
      if (names.length && !names.includes('VEVENT')) continue;
    }

    const privileges = props.map((p) => find(p, 'current-user-privilege-set')).find(Boolean);
    // No privilege list at all means the server is not telling us, and
    // assuming read-only would make every such calendar uneditable. Assuming
    // writable is recoverable: the PUT fails and says so.
    const readOnly = privileges
      ? !findAll(privileges, 'privilege').some((p) => childrenNamed(p, 'write').length || childrenNamed(p, 'write-content').length || childrenNamed(p, 'all').length)
      : false;

    const colour = props.map((p) => find(p, 'calendar-color')?.text.trim()).find(Boolean) ?? null;
    out.push({
      href: resolveHref(homeUrl, href),
      name: props.map((p) => find(p, 'displayname')?.text.trim()).find(Boolean) || decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? 'Calendar'),
      // Apple writes #RRGGBBAA; the alpha is not useful here.
      color: colour ? colour.slice(0, 7) : null,
      timezone: zoneNameOf(props.map((p) => find(p, 'calendar-timezone')?.text).find(Boolean) ?? ''),
      readOnly,
      ctag: props.map((p) => find(p, 'getctag')?.text.trim()).find(Boolean) ?? null,
      syncToken: props.map((p) => find(p, 'sync-token')?.text.trim()).find(Boolean) ?? null,
    });
  }
  return out;
}

function zoneNameOf(vtimezone: string): string | null {
  const m = /^TZID:(.+)$/m.exec(String(vtimezone ?? ''));
  return m ? m[1].trim().slice(0, 64) : null;
}

async function propfind(url: string, auth: DavAuth, props: string[], depth: string, allowPrivate: boolean): Promise<XmlNode | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="${D}" xmlns:c="${CALDAV}" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>${props.join('')}</d:prop>
</d:propfind>`;
  const res = await dav(url, auth, { method: 'PROPFIND', body, depth, allowPrivate });
  if (res.status >= 400) throw new DavError(`The calendar server answered HTTP ${res.status}`, res.status);
  return parseXml(res.text);
}

export interface SyncResult {
  /** Objects that were added or changed. */
  changed: DavObject[];
  /** Hrefs the server says are gone. */
  removed: string[];
  syncToken: string | null;
  ctag: string | null;
  /** True when the server could not do an incremental sync and this is everything. */
  full: boolean;
}

/**
 * Step 4: what changed in one collection.
 *
 * With a token, a `sync-collection` REPORT returns only the differences and a
 * new token — the cheap path, and the one that makes a one-minute poll
 * reasonable. Without one, or against a server that does not implement RFC
 * 6578, it falls back to listing the collection's etags and fetching only the
 * objects whose etag it has not seen.
 */
export async function syncCalendar(calendarUrl: string, auth: DavAuth, opts: {
  syncToken?: string | null; knownEtags?: Map<string, string>; allowPrivate?: boolean; window?: { from: Date; to: Date };
} = {}): Promise<SyncResult> {
  const allowPrivate = Boolean(opts.allowPrivate);
  if (opts.syncToken) {
    try {
      return await syncCollection(calendarUrl, auth, opts.syncToken, allowPrivate);
    } catch (e) {
      if (e instanceof DavError && e.auth) throw e;
      // A token the server has forgotten (507, or a 403 with
      // valid-sync-token) means start again rather than never sync.
      log.debug('sync-collection failed; falling back to a listing', { err: (e as Error).message });
    }
  }
  try {
    return await syncCollection(calendarUrl, auth, null, allowPrivate);
  } catch (e) {
    if (e instanceof DavError && e.auth) throw e;
    return listAndFetch(calendarUrl, auth, opts.knownEtags ?? new Map(), allowPrivate, opts.window);
  }
}

async function syncCollection(calendarUrl: string, auth: DavAuth, token: string | null, allowPrivate: boolean): Promise<SyncResult> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="${D}">
  <d:sync-token>${token ? xmlEscape(token) : ''}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`;
  const res = await dav(calendarUrl, auth, { method: 'REPORT', body, depth: '1', allowPrivate });
  if (res.status >= 400) throw new DavError(`sync-collection answered HTTP ${res.status}`, res.status);
  const doc = parseXml(res.text);
  const newToken = textOf(doc, 'sync-token') || null;

  const wanted: string[] = [];
  const removed: string[] = [];
  for (const r of findAll(doc, 'response')) {
    const href = textOf(r, 'href');
    if (!href) continue;
    const status = textOf(r, 'status');
    // A 404 in the response body is the server saying "this one is gone".
    if (/40[14]/.test(status) && !findAll(r, 'propstat').length) { removed.push(resolveHref(calendarUrl, href)); continue; }
    if (href.replace(/\/$/, '') === new URL(calendarUrl).pathname.replace(/\/$/, '')) continue; // the collection itself
    wanted.push(resolveHref(calendarUrl, href));
  }
  const changed = wanted.length ? await multiget(calendarUrl, auth, wanted, allowPrivate) : [];
  return { changed, removed, syncToken: newToken, ctag: null, full: token === null };
}

// The compatibility path: ask for every object's etag, then fetch the bodies
// whose etag is new. A calendar-query with a time range keeps this from
// dragging down a decade of history on first contact.
async function listAndFetch(calendarUrl: string, auth: DavAuth, known: Map<string, string>, allowPrivate: boolean, window?: { from: Date; to: Date }): Promise<SyncResult> {
  const stamp = (d: Date) => `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const range = window ? `<c:time-range start="${stamp(window.from)}" end="${stamp(window.to)}"/>` : '';
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="${D}" xmlns:c="${CALDAV}">
  <d:prop><d:getetag/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">${range}</c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const res = await dav(calendarUrl, auth, { method: 'REPORT', body, depth: '1', allowPrivate });
  if (res.status >= 400) throw new DavError(`The calendar server answered HTTP ${res.status} to a listing`, res.status);
  const doc = parseXml(res.text);

  const seen = new Map<string, string>();
  for (const r of findAll(doc, 'response')) {
    const href = textOf(r, 'href');
    if (!href) continue;
    seen.set(resolveHref(calendarUrl, href), (find(r, 'getetag')?.text ?? '').trim());
  }
  const wanted = [...seen].filter(([href, etag]) => known.get(href) !== etag || !etag).map(([href]) => href);
  const changed = wanted.length ? await multiget(calendarUrl, auth, wanted, allowPrivate) : [];
  const removed = [...known.keys()].filter((h) => !seen.has(h));
  return { changed, removed, syncToken: null, ctag: null, full: true };
}

/** Fetch object bodies in batches, which is the whole point of calendar-multiget. */
export async function multiget(calendarUrl: string, auth: DavAuth, hrefs: string[], allowPrivate = false): Promise<DavObject[]> {
  const out: DavObject[] = [];
  const BATCH = 60;
  for (let i = 0; i < hrefs.length; i += BATCH) {
    const slice = hrefs.slice(i, i + BATCH);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="${D}" xmlns:c="${CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  ${slice.map((h) => `<d:href>${xmlEscape(new URL(h).pathname)}</d:href>`).join('\n  ')}
</c:calendar-multiget>`;
    const res = await dav(calendarUrl, auth, { method: 'REPORT', body, depth: '1', allowPrivate });
    if (res.status >= 400) throw new DavError(`calendar-multiget answered HTTP ${res.status}`, res.status);
    const doc = parseXml(res.text);
    for (const r of findAll(doc, 'response')) {
      const href = textOf(r, 'href');
      const ical = find(r, 'calendar-data')?.text ?? '';
      if (!href || !ical.includes('BEGIN:VEVENT')) continue;
      out.push({ href: resolveHref(calendarUrl, href), etag: (find(r, 'getetag')?.text ?? '').trim() || null, ical });
    }
  }
  return out;
}

// ---------- Writing ----------

/**
 * Create or replace one object.
 *
 * `If-Match` on an update is what keeps two clients from silently
 * overwriting each other: the server refuses with 412 when the object has
 * moved on, and the caller re-reads rather than clobbering. A create uses
 * `If-None-Match: *` so it cannot quietly overwrite an object that appeared
 * in between.
 */
export async function putObject(url: string, auth: DavAuth, ical: string, opts: { etag?: string | null; create?: boolean; allowPrivate?: boolean } = {}): Promise<{ etag: string | null; conflict: boolean }> {
  const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' };
  if (opts.create) headers['If-None-Match'] = '*';
  else if (opts.etag) headers['If-Match'] = opts.etag;
  const res = await dav(url, auth, { method: 'PUT', body: ical, headers, allowPrivate: opts.allowPrivate });
  if (res.status === 412 || res.status === 409) return { etag: null, conflict: true };
  if (res.status >= 400) throw new DavError(`The calendar server refused the change: HTTP ${res.status}`, res.status);
  // Plenty of servers do not return an etag on PUT; the next sync picks it up.
  return { etag: res.headers.get('etag'), conflict: false };
}

export async function deleteObject(url: string, auth: DavAuth, opts: { etag?: string | null; allowPrivate?: boolean } = {}): Promise<{ conflict: boolean }> {
  const headers: Record<string, string> = {};
  if (opts.etag) headers['If-Match'] = opts.etag;
  const res = await dav(url, auth, { method: 'DELETE', headers, allowPrivate: opts.allowPrivate });
  if (res.status === 412) return { conflict: true };
  // Already gone is the outcome that was wanted.
  if (res.status === 404 || res.status === 410) return { conflict: false };
  if (res.status >= 400) throw new DavError(`The calendar server refused the deletion: HTTP ${res.status}`, res.status);
  return { conflict: false };
}

/** Where a new object goes: the collection URL plus a filename of our choosing. */
export function objectUrlFor(calendarUrl: string, uid: string): string {
  const safe = uid.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || `tern-${Date.now()}`;
  return `${calendarUrl.replace(/\/+$/, '')}/${encodeURIComponent(safe)}.ics`;
}

/** A cheap "has anything changed at all" check, for servers with a ctag. */
export async function collectionTag(calendarUrl: string, auth: DavAuth, allowPrivate = false): Promise<{ ctag: string | null; syncToken: string | null }> {
  const doc = await propfind(calendarUrl, auth, ['<cs:getctag/>', '<d:sync-token/>'], '0', allowPrivate);
  return { ctag: textOf(doc, 'getctag') || null, syncToken: textOf(doc, 'sync-token') || null };
}

/** Whether these credentials work at all, used by the connect form. */
export async function checkAccess(baseUrl: string, auth: DavAuth, allowPrivate = false): Promise<{ home: string; calendars: DavCalendar[] }> {
  const home = await discoverHome(baseUrl, auth, allowPrivate);
  return { home, calendars: await listCalendars(home, auth, allowPrivate) };
}
