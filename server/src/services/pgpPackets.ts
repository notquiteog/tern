// A small OpenPGP packet walker (RFC 9580 §5) that reads only what the
// library will not tell us: the version and public-key algorithm of every
// key packet in a certificate, including subkeys whose algorithm OpenPGP.js
// does not implement yet. That is how a post-quantum subkey (ML-KEM,
// ML-DSA) is recognised on an imported key even though encryption still
// goes to its classical subkey.

export interface KeyPacketInfo { tag: number; version: number; algorithm: number; name: string; postQuantum: boolean; primary: boolean }

// Algorithm ids: RFC 9580 §9.1 plus draft-ietf-openpgp-pqc (35-37 KEMs,
// 30-34 signatures) and the experimental ids OpenPGP.js reserves for the
// same schemes (105, 107).
const NAMES: Record<number, string> = {
  1: 'RSA', 2: 'RSA (encrypt only)', 3: 'RSA (sign only)', 16: 'ElGamal', 17: 'DSA', 18: 'ECDH', 19: 'ECDSA', 22: 'EdDSA (legacy)',
  25: 'X25519', 26: 'X448', 27: 'Ed25519', 28: 'Ed448',
  30: 'ML-DSA-65 + Ed25519', 31: 'ML-DSA-87 + Ed448', 32: 'SLH-DSA-SHAKE-128s', 33: 'SLH-DSA-SHAKE-128f', 34: 'SLH-DSA-SHAKE-256s',
  35: 'ML-KEM-768 + X25519', 36: 'ML-KEM-1024 + X448', 37: 'ML-KEM-1024 + X448 (alt)',
  105: 'ML-KEM-768 + X25519 (experimental)', 107: 'ML-DSA-65 + Ed25519 (experimental)',
};
const PQ = new Set([30, 31, 32, 33, 34, 35, 36, 37, 105, 107]);

export function algorithmName(id: number): string { return NAMES[id] ?? `algorithm ${id}`; }
export function isPostQuantum(id: number): boolean { return PQ.has(id); }

// Armor to bytes without the library: header line, optional armor headers,
// blank line, base64 body, "=" CRC line, footer.
export function dearmor(armored: string): Uint8Array {
  const lines = armored.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^-----BEGIN PGP /.test(l));
  if (start < 0) throw new Error('Not an armored OpenPGP block');
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes(':')) i++; // armor headers
  while (i < lines.length && lines[i].trim() === '') i++;
  const body: string[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('=') || l.startsWith('-----END')) break;
    body.push(l);
  }
  return new Uint8Array(Buffer.from(body.join(''), 'base64'));
}

interface Packet { tag: number; body: Uint8Array }

// Handles new-format headers (one, two and five octet lengths and partial
// bodies) and old-format headers (one, two, four octet and indeterminate).
export function walkPackets(bytes: Uint8Array): Packet[] {
  const out: Packet[] = [];
  let p = 0;
  while (p < bytes.length) {
    const h = bytes[p++];
    if (!(h & 0x80)) throw new Error('Malformed packet header');
    let tag: number;
    let body: Uint8Array;
    if (h & 0x40) {
      tag = h & 0x3f;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const o = bytes[p++];
        let len: number, partial = false;
        if (o < 192) len = o;
        else if (o < 224) { len = ((o - 192) << 8) + bytes[p++] + 192; }
        else if (o === 255) { len = (bytes[p] << 24 >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3]; p += 4; }
        else { len = 1 << (o & 0x1f); partial = true; }
        chunks.push(bytes.subarray(p, p + len)); p += len;
        if (!partial) break;
      }
      body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    } else {
      tag = (h >> 2) & 0x0f;
      const lt = h & 3;
      let len: number;
      if (lt === 0) len = bytes[p++];
      else if (lt === 1) { len = (bytes[p] << 8) + bytes[p + 1]; p += 2; }
      else if (lt === 2) { len = (bytes[p] << 24 >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3]; p += 4; }
      else len = bytes.length - p;
      body = bytes.subarray(p, p + len); p += len;
    }
    out.push({ tag, body });
  }
  return out;
}

const KEY_TAGS = new Set([5, 6, 7, 14]); // secret key, public key, secret subkey, public subkey

export function keyPackets(bytes: Uint8Array): KeyPacketInfo[] {
  const out: KeyPacketInfo[] = [];
  for (const pk of walkPackets(bytes)) {
    if (!KEY_TAGS.has(pk.tag) || pk.body.length < 6) continue;
    const version = pk.body[0];
    // v3: time(4) validity(2) algo(1); v4: time(4) algo(1); v5/v6: time(4) algo(1) len(4)
    const algorithm = version === 3 ? pk.body[7] : pk.body[5];
    out.push({ tag: pk.tag, version, algorithm, name: algorithmName(algorithm), postQuantum: isPostQuantum(algorithm), primary: pk.tag === 5 || pk.tag === 6 });
  }
  return out;
}

export interface KeyShape { version: number; algorithms: string[]; postQuantum: boolean; postQuantumAlgorithms: string[] }

export function describeKeyShape(armoredOrBinary: string | Uint8Array): KeyShape {
  const bytes = typeof armoredOrBinary === 'string' ? dearmor(armoredOrBinary) : armoredOrBinary;
  const packets = keyPackets(bytes);
  const names = [...new Set(packets.map((k) => k.name))];
  const pq = [...new Set(packets.filter((k) => k.postQuantum).map((k) => k.name))];
  return { version: packets[0]?.version ?? 0, algorithms: names, postQuantum: pq.length > 0, postQuantumAlgorithms: pq };
}
