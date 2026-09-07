// VEVENT as a calendar needs it, rather than as an invitation card needs it.
//
// services/icalendar.ts already reads the `text/calendar` part of a message
// well enough to say what a meeting is and when. It deliberately throws away
// the parts only a calendar can use: the RRULE itself (it keeps a sentence
// describing one), EXDATE, RDATE, RECURRENCE-ID, TRANSP, and — the one that
// matters most — the TZID a time was written in, as opposed to the instant
// that time resolved to. A series cannot be expanded without the zone,
// because "every Monday at nine" is a wall clock rather than an interval.
//
// So this parses the same syntax into a fuller shape, reusing the line
// reader that already exists rather than writing a second one, and can write
// the shape back out for a server that expects to be handed iCalendar.
import { parseLine, unescapeText, unfold, mailtoOf, parseDuration, zoneOffsetMinutes, type IcalLine } from '../icalendar.js';
import { expandRrule, instantOf, parseRrule, utcToCivil, civilToUtc, type Civil, type Rrule } from './recurrence.js';

export interface VTime {
  /** The instant, once the zone was applied. */
  at: Date;
  /** Wall-clock fields exactly as written, which is what a series repeats on. */
  civil: Civil;
  /** The zone those fields are in; null for a UTC or floating time. */
  tzid: string | null;
  allDay: boolean;
}

export interface VAttendee {
  email: string;
  name: string | null;
  role: string | null;
  partstat: string | null;
  rsvp: boolean;
  cutype: string | null;
}

export interface VEvent {
  uid: string;
  /** Set on an override: which occurrence of the series this replaces. */
  recurrenceId: VTime | null;
  /** RANGE=THISANDFUTURE on the override, which truncates the master. */
  thisAndFuture: boolean;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: VAttendee[];
  start: VTime | null;
  end: VTime | null;
  /** Milliseconds, when the event carried a DURATION rather than a DTEND. */
  duration: number | null;
  rrule: string | null;
  exdates: Date[];
  rdates: Date[];
  status: string | null;
  /** OPAQUE blocks the time; TRANSPARENT does not. Free/busy turns on this. */
  transparent: boolean;
  sequence: number;
  created: Date | null;
  lastModified: Date | null;
  categories: string[];
  /**
   * Reminders, as minutes before the start. Only DISPLAY and AUDIO alarms
   * with a simple relative trigger are kept: an alarm that runs a program or
   * sends mail on somebody else's server is not something to carry around,
   * and an absolute trigger on a repeating event is meaningless.
   */
  alarms: number[];
  /** The time could not be resolved exactly and is a best guess. */
  approximate: boolean;
}

export interface VCalendar {
  method: string;
  prodId: string | null;
  events: VEvent[];
}

// ---------- Zones ----------

// A file's own VTIMEZONE blocks, kept as a name the platform can use where
// it recognises one. Where it does not — a Microsoft-invented name like
// "Romance Standard Time" — the block's own offset stands in, which is right
// for the near future and drifts only across a rule change.
interface ZoneTable { known: Set<string>; fallback: Map<string, number> }

function zoneTable(lines: IcalLine[]): ZoneTable {
  const known = new Set<string>();
  const fallback = new Map<string, number>();
  let tzid: string | null = null;
  let offset: number | null = null;
  let depth = 0;
  for (const l of lines) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VTIMEZONE') { depth = 1; tzid = null; offset = null; continue; }
    if (!depth) continue;
    if (l.name === 'END' && l.value.toUpperCase() === 'VTIMEZONE') {
      if (tzid) {
        if (zoneOffsetMinutes(tzid, new Date()) !== null) known.add(tzid);
        else if (offset !== null) fallback.set(tzid, offset);
      }
      depth = 0; tzid = null; offset = null;
      continue;
    }
    if (l.name === 'TZID' && !tzid) tzid = l.value.trim();
    if (l.name === 'TZOFFSETTO') {
      const m = /^([+-])(\d{2})(\d{2})/.exec(l.value.trim());
      // The last observance in the block wins, which is the current one in
      // every file that lists them in order.
      if (m) offset = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
    }
  }
  return { known, fallback };
}

