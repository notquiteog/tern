// Metadata removal for outgoing photos and videos. A phone photo carries the
// GPS position, the exact time, the device model and serial, the owner's
// name and often a full-size thumbnail of the original crop; a video carries
// the same in its `udta`/`meta` boxes. Everything that is not needed to
// display the picture is dropped before a message leaves.
//
// Each format is handled at the container level without decoding pixels, so
// the image itself is byte-for-byte unchanged:
//   JPEG   drop every APPn/COM segment except JFIF (APP0) and Adobe (APP14),
//          which decoders need for colour; truncate anything after EOI.
//   PNG    keep critical and rendering chunks; drop text, time, EXIF, ICC.
//   WebP   drop EXIF, XMP and ICCP chunks; clear their flags in VP8X.
//   GIF    drop comment, plain-text and application extensions other than
//          the NETSCAPE/ANIMEXTS loop control.
//   MP4/MOV blank `udta`, `meta`, `uuid` and `xtra` boxes in place so every
//          chunk offset in the file stays valid.
// Unknown types pass through untouched and are reported as such.

export interface ScrubResult { data: Buffer; changed: boolean; removed: string[]; handled: boolean }

const VIDEO_EXT = /\.(mp4|m4v|mov|qt|3gp|3g2|m4a)$/i;

export function scrubMedia(data: Buffer, contentType: string, filename = ''): ScrubResult {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  const name = filename.toLowerCase();
  try {
    if (ct === 'image/jpeg' || ct === 'image/jpg' || /\.jpe?g$/.test(name) || isJpeg(data)) return scrubJpeg(data);
    if (ct === 'image/png' || /\.png$/.test(name) || isPng(data)) return scrubPng(data);
    if (ct === 'image/webp' || /\.webp$/.test(name) || isWebp(data)) return scrubWebp(data);
    if (ct === 'image/gif' || /\.gif$/.test(name) || isGif(data)) return scrubGif(data);
    if (ct.startsWith('video/') || ct === 'audio/mp4' || ct === 'audio/x-m4a' || VIDEO_EXT.test(name)) { if (isBmff(data)) return scrubBmff(data); }
  } catch {
    // A malformed file is sent as it is rather than corrupted further.
    return { data, changed: false, removed: [], handled: false };
  }
  return { data, changed: false, removed: [], handled: false };
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isWebp = (b: Buffer) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
const isGif = (b: Buffer) => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6));
const isBmff = (b: Buffer) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp';

// ---------- JPEG ----------

const JPEG_NAMES: Record<number, string> = { 0xe1: 'EXIF/XMP', 0xe2: 'ICC profile', 0xe3: 'metadata', 0xe4: 'metadata', 0xe5: 'metadata', 0xe6: 'metadata', 0xe7: 'metadata', 0xe8: 'metadata', 0xe9: 'metadata', 0xea: 'metadata', 0xeb: 'metadata', 0xec: 'Ducky/Picasa', 0xed: 'IPTC/Photoshop', 0xef: 'metadata', 0xfe: 'comment' };

export function scrubJpeg(b: Buffer): ScrubResult {
  if (!isJpeg(b)) return { data: b, changed: false, removed: [], handled: false };
  const out: Buffer[] = [b.subarray(0, 2)];
  const removed = new Set<string>();
  let p = 2;
  let changed = false;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error('bad marker');
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (marker === 0xd9) { out.push(b.subarray(p, p + 2)); p += 2; break; }
    const len = b.readUInt16BE(p + 2);
    const seg = b.subarray(p, p + 2 + len);
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows. Inside it 0xFF is always
      // followed by 0x00 or a restart marker, so the first FFD9 is the real
      // end of image. Copy through it and drop any trailer.
      let q = p + 2 + len;
      let end = -1;
      while (q + 1 < b.length) {
        if (b[q] === 0xff && b[q + 1] === 0xd9) { end = q + 2; break; }
        q++;
      }
      if (end < 0) end = b.length;
      out.push(b.subarray(p, end));
      if (end < b.length) { changed = true; removed.add('trailing data'); }
      p = b.length;
      break;
    }
    const keep = !(marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee));
    if (keep) out.push(seg);
    else { changed = true; removed.add(nameJpeg(marker, seg)); }
    p += 2 + len;
  }
  if (p < b.length) { /* bytes after EOI without SOS: drop */ }
  return { data: changed ? Buffer.concat(out) : b, changed, removed: [...removed], handled: true };
}

function nameJpeg(marker: number, seg: Buffer): string {
  if (marker === 0xe1) return seg.toString('latin1', 4, 8) === 'Exif' ? 'EXIF (camera, GPS, time)' : 'XMP';
  if (marker === 0xe2) return seg.toString('latin1', 4, 7) === 'MPF' ? 'embedded images (MPF)' : 'ICC profile';
  return JPEG_NAMES[marker] ?? 'metadata';
}

// ---------- PNG ----------

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi']);
const PNG_NAMES: Record<string, string> = { tEXt: 'text', zTXt: 'text', iTXt: 'text', tIME: 'timestamp', eXIf: 'EXIF (camera, GPS, time)', iCCP: 'ICC profile', dSIG: 'signature', oFFs: 'offset', pCAL: 'calibration', sCAL: 'scale', sTER: 'stereo', exIf: 'EXIF' };

