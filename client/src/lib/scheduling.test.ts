import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksAboutTime, writeSlots } from './scheduling.js';

test('one slot is a question and several are a list with a way out', () => {
  const a = { startsAt: '2026-09-08T09:00:00Z', endsAt: '2026-09-08T09:30:00Z' };
  const b = { startsAt: '2026-09-09T14:00:00Z', endsAt: '2026-09-09T14:30:00Z' };
  const one = writeSlots([a]);
  assert.ok(one.startsWith('Would ') && one.endsWith('work?'));
  assert.ok(!one.includes('•'), 'a single time is a sentence, not a bullet');

  const many = writeSlots([a, b]);
  assert.equal(many.split('•').length - 1, 2);
  assert.ok(/none of them suit/.test(many), 'an offer of times without a way out reads as an ultimatum');

  assert.equal(writeSlots([]), '');
});

test('asksAboutTime catches the ways people ask and leaves ordinary mail alone', () => {
  for (const yes of [
    'When are you free next week?',
    'Let me know what your availability looks like.',
    'Could we set up a call?',
    'Happy to book a meeting if that helps.',
    'Are you available Thursday?',
    'Shall we find a time to talk it through?',
    'Is there a time that works for you?',
    'Let me know if any of that suits.',
  ]) assert.ok(asksAboutTime(yes), `should match: ${yes}`);

  for (const no of [
    'Thanks for the invoice, all looks right.',
    'The quote is attached; let me know what you think.',
    'We shipped it this morning.',
    '',
    null,
    undefined,
  ]) assert.ok(!asksAboutTime(no), `should not match: ${no}`);
});

test('only the top of a long message is read, so a footer cannot trigger it', () => {
  const body = `${'Nothing to see here. '.repeat(400)}Sent from my calendar app`;
  assert.ok(body.length > 4000);
  assert.equal(asksAboutTime(body), false);
});
