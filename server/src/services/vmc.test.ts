import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeDataUri, inflateIfPacked, inspectVmc, readLogotype, splitPem } from './vmc.js';

// A small DER encoder, so the parser is tested against something built
// independently of it rather than against a blob it produced itself.
function tlv(tag: number, content: Buffer): Buffer {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  const len: number[] = [];
  for (let n = content.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | len.length]), Buffer.from(len), content]);
}
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const octets = (b: Buffer) => tlv(0x04, b);
const ia5 = (s: string) => tlv(0x16, Buffer.from(s, 'utf8'));
function oid(dotted: string): Buffer {
  const n = dotted.split('.').map(Number);
  const bytes = [n[0] * 40 + n[1]];
  for (const part of n.slice(2)) {
    const chunk: number[] = [part % 128];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>T</title><rect width="64" height="64" fill="#123456"/></svg>';

// Extension ::= SEQUENCE { extnID, extnValue OCTET STRING } wrapping the
// shape a real VMC uses: media type, a SHA-256 of the image, and the image
// itself gzipped into a data: URI.
function logotypeExtension(image: Buffer, hashHex: string): Buffer {
  const details = seq(
    ia5('image/svg+xml'),
    seq(seq(seq(oid('2.16.840.1.101.3.4.2.1')), octets(Buffer.from(hashHex, 'hex')))),
    seq(ia5(`data:image/svg+xml;base64,${zlib.gzipSync(image).toString('base64')}`)),
  );
  return seq(oid('1.3.6.1.5.5.7.1.12'), octets(tlv(0xa2, tlv(0xa0, seq(details)))));
}

test('readLogotype finds the extension, the hash and the embedded image', () => {
  const hash = 'a'.repeat(64);
  const logo = readLogotype(logotypeExtension(Buffer.from(SVG), hash));
  assert.ok(logo);
  assert.equal(logo.mediaType, 'image/svg+xml');
  assert.deepEqual(logo.hashes, [{ alg: 'sha256', hex: hash }]);
  assert.equal(logo.encoding, 'gzip');
  assert.equal(logo.image?.toString('utf8'), SVG);
});

test('readLogotype returns null when the certificate carries no logotype', () => {
  // The same shape under the basic-constraints OID: a plain TLS certificate.
  assert.equal(readLogotype(seq(oid('2.5.29.19'), octets(seq()))), null);
  assert.equal(readLogotype(Buffer.from('not der at all')), null);
});

test('a data: URI decodes whether or not it is compressed', () => {
  const plain = decodeDataUri(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
  assert.equal(plain?.encoding, 'none');
  assert.equal(plain?.bytes.toString('utf8'), SVG);
  const packed = decodeDataUri(`data:image/svg+xml;base64,${zlib.gzipSync(Buffer.from(SVG)).toString('base64')}`);
  assert.equal(packed?.encoding, 'gzip');
  assert.equal(packed?.bytes.toString('utf8'), SVG);
  assert.equal(decodeDataUri('https://example.test/logo.svg'), null);
});

test('inflateIfPacked leaves plain bytes alone', () => {
  const r = inflateIfPacked(Buffer.from(SVG));
  assert.equal(r.encoding, 'none');
  assert.equal(r.bytes.toString('utf8'), SVG);
});

test('splitPem separates a chain and ignores the text around it', () => {
  const block = (n: string) => `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`;
  const chain = `subject=/O=Example\n${block('AAAA')}\nissuer=/O=CA\n${block('BBBB')}\n`;
  assert.deepEqual(splitPem(chain), [block('AAAA'), block('BBBB')]);
  assert.deepEqual(splitPem('<html>404</html>'), []);
});

test('inspectVmc explains a file that is not a certificate rather than throwing', () => {
  const html = inspectVmc('<html>Not found</html>', { domain: 'probe.test', logo: null });
  assert.equal(html.ok, false);
  assert.equal(html.certificates, 0);
  assert.match(html.error!, /no PEM certificate block/);
  const broken = inspectVmc('-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----', { domain: 'probe.test', logo: null });
  assert.equal(broken.ok, false);
  assert.equal(broken.certificates, 1);
  assert.match(broken.error!, /could not be parsed/);
});
