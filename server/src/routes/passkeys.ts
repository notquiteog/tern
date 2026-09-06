// Passkey enrolment and management for a signed-in person. The sign-in half
// lives in routes/auth.ts next to the password and the OpenPGP challenge, so
// all three factors are decided in one place.
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { verifyPassword } from '../crypto.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { newCeremony, passkeysAvailable, rpId, rpName, SUPPORTED_ALGS, verifyRegistration } from '../services/webauthn.js';
import { describeAuthenticator } from '../services/aaguid.js';

export const passkeysRouter = Router();

export interface CredentialRow {
  id: number; user_id: number; credential_id: string; public_key: string; alg: number; sign_count: number;
  aaguid: string | null; transports: string[]; name: string; backed_up: boolean; user_verified: boolean;
  created_at: Date; last_used_at: Date | null;
}

export async function listCredentials(userId: number): Promise<CredentialRow[]> {
  return query<CredentialRow>('SELECT * FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at', [userId]);
}

// A passkey stands in for the password only when it verified the person and
// the account is set to allow it. Presence alone (a tapped security key with
// no PIN) is a second factor, never the whole sign-in.
export async function passwordlessCredentials(userId: number): Promise<CredentialRow[]> {
  return query<CredentialRow>('SELECT * FROM webauthn_credentials WHERE user_id=$1 AND user_verified ORDER BY created_at', [userId]);
}

passkeysRouter.get('/', requireAuth, async (req, res) => {
  const rows = await listCredentials(req.user!.id);
  res.json({
    passkeys: rows.map((r) => ({
      id: r.id, name: r.name, created_at: r.created_at, last_used_at: r.last_used_at,
      backed_up: r.backed_up, user_verified: r.user_verified, transports: r.transports,
      authenticator: describeAuthenticator(r.aaguid),
    })),
    mode: (req.user as any).passkey_auth ?? 'second_factor',
    rpId: rpId(),
    ...passkeysAvailable(),
  });
});

// Enrolling a factor is a security change, so it asks for the password
// again: a session left open on a shared machine cannot add a passkey.
passkeysRouter.post('/register/start', requireAuth, async (req, res) => {
  const available = passkeysAvailable();
  if (!available.ok) throw badRequest(available.reason);
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  const { id, challenge } = newCeremony('register', req.user!.id);
  const existing = await listCredentials(req.user!.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ceremonyId: id,
    options: {
      challenge,
      rp: { id: rpId(), name: rpName() },
      // The user handle is the account id, not the username: a passkey is
      // not the place to publish the address, and it never has to change.
      user: { id: Buffer.from(`tern:${req.user!.id}`).toString('base64url'), name: req.user!.username, displayName: req.user!.display_name || req.user!.username },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      timeout: 120_000,
      attestation: 'none',
      // Discoverable so the browser can offer the account without a username
      // typed first, and verifying so it can replace the password.
      authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' },
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports })),
    },
  });
});

passkeysRouter.post('/register/finish', requireAuth, async (req, res) => {
  const b = parse(z.object({
    ceremonyId: z.string().max(64),
    clientDataJSON: z.string().max(8000),
    attestationObject: z.string().max(20_000),
    transports: z.array(z.string().max(16)).max(8).optional(),
    name: z.string().max(60).optional(),
  }), req.body);
  const { userId, credential } = verifyRegistration(b);
  if (userId !== req.user!.id) throw badRequest('That enrolment was started by someone else');
  if (await one('SELECT 1 FROM webauthn_credentials WHERE credential_id=$1', [credential.credentialId])) throw badRequest('That passkey is already registered');
  const name = (b.name ?? '').trim() || describeAuthenticator(credential.aaguid) || 'Passkey';
  const rows = await query<CredentialRow>(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, alg, sign_count, aaguid, transports, name, backed_up, user_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.user!.id, credential.credentialId, credential.publicKey, credential.alg, credential.signCount, credential.aaguid, credential.transports, name.slice(0, 60), credential.backedUp, credential.userVerified],
  );
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'auth.passkey_added',$2)`, [req.user!.id, JSON.stringify({ name, verified: credential.userVerified, backedUp: credential.backedUp })]);
  res.json({ passkey: { id: rows[0].id, name: rows[0].name, created_at: rows[0].created_at, user_verified: rows[0].user_verified, backed_up: rows[0].backed_up } });
});

passkeysRouter.put('/:id', requireAuth, async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(60) }), req.body);
  const rows = await query('UPDATE webauthn_credentials SET name=$3 WHERE id=$1 AND user_id=$2 RETURNING id', [Number(req.params.id), req.user!.id, b.name.trim()]);
  if (!rows.length) throw notFound('Passkey not found');
  res.json({ ok: true });
});

// Removing a passkey asks for the password too, so someone at an unlocked
// screen cannot quietly strip the account back to one factor.
passkeysRouter.post('/:id/delete', requireAuth, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  const rows = await query<{ name: string }>('DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2 RETURNING name', [Number(req.params.id), req.user!.id]);
  if (!rows.length) throw notFound('Passkey not found');
  // The last passkey going means passwordless sign-in has nothing to answer
  // with; put the account back to needing the password.
  const left = await one<{ n: number }>('SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id=$1 AND user_verified', [req.user!.id]);
  if (!left?.n) await query(`UPDATE users SET passkey_auth='second_factor' WHERE id=$1`, [req.user!.id]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'auth.passkey_removed',$2)`, [req.user!.id, JSON.stringify({ name: rows[0].name })]);
  res.json({ ok: true });
});

// Whether a passkey is the whole sign-in or only the second step. Mirrors
// the OpenPGP key's three modes; "off" here is simply having no passkeys.
passkeysRouter.post('/mode', requireAuth, async (req, res) => {
  const b = parse(z.object({ mode: z.enum(['second_factor', 'passwordless']), password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(b.password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  if (b.mode === 'passwordless') {
    const verified = await one<{ n: number }>('SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id=$1 AND user_verified', [req.user!.id]);
    if (!verified?.n) throw badRequest('Add a passkey that asks for your PIN, fingerprint or face first');
  }
  await query('UPDATE users SET passkey_auth=$2 WHERE id=$1', [req.user!.id, b.mode]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'auth.passkey_mode',$2)`, [req.user!.id, JSON.stringify({ mode: b.mode })]);
  res.json({ ok: true });
});