// A zone name this platform can actually use, or null.
export function usableZone(tzid: string | null | undefined, zones?: ZoneTable): string | null {
  if (!tzid) return null;
  const t = tzid.trim();
  if (!t) return null;
  if (zoneOffsetMinutes(t, new Date()) !== null) return t;
  // Windows zone names arrive from Exchange and from older Outlook clients.
  const win = WINDOWS_ZONES[t.toLowerCase()];
  if (win && zoneOffsetMinutes(win, new Date()) !== null) return win;
  if (zones?.fallback.has(t)) return null; // handled by the fixed offset instead
  return null;
}

// The handful of Windows zone names common enough in real mail to be worth
// translating. Anything else falls back to the file's own VTIMEZONE offset,
// which is what the sending client believed at the time.
const WINDOWS_ZONES: Record<string, string> = {
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'russian standard time': 'Europe/Moscow',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  'atlantic standard time': 'America/Halifax',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'singapore standard time': 'Asia/Singapore',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'utc': 'UTC',
};

// ---------- Times ----------

export function parseVTime(value: string, params: Record<string, string>, zones: ZoneTable): VTime | null {
  const v = String(value ?? '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const civil: Civil = { y: +m[1], m: +m[2], d: +m[3], hh: 0, mm: 0, ss: 0 };
    // An all-day date has no zone by definition: it is the same day
    // everywhere, and anchoring it to one is how a birthday ends up on the
    // day before for half the world.
    return { at: new Date(civilToUtc(civil)), civil, tzid: null, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const civil: Civil = { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +m[6] };
  if (m[7]) return { at: new Date(civilToUtc(civil)), civil, tzid: null, allDay: false };
  const raw = params.TZID ?? null;
  const zone = usableZone(raw, zones);
  if (zone) return { at: new Date(instantOf(civil, zone)), civil, tzid: zone, allDay: false };
  if (raw && zones.fallback.has(raw)) {
    return { at: new Date(civilToUtc(civil) - zones.fallback.get(raw)! * 60_000), civil, tzid: null, allDay: false };
  }
  // Floating: legitimately "whatever the local clock says". Treated as UTC,
  // which is the only thing a server can do, and marked so callers know.
  return { at: new Date(civilToUtc(civil)), civil, tzid: null, allDay: false };
}

// A list-valued date property (EXDATE, RDATE), which may carry several
// values on one line and its own TZID.
function parseDateList(l: IcalLine, zones: ZoneTable): Date[] {
  const out: Date[] = [];
  for (const bit of l.value.split(',')) {
    // RDATE;VALUE=PERIOD carries "start/end" or "start/duration"; the start
    // is the occurrence, which is all an expansion needs.
    const t = parseVTime(bit.split('/')[0], l.params, zones);
    if (t) out.push(t.at);
  }
  return out;
}

// ---------- Parsing ----------

const empty = (uid: string): VEvent => ({
  uid, recurrenceId: null, thisAndFuture: false, summary: null, description: null, location: null, url: null,
  organizer: null, attendees: [], start: null, end: null, duration: null, rrule: null, exdates: [], rdates: [],
  status: null, transparent: false, sequence: 0, created: null, lastModified: null, categories: [], alarms: [], approximate: false,
});

export function parseCalendar(text: string): VCalendar {
  const lines = unfold(text).map(parseLine).filter(Boolean) as IcalLine[];
  const zones = zoneTable(lines);
  const out: VCalendar = { method: 'PUBLISH', prodId: null, events: [] };
  let cur: VEvent | null = null;
  // Anything inside a VALARM or a VTIMEZONE belongs to that component, not to
  // the event around it; its DTSTART is not the meeting's.
  let skipping = 0;
  let inAlarm = false;
  let alarmAction: string | null = null;

  for (const l of lines) {
    const value = l.value.trim();
    if (l.name === 'BEGIN') {
      const kind = value.toUpperCase();
      if (kind === 'VEVENT') { cur = empty(''); continue; }
      if (kind === 'VALARM' && cur) inAlarm = true;
      if (cur || kind === 'VTIMEZONE' || kind === 'VALARM') skipping++;
      continue;
    }
    if (l.name === 'END') {
      const kind = value.toUpperCase();
      if (kind === 'VEVENT') {
        if (cur && (cur.uid || cur.start)) out.events.push(cur);
        cur = null;
        continue;
      }
      if (kind === 'VALARM') { inAlarm = false; alarmAction = null; }
      if (skipping) skipping--;
      continue;
    }
    // Inside a VALARM: everything is skipped except the one thing worth
    // keeping, which is when it goes off.
    if (inAlarm && cur) {
      if (l.name === 'ACTION') alarmAction = value.toUpperCase();
      else if (l.name === 'TRIGGER' && (l.params.VALUE ?? 'DURATION').toUpperCase() === 'DURATION') {
        const ms = parseDuration(value);
        // Only alarms that fire before the event, and only the kinds that
        // amount to "tell the person": an EMAIL or PROCEDURE alarm is
        // somebody else's automation and is left where it was found.
        if (ms !== null && ms <= 0 && (alarmAction === null || alarmAction === 'DISPLAY' || alarmAction === 'AUDIO')) {
          const minutes = Math.round(-ms / 60_000);
          if (minutes <= 60 * 24 * 14 && !cur.alarms.includes(minutes)) cur.alarms.push(minutes);
        }
      }
      continue;
    }
    if (skipping) continue;
    if (!cur) {
      if (l.name === 'METHOD') out.method = value.toUpperCase() || 'PUBLISH';
      else if (l.name === 'PRODID') out.prodId = value.slice(0, 200);
      continue;
    }
    switch (l.name) {
      case 'UID': cur.uid = value.slice(0, 500); break;
      case 'SUMMARY': cur.summary = unescapeText(l.value).slice(0, 1000) || null; break;
      case 'DESCRIPTION': cur.description = unescapeText(l.value).slice(0, 20000) || null; break;
      case 'LOCATION': cur.location = unescapeText(l.value).slice(0, 1000) || null; break;
      case 'URL': cur.url = value.slice(0, 2000) || null; break;
      case 'STATUS': cur.status = value.toUpperCase() || null; break;
      case 'TRANSP': cur.transparent = value.toUpperCase() === 'TRANSPARENT'; break;
      case 'SEQUENCE': cur.sequence = Number.parseInt(value, 10) || 0; break;
      case 'CATEGORIES': cur.categories = l.value.split(',').map((c) => unescapeText(c)).filter(Boolean).slice(0, 20); break;
      case 'RRULE': cur.rrule = value.slice(0, 1000) || null; break;
      case 'EXDATE': cur.exdates.push(...parseDateList(l, zones)); break;
      case 'RDATE': cur.rdates.push(...parseDateList(l, zones)); break;
      case 'CREATED': cur.created = parseVTime(value, l.params, zones)?.at ?? null; break;
      case 'LAST-MODIFIED': cur.lastModified = parseVTime(value, l.params, zones)?.at ?? null; break;
      case 'RECURRENCE-ID': {
        cur.recurrenceId = parseVTime(value, l.params, zones);
        cur.thisAndFuture = (l.params.RANGE ?? '').toUpperCase() === 'THISANDFUTURE';
        break;
      }
      case 'ORGANIZER': {
        const email = mailtoOf(l.value);
        if (email) cur.organizer = { email, name: l.params.CN ? unescapeText(l.params.CN) : null };
        break;
      }
      case 'ATTENDEE': {
        const email = mailtoOf(l.value);
        if (email && cur.attendees.length < 200) {
          cur.attendees.push({
            email, name: l.params.CN ? unescapeText(l.params.CN) : null,
            role: l.params.ROLE ?? null, partstat: l.params.PARTSTAT ?? null,
            rsvp: (l.params.RSVP ?? '').toUpperCase() === 'TRUE',
            cutype: l.params.CUTYPE ?? null,
          });
        }
        break;
      }
      case 'DTSTART': {
        cur.start = parseVTime(value, l.params, zones);
        if (cur.start && !cur.start.allDay && !cur.start.tzid && !/Z$/.test(value) && !l.params.TZID) cur.approximate = true;
        break;
      }
      case 'DTEND': cur.end = parseVTime(value, l.params, zones); break;
      case 'DURATION': cur.duration = parseDuration(value); break;
    }
  }
  if (cur && (cur.uid || cur.start)) out.events.push(cur);
  // An event with no UID cannot be stored or matched to an override; giving
  // it one derived from its own contents is better than dropping it, because
  // plenty of hand-written files omit it.
  for (const e of out.events) {
    if (!e.uid) e.uid = `tern-${Buffer.from(`${e.summary ?? ''}|${e.start?.at.toISOString() ?? ''}`).toString('base64url').slice(0, 60)}`;
  }
  return out;
}

// ---------- The shape of one occurrence ----------

export interface Occurrence {
  start: Date;
  end: Date;
  allDay: boolean;
  /** Which occurrence of the series this is; null for a non-recurring event. */
  recurrenceId: Date | null;
  /** The override that replaced this occurrence, when one did. */
  override: VEvent | null;
}

// How long an event lasts, from whichever of DTEND and DURATION it carried.
// An event with neither is an hour if it has a time and a day if it does not,
// which is what RFC 5545 says and what every client shows.
export function durationOf(e: VEvent): number {
  if (e.duration !== null) return e.duration;
  if (e.start && e.end) return Math.max(0, e.end.at.getTime() - e.start.at.getTime());
  if (e.start?.allDay) return 86_400_000;
  return 3_600_000;
}

/**
 * Every occurrence of one event in a window, with its overrides applied.
 *
 * `master` is the VEVENT with no RECURRENCE-ID; `overrides` are the ones
 * with. A cancelled override removes its occurrence rather than replacing
 * it, which is how a single meeting in a series is called off.
 */
export function expandEvent(master: VEvent, overrides: VEvent[], from: Date, to: Date, limit = 750): Occurrence[] {
  if (!master.start) return [];
  const length = durationOf(master);
  const out: Occurrence[] = [];

  // An override keyed by the occurrence it replaces.
  const byRecurrence = new Map<number, VEvent>();
  for (const o of overrides) if (o.recurrenceId) byRecurrence.set(o.recurrenceId.at.getTime(), o);

  // THISANDFUTURE truncates the series at that point; everything from there
  // is described by the override instead.
  const truncateAt = overrides.filter((o) => o.thisAndFuture && o.recurrenceId).map((o) => o.recurrenceId!.at.getTime()).sort((a, b) => a - b)[0];

  const push = (startMs: number, recurrenceId: Date | null) => {
    const override = recurrenceId ? byRecurrence.get(recurrenceId.getTime()) ?? null : null;
    if (override) {
      if ((override.status ?? '').toUpperCase() === 'CANCELLED') return;
      const s = override.start?.at ?? new Date(startMs);
      out.push({ start: s, end: new Date(s.getTime() + durationOf(override)), allDay: override.start?.allDay ?? master.start!.allDay, recurrenceId, override });
      return;
    }
    out.push({ start: new Date(startMs), end: new Date(startMs + length), allDay: master.start!.allDay, recurrenceId, override: null });
  };

  if (!master.rrule && !master.rdates.length) {
    const s = master.start.at.getTime();
    // A single event is in the window when it overlaps it, not when it
    // starts in it: a week-long booking must show on the Wednesday.
    if (s + length > from.getTime() && s < to.getTime()) push(s, null);
    return out;
  }

  const rule: Rrule | null = master.rrule ? parseRrule(master.rrule) : null;
  const starts = rule
    ? expandRrule(rule, master.start.civil, {
      tzid: master.start.tzid,
      // Reach back by the event's own length so a long occurrence that
      // began before the window still appears in it.
      from: new Date(from.getTime() - Math.min(length, 40 * 86_400_000)),
      to,
      limit,
      exdates: master.exdates,
      rdates: master.rdates,
    })
    : [...master.rdates, master.start.at].sort((a, b) => a.getTime() - b.getTime());

  const exset = new Set(master.exdates.map((d) => d.getTime()));
  for (const s of starts) {
    const ms = s.getTime();
    if (exset.has(ms)) continue;
    if (truncateAt !== undefined && ms > truncateAt) break;
    if (ms + length <= from.getTime() || ms >= to.getTime()) continue;
    push(ms, s);
    if (out.length >= limit) break;
  }

  // Overrides that were moved out of their original slot and into the window.
  for (const o of overrides) {
    if (!o.recurrenceId || !o.start) continue;
    if ((o.status ?? '').toUpperCase() === 'CANCELLED') continue;
    const ms = o.start.at.getTime();
    if (ms + durationOf(o) <= from.getTime() || ms >= to.getTime()) continue;
    if (out.some((x) => x.recurrenceId?.getTime() === o.recurrenceId!.at.getTime())) continue;
    out.push({ start: o.start.at, end: new Date(ms + durationOf(o)), allDay: o.start.allDay, recurrenceId: o.recurrenceId.at, override: o });
  }

  return out.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, limit);
}

// ---------- Editing a series ----------

/**
 * The same rule, ending just before `at`.
 *
 * Used to split a series: "change this and every later one" truncates the
 * original here and starts a new one from `at`. Any COUNT is dropped,
 * because a count that survived the split would be counted twice.
 */
export function ruleUntil(rrule: string, at: Date): string {
  const parts = rrule.replace(/^RRULE:/i, '').split(';').filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p));
  // One second before the occurrence, so the occurrence itself belongs to
  // whatever replaces it rather than to both halves.
  const until = new Date(at.getTime() - 1000).toISOString().slice(0, 19).replace(/[-:]/g, '');
  parts.push(`UNTIL=${until}Z`);
  return parts.join(';');
}

