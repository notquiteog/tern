import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByUid } from './ics.js';
import { toVEvent as googleEvent, toGoogle } from './google.js';
import { fromRrule, toRrule, toVEvent as graphEvent, toGraph } from './microsoft.js';
import { parseCalendar, expandEvent } from './vevent.js';
import { mergeBlocks } from './index.js';

// ---------- Subscribed .ics ----------

const FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Publisher//EN
X-WR-CALNAME:Holidays
BEGIN:VEVENT
UID:a@feed
DTSTART;VALUE=DATE:20260101
SUMMARY:New Year
END:VEVENT
BEGIN:VEVENT
UID:b@feed
DTSTART:20260601T090000Z
DTEND:20260601T100000Z
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Standing item
END:VEVENT
BEGIN:VEVENT
UID:b@feed
RECURRENCE-ID:20260608T090000Z
DTSTART:20260608T110000Z
DTEND:20260608T120000Z
SUMMARY:Standing item (moved)
END:VEVENT
END:VCALENDAR`;

test('a published feed becomes one object per event, overrides staying with their master', () => {
  const objects = groupByUid(FEED);
  assert.equal(objects.length, 2);
  const series = objects.find((o) => o.uid === 'b@feed')!;
  // The master and its exception have to be in the same file, or the
  // exception is stored as an event of its own and the meeting appears twice.
  const parsed = parseCalendar(series.ical);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events.filter((e) => e.recurrenceId).length, 1);
  const occ = expandEvent(parsed.events.find((e) => !e.recurrenceId)!, parsed.events.filter((e) => e.recurrenceId), new Date('2026-06-01'), new Date('2026-07-01'));
  assert.deepEqual(occ.map((o) => o.start.toISOString().slice(0, 16)), ['2026-06-01T09:00', '2026-06-08T11:00', '2026-06-15T09:00']);
});

// ---------- Google ----------

test('a Google event keeps its recurrence rules, which are already iCalendar', () => {
  const e = googleEvent({
    id: 'g1', iCalUID: 'g1@google.com', summary: 'Weekly sync',
    start: { dateTime: '2026-09-07T09:00:00+01:00', timeZone: 'Europe/London' },
    end: { dateTime: '2026-09-07T09:30:00+01:00', timeZone: 'Europe/London' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/London:20260914T090000'],
    attendees: [{ email: 'Sam@Example.com', responseStatus: 'accepted', displayName: 'Sam' }],
    transparency: 'opaque', status: 'confirmed',
  })!;
  assert.equal(e.uid, 'g1@google.com');
  assert.equal(e.rrule, 'FREQ=WEEKLY;BYDAY=MO');
  assert.equal(e.start!.tzid, 'Europe/London');
  assert.equal(e.start!.at.toISOString(), '2026-09-07T08:00:00.000Z');
  assert.equal(e.attendees[0].email, 'sam@example.com');
  assert.equal(e.attendees[0].partstat, 'ACCEPTED');
  // The excluded date is a wall clock in London, so it is 08:00Z in September.
  assert.equal(e.exdates[0].toISOString(), '2026-09-14T08:00:00.000Z');
});

test('a Google all-day event is a date, not a midnight', () => {
  const e = googleEvent({ id: 'g2', iCalUID: 'g2', start: { date: '2026-12-25' }, end: { date: '2026-12-26' }, summary: 'Christmas' })!;
  assert.equal(e.start!.allDay, true);
  assert.equal(e.start!.at.toISOString(), '2026-12-25T00:00:00.000Z');
});

test('an event written back to Google carries the rule it came with', () => {
  const e = googleEvent({ id: 'g3', iCalUID: 'g3', start: { dateTime: '2026-09-07T09:00:00Z' }, end: { dateTime: '2026-09-07T10:00:00Z' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=5'], summary: 'x' })!;
  const back = toGoogle(e) as any;
  assert.deepEqual(back.recurrence, ['RRULE:FREQ=DAILY;COUNT=5']);
  assert.equal(back.iCalUID, 'g3');
  assert.equal(back.transparency, 'opaque');
});

// ---------- Microsoft ----------

test("Graph's recurrence object becomes an RRULE", () => {
  assert.equal(
    toRrule({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'thursday'], firstDayOfWeek: 'sunday' }, range: { type: 'noEnd' } }),
    'FREQ=WEEKLY;BYDAY=MO,TH;WKST=SU;INTERVAL=2',
  );
  assert.equal(
    toRrule({ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' }, range: { type: 'numbered', numberOfOccurrences: 6 } }),
    'FREQ=MONTHLY;BYDAY=-1FR;COUNT=6',
  );
  assert.equal(
    toRrule({ pattern: { type: 'absoluteYearly', interval: 1, month: 3, dayOfMonth: 14 }, range: { type: 'endDate', endDate: '2030-03-14' } }),
    'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14;UNTIL=20300314T235959Z',
  );
  assert.equal(toRrule({ pattern: { type: 'somethingNew' } }), null);
});

test('and back again, so an edit made here survives the round trip', () => {
  const start = new Date('2026-09-07T09:00:00Z');
  const weekly = fromRrule('FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=2', start) as any;
  assert.equal(weekly.pattern.type, 'weekly');
  assert.deepEqual(weekly.pattern.daysOfWeek, ['monday', 'thursday']);
  assert.equal(weekly.pattern.interval, 2);
  assert.equal(weekly.range.type, 'noEnd');

  const monthly = fromRrule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=6', start) as any;
  assert.equal(monthly.pattern.type, 'relativeMonthly');
  assert.equal(monthly.pattern.index, 'last');
  assert.equal(monthly.range.numberOfOccurrences, 6);

  // A rule Graph has no way to express must come back null rather than a
  // wrong approximation of it.
  assert.equal(fromRrule('FREQ=MINUTELY;INTERVAL=90', start), null);
});

test("Graph's zone-beside-the-clock times resolve to the right instant", () => {
  const e = graphEvent({
    id: 'm1', iCalUId: 'm1@outlook', subject: 'Review',
    start: { dateTime: '2026-09-07T09:00:00.0000000', timeZone: 'Pacific Standard Time' },
    end: { dateTime: '2026-09-07T10:00:00.0000000', timeZone: 'Pacific Standard Time' },
    showAs: 'busy', isAllDay: false,
    attendees: [{ emailAddress: { address: 'Dana@Example.com', name: 'Dana' }, type: 'required', status: { response: 'tentativelyAccepted' } }],
  })!;
  assert.equal(e.start!.tzid, 'America/Los_Angeles');
  assert.equal(e.start!.at.toISOString(), '2026-09-07T16:00:00.000Z');
  assert.equal(e.attendees[0].partstat, 'TENTATIVE');
  assert.equal(e.transparent, false);
});

test('a Graph event marked free does not block the time', () => {
  const e = graphEvent({ id: 'm2', iCalUId: 'm2', subject: 'Focus', start: { dateTime: '2026-09-07T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-07T10:00:00', timeZone: 'UTC' }, showAs: 'free' })!;
  assert.equal(e.transparent, true);
  assert.equal((toGraph(e) as any).showAs, 'free');
});

// ---------- Free/busy ----------

test('overlapping busy blocks merge into one', () => {
  const merged = mergeBlocks([
    { from: 100, to: 200 },
    { from: 150, to: 250 },
    { from: 250, to: 300 },
    { from: 400, to: 500 },
  ]);
  assert.deepEqual(merged, [{ from: 100, to: 300 }, { from: 400, to: 500 }]);
});

test('blocks arriving out of order still merge', () => {
  assert.deepEqual(mergeBlocks([{ from: 400, to: 500 }, { from: 100, to: 450 }]), [{ from: 100, to: 500 }]);
});

test('an empty diary is empty rather than one zero-length block', () => {
  assert.deepEqual(mergeBlocks([]), []);
});
