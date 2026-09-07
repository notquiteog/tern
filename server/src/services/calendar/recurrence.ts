// RRULE expansion (RFC 5545 §3.3.10), which is the piece the invitation
// reader deliberately did without.
//
// Why this is more than a loop that adds seven days. Two things make it
// hard, and getting either wrong is a missed meeting rather than a cosmetic
// bug:
//
//   1. Recurrence happens on the wall clock, not on the instant. A weekly
//      nine o'clock stand-up is at nine before the clocks change and at nine
//      after, which is a different number of elapsed hours. So the whole
//      expansion runs on civil date fields in the event's own zone, and only
//      the last step turns each occurrence into an instant.
//   2. The BY* parts are not filters in a single sense: the same part
//      expands the set in one frequency and narrows it in another
//      (RFC 5545's table). BYDAY under MONTHLY makes new dates; BYDAY under
//      DAILY only removes them.
//
// Everything is bounded. A malformed rule that would otherwise run for ever
// is stopped by a hard iteration cap and by the caller's window, because
// this is fed by remote servers and by mail from strangers.
import { zoneOffsetMinutes } from '../icalendar.js';

export interface Civil { y: number; m: number; d: number; hh: number; mm: number; ss: number }

export interface Rrule {
  freq: 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  /** Civil fields when the UNTIL was floating, an instant when it was UTC. */
  until: { at: Date; utc: boolean } | null;
  byDay: { day: number; nth: number | null }[];
  byMonthDay: number[];
  byYearDay: number[];
  byMonth: number[];
  byWeekNo: number[];
  byHour: number[];
  byMinute: number[];
  bySecond: number[];
  bySetPos: number[];
  /** Which day the week starts on; only matters for WEEKLY with INTERVAL > 1 and BYWEEKNO. */
  wkst: number;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRrule(text: string): Rrule | null {
  const parts: Record<string, string> = {};
  for (const bit of String(text ?? '').replace(/^RRULE:/i, '').split(';')) {
    const eq = bit.indexOf('=');
    if (eq > 0) parts[bit.slice(0, eq).trim().toUpperCase()] = bit.slice(eq + 1).trim();
  }
  const freq = (parts.FREQ ?? '').toUpperCase();
  if (!['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  const nums = (v: string | undefined, lo: number, hi: number): number[] => {
    if (!v) return [];
    return v.split(',')
      .map((x) => Number.parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n !== 0 && Math.abs(n) >= lo && Math.abs(n) <= hi);
  };

  // BYDAY carries an optional ordinal: "-1FR" is the last Friday, "2MO" the
  // second Monday. The ordinal only means anything under MONTHLY and YEARLY.
  const byDay: { day: number; nth: number | null }[] = [];
  for (const bit of (parts.BYDAY ?? '').split(',')) {
    const m = /^\s*([+-]?\d{1,2})?\s*(SU|MO|TU|WE|TH|FR|SA)\s*$/i.exec(bit);
    if (!m) continue;
    const nth = m[1] ? Number.parseInt(m[1], 10) : null;
    if (nth === 0) continue;
    byDay.push({ day: DAYS.indexOf(m[2].toUpperCase()), nth });
  }

  let until: Rrule['until'] = null;
  if (parts.UNTIL) {
    const u = parts.UNTIL.trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(u);
    if (m) {
      until = {
        at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))),
        utc: Boolean(m[7]) || !m[4],
      };
    }
  }

  const count = parts.COUNT ? Number.parseInt(parts.COUNT, 10) : null;
  const interval = Math.max(1, Number.parseInt(parts.INTERVAL ?? '1', 10) || 1);
  const wkstIdx = DAYS.indexOf((parts.WKST ?? 'MO').toUpperCase());

  return {
    freq: freq as Rrule['freq'],
    interval,
    count: Number.isFinite(count) && (count as number) > 0 ? (count as number) : null,
    until,
    byDay,
    byMonthDay: nums(parts.BYMONTHDAY, 1, 31),
    byYearDay: nums(parts.BYYEARDAY, 1, 366),
    byMonth: nums(parts.BYMONTH, 1, 12),
    byWeekNo: nums(parts.BYWEEKNO, 1, 53),
    // BYHOUR and friends legitimately include 0, which `nums` drops because
    // 0 is meaningless everywhere else.
    byHour: (parts.BYHOUR ?? '').split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23),
    byMinute: (parts.BYMINUTE ?? '').split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 59),
    bySecond: (parts.BYSECOND ?? '').split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 59),
    bySetPos: nums(parts.BYSETPOS, 1, 366),
    wkst: wkstIdx < 0 ? 1 : wkstIdx,
  };
}

