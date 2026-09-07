import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWindow } from './index.js';

const iso = (d: Date) => d.toISOString().slice(0, 16);
// What the window's edges read as on the clock it was built for; a correct
// day window starts and ends at local midnight, whatever the offset.
const localMidnights = (w: { from: Date; to: Date }, tz: string) =>
  [w.from, w.to].map((d) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(d));

// The bug this exists for: the daily brief asked for "today" with no zone,
// which meant the UTC day. At eight in the evening in Chicago that is
// already tomorrow, so the brief listed the wrong day's meetings.
test('an evening in Chicago is still today, not tomorrow in UTC', () => {
  const evening = new Date('2026-09-08T01:30:00Z'); // 20:30 on the 7th, Chicago
  const w = dayWindow(evening, 'America/Chicago');
  assert.deepEqual(iso(w.from), '2026-09-07T05:00');
  assert.deepEqual(iso(w.to), '2026-09-08T05:00');
  // And the same instant read as UTC is the following day, which is exactly
  // what the brief used to show.
  assert.deepEqual(iso(dayWindow(evening).from), '2026-09-08T00:00');
});

test('a morning east of Greenwich is today rather than yesterday', () => {
  const morning = new Date('2026-09-07T23:00:00Z'); // 08:00 on the 8th, Tokyo
  const w = dayWindow(morning, 'Asia/Tokyo');
  assert.deepEqual(localMidnights(w, 'Asia/Tokyo'), ['2026-09-08 00:00', '2026-09-09 00:00']);
});

test('the window is exactly one local day, whichever zone it is', () => {
  for (const tz of ['UTC', 'Europe/London', 'America/Chicago', 'Asia/Kolkata', 'Pacific/Auckland']) {
    const w = dayWindow(new Date('2026-06-15T12:00:00Z'), tz);
    const [start, end] = localMidnights(w, tz);
    assert.match(start, /00:00$/, `${tz} start`);
    assert.match(end, /00:00$/, `${tz} end`);
    assert.equal(w.to.getTime() - w.from.getTime(), 86_400_000, tz);
  }
});

// A fixed 24-hour span would drop the last meeting of a 25-hour day and
// borrow one from the next on a 23-hour day.
test('a day that gains an hour is 25 hours long, and one that loses an hour is 23', () => {
  const autumn = dayWindow(new Date('2026-10-25T12:00:00Z'), 'Europe/London');
  assert.equal((autumn.to.getTime() - autumn.from.getTime()) / 3_600_000, 25);
  assert.deepEqual(localMidnights(autumn, 'Europe/London'), ['2026-10-25 00:00', '2026-10-26 00:00']);

  const spring = dayWindow(new Date('2026-03-29T12:00:00Z'), 'Europe/London');
  assert.equal((spring.to.getTime() - spring.from.getTime()) / 3_600_000, 23);
  assert.deepEqual(localMidnights(spring, 'Europe/London'), ['2026-03-29 00:00', '2026-03-30 00:00']);
});

test('a zone the browser made up falls back to UTC rather than throwing', () => {
  const w = dayWindow(new Date('2026-09-07T12:00:00Z'), 'Not/AZone');
  assert.deepEqual(iso(w.from), '2026-09-07T00:00');
  assert.deepEqual(iso(dayWindow(new Date('2026-09-07T12:00:00Z'), '').from), '2026-09-07T00:00');
});
