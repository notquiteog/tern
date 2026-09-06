// Keys and sign-in-with-key. The user's own key pair (public stored plain,
// private stored only passphrase-protected), the keys of people they write
// to, and the challenge round trip that turns a key into a second factor or
// a password replacement.
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { generateRecoveryCodes, sha256hex, verifyPassword } from '../crypto.js';
import { clearUserKeys, createChallenge, getUserKeys, lookupKey, readPrivateKey, readPublicKey, recipientKeys, removeRecipientKey, saveRecipientKey, saveUserKeys, verifyChallenge, type PgpAuthMode } from '../services/pgp.js';
import { forgetPeer, getPeer, isStale, listPeers, recommend, updateGossip } from '../services/autocrypt.js';
import { listAccounts } from '../services/accounts.js';
import { describeKeyShape } from '../services/pgpPackets.js';
import { rateLimit } from '../util/rateLimit.js';

export const pgpRouter = Router();
pgpRouter.use(requireAuth);

const emailParam = (v: string) => { const e = String(v).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest('Invalid address'); return e; };

pgpRouter.get('/me', async (req, res) => {
  const k = await getUserKeys(req.user!.id);
  const info = k.publicKey ? await readPublicKey(k.publicKey).catch(() => null) : null;
  res.json({ key: info ? { fingerprint: info.fingerprint, keyId: info.keyId, userIds: info.userIds, emails: info.emails, algorithm: info.algorithm, created: info.created, expires: info.expires, publicKey: info.armored, version: info.version, algorithms: info.algorithms, postQuantum: info.postQuantum, postQuantumAlgorithms: info.postQuantumAlgorithms } : null, hasPrivate: Boolean(k.privateKey), auth: k.auth, updatedAt: k.updatedAt, autocrypt: k.autocrypt });
});

// Upload or replace the key pair. A private key is accepted only in
// passphrase-protected form and defines the public half; a public key alone
// is fine for people who keep their private key elsewhere.
pgpRouter.put('/me', async (req, res) => {
  const b = parse(z.object({ publicKey: z.string().max(200_000).optional(), privateKey: z.string().max(400_000).nullable().optional() }), req.body);
  if (!b.publicKey && !b.privateKey) throw badRequest('Provide a public key, a private key, or both');
  const current = await getUserKeys(req.user!.id);
  let publicArmored: string, fingerprint: string, privateArmored: string | null | undefined;
  if (b.privateKey) {
    const p = await readPrivateKey(b.privateKey);
    publicArmored = p.info.armored; fingerprint = p.info.fingerprint; privateArmored = p.armored;
    if (b.publicKey) {
      const pub = await readPublicKey(b.publicKey);
      if (pub.fingerprint !== fingerprint) throw badRequest('The public and private keys do not belong to the same key pair');
    }
  } else {
    const pub = await readPublicKey(b.publicKey!);
    publicArmored = pub.armored; fingerprint = pub.fingerprint;
    // A new public key that does not match the stored private key drops that private key.
    privateArmored = b.privateKey === null ? null : current.fingerprint === fingerprint ? undefined : null;
  }
  await saveUserKeys(req.user!.id, publicArmored, fingerprint, privateArmored);
  // Sign-in with key must always be answerable; a changed key needs re-enabling.
  if (current.fingerprint && current.fingerprint !== fingerprint && current.auth !== 'off') await query(`UPDATE users SET pgp_auth='off' WHERE id=$1`, [req.user!.id]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'pgp.key_updated',$2)`, [req.user!.id, JSON.stringify({ fingerprint, hasPrivate: Boolean(privateArmored ?? (privateArmored === undefined && current.privateKey)) })]);
  res.json({ ok: true, fingerprint });
});

pgpRouter.delete('/me', async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  await clearUserKeys(req.user!.id);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'pgp.key_removed')`, [req.user!.id]);
  res.json({ ok: true });
});

