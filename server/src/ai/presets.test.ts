// The shipped presets, and the rules a saved one has to follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_PRESETS, PRESET_FIELDS, presetId, presetValues } from './presets.js';

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
