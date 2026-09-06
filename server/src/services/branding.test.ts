import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLogo } from './branding.js';

test('SVG logos are cleaned of scripts and metadata', () => {
  const svg = `<?xml version="1.0"?><!-- made with Foo --><svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="64" height="64"><metadata>secret</metadata><title>x</title><rect width="64" height="64" fill="#123456" inkscape:label="bg"/></svg>`;
  const r = prepareLogo(Buffer.from(svg), 'image/svg+xml', 'Acme');
  assert.equal(r.type, 'image/svg+xml');
  const out = r.data.toString();
  assert.ok(!/metadata|inkscape|Foo|secret/.test(out), out);
  assert.ok(/<title>Acme<\/title>/.test(out));
  assert.ok(/viewBox="0 0 64 64"/.test(out));
  assert.ok(r.note && /stripped/.test(r.note));
});

test('scripts and non-images are refused', () => {
  assert.throws(() => prepareLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'x'), /Scripts/);
  assert.throws(() => prepareLogo(Buffer.from('not an image'), 'image/png', 'x'), /valid image/);
  assert.throws(() => prepareLogo(Buffer.from('x'), 'text/html', 'x'), /SVG, PNG/);
  assert.throws(() => prepareLogo(Buffer.alloc(0), 'image/png', 'x'), /empty/);
});

test('rasters pass through with metadata stripped', () => {
  // Smallest valid PNG (1x1) plus a tEXt chunk that should disappear.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); return Buffer.concat([len, Buffer.from(type), data, crc]); };
  const withText = Buffer.concat([png.subarray(0, 33), chunk('tEXt', Buffer.from('Author\0Someone')), png.subarray(33)]);
  const r = prepareLogo(withText, 'image/png', 'x');
  assert.equal(r.type, 'image/png');
  assert.ok(!r.data.includes('Someone'));
  assert.ok(r.bytes < withText.length);
});
