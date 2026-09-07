import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueIn } from './format';

// Fixed points relative to "now", built from calendar days rather than
// milliseconds so the tests do not flip when they run near midnight.
function atNoon(offsetDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(12, 0, 0, 0);
  return d;
}

test('nothing to say without a date', () => {
  assert.equal(dueIn(null), null);
  assert.equal(dueIn(undefined), null);
  assert.equal(dueIn(''), null);
  assert.equal(dueIn('not a date'), null);
});

test('late is counted in days and says so', () => {
  assert.deepEqual(dueIn(atNoon(-1)), { label: 'A day late', late: true, today: false });
  assert.deepEqual(dueIn(atNoon(-4)), { label: '4 days late', late: true, today: false });
});

test('only today carries the flag callers colour on', () => {
  assert.deepEqual(dueIn(atNoon(0)), { label: 'Due today', late: false, today: true });
  assert.deepEqual(dueIn(atNoon(1)), { label: 'Due tomorrow', late: false, today: false });
  assert.equal(dueIn(atNoon(3))!.today, false);
});

// An hour before midnight is still today, and an hour after it is tomorrow —
// which is only true if the difference is measured between calendar days.
test('the boundary is midnight, not twenty-four hours', () => {
  const late = new Date(); late.setHours(23, 30, 0, 0);
  assert.equal(dueIn(late)!.label, 'Due today');
  const early = new Date(); early.setDate(early.getDate() + 1); early.setHours(0, 30, 0, 0);
  assert.equal(dueIn(early)!.label, 'Due tomorrow');
});

test('inside the week it names the day', () => {
  const d = atNoon(4);
  assert.equal(dueIn(d)!.label, `Due ${d.toLocaleDateString([], { weekday: 'long' })}`);
});

// Beyond a week a weekday name stops locating anything, so it falls back to
// a date. Asserted as "not the weekday form" rather than against a literal,
// which would only be testing the runtime's locale.
test('past the week it goes back to a date', () => {
  const d = atNoon(30);
  const label = dueIn(d)!.label;
  assert.match(label, /^Due /);
  assert.notEqual(label, `Due ${d.toLocaleDateString([], { weekday: 'long' })}`);
  assert.match(label, /\d/);
});

test('takes a string as readily as a Date', () => {
  assert.equal(dueIn(atNoon(0).toISOString())!.label, 'Due today');
});
