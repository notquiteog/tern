// The floor Tern's AI features are built against, and the two things about it
// that are easy to get wrong later.
//
// The floor itself is a pair of constants and needs little guarding. What needs
// guarding is that it stays consistent with the installer — which cannot import
// TypeScript and so carries its own copy — and that the correction underneath
// it does not get undone.
//
// ── The correction ────────────────────────────────────────────────────────
//
// Two places used to state that a wider embedding model costs proportionally
// more disk: "the 8B builds an index over five times the size of an all-minilm
// one over the same mailbox". It is false, and has been since the keyed
// projection went in — every vector is cut to EMBED_DIMS before storage, so
// every row is the same size whatever produced it.
//
// It matters more than an ordinary stale comment because it argues against the
// floor. An admin reading it concludes that moving to qwen3-embedding:4b will
// cost them several times the storage, which is a reason not to, and the reason
// is not real. The instinct behind it is reasonable — a wider vector sounds
// like a bigger row — so it will be written again by somebody reasoning from
// first principles unless something objects.
//
// ── Not passing by finding nothing ────────────────────────────────────────
//
// The scan is anchored on a source tree it must actually find (asserted), and
// the absence assertion carries a positive control in the same test: a fixture
// holding both a false claim and the corrected sentence, asserting exactly
// which comes back. The corrected sentence is the important half — it contains
// most of the same words, so a scanner reading too loosely flags it, and a
// scanner that has stopped matching reports both halves clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { MODEL_TIERS, EMBED_MODELS, FLOOR_CHAT, FLOOR_EMBED, belowFloor } from './models.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** The repository, found rather than assumed. */
function repoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'install.sh'))
      && fs.existsSync(path.join(dir, 'docs', 'SETUP.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the repository to scan, starting from ${here}`);
}

function readReal(rel: string): string {
  const text = fs.readFileSync(path.join(repoRoot(), rel), 'utf8');
  assert.ok(text.length > 500, `${rel} is too short to have been read properly`);
  return text;
}

test('the floor names tiers that exist, and marks exactly those', () => {
  const byModel = new Map(MODEL_TIERS.map((t) => [t.model, t]));
  for (const name of FLOOR_CHAT) {
    const t = byModel.get(name);
    assert.ok(t, `FLOOR_CHAT names ${name}, which is not a tier`);
    assert.equal(t.floor, true, `${name} is the floor but is not marked floor: true`);
  }
  const marked = MODEL_TIERS.filter((t) => t.floor).map((t) => t.model).sort();
  assert.deepEqual(marked, [...FLOOR_CHAT].sort(),
    'the tiers marked floor and the FLOOR_CHAT list have drifted apart');
});

test('the embedding floor is a model this box can actually pull', () => {
  const m = EMBED_MODELS.find((e) => e.name === FLOOR_EMBED);
  assert.ok(m, `FLOOR_EMBED names ${FLOOR_EMBED}, which is not in EMBED_MODELS`);
  assert.equal(m.contextTokens, 32768, 'the floor embedder should take a whole message');
});

test('belowFloor answers for every tier, and only the small ones', () => {
  assert.equal(belowFloor('qwen3.5:0.8b'), true);
  assert.equal(belowFloor('qwen3.5:4b'), true);
  assert.equal(belowFloor('qwen3.5:9b'), false);
  assert.equal(belowFloor('gemma4:12b'), false);
  // Bigger than the floor is not below it, which inferring from a size table
  // would get wrong for the newest generation.
  assert.equal(belowFloor('qwen3.8:27b'), false);
  // A tag that arrives with :latest is the same model.
  assert.equal(belowFloor('gemma4:12b:latest'.replace(':latest', '')), false);
});

test('the installer and the catalogue agree about where the floor is', () => {
  const sh = readReal('install.sh');
  const m = /^FLOOR_GIB=(\d+)/m.exec(sh);
  assert.ok(m, 'install.sh no longer defines FLOOR_GIB — the guard cannot see the floor');

  const floorTier = MODEL_TIERS.find((t) => t.floor);
  assert.ok(floorTier, 'no tier is marked as the floor');
  assert.equal(Number(m[1]), floorTier.minGiB,
    `install.sh says FLOOR_GIB=${m[1]}, the smallest floor tier starts at ${floorTier.minGiB}`);

  // And the ladder itself must still match, since the installer duplicates it.
  for (const t of MODEL_TIERS) {
    assert.ok(sh.includes(t.model), `install.sh no longer offers ${t.model}`);
  }
});

/**
 * Sentences claiming that a wider embedding vector costs more storage.
 *
 * Narrow on purpose: it wants a width word and a storage word making a claim
 * together, which is the shape of the thing that was wrong. A sentence saying
 * width does NOT cost storage is the case that must survive.
 */
function widthCostsDiskClaims(text: string): string[] {
  const out: string[] = [];
  const flat = text.split('\n').join(' ').replace(/\s+/g, ' ');
  // Sentence by sentence, NOT paragraph by paragraph.
  //
  // This was written per paragraph first, and planting the false claim proved
  // it useless: the paragraph that corrects the claim necessarily contains
  // negations ("do not cost", "the same 256 bytes"), so a false sentence
  // dropped into that paragraph — which is exactly where somebody re-editing
  // this passage would put it — was excused by its neighbours. The guard
  // reported clean on text containing the very sentence it exists to catch.
  //
  // A claim is made in a sentence, so the negation that withdraws it has to be
  // in the same sentence to count.
  for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
    const width = /wider vectors|wider model|model's width|width|dimensions/i.test(sentence);
    const cost = /(times the size|more (?:disk|storage)|cost(?:s)? (?:disk|storage)|bigger index)/i.test(sentence);
    if (!width || !cost) continue;
    if (/\b(do not|does not|no more|not cost|same size|same \d+ bytes|regardless)\b/i.test(sentence)) continue;
    out.push(sentence.trim().slice(0, 220));
  }
  return out;
}

