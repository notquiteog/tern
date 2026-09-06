// Passkeys (WebAuthn level 2), verified here with nothing but Node's crypto.
// A passkey is the phishing-resistant factor the OpenPGP challenge already
// provides, in the form the browser and the operating system offer natively:
// the private key never leaves the authenticator, the signature is bound to
// this origin, and the challenge is single use.
//
// The two formats WebAuthn speaks are CBOR (the attestation object and the
// public key inside it) and packed binary authenticator data. Both are
// small enough to decode here rather than take a dependency, and decoding
// them ourselves means the parser refuses anything it does not expect
// instead of accepting whatever a general-purpose library tolerates.
import { createHash, createPublicKey, createVerify, timingSafeEqual, verify as verifyOneShot, type KeyObject } from 'node:crypto';
import { config } from '../config.js';
import { b64url, fromB64url, randomToken } from '../crypto.js';
import { badRequest } from '../errors.js';

// ---------- CBOR ----------
// Only the subset RFC 8949 needs for these structures: unsigned and negative
// integers, byte and text strings of definite length, arrays, maps, and the
// three simple values. Indefinite lengths, tags and floats are refused,
// which is enough for every authenticator's output and rejects the rest.

interface Cursor { buf: Buffer; pos: number }

function readArg(c: Cursor, info: number): number {
  if (info < 24) return info;
  if (info === 24) { const v = c.buf.readUInt8(c.pos); c.pos += 1; return v; }
  if (info === 25) { const v = c.buf.readUInt16BE(c.pos); c.pos += 2; return v; }
  if (info === 26) { const v = c.buf.readUInt32BE(c.pos); c.pos += 4; return v; }
  if (info === 27) {
    const v = c.buf.readBigUInt64BE(c.pos); c.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('Malformed authenticator response');
    return Number(v);
  }
  throw badRequest('Malformed authenticator response');
}

export type CborValue = number | string | Buffer | boolean | null | CborValue[] | Map<number | string, CborValue>;

function readValue(c: Cursor, depth = 0): CborValue {
  if (depth > 16 || c.pos >= c.buf.length) throw badRequest('Malformed authenticator response');
  const b = c.buf.readUInt8(c.pos); c.pos += 1;
  const major = b >> 5;
  const info = b & 0x1f;
  switch (major) {
    case 0: return readArg(c, info);
    case 1: return -1 - readArg(c, info);
    case 2: case 3: {
      const len = readArg(c, info);
      if (c.pos + len > c.buf.length) throw badRequest('Malformed authenticator response');
      const slice = c.buf.subarray(c.pos, c.pos + len); c.pos += len;
      return major === 2 ? Buffer.from(slice) : slice.toString('utf8');
    }
    case 4: {
      const len = readArg(c, info);
      const out: CborValue[] = [];
      for (let i = 0; i < len; i++) out.push(readValue(c, depth + 1));
      return out;
    }
    case 5: {
      const len = readArg(c, info);
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = readValue(c, depth + 1);
        if (typeof k !== 'number' && typeof k !== 'string') throw badRequest('Malformed authenticator response');
        map.set(k, readValue(c, depth + 1));
      }
      return map;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw badRequest('Malformed authenticator response');
    default:
      throw badRequest('Malformed authenticator response');
  }
}

// Decodes one item and reports where it ended, because the attestation
// object's map is followed by nothing but the authenticator data we already
// hold; trailing bytes mean the response is not what it claims to be.
export function cborDecode(buf: Buffer): { value: CborValue; end: number } {
  const c: Cursor = { buf, pos: 0 };
  const value = readValue(c);
  return { value, end: c.pos };
}

export function cborDecodeStrict(buf: Buffer): CborValue {
  const { value, end } = cborDecode(buf);
  if (end !== buf.length) throw badRequest('Malformed authenticator response');
  return value;
}

// ---------- COSE keys ----------
// RFC 8152 in the shape WebAuthn uses it: kty, alg and the curve or modulus.
// Node has no COSE reader, but it builds a key from a JWK, and every
// algorithm below has a direct JWK spelling.

