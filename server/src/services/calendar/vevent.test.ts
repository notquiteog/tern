import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationOf, expandEvent, foldLine, newEvent, parseCalendar, vtimeOf, writeCalendar } from './vevent.js';

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}\r\nEND:VCALENDAR`;
const win = (a: string, b: string) => [new Date(a), new Date(b)] as const;
const at = (o: { start: Date }[]) => o.map((x) => x.start.toISOString().slice(0, 16));

test('a zoned start keeps the zone, not just the instant it resolved to', () => {
  const c = parseCalendar(ics([
    'BEGIN:VEVENT', 'UID:a@x', 'DTSTART;TZID=Europe/London:20260327T090000', 'DTEND;TZID=Europe/London:20260327T093000',
    'RRULE:FREQ=DAILY;COUNT=4', 'END:VEVENT',
  ].join('\r\n')));
  const e = c.events[0];
  assert.equal(e.start!.tzid, 'Europe/London');
  assert.deepEqual(e.start!.civil, { y: 2026, m: 3, d: 27, hh: 9, mm: 0, ss: 0 });
  assert.equal(e.start!.at.toISOString(), '2026-03-27T09:00:00.000Z');
  // And so the series survives the clocks going forward at the right hour.
  const occ = expandEvent(e, [], ...win('2026-03-26T00:00:00Z', '2026-04-01T00:00:00Z'));
  assert.deepEqual(at(occ), ['2026-03-27T09:00', '2026-03-28T09:00', '2026-03-29T08:00', '2026-03-30T08:00']);
});

test('an all-day date is not anchored to a zone', () => {
  const e = parseCalendar(ics(['BEGIN:VEVENT', 'UID:b@x', 'DTSTART;VALUE=DATE:20260704', 'DTEND;VALUE=DATE:20260705', 'END:VEVENT'].join('\r\n'))).events[0];
  assert.equal(e.start!.allDay, true);
  assert.equal(e.start!.tzid, null);
  assert.equal(e.start!.at.toISOString(), '2026-07-04T00:00:00.000Z');
});

test('EXDATE and RDATE are kept as dates rather than described', () => {
  const e = parseCalendar(ics([
    'BEGIN:VEVENT', 'UID:c@x', 'DTSTART:20260202T090000Z', 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=4',
    'EXDATE:20260203T090000Z', 'RDATE:20260210T140000Z', 'END:VEVENT',
  ].join('\r\n'))).events[0];
  assert.equal(e.exdates.length, 1);
  assert.equal(e.rdates.length, 1);
  assert.equal(durationOf(e), 30 * 60_000);
  const occ = expandEvent(e, [], ...win('2026-02-01T00:00:00Z', '2026-02-20T00:00:00Z'));
  assert.deepEqual(at(occ), ['2026-02-02T09:00', '2026-02-04T09:00', '2026-02-05T09:00', '2026-02-10T14:00']);
});

test('an override replaces exactly its own occurrence and leaves the rest alone', () => {
  const c = parseCalendar(ics([
    'BEGIN:VEVENT', 'UID:d@x', 'DTSTART:20260302T090000Z', 'DTEND:20260302T093000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Stand-up', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d@x', 'RECURRENCE-ID:20260309T090000Z', 'DTSTART:20260309T110000Z', 'DTEND:20260309T113000Z', 'SUMMARY:Stand-up (moved)', 'END:VEVENT',
  ].join('\r\n')));
  const master = c.events.find((e) => !e.recurrenceId)!;
  const occ = expandEvent(master, c.events.filter((e) => e.recurrenceId), ...win('2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z'));
  assert.deepEqual(at(occ), ['2026-03-02T09:00', '2026-03-09T11:00', '2026-03-16T09:00']);
  assert.equal(occ[1].override?.summary, 'Stand-up (moved)');
});

test('a cancelled override removes that one meeting only', () => {
  const c = parseCalendar(ics([
    'BEGIN:VEVENT', 'UID:e@x', 'DTSTART:20260302T090000Z', 'DTEND:20260302T093000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e@x', 'RECURRENCE-ID:20260309T090000Z', 'DTSTART:20260309T090000Z', 'STATUS:CANCELLED', 'END:VEVENT',
  ].join('\r\n')));
  const occ = expandEvent(c.events.find((e) => !e.recurrenceId)!, c.events.filter((e) => e.recurrenceId), ...win('2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z'));
  assert.deepEqual(at(occ), ['2026-03-02T09:00', '2026-03-16T09:00']);
});

test('RANGE=THISANDFUTURE truncates the series at that point', () => {
  const c = parseCalendar(ics([
    'BEGIN:VEVENT', 'UID:f@x', 'DTSTART:20260302T090000Z', 'DTEND:20260302T093000Z', 'RRULE:FREQ=WEEKLY;COUNT=6', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:f@x', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260316T090000Z', 'DTSTART:20260316T090000Z', 'STATUS:CANCELLED', 'END:VEVENT',
  ].join('\r\n')));
  const occ = expandEvent(c.events.find((e) => !e.recurrenceId)!, c.events.filter((e) => e.recurrenceId), ...win('2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z'));
  assert.deepEqual(at(occ), ['2026-03-02T09:00', '2026-03-09T09:00']);
});

// A booking that started last week is still on today; a window that only
// caught events *starting* inside it would show an empty Wednesday.
test('a long event shows on every day it covers', () => {
  const e = parseCalendar(ics(['BEGIN:VEVENT', 'UID:g@x', 'DTSTART:20260601T000000Z', 'DTEND:20260610T000000Z', 'END:VEVENT'].join('\r\n'))).events[0];
  assert.equal(expandEvent(e, [], ...win('2026-06-04T00:00:00Z', '2026-06-05T00:00:00Z')).length, 1);
});

test('a VALARM inside an event does not steal its start time', () => {
  const e = parseCalendar(ics([
    'BEGIN:VEVENT', 'UID:h@x', 'DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Soon', 'END:VALARM',
    'SUMMARY:Real', 'END:VEVENT',
  ].join('\r\n'))).events[0];
  assert.equal(e.start!.at.toISOString(), '2026-06-01T10:00:00.000Z');
  assert.equal(e.summary, 'Real');
  assert.equal(e.description, null);
});

test('a VTIMEZONE block does not become an event', () => {
  const c = parseCalendar(ics([
    'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:i@x', 'DTSTART;TZID=Europe/Berlin:20260601T100000', 'END:VEVENT',
  ].join('\r\n')));
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].start!.at.toISOString(), '2026-06-01T08:00:00.000Z');
});

test('a Windows zone name from Exchange is translated', () => {
  const e = parseCalendar(ics(['BEGIN:VEVENT', 'UID:j@x', 'DTSTART;TZID=Pacific Standard Time:20260601T090000', 'END:VEVENT'].join('\r\n'))).events[0];
  assert.equal(e.start!.tzid, 'America/Los_Angeles');
  assert.equal(e.start!.at.toISOString(), '2026-06-01T16:00:00.000Z');
});

// Neither name resolves, so the file's own declared offset has to carry it.
test('an unknown zone falls back to the offset the file declared', () => {
  const e = parseCalendar(ics([
    'BEGIN:VTIMEZONE', 'TZID:Made Up Zone', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0500', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:k@x', 'DTSTART;TZID=Made Up Zone:20260601T120000', 'END:VEVENT',
  ].join('\r\n'))).events[0];
  assert.equal(e.start!.at.toISOString(), '2026-06-01T06:30:00.000Z');
});

test('TRANSP decides whether an event blocks the time', () => {
  const body = (t: string) => parseCalendar(ics(['BEGIN:VEVENT', 'UID:l@x', 'DTSTART:20260601T100000Z', t, 'END:VEVENT'].join('\r\n'))).events[0];
  assert.equal(body('TRANSP:TRANSPARENT').transparent, true);
  assert.equal(body('TRANSP:OPAQUE').transparent, false);
  assert.equal(body('SUMMARY:x').transparent, false);
});

test('what is written can be read back', () => {
  const e = newEvent('round@trip');
  e.summary = 'Quarterly review; with a comma, too';
  e.location = 'Room 2\nSecond floor';
  e.start = vtimeOf(new Date('2026-05-06T13:00:00Z'));
  e.end = vtimeOf(new Date('2026-05-06T14:00:00Z'));
  e.rrule = 'FREQ=MONTHLY;COUNT=3';
  e.attendees = [{ email: 'sam@example.com', name: 'Sam Reed', role: 'REQ-PARTICIPANT', partstat: 'NEEDS-ACTION', rsvp: true, cutype: null }];
  const back = parseCalendar(writeCalendar([e])).events[0];
  assert.equal(back.uid, 'round@trip');
  assert.equal(back.summary, 'Quarterly review; with a comma, too');
  assert.equal(back.location, 'Room 2\nSecond floor');
  assert.equal(back.start!.at.toISOString(), '2026-05-06T13:00:00.000Z');
  assert.equal(back.rrule, 'FREQ=MONTHLY;COUNT=3');
  assert.deepEqual(back.attendees.map((a) => a.email), ['sam@example.com']);
});

test('an all-day event round-trips as a date, not as midnight UTC', () => {
  const e = newEvent('allday@x');
  e.start = vtimeOf(new Date('2026-12-25T00:00:00Z'), { allDay: true });
  e.end = vtimeOf(new Date('2026-12-26T00:00:00Z'), { allDay: true });
  const text = writeCalendar([e]);
  assert.match(text, /DTSTART;VALUE=DATE:20261225/);
  assert.equal(parseCalendar(text).events[0].start!.allDay, true);
});

test('long lines fold on byte boundaries without splitting a character', () => {
  const folded = foldLine(`SUMMARY:${'é'.repeat(80)}`);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 76, line.length.toString());
  assert.equal(parseCalendar(ics(['BEGIN:VEVENT', 'UID:m@x', 'DTSTART:20260601T100000Z', folded, 'END:VEVENT'].join('\r\n'))).events[0].summary, 'é'.repeat(80));
});

test('an event with no UID still survives, because plenty of files omit one', () => {
  const e = parseCalendar(ics(['BEGIN:VEVENT', 'DTSTART:20260601T100000Z', 'SUMMARY:Unidentified', 'END:VEVENT'].join('\r\n'))).events[0];
  assert.ok(e.uid.startsWith('tern-'));
  assert.equal(e.summary, 'Unidentified');
});
