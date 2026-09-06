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

test('a leading dash excludes a word', () => {
  const s = parseSearch('invoice -draft -"internal only"');
  assert.equal(s.text, 'invoice');
  assert.equal(s.exclude, 'draft internal only');
});

test('a lone dash is a word, not an exclusion', () => {
  const s = parseSearch('a - b');
  assert.equal(s.exclude, undefined);
});

test('an operator is not mistaken for an exclusion', () => {
  const s = parseSearch('-from:alice invoice');
  // A negated operator is not supported; it must not silently become a
  // required word or swallow the operator's value.
  assert.equal(s.from, undefined);
  assert.equal(s.text.includes('invoice'), true);
});

test('nothing to exclude leaves the field unset', () => {
  assert.equal(parseSearch('plain words').exclude, undefined);
});
