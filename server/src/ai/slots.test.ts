// Sharing one model between several people: who runs, who waits, and how
// many slots an install should be asking Ollama for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireSlot, kvBytesPerToken, resetSlots, slotAdvice, slotPlan, slotStats, MAX_WAITING } from './slots.js';

test('concurrency off is one generation at a time', () => {
  const plan = slotPlan(false, 8);
  assert.equal(plan.slots, 1);
  // Nothing to reserve when there is one slot: background work may have it.
  assert.equal(plan.background, 1);
});

test('concurrency on follows what Ollama was started with, and keeps a slot back', () => {
  assert.deepEqual(slotPlan(true, 4), { enabled: true, slots: 4, background: 3, perUser: 1 });
  assert.equal(slotPlan(true, 0).slots, 1, 'a missing or nonsense setting is one slot, not none');
});

test('two people are answered at once; a third waits for a slot', async () => {
  resetSlots();
  const plan = slotPlan(true, 2);
  const a = await acquireSlot(plan, 'interactive', 'ana');
  const b = await acquireSlot(plan, 'interactive', 'ben');
  assert.equal(slotStats().running, 2);
  let cStarted = false;
  const c = acquireSlot(plan, 'interactive', 'cleo').then((r) => { cStarted = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(cStarted, false, 'both slots are busy');
  assert.equal(slotStats().waiting, 1);
  a();
  const release = await c;
  assert.equal(cStarted, true, 'the freed slot went to whoever was waiting');
  b(); release();
  assert.equal(slotStats().running, 0);
  resetSlots();
});

test('one person cannot hold two interactive slots while anyone else is waiting', async () => {
  resetSlots();
  const plan = slotPlan(true, 4);
  const first = await acquireSlot(plan, 'interactive', 'ana');
  let second = false;
  void acquireSlot(plan, 'interactive', 'ana').then(() => { second = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(second, false, 'a second draft from the same person queues behind their first');
  // ...but the slots are not idle: somebody else goes straight through.
  const ben = await acquireSlot(plan, 'interactive', 'ben');
  assert.equal(slotStats().running, 2);
  first(); ben();
  resetSlots();
});

test('background work never takes the last slot', async () => {
  resetSlots();
  const plan = slotPlan(true, 2);
  const s1 = await acquireSlot(plan, 'background', 'summaries');
  let second = false;
  void acquireSlot(plan, 'background', 'campaign').then(() => { second = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(second, false, 'the second slot is kept for somebody who is waiting');
  const person = await acquireSlot(plan, 'interactive', 'ana');
  assert.equal(slotStats().running, 2);
  s1(); person();
  resetSlots();
});

test('a queue that is already too long is told the assistant is busy', async () => {
  resetSlots();
  const plan = slotPlan(true, 1);
  const held = await acquireSlot(plan, 'interactive', 'ana');
  const waiting = [];
  for (let i = 0; i < MAX_WAITING; i++) waiting.push(acquireSlot(plan, 'interactive', `p${i}`).catch(() => {}));
  await assert.rejects(() => acquireSlot(plan, 'interactive', 'late'), /busy/i);
  held();
  resetSlots();
  await Promise.all(waiting);
});

test('a cancelled request gives up its place rather than holding it', async () => {
  resetSlots();
  const plan = slotPlan(true, 1);
  const held = await acquireSlot(plan, 'interactive', 'ana');
  const ac = new AbortController();
  const pending = acquireSlot(plan, 'interactive', 'ben', ac.signal);
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await assert.rejects(() => pending, /cancel/i);
  assert.equal(slotStats().waiting, 0);
  held();
  resetSlots();
});

test('a slot is priced from the model’s own attention numbers', () => {
  // qwen2.5:1.5b: 28 blocks, 2 KV heads, 128-wide keys and values. At f16
  // that is 28 KB a token, so an 8192-token slot is about 224 MB.
  const info = { 'qwen2.block_count': 28, 'qwen2.attention.head_count_kv': 2, 'qwen2.attention.key_length': 128, 'qwen2.attention.value_length': 128 };
  assert.equal(kvBytesPerToken(info, 'f16'), 28_672);
  // q8_0 is 8.5 bits an element, so it costs a little over half.
  assert.equal(kvBytesPerToken(info, 'q8_0'), 15_232);
  assert.equal(kvBytesPerToken(info, 'q4_0'), 8064);
});

test('a model that does not describe its attention is priced at nothing rather than wrongly', () => {
  assert.equal(kvBytesPerToken(undefined, 'f16'), null);
  assert.equal(kvBytesPerToken({ 'general.architecture': 'llama' }, 'f16'), null);
  // Head width can be worked out from the embedding when it is not given.
  const derived = kvBytesPerToken({ 'llama.block_count': 2, 'llama.attention.head_count_kv': 1, 'llama.embedding_length': 256, 'llama.attention.head_count': 2 }, 'f16');
  assert.equal(derived, 2 * 1 * (128 + 128) * 2);
});

test('the advice is one slot per person, as far as the memory goes', () => {
  const perToken = 15_232; // qwen2.5:1.5b with a q8_0 cache
  const gb = 1024 ** 3;
  // Five people, a small model, and room to spare: everyone gets a slot.
  const roomy = slotAdvice({ users: 5, configured: 2, numCtx: 8192, kvPerToken: perToken, modelBytes: gb, memBudgetBytes: 8 * gb });
  assert.equal(roomy.needed, 5);
  assert.equal(roomy.recommended, 5);
  assert.equal(roomy.enough, false, 'two slots for five people is not enough');
  assert.equal(roomy.memoryBound, false);
  // Eight people, a 7b model and a 6 GB limit: the weights leave room for
  // four slots, and memory — not the setting — is what stops the other four.
  const tight = slotAdvice({ users: 8, configured: 2, numCtx: 8192, kvPerToken: 30_464, modelBytes: Math.round(4.7 * gb), memBudgetBytes: 6 * gb });
  assert.equal(tight.memoryBound, true);
  assert.ok(tight.recommended < 8 && tight.recommended >= 1);
  assert.equal(tight.recommended, tight.affordable);
  // A slot is never priced at nothing, so a box with no room left is told it
  // has one, not none.
  const nothingLeft = slotAdvice({ users: 5, configured: 4, numCtx: 8192, kvPerToken: perToken, modelBytes: 2 * gb, memBudgetBytes: Math.round(2.3 * gb) });
  assert.equal(nothingLeft.recommended, 1);
});

test('with nothing known about memory the advice is still one slot per person', () => {
  const blind = slotAdvice({ users: 3, configured: 3, numCtx: 8192, kvPerToken: null, modelBytes: 0, memBudgetBytes: 0 });
  assert.equal(blind.affordable, null);
  assert.equal(blind.perSlotBytes, null);
  assert.equal(blind.recommended, 3);
  assert.equal(blind.enough, true);
  assert.equal(blind.memoryBound, false);
});
