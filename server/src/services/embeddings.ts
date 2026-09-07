// The sealed half of meaning search (F1): turning an embedding into
// something that can be compared but not read.
//
// The problem. An embedding is not a hash. Given a vector and the model that
// made it, a good deal of the original text can be reconstructed — this is a
// published attack, not a theoretical one. So a column of plain embeddings
// beside a column of sealed bodies would quietly undo the encryption: the
// bodies would be ciphertext and the meanings would be sitting next to them
// in the clear.
//
// The transform. Every vector is passed through a keyed, structured
// orthogonal rotation and then cut down to a fixed number of coordinates:
//
//   pad to a power of two  →  (sign flip, Walsh–Hadamard) ×3  →  keep D of P
//
// Three rounds of "flip the signs by a keyed pattern, then transform" is the
// standard fast Johnson–Lindenstrauss construction. Each round is exactly
// orthogonal, so inner products — and therefore cosine similarity, which is
// all the ranking uses — survive the rotation untouched. Keeping the first D
// coordinates of a rotated vector is then a Johnson–Lindenstrauss
// projection: distances are preserved to within a few percent, which is far
// inside the noise of what "related" means for an email.
//
// What that buys, precisely:
//   - The sign patterns come from the person's own data key, so two accounts
//     on the same server produce unrelated geometry for the same sentence,
//     and nothing can be compared across accounts.
//   - The projection throws information away on purpose. A rotation alone is
//     reversible to somebody who recovers the key; a rotation followed by
//     keeping a quarter of the coordinates is not reversible even then.
//   - Without the key the stored rows are an unlabelled point cloud. No
//     public inversion model has an axis to hold on to.
//
// What it does not buy, and the docs say so in the same words: this is the
// same class of protection as the rest of the vault. Somebody holding the
// database *and* the server master key can re-derive the rotation, and can
// then do what the app does — compare. They still cannot read the text back
// out of the index, which is the point.
//
// No dependencies, no database, no I/O: all of it is testable on its own.
import { createHmac } from 'node:crypto';

// Coordinates kept per message. 256 signed bytes is a quarter of a kilobyte
// per email — 12 MB for a fifty-thousand message archive, small enough to
// scan in a tight loop without an approximate index, a new extension, or
// another container.
export const EMBED_DIMS = 256;

const ROUNDS = 3;
const INFO = 'tern-embed-rotation-v1';

export interface Rotation {
  /** Padded working width: the power of two at or above the model's own. */
  padded: number;
  /** Output width, always EMBED_DIMS (or `padded` when the model is smaller). */
  dims: number;
  /** One ±1 pattern per round, as the keyed sign flips. */
  signs: Int8Array[];
  /** Which of the padded coordinates are kept, and in what order. */
  pick: Int32Array;
  /** Undoes the shrinkage the projection causes, so norms come out near 1. */
  scale: number;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// A keyed stream of bytes. HMAC in counter mode rather than a cipher, so the
// only primitive this file needs is the one the vault already uses.
function keystream(key: Buffer, label: string, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let filled = 0;
  for (let counter = 0; filled < bytes; counter++) {
    const block = createHmac('sha256', key).update(`${INFO}|${label}|${counter}`).digest();
    const take = Math.min(block.length, bytes - filled);
    block.copy(out, filled, 0, take);
    filled += take;
  }
  return out;
}

// The rotation for one person and one model width. Derived, never stored:
// the data key is the only thing that has to survive, and a rotation that
// lived in a row would be one more secret to leak.
export function rotationFor(dek: Buffer, inputDims: number): Rotation {
  if (!Number.isInteger(inputDims) || inputDims < 2 || inputDims > 8192) {
    throw new Error(`Unsupported embedding width ${inputDims}`);
  }
  const key = createHmac('sha256', dek).update(INFO).digest();
  const padded = nextPowerOfTwo(inputDims);
  const dims = Math.min(EMBED_DIMS, padded);

  const signs: Int8Array[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    // One bit per coordinate per round.
    const bits = keystream(key, `signs${r}`, Math.ceil(padded / 8));
    const s = new Int8Array(padded);
    for (let i = 0; i < padded; i++) s[i] = (bits[i >> 3] >> (i & 7)) & 1 ? 1 : -1;
    signs.push(s);
  }

  // A keyed Fisher–Yates over the padded coordinates; the first `dims` of the
  // shuffle are the ones that are kept. Choosing them by key rather than
  // taking the leading block means an attacker who somehow learned the sign
  // patterns still would not know which axes survived.
  const order = new Int32Array(padded);
  for (let i = 0; i < padded; i++) order[i] = i;
  const rnd = keystream(key, 'pick', padded * 4);
  for (let i = padded - 1; i > 0; i--) {
    const j = rnd.readUInt32BE(i * 4) % (i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  const pick = order.slice(0, dims);

  return { padded, dims, signs, pick, scale: Math.sqrt(padded / dims) };
}

// In-place Walsh–Hadamard transform, normalised so the whole thing is
// orthogonal rather than merely orthogonal-up-to-a-constant. `len` is a power
// of two by construction.
export function walshHadamard(v: Float64Array): void {
  const n = v.length;
  for (let len = 1; len < n; len <<= 1) {
    for (let i = 0; i < n; i += len << 1) {
      for (let j = i; j < i + len; j++) {
        const a = v[j], b = v[j + len];
        v[j] = a + b;
        v[j + len] = a - b;
      }
    }
  }
  const norm = 1 / Math.sqrt(n);
  for (let i = 0; i < n; i++) v[i] *= norm;
}

// The stored form: `dims` signed bytes. The vector is unit-normalised first,
// so a dot product of two stored rows is their cosine similarity and nothing
// has to remember a magnitude.
export function project(rot: Rotation, vector: readonly number[] | Float64Array): Int8Array {
  const work = new Float64Array(rot.padded);
  const n = Math.min(vector.length, rot.padded);
  for (let i = 0; i < n; i++) work[i] = vector[i];

  for (let r = 0; r < ROUNDS; r++) {
    const s = rot.signs[r];
    for (let i = 0; i < rot.padded; i++) work[i] *= s[i];
    walshHadamard(work);
  }

  const out = new Float64Array(rot.dims);
  for (let i = 0; i < rot.dims; i++) out[i] = work[rot.pick[i]] * rot.scale;

  let len = 0;
  for (let i = 0; i < rot.dims; i++) len += out[i] * out[i];
  len = Math.sqrt(len);
  // A zero vector is a model that returned nothing; it is stored as zeros and
  // scores zero against everything, which is the right answer.
  const inv = len > 1e-12 ? 127 / len : 0;

  const q = new Int8Array(rot.dims);
  for (let i = 0; i < rot.dims; i++) {
    // Clamp rather than wrap: a single coordinate riding the rail costs a
    // little accuracy, whereas an overflow would flip its sign.
    q[i] = Math.max(-127, Math.min(127, Math.round(out[i] * inv)));
  }
  return q;
}

// Cosine similarity between two stored rows, in [-1, 1]. Both sides are
// unit-length before quantisation, so the dot product needs only to be
// divided by the square of the scale.
export function similarity(a: Int8Array, b: Int8Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot / (127 * 127);
}

export function toBuffer(v: Int8Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function fromBuffer(b: Buffer): Int8Array {
  return new Int8Array(b.buffer, b.byteOffset, b.byteLength);
}
