import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferUntil, housekeepingJobs, MAX_DEFER_MS, nextRunAfterSend } from './scheduler.js';

test('a deferral inside the cap keeps its own time, plus a little jitter', () => {
  const soon = new Date(Date.now() + 60_000);
  for (let i = 0; i < 50; i++) {
    const at = deferUntil(soon);
    assert.ok(at.getTime() >= soon.getTime());
    assert.ok(at.getTime() <= soon.getTime() + 60_000);
  }
});

test('a long deferral is capped so a widened window is noticed', () => {
  // The shape of the bug this exists for: the window is shut until 09:00
  // tomorrow, the row sleeps until then, and the window is reopened in the
  // meantime. Sleeping the full nine hours would ignore the change.
  const tomorrow = new Date(Date.now() + 9 * 3600_000);
  for (let i = 0; i < 50; i++) {
    const at = deferUntil(tomorrow);
    assert.ok(at.getTime() <= Date.now() + MAX_DEFER_MS + 1000, 'never sleeps past the cap');
    assert.ok(at.getTime() > Date.now(), 'and never wakes in the past');
  }
});

test('the cap is short enough to be useful and long enough to be cheap', () => {
  assert.ok(MAX_DEFER_MS >= 5 * 60_000 && MAX_DEFER_MS <= 30 * 60_000);
});

const noJitter = { jitter_enabled: false, jitter_min_s: 0, jitter_max_s: 0 };
const wait4d: any = { kind: 'wait', wait_days: 4, wait_hours: 0 };

test('the step after the last one ends the sequence', () => {
  assert.equal(nextRunAfterSend(undefined, noJitter), null);
});

test('a wait step is made due, not scheduled: the delay is applied once', () => {
  // The regression: pre-computing the wait here as well as in the wait branch
  // turned a four-day gap into eight.
  const at = nextRunAfterSend(wait4d, noJitter)!;
  assert.ok(at.getTime() <= Date.now() + 1000, 'due now, not four days out');
  assert.ok(at.getTime() > Date.now() - 1000);
});

test('a following email waits out the randomised gap, never under a minute', () => {
  const quick = nextRunAfterSend({ kind: 'email' } as any, noJitter)!;
  assert.ok(quick.getTime() >= Date.now() + 59_000, 'a floor of one minute with jitter off');
  for (let i = 0; i < 25; i++) {
    const at = nextRunAfterSend({ kind: 'email' } as any, { jitter_enabled: true, jitter_min_s: 120, jitter_max_s: 180 })!;
    const gap = at.getTime() - Date.now();
    assert.ok(gap >= 119_000 && gap <= 181_000, `gap ${gap} inside the jitter range`);
  }
});

test('every housekeeping sweep is given exactly the parameters it uses', () => {
  // The whole set used to share one array of seven, so a statement with no
  // placeholder was handed seven values and Postgres refused it. Nothing was
  // deleted and the only sign was a warning line per sweep, per hour.
  const jobs = housekeepingJobs({
    outboxDays: 1, reviewDays: 2, aiJobHours: 3, auditDays: 4,
    briefDays: 5, commitmentDays: 6, calendarDays: 7,
  } as any);
  assert.ok(jobs.length >= 10, 'the sweeps are all still here');
  for (const [name, sql, args] of jobs) {
    const used = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const highest = used.length ? Math.max(...used) : 0;
    assert.equal(highest, args.length, `${name} references $1..$${highest} but is given ${args.length} value(s)`);
    for (let i = 1; i <= highest; i++) assert.ok(used.includes(i), `${name} skips $${i}, which Postgres will not accept`);
  }
});
