import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, decrypt, encrypt, hashPassword, signPayload, totpCode, verifyPassword, verifyPayload, verifyTotp } from './crypto.js';

test('passwords hash and verify', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});

test('encrypt/decrypt round trips and tampering fails', () => {
  const ct = encrypt('api-token-123');
  assert.equal(decrypt(ct), 'api-token-123');
  const parts = ct.split('.');
  parts[3] = parts[3].slice(0, -2) + 'AA';
  assert.throws(() => decrypt(parts.join('.')));
});

test('signed payloads verify and reject edits', () => {
  const t = signPayload('u:1:2:3');
  assert.equal(verifyPayload(t), 'u:1:2:3');
  assert.equal(verifyPayload(t.replace('.', 'x.')), null);
});

test('TOTP matches RFC 6238 style codes', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // RFC 6238 test vector: T=59 with SHA1 -> 94287082 (8 digits); 6-digit tail is 287082.
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(verifyTotp(secret, totpCode(secret)), true);
  assert.equal(verifyTotp(secret, '000000'), false);
});

test('a TOTP code is accepted once: the matched step is refused when it is not newer than the last one', async () => {
  const { matchTotp } = await import('./crypto.js');
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const at = 59_000;
  const step = matchTotp(secret, '287082', null, 1, at);
  assert.equal(step, 1);
  assert.equal(matchTotp(secret, '287082', step, 1, at), null, 'same code replayed');
  assert.equal(matchTotp(secret, '287082', 0, 1, at), 1, 'an older last step still allows it');
  assert.equal(matchTotp(secret, '000000', null, 1, at), null);
  assert.equal(matchTotp(secret, '28 70 82', null, 1, at), 1, 'spaces are ignored');
});
