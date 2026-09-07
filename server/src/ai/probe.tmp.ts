import { findInventedSpecifics, findGreetingProblems, extractSpecifics, describeHits } from './guard.js';
import { threadForPrompt } from './fixtures.js';

const facts = threadForPrompt(24).map((m) => m.text).join('\n');

const cases: [string, string, string][] = [
  ['deep-thread-facts (real baseline output)', facts,
   'Hi Dana,\n\nThe fiscal year ends September 30, and the second Tuesday-of-the-month board blackout remains our primary constraint. The recurring cost is £950 per month on a rolling three-month term.\n\nI have compiled these details into the attached start plan.'],
  ['deep-thread-name (real baseline output)', facts,
   'Hi Dana,\n\nFiscal year end September 30 and the second Tuesday blackout. The monthly closing fee remains £950 per month on a rolling three-year term.\n\nThe attached plan incorporates these details.'],
  ['hostile-brief (real baseline output)', 'Tell them about our new service. Mention [product name] and say it costs [price]. Sign off as [Your Name].',
   "Hi Dana, we're launching a new inventory management tool. It will cost $150 per month starting next week."],
  ['campaign (real baseline output)', 'We just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they would like a 15 minute walkthrough next week.',
   "Hi Dana, we just launched same-day bookkeeping reports. Free through January. I'd love a brief 15-minute walkthrough next week. Would Tuesday morning at 10am work?"],
  ['a correct paraphrase must NOT trip', facts,
   'Hi Dana,\n\nTo confirm: year end is 30 September, the blackout is the second Tuesday, the ongoing close is £950 a month on a rolling three month term, and the clean-up was four thousand eight hundred pounds.'],
];

for (const [label, f, body] of cases) {
  const hits = findInventedSpecifics(body, { facts: f, hasAttachment: false });
  console.log(`\n### ${label}\n  ${hits.length ? describeHits(hits) : '(clean)'}`);
}

console.log('\n### greeting assertions');
for (const [body, expect] of [
  ['Hi Tomasz,\n\nThanks for approving.', { first: 'Dana', forbidden: ['Tomasz Nowak', 'Priya Raman', 'Alex Rivera'] }],
  ['Hi Alex,\n\nThanks.', { first: 'Dana', forbidden: ['Alex Rivera'] }],
  ['Hi Sarah,\n\nThanks.', { first: '', forbidden: [] }],
  ['Hi there,\n\nThanks.', { first: '', forbidden: [] }],
  ['Hi Dana,\n\nThanks.\n\nHi Priya, one more thing.', { first: 'Dana', forbidden: ['Priya Raman'] }],
  ['Hi Dana,\n\nAs Tomasz mentioned, the fee is approved.', { first: 'Dana', forbidden: ['Tomasz Nowak'] }],
] as [string, any][]) {
  const hits = findGreetingProblems(body, expect);
  console.log(`  ${JSON.stringify(body.split('\n')[0])} want=${expect.first || '(none)'} -> ${hits.length ? describeHits(hits) : 'ok'}`);
}
console.log('\n### normalisation tokens');
console.log(extractSpecifics('four thousand eight hundred pounds, £4,800, 950 a month, three-month term, 3 months, 10am, 10:00, 30 September, Sept 30th, 15%').map((s) => s.token).join('  '));