// ---------- Civil arithmetic ----------
//
// Done on UTC instants used purely as a calendar — never converted to a
// zone here — so that "add one month" lands on the same day number and
// "which weekday is this" is a plain lookup.

const DAY_MS = 86_400_000;

export function civilToUtc(c: Civil): number {
  return Date.UTC(c.y, c.m - 1, c.d, c.hh, c.mm, c.ss);
}
export function utcToCivil(ms: number): Civil {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds() };
}
function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function weekdayOf(y: number, m: number, d: number): number { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function dayOfYear(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
}
function daysInYear(y: number): number { return dayOfYear(y, 12, 31); }

// ISO-like week number, but honouring WKST rather than assuming Monday.
function weekNumber(y: number, m: number, d: number, wkst: number): number {
  const jan1 = weekdayOf(y, 1, 1);
  // Offset of the first day of the first week that has at least four days
  // in this year, as RFC 5545 defines it.
  const shift = (jan1 - wkst + 7) % 7;
  const firstWeekStart = shift <= 3 ? 1 - shift : 8 - shift;
  const doy = dayOfYear(y, m, d);
  if (doy < firstWeekStart) return weekNumber(y - 1, 12, 31, wkst);
  return Math.floor((doy - firstWeekStart) / 7) + 1;
}

// ---------- Expansion ----------

export interface ExpandOptions {
  /** The event's own zone. Undefined means the times are floating or UTC. */
  tzid?: string | null;
  /** Only occurrences that start at or after this instant are returned. */
  from?: Date;
  /** Only occurrences that start strictly before this instant are returned. */
  to?: Date;
  /** Hard ceiling on returned occurrences. */
  limit?: number;
  /** EXDATE values, as instants. */
  exdates?: Date[];
  /** RDATE values, as instants. */
  rdates?: Date[];
}

// How many candidate periods to walk before giving up. A rule that matches
// nothing (BYMONTHDAY=31 on a YEARLY in February) would otherwise spin.
const MAX_PERIODS = 40_000;
const DEFAULT_LIMIT = 2000;

// The instant a civil time in `tzid` refers to.
//
// Two passes, because the offset to apply depends on the instant we are
// trying to find. The second pass settles everything except the hour that
// does not exist on a spring-forward morning, where the convention — and
// what every other client does — is to slide forward onto the next real one.
export function instantOf(c: Civil, tzid?: string | null): number {
  const guess = civilToUtc(c);
  if (!tzid) return guess;
  const o1 = zoneOffsetMinutes(tzid, new Date(guess));
  if (o1 === null) return guess;
  const first = guess - o1 * 60_000;
  const o2 = zoneOffsetMinutes(tzid, new Date(first));
  if (o2 === null) return first;
  return guess - o2 * 60_000;
}

/**
 * Every start time this rule produces, in order.
 *
 * `start` is the DTSTART as civil fields in `tzid`. The first occurrence is
 * DTSTART itself whenever the rule matches it, which is what RFC 5545 says
 * and what every calendar shows.
 */
export function expandRrule(rule: Rrule, start: Civil, opts: ExpandOptions = {}): Date[] {
  const tzid = opts.tzid ?? null;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 20_000));
  const fromMs = opts.from ? opts.from.getTime() : -Infinity;
  const toMs = opts.to ? opts.to.getTime() : Infinity;
  const excluded = new Set((opts.exdates ?? []).map((d) => d.getTime()));

  // UNTIL in UTC is an instant; a floating UNTIL is a civil time in the
  // event's own zone, so it becomes an instant the same way a start does.
  const untilMs = rule.until
    ? (rule.until.utc ? rule.until.at.getTime() : instantOf(utcToCivil(rule.until.at.getTime()), tzid))
    : Infinity;

  const out: number[] = [];
  let produced = 0; // counts against COUNT, including occurrences before `from`
  let periods = 0;
  let cursor: Civil = { ...start };
  let done = false;

  const hours = rule.byHour.length ? [...rule.byHour].sort((a, b) => a - b) : [start.hh];
  const minutes = rule.byMinute.length ? [...rule.byMinute].sort((a, b) => a - b) : [start.mm];
  const seconds = rule.bySecond.length ? [...rule.bySecond].sort((a, b) => a - b) : [start.ss];

  while (!done && periods < MAX_PERIODS && out.length < limit) {
    periods++;
    const dates = candidateDates(rule, cursor, start);
    // Times within each candidate day.
    let stamps: Civil[] = [];
    for (const d of dates) {
      for (const hh of hours) for (const mm of minutes) for (const ss of seconds) {
        stamps.push({ ...d, hh, mm, ss });
      }
    }
    stamps.sort((a, b) => civilToUtc(a) - civilToUtc(b));

    // BYSETPOS selects from the period's whole set, after everything else.
    if (rule.bySetPos.length) {
      const picked: Civil[] = [];
      for (const pos of rule.bySetPos) {
        const i = pos > 0 ? pos - 1 : stamps.length + pos;
        if (i >= 0 && i < stamps.length) picked.push(stamps[i]);
      }
      stamps = picked.sort((a, b) => civilToUtc(a) - civilToUtc(b));
    }

    const startMs = instantOf(start, tzid);
    for (const s of stamps) {
      const at = instantOf(s, tzid);
      // Nothing before DTSTART, whatever the BY parts would allow.
      if (at < startMs) continue;
      if (at > untilMs) { done = true; break; }
      produced++;
      if (rule.count !== null && produced > rule.count) { done = true; break; }
      if (excluded.has(at)) continue;
      if (at >= fromMs && at < toMs) out.push(at);
      // Past the window and going forward: nothing later can come back into
      // it, so stop rather than walk to UNTIL.
      if (at >= toMs) { done = true; break; }
      if (out.length >= limit) { done = true; break; }
    }
    if (done) break;
    const next = advance(rule, cursor);
    if (!next) break;
    cursor = next;
    // A rule with no COUNT and no UNTIL, asked for an unbounded window, has
    // to stop somewhere; the caller's window is the usual bound.
    if (!Number.isFinite(toMs) && rule.count === null && !rule.until && out.length >= limit) break;
  }

  // RDATEs are added to whatever the rule produced, then the whole set is
  // deduplicated and ordered.
  for (const r of opts.rdates ?? []) {
    const at = r.getTime();
    if (excluded.has(at)) continue;
    if (at >= fromMs && at < toMs) out.push(at);
  }
  return [...new Set(out)].sort((a, b) => a - b).slice(0, limit).map((ms) => new Date(ms));
}

