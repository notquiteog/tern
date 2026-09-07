// Reading a model's answer about what was promised. The model is not tested
// here; what is tested is how little of its answer is trusted. Every item
// that gets through becomes a row somebody sees on a list and possibly a
// reminder about a date, so an answer that is not clearly a commitment has to
// produce nothing rather than something plausible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDue, parseCommitments } from './commitments.js';

const TODAY = new Date('2026-09-08T12:00:00Z');
const wrap = (v: unknown) => JSON.stringify(v);

test('a well-formed answer becomes commitments', () => {
  const out = parseCommitments(wrap([
    { kind: 'owed', what: 'send the revised quote', who: 'Ana Duarte', due: '2026-09-11' },
    { kind: 'awaiting', what: 'confirmation of the delivery address', who: 'ana@corp.example', due: null },
  ]), TODAY);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'owed');
  assert.equal(out[0].what, 'Send the revised quote', 'the first letter is capitalised for the list');
  assert.equal(out[0].who, 'Ana Duarte');
  assert.equal(out[0].due, '2026-09-11T12:00:00.000Z');
  assert.equal(out[1].due, null);
});

test('an empty answer is an answer', () => {
  assert.deepEqual(parseCommitments('[]', TODAY), []);
  assert.deepEqual(parseCommitments('There are no commitments in this conversation.\n\n[]', TODAY), []);
});

test('prose and code fences around the array are ignored', () => {
  const raw = 'Here you go:\n```json\n[{"kind":"owed","what":"send the deck","who":null,"due":null}]\n```\nHope that helps.';
  assert.equal(parseCommitments(raw, TODAY).length, 1);
});

test('a second array afterwards is not merged into the first', () => {
  // The matching bracket, not the last one in the string.
  const raw = '[{"kind":"owed","what":"send the deck","who":null,"due":null}]\n\nAlso: [1,2,3]';
  const out = parseCommitments(raw, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].what, 'Send the deck');
});

test('a bracket inside a string does not end the array early', () => {
  const raw = wrap([{ kind: 'owed', what: 'send the file [final] to Ana', who: null, due: null }]);
  const out = parseCommitments(raw, TODAY);
  assert.equal(out.length, 1);
  assert.match(out[0].what, /\[final\]/);
});

test('an unusable answer produces nothing rather than an error', () => {
  for (const raw of ['', 'I am sorry, I cannot help with that.', '{"kind":"owed"}', 'null', '[', '[{']) {
    assert.deepEqual(parseCommitments(raw, TODAY), [], JSON.stringify(raw));
  }
});

test('a kind outside the two is dropped', () => {
  const out = parseCommitments(wrap([
    { kind: 'maybe', what: 'think about the proposal', who: null, due: null },
    { kind: 'owed', what: 'send the proposal', who: null, due: null },
  ]), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'owed');
});

test('a fragment and an essay are both refused', () => {
  const out = parseCommitments(wrap([
    { kind: 'owed', what: 'ok', who: null, due: null },
    { kind: 'owed', what: 'reply', who: null, due: null },
    { kind: 'owed', what: 'a'.repeat(250), who: null, due: null },
    // A model asked for a phrase sometimes returns the whole email.
    { kind: 'owed', what: Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '), who: null, due: null },
    { kind: 'owed', what: 'send the signed contract back', who: null, due: null },
  ]), TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].what, 'Send the signed contract back');
});

test('a placeholder counterparty becomes nothing', () => {
  const names = ['null', 'unknown', 'N/A', 'the user', 'me', 'you', '', '  '];
  for (const who of names) {
    const out = parseCommitments(wrap([{ kind: 'owed', what: 'send the deck over', who, due: null }]), TODAY);
    assert.equal(out[0].who, null, `who="${who}"`);
  }
});

test('the list is bounded', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'owed', what: `send document number ${i}`, who: null, due: null }));
  assert.ok(parseCommitments(wrap(many), TODAY).length <= 12);
});

// ---------- Dates ----------

test('a plausible date becomes a due date', () => {
  assert.equal(cleanDue('2026-09-11', TODAY), '2026-09-11T12:00:00.000Z');
  assert.equal(cleanDue('2027-01-05', TODAY), '2027-01-05T12:00:00.000Z');
});

test('a date the model invented out of range is dropped', () => {
  // An overdue item that never existed is worse than no date at all.
  assert.equal(cleanDue('2020-01-01', TODAY), null, 'long past');
  assert.equal(cleanDue('2031-01-01', TODAY), null, 'more than two years out');
  // Yesterday is allowed: a thread read a day late still has a real deadline.
  assert.equal(cleanDue('2026-09-08', TODAY), '2026-09-08T12:00:00.000Z');
});

test('anything that is not a date is dropped', () => {
  for (const v of ['next Friday', 'soon', '11/09/2026', '2026-13-45', '', null, undefined, 42]) {
    assert.equal(cleanDue(v, TODAY), null, JSON.stringify(v));
  }
});
