import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicIntent, isReplyIntent, ownWords, parseIntent, REPLY_INTENTS, ROUTE_OF } from './replyIntent.js';

test('the label set is small enough for a small model to be reliable at', () => {
  // Five labels for the model to choose between, plus two it never sees and
  // one fallback. Growing this list is the thing most likely to make the
  // classification worse, so the size is asserted rather than assumed.
  const modelChoices = REPLY_INTENTS.filter((i) => i !== 'stop' && i !== 'auto_reply' && i !== 'unclear');
  assert.equal(modelChoices.length, 5);
  // Every label routes somewhere, and none of them routes to an automatic answer.
  for (const i of REPLY_INTENTS) assert.ok(ROUTE_OF[i], `${i} has no route`);
});

test('an unsubscribe and an out-of-office are decided in code, never by a model', () => {
  assert.equal(deterministicIntent({ text: 'Please stop emailing me.' }), 'stop');
  assert.equal(deterministicIntent({ text: 'unsubscribe' }), 'stop');
  assert.equal(deterministicIntent({ text: 'Take me off this list please.' }), 'stop');
  assert.equal(deterministicIntent({ text: 'I am out of the office until 12 June.' }), 'auto_reply');
  assert.equal(deterministicIntent({ subject: 'Automatic reply: Bookkeeping', text: 'I will be back on Monday.' }), 'auto_reply');
  assert.equal(deterministicIntent({ text: 'anything', autoSubmitted: 'auto-generated' }), 'auto_reply');
  assert.equal(deterministicIntent({ text: 'anything', autoSubmitted: 'no' }), null);
  // A real reply is left for the classifier.
  assert.equal(deterministicIntent({ text: 'Yes, Tuesday works. Can you send a time?' }), null);
});

test('only a word from the list is ever a label', () => {
  assert.equal(parseIntent('interested'), 'interested');
  assert.equal(parseIntent('  NOT_INTERESTED\n'), 'not_interested');
  assert.equal(parseIntent('The label is: question.'), 'question');
  assert.equal(parseIntent('<think>hmm, they seem keen</think>interested'), 'interested');
  // Anything the model invents is not a label.
  assert.equal(parseIntent('enthusiastic'), 'unclear');
  assert.equal(parseIntent('I think they are quite keen about this offer'), 'unclear');
  assert.equal(parseIntent(''), 'unclear');
  // And it can never talk its way into the two decided in code.
  assert.equal(parseIntent('stop'), 'unclear');
  assert.equal(parseIntent('auto_reply'), 'unclear');
  for (const v of ['interested', 'question', 'not_now', 'not_interested', 'wrong_person', 'unclear']) assert.ok(isReplyIntent(v));
});

test('only the words they wrote are classified, not our own message quoted back', () => {
  const reply = [
    'Not for us at the moment, thanks.',
    '',
    'On Mon 1 Jun 2026, Alex Rivera <alex@brightledger.example> wrote:',
    '> We have just launched same-day bookkeeping reports and I wondered',
    '> whether you would like a walkthrough next week.',
  ].join('\n');
  assert.equal(ownWords(reply), 'Not for us at the moment, thanks.');
  assert.equal(ownWords('Interested!\n\n-----Original Message-----\nFrom: Alex'), 'Interested!');
});
