import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byPerformance, replyRate, RATE_FLOOR } from './templates.js';

test('a rate needs enough sends to be a rate', () => {
  assert.equal(replyRate({ sent_count: 2, reply_count: 2 }), null, 'two out of two is luck, not 100%');
  assert.equal(replyRate({ sent_count: RATE_FLOOR - 1, reply_count: 4 }), null);
  assert.equal(replyRate({ sent_count: RATE_FLOOR, reply_count: 4 }), 50);
  assert.equal(replyRate({ sent_count: 40, reply_count: 9 }), 23);
  assert.equal(replyRate({}), null);
  assert.equal(replyRate({ sent_count: 20, reply_count: 0 }), 0, 'a real zero is a rate and should be shown');
});

test('templates sort by what gets answered, then by starred, then by recency', () => {
  const good = { name: 'good', sent_count: 40, reply_count: 20 };      // 50%
  const poor = { name: 'poor', sent_count: 40, reply_count: 2 };       // 5%
  const starred = { name: 'starred', starred: true, updated_at: '2026-01-01' };
  const fresh = { name: 'fresh', updated_at: '2026-06-01' };
  const stale = { name: 'stale', updated_at: '2025-01-01' };
  const order = [stale, poor, fresh, starred, good].sort(byPerformance).map((t) => t.name);
  assert.deepEqual(order, ['good', 'poor', 'starred', 'fresh', 'stale']);
});

test('an unrated template never outranks a rated one on a zero it has not earned', () => {
  const rated = { name: 'rated', sent_count: 30, reply_count: 0 };     // a real 0%
  const unused = { name: 'unused', starred: true, updated_at: '2030-01-01' };
  assert.deepEqual([unused, rated].sort(byPerformance).map((t) => t.name), ['rated', 'unused']);
});
