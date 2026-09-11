import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceChips, audienceQuery, parseAudience, resolvePeriod } from './nlAudience.js';

// Thursday 10 September 2026.
const NOW = new Date('2026-09-10T09:00:00Z');
const vocab = { tags: ['customers', 'Trial'], fieldKeys: ['plan', 'renewal_date'] };

// ---------- Periods, which the model never works out ----------

test('a month means the one already behind us', () => {
  // Somebody describing an audience is describing people who already did
  // something, so a bare month is the nearest past one.
  assert.deepEqual(resolvePeriod('march', NOW), { from: '2026-03-01', to: '2026-04-01' });
  // November has not happened yet this year, so it means last year's.
  assert.deepEqual(resolvePeriod('november', NOW), { from: '2025-11-01', to: '2025-12-01' });
});

test('the end of a period is exclusive, so a month is the whole month', () => {
  // The off-by-one this shape exists to avoid: an inclusive end would drop
  // everybody who replied on the 31st.
  assert.equal(resolvePeriod('march', NOW)!.to, '2026-04-01');
  assert.equal(resolvePeriod('q1', NOW)!.to, '2026-04-01');
});

test('the everyday periods', () => {
  assert.deepEqual(resolvePeriod('last month', NOW), { from: '2026-08-01', to: '2026-09-01' });
  assert.deepEqual(resolvePeriod('this year', NOW), { from: '2026-01-01', to: '2027-01-01' });
  assert.deepEqual(resolvePeriod('q3', NOW), { from: '2026-07-01', to: '2026-10-01' });
  assert.deepEqual(resolvePeriod('q1 last year', NOW), { from: '2025-01-01', to: '2025-04-01' });
  assert.equal(resolvePeriod('last 30 days', NOW)!.from, '2026-08-11');
});

test('a season is a season, and winter wraps the year', () => {
  assert.deepEqual(resolvePeriod('this spring', NOW), { from: '2026-03-01', to: '2026-06-01' });
  const w = resolvePeriod('winter', NOW)!;
  assert.equal(w.from, '2025-12-01');
  assert.equal(w.to, '2026-03-01');
});

test('a period it cannot read is null rather than a guess', () => {
  assert.equal(resolvePeriod('whenever', NOW), null);
  assert.equal(resolvePeriod('', NOW), null);
});

// ---------- The filter ----------

const parse = (j: any) => parseAudience(JSON.stringify(j), vocab, NOW);

test('the sentence from the brief: customers on Sage who said not now in March', () => {
  const f = parse({ tag: 'customers', fields: [{ key: 'plan', value: 'Sage' }], intent: 'not_now', period: 'march' });
  assert.equal(f.tag, 'customers');
  assert.deepEqual(f.fields, [{ key: 'plan', value: 'Sage' }]);
  assert.equal(f.intent, 'not_now');
  assert.equal(f.intentFrom, '2026-03-01');
  assert.equal(f.intentTo, '2026-04-01');
});

test('a tag the person does not have is dropped, not passed through', () => {
  // A hallucinated tag would narrow the audience to nobody, which reads as
  // "there is no one here" rather than as a mistake.
  const f = parse({ tag: 'enterprise-whales', q: 'logistics' });
  assert.equal(f.tag, undefined);
  assert.equal(f.q, 'logistics');
});

test('a tag matches whatever case it was written in', () => {
  assert.equal(parse({ tag: 'trial' }).tag, 'Trial');
});

test('a custom field key that does not exist is dropped', () => {
  const f = parse({ fields: [{ key: 'plan', value: 'Sage' }, { key: 'invented', value: 'x' }], tag: 'customers' });
  assert.deepEqual(f.fields, [{ key: 'plan', value: 'Sage' }]);
});

test('the three labels that are not audiences are refused', () => {
  // A suppression is not a list to write to, and the other two describe the
  // message rather than the person.
  for (const intent of ['stop', 'auto_reply', 'unclear']) {
    assert.equal(parse({ intent, tag: 'customers' }).intent, undefined, `${intent} should not be an audience`);
  }
  assert.equal(parse({ intent: 'interested' }).intent, 'interested');
});

test('a period with no intent is dropped, because it would filter on nothing', () => {
  const f = parse({ tag: 'customers', period: 'march' });
  assert.equal(f.period, undefined);
  assert.equal(f.intentFrom, undefined);
});

test('an empty filter is refused rather than meaning everybody', () => {
  // The most expensive thing to get wrong: an empty filter is every active
  // contact on the install.
  assert.throws(() => parse({}), /did not describe an audience/);
  assert.throws(() => parse({ tag: 'nope', fields: [] }), /did not describe an audience/);
});

test('nonsense from the model is an error a person can act on', () => {
  assert.throws(() => parseAudience('I am not sure what you mean!', vocab, NOW), /did not answer with an audience/);
  assert.throws(() => parseAudience('{ not json }', vocab, NOW), /was not an audience/);
});

test('the filter becomes the query string the contact list already takes', () => {
  const f = parse({ tag: 'customers', intent: 'not_now', period: 'march', quietDays: 60, fields: [{ key: 'plan', value: 'Sage' }] });
  const q = audienceQuery(f);
  assert.equal(q.get('tag'), 'customers');
  assert.equal(q.get('intent'), 'not_now');
  assert.equal(q.get('intentFrom'), '2026-03-01');
  assert.equal(q.get('quietDays'), '60');
  assert.equal(q.get('field'), 'plan:Sage');
});

test('every chip names the property that removes it', () => {
  // Taking a chip off is deleting a property, not re-running the sentence.
  const f = parse({ tag: 'customers', intent: 'not_now', period: 'march', quietDays: 30, q: 'logistics' });
  const chips = audienceChips(f);
  for (const c of chips) assert.ok(c.key in f, `${c.key} is not on the filter`);
  assert.ok(chips.some((c) => /said not now in march/i.test(c.label)));
});