// Which dates in the current period the rule selects. Returns civil dates
// with the time fields left as they came in; the caller fills those.
function candidateDates(rule: Rrule, cursor: Civil, start: Civil): Civil[] {
  const inMonths = (y: number, m: number) => !rule.byMonth.length || rule.byMonth.includes(m);
  const dayOk = (y: number, m: number, d: number): boolean => {
    if (rule.byMonthDay.length) {
      const dim = daysInMonth(y, m);
      if (!rule.byMonthDay.some((n) => (n > 0 ? n === d : dim + n + 1 === d))) return false;
    }
    if (rule.byYearDay.length) {
      const diy = daysInYear(y);
      const doy = dayOfYear(y, m, d);
      if (!rule.byYearDay.some((n) => (n > 0 ? n === doy : diy + n + 1 === doy))) return false;
    }
    if (rule.byWeekNo.length) {
      const wn = weekNumber(y, m, d, rule.wkst);
      if (!rule.byWeekNo.some((n) => n > 0 && n === wn)) return false;
    }
    if (rule.byDay.length) {
      const wd = weekdayOf(y, m, d);
      if (!rule.byDay.some((b) => b.day === wd)) return false;
    }
    return true;
  };

  switch (rule.freq) {
    case 'SECONDLY':
    case 'MINUTELY':
    case 'HOURLY':
    case 'DAILY': {
      // Everything is a filter here: the period is already one day (or less).
      if (!inMonths(cursor.y, cursor.m)) return [];
      if (!dayOk(cursor.y, cursor.m, cursor.d)) return [];
      return [{ ...cursor }];
    }
    case 'WEEKLY': {
      // BYDAY expands across the week the cursor sits in; without it, the
      // week contributes the same weekday DTSTART fell on.
      const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [weekdayOf(start.y, start.m, start.d)];
      const cursorDow = weekdayOf(cursor.y, cursor.m, cursor.d);
      const weekStart = civilToUtc({ ...cursor, hh: 0, mm: 0, ss: 0 }) - ((cursorDow - rule.wkst + 7) % 7) * DAY_MS;
      const out: Civil[] = [];
      for (const wd of [...new Set(days)].sort((a, b) => ((a - rule.wkst + 7) % 7) - ((b - rule.wkst + 7) % 7))) {
        const ms = weekStart + ((wd - rule.wkst + 7) % 7) * DAY_MS;
        const c = utcToCivil(ms);
        if (!inMonths(c.y, c.m)) continue;
        // BYMONTHDAY is a filter under WEEKLY, which is unusual but legal.
        if (rule.byMonthDay.length) {
          const dim = daysInMonth(c.y, c.m);
          if (!rule.byMonthDay.some((n) => (n > 0 ? n === c.d : dim + n + 1 === c.d))) continue;
        }
        out.push({ ...c, hh: cursor.hh, mm: cursor.mm, ss: cursor.ss });
      }
      return out;
    }
    case 'MONTHLY': {
      if (!inMonths(cursor.y, cursor.m)) return [];
      const dim = daysInMonth(cursor.y, cursor.m);
      let days: number[] = [];
      if (rule.byMonthDay.length) {
        days = rule.byMonthDay.map((n) => (n > 0 ? n : dim + n + 1)).filter((d) => d >= 1 && d <= dim);
        // With both parts present BYDAY narrows what BYMONTHDAY produced.
        if (rule.byDay.length) days = days.filter((d) => rule.byDay.some((b) => b.day === weekdayOf(cursor.y, cursor.m, d)));
      } else if (rule.byDay.length) {
        days = monthlyByDay(rule, cursor.y, cursor.m, dim);
      } else {
        days = [Math.min(start.d, dim)];
        // A monthly on the 31st legitimately skips the months without one;
        // clamping instead would silently invent a meeting on the 30th.
        if (start.d > dim) days = [];
      }
      return [...new Set(days)].sort((a, b) => a - b).map((d) => ({ ...cursor, d }));
    }
    case 'YEARLY': {
      const months = rule.byMonth.length ? rule.byMonth : (rule.byYearDay.length || rule.byWeekNo.length || (rule.byDay.length && rule.byDay.some((b) => b.nth !== null)) ? [] : [start.m]);
      const out: Civil[] = [];
      if (rule.byYearDay.length) {
        const diy = daysInYear(cursor.y);
        for (const n of rule.byYearDay) {
          const doy = n > 0 ? n : diy + n + 1;
          if (doy < 1 || doy > diy) continue;
          const c = utcToCivil(Date.UTC(cursor.y, 0, 1) + (doy - 1) * DAY_MS);
          if (rule.byMonth.length && !rule.byMonth.includes(c.m)) continue;
          out.push({ ...cursor, m: c.m, d: c.d });
        }
        return out;
      }
      if (rule.byWeekNo.length) {
        for (let m = 1; m <= 12; m++) {
          for (let d = 1; d <= daysInMonth(cursor.y, m); d++) {
            if (rule.byMonth.length && !rule.byMonth.includes(m)) continue;
            if (!rule.byWeekNo.includes(weekNumber(cursor.y, m, d, rule.wkst))) continue;
            if (rule.byDay.length && !rule.byDay.some((b) => b.day === weekdayOf(cursor.y, m, d))) continue;
            out.push({ ...cursor, m, d });
          }
        }
        return out;
      }
      // A yearly BYDAY with an ordinal counts across the whole year unless
      // BYMONTH narrows it to months, where it counts within each.
      if (rule.byDay.length && rule.byDay.some((b) => b.nth !== null) && !rule.byMonth.length) {
        for (const b of rule.byDay) {
          const all: number[] = [];
          for (let m = 1; m <= 12; m++) {
            for (let d = 1; d <= daysInMonth(cursor.y, m); d++) {
              if (weekdayOf(cursor.y, m, d) === b.day) all.push(Date.UTC(cursor.y, m - 1, d));
            }
          }
          const picks = b.nth === null ? all : [all[b.nth > 0 ? b.nth - 1 : all.length + b.nth]];
          for (const ms of picks) {
            if (ms === undefined) continue;
            const c = utcToCivil(ms);
            out.push({ ...cursor, m: c.m, d: c.d });
          }
        }
        return out.sort((a, b) => civilToUtc(a) - civilToUtc(b));
      }
      for (const m of months) {
        const dim = daysInMonth(cursor.y, m);
        let days: number[];
        if (rule.byMonthDay.length) {
          days = rule.byMonthDay.map((n) => (n > 0 ? n : dim + n + 1)).filter((d) => d >= 1 && d <= dim);
          if (rule.byDay.length) days = days.filter((d) => rule.byDay.some((b) => b.day === weekdayOf(cursor.y, m, d)));
        } else if (rule.byDay.length) {
          days = monthlyByDay(rule, cursor.y, m, dim);
        } else {
          days = start.d > dim ? [] : [start.d];
        }
        for (const d of [...new Set(days)].sort((a, b) => a - b)) out.push({ ...cursor, m, d });
      }
      return out;
    }
  }
}

