import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPrivateAddress } from './netguard.js';

test('private, loopback, link-local and metadata addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.0.0.1', '10.89.0.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('URLs on internal names or addresses are refused', async () => {
  for (const u of ['http://localhost:11434/api/tags', 'http://ollama:11434/', 'http://127.0.0.1:5432/', 'http://10.89.0.2/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://stalwart.internal/']) {
    await assert.rejects(assertPublicUrl(u), /private|internal|own network/i, u);
  }
  await assert.rejects(assertPublicUrl('ftp://example.com/'), /http/);
  await assert.rejects(assertPublicUrl('https://user:pw@example.com/'), /credentials/);
  await assert.rejects(assertPublicUrl('not a url'), /valid URL/);
});

test('a public literal address passes without a lookup', async () => {
  const u = await assertPublicUrl('https://1.1.1.1/.well-known/jmap');
  assert.equal(u.hostname, '1.1.1.1');
});

test('allowPrivate lets the bundled mail server through', async () => {
  const u = await assertPublicUrl('http://stalwart:8080/.well-known/jmap', { allowPrivate: true });
  assert.equal(u.hostname, 'stalwart');
});
