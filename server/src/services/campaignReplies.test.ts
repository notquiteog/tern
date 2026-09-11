import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionFor, REENROLL_DAYS } from './campaignReplies.js';
import { REPLY_INTENTS } from './replyIntent.js';

test('every intent says what to do next', () => {
  // The tab, the brief and the assistant all read this. An intent with no
  // action would render a row with no button in one place and be silently
  // skipped in another.
  for (const i of REPLY_INTENTS) {
    const a = actionFor(i);
    assert.ok(a.kind, `${i} has no action kind`);
    assert.ok(a.label.length > 0, `${i} has no label`);
  }
});

test('interested gets times offered, and nothing else does', () => {
  // Offering slots inside a mass first send would hand the same three times
  // to two hundred people. The reply is the only right place for them, and
  // the trigger is the intent rather than the message mentioning a date.
  assert.equal(actionFor('interested').proposeTimes, true);
  for (const i of REPLY_INTENTS.filter((x) => x !== 'interested')) {
    assert.notEqual(actionFor(i).proposeTimes, true, `${i} should not offer times`);
  }
});

test('a question is answered from the brief', () => {
  const a = actionFor('question');
  assert.equal(a.kind, 'reply');
  assert.equal(a.fromBrief, true);
});

test('nothing offers to write again to somebody who declined', () => {
  // The two ways of saying no both end in an action that sends nothing.
  for (const i of ['not_interested', 'stop', 'auto_reply'] as const) {
    assert.equal(actionFor(i).kind, 'none', `${i} must not offer to send`);
  }
});

test('not now is re-enrolled, not resumed', () => {
  const a = actionFor('not_now');
  assert.equal(a.kind, 'reenroll');
  assert.equal(a.reenrollDays, REENROLL_DAYS);
  assert.match(a.label, /6 weeks/);
});

test('a wrong-person reply offers the person it named, and nothing when it named nobody', () => {
  const withName = actionFor('wrong_person', [{ email: 'priya@westmere.example', name: 'Priya', first_name: 'Priya', last_name: '', quote: 'try Priya' }]);
  assert.equal(withName.kind, 'referral');
  assert.equal(withName.referrals?.length, 1);

  // A handover that named nobody has nothing to offer but the message.
  const bare = actionFor('wrong_person', []);
  assert.equal(bare.kind, 'open');
});

test('a name with no address is still offered, worded differently', () => {
  const a = actionFor('wrong_person', [{ email: '', name: 'Priya Raman', first_name: 'Priya', last_name: 'Raman', quote: 'ask Priya Raman' }]);
  assert.equal(a.kind, 'referral');
  // "Add them and enroll" would be a lie: there is no address to enroll.
  assert.doesNotMatch(a.label, /enroll/i);
});