export const ALGORITHMS: Record<number, string> = {
  [-7]: 'ES256',
  [-8]: 'EdDSA',
  [-35]: 'ES384',
  [-36]: 'ES512',
  [-257]: 'RS256',
  [-258]: 'RS384',
  [-259]: 'RS512',
};

// Offered to the browser in that order: the two the platform authenticators
// on every current OS produce, then RSA for older security keys.
export const SUPPORTED_ALGS = [-7, -8, -257, -35, -36, -258, -259];

const EC_CURVE: Record<number, { crv: string; bytes: number }> = {
  1: { crv: 'P-256', bytes: 32 },
  2: { crv: 'P-384', bytes: 48 },
  3: { crv: 'P-521', bytes: 66 },
};

function num(map: Map<number | string, CborValue>, k: number): number | undefined {
  const v = map.get(k);
  return typeof v === 'number' ? v : undefined;
}
function bytes(map: Map<number | string, CborValue>, k: number): Buffer | undefined {
  const v = map.get(k);
  return Buffer.isBuffer(v) ? v : undefined;
}

export interface CoseKey { alg: number; key: KeyObject }

export function coseToKey(cose: Buffer): CoseKey {
  const decoded = cborDecodeStrict(cose);
  if (!(decoded instanceof Map)) throw badRequest('Unsupported passkey format');
  const kty = num(decoded, 1);
  const alg = num(decoded, 3);
  if (alg === undefined || !ALGORITHMS[alg]) throw badRequest('This passkey uses an algorithm Tern does not support');

  if (kty === 2) {
    const curve = EC_CURVE[num(decoded, -1) ?? 0];
    const x = bytes(decoded, -2), y = bytes(decoded, -3);
    if (!curve || !x || !y) throw badRequest('Unsupported passkey format');
    // A short coordinate is left-padded rather than accepted as-is: JWK
    // fixes the length by curve, and a mismatch would verify against the
    // wrong point.
    if (x.length > curve.bytes || y.length > curve.bytes) throw badRequest('Unsupported passkey format');
    const pad = (b: Buffer) => Buffer.concat([Buffer.alloc(curve.bytes - b.length), b]);
    return { alg, key: createPublicKey({ key: { kty: 'EC', crv: curve.crv, x: b64url(pad(x)), y: b64url(pad(y)) }, format: 'jwk' }) };
  }
  if (kty === 1) {
    // OKP: Ed25519 only. Ed448 has no WebAuthn algorithm id.
    const x = bytes(decoded, -2);
    if (num(decoded, -1) !== 6 || !x || alg !== -8) throw badRequest('Unsupported passkey format');
    return { alg, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(x) }, format: 'jwk' }) };
  }
  if (kty === 3) {
    const n = bytes(decoded, -1), e = bytes(decoded, -2);
    if (!n || !e) throw badRequest('Unsupported passkey format');
    return { alg, key: createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' }) };
  }
  throw badRequest('Unsupported passkey format');
}

function verifySignature(alg: number, key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    if (alg === -8) return verifyOneShot(null, data, key, sig);
    const hash = alg === -35 || alg === -258 ? 'sha384' : alg === -36 || alg === -259 ? 'sha512' : 'sha256';
    const v = createVerify(hash);
    v.update(data);
    v.end();
    // WebAuthn ECDSA signatures are ASN.1 DER, which is Node's default.
    return v.verify(key, sig);
  } catch {
    return false;
  }
}

// ---------- Authenticator data ----------

const FLAG_UP = 0x01;   // user present
const FLAG_UV = 0x04;   // user verified (PIN, biometric)
const FLAG_BE = 0x08;   // backup eligible (a syncing passkey)
const FLAG_BS = 0x10;   // backed up right now
const FLAG_AT = 0x40;   // attested credential data follows

