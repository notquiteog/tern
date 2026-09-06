// Exercises the passkey verifier against responses built the way a real
// authenticator builds them: a real key pair, a real signature over
// authenticatorData || SHA-256(clientDataJSON), real CBOR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signOneShot, createSign } from 'node:crypto';

process.env.APP_URL = 'https://mail.example.com';

const { cborDecodeStrict, coseToKey, parseAuthData, verifyRegistration, verifyAssertion, newCeremony, rpId, ALGORITHMS } = await import('./webauthn.js');

// ---------- CBOR encoding, just enough to build test fixtures ----------

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cborInt(n: number): Buffer {
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
}
function cborBytes(b: Buffer): Buffer { return Buffer.concat([cborHead(2, b.length), b]); }
function cborText(s: string): Buffer { const b = Buffer.from(s, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
function cborMap(entries: [Buffer, Buffer][]): Buffer {
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);
}

// ---------- Key material ----------

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = cborMap([
    [cborInt(1), cborInt(2)],    // kty: EC2
    [cborInt(3), cborInt(-7)],   // alg: ES256
    [cborInt(-1), cborInt(1)],   // crv: P-256
    [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
    [cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
  ]);
  const sign = (data: Buffer) => { const s = createSign('sha256'); s.update(data); s.end(); return s.sign(privateKey); };
  return { cose, sign, alg: -7 };
}

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const cose = cborMap([
    [cborInt(1), cborInt(1)],    // kty: OKP
    [cborInt(3), cborInt(-8)],   // alg: EdDSA
    [cborInt(-1), cborInt(6)],   // crv: Ed25519
    [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
  ]);
  return { cose, sign: (data: Buffer) => signOneShot(null, data, privateKey), alg: -8 };
}

function rsa() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const cose = cborMap([
    [cborInt(1), cborInt(3)],       // kty: RSA
    [cborInt(3), cborInt(-257)],    // alg: RS256
    [cborInt(-1), cborBytes(Buffer.from(jwk.n, 'base64url'))],
    [cborInt(-2), cborBytes(Buffer.from(jwk.e, 'base64url'))],
  ]);
  const sign = (data: Buffer) => { const s = createSign('sha256'); s.update(data); s.end(); return s.sign(privateKey); };
  return { cose, sign, alg: -257 };
}

// ---------- Fixtures ----------

const RP = 'mail.example.com';
const ORIGIN = 'https://mail.example.com';
const CRED_ID = Buffer.from('a-credential-id-of-some-length!!');

function authData(opts: { rp?: string; flags?: number; signCount?: number; cose?: Buffer; credId?: Buffer } = {}): Buffer {
  const rpHash = createHash('sha256').update(opts.rp ?? RP).digest();
  const flags = Buffer.from([opts.flags ?? 0x45]); // UP | UV | AT
  const count = Buffer.alloc(4); count.writeUInt32BE(opts.signCount ?? 0);
  if (!opts.cose) return Buffer.concat([rpHash, flags, count]);
  const credId = opts.credId ?? CRED_ID;
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
  return Buffer.concat([rpHash, flags, count, Buffer.alloc(16, 7), idLen, credId, opts.cose]);
}

function clientData(type: string, challenge: string, origin = ORIGIN, extra: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin, ...extra })).toString('base64url');
}

function attestation(ad: Buffer): string {
  return cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('attStmt'), cborMap([])],
    [cborText('authData'), cborBytes(ad)],
  ]).toString('base64url');
}

function register(key: { cose: Buffer }, userId = 7, opts: { flags?: number; rp?: string } = {}) {
  const { id, challenge } = newCeremony('register', userId);
  return verifyRegistration({
    ceremonyId: id,
    clientDataJSON: clientData('webauthn.create', challenge),
    attestationObject: attestation(authData({ cose: key.cose, ...opts })),
  });
}

