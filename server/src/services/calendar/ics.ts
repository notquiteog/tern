// A subscribed ICS URL: the lowest common denominator, and the one that
// works for everything else.
//
// Proton, a colleague's "secret address" from Google, a room booking system,
// a football fixture list, the public holidays of a country — all of these
// are published as one iCalendar file behind a URL. There is no protocol
// here worth the name: fetch it, parse it, replace what was there. It is
// read-only by definition, and it is never live — a publisher decides how
// stale it is allowed to be, and fifteen minutes to a day is normal.
//
// What makes it cheap enough to poll often anyway is conditional fetching:
// an ETag or a Last-Modified turns almost every poll into a 304 with no body.
import { assertPublicUrl } from '../../util/netguard.js';
import { parseCalendar, writeCalendar, type VEvent } from './vevent.js';

const MAX_BYTES = 12 * 1024 * 1024;

export interface IcsResult {
  /** Null when the server said "not modified" and there is nothing to do. */
  objects: { uid: string; ical: string }[] | null;
  etag: string | null;
  lastModified: string | null;
  name: string | null;
  timezone: string | null;
  color: string | null;
}

export async function fetchIcs(url: string, opts: { etag?: string | null; lastModified?: string | null; allowPrivate?: boolean } = {}): Promise<IcsResult> {
  const u = await assertPublicUrl(url, { what: 'That calendar address', allowPrivate: opts.allowPrivate });
  // webcal:// is the same thing with a scheme browsers understand; it is
  // pasted often enough to be worth accepting.
  if (u.protocol === 'webcal:') u.protocol = 'https:';
  const headers: Record<string, string> = { Accept: 'text/calendar, text/plain;q=0.5', 'User-Agent': 'Tern/1.0' };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

  const res = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
  if (res.status === 304) {
    return { objects: null, etag: opts.etag ?? null, lastModified: opts.lastModified ?? null, name: null, timezone: null, color: null };
  }
  if (!res.ok) throw new Error(`That calendar address answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('That calendar file is larger than this server will read');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('That calendar file is larger than this server will read');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address did not return a calendar file');

  return {
    objects: groupByUid(text),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    // The non-standard properties every publisher uses anyway, so a
    // subscribed calendar arrives with its own name rather than the URL.
    name: /^X-WR-CALNAME:(.+)$/im.exec(text)?.[1]?.trim().slice(0, 200) ?? null,
    timezone: /^X-WR-TIMEZONE:(.+)$/im.exec(text)?.[1]?.trim().slice(0, 64) ?? null,
    color: /^X-APPLE-CALENDAR-COLOR:(.+)$/im.exec(text)?.[1]?.trim().slice(0, 9) ?? null,
  };
}

/**
 * One file holding hundreds of events becomes one object per UID, so it is
 * stored exactly like a CalDAV collection and read by the same code — masters
 * and their overrides staying together in one file, as they must.
 */
export function groupByUid(text: string): { uid: string; ical: string }[] {
  const parsed = parseCalendar(text);
  const groups = new Map<string, VEvent[]>();
  for (const e of parsed.events) {
    const list = groups.get(e.uid) ?? [];
    list.push(e);
    groups.set(e.uid, list);
  }
  const out: { uid: string; ical: string }[] = [];
  for (const [uid, events] of groups) {
    const master = events.find((e) => !e.recurrenceId);
    const overrides = events.filter((e) => e.recurrenceId);
    if (!master) continue;
    out.push({ uid, ical: writeCalendar([master, ...overrides], { prodId: parsed.prodId ?? undefined }) });
  }
  return out;
}
