import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from './projection.js';

// Monday 7 September 2026, so the first simulated day is a working one.
const MON = new Date('2026-09-07T09:00:00Z');
const account = {
  daily_cap: 40,
  send_window: { start: 9, end: 17, days: [1, 2, 3, 4, 5], tz: 'UTC' },
  warmup_enabled: false, warmup_started_at: null, warmup_start_cap: 20, warmup_step: 5,
};
const DAY = 86_400_000;
const enroll = (n: number) => Array.from({ length: n }, () => ({ stepIndex: 0, readyAt: MON.getTime() }));

test('an audience that fits the cap goes out in one day', () => {
  const p = project({ account, steps: [{ waitMsBefore: 0 }], pending: enroll(10), now: MON });
  assert.equal(p.days.length, 1);
  assert.equal(p.days[0]!.first, 10);
  assert.equal(p.days[0]!.full, false);
  assert.equal(p.lastFirstSend, '2026-09-07');
});

test('the cap spreads a big audience over days, and says which are full', () => {
  // The number nobody works out in their head: 100 people, 40 a day.
  const p = project({ account, steps: [{ waitMsBefore: 0 }], pending: enroll(100), now: MON });
  assert.deepEqual(p.days.map((d) => d.first), [40, 40, 20]);
  assert.deepEqual(p.days.map((d) => d.full), [true, true, false]);
  assert.equal(p.lastFirstSend, '2026-09-09');
});

test('sends already made today count against today’s cap', () => {
  const p = project({ account, steps: [{ waitMsBefore: 0 }], pending: enroll(50), now: MON, usedToday: 35 });
  assert.equal(p.days[0]!.first, 5, 'only the unused part of the cap is available');
  assert.equal(p.days[1]!.first, 40);
});

test('the weekend is skipped, because the window says so', () => {
  const p = project({ account, steps: [{ waitMsBefore: 0 }], pending: enroll(200), now: MON });
  const daysUsed = p.days.map((d) => d.day);
  assert.ok(!daysUsed.includes('2026-09-12'), 'Saturday was used');
  assert.ok(!daysUsed.includes('2026-09-13'), 'Sunday was used');
});

test('the answer the projection exists for: when follow-ups start competing', () => {
  // 400 people, a cap of 40, a follow-up three days later. The first sends
  // alone take ten days, so on day four the first cohort's follow-ups come
  // due while there are still 280 people who have not heard anything — and
  // from then on the two are queueing for the same forty slots.
  const p = project({
    account,
    steps: [{ waitMsBefore: 0 }, { waitMsBefore: 3 * DAY }],
    pending: enroll(400),
    now: MON,
  });
  assert.equal(p.contentionFrom, '2026-09-10', 'contention was not spotted on the day the follow-ups came due');
  assert.ok(p.days.find((d) => d.day === p.contentionFrom)!.full, 'a contention day must be a full one');
  // The last person hears from the campaign well after that, which is the
  // number somebody actually wants before enrolling four hundred people.
  assert.ok(p.lastFirstSend! > p.contentionFrom!);
  // And every message eventually goes out.
  const total = p.days.reduce((n, d) => n + d.first + d.followUp, 0);
  assert.equal(total, 800, 'four hundred people times two steps');
});

test('a campaign small enough never reports contention', () => {
  // Ten people and a cap of forty: the follow-ups arrive to an empty queue.
  const p = project({
    account, steps: [{ waitMsBefore: 0 }, { waitMsBefore: 3 * DAY }], pending: enroll(10), now: MON,
  });
  assert.equal(p.contentionFrom, null);
});

test('a warm-up ramp is what limits the early days', () => {
  const ramped = {
    ...account,
    warmup_enabled: true,
    warmup_started_at: MON,
    warmup_start_cap: 10,
    warmup_step: 10,
  };
  const p = project({ account: ramped, steps: [{ waitMsBefore: 0 }], pending: enroll(100), now: MON });
  assert.equal(p.days[0]!.cap, 10);
  assert.equal(p.days[0]!.first, 10);
  assert.equal(p.days[1]!.cap, 20);
  assert.equal(p.days[1]!.first, 20);
});

test('an empty campaign projects nothing rather than failing', () => {
  const p = project({ account, steps: [{ waitMsBefore: 0 }], pending: [], now: MON });
  assert.deepEqual(p.days, []);
  assert.equal(p.lastFirstSend, null);
  assert.equal(p.truncated, false);
});

test('an audience too big for the horizon says so instead of lying', () => {
  const p = project({ account, steps: [{ waitMsBefore: 0 }], pending: enroll(20_000), now: MON });
  assert.equal(p.truncated, true);
});
