import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandEvent, overrideFor, parseCalendar, ruleAfterSplit, ruleEndsBefore, ruleUntil, writeCalendar } from './vevent.js';

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\n${body}\r\nEND:VCALENDAR`;
const SERIES = ics([
  'BEGIN:VEVENT', 'UID:standup@x', 'DTSTART:20260907T090000Z', 'DTEND:20260907T091500Z',
  'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Stand-up', 'END:VEVENT',
].join('\r\n'));
const at = (o: { start: Date }[]) => o.map((x) => x.start.toISOString().slice(0, 16));
const load = (text: string) => {
  const p = parseCalendar(text);
  return { master: p.events.find((e) => !e.recurrenceId)!, overrides: p.events.filter((e) => e.recurrenceId) };
};
const span = (a: string, b: string) => [new Date(a), new Date(b)] as const;
const WINDOW = span('2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z');

test('a rule truncated at an occurrence stops before it', () => {
  const rule = ruleUntil('FREQ=WEEKLY;COUNT=6', new Date('2026-09-21T09:00:00Z'));
  assert.equal(rule, 'FREQ=WEEKLY;UNTIL=20260921T085959Z');
  // The COUNT has to go, or the two halves of a split series both count to six.
  assert.equal(/COUNT/.test(rule), false);
});

test('truncation is what decides where the first half ends', () => {
  const { master } = load(SERIES);
  master.rrule = ruleUntil(master.rrule!, new Date('2026-09-21T09:00:00Z'));
  assert.deepEqual(at(expandEvent(master, [], ...WINDOW)), ['2026-09-07T09:00', '2026-09-14T09:00']);
});

test('changing one occurrence leaves the others exactly where they were', () => {
  const { master, overrides } = load(SERIES);
  const one = overrideFor(master, overrides, new Date('2026-09-21T09:00:00Z'));
  one.summary = 'Stand-up (late)';
  one.start = { ...one.start!, at: new Date('2026-09-21T11:00:00Z') };
  one.end = { ...one.end!, at: new Date('2026-09-21T111500Z'.replace('111500Z', '11:15:00Z')) };
  const back = load(writeCalendar([master, ...overrides]));
  const occ = expandEvent(back.master, back.overrides, ...WINDOW);
  assert.deepEqual(at(occ), [
    '2026-09-07T09:00', '2026-09-14T09:00', '2026-09-21T11:00',
    '2026-09-28T09:00', '2026-10-05T09:00', '2026-10-12T09:00',
  ]);
  assert.equal(occ[2].override?.summary, 'Stand-up (late)');
});

test('an override seeded from the master is a complete event on its own', () => {
  const { master, overrides } = load(ics([
    'BEGIN:VEVENT', 'UID:a@x', 'DTSTART:20260907T090000Z', 'DTEND:20260907T093000Z', 'RRULE:FREQ=DAILY',
    'SUMMARY:Title', 'LOCATION:Room 2', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:sam@example.com',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:Soon', 'END:VALARM', 'END:VEVENT',
  ].join('\r\n')));
  const one = overrideFor(master, overrides, new Date('2026-09-09T09:00:00Z'));
  assert.equal(one.summary, 'Title');
  assert.equal(one.location, 'Room 2');
  assert.deepEqual(one.attendees.map((a) => a.email), ['sam@example.com']);
  assert.deepEqual(one.alarms, [10]);
  // Its length is the master's, not zero.
  assert.equal(one.end!.at.getTime() - one.start!.at.getTime(), 30 * 60_000);
  // And asking again returns the same one rather than making a second.
  assert.equal(overrideFor(master, overrides, new Date('2026-09-09T09:00:00Z')), one);
  assert.equal(overrides.length, 1);
});

test('deleting one occurrence is an EXDATE and removes only that one', () => {
  const { master, overrides } = load(SERIES);
  master.exdates.push(new Date('2026-09-21T09:00:00Z'));
  const back = load(writeCalendar([master, ...overrides]));
  assert.deepEqual(at(expandEvent(back.master, back.overrides, ...WINDOW)), [
    '2026-09-07T09:00', '2026-09-14T09:00', '2026-09-28T09:00', '2026-10-05T09:00', '2026-10-12T09:00',
  ]);
});

test('a rule is recognised as finished before a date, or not', () => {
  assert.equal(ruleEndsBefore('FREQ=WEEKLY;UNTIL=20260921T085959Z', new Date('2026-09-22T00:00:00Z')), true);
  assert.equal(ruleEndsBefore('FREQ=WEEKLY;UNTIL=20260921T085959Z', new Date('2026-09-01T00:00:00Z')), false);
  assert.equal(ruleEndsBefore('FREQ=WEEKLY', new Date('2030-01-01T00:00:00Z')), false);
  assert.equal(ruleEndsBefore(null, new Date()), true);
});

test('reminders survive a round trip through iCalendar', () => {
  const { master } = load(ics([
    'BEGIN:VEVENT', 'UID:r@x', 'DTSTART:20260907T090000Z', 'DTEND:20260907T093000Z',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n')));
  assert.deepEqual(master.alarms, [15, 60]);
  assert.deepEqual(load(writeCalendar([master])).master.alarms, [15, 60]);
});

test('an alarm that runs somebody else’s automation is not carried around', () => {
  const { master } = load(ics([
    'BEGIN:VEVENT', 'UID:r2@x', 'DTSTART:20260907T090000Z',
    'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-PT30M', 'ATTENDEE:mailto:list@example.com', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT10M', 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n')));
  // The EMAIL alarm is dropped, and so is one that fires *after* the start.
  assert.deepEqual(master.alarms, []);
});

test('a VALARM still does not steal the event’s own fields', () => {
  const { master } = load(ics([
    'BEGIN:VEVENT', 'UID:r3@x', 'DTSTART:20260907T090000Z', 'DTEND:20260907T100000Z', 'SUMMARY:Real',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'DESCRIPTION:Alarm text', 'SUMMARY:Alarm title', 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n')));
  assert.equal(master.summary, 'Real');
  assert.equal(master.description, null);
  assert.deepEqual(master.alarms, [5]);
});

// Caught by the end-to-end suite: splitting "five daily meetings" at the
// third produced two on one side and five on the other. Seven meetings out
// of a series of five.
test('splitting a counted series divides the count rather than duplicating it', () => {
  assert.equal(ruleAfterSplit('FREQ=DAILY;COUNT=5', 2), 'FREQ=DAILY;COUNT=3');
  assert.equal(ruleAfterSplit('FREQ=WEEKLY;BYDAY=MO;COUNT=10', 4), 'FREQ=WEEKLY;BYDAY=MO;COUNT=6');
  // Never below one: a split that leaves nothing is a deletion, and the
  // caller has a path for that.
  assert.equal(ruleAfterSplit('FREQ=DAILY;COUNT=3', 9), 'FREQ=DAILY;COUNT=1');
});

test('a rule bounded by a date, or by nothing, carries over unchanged', () => {
  assert.equal(ruleAfterSplit('FREQ=DAILY;UNTIL=20261231T000000Z', 3), 'FREQ=DAILY;UNTIL=20261231T000000Z');
  assert.equal(ruleAfterSplit('FREQ=WEEKLY;BYDAY=MO,WE', 3), 'FREQ=WEEKLY;BYDAY=MO,WE');
});

test('the two halves of a split add up to the original', () => {
  const { master } = load(SERIES); // FREQ=WEEKLY;COUNT=6
  const at = new Date('2026-09-28T09:00:00Z'); // the fourth occurrence
  const head = { ...master, rrule: ruleUntil(master.rrule!, at) };
  const kept = expandEvent(head, [], new Date('2026-09-01'), new Date('2026-12-01'));
  const tail = { ...master, rrule: ruleAfterSplit(master.rrule!, kept.length), start: { ...master.start!, at, civil: { y: 2026, m: 9, d: 28, hh: 9, mm: 0, ss: 0 } } };
  const rest = expandEvent(tail, [], new Date('2026-09-01'), new Date('2026-12-01'));
  assert.equal(kept.length + rest.length, 6);
  assert.deepEqual(at2(kept), ['2026-09-07T09:00', '2026-09-14T09:00', '2026-09-21T09:00']);
  assert.deepEqual(at2(rest), ['2026-09-28T09:00', '2026-10-05T09:00', '2026-10-12T09:00']);
});

const at2 = at;
