import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRrule, parseRrule, utcToCivil, type Civil } from './recurrence.js';

const civil = (s: string): Civil => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)!;
  return { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +(m[6] ?? 0) };
};
// Occurrences as they read in the event's own zone, which is the only way to
// check a rule's intent rather than an offset.
const inZone = (dates: Date[], tz: string) => dates.map((d) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(d).replace(' ', 'T'));
const utc = (dates: Date[]) => dates.map((d) => d.toISOString().slice(0, 16));

function run(rrule: string, start: string, opts: Parameters<typeof expandRrule>[2] = {}) {
  const rule = parseRrule(rrule);
  assert.ok(rule, `unparsed: ${rrule}`);
  return expandRrule(rule!, civil(start), { limit: 40, ...opts });
}

test('a plain weekly repeat keeps its weekday', () => {
  assert.deepEqual(utc(run('FREQ=WEEKLY;COUNT=4', '2026-09-07T09:00')), [
    '2026-09-07T09:00', '2026-09-14T09:00', '2026-09-21T09:00', '2026-09-28T09:00',
  ]);
});

test('INTERVAL and COUNT are both honoured', () => {
  assert.deepEqual(utc(run('FREQ=DAILY;INTERVAL=3;COUNT=3', '2026-01-01T08:30')), [
    '2026-01-01T08:30', '2026-01-04T08:30', '2026-01-07T08:30',
  ]);
});

// RFC 5545's own example: every other week on Monday, Wednesday and Friday.
test('a fortnightly BYDAY expands within each active week and skips the others', () => {
  const got = utc(run('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=6;WKST=SU', '2026-01-05T09:00'));
  assert.deepEqual(got, [
    '2026-01-05T09:00', '2026-01-07T09:00', '2026-01-09T09:00',
    '2026-01-19T09:00', '2026-01-21T09:00', '2026-01-23T09:00',
  ]);
});

test('the last Friday of the month is found, including in a five-Friday month', () => {
  assert.deepEqual(utc(run('FREQ=MONTHLY;BYDAY=-1FR;COUNT=4', '2026-01-30T17:00')), [
    '2026-01-30T17:00', '2026-02-27T17:00', '2026-03-27T17:00', '2026-04-24T17:00',
  ]);
});

