// Fitting an assistant turn into the model's window, and judging a draft
// against the right facts — the two things the reply evaluation found still
// wrong after the first round of fixes. No model and no database here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToWindow, type ChatMessage, type ToolSpec } from './llm.js';
import { assertAgentTranscript } from './prompts.js';
import { draftFacts } from './assistantDraft.js';
import { extractSpecifics, findInventedSpecifics } from './guard.js';

const tools: ToolSpec[] = [{ name: 'search_mail', description: 'Search.', parameters: { type: 'object', properties: {} } }];
const turn = (search: string, thread: string): ChatMessage[] => [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'Draft a reply to this.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search_mail', arguments: {} }] },
  { role: 'tool', content: search, toolCallId: 'c1', name: 'search_mail' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_thread', arguments: {} }] },
  { role: 'tool', content: thread, toolCallId: 'c2', name: 'read_thread' },
];

// ---------- the window ----------

test('a turn that fits is sent as it is', () => {
  const m = turn('s'.repeat(100), 't'.repeat(100));
  assert.deepEqual(fitToWindow(m, tools, 100_000), m);
});

test('a turn that does not fit loses a search before it loses the question or the thread', () => {
  // What Ollama did instead was drop the oldest messages — the question — and
  // the model, holding a thread and nothing asked of it, wrote nothing.
  const m = turn('OTHER THREAD '.repeat(400), 'THE THREAD '.repeat(300));
  const out = fitToWindow(m, tools, 5_000);
  assert.doesNotThrow(() => assertAgentTranscript(out));
  assert.deepEqual(out.map((x) => x.role), m.map((x) => x.role));
  assert.equal(out[1]!.content, 'Draft a reply to this.');
  assert.doesNotMatch(out[3]!.content, /OTHER THREAD/);
  assert.equal(out[5]!.content, m[5]!.content);
  // Only what is sent changes.
  assert.match(m[3]!.content, /OTHER THREAD/);
});

test('when even that is not enough, the newest result keeps its start and its end', () => {
  // read_thread puts the newest messages first-to-last and the agreed figures
  // at the very end, so both ends are what a reply needs.
  const thread = `NEWEST MESSAGE ${'x'.repeat(6000)} FIGURES: £950`;
  const kept = fitToWindow(turn('s'.repeat(3000), thread), tools, 3_000)[5]!.content;
  assert.ok(kept.length < thread.length);
  assert.match(kept, /^NEWEST MESSAGE/);
  assert.match(kept, /£950$/);
  assert.match(kept, /cut here to fit/);
});

test('a search that follows a read does not push the thread out, or invite going round', () => {
  // Measured: protecting the newest result instead sent a Northwind turn round
  // read_thread → search_mail for all six steps without drafting.
  const m: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'Draft a reply to this.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_thread', arguments: {} }] },
    { role: 'tool', content: 'THE THREAD '.repeat(300), toolCallId: 'c1', name: 'read_thread' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'search_mail', arguments: {} }] },
    { role: 'tool', content: 'OTHER THREAD '.repeat(400), toolCallId: 'c2', name: 'search_mail' },
  ];
  const out = fitToWindow(m, tools, 5_000);
  assert.doesNotThrow(() => assertAgentTranscript(out));
  assert.equal(out[3]!.content, m[3]!.content);
  assert.doesNotMatch(out[5]!.content, /OTHER THREAD/);
  assert.match(out[5]!.content, /rather than calling it again/);
});

// ---------- what a draft is judged against ----------

test('a draft may not borrow a figure from its own refusal', () => {
  const seen = { said: 'Draft a reply.', system: '', results: [{ name: 'draft_email', text: 'Nothing was put in front of the person: the draft states a figure it was never given "£4,250"' }] };
  const facts = draftFacts({ thread: 'The monthly close is £950.', reply: true, seen });
  assert.equal(findInventedSpecifics('The fee is £4,250.', { facts }).length, 1);
});

test('a reply may not borrow a figure from other mail; a new message may use what was looked up', () => {
  const seen = { said: '', system: '', results: [{ name: 'search_mail', text: 'Meridian quoted £2.10 a pallet' }, { name: 'my_day', text: 'free 14:00-15:00' }] };
  const reply = draftFacts({ thread: 'Can we talk?', reply: true, seen });
  assert.doesNotMatch(reply, /Meridian/);
  assert.match(reply, /14:00/);
  assert.match(draftFacts({ thread: '', reply: false, seen }), /Meridian/);
});

test('a month at the end of a line is not a date with the list number below it', () => {
  const tokens = extractSpecifics('1. Your year ends 30 September\n2. The board meets on the second Tuesday').map((s) => s.token);
  assert.ok(tokens.includes('day:sep-30'));
  assert.ok(!tokens.includes('day:sep-2'), tokens.join(' '));
  // Measured: this shape sent a correct Northwind reply back as "a date it was never given".
  const facts = 'Our fiscal year ends 30 September. The board meets on the second Tuesday of every month.';
  assert.deepEqual(findInventedSpecifics('Hi Dana,\n\n1. The year ends 30 September\n2. Nothing is in flight in the second Tuesday week.\n\nAlex', { facts }), []);
});
