import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem } from './password.js';

test('length is the first rule', () => {
  assert.match(passwordProblem('short', 'alice')!, /at least 10/);
  assert.equal(passwordProblem('a decent passphrase', 'alice'), null);
});

test('the usual worst passwords are refused even with decoration', () => {
  for (const p of ['password123', 'Password123!', 'qwertyuiop', 'iloveyou12', '1234567890', 'letmein123', 'aaaaaaaaaaaa', 'abcdefghijkl']) {
    assert.ok(passwordProblem(p, 'alice'), p);
  }
});

test('a password may not contain the username', () => {
  assert.match(passwordProblem('alice-rules-2026', 'alice')!, /username/);
  assert.match(passwordProblem('xxalice.smithxx', 'alice.smith@example.com')!, /username/);
  assert.equal(passwordProblem('bob-rules-2026', 'alice'), null);
  // Two-letter usernames are too short to be meaningful inside a password.
  assert.equal(passwordProblem('a long enough one', 'al'), null);
});
