// The counts cache has one job it must never get wrong: hand back a number
// that is out of date. Everything here is about when an entry is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheStats, clearMailCache, rememberCounts, touchAccount, touchAccounts, versionOf } from './mailCache.js';

const counts = (n: number) => ({ primary: { n, unread: 0 } });

test('a second ask for the same key does not recompute', async () => {
  clearMailCache();
  let ran = 0;
  const compute = async () => { ran++; return counts(7); };
  const a = await rememberCounts('k1', [1], compute);
  const b = await rememberCounts('k1', [1], compute);
  assert.equal(ran, 1);
  assert.deepEqual(a, b);
  assert.equal(b.primary.n, 7);
});

test('touching the account drops the entry', async () => {
  clearMailCache();
  let n = 1;
  const compute = async () => counts(n);
  assert.equal((await rememberCounts('k2', [4], compute)).primary.n, 1);
  n = 2;
  // Still cached, so still the old number.
  assert.equal((await rememberCounts('k2', [4], compute)).primary.n, 1);
  // Someone archived something.
  touchAccount(4);
  assert.equal((await rememberCounts('k2', [4], compute)).primary.n, 2);
});

test('any one account in a unified view invalidates it', async () => {
  clearMailCache();
  let n = 1;
  const compute = async () => counts(n);
  await rememberCounts('k3', [10, 11, 12], compute);
  n = 99;
  // A change to the third mailbox must drop a count that spans all three.
  touchAccount(12);
  assert.equal((await rememberCounts('k3', [10, 11, 12], compute)).primary.n, 99);
});

test('an untouched account leaves other keys alone', async () => {
  clearMailCache();
  let n = 5;
  const compute = async () => counts(n);
  await rememberCounts('mine', [20], compute);
  await rememberCounts('theirs', [21], compute);
  n = 6;
  touchAccount(20);
  assert.equal((await rememberCounts('mine', [20], compute)).primary.n, 6, 'the touched one recomputes');
  assert.equal((await rememberCounts('theirs', [21], compute)).primary.n, 5, 'the other one is untouched');
});

test('the version only ever moves forward, and is per account', () => {
  const before = versionOf([30, 31]);
  touchAccount(30);
  const after = versionOf([30, 31]);
  assert.notEqual(before, after);
  // Order is the caller's, so the same set in the same order is stable.
  assert.equal(versionOf([30, 31]), after);
  touchAccounts([30, 31]);
  assert.notEqual(versionOf([30, 31]), after);
});

test('an account nobody has touched still has a version', () => {
  assert.equal(typeof versionOf([9999]), 'string');
  assert.ok(versionOf([9999]).includes('9999'));
  assert.equal(versionOf([]), '');
});

test('the cache does not grow without bound', async () => {
  clearMailCache();
  const compute = async () => counts(1);
  for (let i = 0; i < 400; i++) await rememberCounts(`bulk-${i}`, [1], compute);
  // 300 is the cap; the oldest go first.
  assert.ok(cacheStats().entries <= 300, `grew to ${cacheStats().entries}`);
});
