// The model catalogues. Mostly data, but two things in it are load-bearing:
// that an embedding model can be told apart from one that writes, and that
// every tag offered is one the registry will actually resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURATED_MODELS, EMBED_MODELS, MODEL_TIERS, isEmbedModel, recommendModel } from './models.js';

test('the models for meaning search are a separate list from the ones that write', () => {
  // They were not, and the consequence was that all-minilm appeared in the
  // writing table with a "Use" button that would have set it as the drafting
  // model — a model that cannot generate a word.
  const writing = new Set(CURATED_MODELS.map((m) => m.name));
  for (const e of EMBED_MODELS) assert.equal(writing.has(e.name), false, e.name);
  assert.deepEqual(EMBED_MODELS.map((m) => m.name), [
    'all-minilm', 'nomic-embed-text', 'embeddinggemma', 'qwen3-embedding:0.6b',
    'mxbai-embed-large', 'bge-m3', 'snowflake-arctic-embed2',
    'qwen3-embedding:4b', 'qwen3-embedding:8b',
  ]);
  // And in that order for a reason: the table is drawn in list order and the
  // decision an admin is making is "what fits on this box", so the cheapest
  // thing that could work has to be at the top. A model appended to the end
  // because that is where the cursor was would put a 4.7 GB pull above a
  // 670 MB one.
  const sizes = EMBED_MODELS.map((m) => m.sizeBytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), 'the embedders are not ordered by download size');
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

