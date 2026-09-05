import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from './search.js';

test('parseSearch splits operators from free text', () => {
  const s = parseSearch('from:alice subject:"quarterly report" is:unread has:attachment newer_than:7d budget plan');
  assert.equal(s.from, 'alice');
  assert.equal(s.subject, 'quarterly report');
  assert.equal(s.unread, true);
  assert.equal(s.attachment, true);
  assert.equal(s.newerDays, 7);
  assert.equal(s.text, 'budget plan');
});

test('parseSearch understands read/starred and sizes', () => {
  const s = parseSearch('is:read is:starred larger:2m older_than:3w');
  assert.equal(s.unread, false);
  assert.equal(s.starred, true);
  assert.equal(s.larger, 2 * 1024 * 1024);
  assert.equal(s.olderDays, 21);
});
