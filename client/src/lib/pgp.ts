// OpenPGP in the browser. The library is loaded on first use (it is large
// and most sessions never need it). The private key lives here and nowhere
// else in usable form: the server only ever holds the passphrase-protected
// armour, and this module keeps the unlocked key in memory for the session.
import type * as OpenPGP from 'openpgp';

type Lib = typeof OpenPGP;
export type PrivateKey = OpenPGP.PrivateKey;
let lib: Promise<Lib> | null = null;
export function pgp(): Promise<Lib> { return (lib ??= import('openpgp')); }

export interface KeyInfo { fingerprint: string; keyId: string; userIds: string[]; algorithm: string; created: Date; expires: Date | null; isPrivate: boolean; protectedByPassphrase: boolean; publicKey: string }

export async function inspectKey(armored: string): Promise<KeyInfo> {
  const o = await pgp();
  const key = await o.readKey({ armoredKey: armored.trim() });
  const exp = await key.getExpirationTime().catch(() => null);
  const info = key.getAlgorithmInfo();
  return {
    fingerprint: key.getFingerprint(), keyId: key.getKeyID().toHex(), userIds: key.getUserIDs(),
    algorithm: `${info.algorithm}${info.curve ? ` ${info.curve}` : (info as any).bits ? ` ${(info as any).bits}` : ''}`,
    created: key.getCreationTime(), expires: exp instanceof Date ? exp : null,
    isPrivate: key.isPrivate(), protectedByPassphrase: key.isPrivate() ? !(key as OpenPGP.PrivateKey).isDecrypted() : false,
    publicKey: key.toPublic().armor(),
  };
}

export async function generateKeyPair(input: { name: string; email: string; passphrase: string }): Promise<{ publicKey: string; privateKey: string; fingerprint: string }> {
  const o = await pgp();
  const r = await o.generateKey({ userIDs: [{ name: input.name, email: input.email }], passphrase: input.passphrase, format: 'armored' });
  const key = await o.readKey({ armoredKey: r.publicKey });
  return { publicKey: r.publicKey, privateKey: r.privateKey, fingerprint: key.getFingerprint() };
}

// An imported private key without a passphrase gets one before it goes anywhere.
export async function protectPrivateKey(armored: string, passphrase: string): Promise<string> {
  const o = await pgp();
  const key = await o.readPrivateKey({ armoredKey: armored.trim() });
  if (!key.isDecrypted()) return key.armor();
  return (await o.encryptKey({ privateKey: key, passphrase })).armor();
}

export async function changePassphrase(armored: string, current: string, next: string): Promise<string> {
  const o = await pgp();
  const unlocked = await unlockPrivateKey(armored, current);
  return (await o.encryptKey({ privateKey: unlocked, passphrase: next })).armor();
}

export async function unlockPrivateKey(armored: string, passphrase: string): Promise<PrivateKey> {
  const o = await pgp();
  const key = await o.readPrivateKey({ armoredKey: armored.trim() });
  if (key.isDecrypted()) return key;
  try { return await o.decryptKey({ privateKey: key, passphrase }); } catch { throw new Error('That passphrase did not unlock the key'); }
}

export interface SignatureStatus { keyId: string; verified: boolean; signer: string | null }

export async function decryptArmored(armored: string, key: PrivateKey, verificationArmored: string[] = []): Promise<{ text: string; signatures: SignatureStatus[] }> {
  const o = await pgp();
  const verificationKeys = await Promise.all(verificationArmored.map((a) => o.readKey({ armoredKey: a })));
  const r = await o.decrypt({ message: await o.readMessage({ armoredMessage: armored }), decryptionKeys: key, verificationKeys: verificationKeys.length ? verificationKeys : undefined, expectSigned: false });
  const signatures: SignatureStatus[] = [];
  for (const s of r.signatures) {
    let verified = false;
    try { await s.verified; verified = true; } catch { verified = false; }
    const signer = verificationKeys.find((k) => k.getKeys(s.keyID).length)?.getUserIDs()[0] ?? null;
    signatures.push({ keyId: s.keyID.toHex(), verified, signer });
  }
  return { text: String(r.data), signatures };
}

export async function verifyDetached(text: string, signatureArmored: string, verificationArmored: string[]): Promise<SignatureStatus[]> {
  const o = await pgp();
  const verificationKeys = await Promise.all(verificationArmored.map((a) => o.readKey({ armoredKey: a })));
  if (!verificationKeys.length) return [{ keyId: '', verified: false, signer: null }];
  const r = await o.verify({ message: await o.createMessage({ text }), signature: await o.readSignature({ armoredSignature: signatureArmored }), verificationKeys });
  const out: SignatureStatus[] = [];
  for (const s of r.signatures) { let verified = false; try { await s.verified; verified = true; } catch { /* bad */ } out.push({ keyId: s.keyID.toHex(), verified, signer: verificationKeys.find((k) => k.getKeys(s.keyID).length)?.getUserIDs()[0] ?? null }); }
  return out;
}

export async function encryptText(text: string, recipientArmored: string[], signWith?: PrivateKey): Promise<string> {
  const o = await pgp();
  const encryptionKeys = await Promise.all(recipientArmored.map((a) => o.readKey({ armoredKey: a })));
  return o.encrypt({ message: await o.createMessage({ text }), encryptionKeys, signingKeys: signWith, format: 'armored' });
}

export async function signDetached(text: string, key: PrivateKey): Promise<string> {
  const o = await pgp();
  return o.sign({ message: await o.createMessage({ text }), signingKeys: key, detached: true, format: 'armored' });
}

export function looksEncrypted(s: string | null | undefined): boolean { return Boolean(s && /-----BEGIN PGP MESSAGE-----/.test(s)); }
export function looksLikeKey(s: string): 'private' | 'public' | null { return /BEGIN PGP PRIVATE KEY BLOCK/.test(s) ? 'private' : /BEGIN PGP PUBLIC KEY BLOCK/.test(s) ? 'public' : null; }

// ---------- this device ----------
// The passphrase-protected private key may be remembered in this browser so
// sign-in with the key works before a session exists. The passphrase never is.
const DEVICE_KEY = 'tern.pgp.privateKey';
export function loadDeviceKey(): { armored: string; fingerprint: string } | null {
  try { const raw = localStorage.getItem(DEVICE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function saveDeviceKey(armored: string, fingerprint: string): void { try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ armored, fingerprint })); } catch { /* ignore */ } }
export function clearDeviceKey(): void { try { localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ } }

export function fmtFingerprint(fp: string | null | undefined): string {
  if (!fp) return '';
  return fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim();
}
