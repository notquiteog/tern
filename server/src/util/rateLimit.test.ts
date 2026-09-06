import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRateLimits, take } from './rateLimit.js';

test('a bucket allows perMinute calls, then refuses until the window moves', () => {
  resetRateLimits();
  for (let i = 0; i < 3; i++) assert.equal(take('t|u1', 3), true);
  assert.equal(take('t|u1', 3), false);
  // Another key is independent.
  assert.equal(take('t|u2', 3), true);
});

test('old entries expire with the window', () => {
  resetRateLimits();
  assert.equal(take('w|x', 1, 1), true);
  assert.equal(take('w|x', 1, 1), false);
  const until = Date.now() + 3;
  while (Date.now() < until) { /* spin past the 1 ms window */ }
  assert.equal(take('w|x', 1, 1), true);
});
