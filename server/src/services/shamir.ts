// F13: recovery for the vault, without a back door.
//
// The situation this exists for. Every user's data key is wrapped with the
// server master key from `.env`. Lose that file — a rebuilt box, a restored
// backup that skipped the dotfile, a disk that died — and every mailbox
// cache, every stored mailbox password and every sealed index is
// unrecoverable. "No email-based password reset by design" is the right
// call and it turns one lost file into a destroyed archive.
//
// The wrong fixes are obvious: escrow the key somewhere, or let an admin
// print it. Both replace a cliff with a back door.
//
// What this does instead is split the master key with Shamir's scheme over
// GF(256): `n` shares, any `k` of which reconstruct it, and any `k-1` of
// which reveal *nothing at all* — that is the actual theorem, not a
// difficulty argument. The shares are shown once, meant to be printed, and
// never stored: the database keeps only how many exist, when, and a short
// digest to tell a genuine share from a typo.
//
// Recovery is deliberately not in the web app. It is a CLI command, because
// the situation it is for is one where the app cannot start.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------- GF(256) ----------
// The field used by AES, so the tables are the familiar ones. Everything is
// byte-wise: a 32-byte key is 32 independent one-byte secrets sharing the
// same x-coordinates.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator 3 (x + 1) modulo the AES polynomial 0x11b.
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function div(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

// ---------- Splitting ----------

export interface Share {
  /** 1..255, the x-coordinate. Never zero: f(0) is the secret. */
  index: number;
  /** One byte of the polynomial evaluated at `index`, per secret byte. */
  data: Buffer;
}

export function split(secret: Buffer, n: number, k: number): Share[] {
  if (k < 2 || k > 255) throw new Error('the threshold must be between 2 and 255');
  if (n < k || n > 255) throw new Error('there must be at least as many shares as the threshold, and at most 255');
  if (!secret.length) throw new Error('nothing to split');

  const shares: Share[] = Array.from({ length: n }, (_, i) => ({ index: i + 1, data: Buffer.alloc(secret.length) }));
  // One random polynomial of degree k-1 per byte, with the secret byte as
  // its constant term. The coefficients come from the system CSPRNG and are
  // discarded with the stack frame.
  const coeffs = Buffer.alloc(k - 1);
  for (let byte = 0; byte < secret.length; byte++) {
    randomBytes(k - 1).copy(coeffs);
    for (const share of shares) {
      // Horner, from the top coefficient down to the secret.
      let acc = 0;
      for (let c = k - 2; c >= 0; c--) acc = mul(acc, share.index) ^ coeffs[c];
      share.data[byte] = mul(acc, share.index) ^ secret[byte];
    }
  }
  coeffs.fill(0);
  return shares;
}

// ---------- Recombining ----------

export function combine(shares: Share[]): Buffer {
  if (shares.length < 2) throw new Error('at least two shares are needed');
  const len = shares[0].data.length;
  if (shares.some((s) => s.data.length !== len)) throw new Error('these shares are not from the same secret');
  const seen = new Set(shares.map((s) => s.index));
  if (seen.size !== shares.length) throw new Error('the same share was given twice');
  if ([...seen].some((i) => i < 1 || i > 255)) throw new Error('a share has an impossible number');

  const out = Buffer.alloc(len);
  for (let byte = 0; byte < len; byte++) {
    // Lagrange interpolation at x = 0.
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        basis = mul(basis, div(shares[j].index, shares[i].index ^ shares[j].index));
      }
      acc ^= mul(shares[i].data[byte], basis);
    }
    out[byte] = acc;
  }
  return out;
}

// ---------- The printed form ----------
// A share has to survive being typed back in by somebody reading paper, so
// it carries its own checksum and is grouped for the eye. The version prefix
// exists so a future scheme can refuse an old share rather than producing
// rubbish from it.

const VERSION = 'TERN1';

export function encodeShare(share: Share, threshold: number): string {
  const body = Buffer.concat([Buffer.from([share.index, threshold]), share.data]);
  const check = createHash('sha256').update(body).digest().subarray(0, 2);
  const b32 = base32(Buffer.concat([body, check]));
  return `${VERSION}-${b32.match(/.{1,5}/g)!.join('-')}`;
}

export function decodeShare(text: string): { share: Share; threshold: number } {
  const raw = String(text ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw.startsWith(`${VERSION}-`)) throw new Error('That does not look like a Tern recovery share');
  const b32 = raw.slice(VERSION.length + 1).replace(/-/g, '');
  const buf = unbase32(b32);
  if (buf.length < 5) throw new Error('That share is too short to be complete');
  const body = buf.subarray(0, buf.length - 2);
  const check = buf.subarray(buf.length - 2);
  const want = createHash('sha256').update(body).digest().subarray(0, 2);
  if (!timingSafeEqual(check, want)) throw new Error('That share did not check out — it may have a typo');
  return { share: { index: body[0], data: Buffer.from(body.subarray(2)) }, threshold: body[1] };
}

// A short, non-secret name for a share, so the admin page can list which
// ones exist and the recovery tool can say "that is share 3 again" without
// anything about the share itself being stored.
export function shareFingerprint(share: Share): string {
  return createHash('sha256').update(share.data).digest('hex').slice(0, 8);
}

// The only thing about the secret that is ever written down: enough to say
// "yes, that is the key this install was using" and nothing more. Eight
// bytes of a salted digest, where the salt is public — it exists to stop the
// digest being looked up, not to hide anything.
export function secretCheck(secret: Buffer): string {
  return createHash('sha256').update('tern-vault-check-v1').update(secret).digest('hex').slice(0, 16);
}

export function verifySecret(secret: Buffer, check: string): boolean {
  const a = Buffer.from(secretCheck(secret), 'hex');
  const b = Buffer.from(String(check ?? ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Crockford's alphabet, which drops I, L, O and U so a handwritten share
// cannot be misread as a different one.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Buffer {
  // The letters Crockford drops are accepted on input and folded, because
  // somebody reading their own handwriting will type them.
  const cleaned = String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const ch of cleaned) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`"${ch}" is not part of a share`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}
