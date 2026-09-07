// Secret sharing. This is the file where a subtle mistake is unrecoverable
// in the literal sense — a wrong field operation produces shares that
// recombine to plausible rubbish and nobody finds out until the day the key
// is actually needed. So the tests check the theorem, not just the happy path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  base32, combine, decodeShare, encodeShare, secretCheck, shareFingerprint, split, unbase32, verifySecret,
} from './shamir.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'); // 32 bytes

// Every k-subset of a list, so "any k shares" can be checked rather than
// assumed from one lucky combination.
function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [first, ...s]), ...subsets(rest, k)];
}

test('any k of n shares rebuild the key, and every k-subset does', () => {
  const shares = split(KEY, 5, 3);
  assert.equal(shares.length, 5);
  const combos = subsets(shares, 3);
  assert.equal(combos.length, 10);
  for (const combo of combos) {
    assert.deepEqual(combine(combo), KEY, `shares ${combo.map((s) => s.index).join(',')}`);
  }
});

test('more than the threshold also works', () => {
  const shares = split(KEY, 5, 3);
  assert.deepEqual(combine(shares), KEY);
  assert.deepEqual(combine(shares.slice(0, 4)), KEY);
});

test('fewer than the threshold reveals nothing, not merely "not enough"', () => {
  // The security claim is information-theoretic: k-1 shares are consistent
  // with every possible secret. What can be checked here is that they do not
  // produce the right one, over many keys, with every subset.
  for (let trial = 0; trial < 20; trial++) {
    const secret = randomBytes(32);
    const shares = split(secret, 4, 3);
    for (const combo of subsets(shares, 2)) {
      assert.notDeepEqual(combine(combo), secret, 'two of three must not rebuild the key');
    }
  }
});

test('a threshold of two works, and one share alone is refused', () => {
  const shares = split(KEY, 3, 2);
  assert.deepEqual(combine(shares.slice(0, 2)), KEY);
  assert.throws(() => combine(shares.slice(0, 1)), /at least two/);
});

test('the largest useful split still round-trips', () => {
  const shares = split(KEY, 255, 200);
  assert.deepEqual(combine(shares.slice(0, 200)), KEY);
});

test('impossible parameters are refused rather than silently adjusted', () => {
  assert.throws(() => split(KEY, 3, 1), /threshold/);
  assert.throws(() => split(KEY, 2, 3), /at least as many/);
  assert.throws(() => split(KEY, 256, 2), /at most 255/);
  assert.throws(() => split(Buffer.alloc(0), 3, 2), /nothing to split/);
});

test('a repeated share is caught instead of producing rubbish', () => {
  const shares = split(KEY, 5, 3);
  assert.throws(() => combine([shares[0], shares[0], shares[1]]), /same share was given twice/);
});

test('shares of different lengths are refused', () => {
  const a = split(KEY, 3, 2);
  const b = split(Buffer.alloc(16, 7), 3, 2);
  assert.throws(() => combine([a[0], b[1]]), /not from the same secret/);
});

test('every secret byte value survives, including zero', () => {
  // A field implementation that mishandles zero produces shares that work
  // for most keys and fail for a few.
  const secret = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const shares = split(secret, 4, 3);
  assert.deepEqual(combine(shares.slice(1, 4)), secret);
});

// ---------- The printed form ----------

test('a share survives being written down and typed back in', () => {
  const shares = split(KEY, 3, 2);
  const printed = shares.map((s) => encodeShare(s, 2));
  assert.match(printed[0], /^TERN1-[0-9A-Z-]+$/);
  const back = printed.map((p) => decodeShare(p));
  assert.equal(back[0].threshold, 2);
  assert.deepEqual(combine(back.slice(0, 2).map((b) => b.share)), KEY);
});

test('the letters Crockford drops are accepted from handwriting', () => {
  const printed = encodeShare(split(KEY, 3, 2)[0], 2);
  // Somebody reading their own capitals will type O for 0 and I or L for 1.
  const misread = printed.replace(/0/g, 'O').replace(/1(?!$)/g, 'I');
  assert.doesNotThrow(() => decodeShare(misread.replace('TERNI', 'TERN1')));
});

test('lowercase and stray spaces are forgiven', () => {
  const printed = encodeShare(split(KEY, 3, 2)[0], 2);
  assert.doesNotThrow(() => decodeShare(`  ${printed.toLowerCase()}  `));
});

test('a typo is caught by the checksum rather than becoming a wrong key', () => {
  const printed = encodeShare(split(KEY, 3, 2)[0], 2);
  // Change one character in the body to something else in the alphabet.
  const at = printed.length - 8;
  const wrong = printed.slice(0, at) + (printed[at] === 'A' ? 'B' : 'A') + printed.slice(at + 1);
  assert.throws(() => decodeShare(wrong), /typo|not look like|too short/);
});

test('a share from another scheme is refused outright', () => {
  assert.throws(() => decodeShare('SSSS1-ABCDE-FGHIJ'), /does not look like/);
  assert.throws(() => decodeShare(''), /does not look like/);
});

test('base32 round-trips arbitrary bytes', () => {
  for (const len of [1, 2, 5, 31, 32, 33, 100]) {
    const buf = randomBytes(len);
    assert.deepEqual(unbase32(base32(buf)).subarray(0, len), buf, `length ${len}`);
  }
});

// ---------- Fingerprints and the stored check ----------

test('a fingerprint identifies a share without being one', () => {
  const shares = split(KEY, 3, 2);
  const fps = shares.map(shareFingerprint);
  assert.equal(new Set(fps).size, 3, 'each share gets its own');
  assert.equal(fps[0].length, 8);
  // The fingerprint must not carry enough to help: it is a truncated digest
  // of a share that is itself useless on its own.
  assert.ok(!fps.some((f) => KEY.toString('hex').includes(f)));
});

test('the stored check recognises the right key and nothing else', () => {
  const check = secretCheck(KEY);
  assert.ok(verifySecret(KEY, check));
  assert.ok(!verifySecret(Buffer.from('0123456789abcdef0123456789abcdeg', 'utf8'), check));
  assert.ok(!verifySecret(KEY, 'deadbeef'));
  assert.ok(!verifySecret(KEY, ''));
  // It is a check, not a copy: sixteen hex characters cannot be a 32-byte key.
  assert.equal(check.length, 16);
});
