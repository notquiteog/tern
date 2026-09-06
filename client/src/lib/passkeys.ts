// Browser side of passkeys. The WebAuthn API speaks ArrayBuffers where the
// wire speaks base64url, so this module is mostly that conversion, plus the
// two ceremonies and an honest answer to "can this browser do it at all".
import { api } from '../api';

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && Boolean(navigator.credentials?.create);
}

// Whether the browser can offer a passkey without the person naming their
// account first. False on browsers with no platform authenticator and on
// older ones that never learnt conditional UI.
export async function discoverableSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    const c = window.PublicKeyCredential as any;
    if (typeof c.isConditionalMediationAvailable === 'function' && (await c.isConditionalMediationAvailable())) return true;
    return typeof c.isUserVerifyingPlatformAuthenticatorAvailable === 'function' && (await c.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

// Backed by a plain ArrayBuffer rather than the ambient ArrayBufferLike, so
// the result satisfies BufferSource where WebAuthn asks for one.
function toBuffer(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The browser's own words are better than ours for "you cancelled" and "this
// key is already enrolled"; anything else gets a sentence a person can act on.
function readable(e: unknown): Error {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'NotAllowedError') return new Error('Cancelled, or the passkey prompt timed out.');
  if (err?.name === 'InvalidStateError') return new Error('This device already has a passkey for your account.');
  if (err?.name === 'SecurityError') return new Error('Passkeys need the site to be served over HTTPS on its own domain.');
  if (err?.name === 'AbortError') return new Error('Cancelled.');
  return e instanceof Error ? e : new Error('The passkey could not be used.');
}

interface RegisterOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: string; alg: number }[];
  timeout: number;
  attestation: string;
  authenticatorSelection: Record<string, unknown>;
  excludeCredentials: { type: string; id: string; transports?: string[] }[];
}

export interface RegisterPayload {
  ceremonyId: string;
  clientDataJSON: string;
  attestationObject: string;
  transports: string[];
  name?: string;
}

// Enrol a new passkey. The password is checked server-side before the
// challenge is issued, so a session someone walked away from cannot add one.
export async function createPasskey(password: string, name?: string): Promise<{ id: number; name: string }> {
  const start = await api.post<{ ceremonyId: string; options: RegisterOptions }>('/api/passkeys/register/start', { password });
  const o = start.options;
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: toBuffer(o.challenge),
        rp: o.rp,
        user: { id: toBuffer(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams as PublicKeyCredentialParameters[],
        timeout: o.timeout,
        attestation: o.attestation as AttestationConveyancePreference,
        authenticatorSelection: o.authenticatorSelection as AuthenticatorSelectionCriteria,
        excludeCredentials: o.excludeCredentials.map((c) => ({ type: 'public-key' as const, id: toBuffer(c.id), transports: c.transports as AuthenticatorTransport[] })),
      },
    })) as PublicKeyCredential | null;
  } catch (e) { throw readable(e); }
  if (!credential) throw new Error('No passkey was created.');
  const response = credential.response as AuthenticatorAttestationResponse;
  const payload: RegisterPayload = {
    ceremonyId: start.ceremonyId,
    clientDataJSON: toB64url(response.clientDataJSON),
    attestationObject: toB64url(response.attestationObject),
    transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    name,
  };
  const done = await api.post<{ passkey: { id: number; name: string } }>('/api/passkeys/register/finish', payload);
  return done.passkey;
}

export interface AssertionPayload {
  ceremonyId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

interface AssertionChallenge {
  ceremonyId: string;
  challenge: string;
  rpId: string;
  userVerification?: string;
  allowCredentials?: { type: string; id: string; transports?: string[] }[];
}

// Answer a challenge. `mediation: 'conditional'` is what puts passkeys in the
// browser's own autofill list; it is passed through so the sign-in form can
// offer one without a button being pressed.
export async function getAssertion(c: AssertionChallenge, opts: { mediation?: CredentialMediationRequirement; signal?: AbortSignal } = {}): Promise<AssertionPayload> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: toBuffer(c.challenge),
        rpId: c.rpId,
        timeout: 120_000,
        userVerification: (c.userVerification ?? 'preferred') as UserVerificationRequirement,
        allowCredentials: (c.allowCredentials ?? []).map((a) => ({ type: 'public-key' as const, id: toBuffer(a.id), transports: a.transports as AuthenticatorTransport[] })),
      },
      mediation: opts.mediation,
      signal: opts.signal,
    })) as PublicKeyCredential | null;
  } catch (e) { throw readable(e); }
  if (!credential) throw new Error('No passkey was offered.');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    ceremonyId: c.ceremonyId,
    credentialId: credential.id,
    clientDataJSON: toB64url(response.clientDataJSON),
    authenticatorData: toB64url(response.authenticatorData),
    signature: toB64url(response.signature),
    userHandle: response.userHandle ? toB64url(response.userHandle) : null,
  };
}
