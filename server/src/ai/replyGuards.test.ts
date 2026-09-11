// What keeps a reply on its own thread and in prose, tested without a model.
// reply.eval.ts measures the same things against a real one; these pin down
// the mechanisms so a change that quietly undoes one fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGarbledText, findTemplateArtifacts } from './guard.js';
import { agreedFactsBlock, assertAgentTranscript, pickThreadMessages } from './prompts.js';
import { earlierResult, transcriptFor, type StoredMessage } from './conversation.js';
import { vetDraft } from './assistantDraft.js';
import { MAILBOX, REPLY_THREADS, REPORTED_REPLY, renderThread, threadText } from './replyFixtures.js';

const northwind = REPLY_THREADS.find((t) => t.id === 'northwind')!;
const garbled = (text: string, context?: string) => findGarbledText(text, { context }).map((h) => h.sample);

// ---------- Text that is not prose ----------

test('the reported reply is garbled four separate ways', () => {
  const why = garbled(REPORTED_REPLY.body, threadText(northwind));
  assert.ok(why.some((w) => /^markup <\/p>/.test(w)), why.join(' | '));
  assert.ok(why.some((w) => /script the conversation never used: ".*末/.test(w)), why.join(' | '));
  assert.ok(why.some((w) => /^\d{3} words without a stop/.test(w)), why.join(' | '));
  assert.ok(why.some((w) => /^ends mid-sentence: ".*dealers"$/.test(w)), why.join(' | '));
});

test('real mail is not garbled: every message in the fixture mailbox passes', () => {
  // Sixty-odd messages with signatures, legal footers, quoted replies and a
  // forwarded note. A detector that flagged any of them would hold ordinary
  // mail, which is the expensive way for it to be wrong.
  for (const t of MAILBOX) {
    for (const m of renderThread(t)) {
      if (!m.text) continue;
      assert.deepEqual(garbled(m.text, m.text), [], `${t.id}: ${m.text.slice(0, 60)}`);
    }
  }
});

test('a writing system is only foreign when the conversation never used it', () => {
  const reply = 'Hi 田中さん,\n\nThank you for the note. Thursday works.\n\nAlex';
  assert.deepEqual(garbled(reply, '田中優希 wrote: could we meet?'), []);
  assert.match(garbled(reply, 'Dana wrote: could we meet?')[0] ?? '', /Chinese or Japanese|Japanese/);
  // With nothing to compare against, script is not judged at all.
  assert.deepEqual(garbled(reply), []);
});

test('a loop is caught; a phrase used twice is not', () => {
  const twice = 'Hi Dana,\n\nLet me know if Tuesday works. If not, let me know if Wednesday does.\n\nAlex';
  assert.deepEqual(garbled(twice), []);
  const loop = 'Hi Dana,\n\nWe look forward to it. We look forward to it. We look forward to it. We look forward to it.\n\nAlex';
  assert.match(garbled(loop)[0] ?? '', /on a loop/);
});

test('generated mail that is garbled is held; a template a person wrote is not', () => {
  const kinds = findTemplateArtifacts({ text: REPORTED_REPLY.body, specifics: { facts: 'We launched same-day bookkeeping this week.' } }).map((h) => h.kind);
  assert.ok(kinds.includes('garbled'));
  // Seventy words and no full stop, written by a person: a style, not a fault.
  const rambling = 'Thanks so much for coming to the open day we loved meeting everyone and hope to see you again soon at the next one which will be in the spring when the garden is at its best and the new classrooms are finished and we can show you round properly with the children and the teachers and all of the parents who helped to build it over the summer holidays';
  assert.deepEqual(findTemplateArtifacts({ text: rambling }), []);
});

test('planning the email instead of writing it is prompt text', () => {
  const plan = 'Hi there,\n\nWe are writing a reply to the latest message in the conversation. Let\'s draft: a short confirmation.';
  assert.ok(findTemplateArtifacts({ text: plan }).some((h) => h.kind === 'prompt_leak'));
  // The same words in an ordinary email are not.
  assert.deepEqual(findTemplateArtifacts({ text: 'Hi Dana,\n\nWe need to write a reply to the auditors by Friday, so I will send it tomorrow.\n\nAlex' }), []);
});

// ---------- The assistant reading a long thread ----------

test('a long thread keeps its opening and its end, and nothing out of order', () => {
  const shown = pickThreadMessages(Array(24).fill(1000), 12_000);
  assert.ok(shown.includes(0) && shown.includes(1), 'the opening, where terms are agreed');
  assert.ok([21, 22, 23].every((i) => shown.includes(i)), 'the newest three, whatever they cost');
  assert.ok(shown.length < 24);
  assert.deepEqual(shown, [...shown].sort((a, b) => a - b));
  assert.deepEqual(pickThreadMessages([100, 100, 100, 100], 12_000), [0, 1, 2, 3]);
});

test('the figures a trimmed middle held are still listed', () => {
  // £950 is agreed in message 13 of 24 — exactly the part a trimmed thread
  // drops, and exactly what the assistant invented when it could not see it.
  const block = agreedFactsBlock(renderThread(northwind).map((m) => ({ from: m.from.email, date: '', text: m.text })));
  assert.match(block, /£950/);
  assert.match(block, /30 September/);
  assert.match(block, /second Tuesday/i);
});

// ---------- One conversation leaking into the next ----------

const stored = (role: StoredMessage['role'], content: string, extra: Partial<StoredMessage> = {}): StoredMessage =>
  ({ id: 1, role, content, createdAt: '2026-09-11T00:00:00.000Z', ...extra });

test('an earlier question\'s tool results are replayed as a stub, not as the text', () => {
  const history: StoredMessage[] = [
    stored('user', 'What is this offer about?'),
    stored('assistant', '', { toolCalls: [{ id: 'c1', name: 'read_thread', arguments: { thread_id: 'newsletter' } }] }),
    stored('tool', 'Use code QUILLFEATHER for 10% off, Ledgerly launch event', { toolCallId: 'c1', name: 'read_thread' }),
    stored('assistant', 'It is a 10% launch discount.'),
    stored('user', 'Draft a reply to this answering her last question.'),
  ];
  const out = transcriptFor('rules', history);
  assert.doesNotThrow(() => assertAgentTranscript(out));
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  const tool = out.find((m) => m.role === 'tool')!;
  assert.equal(tool.content, earlierResult('read_thread'));
  assert.doesNotMatch(JSON.stringify(out.map((m) => m.content)), /QUILLFEATHER/);
});

test('this question\'s own tool results are replayed in full', () => {
  // A turn that died between the call and the answer is replayed from the
  // same question, and what it had already read still counts.
  const history: StoredMessage[] = [
    stored('user', 'Summarise this.'),
    stored('assistant', '', { toolCalls: [{ id: 'c1', name: 'read_thread', arguments: {} }] }),
    stored('tool', 'the whole thread', { toolCallId: 'c1', name: 'read_thread' }),
  ];
  assert.equal(transcriptFor('rules', history).find((m) => m.role === 'tool')!.content, 'the whole thread');
});

// ---------- The assistant's draft, held to the composer's standard ----------

test('an assistant reply that states a figure the thread never did is sent back', () => {
  const v = vetDraft({ raw: 'Hi Dana,\n\nThe monthly fee for this work is £4,250.\n\nBest,\nAlex', reply: true, recipient: { name: 'Dana Osei' }, facts: threadText(northwind) });
  assert.match(v.refusal ?? '', /£4,250/);
  assert.match(v.refusal ?? '', /read_thread/);
});

test('an assistant draft that is not prose is sent back rather than shown', () => {
  const v = vetDraft({ raw: REPORTED_REPLY.body, reply: false, facts: 'Ask whether they would like to try our new bookkeeping service.' });
  assert.match(v.refusal ?? '', /garbled/);
});

test('an acceptable assistant draft gets the composer\'s clean-up', () => {
  const v = vetDraft({
    raw: '**Hi Dana,**\n\nThe monthly close is £950 a month.\n\nBest,\nAlex\nalex@brightledger.example',
    reply: true, recipient: { name: 'Dana Osei', email: 'dana@northwind.example' },
    senderName: 'Alex Rivera', senderEmail: 'alex@brightledger.example', facts: threadText(northwind),
  });
  assert.equal(v.refusal, null);
  assert.equal(v.body, 'Hi Dana,\n\nThe monthly close is £950 a month.\n\nBest,\nAlex');
});

test('the salutation is corrected only when the recipient\'s name is known', () => {
  const fixed = vetDraft({ raw: 'Hi Priya,\n\nThe monthly close is £950 a month.\n\nAlex', reply: true, recipient: { name: 'Dana Osei' }, facts: threadText(northwind) });
  assert.match(fixed.body, /^Hi Dana,/);
  // Nothing on file says who Bob is, but the person may have told the
  // assistant — so the model's greeting stands rather than becoming "Hi there".
  const kept = vetDraft({ raw: 'Hi Bob,\n\nThanks for the note, Tuesday works for me.\n\nAlex', reply: false, recipient: { email: 'bob@elsewhere.example' }, facts: 'Tell Bob Tuesday works.' });
  assert.equal(kept.refusal, null);
  assert.match(kept.body, /^Hi Bob,/);
});
