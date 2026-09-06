import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery, EMPTY_SEARCH, parseSearchQuery } from './search';

test('builds operators from fields', () => {
  assert.equal(buildSearchQuery({ from: 'bob', subject: 'quarterly plan', words: 'budget', has: 'attachment', within: '7d', unread: true }), 'from:bob subject:"quarterly plan" has:attachment is:unread newer_than:7d budget');
});
test('negated words get a dash each', () => {
  assert.equal(buildSearchQuery({ not: 'newsletter -promo' }), '-newsletter -promo');
});
test('empty fields produce an empty query', () => {
  assert.equal(buildSearchQuery({}), '');
  assert.equal(buildSearchQuery({ from: '  ', words: '' }), '');
});
test('folder becomes in:', () => {
  assert.equal(buildSearchQuery({ box: 'Leads 2026' }), 'in:"Leads 2026"');
  assert.equal(buildSearchQuery({ box: 'sent' }), 'in:sent');
});
test('starred', () => { assert.equal(buildSearchQuery({ starred: true }), 'is:starred'); });
test('parses back what it built', () => {
  const f = { ...EMPTY_SEARCH, from: 'bob', to: 'alice@probe.test', subject: 'quarterly plan', words: 'budget draft', not: 'promo', has: 'attachment' as const, within: '30d' as const, box: 'inbox', unread: true, starred: true };
  assert.deepEqual(parseSearchQuery(buildSearchQuery(f)), f);
});
test('parses free text with quotes and unknown operators as words', () => {
  const f = parseSearchQuery('larger:1m "exact phrase" hello');
  assert.equal(f.words, 'larger:1m "exact phrase" hello');
});
test('is:flagged means starred, label: means folder', () => {
  const f = parseSearchQuery('is:flagged label:Leads');
  assert.equal(f.starred, true);
  assert.equal(f.box, 'Leads');
});
test('a lone dash is a word, not a negation', () => {
  assert.equal(parseSearchQuery('a - b').words, 'a - b');
});
test('empty and whitespace queries', () => {
  assert.deepEqual(parseSearchQuery(''), EMPTY_SEARCH);
  assert.deepEqual(parseSearchQuery('   '), EMPTY_SEARCH);
});
test('unsupported within values fall back to words', () => {
  assert.equal(parseSearchQuery('newer_than:2w').words, 'newer_than:2w');
});