export interface AuthData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  signCount: number;
  aaguid: Buffer | null;
  credentialId: Buffer | null;
  credentialPublicKey: Buffer | null;
}

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw badRequest('Malformed authenticator response');
  const flags = buf.readUInt8(32);
  const out: AuthData = {
    rpIdHash: buf.subarray(0, 32),
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    backupEligible: (flags & FLAG_BE) !== 0,
    backedUp: (flags & FLAG_BS) !== 0,
    signCount: buf.readUInt32BE(33),
    aaguid: null, credentialId: null, credentialPublicKey: null,
  };
  if (flags & FLAG_AT) {
    if (buf.length < 55) throw badRequest('Malformed authenticator response');
    const idLen = buf.readUInt16BE(53);
    // The spec caps a credential id at 1023 bytes; anything longer is not
    // one, and the column that stores it is sized for the real thing.
    if (idLen > 1023 || buf.length < 55 + idLen) throw badRequest('Malformed authenticator response');
    out.aaguid = buf.subarray(37, 53);
    out.credentialId = buf.subarray(55, 55 + idLen);
    // The key is the rest, minus any extension map the authenticator added.
    const rest = buf.subarray(55 + idLen);
    const { end } = cborDecode(rest);
    out.credentialPublicKey = rest.subarray(0, end);
  }
  return out;
}

// ---------- Relying party identity ----------
// The RP id is the app's registered domain and the origin is its exact URL.
// Both come from APP_URL, so a passkey made on this install answers only to
// this install; nothing a member types can influence either.

export function rpId(): string {
  try { return new URL(config.appUrl).hostname; } catch { return 'localhost'; }
}

// A relying party id has to be a domain. WebAuthn has no notion of an IP
// address as an identity, so a browser refuses one outright — an install
// still reached by its address would offer a passkey button that could only
// ever fail. Better to say why. "localhost" is the one bare name browsers
// make an exception for, and it is how the app is developed.
export function passkeysAvailable(): { ok: boolean; reason: string } {
  let url: URL;
  try { url = new URL(config.appUrl); } catch { return { ok: false, reason: 'APP_URL is not a valid URL.' }; }
  const host = url.hostname;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpv6 = host.includes(':') || (host.startsWith('[') && host.endsWith(']'));
  if (isIpv4 || isIpv6) return { ok: false, reason: `Passkeys need a domain name. This install is reached at ${host}, an IP address, which browsers refuse as a passkey identity. Set APP_URL to a hostname.` };
  if (host !== 'localhost' && url.protocol !== 'https:') return { ok: false, reason: 'Passkeys need HTTPS. Set APP_URL to the https address this install is reached at.' };
  return { ok: true, reason: '' };
}
export function rpOrigins(): string[] {
  try {
    const u = new URL(config.appUrl);
    return [u.origin];
  } catch { return ['http://localhost']; }
}
export function rpName(): string {
  return 'Tern';
}

// ---------- Challenges ----------
// Random, single use, five minutes, in memory. A registration challenge is
// tied to the user it was issued to; a sign-in challenge is not, because
// with a discoverable credential the browser tells us who it is only in the
// response.

export type CeremonyPurpose = 'register' | 'login' | 'reauth';
interface Ceremony { challenge: string; purpose: CeremonyPurpose; userId: number | null; expires: number }
const ceremonies = new Map<string, Ceremony>();
setInterval(() => { const now = Date.now(); for (const [k, c] of ceremonies) if (c.expires < now) ceremonies.delete(k); }, 60_000).unref();

export function newCeremony(purpose: CeremonyPurpose, userId: number | null): { id: string; challenge: string } {
  const id = randomToken(16);
  const challenge = randomToken(32);
  ceremonies.set(id, { challenge, purpose, userId, expires: Date.now() + 5 * 60_000 });
  return { id, challenge };
}

function takeCeremony(id: string | undefined, purpose: CeremonyPurpose): Ceremony {
  if (!id) throw badRequest('That sign-in attempt has expired. Try again.');
  const c = ceremonies.get(id);
  ceremonies.delete(id);
  if (!c || c.purpose !== purpose || c.expires < Date.now()) throw badRequest('That sign-in attempt has expired. Try again.');
  return c;
}

// ---------- Client data ----------

interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }

function checkClientData(raw: Buffer, expectedType: string, expectedChallenge: string): void {
  let data: ClientData;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw badRequest('Malformed authenticator response'); }
  if (data.type !== expectedType) throw badRequest('Malformed authenticator response');
  // The challenge is compared as bytes so a re-encoded but equal value still
  // matches, and in constant time so a wrong one leaks no prefix.
  const got = fromB64url(String(data.challenge ?? ''));
  const want = fromB64url(expectedChallenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw badRequest('That sign-in attempt has expired. Try again.');
  if (!rpOrigins().includes(data.origin)) throw badRequest('This passkey was used from the wrong address');
  if (data.crossOrigin) throw badRequest('This passkey was used from the wrong address');
}

