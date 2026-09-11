// The grader, graded.
//
// ai/grade.ts decides what reply.eval.ts reports, so it has to be right before
// any score it gives means anything. Two anchors hold it in place: the reply
// that prompted all of this must score as the non-email it is, and a reply a
// careful person would send must score ten on every fixture thread — which
// also proves each thread's required facts and marks are what they claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeReply, hasWord } from './grade.js';
import { MAILBOX, REPLY_THREADS, REPORTED_REPLY, threadText, type DetailedThread } from './replyFixtures.js';

const thread = (id: string) => REPLY_THREADS.find((t) => t.id === id)!;
const foreign = (t: DetailedThread) => MAILBOX.filter((o) => o.id !== t.id).flatMap((o) => o.marks);
const grade = (t: DetailedThread, draft: string | null, extra: { wrongThread?: string } = {}) =>
  gradeReply({ draft, task: t.task!, threadText: threadText(t), foreignMarks: foreign(t), extraFacts: t.task!.instruction, ...extra });
const lost = (g: ReturnType<typeof gradeReply>) => Object.fromEntries(g.criteria.filter((c) => c.points < c.max).map((c) => [c.id, c.why ?? '']));

// What a careful person would send to each thread. Every required fact, the
// right name, nothing borrowed and nothing invented.
const GOOD: Record<string, string> = {
  kitchen: `Hi Marta,

Yes, we are happy with the revised total of £19,150 and with starting on Monday 5 October.

We would like to keep the old radiator where it is, so there is no need for the plumber. Please send the deposit invoice whenever you are ready.

Thanks,
Alex`,
  outage: `Hi Hannah,

Thank you. The credit we are expecting is £120, which is 10% of our monthly fee, and we would like it applied to the October invoice, as September's has already been paid. The ticket reference is RW-48213.

Best,
Alex`,
  offer: `Hi Tomás,

Happy to confirm in writing. You will work three days a week from home and be in the Leeds office on Tuesdays and Wednesdays, and your start date is Monday 2 November.

The contract from HR will say the same.

Best,
Alex`,
  trip: `Hi Eleanor,

Yes, Maya still needs the vegetarian option — thank you for checking. I will send the medical form back, with her antihistamine and the dose on it, before 30 September.

Best wishes,
Alex`,
  northwind: `Hi Dana,

Here they are in one place. Your fiscal year ends on 30 September, so the clean-up has to be finished and reconciled before then, and nothing can be in flight during the week of the board meeting on the second Tuesday of every month.

The ongoing monthly close is £950 a month on a rolling three month term.

Best,
Alex`,
};

test('every fact a reply must state is in the thread it answers', () => {
  // A required fact the thread never states would be a test of invention.
  for (const t of REPLY_THREADS) {
    const text = threadText(t);
    for (const r of t.task!.required) assert.match(text, r.re, `${t.id}: ${r.id} is not in the thread`);
  }
});

test('each thread\'s marks are its own', () => {
  // A mark is evidence of a leak only if it is in its own thread and in no
  // other. One that appeared in two would accuse a correct reply.
  for (const t of MAILBOX) {
    const own = threadText(t);
    for (const mark of t.marks) {
      assert.ok(hasWord(own, mark), `${t.id}: "${mark}" is not in its own thread`);
      for (const o of MAILBOX.filter((x) => x.id !== t.id)) {
        assert.ok(!hasWord(threadText(o), mark), `"${mark}" (${t.id}) also appears in ${o.id}`);
      }
    }
  }
});

test('a careful reply to every thread scores ten', () => {
  for (const t of REPLY_THREADS) {
    const g = grade(t, GOOD[t.id]!);
    assert.deepEqual(lost(g), {}, t.id);
    assert.equal(g.score, 10, t.id);
    assert.deepEqual(g.critical, [], t.id);
  }
});