/**
 * The same rule, with its COUNT reduced by the occurrences that stayed
 * behind.
 *
 * Splitting a counted series is where this matters: "five daily meetings,
 * change the third onwards" leaves two on the original and must leave three
 * on the new one. Carrying the original COUNT across would produce five more
 * — seven meetings out of a series of five, which is exactly the shape of
 * the bug this exists to stop.
 */
export function ruleAfterSplit(rrule: string, kept: number): string {
  const parts = rrule.replace(/^RRULE:/i, '').split(';').filter(Boolean);
  const i = parts.findIndex((p) => /^COUNT=/i.test(p));
  if (i < 0) return parts.join(';'); // UNTIL, or endless: both carry over as they are
  const total = Number.parseInt(parts[i].slice(6), 10);
  if (!Number.isFinite(total)) return parts.join(';');
  const left = Math.max(1, total - Math.max(0, kept));
  parts[i] = `COUNT=${left}`;
  return parts.join(';');
}

/** Whether a rule would still produce anything at or after `at`. */
export function ruleEndsBefore(rrule: string | null, at: Date): boolean {
  if (!rrule) return true;
  const m = /UNTIL=(\d{8})(?:T(\d{6})Z?)?/i.exec(rrule);
  if (!m) return false;
  const until = new Date(Date.UTC(
    +m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8),
    +(m[2]?.slice(0, 2) ?? 23), +(m[2]?.slice(2, 4) ?? 59), +(m[2]?.slice(4, 6) ?? 59),
  ));
  return until.getTime() < at.getTime();
}