test('the second Tuesday is the second, not the Tuesday of the second week', () => {
  assert.deepEqual(utc(run('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '2026-09-08T10:00')), [
    '2026-09-08T10:00', '2026-10-13T10:00', '2026-11-10T10:00',
  ]);
});

// The classic wrong answer here is a meeting on the 28th of February.
test('a monthly on the 31st skips the months that have none rather than clamping', () => {
  assert.deepEqual(utc(run('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4', '2026-01-31T12:00')), [
    '2026-01-31T12:00', '2026-03-31T12:00', '2026-05-31T12:00', '2026-07-31T12:00',
  ]);
});

test('BYSETPOS picks from the whole period, so the last weekday of the month works', () => {
  assert.deepEqual(utc(run('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4', '2026-01-30T16:00')), [
    '2026-01-30T16:00', '2026-02-27T16:00', '2026-03-31T16:00', '2026-04-30T16:00',
  ]);
});

test('a yearly repeat lands on the same date each year', () => {
  assert.deepEqual(utc(run('FREQ=YEARLY;COUNT=3', '2026-03-14T09:00')), [
    '2026-03-14T09:00', '2027-03-14T09:00', '2028-03-14T09:00',
  ]);
});

test('a yearly BYMONTH with an ordinal BYDAY counts within the month', () => {
  assert.deepEqual(utc(run('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3', '2026-11-26T12:00')), [
    '2026-11-26T12:00', '2027-11-25T12:00', '2028-11-23T12:00',
  ]);
});

test('UNTIL ends the series and is inclusive of an occurrence exactly on it', () => {
  assert.deepEqual(utc(run('FREQ=DAILY;UNTIL=20260110T090000Z', '2026-01-08T09:00')), [
    '2026-01-08T09:00', '2026-01-09T09:00', '2026-01-10T09:00',
  ]);
});

test('EXDATE removes an occurrence without shifting the rest or the COUNT', () => {
  const got = utc(run('FREQ=DAILY;COUNT=4', '2026-02-02T09:00', { exdates: [new Date('2026-02-03T09:00:00Z')] }));
  assert.deepEqual(got, ['2026-02-02T09:00', '2026-02-04T09:00', '2026-02-05T09:00']);
});

test('RDATE adds a one-off outside the rule', () => {
  const got = utc(run('FREQ=WEEKLY;COUNT=2', '2026-02-02T09:00', { rdates: [new Date('2026-02-05T14:00:00Z')] }));
  assert.deepEqual(got, ['2026-02-02T09:00', '2026-02-05T14:00', '2026-02-09T09:00']);
});

// The whole reason expansion runs on civil fields. A 09:00 London stand-up is
// 08:00 UTC in winter and 09:00 UTC... no: 09:00 local is 09:00Z in winter and
// 08:00Z in summer. Either way it must stay 09:00 to the person attending.
test('a daily meeting stays at the same wall-clock time across a DST change', () => {
  const got = run('FREQ=DAILY;COUNT=4', '2026-03-27T09:00', { tzid: 'Europe/London' });
  assert.deepEqual(inZone(got, 'Europe/London'), [
    '2026-03-27T09:00', '2026-03-28T09:00', '2026-03-29T09:00', '2026-03-30T09:00',
  ]);
  // And the underlying instants really do shift, which is the point.
  assert.deepEqual(utc(got), [
    '2026-03-27T09:00', '2026-03-28T09:00', '2026-03-29T08:00', '2026-03-30T08:00',
  ]);
});

test('the same holds going the other way, over a northern-autumn change', () => {
  const got = run('FREQ=WEEKLY;COUNT=3', '2026-10-18T08:30', { tzid: 'America/New_York' });
  assert.deepEqual(inZone(got, 'America/New_York'), ['2026-10-18T08:30', '2026-10-25T08:30', '2026-11-01T08:30']);
});

test('a window returns only what falls inside it, and stops there', () => {
  const got = utc(run('FREQ=DAILY', '2026-01-01T09:00', {
    from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-05T00:00:00Z'), limit: 100,
  }));
  assert.deepEqual(got, ['2026-06-01T09:00', '2026-06-02T09:00', '2026-06-03T09:00', '2026-06-04T09:00']);
});

test('an endless rule asked for an endless window is still bounded', () => {
  const got = run('FREQ=DAILY', '2026-01-01T09:00', { limit: 50 });
  assert.equal(got.length, 50);
});

test('rules that cannot be honoured are refused rather than guessed at', () => {
  assert.equal(parseRrule('FREQ=FORTNIGHTLY'), null);
  assert.equal(parseRrule('nonsense'), null);
  assert.equal(parseRrule(''), null);
});

test('a rule that can never match gives up instead of spinning', () => {
  // The 30th of February, for ever.
  assert.deepEqual(run('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-02-01T09:00', { limit: 5 }), []);
});

test('WKST changes which occurrences a fortnightly rule produces', () => {
  const su = utc(run('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;COUNT=4;WKST=SU', '2026-08-04T09:00'));
  const mo = utc(run('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;COUNT=4;WKST=MO', '2026-08-04T09:00'));
  assert.notDeepEqual(su, mo);
});

test('parsing keeps the parts a caller needs to describe the rule', () => {
  const r = parseRrule('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;BYSETPOS=1;COUNT=5;WKST=SU')!;
  assert.equal(r.freq, 'MONTHLY');
  assert.equal(r.interval, 2);
  assert.equal(r.count, 5);
  assert.deepEqual(r.byDay, [{ day: 5, nth: -1 }]);
  assert.deepEqual(r.bySetPos, [1]);
  assert.equal(r.wkst, 0);
});

test('civil fields survive a round trip', () => {
  const c = civil('2026-07-04T13:45:30');
  assert.deepEqual(utcToCivil(Date.UTC(c.y, c.m - 1, c.d, c.hh, c.mm, c.ss)), c);
});