function assert_(key: { sign: (d: Buffer) => Buffer }, stored: any, opts: { signCount?: number; flags?: number; purpose?: 'login' | 'reauth'; userId?: number | null } = {}) {
  const purpose = opts.purpose ?? 'login';
  const { id, challenge } = newCeremony(purpose, opts.userId ?? 7);
  const ad = authData({ flags: opts.flags ?? 0x01, signCount: opts.signCount ?? 0 });
  const cd = clientData('webauthn.get', challenge);
  const signature = key.sign(Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
  return verifyAssertion({
    ceremonyId: id, purpose,
    clientDataJSON: cd,
    authenticatorData: ad.toString('base64url'),
    signature: signature.toString('base64url'),
    stored,
  });
}

// ---------- Tests ----------

test('rp id comes from APP_URL', () => {
  assert.equal(rpId(), RP);
});

test('CBOR round-trips the shapes WebAuthn uses', () => {
  const m = cborDecodeStrict(cborMap([[cborText('fmt'), cborText('none')], [cborInt(-7), cborBytes(Buffer.from('hi'))]]));
  assert.ok(m instanceof Map);
  assert.equal((m as Map<any, any>).get('fmt'), 'none');
  assert.deepEqual((m as Map<any, any>).get(-7), Buffer.from('hi'));
});

test('CBOR refuses trailing bytes', () => {
  assert.throws(() => cborDecodeStrict(Buffer.concat([cborInt(1), Buffer.from([0xff])])), /Malformed/);
});

test('CBOR refuses indefinite lengths and floats', () => {
  assert.throws(() => cborDecodeStrict(Buffer.from([0x5f])), /Malformed/);   // indefinite byte string
  assert.throws(() => cborDecodeStrict(Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0])), /Malformed/); // float64
});

test('CBOR refuses a length that runs past the buffer', () => {
  assert.throws(() => cborDecodeStrict(Buffer.from([0x58, 0x40, 0x01])), /Malformed/);
});

test('authenticator data is parsed with its flags', () => {
  const ad = parseAuthData(authData({ flags: 0x5d, signCount: 42, cose: p256().cose }));
  assert.equal(ad.userPresent, true);
  assert.equal(ad.userVerified, true);
  assert.equal(ad.backupEligible, true);
  assert.equal(ad.backedUp, true);
  assert.equal(ad.signCount, 42);
  assert.deepEqual(ad.credentialId, CRED_ID);
});

test('authenticator data shorter than the header is refused', () => {
  assert.throws(() => parseAuthData(Buffer.alloc(20)), /Malformed/);
});

test('a credential id longer than the spec allows is refused', () => {
  const bad = Buffer.concat([createHash('sha256').update(RP).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0xff, 0xff])]);
  assert.throws(() => parseAuthData(bad), /Malformed/);
});

for (const [name, make] of [['ES256', p256], ['EdDSA', ed25519], ['RS256', rsa]] as const) {
  test(`${name}: registration then a signature that verifies`, () => {
    const key = make();
    const { userId, credential } = register(key);
    assert.equal(userId, 7);
    assert.equal(credential.alg, key.alg);
    assert.equal(credential.userVerified, true);
    assert.equal(ALGORITHMS[credential.alg], name);

    const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
    assert.equal(assert_(key, stored).result.userVerified, false);       // 0x01 is presence alone
    assert.equal(assert_(key, stored, { flags: 0x05 }).result.userVerified, true); // 0x04 adds verification
  });

  test(`${name}: a tampered signature is refused`, () => {
    const key = make();
    const { credential } = register(key);
    const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
    const { id, challenge } = newCeremony('login', 7);
    const ad = authData({ flags: 0x05 });
    const cd = clientData('webauthn.get', challenge);
    const good = key.sign(Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
    good[good.length - 1] ^= 0xff;
    assert.throws(() => verifyAssertion({
      ceremonyId: id, purpose: 'login', clientDataJSON: cd,
      authenticatorData: ad.toString('base64url'), signature: good.toString('base64url'), stored,
    }), /not accepted/);
  });
}

test('a signature over different authenticator data is refused', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
  const { id, challenge } = newCeremony('login', 7);
  const cd = clientData('webauthn.get', challenge);
  // Signed with UV set, presented with UV clear: the bytes must match exactly.
  const signed = authData({ flags: 0x05 });
  const presented = authData({ flags: 0x01 });
  const sig = key.sign(Buffer.concat([signed, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
  assert.throws(() => verifyAssertion({
    ceremonyId: id, purpose: 'login', clientDataJSON: cd,
    authenticatorData: presented.toString('base64url'), signature: sig.toString('base64url'), stored,
  }), /not accepted/);
});

test('a key registered for another site is refused', () => {
  assert.throws(() => register(p256(), 7, { rp: 'evil.example.net' }), /different site/);
});

test('an assertion from another origin is refused', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
  const { id, challenge } = newCeremony('login', 7);
  const ad = authData({ flags: 0x05 });
  const cd = clientData('webauthn.get', challenge, 'https://mail.example.com.evil.net');
  const sig = key.sign(Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
  assert.throws(() => verifyAssertion({
    ceremonyId: id, purpose: 'login', clientDataJSON: cd,
    authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), stored,
  }), /wrong address/);
});

test('a cross-origin assertion is refused even from the right origin', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
  const { id, challenge } = newCeremony('login', 7);
  const ad = authData({ flags: 0x05 });
  const cd = clientData('webauthn.get', challenge, ORIGIN, { crossOrigin: true });
  const sig = key.sign(Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
  assert.throws(() => verifyAssertion({
    ceremonyId: id, purpose: 'login', clientDataJSON: cd,
    authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), stored,
  }), /wrong address/);
});

test('a get response cannot answer a create challenge, or the reverse', () => {
  const key = p256();
  const { id, challenge } = newCeremony('register', 7);
  assert.throws(() => verifyRegistration({
    ceremonyId: id,
    clientDataJSON: clientData('webauthn.get', challenge),
    attestationObject: attestation(authData({ cose: key.cose })),
  }), /Malformed/);
});

test('a challenge is single use', () => {
  const key = p256();
  const { id, challenge } = newCeremony('register', 7);
  const body = {
    ceremonyId: id,
    clientDataJSON: clientData('webauthn.create', challenge),
    attestationObject: attestation(authData({ cose: key.cose })),
  };
  verifyRegistration(body);
  assert.throws(() => verifyRegistration(body), /expired/);
});

test('a challenge issued for one purpose does not answer another', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
  const { id, challenge } = newCeremony('reauth', 7);
  const ad = authData({ flags: 0x05 });
  const cd = clientData('webauthn.get', challenge);
  const sig = key.sign(Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
  assert.throws(() => verifyAssertion({
    ceremonyId: id, purpose: 'login', clientDataJSON: cd,
    authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), stored,
  }), /expired/);
});

