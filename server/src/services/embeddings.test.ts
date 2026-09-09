// The keyed projection is only worth anything if it keeps the ranking it is
// supposed to keep and destroys the geometry it is supposed to destroy. Both
// halves are checked here, on synthetic vectors, with no model in the way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBED_DIMS, fromBuffer, project, rotationFor, similarity, toBuffer, walshHadamard } from './embeddings.js';
import { EMBED_CATALOGUE } from '../ai/providers.js';

const DEK = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 11);

// A deterministic stand-in for a model: any seed gives the same vector, and
// two nearby seeds give nearby vectors.
function fakeEmbedding(seed: number, dims = 768): Float64Array {
  const v = new Float64Array(dims);
  let x = seed * 2654435761 % 2 ** 31;
  for (let i = 0; i < dims; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    v[i] = (x / 2 ** 31) - 0.5;
  }
  return v;
}

function unitCosine(a: Float64Array, b: Float64Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

function blend(a: Float64Array, b: Float64Array, t: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - t) + b[i] * t;
  return out;
}

// ---------- The transform itself ----------

test('the Walsh-Hadamard transform is its own inverse and keeps lengths', () => {
  const v = new Float64Array([1, -2, 3, 4, -5, 6, 7, -8]);
  const before = Math.hypot(...v);
  const copy = Float64Array.from(v);
  walshHadamard(copy);
  assert.ok(Math.abs(Math.hypot(...copy) - before) < 1e-9, 'length is preserved');
  walshHadamard(copy);
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(copy[i] - v[i]) < 1e-9, `coordinate ${i} round-trips`);
});

test('a projected vector is the stored width and is unit length after scaling', () => {
  const rot = rotationFor(DEK, 768);
  assert.equal(rot.dims, EMBED_DIMS);
  assert.equal(rot.padded, 1024);
  const q = project(rot, fakeEmbedding(1));
  assert.equal(q.length, EMBED_DIMS);
  assert.ok(Math.abs(similarity(q, q) - 1) < 0.02, 'a vector is maximally similar to itself');
});

test('projection is deterministic for one key', () => {
  const rot = rotationFor(DEK, 768);
  const a = project(rot, fakeEmbedding(42));
  const b = project(rotationFor(DEK, 768), fakeEmbedding(42));
  assert.deepEqual([...a], [...b]);
});

// ---------- What it must preserve ----------

test('cosine similarity survives the projection', () => {
  const rot = rotationFor(DEK, 768);
  const base = fakeEmbedding(3);
  const far = fakeEmbedding(99);
  // Several degrees of relatedness, from "the same text" to "unrelated".
  for (const t of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    const other = blend(base, far, t);
    const before = unitCosine(base, other);
    const after = similarity(project(rot, base), project(rot, other));
    assert.ok(
      Math.abs(before - after) < 0.08,
      `t=${t}: cosine ${before.toFixed(3)} became ${after.toFixed(3)}`,
    );
  }
});

test('the ranking a search depends on is unchanged', () => {
  const rot = rotationFor(DEK, 768);
  const query = fakeEmbedding(5);
  const far = fakeEmbedding(500);
  // Ten candidates, each further from the query than the last by construction.
  const candidates = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => blend(query, far, t));
  const trueOrder = candidates
    .map((c, i) => ({ i, s: unitCosine(query, c) }))
    .sort((a, b) => b.s - a.s).map((r) => r.i);
  const q = project(rot, query);
  const projectedOrder = candidates
    .map((c, i) => ({ i, s: similarity(q, project(rot, c)) }))
    .sort((a, b) => b.s - a.s).map((r) => r.i);
  assert.deepEqual(projectedOrder, trueOrder);
});

// ---------- What it must destroy ----------

test('two accounts produce unrelated geometry for the same vector', () => {
  const mine = project(rotationFor(DEK, 768), fakeEmbedding(8));
  const theirs = project(rotationFor(OTHER, 768), fakeEmbedding(8));
  // The same input under two keys must not look like the same thing, or a
  // server holding both could match one person's mail against another's.
  assert.ok(Math.abs(similarity(mine, theirs)) < 0.25, 'identical text under two keys does not correlate');
});

test('a wrong key destroys the ranking rather than degrading it', () => {
  const query = fakeEmbedding(11);
  const near = blend(query, fakeEmbedding(600), 0.05);
  const stored = project(rotationFor(DEK, 768), near);
  const rightKey = similarity(project(rotationFor(DEK, 768), query), stored);
  const wrongKey = similarity(project(rotationFor(OTHER, 768), query), stored);
  assert.ok(rightKey > 0.85, `the right key still finds it (${rightKey.toFixed(3)})`);
  assert.ok(Math.abs(wrongKey) < 0.25, `the wrong key does not (${wrongKey.toFixed(3)})`);
});

test('the projection throws information away, so it is not merely a rotation', () => {
  const rot = rotationFor(DEK, 768);
  // 768 inputs to 256 stored coordinates: whole directions in the input space
  // survive nowhere. Two vectors differing only inside the discarded subspace
  // are therefore indistinguishable once stored, which is what makes the
  // transform one-way even to someone holding the key.
  assert.ok(rot.dims < rot.padded / 2);
  assert.equal(new Set([...rot.pick]).size, rot.dims, 'kept coordinates are distinct');
});

// ---------- Storage ----------

test('a stored vector round-trips through its buffer', () => {
  const q = project(rotationFor(DEK, 768), fakeEmbedding(21));
  const back = fromBuffer(toBuffer(q));
  assert.deepEqual([...back], [...q]);
  assert.equal(toBuffer(q).length, EMBED_DIMS);
});

