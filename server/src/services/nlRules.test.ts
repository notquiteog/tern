// Turning a sentence into a rule. The model's half is not tested here — what
// is tested is the half that decides what a model is *allowed* to have said,
// which is the part that matters: this output becomes something that runs on
// every message that arrives, so anything it does not understand has to be
// dropped rather than passed through and discovered later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanQuery, parseRule } from './nlRules.js';

const LABELS = [
  { id: 'mb-1', name: 'Finance' },
  { id: 'mb-2', name: 'Receipts' },
];

const wrap = (o: unknown) => JSON.stringify(o);

test('a well-formed answer becomes a rule', () => {
  const r = parseRule(wrap({
    name: 'Stripe receipts',
    match: 'all',
    conditions: [{ field: 'from', op: 'contains', value: 'stripe.com' }],
    actions: [{ type: 'label', label: 'Finance' }, { type: 'archive' }],
  }), LABELS);
  assert.equal(r.name, 'Stripe receipts');
  assert.equal(r.match, 'all');
  assert.deepEqual(r.conditions, [{ field: 'from', op: 'contains', value: 'stripe.com' }]);
  assert.deepEqual(r.actions, [{ type: 'label', mailboxId: 'mb-1' }, { type: 'archive' }]);
});

test('prose around the JSON is ignored', () => {
  // Small models preface everything. The rule is still in there.
  const raw = `Sure! Here is the rule you asked for:\n\n\`\`\`json\n${wrap({
    name: 'x', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: [{ type: 'star' }],
  })}\n\`\`\`\nLet me know if you want changes.`;
  assert.equal(parseRule(raw, LABELS).actions[0].type, 'star');
});

test('a label that does not exist is dropped, not invented', () => {
  // Creating a mailbox is not something a sentence should be able to do.
  const r = parseRule(wrap({
    name: 'x',
    conditions: [{ field: 'from', op: 'contains', value: 'a@b.example' }],
    actions: [{ type: 'label', label: 'Nonexistent' }, { type: 'archive' }],
  }), LABELS);
  assert.deepEqual(r.actions, [{ type: 'archive' }]);
});

test('label names match without regard to case', () => {
  const r = parseRule(wrap({
    name: 'x', conditions: [{ field: 'any', op: 'contains', value: 'z' }], actions: [{ type: 'label', label: 'finance' }],
  }), LABELS);
  assert.equal(r.actions[0].mailboxId, 'mb-1');
});

test('a field or operator outside the vocabulary is dropped', () => {
  // The rules engine would not know what to do with these, and a condition
  // it cannot evaluate is a rule that behaves unpredictably on real mail.
  assert.throws(() => parseRule(wrap({
    name: 'x',
    conditions: [{ field: 'attachment_name', op: 'contains', value: 'a' }, { field: 'sentiment', op: 'is', value: 'angry' }],
    actions: [{ type: 'archive' }],
  }), LABELS), /match on/i);
});

test('an action outside the vocabulary is dropped', () => {
  assert.throws(() => parseRule(wrap({
    name: 'x',
    conditions: [{ field: 'from', op: 'contains', value: 'a' }],
    actions: [{ type: 'forward_to', value: 'attacker@evil.example' }],
  }), LABELS), /anything to do/i);
});

test('the boolean fields get a boolean operator whatever was asked for', () => {
  const r = parseRule(wrap({
    name: 'x',
    conditions: [{ field: 'has_attachment', op: 'contains', value: 'yes' }, { field: 'list', op: 'is_false' }],
    actions: [{ type: 'archive' }],
  }), LABELS);
  assert.deepEqual(r.conditions, [{ field: 'has_attachment', op: 'is_true' }, { field: 'list', op: 'is_false' }]);
});

test('a regular expression that does not compile is dropped', () => {
  // It would throw inside the engine on every message that arrives.
  assert.throws(() => parseRule(wrap({
    name: 'x',
    conditions: [{ field: 'subject', op: 'matches', value: '([unclosed' }],
    actions: [{ type: 'archive' }],
  }), LABELS), /match on/i);
  const ok = parseRule(wrap({
    name: 'x',
    conditions: [{ field: 'subject', op: 'matches', value: '^Invoice \\d+' }],
    actions: [{ type: 'archive' }],
  }), LABELS);
  assert.equal(ok.conditions[0].op, 'matches');
});

test('an unusable answer says so rather than producing an empty rule', () => {
  // A rule with no conditions matches everything, and a rule with no actions
  // does nothing. Both are worse than an error.
  for (const raw of ['I could not do that', '', '{}', wrap({ name: 'x', conditions: [], actions: [] })]) {
    assert.throws(() => parseRule(raw, LABELS), /rule|match on|anything to do/i, JSON.stringify(raw));
  }
});

test('a condition with no value is dropped', () => {
  assert.throws(() => parseRule(wrap({
    name: 'x', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'archive' }],
  }), LABELS), /match on/i);
});

test('a rule is bounded in every direction', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ field: 'subject', op: 'contains', value: `w${i}` }));
  const r = parseRule(wrap({ name: 'x'.repeat(500), conditions: many, actions: Array.from({ length: 30 }, () => ({ type: 'star' })) }), LABELS);
  assert.ok(r.conditions.length <= 20);
  assert.ok(r.actions.length <= 10);
  assert.ok(r.name.length <= 200);
});

// ---------- Search ----------

test('a query keeps the operators the omnibox understands', () => {
  assert.equal(cleanQuery('from:ana@corp.example subject:invoice newer_than:30d'), 'from:ana@corp.example subject:invoice newer_than:30d');
  assert.equal(cleanQuery('is:unread has:attachment'), 'is:unread has:attachment');
});

test('an operator the search parser does not know is dropped', () => {
  // It would be searched for as a literal word, find nothing, and look broken.
  assert.equal(cleanQuery('from:ana sentiment:angry priority:high invoice'), 'from:ana invoice');
});

test('plain words and exclusions survive', () => {
  assert.equal(cleanQuery('invoice -draft "exact phrase"'), 'invoice -draft "exact phrase"');
});

test('only the first line is taken, and wrapping quotes come off', () => {
  assert.equal(cleanQuery('"from:ana invoice"\n\nLet me know if that helps!'), 'from:ana invoice');
});

test('rubbish comes back empty rather than as a search for rubbish', () => {
  assert.equal(cleanQuery(''), '');
  assert.equal(cleanQuery('\n\n'), '');
});
