import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import { dearmor, describeKeyShape, keyPackets, walkPackets } from './pgpPackets.js';

function fakeSubkey(algorithm: number, version = 4): Uint8Array {
  const body = new Uint8Array(1 + 4 + 1 + (version === 6 ? 4 : 0) + 64);
  body[0] = version; body[5] = algorithm;
  const len = body.length;
  const hdr = len < 192 ? new Uint8Array([0xc0 | 14, len]) : new Uint8Array([0xc0 | 14, ((len - 192) >> 8) + 192, (len - 192) & 0xff]);
  const out = new Uint8Array(hdr.length + body.length); out.set(hdr); out.set(body, hdr.length);
  return out;
}

test('walks a generated v4 key and names its algorithms', async () => {
  const { publicKey } = await openpgp.generateKey({ userIDs: [{ name: 'T', email: 't@x.test' }], format: 'armored' });
  const shape = describeKeyShape(publicKey);
  assert.equal(shape.version, 4);
  assert.equal(shape.postQuantum, false);
  assert.ok(shape.algorithms.some((a) => /EdDSA|Ed25519/.test(a)));
  assert.ok(shape.algorithms.some((a) => /ECDH|X25519/.test(a)));
  const bytes = dearmor(publicKey);
  const key = await openpgp.readKey({ armoredKey: publicKey });
  assert.deepEqual([...bytes], [...key.write()]);
});

test('recognises a v6 key', async () => {
  const { publicKey } = await openpgp.generateKey({ userIDs: [{ name: 'T', email: 't@x.test' }], format: 'armored', config: { v6Keys: true } });
  const shape = describeKeyShape(publicKey);
  assert.equal(shape.version, 6);
  assert.deepEqual(shape.algorithms, ['Ed25519', 'X25519']);
});

test('spots post-quantum subkeys the library cannot parse, on v4 and v6 keys', async () => {
  const { publicKey } = await openpgp.generateKey({ userIDs: [{ name: 'T', email: 't@x.test' }], format: 'binary' });
  for (const [algo, name, ver] of [[35, 'ML-KEM-768 + X25519', 4], [30, 'ML-DSA-65 + Ed25519', 6], [105, 'ML-KEM-768 + X25519 (experimental)', 4]] as const) {
    const fake = fakeSubkey(algo, ver);
    const spliced = new Uint8Array(publicKey.length + fake.length); spliced.set(publicKey); spliced.set(fake, publicKey.length);
    const shape = describeKeyShape(spliced);
    assert.equal(shape.postQuantum, true, name);
    assert.deepEqual(shape.postQuantumAlgorithms, [name]);
    // The library still reads the classical part and can encrypt to it.
    const k = await openpgp.readKey({ binaryKey: spliced });
    await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'x' }), encryptionKeys: k });
  }
});

test('handles old-format and partial-length headers', () => {
  // old format, one-octet length, tag 6 (public key), v4 RSA
  const oldFmt = new Uint8Array([0x98, 6, 4, 0, 0, 0, 0, 1]);
  assert.deepEqual(keyPackets(oldFmt).map((k) => [k.version, k.algorithm]), [[4, 1]]);
  // new format partial: first chunk 2 bytes (224 => 2^0 = 1? use 225 => 2 bytes), then final 4-byte chunk
  const partial = new Uint8Array([0xc0 | 14, 225, 4, 0, 4, 0, 0, 0, 35]);
  const pk = walkPackets(partial);
  assert.equal(pk.length, 1);
  assert.deepEqual([...pk[0].body], [4, 0, 0, 0, 0, 35]);
  assert.equal(keyPackets(partial)[0].algorithm, 35);
});
