// The model catalogues. Mostly data, but two things in it are load-bearing:
// that an embedding model can be told apart from one that writes, and that
// every tag offered is one the registry will actually resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURATED_MODELS, EMBED_MODELS, MODEL_TIERS, isEmbedModel, recommendModel, recommendNumCtx, clampNumCtx, CTX_TIERS } from './models.js';

test('the models for meaning search are a separate list from the ones that write', () => {
  // They were not, and the consequence was that all-minilm appeared in the
  // writing table with a "Use" button that would have set it as the drafting
  // model — a model that cannot generate a word.
  const writing = new Set(CURATED_MODELS.map((m) => m.name));
  for (const e of EMBED_MODELS) assert.equal(writing.has(e.name), false, e.name);
  assert.deepEqual(EMBED_MODELS.map((m) => m.name), ['all-minilm', 'nomic-embed-text', 'embeddinggemma']);
});

test('an embedding model is recognised whether or not Ollama tagged it', () => {
  // The settings hold "all-minilm"; /api/tags answers "all-minilm:latest".
  assert.equal(isEmbedModel('all-minilm'), true);
  assert.equal(isEmbedModel('all-minilm:latest'), true);
  assert.equal(isEmbedModel('nomic-embed-text:latest'), true);
  assert.equal(isEmbedModel('qwen3.5:4b'), false);
  assert.equal(isEmbedModel(''), false);
  assert.equal(isEmbedModel(undefined as any), false);
});

test('every embedding model says what it costs loaded, not just downloaded', () => {
  // "wants" is the number that decides whether it fits: it loads beside the
  // writing model rather than instead of it, so its memory is on top.
  for (const m of EMBED_MODELS) {
    assert.ok(m.needsBytes > m.sizeBytes, `${m.name}: loaded should cost more than the download`);
    assert.ok(m.contextTokens >= 512, m.name);
    assert.ok(m.note.length > 20, m.name);
    assert.ok(m.params.length > 0, m.name);
  }
});

test('the smallest embedding model stays small enough for the box Tern ships to', () => {
  // The default has to load beside the writing model on a 4.5 GB VPS that is
  // also running Postgres and the app; anything approaching a gigabyte there
  // is not a default, it is a decision.
  const dflt = EMBED_MODELS[0];
  assert.equal(dflt.name, 'all-minilm');
  assert.ok(dflt.needsBytes <= 0.4e9, 'the default embedding model must stay under 400 MB loaded');
});

test('a tier is picked by what the machine actually has', () => {
  assert.equal(recommendModel(2 * 1024 ** 3).model, MODEL_TIERS[0].model);
  assert.equal(recommendModel(8 * 1024 ** 3).model, 'qwen3.5:2b');
  assert.equal(recommendModel(64 * 1024 ** 3).model, 'gemma4:12b');
  // The context window scales with the box for the same reason.
  assert.ok(recommendNumCtx(2 * 1024 ** 3) < recommendNumCtx(32 * 1024 ** 3));
});

test('the context window is bounded by what the model was trained for', () => {
  // Ollama accepts a num_ctx larger than the model's training length and
  // extends it, which costs quality silently rather than failing. The three
  // models measured here differ by 16x: phi4 is trained to 16k,
  // mistral-small to 32k, qwen3.5 to 262k — so a default sized from host
  // memory alone would have run phi4 at double its native window.
  assert.equal(clampNumCtx(32768, 16384), 16384);   // phi4
  assert.equal(clampNumCtx(32768, 32768), 32768);   // mistral-small, exactly
  assert.equal(clampNumCtx(32768, 262144), 32768);  // qwen3.5, plenty of room
  // A model that does not report a limit is left alone rather than guessed at.
  assert.equal(clampNumCtx(32768, null), 32768);
  assert.equal(clampNumCtx(32768, 0), 32768);
});

test('every context tier can hold a real conversation', () => {
  // The tiers were raised once num_ctx actually governed how much thread the
  // model sees. The smallest must still fit the 24-message fixture, which is
  // about 8,500 tokens.
  assert.ok(CTX_TIERS[0].numCtx >= 8192, 'the bottom tier must hold a real thread');
  for (let i = 1; i < CTX_TIERS.length; i++) {
    assert.ok(CTX_TIERS[i].numCtx > CTX_TIERS[i - 1].numCtx, 'tiers increase');
    assert.ok(CTX_TIERS[i].minGiB > CTX_TIERS[i - 1].minGiB, 'thresholds increase');
  }
  assert.equal(recommendNumCtx(4 * 1024 ** 3), 8192);
  assert.equal(recommendNumCtx(31 * 1024 ** 3), 32768);
});