export function scrubPng(b: Buffer): ScrubResult {
  if (!isPng(b)) return { data: b, changed: false, removed: [], handled: false };
  const out: Buffer[] = [b.subarray(0, 8)];
  const removed = new Set<string>();
  let p = 8;
  let changed = false;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const end = p + 12 + len;
    if (end > b.length) throw new Error('truncated chunk');
    if (PNG_KEEP.has(type)) out.push(b.subarray(p, end));
    else { changed = true; removed.add(PNG_NAMES[type] ?? `${type} chunk`); }
    p = end;
    if (type === 'IEND') break;
  }
  return { data: changed ? Buffer.concat(out) : b, changed, removed: [...removed], handled: true };
}

// ---------- WebP ----------

export function scrubWebp(b: Buffer): ScrubResult {
  if (!isWebp(b)) return { data: b, changed: false, removed: [], handled: false };
  const chunks: Buffer[] = [];
  const removed = new Set<string>();
  let p = 12;
  let changed = false;
  let vp8x: Buffer | null = null;
  while (p + 8 <= b.length) {
    const type = b.toString('latin1', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    const padded = len + (len & 1);
    const chunk = Buffer.from(b.subarray(p, Math.min(b.length, p + 8 + padded)));
    if (type === 'EXIF' || type === 'XMP ' || type === 'ICCP') { changed = true; removed.add(type === 'EXIF' ? 'EXIF (camera, GPS, time)' : type === 'ICCP' ? 'ICC profile' : 'XMP'); }
    else { if (type === 'VP8X') vp8x = chunk; chunks.push(chunk); }
    p += 8 + padded;
  }
  if (!changed) return { data: b, changed: false, removed: [], handled: true };
  if (vp8x) vp8x[8] &= ~(0x20 | 0x08 | 0x04); // clear ICC, EXIF, XMP flags
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return { data: Buffer.concat([head, body]), changed: true, removed: [...removed], handled: true };
}

// ---------- GIF ----------

export function scrubGif(b: Buffer): ScrubResult {
  if (!isGif(b)) return { data: b, changed: false, removed: [], handled: false };
  const out: Buffer[] = [];
  const removed = new Set<string>();
  let changed = false;
  let p = 13;
  const packed = b[10];
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
  out.push(b.subarray(0, p));
  const skipSubBlocks = (q: number): number => { while (q < b.length) { const n = b[q]; q += 1 + n; if (n === 0) break; } return q; };
  while (p < b.length) {
    const tag = b[p];
    if (tag === 0x3b) { out.push(b.subarray(p, p + 1)); p++; break; }
    if (tag === 0x2c) {
      let q = p + 10;
      const lp = b[p + 9];
      if (lp & 0x80) q += 3 * (1 << ((lp & 0x07) + 1));
      q += 1; // LZW minimum code size
      q = skipSubBlocks(q);
      out.push(b.subarray(p, q)); p = q; continue;
    }
    if (tag === 0x21) {
      const label = b[p + 1];
      const q = skipSubBlocks(p + 2);
      let keep = true;
      if (label === 0xfe) { keep = false; removed.add('comment'); }
      else if (label === 0x01) { keep = false; removed.add('plain text'); }
      else if (label === 0xff) {
        const app = b.toString('latin1', p + 3, p + 3 + Math.min(11, b[p + 2]));
        if (!/^(NETSCAPE2\.0|ANIMEXTS1\.0)/.test(app)) { keep = false; removed.add(`application data (${app.replace(/[^\x20-\x7e]/g, '').trim() || 'unknown'})`); }
      }
      if (keep) out.push(b.subarray(p, q)); else changed = true;
      p = q; continue;
    }
    throw new Error('unknown GIF block');
  }
  return { data: changed ? Buffer.concat(out) : b, changed, removed: [...removed], handled: true };
}

// ---------- ISO base media (MP4, MOV, M4V, 3GP) ----------

const BMFF_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'udta', 'edts', 'mvex', 'moof', 'traf']);
const BMFF_DROP: Record<string, string> = { udta: 'user data (location, device, comments)', meta: 'metadata', uuid: 'XMP/vendor data', xtra: 'Windows metadata', '©xyz': 'GPS location' };

export function scrubBmff(b: Buffer): ScrubResult {
  if (!isBmff(b)) return { data: b, changed: false, removed: [], handled: false };
  const out = Buffer.from(b);
  const removed = new Set<string>();
  let changed = false;
  const blank = (start: number, headerLen: number, end: number, type: string) => {
    out.write('free', start + 4, 'latin1');
    out.fill(0, start + headerLen, end);
    removed.add(BMFF_DROP[type] ?? 'metadata');
    changed = true;
  };
  const walk = (start: number, end: number, depth: number) => {
    let p = start;
    while (p + 8 <= end) {
      let size = out.readUInt32BE(p);
      const type = out.toString('latin1', p + 4, p + 8);
      let header = 8;
      if (size === 1) { if (p + 16 > end) return; size = Number(out.readBigUInt64BE(p + 8)); header = 16; }
      else if (size === 0) size = end - p;
      if (size < header || p + size > end) return;
      if (type in BMFF_DROP) blank(p, header, p + size, type);
      else if (BMFF_CONTAINERS.has(type) && depth < 6) walk(p + header, p + size, depth + 1);
      p += size;
    }
  };
  walk(0, out.length, 0);
  return { data: changed ? out : b, changed, removed: [...removed], handled: true };
}

export function describeScrub(r: ScrubResult): string | null {
  if (!r.handled) return null;
  if (!r.changed) return 'No metadata found';
  return `Removed ${r.removed.join(', ')}`;
}
