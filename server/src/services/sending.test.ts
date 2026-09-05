import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWindowOpen, jitterMs, nextWindowOpen } from './sending.js';

const w = { start: 9, end: 17, days: [1, 2, 3, 4, 5], tz: 'UTC' };

test('isWindowOpen respects hours and weekdays in the given timezone', () => {
  assert.equal(isWindowOpen(w, new Date('2026-09-07T10:00:00Z')), true);   // Monday 10:00
  assert.equal(isWindowOpen(w, new Date('2026-09-07T17:00:00Z')), false);  // closes at 17:00
  assert.equal(isWindowOpen(w, new Date('2026-09-05T10:00:00Z')), false);  // Saturday
  assert.equal(isWindowOpen({ ...w, tz: 'America/New_York' }, new Date('2026-09-07T12:00:00Z')), false); // 08:00 New York
  assert.equal(isWindowOpen({ ...w, tz: 'America/New_York' }, new Date('2026-09-07T14:00:00Z')), true);  // 10:00 New York
});

test('nextWindowOpen skips the weekend', () => {
  const next = nextWindowOpen(w, new Date('2026-09-05T10:00:00Z')); // Saturday
  assert.equal(next.toISOString(), '2026-09-07T09:00:00.000Z');
});

test('jitterMs stays inside the range and is zero when disabled', () => {
  for (let i = 0; i < 50; i++) {
    const ms = jitterMs({ jitter_enabled: true, jitter_min_s: 10, jitter_max_s: 20 });
    assert.ok(ms >= 10_000 && ms <= 20_000);
  }
  assert.equal(jitterMs({ jitter_enabled: false, jitter_min_s: 10, jitter_max_s: 20 }), 0);
});
