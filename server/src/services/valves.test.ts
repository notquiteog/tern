import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SAMPLE, verdict } from './valves.js';

const limits = { bouncePct: 8, unsubscribes: 5 };

test('a clean campaign trips nothing', () => {
  const v = verdict({ sent: 200, bounced: 2, unsubscribedToday: 1 }, limits);
  assert.equal(v.tripped, null);
  assert.equal(v.bouncePct, 1);
});

test('a bounce rate means nothing until there are enough sends', () => {
  // One bounce out of the first two sends is fifty per cent and is evidence of
  // nothing. Pausing on it would stop every campaign on its second morning.
  assert.equal(verdict({ sent: 2, bounced: 1, unsubscribedToday: 0 }, limits).tripped, null);
  assert.equal(verdict({ sent: MIN_SAMPLE - 1, bounced: 10, unsubscribedToday: 0 }, limits).tripped, null);
  // One more send and the same rate is now describing the list.
  assert.ok(verdict({ sent: MIN_SAMPLE, bounced: 10, unsubscribedToday: 0 }, limits).tripped);
});

test('the bounce message says the numbers, not just that it stopped', () => {
  // The sentence goes into a push notification, where it is the whole of what
  // somebody away from their desk gets to read.
  const v = verdict({ sent: 50, bounced: 6, unsubscribedToday: 0 }, limits);
  assert.match(v.tripped!, /6 of 50/);
  assert.match(v.tripped!, /12%/);
  assert.match(v.tripped!, /8% limit/);
});

test('unsubscribes trip on their own, with no sample requirement', () => {
  // Five people leaving in a day is a statement about the brief whether the
  // campaign has sent twenty messages or two thousand.
  const v = verdict({ sent: 6, bounced: 0, unsubscribedToday: 5 }, limits);
  assert.ok(v.tripped);
  assert.match(v.tripped!, /5 people unsubscribed/);
  assert.equal(verdict({ sent: 6, bounced: 0, unsubscribedToday: 4 }, limits).tripped, null);
});

test('zero turns a valve off', () => {
  // How somebody who knows their list opts out, without a separate switch.
  assert.equal(verdict({ sent: 500, bounced: 400, unsubscribedToday: 0 }, { bouncePct: 0, unsubscribes: 5 }).tripped, null);
  assert.equal(verdict({ sent: 500, bounced: 0, unsubscribedToday: 90 }, { bouncePct: 8, unsubscribes: 0 }).tripped, null);
  assert.equal(verdict({ sent: 500, bounced: 400, unsubscribedToday: 90 }, { bouncePct: 0, unsubscribes: 0 }).tripped, null);
});

test('bounces are reported ahead of unsubscribes when both have tripped', () => {
  // Both are true; the dead-list one is the more urgent and the more
  // actionable, and two reasons in one sentence reads as neither.
  const v = verdict({ sent: 100, bounced: 30, unsubscribedToday: 20 }, limits);
  assert.match(v.tripped!, /bounced/);
});

test('a campaign that has sent nothing divides by nothing safely', () => {
  const v = verdict({ sent: 0, bounced: 0, unsubscribedToday: 0 }, limits);
  assert.equal(v.bouncePct, 0);
  assert.equal(v.tripped, null);
});
