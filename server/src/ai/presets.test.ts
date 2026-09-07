// The shipped presets, and the rules a saved one has to follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_PRESETS, PRESET_FIELDS, presetId, presetValues, defaultTuningFor, matchesPreset, presetFor, hasThinkingProfile } from './presets.js';

test('a preset carries how the model writes and nothing about the machine', () => {
  // The context window and the keep-alive are memory decisions — a preset
  // that resized the context would resize every parallel slot with it — and
  // the provider and model are a download, not a tuning change.
  for (const forbidden of ['numCtx', 'keepAlive', 'model', 'provider', 'baseUrl', 'apiKey', 'systemPrompt', 'concurrency', 'enabled']) {
    assert.equal(PRESET_FIELDS.includes(forbidden as never), false, forbidden);
  }
  const cleaned = presetValues({ temperature: 0.4, numCtx: 131072, apiKey: 'sk-leak', nonsense: true });
  assert.deepEqual(cleaned, { temperature: 0.4 });
});

test('a preset only carries the fields it actually set', () => {
  assert.deepEqual(presetValues({}), {});
  assert.deepEqual(presetValues(undefined), {});
  // false and 0 are values, not absences.
  assert.deepEqual(presetValues({ allowThinking: false, minP: 0 }), { allowThinking: false, minP: 0 });
});

test('two presets with the same name still get their own ids', () => {
  const first = presetId('Long replies', []);
  assert.equal(first, 'p-long-replies');
  assert.equal(presetId('Long replies', [first]), 'p-long-replies-2');
  assert.equal(presetId('Long replies!!', [first, 'p-long-replies-2']), 'p-long-replies-3');
  // A name with nothing usable in it still produces an id, and never a bare
  // one that could collide with a shipped preset.
  assert.equal(presetId('!!!', []), 'p-preset');
  assert.equal(presetId('builtin-balanced', []).startsWith('p-'), true);
});

test('the shipped presets are what Qwen3.5 asks for, in both of its modes', () => {
  const byId = Object.fromEntries(BUILT_IN_PRESETS.map((p) => [p.id, p]));
  const thinking = byId['builtin-qwen35-thinking'].values;
  const fast = byId['builtin-qwen35-fast'].values;
  // Qwen3.5's published recommendations: temperature 1.0 / top-p 0.95 while
  // reasoning, 0.7 / 0.8 when not, top-k 20 and presence penalty 1.5 either
  // way, with the repeat penalty left off because on this model the presence
  // penalty does that work.
  assert.deepEqual([thinking.temperature, thinking.topP, thinking.topK, thinking.presencePenalty, thinking.repeatPenalty], [1.0, 0.95, 20, 1.5, 1.0]);
  assert.deepEqual([fast.temperature, fast.topP, fast.topK, fast.presencePenalty, fast.repeatPenalty], [0.7, 0.8, 20, 1.5, 1.0]);
  assert.equal(thinking.allowThinking, true);
  assert.equal(fast.allowThinking, false);
  assert.ok((thinking.thinkingBudget ?? 0) > 0, 'a thinking preset that leaves no room to think would answer with nothing');
});

test('every shipped preset is applicable and inside the bounds the API enforces', () => {
  const ids = new Set<string>();
  for (const p of BUILT_IN_PRESETS) {
    assert.equal(ids.has(p.id), false, `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.equal(p.builtIn, true);
    assert.ok(p.name.length > 0 && p.name.length <= 60);
    assert.ok(p.note.length > 0 && p.note.length <= 400);
    assert.deepEqual(presetValues(p.values), p.values, `${p.id} carries a field a preset may not carry`);
    const v = p.values;
    assert.ok((v.temperature ?? 0) >= 0 && (v.temperature ?? 0) <= 2);
    assert.ok((v.topP ?? 1) > 0 && (v.topP ?? 1) <= 1);
    assert.ok((v.topK ?? 1) >= 1 && (v.topK ?? 1) <= 200);
    assert.ok((v.repeatPenalty ?? 1) >= 0.5 && (v.repeatPenalty ?? 1) <= 2);
    assert.ok((v.presencePenalty ?? 0) >= -2 && (v.presencePenalty ?? 0) <= 2);
    assert.ok((v.maxTokens ?? 64) >= 64 && (v.maxTokens ?? 64) <= 4096);
  }
});

test('every shipped preset carries the vendor\'s own published numbers', () => {
  // Qwen publish both modes and state min_p = 0 for each. Ollama bakes the
  // *thinking* pair in as the model default, which is the wrong one for a
  // mail client answering straight — so the straight profile has to be set
  // explicitly rather than left to the model file.
  const straight = presetFor('qwen3.5:4b', 'straight');
  assert.equal(straight.temperature, 0.7);
  assert.equal(straight.topP, 0.8);
  assert.equal(straight.topK, 20);
  assert.equal(straight.minP, 0);
  assert.equal(straight.presencePenalty, 1.5);
  // Presence penalty and repeat penalty are two repetition controls; Qwen ask
  // for the first, so the second is off rather than stacked on top.
  assert.equal(straight.repeatPenalty, 1.0);
  assert.equal(straight.allowThinking, false);

  const thinking = presetFor('qwen3.5:4b', 'thinking');
  assert.equal(thinking.temperature, 1.0);
  assert.equal(thinking.topP, 0.95);
  assert.equal(thinking.topK, 20);
  assert.equal(thinking.minP, 0);
  assert.equal(thinking.allowThinking, true);
  // Measured: uncapped reasoning runs to 12,479 tokens on a long thread.
  assert.ok((thinking.thinkingBudget ?? 0) >= 13_000, 'the budget must clear the measured maximum');

  // Mistral's one published number, and it is unusually low.
  assert.equal(presetFor('mistral-small:24b', 'straight').temperature, 0.15);
  // Phi-4 has no official recommendation; these are its report's own numbers.
  assert.equal(presetFor('phi4:14b', 'straight').temperature, 0.5);
  assert.equal(presetFor('phi4:14b', 'straight').topK, 50);
  // Anything unknown gets the general-purpose set.
  for (const tag of ['qwen2.5:1.5b', 'llama3.2:3b', 'gemma3:4b', '']) {
    assert.equal(presetFor(tag, 'straight').topK, 40, tag);
  }
});

test('the whole qwen3.5 family is matched, however it is tagged', () => {
  for (const tag of ['qwen3.5:9b', 'qwen3.5:4b-instruct-q4_K_M', 'QWEN3.5:4B']) {
    assert.equal(presetFor(tag, 'straight').topP, 0.8, tag);
  }
  // A model with one mode does not pretend to have two.
  assert.equal(hasThinkingProfile('qwen3.5:4b'), true);
  assert.equal(hasThinkingProfile('mistral-small:24b'), false);
  assert.equal(hasThinkingProfile('phi4:14b'), false);
});

test('"untouched" is exact equality, so a hand-tuned install keeps its numbers', () => {
  const q35 = defaultTuningFor('qwen3.5:4b');
  assert.equal(matchesPreset(q35, q35), true);
  assert.equal(matchesPreset({ ...q35, temperature: 0.9 }, q35), false);
  assert.equal(matchesPreset(defaultTuningFor('mistral-small:24b'), q35), false);
});