// The stored (passphrase-protected) private key, for a browser that does
// not have it yet. Only for a fully signed-in session.
pgpRouter.get('/me/private', async (req, res) => {
  const k = await getUserKeys(req.user!.id);
  if (!k.privateKey) throw notFound('No private key is stored on this server');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ privateKey: k.privateKey, fingerprint: k.fingerprint });
});

// Enabling sign-in with the key: prove you can answer a challenge first.
pgpRouter.post('/auth/challenge', async (req, res) => {
  const k = await getUserKeys(req.user!.id);
  if (!k.publicKey) throw badRequest('Add a key first');
  const c = await createChallenge(req.user!.id, k.publicKey, 'enable');
  res.json({ challengeId: c.id, challenge: c.armored });
});

pgpRouter.put('/auth', async (req, res) => {
  const b = parse(z.object({ mode: z.enum(['off', 'second_factor', 'passwordless']), password: z.string().min(1), challengeId: z.string().optional(), response: z.string().max(200).optional() }), req.body);
  if (!(await verifyPassword(b.password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  let recoveryCodes: string[] | null = null;
  if (b.mode !== 'off') {
    const k = await getUserKeys(req.user!.id);
    if (!k.publicKey) throw badRequest('Add a key first');
    if (verifyChallenge(b.challengeId, b.response, 'enable') !== req.user!.id) throw badRequest('The challenge was not answered correctly. Unlock your key and try again.');
    if (!req.user!.recovery_codes.length) {
      recoveryCodes = generateRecoveryCodes();
      await query('UPDATE users SET recovery_codes=$2 WHERE id=$1', [req.user!.id, recoveryCodes.map((c) => sha256hex(c.toLowerCase()))]);
    }
  }
  await query('UPDATE users SET pgp_auth=$2 WHERE id=$1', [req.user!.id, b.mode satisfies PgpAuthMode]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'pgp.auth_changed',$2)`, [req.user!.id, JSON.stringify({ mode: b.mode })]);
  res.json({ ok: true, mode: b.mode, recoveryCodes });
});

// ---------- Other people's keys ----------

pgpRouter.get('/recipients', async (req, res) => {
  const emails = String(req.query.emails ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).slice(0, 50);
  const keys = await recipientKeys(req.user!.id, emails);
  res.json({ keys: Object.fromEntries([...keys].map(([e, k]) => [e, { fingerprint: k.fingerprint, source: k.source, publicKey: k.publicKey, recommendation: k.recommendation ?? null }])) });
});

pgpRouter.put('/recipients/:email', async (req, res) => {
  const email = emailParam(String(req.params.email));
  const { publicKey } = parse(z.object({ publicKey: z.string().min(1).max(200_000) }), req.body);
  const info = await readPublicKey(publicKey);
  const saved = await saveRecipientKey(req.user!.id, email, info, 'manual');
  res.json({ key: { ...saved, userIds: info.userIds, algorithm: info.algorithm, matchesAddress: info.emails.includes(email) } });
});

pgpRouter.delete('/recipients/:email', async (req, res) => {
  await removeRecipientKey(req.user!.id, emailParam(String(req.params.email)));
  res.json({ ok: true });
});

pgpRouter.post('/lookup', rateLimit({ name: 'pgp-lookup', perMinute: 20 }), async (req, res) => {
  const { email } = parse(z.object({ email: z.string().max(320) }), req.body);
  const e = emailParam(email);
  const found = await lookupKey(e);
  if (!found) { res.status(404).json({ error: `No published key found for ${e} (checked its Web Key Directory and keys.openpgp.org)` }); return; }
  const saved = await saveRecipientKey(req.user!.id, e, found.info, found.source);
  res.json({ key: { ...saved, userIds: found.info.userIds, algorithm: found.info.algorithm, matchesAddress: true } });
});

// ---------- Autocrypt ----------

pgpRouter.get('/autocrypt', async (req, res) => {
  const k = await getUserKeys(req.user!.id);
  const peers = await listPeers(req.user!.id);
  res.json({
    enabled: k.autocrypt.enabled, prefer: k.autocrypt.prefer, hasKey: Boolean(k.publicKey),
    peers: peers.map((p) => ({ email: p.email, lastSeen: p.last_seen, keySeen: p.autocrypt_timestamp, fingerprint: p.fingerprint, preferEncrypt: p.prefer_encrypt, gossipFingerprint: p.gossip_fingerprint, gossipSeen: p.gossip_timestamp, stale: isStale(p), recommendation: recommend(p, k.autocrypt.prefer).recommendation })),
  });
});

pgpRouter.put('/autocrypt', async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean().optional(), prefer: z.enum(['mutual', 'nopreference']).optional() }), req.body);
  await query('UPDATE users SET autocrypt_enabled=COALESCE($2, autocrypt_enabled), autocrypt_prefer=COALESCE($3, autocrypt_prefer) WHERE id=$1', [req.user!.id, b.enabled ?? null, b.prefer ?? null]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'pgp.autocrypt_changed',$2)`, [req.user!.id, JSON.stringify(b)]);
  const k = await getUserKeys(req.user!.id);
  res.json({ enabled: k.autocrypt.enabled, prefer: k.autocrypt.prefer });
});

pgpRouter.delete('/autocrypt/peers/:email', async (req, res) => {
  await forgetPeer(req.user!.id, emailParam(String(req.params.email)));
  res.json({ ok: true });
});

// Promote a key learned through Autocrypt to a verified recipient key, so
// mail to that address is encrypted by default from now on.
pgpRouter.post('/autocrypt/peers/:email/trust', async (req, res) => {
  const email = emailParam(String(req.params.email));
  const peer = await getPeer(req.user!.id, email);
  const armored = peer?.public_key ?? peer?.gossip_key;
  if (!armored) throw notFound('No Autocrypt key for that address');
  const info = await readPublicKey(armored);
  const saved = await saveRecipientKey(req.user!.id, email, info, peer!.public_key ? 'autocrypt' : 'autocrypt-gossip');
  res.json({ key: { ...saved, userIds: info.userIds, algorithm: info.algorithm } });
});

// Autocrypt-Gossip headers live inside the encrypted part, which only the
// browser can open; it reports them here. Only addresses the message was
// actually sent to are accepted (the server checks against its own copy).
pgpRouter.post('/autocrypt/gossip', async (req, res) => {
  const b = parse(z.object({ emailId: z.number().int(), headers: z.array(z.string().max(20_000)).max(50) }), req.body);
  const accountIds = (await listAccounts(req.user!.id)).map((a) => a.id);
  const m = await one<any>('SELECT id, to_addr, cc_addr, from_addr, sent_at, received_at FROM emails WHERE id=$1 AND account_id = ANY($2)', [b.emailId, accountIds]);
  if (!m) throw notFound('Message not found');
  const recipients = [...(m.to_addr ?? []), ...(m.cc_addr ?? [])].map((a: any) => String(a.email ?? '').toLowerCase()).filter(Boolean);
  const n = await updateGossip(req.user!.id, recipients, b.headers, new Date(m.sent_at ?? m.received_at));
  res.json({ ok: true, updated: n });
});

// Which contacts have keys, for the encryption settings page.
pgpRouter.get('/recipients/summary', async (req, res) => {
  const r = await one<{ contacts: number; extra: number }>(`SELECT (SELECT count(*)::int FROM contacts WHERE user_id=$1 AND pgp_public_key IS NOT NULL) AS contacts, (SELECT count(*)::int FROM pgp_keys WHERE user_id=$1) AS extra`, [req.user!.id]);
  const recent = await query<any>(`SELECT email, fingerprint, source, created_at, public_key FROM pgp_keys WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user!.id]);
  const keys = recent.map(({ public_key, ...k }) => { let shape = { version: 0, postQuantum: false, postQuantumAlgorithms: [] as string[] }; try { shape = describeKeyShape(public_key); } catch { /* cosmetic */ } return { ...k, version: shape.version, postQuantum: shape.postQuantum, postQuantumAlgorithms: shape.postQuantumAlgorithms }; });
  res.json({ contactsWithKeys: r?.contacts ?? 0, keys });
});