test('a model narrower than the stored width is padded, not truncated', () => {
  const rot = rotationFor(DEK, 384);
  assert.equal(rot.padded, 512);
  assert.equal(rot.dims, EMBED_DIMS);
  const a = fakeEmbedding(4, 384);
  const b = blend(a, fakeEmbedding(70, 384), 0.2);
  const before = unitCosine(a, b);
  const after = similarity(project(rot, a), project(rot, b));
  assert.ok(Math.abs(before - after) < 0.08, `${before.toFixed(3)} vs ${after.toFixed(3)}`);
});

test('an empty vector stores as zeros and matches nothing', () => {
  const rot = rotationFor(DEK, 768);
  const q = project(rot, new Float64Array(768));
  assert.ok([...q].every((x) => x === 0));
  assert.equal(similarity(q, project(rot, fakeEmbedding(1))), 0);
});

// ---------- Every embedder Tern offers, not just the default ----------
//
// The projection was only ever exercised at 768, which is the width of the
// two small Ollama models and of nothing else in the catalogue. Everything
// worth pointing meaning search at is somewhere between 384 and 4096 —
// Qwen3-Embedding-4B is 2560, the 8B is 4096, OpenAI's large is 3072 — and
// each of those pads to a different power of two and keeps a different subset
// of coordinates. A width that failed would fail silently: `project` would
// throw during a background index pass, or worse, return something that
// scores plausibly and ranks wrongly.

test('every embedder in the catalogue has a usable rotation', () => {
  assert.ok(EMBED_CATALOGUE.length >= 8, 'the catalogue is empty — this check would report clean on that');
  for (const m of EMBED_CATALOGUE) {
    const rot = rotationFor(DEK, m.dims);
    assert.ok(rot.padded >= m.dims, `${m.name}: padded to ${rot.padded}, below its own ${m.dims}`);
    assert.equal(rot.padded & (rot.padded - 1), 0, `${m.name}: padded width is not a power of two`);
    assert.equal(rot.dims, Math.min(EMBED_DIMS, rot.padded), `${m.name}: unexpected stored width`);
    const q = project(rot, fakeEmbedding(5, m.dims));
    assert.equal(q.length, rot.dims, `${m.name}: stored the wrong number of coordinates`);
    assert.ok(Math.abs(similarity(q, q) - 1) < 0.02, `${m.name}: a vector is not maximally similar to itself`);
  }
});

test('ranking survives the projection at every catalogue width', () => {
  // The property the whole feature rests on, checked per model rather than
  // once at 768.
  //
  // Two claims, and the second is the one that matters. The absolute error is
  // bounded — the projection estimates an inner product from 256 coordinates,
  // so its standard deviation is around 1/16 whatever came in, and 0.15 is a
  // little over two of those. But search does not read an absolute number: it
  // sorts. So the ordering is asserted outright, because a projection that
  // was accurate to a hundredth and reordered two results would be useless,
  // and one that is out by a tenth and never reorders is fine.
  const TOLERANCE = 0.15;
  for (const m of EMBED_CATALOGUE) {
    const rot = rotationFor(DEK, m.dims);
    const base = fakeEmbedding(3, m.dims);
    const far = fakeEmbedding(99, m.dims);
    const scores: number[] = [];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const other = blend(base, far, t);
      const before = unitCosine(base, other);
      const after = similarity(project(rot, base), project(rot, other));
      assert.ok(
        Math.abs(before - after) < TOLERANCE,
        `${m.name} (${m.dims}) at t=${t}: cosine ${before.toFixed(3)} became ${after.toFixed(3)}`,
      );
      scores.push(after);
    }
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] < scores[i - 1],
        `${m.name} (${m.dims}): a less related vector scored higher (${scores[i - 1].toFixed(3)} then ${scores[i].toFixed(3)})`);
    }
    // And the two ends stay on the right sides of the threshold meaning
    // search actually uses, which is what "it still works" means in practice.
    assert.ok(scores[0] > 0.9, `${m.name}: an identical vector scored only ${scores[0].toFixed(3)}`);
    assert.ok(scores[scores.length - 1] < 0.28, `${m.name}: an unrelated vector scored ${scores[scores.length - 1].toFixed(3)}, above the search threshold`);
  }
});

test('the stored width says nothing about which model made the row', () => {
  // The reason `semanticSearch` scopes its scan by model NAME and not by
  // `dims`, written down as a test because the comment that said otherwise
  // was wrong for a year.
  //
  // Every vector is projected to EMBED_DIMS regardless of what came in, so an
  // all-minilm row and a Qwen3-Embedding-4B row are both 256 bytes wide and a
  // `WHERE dims = ?` clause matches both. Their rotations are derived from
  // their INPUT widths, so they live in different spaces: scoring one against
  // the other's needle is noise. Over a large mailbox some of that noise
  // clears the score threshold and comes back as a confident result about an
  // unrelated message.
  const widths = [...new Set(EMBED_CATALOGUE.map((m) => m.dims))];
  assert.ok(widths.length >= 4, 'the catalogue no longer has a spread of widths to check');
  const stored = widths.map((d) => project(rotationFor(DEK, d), fakeEmbedding(17, d)).length);
  assert.equal(new Set(stored).size, 1, `stored widths differ across models (${stored.join(', ')}) — this test’s premise has changed`);
  assert.equal(stored[0], EMBED_DIMS);

  // And the geometry really is unrelated, which is what makes matching across
  // them wrong rather than merely untidy.
  const small = project(rotationFor(DEK, 384), fakeEmbedding(17, 384));
  const large = project(rotationFor(DEK, 2560), fakeEmbedding(17, 2560));
  assert.ok(Math.abs(similarity(small, large)) < 0.25,
    'the same seed under two model widths correlates, which would make the mixing harmless — it is not');
});
