import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBlocks } from './index.js';

// The shape of the bug this file exists for.
//
// Accepting an invitation puts the meeting in the calendar, so the same
// meeting is then in two places: `calendar_events` (the copy that arrived by
// mail) and `calendar_instances` (the copy in the calendar). Asked whether
// the invitation clashes with anything, a check that counted both answered
// "yes, with itself".
//
// The fix is an exclusion by UID inside the free/busy query, which needs a
// database. What can be pinned down here is the arithmetic either side of
// it: that an excluded event contributes nothing, and that overlapping
// blocks from genuinely different meetings still merge.

interface Block { from: number; to: number; uid: string }

// Stands in for the SQL: the same filter, over rows held in memory.
function busyExcluding(blocks: Block[], excludeUids: string[]): { from: number; to: number }[] {
  const skip = new Set(excludeUids.filter(Boolean));
  return mergeBlocks(blocks.filter((b) => !skip.has(b.uid)).map(({ from, to }) => ({ from, to })));
}

const overlaps = (blocks: { from: number; to: number }[], from: number, to: number) => blocks.some((b) => b.from < to && b.to > from);

const AT_TEN = 10 * 3600_000;
const AT_ELEVEN = 11 * 3600_000;

test('an invitation does not clash with its own copy in the calendar', () => {
  const busy = busyExcluding([{ from: AT_TEN, to: AT_ELEVEN, uid: 'review@example.com' }], ['review@example.com']);
  assert.deepEqual(busy, []);
  assert.equal(overlaps(busy, AT_TEN, AT_ELEVEN), false);
});

test('but a different meeting at the same time still clashes', () => {
  const busy = busyExcluding([
    { from: AT_TEN, to: AT_ELEVEN, uid: 'review@example.com' },
    { from: AT_TEN, to: AT_ELEVEN, uid: 'somebody-else@example.com' },
  ], ['review@example.com']);
  assert.equal(overlaps(busy, AT_TEN, AT_ELEVEN), true);
});

test('excluding one invitation does not hide another one that is genuinely in the way', () => {
  // Two invitations rendered together: each is excluded from the calendar
  // side, because each is already reported from the invitation side. What
  // must survive is everything that is neither of them.
  const busy = busyExcluding([
    { from: AT_TEN, to: AT_ELEVEN, uid: 'a@x' },
    { from: AT_TEN, to: AT_ELEVEN, uid: 'b@x' },
    { from: AT_TEN + 30 * 60_000, to: AT_ELEVEN, uid: 'standup@x' },
  ], ['a@x', 'b@x']);
  assert.deepEqual(busy, [{ from: AT_TEN + 30 * 60_000, to: AT_ELEVEN }]);
});

test('an empty exclusion list changes nothing', () => {
  const blocks: Block[] = [{ from: AT_TEN, to: AT_ELEVEN, uid: 'a@x' }];
  assert.deepEqual(busyExcluding(blocks, []), [{ from: AT_TEN, to: AT_ELEVEN }]);
});

test('an invitation with no UID excludes nothing rather than everything', () => {
  // A UID is optional in the wild, and the exclusion list is filtered before
  // it reaches SQL. An empty string must not become a wildcard.
  const blocks: Block[] = [{ from: AT_TEN, to: AT_ELEVEN, uid: '' }];
  assert.deepEqual(busyExcluding(blocks, ['']), [{ from: AT_TEN, to: AT_ELEVEN }]);
});
