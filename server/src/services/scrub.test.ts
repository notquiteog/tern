import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubMedia, scrubJpeg, scrubPng, scrubWebp, scrubGif, scrubBmff } from './scrub.js';

// ---- fixtures built by hand: tiny but structurally valid containers ----

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}
export function exifApp1(): Buffer {
  // "Exif\0\0" + TIFF header + IFD0 with GPSInfo pointer + GPS IFD (lat 51.5 N, long 0.12 W).
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 * 2 + 4 + 16);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // one entry in IFD0
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18); // GPSInfo -> offset 26
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(1, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(2, 32); tiff.write('N\0', 36, 'latin1'); // GPSLatitudeRef
  tiff.writeUInt16LE(3, 40); tiff.writeUInt16LE(2, 42); tiff.writeUInt32LE(2, 44); tiff.write('W\0', 48, 'latin1'); // GPSLongitudeRef
  return jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}
function makeJpeg(withMeta: boolean): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')));
  if (withMeta) {
    parts.push(exifApp1());
    parts.push(jpegSegment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')));
    parts.push(jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile-bytes', 'latin1')));
    parts.push(jpegSegment(0xfe, Buffer.from('shot on my phone', 'latin1')));
  }
  parts.push(jpegSegment(0xdb, Buffer.alloc(65, 1)));
  parts.push(jpegSegment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])));
  parts.push(jpegSegment(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\0', 'latin1'))); // APP14, must survive
  parts.push(jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])));
  parts.push(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78])); // entropy data with a stuffed FF and a restart marker
  parts.push(Buffer.from([0xff, 0xd9]));
  if (withMeta) parts.push(Buffer.from('trailing xmp or depth map', 'latin1'));
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4, 0xaa)]);
}
function makePng(withMeta: boolean): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, pngChunk('IHDR', Buffer.alloc(13, 1))];
  if (withMeta) parts.push(pngChunk('tEXt', Buffer.from('Author\0Alex', 'latin1')), pngChunk('eXIf', Buffer.alloc(20, 2)), pngChunk('iCCP', Buffer.alloc(10, 3)), pngChunk('tIME', Buffer.alloc(7, 4)));
  parts.push(pngChunk('gAMA', Buffer.alloc(4, 5)), pngChunk('IDAT', Buffer.alloc(30, 6)), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function makeWebp(withMeta: boolean): Buffer {
  const vp8x = Buffer.alloc(10); vp8x[0] = withMeta ? 0x2c : 0x00; // ICC | EXIF | XMP
  const chunks = [riffChunk('VP8X', vp8x)];
  if (withMeta) chunks.push(riffChunk('ICCP', Buffer.alloc(9, 1)), riffChunk('EXIF', Buffer.alloc(20, 2)));
  chunks.push(riffChunk('VP8L', Buffer.alloc(21, 3)));
  if (withMeta) chunks.push(riffChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1')));
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function gifSub(data: Buffer): Buffer { return Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0])]); }
function makeGif(withMeta: boolean): Buffer {
  const parts: Buffer[] = [Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.alloc(6, 0x11)]; // 2-colour global table
  parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0])); // loop control, kept
  if (withMeta) {
    parts.push(Buffer.from([0x21, 0xfe]), gifSub(Buffer.from('made with CameraApp by Alex', 'latin1')));
    parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP', 'latin1'), gifSub(Buffer.from('<x:xmpmeta/>', 'latin1')));
  }
  parts.push(Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0])); // graphic control, kept
  parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2]), gifSub(Buffer.from([0x44, 0x01])), Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length + 8); head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
function makeMp4(withMeta: boolean): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isommp41', 'latin1'));
  const trak = box('trak', box('tkhd', Buffer.alloc(84)), ...(withMeta ? [box('udta', box('meta', Buffer.alloc(30, 7)))] : []), box('mdia', box('mdhd', Buffer.alloc(24))));
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), trak, ...(withMeta ? [box('udta', box('©xyz', Buffer.from('\0\x0c\x15\xc7+51.5074-000.1278/', 'latin1')), box('meta', Buffer.alloc(40, 9))), box('meta', Buffer.alloc(24, 8))] : []));
  const mdat = box('mdat', Buffer.alloc(64, 0x55));
  const uuid = withMeta ? box('uuid', Buffer.alloc(16, 0xbe), Buffer.from('<x:xmpmeta/>', 'latin1')) : Buffer.alloc(0);
  return Buffer.concat([ftyp, moov, mdat, uuid]);
}