test('the reply that prompted this scores as the non-email it is', () => {
  const g = grade(thread('outage'), REPORTED_REPLY.body);
  assert.ok(g.score <= 3, `scored ${g.score}/10`);
  const why = lost(g);
  assert.match(why['coherent/text'] ?? '', /markup/);
  assert.match(why['coherent/text'] ?? '', /script/);
  assert.match(why['coherent/prose'] ?? '', /words without a stop/);
  assert.match(why['coherent/prose'] ?? '', /ends mid-sentence/);
  // "launch event" and "early adopters" are the newsletter's words.
  assert.match(why['on-thread'] ?? '', /launch event/);
  assert.ok(g.critical.some((c) => /^garbled/.test(c)) && g.critical.some((c) => /other conversations/.test(c)));
});

test('words from another conversation cost both on-thread points and fail the run', () => {
  const draft = GOOD.kitchen!.replace('Please send', 'Ledgerly also wrote to us about early adopters. Please send');
  const g = grade(thread('kitchen'), draft);
  assert.equal(g.score, 8);
  assert.match(lost(g)['on-thread'] ?? '', /Ledgerly, early adopters/);
  assert.equal(g.critical.length, 1);
});

test('a draft filed against a different conversation is off-thread however well written', () => {
  const g = grade(thread('kitchen'), GOOD.kitchen!, { wrongThread: 'newsletter' });
  assert.equal(g.score, 8);
  assert.match(g.critical[0] ?? '', /another conversation/);
});

test('an invented figure costs the faithful point, and the fact it replaced costs part of answers', () => {
  const g = grade(thread('kitchen'), GOOD.kitchen!.replace('£19,150', '£19,500'));
  const why = lost(g);
  assert.match(why.faithful ?? '', /19,500/);
  assert.match(why.answers ?? '', /revised total/);
  assert.equal(g.score, 8.5);
});

test('stating the position the thread moved away from costs the faithful point', () => {
  const g = grade(thread('offer'), GOOD.offer!.replace('three days a week', 'two days a week'));
  const why = lost(g);
  assert.match(why.faithful ?? '', /changed to three/);
  assert.match(why.answers ?? '', /three days/);
});

test('the old position mentioned in passing is not the old position restated', () => {
  // Both of these name the abandoned figure to explain the current one. A
  // grader that docked them would be marking good replies down for context.
  const kitchen = grade(thread('kitchen'), GOOD.kitchen!.replace('£19,150', '£19,150, up from £18,400'));
  assert.deepEqual(lost(kitchen), {});
  const outage = grade(thread('outage'), GOOD.outage!.replace("it applied to the October invoice, as September's has already been paid", "it applied to October's bill, as September's invoice is already paid"));
  assert.deepEqual(lost(outage), {});
});

test('greeting somebody else on the thread costs the addressed point', () => {
  const g = grade(thread('kitchen'), GOOD.kitchen!.replace('Hi Marta,', 'Hi Dev,'));
  assert.equal(g.score, 9);
  assert.match(lost(g).addressed ?? '', /Marta/);
});

test('a plan for an email is not an email', () => {
  // Verbatim shape of what qwen3:4b wrote with thinking turned off: the
  // working-out, as the draft.
  const plan = `Hi there,

We are writing a reply to the latest message in the conversation. The latest message is from Dana Osei on Wed Jun 24 2026.

We are to answer this question. Let's draft: the two constraints and the monthly figure, which is £950.`;
  const g = grade(thread('northwind'), plan);
  const why = lost(g);
  assert.match(why.clean ?? '', /prompt text/);
  assert.match(why.addressed ?? '', /Dana/);
});

test('no draft, or a scrap of one, scores nothing', () => {
  assert.equal(grade(thread('trip'), null).score, 0);
  assert.deepEqual(grade(thread('trip'), null).critical, ['no draft came back']);
  assert.equal(grade(thread('trip'), 'Hi Eleanor, yes.').score, 0);
});

test('a mark is a whole word, in any script', () => {
  assert.equal(hasWord('Tomasz approved it', 'Tomasz'), true);
  assert.equal(hasWord('Hi Tomás,', 'Tomasz'), false);
  assert.equal(hasWord('TOMASZ', 'Tomasz'), true);
  assert.equal(hasWord('use code quillfeather now', 'QUILLFEATHER'), true);
  assert.equal(hasWord('the webhooks', 'webhook'), false);
  assert.equal(hasWord('田中さん', '田中'), false);
});