/**
 * The override for one occurrence of a series, created if it is not there.
 *
 * An override is a second VEVENT with the same UID and a RECURRENCE-ID
 * naming the occurrence it replaces. It inherits everything from the master
 * that it does not state itself, which is why a new one is seeded from the
 * master rather than left blank: a client reading only the override has to
 * see a complete event.
 */
export function overrideFor(master: VEvent, overrides: VEvent[], occurrence: Date): VEvent {
  const existing = overrides.find((o) => o.recurrenceId && o.recurrenceId.at.getTime() === occurrence.getTime());
  if (existing) return existing;
  const allDay = master.start?.allDay ?? false;
  const length = durationOf(master);
  const made = newEvent(master.uid);
  made.recurrenceId = vtimeOf(occurrence, { allDay, tzid: master.start?.tzid });
  made.summary = master.summary;
  made.description = master.description;
  made.location = master.location;
  made.organizer = master.organizer;
  made.attendees = master.attendees.map((a) => ({ ...a }));
  made.transparent = master.transparent;
  made.alarms = [...master.alarms];
  made.status = master.status;
  made.sequence = master.sequence;
  made.start = vtimeOf(occurrence, { allDay, tzid: master.start?.tzid });
  made.end = vtimeOf(new Date(occurrence.getTime() + length), { allDay, tzid: master.start?.tzid });
  overrides.push(made);
  return made;
}

