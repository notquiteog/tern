// F10, the parsing half: iCalendar (RFC 5545) as it actually arrives in
// mail, which is to say folded, escaped, in mixed time zones, and sometimes
// slightly wrong.
//
// This reads invitations; it does not implement a calendar. Recurrence is
// parsed only far enough to say "repeats weekly" in a sentence, because a
// full RRULE expansion is a fortnight of work and the question in front of
// somebody reading their mail is "is this a real invitation, when is it, and
// do I want it".
//
// Time zones: a floating or TZID-qualified time is anchored using the
// VTIMEZONE offsets in the same file when they are there, and otherwise
// treated as UTC with `approximate` set, so nothing downstream shows a time
// it cannot stand behind.
export interface IcalAttendee { email: string; name: string | null; role: string | null; partstat: string | null }

export interface IcalEvent {
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: IcalAttendee[];
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  sequence: number;
  status: string | null;
  recurrence: string | null;
  /** The time could not be resolved exactly; it is the best available guess. */
  approximate: boolean;
}

export interface IcalDocument { method: string; events: IcalEvent[] }

// ---------- Lines ----------

// Content lines are folded at 75 octets with a leading space or tab on the
// continuation. Unfolding has to happen before anything else, or a long
// summary arrives in pieces.
export function unfold(text: string): string[] {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter((l) => l.trim().length);
}

export interface IcalLine { name: string; params: Record<string, string>; value: string }