// The days in one month that a BYDAY list selects, honouring ordinals.
function monthlyByDay(rule: Rrule, y: number, m: number, dim: number): number[] {
  const days: number[] = [];
  for (const b of rule.byDay) {
    const matching: number[] = [];
    for (let d = 1; d <= dim; d++) if (weekdayOf(y, m, d) === b.day) matching.push(d);
    if (b.nth === null) days.push(...matching);
    else {
      const i = b.nth > 0 ? b.nth - 1 : matching.length + b.nth;
      if (i >= 0 && i < matching.length) days.push(matching[i]);
    }
  }
  return days;
}

// The next period's cursor. Month arithmetic clamps the day so that walking
// from the 31st does not skip a month; the day itself is re-derived from the
// rule in `candidateDates`, so the clamp cannot leak into an occurrence.
function advance(rule: Rrule, c: Civil): Civil | null {
  const n = rule.interval;
  switch (rule.freq) {
    case 'SECONDLY': return utcToCivil(civilToUtc(c) + n * 1000);
    case 'MINUTELY': return utcToCivil(civilToUtc(c) + n * 60_000);
    case 'HOURLY': return utcToCivil(civilToUtc(c) + n * 3_600_000);
    case 'DAILY': return utcToCivil(civilToUtc({ ...c }) + n * DAY_MS);
    case 'WEEKLY': return utcToCivil(civilToUtc({ ...c }) + n * 7 * DAY_MS);
    case 'MONTHLY': {
      const total = (c.y * 12 + (c.m - 1)) + n;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      if (y > 9000) return null;
      return { ...c, y, m, d: Math.min(c.d, daysInMonth(y, m)) };
    }
    case 'YEARLY': {
      const y = c.y + n;
      if (y > 9000) return null;
      return { ...c, y, d: Math.min(c.d, daysInMonth(y, c.m)) };
    }
  }
}
