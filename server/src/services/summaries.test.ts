// The one line that goes above a conversation in the list. A small model
// given "one line" writes three, opens with "This email is about", and puts
// the lot in quotes, so what it produces is tidied before it is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyGist } from './summaries.js';

test('a clean line is kept as it is, minus the full stop', () => {
  assert.equal(tidyGist('Asks to move Thursday’s call to Friday morning.'), 'Asks to move Thursday’s call to Friday morning');
});

test('only the first line survives', () => {
  assert.equal(tidyGist('Confirms the invoice was paid\nThey also ask about next month\nAnd a third thought'), 'Confirms the invoice was paid');
});

test('quotes and labels are stripped', () => {
  assert.equal(tidyGist('"Wants the contract signed by Friday"'), 'Wants the contract signed by Friday');
  assert.equal(tidyGist('Summary: budget approved for Q4'), 'Budget approved for Q4');
  assert.equal(tidyGist('TL;DR - the shipment is delayed'), 'The shipment is delayed');
});

test('the padding a model puts in front of a summary is removed', () => {
  assert.equal(tidyGist('This email is about the new pricing tiers'), 'The new pricing tiers');
  assert.equal(tidyGist('This message asks that you confirm the address'), 'You confirm the address');
  assert.equal(tidyGist('The sender wants a call on Tuesday'), 'A call on Tuesday');
});

test('the first letter is capitalised once the padding is gone', () => {
  assert.equal(tidyGist('this email says the server is back up'), 'The server is back up');
});

test('a paragraph is not a line, so nothing is shown', () => {
  // Truncating mid-sentence reads worse than showing the subject alone.
  assert.equal(tidyGist(`Asks about ${'the budget again '.repeat(12)}`), '');
  // Just inside the limit, and a real sentence rather than one long word.
  const ok = `Asks whether ${'the revised budget '.repeat(6)}is approved`;
  assert.ok(ok.length > 120 && ok.length <= 160);
  assert.equal(tidyGist(ok).length, ok.length);
});

test('nothing usable gives nothing', () => {
  assert.equal(tidyGist(''), '');
  assert.equal(tidyGist('   \n  \n'), '');
  assert.equal(tidyGist('""'), '');
  assert.equal(tidyGist(undefined as any), '');
});

test('a greeting is not a summary', () => {
  // A small model handed a thread starts writing the reply rather than
  // describing it, and the first line of a reply is the salutation.
  for (const v of ['Hi Bob,', 'Hello Dana', 'Hey there,', 'Dear Ms Reed,', 'Good morning Alice,', 'Thanks for the update', 'Best regards,']) {
    assert.equal(tidyGist(v), '', v);
  }
});

test('anything ending in a comma is a salutation, not a line', () => {
  assert.equal(tidyGist('Confirming the order,'), '');
});

test('a two-word fragment is not a summary', () => {
  assert.equal(tidyGist('The invoice'), '');
  assert.equal(tidyGist('A call on Thursday'), 'A call on Thursday');
});

test('a summary that only repeats the subject is not worth a line', () => {
  // The subject is already on the row above, so this costs space and adds
  // nothing. Small models do it constantly.
  assert.equal(tidyGist('Your order #88213 has shipped', 'Your order #88213 has shipped'), '');
  assert.equal(tidyGist('your order 88213 has shipped!', 'Re: Your order #88213 has shipped'), '');
  // Swallowed by the subject either way round.
  assert.equal(tidyGist('The budget review', 'The budget review meeting on Tuesday'), '');
  // Genuinely adds something, so it stays.
  assert.equal(tidyGist('Asks you to approve the figures by Friday', 'The budget review'), 'Asks you to approve the figures by Friday');
});