export function parseLine(line: string): IcalLine | null {
  // NAME;PARAM=value;PARAM="quoted:value":VALUE — the colon that ends the
  // name and parameters is the first one outside quotes.
  let colon = -1, inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = splitOutsideQuotes(head, ';');
  const name = (parts.shift() ?? '').toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', inQuotes = false;
  for (const c of s) {
    if (c === '"') { inQuotes = !inQuotes; cur += c; continue; }
    if (c === sep && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// TEXT values escape commas, semicolons, backslashes and newlines.
export function unescapeText(v: string): string {
  return String(v ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

// ---------- Times ----------

// DATE (20260908) or DATE-TIME (20260908T140000, optionally Z-suffixed).
export function parseIcalDate(value: string, params: Record<string, string>, offsets: Map<string, number>): { at: Date | null; allDay: boolean; approximate: boolean } {
  const v = String(value ?? '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return { at: null, allDay: true, approximate: true };
    return { at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), allDay: true, approximate: false };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return { at: null, allDay: false, approximate: true };
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) return { at: new Date(utc), allDay: false, approximate: false };
  const tzid = params.TZID;
  if (tzid) {
    const offset = offsets.get(tzid);
    if (offset !== undefined) return { at: new Date(utc - offset * 60_000), allDay: false, approximate: false };
    // A named zone with no VTIMEZONE block. Node knows most of them.
    const guessed = zoneOffsetMinutes(tzid, new Date(utc));
    if (guessed !== null) return { at: new Date(utc - guessed * 60_000), allDay: false, approximate: false };
  }
  // Floating time: legitimately means "whatever the local clock says", which
  // the server cannot know. Treated as UTC and flagged.
  return { at: new Date(utc), allDay: false, approximate: true };
}

// What a named zone's offset is at a given instant, using the platform's own
// time zone database rather than a table that would go stale.
export function zoneOffsetMinutes(tzid: string, at: Date): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null; // not a zone this platform knows
  }
}

// The offsets a file declares for its own zones. Only the currently active
// observance is taken: an invitation is about one moment, and picking the
// standard or daylight rule by comparing DTSTARTs is close enough for a
// meeting three weeks out.
function timezoneOffsets(lines: IcalLine[]): Map<string, number> {
  const out = new Map<string, number>();
  let tzid: string | null = null;
  let best: { at: number; offset: number } | null = null;
  const now = Date.now();
  for (const l of lines) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VTIMEZONE') { tzid = null; best = null; continue; }
    if (l.name === 'END' && l.value.toUpperCase() === 'VTIMEZONE') {
      if (tzid && best) out.set(tzid, best.offset);
      tzid = null; best = null; continue;
    }
    if (l.name === 'TZID' && !tzid) { tzid = l.value.trim(); continue; }
    if (l.name === 'TZOFFSETTO' && tzid) {
      const m = /^([+-])(\d{2})(\d{2})/.exec(l.value.trim());
      if (!m) continue;
      const offset = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
      // Prefer the observance whose DTSTART is most recently in the past.
      const at = best?.at ?? 0;
      if (!best || at <= now) best = { at: now, offset };
    }
  }
  return out;
}

// ---------- Documents ----------

export function parseIcalendar(text: string): IcalDocument {
  const lines = unfold(text).map(parseLine).filter(Boolean) as IcalLine[];
  const offsets = timezoneOffsets(lines);
  let method = 'PUBLISH';
  const events: IcalEvent[] = [];
  let cur: IcalEvent | null = null;
  let depth = 0;

  for (const l of lines) {
    if (l.name === 'BEGIN') {
      depth++;
      if (l.value.toUpperCase() === 'VEVENT') {
        cur = { uid: null, summary: null, description: null, location: null, organizer: null, attendees: [], start: null, end: null, allDay: false, sequence: 0, status: null, recurrence: null, approximate: false };
      }
      continue;
    }
    if (l.name === 'END') {
      depth--;
      if (l.value.toUpperCase() === 'VEVENT' && cur) { events.push(cur); cur = null; }
      continue;
    }
    if (!cur) {
      if (l.name === 'METHOD') method = l.value.trim().toUpperCase() || 'PUBLISH';
      continue;
    }
    switch (l.name) {
      case 'UID': cur.uid = l.value.trim().slice(0, 500) || null; break;
      case 'SUMMARY': cur.summary = unescapeText(l.value).slice(0, 500) || null; break;
      case 'DESCRIPTION': cur.description = unescapeText(l.value).slice(0, 5000) || null; break;
      case 'LOCATION': cur.location = unescapeText(l.value).slice(0, 500) || null; break;
      case 'STATUS': cur.status = l.value.trim().toUpperCase() || null; break;
      case 'SEQUENCE': cur.sequence = Number.parseInt(l.value, 10) || 0; break;
      case 'RRULE': cur.recurrence = describeRrule(l.value); break;
      case 'ORGANIZER': {
        const email = mailtoOf(l.value);
        if (email) cur.organizer = { email, name: l.params.CN ? unescapeText(l.params.CN) : null };
        break;
      }
      case 'ATTENDEE': {
        const email = mailtoOf(l.value);
        if (email && cur.attendees.length < 100) {
          cur.attendees.push({ email, name: l.params.CN ? unescapeText(l.params.CN) : null, role: l.params.ROLE ?? null, partstat: l.params.PARTSTAT ?? null });
        }
        break;
      }
      case 'DTSTART': {
        const r = parseIcalDate(l.value, l.params, offsets);
        cur.start = r.at; cur.allDay = r.allDay; cur.approximate = cur.approximate || r.approximate;
        break;
      }
      case 'DTEND': {
        const r = parseIcalDate(l.value, l.params, offsets);
        cur.end = r.at; cur.approximate = cur.approximate || r.approximate;
        break;
      }
      case 'DURATION': {
        // Only used when there is no DTEND, which is legal and common.
        const ms = parseDuration(l.value);
        if (ms !== null && cur.start && !cur.end) cur.end = new Date(cur.start.getTime() + ms);
        break;
      }
    }
  }
  // An unterminated VEVENT still holds a usable invitation.
  if (cur) events.push(cur);
  return { method, events: events.filter((e) => e.uid || e.summary || e.start) };
}

export function mailtoOf(v: string): string | null {
  const m = /^\s*mailto:\s*(.+?)\s*$/i.exec(String(v ?? ''));
  const email = (m?.[1] ?? String(v ?? '')).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 320) : null;
}

// ISO 8601 durations, the subset iCalendar uses: P[n]DT[n]H[n]M[n]S and weeks.
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const ms = (Number(m[2] ?? 0) * 7 * 86400 + Number(m[3] ?? 0) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return ms === 0 && !/\d/.test(v) ? null : sign * ms;
}

// One readable line out of an RRULE. Not an expansion — just enough for the
// invitation card to say what kind of repeat it is.
export function describeRrule(v: string): string | null {
  const parts = Object.fromEntries(
    String(v ?? '').split(';').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, x]) => [k.toUpperCase(), x]),
  ) as Record<string, string>;
  const freq = (parts.FREQ ?? '').toUpperCase();
  const every = Number.parseInt(parts.INTERVAL ?? '1', 10) || 1;
  const base: Record<string, [string, string]> = {
    DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'],
  };
  if (!base[freq]) return null;
  const [one, many] = base[freq];
  const when = every === 1 ? `every ${one}` : `every ${every} ${many}`;
  const until = parts.UNTIL ? ` until ${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : '';
  const count = parts.COUNT ? `, ${parts.COUNT} times` : '';
  return `Repeats ${when}${count}${until}`;
}