// ---- tests ----

test('JPEG: EXIF, XMP, ICC, comments and trailing data go; JFIF, Adobe and the scan stay', () => {
  const dirty = makeJpeg(true);
  const clean = makeJpeg(false);
  const r = scrubJpeg(dirty);
  assert.ok(r.changed);
  assert.deepEqual(r.data, clean);
  assert.ok(r.removed.some((x) => x.includes('EXIF')) && r.removed.includes('XMP') && r.removed.includes('ICC profile') && r.removed.includes('comment') && r.removed.includes('trailing data'));
  assert.ok(!r.data.includes(Buffer.from('Exif', 'latin1')));
  assert.ok(r.data.includes(Buffer.from('Adobe', 'latin1')));
  const again = scrubJpeg(r.data);
  assert.equal(again.changed, false);
});

test('PNG: text, time, EXIF and ICC chunks go; IHDR, gAMA, IDAT, IEND stay', () => {
  const r = scrubPng(makePng(true));
  assert.ok(r.changed);
  assert.deepEqual(r.data, makePng(false));
  assert.ok(!r.data.includes(Buffer.from('Alex', 'latin1')));
  assert.equal(scrubPng(r.data).changed, false);
});

test('WebP: EXIF, XMP and ICCP chunks go and VP8X flags are cleared; RIFF size is rewritten', () => {
  const r = scrubWebp(makeWebp(true));
  assert.ok(r.changed);
  assert.deepEqual(r.data, makeWebp(false));
  assert.equal(r.data.readUInt32LE(4), r.data.length - 8);
  assert.equal(scrubWebp(r.data).changed, false);
});

test('GIF: comments and foreign application extensions go; loop control and frames stay', () => {
  const r = scrubGif(makeGif(true));
  assert.ok(r.changed);
  assert.deepEqual(r.data, makeGif(false));
  assert.ok(r.data.includes(Buffer.from('NETSCAPE2.0', 'latin1')));
  assert.ok(!r.data.includes(Buffer.from('CameraApp', 'latin1')));
  assert.equal(scrubGif(r.data).changed, false);
});

test('MP4: udta, meta and uuid boxes are blanked in place, so length and offsets are unchanged', () => {
  const dirty = makeMp4(true);
  const r = scrubBmff(dirty);
  assert.ok(r.changed);
  assert.equal(r.data.length, dirty.length);
  assert.ok(!r.data.includes(Buffer.from('51.5074', 'latin1')));
  assert.ok(!r.data.includes(Buffer.from('xmpmeta', 'latin1')));
  assert.ok(!r.data.includes(Buffer.from('udta', 'latin1')));
  assert.ok(!r.data.includes(Buffer.from('meta', 'latin1')));
  // mdat is where it was
  assert.equal(dirty.indexOf(Buffer.from('mdat', 'latin1')), r.data.indexOf(Buffer.from('mdat', 'latin1')));
  assert.ok(r.removed.includes('GPS location') || r.removed.includes('user data (location, device, comments)'));
  assert.equal(scrubBmff(r.data).changed, false);
});

test('scrubMedia dispatches by type and leaves unknown formats alone', () => {
  assert.ok(scrubMedia(makeJpeg(true), 'application/octet-stream', 'IMG_0001.JPG').changed);
  assert.ok(scrubMedia(makeMp4(true), 'video/quicktime', 'clip.mov').changed);
  const pdf = Buffer.from('%PDF-1.4 hello', 'latin1');
  const r = scrubMedia(pdf, 'application/pdf', 'doc.pdf');
  assert.equal(r.handled, false); assert.equal(r.data, pdf);
  // HEIC keeps its structural meta box: not a video type, so untouched.
  const heic = Buffer.concat([box('ftyp', Buffer.from('heic', 'latin1')), box('meta', Buffer.alloc(8))]);
  assert.equal(scrubMedia(heic, 'image/heic', 'photo.heic').handled, false);
  // Garbage claiming to be a JPEG passes through instead of throwing.
  const junk = Buffer.from([0xff, 0xd8, 0xff, 0x12, 0x00]);
  assert.equal(scrubMedia(junk, 'image/jpeg').changed, false);
});
