// iCalendar as it arrives from real senders: folded lines, escaped text,
// TZID references, DURATION instead of DTEND, and the occasional file that
// is simply wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRrule, mailtoOf, parseDuration, parseIcalendar, parseLine, unescapeText, unfold, zoneOffsetMinutes,
} from './icalendar.js';

const ical = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\n${body}\r\nEND:VCALENDAR\r\n`;

const EVENT = ical([
  'BEGIN:VEVENT',
  'UID:abc-123@corp.example',
  'DTSTAMP:20260901T090000Z',
  'DTSTART:20260910T140000Z',
  'DTEND:20260910T150000Z',
  'SUMMARY:Quarterly review',
  'LOCATION:Room 3\\, second floor',
  'ORGANIZER;CN=Ana Duarte:mailto:ana@corp.example',
  'ATTENDEE;CN=You;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:me@mine.example',
  'SEQUENCE:2',
  'END:VEVENT',
].join('\r\n'));

// ---------- Lines ----------

test('folded lines are rejoined before anything else', () => {
  const lines = unfold('SUMMARY:A very long summ\r\n ary that was folded\r\nUID:x');
  assert.deepEqual(lines, ['SUMMARY:A very long summary that was folded', 'UID:x']);
});

test('a tab continues a line as well as a space', () => {
  assert.deepEqual(unfold('SUMMARY:one\n\ttwo'), ['SUMMARY:onetwo']);
});

test('parameters are read, and a colon inside quotes is not the separator', () => {
  const l = parseLine('ATTENDEE;CN="Duarte, Ana: Finance";ROLE=CHAIR:mailto:ana@corp.example');
  assert.equal(l?.name, 'ATTENDEE');
  assert.equal(l?.params.CN, 'Duarte, Ana: Finance');
  assert.equal(l?.params.ROLE, 'CHAIR');
  assert.equal(l?.value, 'mailto:ana@corp.example');
});

test('escaped text comes back readable', () => {
  assert.equal(unescapeText('Room 3\\, second floor'), 'Room 3, second floor');
  assert.equal(unescapeText('line one\\nline two'), 'line one\nline two');
  assert.equal(unescapeText('a\\\\b'), 'a\\b');
});

// ---------- A whole invitation ----------

test('an invitation is read end to end', () => {
  const doc = parseIcalendar(EVENT);
  assert.equal(doc.method, 'REQUEST');
  assert.equal(doc.events.length, 1);
  const e = doc.events[0];
  assert.equal(e.uid, 'abc-123@corp.example');
  assert.equal(e.summary, 'Quarterly review');
  assert.equal(e.location, 'Room 3, second floor');
  assert.equal(e.organizer?.email, 'ana@corp.example');
  assert.equal(e.organizer?.name, 'Ana Duarte');
  assert.equal(e.attendees.length, 1);
  assert.equal(e.attendees[0].partstat, 'NEEDS-ACTION');
  assert.equal(e.start?.toISOString(), '2026-09-10T14:00:00.000Z');
  assert.equal(e.end?.toISOString(), '2026-09-10T15:00:00.000Z');
  assert.equal(e.sequence, 2);
  assert.equal(e.approximate, false);
});

test('an all-day event is marked as one', () => {
  const doc = parseIcalendar(ical(['BEGIN:VEVENT', 'UID:x', 'DTSTART;VALUE=DATE:20260910', 'DTEND;VALUE=DATE:20260911', 'SUMMARY:Leave', 'END:VEVENT'].join('\r\n')));
  assert.equal(doc.events[0].allDay, true);
  assert.equal(doc.events[0].start?.toISOString(), '2026-09-10T00:00:00.000Z');
});

test('DURATION fills in a missing DTEND', () => {
  const doc = parseIcalendar(ical(['BEGIN:VEVENT', 'UID:x', 'DTSTART:20260910T140000Z', 'DURATION:PT90M', 'SUMMARY:Call', 'END:VEVENT'].join('\r\n')));
  assert.equal(doc.events[0].end?.toISOString(), '2026-09-10T15:30:00.000Z');
});

test('durations parse in the shapes iCalendar allows', () => {
  assert.equal(parseDuration('PT1H'), 3600_000);
  assert.equal(parseDuration('P1DT2H30M'), (26 * 3600 + 1800) * 1000);
  assert.equal(parseDuration('P2W'), 14 * 86400_000);
  assert.equal(parseDuration('nonsense'), null);
});

// ---------- Time zones ----------

test('a TZID is resolved from the file’s own VTIMEZONE', () => {
  const doc = parseIcalendar(ical([
    'BEGIN:VTIMEZONE', 'TZID:Custom/Plus2', 'BEGIN:STANDARD', 'TZOFFSETTO:+0200', 'TZOFFSETFROM:+0200', 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID=Custom/Plus2:20260910T140000', 'SUMMARY:Call', 'END:VEVENT',
  ].join('\r\n')));
  assert.equal(doc.events[0].start?.toISOString(), '2026-09-10T12:00:00.000Z');
  assert.equal(doc.events[0].approximate, false);
});

test('a named zone with no VTIMEZONE is resolved from the platform', () => {
  const doc = parseIcalendar(ical(['BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID=America/New_York:20260910T090000', 'SUMMARY:Call', 'END:VEVENT'].join('\r\n')));
  // September is daylight time there, so 09:00 local is 13:00 UTC.
  assert.equal(doc.events[0].start?.toISOString(), '2026-09-10T13:00:00.000Z');
  assert.equal(doc.events[0].approximate, false);
});

test('the platform is asked, not a table that would go stale', () => {
  const winter = zoneOffsetMinutes('Europe/London', new Date('2026-01-15T12:00:00Z'));
  const summer = zoneOffsetMinutes('Europe/London', new Date('2026-07-15T12:00:00Z'));
  assert.equal(winter, 0);
  assert.equal(summer, 60);
  assert.equal(zoneOffsetMinutes('Not/AZone', new Date()), null);
});

test('a floating time is used but flagged as a guess', () => {
  const doc = parseIcalendar(ical(['BEGIN:VEVENT', 'UID:x', 'DTSTART:20260910T140000', 'SUMMARY:Call', 'END:VEVENT'].join('\r\n')));
  assert.equal(doc.events[0].approximate, true, 'nothing downstream may show this as an exact time');
  assert.ok(doc.events[0].start);
});

// ---------- Repeats ----------

test('a repeat is described rather than expanded', () => {
  assert.equal(describeRrule('FREQ=WEEKLY'), 'Repeats every week');
  assert.equal(describeRrule('FREQ=WEEKLY;INTERVAL=2'), 'Repeats every 2 weeks');
  assert.equal(describeRrule('FREQ=DAILY;COUNT=5'), 'Repeats every day, 5 times');
  assert.equal(describeRrule('FREQ=MONTHLY;UNTIL=20270101T000000Z'), 'Repeats every month until 2027-01-01');
  assert.equal(describeRrule('FREQ=SECONDLY'), null);
  assert.equal(describeRrule('rubbish'), null);
});

// ---------- Malformed input ----------

test('addresses are validated, not trusted', () => {
  assert.equal(mailtoOf('mailto:Ana@Corp.Example'), 'ana@corp.example');
  assert.equal(mailtoOf('ana@corp.example'), 'ana@corp.example');
  assert.equal(mailtoOf('mailto:not-an-address'), null);
  assert.equal(mailtoOf(''), null);
});

test('an unterminated event is still usable', () => {
  const doc = parseIcalendar('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Truncated\r\nDTSTART:20260910T140000Z');
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].summary, 'Truncated');
});

test('rubbish produces no events rather than an exception', () => {
  for (const s of ['', 'hello', 'BEGIN:VCALENDAR', 'BEGIN:VEVENT\r\nEND:VEVENT']) {
    assert.equal(parseIcalendar(s).events.length, 0, JSON.stringify(s));
  }
});

test('several events in one file all come back, in order', () => {
  const doc = parseIcalendar(ical([
    'BEGIN:VEVENT', 'UID:one', 'SUMMARY:First', 'DTSTART:20260910T140000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:two', 'SUMMARY:Second', 'DTSTART:20260911T140000Z', 'END:VEVENT',
  ].join('\r\n')));
  assert.deepEqual(doc.events.map((e) => e.uid), ['one', 'two']);
});

test('an attendee list is bounded', () => {
  const many = Array.from({ length: 300 }, (_, i) => `ATTENDEE:mailto:p${i}@corp.example`).join('\r\n');
  const doc = parseIcalendar(ical(['BEGIN:VEVENT', 'UID:x', 'SUMMARY:All hands', 'DTSTART:20260910T140000Z', many, 'END:VEVENT'].join('\r\n')));
  assert.equal(doc.events[0].attendees.length, 100);
});
