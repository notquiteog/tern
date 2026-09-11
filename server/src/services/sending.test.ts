import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactWindowOpen, effectiveCap, isWindowOpen, jitterMs, nextContactWindow, nextWindowOpen, sendingBlocked, warmupProgress } from './sending.js';

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

test('sendingBlocked answers the cap and window questions without claiming a slot', async () => {
  const base: any = { id: -1, enabled: true, daily_cap: 40, jitter_enabled: false, jitter_min_s: 0, jitter_max_s: 0, send_window: w };
  // A disabled account is refused before anything is looked up.
  const off = await sendingBlocked({ ...base, enabled: false });
  assert.equal(off?.reason, 'disabled');
  assert.ok(off!.retryAt.getTime() > Date.now());
  // A window that excludes today is shut whatever the hour, and the retry
  // is the next day it opens.
  const notToday = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== new Date().getUTCDay());
  const shut = await sendingBlocked({ ...base, send_window: { start: 0, end: 24, tz: 'UTC', days: notToday } });
  assert.equal(shut?.reason, 'window');
  assert.ok(shut!.retryAt.getTime() > Date.now());
});

// ---------- The ramp ----------

const rampBase = {
  daily_cap: 40,
  send_window: { start: 9, end: 17, days: [1, 2, 3, 4, 5], tz: 'UTC' },
  warmup_enabled: true,
  warmup_started_at: new Date('2026-09-01T10:00:00Z'),
  warmup_start_cap: 20,
  warmup_step: 5,
};

test('a ramp starts where it was told to and climbs a step a day', () => {
  // Day one is the start cap, not the start cap plus a step: somebody who
  // wrote 20 expects the first day to be 20.
  assert.equal(effectiveCap(rampBase, new Date('2026-09-01T10:30:00Z')), 20);
  assert.equal(effectiveCap(rampBase, new Date('2026-09-02T10:00:00Z')), 25);
  assert.equal(effectiveCap(rampBase, new Date('2026-09-05T10:00:00Z')), 40);
});

test('the ramp changes overnight, not at the hour it was switched on', () => {
  // Started at 10:00. An hour later is still day one; the following midnight
  // is day two. A cap that went up mid-morning would read as a bug.
  assert.equal(effectiveCap(rampBase, new Date('2026-09-01T23:59:00Z')), 20);
  assert.equal(effectiveCap(rampBase, new Date('2026-09-02T00:01:00Z')), 25);
});

test('the configured cap is a ceiling a ramp cannot lift', () => {
  // Well past the end of the ramp.
  assert.equal(effectiveCap(rampBase, new Date('2027-01-01T10:00:00Z')), 40);
  // And a start cap above the ceiling is still the ceiling.
  assert.equal(effectiveCap({ ...rampBase, warmup_start_cap: 500 }, new Date('2026-09-01T10:00:00Z')), 40);
});

test('an account with no ramp is capped exactly as before', () => {
  assert.equal(effectiveCap({ ...rampBase, warmup_enabled: false }), 40);
  // Enabled but never started is not a ramp either, and must not silently
  // drop the account to the start cap.
  assert.equal(effectiveCap({ ...rampBase, warmup_started_at: null }), 40);
});

test('warmupProgress says which day it is and when it is over', () => {
  const d1 = warmupProgress(rampBase, new Date('2026-09-01T12:00:00Z'));
  assert.equal(d1?.day, 1);
  assert.equal(d1?.cap, 20);
  assert.equal(d1?.done, false);
  assert.equal(warmupProgress(rampBase, new Date('2026-09-05T12:00:00Z'))?.done, true);
  assert.equal(warmupProgress({ ...rampBase, warmup_enabled: false }), null);
});

// ---------- The recipient's own morning ----------

const win = { start: 9, end: 17, days: [1, 2, 3, 4, 5], tz: 'Europe/London' };

test('a send is held until it is office hours where they are', () => {
  // 09:30 in London on a Wednesday is 01:30 in Los Angeles. Open for the
  // sender, the middle of the night for the recipient.
  const at = new Date('2026-09-09T08:30:00Z');
  assert.equal(isWindowOpen(win, at), true, 'the sender’s window is open');
  assert.equal(contactWindowOpen(win, 'America/Los_Angeles', at), false);
  assert.equal(contactWindowOpen(win, 'Europe/London', at), true);
});

test('a contact with no timezone is sent on the account’s own window', () => {
  // Most contacts have no timezone, and refusing to send to them would be a
  // far worse failure than sending at the sender's hour.
  const at = new Date('2026-09-09T08:30:00Z');
  assert.equal(contactWindowOpen(win, null, at), true);
  assert.equal(contactWindowOpen(win, '', at), true);
});

test('the recipient’s window ignores the sender’s chosen days', () => {
  // A Friday send that is still Thursday evening for them is fine. Re-checking
  // the days would strand contacts a day behind the rest of the campaign.
  const fridayLate = new Date('2026-09-12T01:00:00Z'); // Saturday 10:00 in Tokyo
  assert.equal(isWindowOpen(win, fridayLate), false, 'the sender’s week is over');
  assert.equal(contactWindowOpen(win, 'Asia/Tokyo', fridayLate), true);
});

test('the next local window is a real future instant', () => {
  const at = new Date('2026-09-09T08:30:00Z');
  const next = nextContactWindow(win, 'America/Los_Angeles', at);
  assert.ok(next.getTime() > at.getTime());
  assert.equal(contactWindowOpen(win, 'America/Los_Angeles', next), true);
});
