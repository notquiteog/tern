// How much of a draft survived, which is the number that decides whether an
// edit is evidence of anything.
//
// A character diff would call a reordered sentence a rewrite and a replaced
// sentence a small change, which is backwards for the question being asked:
// "did they keep what it said". So it is a word-level overlap, and these are
// the cases that prove it behaves that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptFraction } from './voiceLearning.js';

test('an untouched draft is kept whole', () => {
  const t = 'Thanks for sending the quote over. Thursday at three works for me.';
  assert.equal(keptFraction(t, t), 1);
});

test('punctuation and case are not edits', () => {
  assert.equal(
    keptFraction('Thanks for the quote — Thursday works.', 'thanks for the quote, thursday works'),
    1,
  );
});

test('a reordered sentence counts as a much smaller change than a replaced one', () => {
  const original = 'Thursday at three works for me. Thanks for sending the quote over.';
  const reordered = 'Thanks for sending the quote over. Thursday at three works for me.';
  const replaced = 'I am afraid none of those times suit. Could we look at the week after?';
  assert.equal(keptFraction(original, reordered), 1, 'the same words in another order are the same words');
  assert.ok(keptFraction(original, replaced) < 0.2, 'a different email should score near zero');
});

test('trimming a closing is a partial edit rather than a rewrite', () => {
  const generated = 'Thanks for sending the quote over. Thursday at three works for me. Please let me know if anything changes and I will be happy to rearrange.';
  const sent = 'Thanks for sending the quote over. Thursday at three works for me.';
  const kept = keptFraction(generated, sent);
  assert.ok(kept > 0.4 && kept < 0.95, `expected a partial edit, got ${kept}`);
});

test('an empty generation cannot claim to have been kept', () => {
  assert.equal(keptFraction('', 'anything at all'), 0);
  assert.equal(keptFraction('', ''), 1);
});
