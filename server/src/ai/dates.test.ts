// Dates the tools resolve for themselves.
//
// Every tool that takes a date used to inherit whatever arithmetic the model
// did, and a well-formed wrong date is indistinguishable from a well-formed
// right one — so a deadline lands a week out and nothing says so. Asked for
// "Friday" on a Thursday, qwen3.5:9b produced today; given a table of the next
// fortnight to read it off instead, it produced the second Friday and then
// described a third date in prose. These cases are the ones that stopped it
// mattering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDate } from './tools.js';

// Thursday 10 September 2026, mid-morning.
const THU = new Date('2026-09-10T09:00:00Z');
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

test('a weekday means the next one, never today', () => {
  // The failure that started this: "by Friday" on a Thursday.
  assert.equal(iso(resolveDate('Friday', THU)), '2026-09-11');
  assert.equal(iso(resolveDate('friday', THU)), '2026-09-11');
  assert.equal(iso(resolveDate('on Friday', THU)), '2026-09-11');
  // "See you Thursday" said on a Thursday means the one coming, not today —
  // a deadline of today that the person called Thursday would be a surprise.
  assert.equal(iso(resolveDate('Thursday', THU)), '2026-09-17');
});

test('"next" pushes it a week further out', () => {
  assert.equal(iso(resolveDate('next Friday', THU)), '2026-09-18');
  assert.equal(iso(resolveDate('next Monday', THU)), '2026-09-21');
  // "this Friday" is the ordinary one, not a week away.
  assert.equal(iso(resolveDate('this Friday', THU)), '2026-09-11');
});

test('the everyday words', () => {
  assert.equal(iso(resolveDate('today', THU)), '2026-09-10');
  assert.equal(iso(resolveDate('tonight', THU)), '2026-09-10');
  assert.equal(iso(resolveDate('tomorrow', THU)), '2026-09-11');
  assert.equal(iso(resolveDate('in 3 days', THU)), '2026-09-13');
  assert.equal(iso(resolveDate('in 2 weeks', THU)), '2026-09-24');
});

test('a date the model worked out itself still works', () => {
  assert.equal(iso(resolveDate('2026-09-14', THU)), '2026-09-14');
  assert.equal(resolveDate('2026-09-14T15:30:00Z', THU)?.toISOString(), '2026-09-14T15:30:00.000Z');
});

test('nothing usable resolves to nothing rather than to today', () => {
  // Silently meaning "today" is how a commitment acquires a deadline nobody
  // set, which is worse than having none.
  assert.equal(resolveDate('', THU), null);
  assert.equal(resolveDate(null, THU), null);
  assert.equal(resolveDate('sometime soon', THU), null);
  assert.equal(resolveDate('whenever', THU), null);
});

test('the day is taken in the person\'s zone, not in UTC', () => {
  // 23:00 on the 10th in Sydney is still the 10th there and already the 11th
  // in UTC — asking for "tomorrow" must not skip a day.
  const lateInSydney = new Date('2026-09-10T13:00:00Z'); // 23:00 +10
  assert.equal(iso(resolveDate('today', lateInSydney, 'Australia/Sydney')), '2026-09-10');
  assert.equal(iso(resolveDate('tomorrow', lateInSydney, 'Australia/Sydney')), '2026-09-11');
});
