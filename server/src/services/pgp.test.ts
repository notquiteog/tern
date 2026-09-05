import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import { createHash } from 'node:crypto';
import { CHALLENGE_PREFIX, createChallenge, createDecoyChallenge, encryptText, extractEmail, readPrivateKey, readPublicKey, verifyChallenge, zbase32 } from './pgp.js';
import { buildInnerMime, buildMime } from '../jmap/send.js';

const PASS = 'correct horse battery staple';
const pair = await openpgp.generateKey({ userIDs: [{ name: 'Dana Osei', email: 'dana@acme.example' }], passphrase: PASS, format: 'armored' });
const unlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: pair.privateKey }), passphrase: PASS });

test('public keys are described; private and unprotected keys are refused where they must be', async () => {
  const info = await readPublicKey(pair.publicKey);
  assert.equal(info.emails[0], 'dana@acme.example');
  assert.ok(info.fingerprint.length >= 40);
  assert.ok(info.armored.includes('PUBLIC KEY BLOCK'));
  await assert.rejects(readPublicKey(pair.privateKey), /private key/);
  await assert.rejects(readPublicKey('not a key'), /Not a valid/);
  const priv = await readPrivateKey(pair.privateKey);
  assert.equal(priv.info.fingerprint, info.fingerprint);
  assert.ok(!priv.armored.includes('PUBLIC'));
  const naked = unlocked.armor();
  await assert.rejects(readPrivateKey(naked), /passphrase/);
});

test('challenges are single use, purpose bound and answerable only with the private key', async () => {
  const c = await createChallenge(42, pair.publicKey, 'login');
  const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: c.armored }), decryptionKeys: unlocked });
  assert.ok(String(data).startsWith(CHALLENGE_PREFIX));
  assert.equal(verifyChallenge(c.id, String(data), 'passwordless'), null, 'wrong purpose');
  const c2 = await createChallenge(42, pair.publicKey, 'login');
  const d2 = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: c2.armored }), decryptionKeys: unlocked });
  assert.equal(verifyChallenge(c2.id, String(d2.data).replace(CHALLENGE_PREFIX, ''), 'login'), 42, 'prefix optional');
  assert.equal(verifyChallenge(c2.id, String(d2.data), 'login'), null, 'single use');
  const c3 = await createChallenge(42, pair.publicKey, 'login');
  assert.equal(verifyChallenge(c3.id, 'guess', 'login'), null);
  const decoy = await createDecoyChallenge();
  assert.ok(decoy.armored.includes('BEGIN PGP MESSAGE'));
  assert.equal(verifyChallenge(decoy.id, 'anything', 'passwordless'), null);
});

test('encryptText produces a message every listed key can open and dedupes keys', async () => {
  const other = await openpgp.generateKey({ userIDs: [{ email: 'alex@team.example' }], passphrase: PASS, format: 'armored' });
  const armored = await encryptText('secret body', [pair.publicKey, other.publicKey, pair.publicKey]);
  const msg = await openpgp.readMessage({ armoredMessage: armored });
  assert.equal(msg.getEncryptionKeyIDs().length, 2);
  const otherUnlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: other.privateKey }), passphrase: PASS });
  assert.equal(String((await openpgp.decrypt({ message: msg, decryptionKeys: otherUnlocked })).data), 'secret body');
});

test('inner MIME carries text, html and attachments and no envelope headers', async () => {
  const inner = await buildInnerMime({ html: '<p>Hi <b>Dana</b></p>', attachments: [{ filename: 'a.png', content: Buffer.from([1, 2, 3]), contentType: 'image/png' }] });
  assert.ok(inner.startsWith('Content-Type: multipart/mixed'));
  assert.ok(!/^(Date|Message-ID|MIME-Version):/m.test(inner));
  assert.ok(inner.includes('Content-Type: text/plain') && inner.includes('Content-Type: text/html') && /filename="?a.png"?/.test(inner));
  assert.ok(inner.includes('Hi Dana'));
});

test('PGP/MIME envelopes follow RFC 3156 for encrypted and signed messages', async () => {
  const base = { from: { name: 'Alex', email: 'alex@team.example' }, to: [{ name: 'Dana Osei', email: 'dana@acme.example' }], subject: 'Sealed', html: '<p>x</p>' };
  const enc = await buildMime({ ...base, pgp: { mode: 'encrypted', armored: '-----BEGIN PGP MESSAGE-----\n\nabc\n-----END PGP MESSAGE-----\n' } });
  const e = enc.raw.toString();
  assert.match(e, /Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/);
  assert.match(e, /Content-Type: application\/pgp-encrypted\r\n[^]*?Content-Transfer-Encoding: 7bit\r\n\r\nVersion: 1/);
  assert.match(e, /filename="?encrypted.asc"?/);
  assert.ok(e.includes(enc.messageId));
  assert.ok(!e.includes('<p>x</p>'), 'plaintext body must not appear in an encrypted envelope');
  const sig = await buildMime({ ...base, pgp: { mode: 'signed', inner: 'Content-Type: text/plain; charset=utf-8\r\n\r\nsigned body\r\n', signature: '-----BEGIN PGP SIGNATURE-----\n\nsig\n-----END PGP SIGNATURE-----\n' } });
  const s = sig.raw.toString();
  assert.match(s, /multipart\/signed; protocol="application\/pgp-signature";\s+micalg=pgp-sha256/);
  assert.ok(s.includes('Content-Type: text/plain; charset=utf-8\r\n\r\nsigned body\r\n'), 'signed part must be byte-exact');
  assert.match(s, /Content-Type: application\/pgp-signature/);
});

test('helpers: address extraction and z-base-32', () => {
  assert.equal(extractEmail('Dana Osei <Dana@Acme.example>'), 'dana@acme.example');
  assert.equal(extractEmail('dana@acme.example'), 'dana@acme.example');
  assert.equal(extractEmail('no address here'), null);
  // WKD example from the draft: "Joe.Doe" hashes to iy9q119eutrkn8s1mk4r39qejnbu3n5q
  assert.equal(zbase32(createHash('sha1').update('joe.doe').digest()), 'iy9q119eutrkn8s1mk4r39qejnbu3n5q');
});
