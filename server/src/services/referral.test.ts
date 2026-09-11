import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReferral } from './referral.js';

test('reads the name and the address out of a handover', () => {
  const [r] = parseReferral('Not my area I am afraid — try Priya, priya@westmere.example');
  assert.equal(r?.email, 'priya@westmere.example');
  assert.equal(r?.name, 'Priya');
  assert.equal(r?.first_name, 'Priya');
  assert.match(r!.quote, /try Priya/);
});

test('reads the three ways a name is written against an address', () => {
  const angle = parseReferral('You want Priya Raman <priya@westmere.example> for this.');
  assert.equal(angle[0]?.email, 'priya@westmere.example');
  assert.equal(angle[0]?.name, 'Priya Raman');
  assert.equal(angle[0]?.last_name, 'Raman');

  const paren = parseReferral('Sam Okafor (sam@westmere.example) has taken this over.');
  assert.equal(paren[0]?.email, 'sam@westmere.example');
  assert.equal(paren[0]?.name, 'Sam Okafor');

  const mirror = parseReferral('Please speak to sam@westmere.example (Sam Okafor) instead.');
  assert.equal(mirror[0]?.email, 'sam@westmere.example');
  assert.equal(mirror[0]?.name, 'Sam Okafor');
});

test('an address in a signature is not a referral', () => {
  // The cue is what separates a handover from a sign-off block. Without it
  // every reply would offer to add its own sender as a new contact.
  const out = parseReferral([
    'Thanks, but we are not looking at this right now.',
    '',
    'Jane Doe',
    'Head of Operations, Westmere',
    'jane@westmere.example | +44 20 7946 0000',
    'www.westmere.example',
  ].join('\n'));
  assert.deepEqual(out, []);
});

test('never offers an address it was told to exclude', () => {
  // Our own sending address appears in every footer we wrote, and the
  // replier's own address is in their signature.
  const out = parseReferral('Please contact jane@westmere.example about this.', {
    exclude: ['jane@westmere.example'],
  });
  assert.deepEqual(out, []);
});

test('nothing below a quote marker is read', () => {
  // Everything under the marker is our own message, carrying our own address
  // and our own footer.
  const out = parseReferral([
    'Wrong person.',
    '',
    '> Hi Jane, I wanted to ask about your renewals. Contact me at us@ours.example',
  ].join('\n'));
  assert.deepEqual(out, []);
});

test('a department address carries no personal name', () => {
  const [r] = parseReferral('Please email accounts@westmere.example for that.');
  assert.equal(r?.email, 'accounts@westmere.example');
  assert.equal(r?.name, '', 'a role address is not a person');
});

test('a name with no address is still worth a card', () => {
  const [r] = parseReferral('That would be Priya Raman, she handles renewals now.');
  assert.equal(r?.email, '');
  assert.equal(r?.name, 'Priya Raman');
});

test('the same person named then addressed is one referral', () => {
  const out = parseReferral('You should speak to Priya Raman. Try Priya Raman <priya@westmere.example>.');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.email, 'priya@westmere.example');
});

test('a sentence that starts with a verb does not name somebody called Sending', () => {
  const out = parseReferral('Try sending it to the main office.');
  assert.deepEqual(out, []);
});

test('an honorific is not a first name', () => {
  const [r] = parseReferral('Please contact Dr Eze <eze@westmere.example>.');
  assert.equal(r?.first_name, 'Eze', 'greeting them as "Hi Dr" would be worse than not greeting them');
});

test('two addresses in one handover keep no name rather than guess', () => {
  const out = parseReferral('Try priya@westmere.example or sam@westmere.example.');
  assert.equal(out.length, 2);
  for (const r of out) assert.equal(r.name, '');
});

test('a decline that names nobody offers nothing', () => {
  assert.deepEqual(parseReferral('No thanks, we are all set.'), []);
  assert.deepEqual(parseReferral(''), []);
  assert.deepEqual(parseReferral(null), []);
});
