import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueChallenge, verifySolution, solveForTest, leadingZeroBits, recordFailure, difficultyFor, clearFailures } from './pow.js';

test('leading zero bits', () => {
  assert.equal(leadingZeroBits(Buffer.from([0, 0, 0x0f])), 20);
  assert.equal(leadingZeroBits(Buffer.from([0x80])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x01])), 7);
});

test('a solved challenge verifies once and only once', () => {
  const c = issueChallenge('login', 'Alice');
  const nonce = solveForTest(c.challenge, c.difficulty);
  verifySolution('login', 'alice', { challenge: c.challenge, nonce });
  assert.throws(() => verifySolution('login', 'alice', { challenge: c.challenge, nonce }), /already used/);
});

test('challenges are bound to purpose and username', () => {
  const c = issueChallenge('login', 'bob');
  const nonce = solveForTest(c.challenge, c.difficulty);
  assert.throws(() => verifySolution('register', 'bob', { challenge: c.challenge, nonce }), /does not match/);
  assert.throws(() => verifySolution('login', 'carol', { challenge: c.challenge, nonce }), /does not match/);
  assert.throws(() => verifySolution('login', 'bob', undefined), /required/);
  assert.throws(() => verifySolution('login', 'bob', { challenge: c.challenge + 'x', nonce }), /failed/);
});

test('difficulty climbs with failures and resets on success', () => {
  const base = difficultyFor('login', 'dave');
  for (let i = 0; i < 6; i++) recordFailure('login', 'dave');
  assert.ok(difficultyFor('login', 'dave') > base);
  clearFailures('login', 'dave');
  assert.equal(difficultyFor('login', 'dave'), base);
});