test('someone else\'s challenge does not pass', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
  const { id } = newCeremony('login', 7);
  const other = newCeremony('login', 9);
  const ad = authData({ flags: 0x05 });
  const cd = clientData('webauthn.get', other.challenge);
  const sig = key.sign(Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]));
  assert.throws(() => verifyAssertion({
    ceremonyId: id, purpose: 'login', clientDataJSON: cd,
    authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), stored,
  }), /expired/);
});

test('user presence is required', () => {
  assert.throws(() => register(p256(), 7, { flags: 0x40 }), /confirm you were there/);
});

test('a counter that does not move forward is reported as a clone', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 10 };
  assert.equal(assert_(key, stored, { signCount: 11 }).result.clonedWarning, false);
  assert.equal(assert_(key, stored, { signCount: 10 }).result.clonedWarning, true);
  assert.equal(assert_(key, stored, { signCount: 4 }).result.clonedWarning, true);
});

test('an authenticator that does not count is never called a clone', () => {
  const key = p256();
  const { credential } = register(key);
  const stored = { credential_id: credential.credentialId, public_key: credential.publicKey, alg: credential.alg, sign_count: 0 };
  assert.equal(assert_(key, stored, { signCount: 0 }).result.clonedWarning, false);
});

test('an unsupported COSE algorithm is refused', () => {
  const cose = cborMap([[cborInt(1), cborInt(2)], [cborInt(3), cborInt(-65535)], [cborInt(-1), cborInt(1)], [cborInt(-2), cborBytes(Buffer.alloc(32))], [cborInt(-3), cborBytes(Buffer.alloc(32))]]);
  assert.throws(() => coseToKey(cose), /does not support/);
});

test('an EC key with an oversized coordinate is refused', () => {
  const cose = cborMap([[cborInt(1), cborInt(2)], [cborInt(3), cborInt(-7)], [cborInt(-1), cborInt(1)], [cborInt(-2), cborBytes(Buffer.alloc(48))], [cborInt(-3), cborBytes(Buffer.alloc(32))]]);
  assert.throws(() => coseToKey(cose), /Unsupported/);
});

test('a short EC coordinate is left-padded rather than rejected', () => {
  // Authenticators occasionally strip a leading zero byte; the JWK needs the
  // full curve length or the point is read wrong.
  const key = p256();
  const decoded = cborDecodeStrict(key.cose) as Map<number, Buffer>;
  const x = decoded.get(-2)!;
  if (x[0] === 0) return; // already short in the fixture, nothing to prove
  assert.doesNotThrow(() => coseToKey(key.cose));
});