// ---------- Writing ----------

const esc = (v: string) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Content lines are folded at 75 octets. Folding by characters would split a
// multi-byte one down the middle, so this counts bytes and breaks between
// whole code points.
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    // 74 on continuations, because the leading space counts toward the 75.
    if (curBytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += n;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

export function icalStamp(d: Date, allDay = false): string {
  const s = d.toISOString();
  return allDay ? s.slice(0, 10).replace(/-/g, '') : `${s.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export interface WriteOptions { method?: string; prodId?: string }

// One VCALENDAR carrying these events.
//
// Times go out as UTC instants rather than in a named zone, with the
// VTIMEZONE that would otherwise be required. That is legal, unambiguous and
// what every server accepts; the cost is that a server showing the raw file
// displays "Z" times, which no user ever sees. A recurring event keeps its
// RRULE, so the series still repeats on the wall clock of whoever reads it.
export function writeCalendar(events: VEvent[], opts: WriteOptions = {}): string {
  const lines: (string | null)[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${opts.prodId ?? '-//Tern//Calendar//EN'}`,
    'CALSCALE:GREGORIAN',
    opts.method ? `METHOD:${opts.method}` : null,
  ];
  for (const e of events) {
    const allDay = e.start?.allDay ?? false;
    const dateParam = allDay ? ';VALUE=DATE' : '';
    lines.push(
      'BEGIN:VEVENT',
      `UID:${esc(e.uid)}`,
      `DTSTAMP:${icalStamp(new Date())}`,
      e.start ? `DTSTART${dateParam}:${icalStamp(e.start.at, allDay)}` : null,
      e.end ? `DTEND${dateParam}:${icalStamp(e.end.at, allDay)}` : null,
      !e.end && e.duration !== null ? `DURATION:PT${Math.round(e.duration / 1000)}S` : null,
      e.recurrenceId ? `RECURRENCE-ID${e.recurrenceId.allDay ? ';VALUE=DATE' : ''}${e.thisAndFuture ? ';RANGE=THISANDFUTURE' : ''}:${icalStamp(e.recurrenceId.at, e.recurrenceId.allDay)}` : null,
      e.summary ? `SUMMARY:${esc(e.summary)}` : null,
      e.description ? `DESCRIPTION:${esc(e.description)}` : null,
      e.location ? `LOCATION:${esc(e.location)}` : null,
      e.url ? `URL:${esc(e.url)}` : null,
      e.rrule ? `RRULE:${e.rrule.replace(/^RRULE:/i, '')}` : null,
      e.exdates.length ? `EXDATE:${e.exdates.map((d) => icalStamp(d, allDay)).join(',')}` : null,
      e.rdates.length ? `RDATE:${e.rdates.map((d) => icalStamp(d, allDay)).join(',')}` : null,
      e.status ? `STATUS:${e.status.toUpperCase()}` : null,
      `TRANSP:${e.transparent ? 'TRANSPARENT' : 'OPAQUE'}`,
      `SEQUENCE:${e.sequence}`,
      e.categories.length ? `CATEGORIES:${e.categories.map(esc).join(',')}` : null,
      e.organizer ? `ORGANIZER${e.organizer.name ? `;CN=${esc(e.organizer.name)}` : ''}:mailto:${e.organizer.email}` : null,
      ...e.attendees.map((a) => `ATTENDEE${a.name ? `;CN=${esc(a.name)}` : ''}${a.role ? `;ROLE=${a.role}` : ''}${a.partstat ? `;PARTSTAT=${a.partstat}` : ''}${a.rsvp ? ';RSVP=TRUE' : ''}:mailto:${a.email}`),
      // A reminder, written as the DISPLAY alarm every client understands.
      // Negative minutes are before the start, which is the only direction
      // anybody sets one in.
      ...(e.alarms.length
        ? e.alarms.slice(0, 5).flatMap((minutes) => [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `TRIGGER:-PT${Math.max(0, Math.round(minutes))}M`,
          `DESCRIPTION:${esc(e.summary ?? 'Reminder')}`,
          'END:VALARM',
        ])
        : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return (lines.filter(Boolean) as string[]).map(foldLine).join('\r\n');
}

// A blank event to build on, so callers do not have to name every field.
export function newEvent(uid: string): VEvent { return empty(uid); }

// A time as the writer wants it, from an instant plus an optional zone.
export function vtimeOf(at: Date, opts: { allDay?: boolean; tzid?: string | null } = {}): VTime {
  const tzid = usableZone(opts.tzid ?? null);
  const civil = tzid
    ? utcToCivil(at.getTime() + (zoneOffsetMinutes(tzid, at) ?? 0) * 60_000)
    : utcToCivil(at.getTime());
  return { at, civil, tzid, allDay: Boolean(opts.allDay) };
}
