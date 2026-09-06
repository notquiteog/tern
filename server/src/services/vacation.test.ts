import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, vacationActive, vacationTarget } from './vacation.js';

const acc: any = { email: 'me@probe.test', send_window: { start: 9, end: 17, days: [1, 2, 3, 4, 5], tz: 'Europe/Berlin' }, vacation: { enabled: true, body: 'Away.', start: null, end: null } };

test('localDay follows the account timezone', () => {
  // 23:30 UTC on 1 Jan is already 2 Jan in Berlin.
  assert.equal(localDay(new Date('2026-01-01T23:30:00Z'), 'Europe/Berlin'), '2026-01-02');
  assert.equal(localDay(new Date('2026-01-01T23:30:00Z'), 'UTC'), '2026-01-01');
});

test('the window honours start and end days and needs a body', () => {
  assert.equal(vacationActive(acc), true);
  assert.equal(vacationActive({ ...acc, vacation: { ...acc.vacation, enabled: false } }), false);
  assert.equal(vacationActive({ ...acc, vacation: { ...acc.vacation, body: '  ' } }), false);
  assert.equal(vacationActive({ ...acc, vacation: { ...acc.vacation, start: '2026-01-10', end: '2026-01-20' } }, new Date('2026-01-05T12:00:00Z')), false);
  assert.equal(vacationActive({ ...acc, vacation: { ...acc.vacation, start: '2026-01-10', end: '2026-01-20' } }, new Date('2026-01-15T12:00:00Z')), true);
  assert.equal(vacationActive({ ...acc, vacation: { ...acc.vacation, start: '2026-01-10', end: '2026-01-20' } }, new Date('2026-01-25T12:00:00Z')), false);
});

test('only real correspondents get the reply', () => {
  const person = { from: [{ name: 'Bob', email: 'bob@example.com' }], to: [{ email: 'me@probe.test' }] };
  assert.deepEqual(vacationTarget(acc, person), { email: 'bob@example.com', name: 'Bob' });
  assert.equal(vacationTarget(acc, { ...person, 'header:List-Id:asText': '<list.example.com>' }), null, 'list mail');
  assert.equal(vacationTarget(acc, { ...person, 'header:Auto-Submitted:asText': 'auto-replied' }), null, 'another auto-reply');
  assert.deepEqual(vacationTarget(acc, { ...person, 'header:Auto-Submitted:asText': 'no' }), { email: 'bob@example.com', name: 'Bob' });
  assert.equal(vacationTarget(acc, { from: [{ email: 'noreply@shop.example' }] }), null, 'no-reply sender');
  assert.equal(vacationTarget(acc, { from: [{ email: 'MAILER-DAEMON@mx.example' }] }), null, 'bounce');
  assert.equal(vacationTarget(acc, { from: [{ email: 'me@probe.test' }], to: [{ email: 'me@probe.test' }] }), null, 'our own mail');
  assert.deepEqual(vacationTarget(acc, { from: [{ email: 'bob@example.com' }], replyTo: [{ name: 'Desk', email: 'desk@example.com' }] }), { email: 'desk@example.com', name: 'Desk' }, 'Reply-To wins');
});
