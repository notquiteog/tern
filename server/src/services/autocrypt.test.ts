import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import { buildAutocryptHeader, minimalKey, parseAutocryptHeader, readKeydata, recommend, type PeerState } from './autocrypt.js';

async function freshKey(email = 'alice@example.org') {
  return openpgp.generateKey({ userIDs: [{ name: 'Alice', email }, { name: 'Alice at work', email: `work-${email}` }], format: 'armored' });
}

test('an Autocrypt header round-trips and carries a usable, pruned key', async () => {
  const { publicKey } = await freshKey();
  const header = await buildAutocryptHeader('Alice@Example.org', 'mutual', publicKey);
  assert.ok(header.startsWith('addr=alice@example.org; prefer-encrypt=mutual; keydata='));
  const parsed = parseAutocryptHeader(header);
  assert.ok(parsed);
  assert.equal(parsed!.addr, 'alice@example.org');
  assert.equal(parsed!.preferEncrypt, 'mutual');
  const key = await readKeydata(parsed!.keydata);
  assert.ok(key);
  const original = await openpgp.readKey({ armoredKey: publicKey });
  assert.equal(key!.fingerprint, original.getFingerprint());
  // Pruned: one user ID instead of two, still encrypts.
  const pruned = await openpgp.readKey({ binaryKey: await minimalKey(publicKey) });
  assert.equal(pruned.getUserIDs().length, 1);
  assert.ok(pruned.getUserIDs().length < original.getUserIDs().length);
  await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'x' }), encryptionKeys: pruned });
  // Folded header (whitespace inside keydata) still parses.
  const folded = header.replace(/(.{60})/g, '$1\r\n ');
  assert.equal(parseAutocryptHeader(folded)!.addr, 'alice@example.org');
});

test('a v6 key prunes to a working minimal key', async () => {
  const { publicKey } = await openpgp.generateKey({ userIDs: [{ name: 'V', email: 'v6@example.org' }, { name: 'V2', email: 'v6b@example.org' }], passphrase: 'correct horse battery staple', format: 'armored', config: { v6Keys: true } });
  const pruned = await openpgp.readKey({ binaryKey: await minimalKey(publicKey) });
  assert.equal(pruned.keyPacket.version, 6);
  assert.equal(pruned.getUserIDs().length, 1);
  await pruned.getEncryptionKey();
  const header = await buildAutocryptHeader('v6@example.org', 'mutual', publicKey);
  const folded = header.replace('; keydata=', ';\r\n keydata=');
  const parsed = parseAutocryptHeader(folded)!;
  assert.equal(parsed.preferEncrypt, 'mutual');
  assert.ok(await readKeydata(parsed.keydata));
});

test('the parser refuses what the spec says to refuse', () => {
  assert.equal(parseAutocryptHeader('addr=a@b.c; keydata=AAAA; future=1'), null);
  assert.equal(parseAutocryptHeader('addr=a@b.c; keydata=AAAA; addr=x@y.z'), null);
  assert.equal(parseAutocryptHeader('keydata=AAAA'), null);
  assert.equal(parseAutocryptHeader('addr=a@b.c'), null);
  assert.equal(parseAutocryptHeader('addr=a@b.c; _extra=fine; prefer-encrypt=whatever; keydata=AAAA')!.preferEncrypt, 'nopreference');
});

test('readKeydata rejects private and unusable keys', async () => {
  const { privateKey } = await freshKey();
  const priv = await openpgp.readPrivateKey({ armoredKey: privateKey });
  assert.equal(await readKeydata(priv.write()), null);
  assert.equal(await readKeydata(new Uint8Array([1, 2, 3])), null);
});

test('recommendation follows the level 1 decision procedure', () => {
  const now = Date.now();
  const d = (ms: number) => new Date(now - ms);
  const base: PeerState = { email: 'p@x.test', last_seen: d(0), autocrypt_timestamp: d(0), public_key: 'K', fingerprint: 'F', prefer_encrypt: 'nopreference', gossip_timestamp: null, gossip_key: null, gossip_fingerprint: null };
  assert.equal(recommend(null, 'mutual').recommendation, 'disable');
  assert.equal(recommend({ ...base, public_key: null }, 'mutual').recommendation, 'disable');
  assert.equal(recommend(base, 'mutual').recommendation, 'available');
  assert.equal(recommend({ ...base, prefer_encrypt: 'mutual' }, 'nopreference').recommendation, 'available');
  assert.equal(recommend({ ...base, prefer_encrypt: 'mutual' }, 'mutual').recommendation, 'encrypt');
  assert.equal(recommend({ ...base, prefer_encrypt: 'mutual', autocrypt_timestamp: d(40 * 86400_000) }, 'mutual').recommendation, 'discourage');
  assert.equal(recommend({ ...base, public_key: null, gossip_key: 'G', gossip_fingerprint: 'GF', gossip_timestamp: d(0) }, 'mutual').source, 'autocrypt-gossip');
  assert.equal(recommend({ ...base, public_key: null, gossip_key: 'G', gossip_fingerprint: 'GF', gossip_timestamp: d(0) }, 'mutual').recommendation, 'discourage');
  assert.equal(recommend(base, 'nopreference', true).recommendation, 'encrypt');
});