test('nothing claims a wider embedder costs more disk, because it does not', () => {
  // ── Positive control, in the same test ──
  const fixture = [
    'Wider vectors cost storage: email_vectors holds one row per message at the'
      + " model's width, so qwen3-embedding:8b builds an index over five times the"
      + ' size of an all-minilm one.',
    '',
    'Wider vectors do not cost storage. Every vector is projected to a fixed'
      + ' width before it is stored, so an all-minilm row and a qwen3-embedding:8b'
      + ' row are the same size and the index is the same size either way.',
    '',
    // The case that defeated the paragraph-scoped version of this scanner: a
    // false sentence inside the paragraph that corrects it, surrounded by the
    // negations that paragraph must contain. Kept because a plant found it.
    'Wider vectors cost storage, five times the size for the 8B. That is not'
      + ' true: every vector is projected to a fixed width, so the rows are the'
      + ' same size regardless.',
  ].join('\n');
  const caught = widthCostsDiskClaims(fixture);
  assert.equal(caught.length, 2,
    `the scanner no longer tells the false claim from its correction: ${JSON.stringify(caught)}`);
  assert.ok(caught.every((c) => /five times the size/.test(c)), JSON.stringify(caught));

  // ── The real files ──
  for (const rel of ['docs/CUSTOMIZING.md', 'server/src/ai/models.ts', 'docs/SETUP.md']) {
    const found = widthCostsDiskClaims(readReal(rel));
    assert.deepEqual(found, [],
      `${rel} says a wider embedding model costs more storage. It does not — every `
      + `vector is projected to EMBED_DIMS before storage:\n${found.join('\n')}`);
  }
});

test('the floor is documented as a warning rather than a wall', () => {
  // Without this said plainly, "tested against" becomes "requires" the first
  // time somebody summarises it, and an operator on a small VPS is told no by
  // a project that never decided to say no.
  for (const rel of ['docs/SETUP.md', 'README.md']) {
    assert.match(readReal(rel), /never a wall|warning, never/i,
      `${rel} states a floor without saying a smaller model is still allowed`);
  }
});

test('the frontier end is documented, so the floor is not read as a target', () => {
  const setup = readReal('docs/SETUP.md');
  assert.match(setup, /thinking/i, 'docs/SETUP.md does not mention thinking models');
  assert.match(setup, /16 GB/, 'docs/SETUP.md does not state the single-box requirement');
});