// ---------- Registration ----------

export interface RegistrationResult {
  credentialId: string;
  publicKey: string;
  alg: number;
  signCount: number;
  aaguid: string | null;
  backedUp: boolean;
  transports: string[];
  userVerified: boolean;
}

export function verifyRegistration(input: {
  ceremonyId: string;
  clientDataJSON: string;
  attestationObject: string;
  transports?: string[];
}): { userId: number | null; credential: RegistrationResult } {
  const ceremony = takeCeremony(input.ceremonyId, 'register');
  const clientData = fromB64url(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.create', ceremony.challenge);

  const att = cborDecodeStrict(fromB64url(input.attestationObject));
  if (!(att instanceof Map)) throw badRequest('Malformed authenticator response');
  const authDataRaw = att.get('authData');
  if (!Buffer.isBuffer(authDataRaw)) throw badRequest('Malformed authenticator response');
  const authData = parseAuthData(authDataRaw);

  if (!authData.rpIdHash.equals(createHash('sha256').update(rpId()).digest())) throw badRequest('This passkey was made for a different site');
  if (!authData.userPresent) throw badRequest('The authenticator did not confirm you were there');
  if (!authData.credentialId || !authData.credentialPublicKey) throw badRequest('Malformed authenticator response');

  // Attestation statements are not checked: Tern does not care which make of
  // authenticator this is, only that the same one answers next time. Asking
  // for "none" and ignoring the statement is what the spec recommends when
  // there is no policy about acceptable devices, and it avoids shipping a
  // root certificate list that would go stale.
  const { alg } = coseToKey(authData.credentialPublicKey);

  return {
    userId: ceremony.userId,
    credential: {
      credentialId: b64url(authData.credentialId),
      publicKey: b64url(authData.credentialPublicKey),
      alg,
      signCount: authData.signCount,
      aaguid: authData.aaguid && !authData.aaguid.equals(Buffer.alloc(16)) ? authData.aaguid.toString('hex') : null,
      backedUp: authData.backedUp,
      transports: (input.transports ?? []).filter((t) => /^[a-z]{1,16}$/.test(t)).slice(0, 8),
      userVerified: authData.userVerified,
    },
  };
}

// ---------- Assertion ----------

export interface StoredCredential { credential_id: string; public_key: string; alg: number; sign_count: number }

export interface AssertionResult { signCount: number; userVerified: boolean; backedUp: boolean; clonedWarning: boolean }

export function verifyAssertion(input: {
  ceremonyId: string;
  purpose: CeremonyPurpose;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  stored: StoredCredential;
}): { userId: number | null; result: AssertionResult } {
  const ceremony = takeCeremony(input.ceremonyId, input.purpose);
  const clientData = fromB64url(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', ceremony.challenge);

  const authDataRaw = fromB64url(input.authenticatorData);
  const authData = parseAuthData(authDataRaw);
  if (!authData.rpIdHash.equals(createHash('sha256').update(rpId()).digest())) throw badRequest('This passkey was made for a different site');
  if (!authData.userPresent) throw badRequest('The authenticator did not confirm you were there');

  const { key } = coseToKey(fromB64url(input.stored.public_key));
  const signed = Buffer.concat([authDataRaw, createHash('sha256').update(clientData).digest()]);
  if (!verifySignature(input.stored.alg, key, signed, fromB64url(input.signature))) throw badRequest('That passkey was not accepted');

  // A counter that goes backwards means two authenticators share one private
  // key: the credential has been copied. Authenticators that do not count
  // (every syncing passkey) report zero forever and are exempt, which is
  // what the spec expects.
  const cloned = authData.signCount > 0 && input.stored.sign_count > 0 && authData.signCount <= input.stored.sign_count;

  return {
    userId: ceremony.userId,
    result: { signCount: authData.signCount, userVerified: authData.userVerified, backedUp: authData.backedUp, clonedWarning: cloned },
  };
}
