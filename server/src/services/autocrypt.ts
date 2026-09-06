// Autocrypt Level 1 (https://autocrypt.org/level1.html): every message we
// send carries our public key in an Autocrypt header; every message we
// receive teaches us the sender's key. No key servers, no fingerprints to
// compare, encryption "just happens" once both sides have written to each
// other. The peer state table below is the spec's, per Tern user, and the
// recommendation function is the spec's decision procedure.
import * as openpgp from 'openpgp';
import { one, query } from '../db.js';
import { logger } from '../log.js';

const log = logger('autocrypt');

export type PreferEncrypt = 'mutual' | 'nopreference';
export interface AutocryptHeader { addr: string; preferEncrypt: PreferEncrypt; keydata: Uint8Array }
export interface PeerState {
  email: string; last_seen: Date | null; autocrypt_timestamp: Date | null; public_key: string | null; fingerprint: string | null; prefer_encrypt: PreferEncrypt;
  gossip_timestamp: Date | null; gossip_key: string | null; gossip_fingerprint: string | null;
}
export type Recommendation = 'disable' | 'discourage' | 'available' | 'encrypt';

const KNOWN = new Set(['addr', 'prefer-encrypt', 'keydata']);
// A key seen this long ago without a fresh header is probably stale (§7.2.3).
const STALE_MS = 35 * 24 * 3600_000;

// Syntax only. Unknown attributes whose names do not start with "_" make the
// whole header invalid, as the spec requires, so a future incompatible
// version is ignored rather than half-understood.
export function parseAutocryptHeader(raw: string): AutocryptHeader | null {
  const attrs: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) { if (part.trim()) return null; continue; }
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1);
    if (!KNOWN.has(name) && !name.startsWith('_')) return null;
    if (name in attrs) return null;
    attrs[name] = name === 'keydata' ? value.replace(/\s+/g, '') : value.trim();
  }
  const addr = attrs.addr?.toLowerCase();
  if (!addr || !addr.includes('@') || !attrs.keydata) return null;
  let keydata: Uint8Array;
  try { keydata = new Uint8Array(Buffer.from(attrs.keydata, 'base64')); } catch { return null; }
  if (!keydata.length) return null;
  const preferEncrypt: PreferEncrypt = attrs['prefer-encrypt'] === 'mutual' ? 'mutual' : 'nopreference';
  return { addr, preferEncrypt, keydata };
}

// The key inside must be a usable public key. Expired or revoked keys are
// not stored: the peer will send a fresh one.
export async function readKeydata(keydata: Uint8Array): Promise<{ armored: string; fingerprint: string } | null> {
  try {
    const key = await openpgp.readKey({ binaryKey: keydata });
    if (key.isPrivate()) return null;
    await key.getEncryptionKey();
    const exp = await key.getExpirationTime().catch(() => null);
    if (exp instanceof Date && exp.getTime() < Date.now()) return null;
    return { armored: key.armor(), fingerprint: key.getFingerprint() };
  } catch (e) {
    log.debug('keydata rejected', { err: (e as Error).message });
    return null;
  }
}

// The smallest certificate other clients accept: primary key, one user ID
// with its self-signature, and the encryption subkey with its binding
// signature. Falls back to the whole public key if the pruning fails.
export async function minimalKey(armoredPublicKey: string): Promise<Uint8Array> {
  const key = (await openpgp.readKey({ armoredKey: armoredPublicKey })).toPublic();
  try {
    const { user, selfCertification } = await key.getPrimaryUser();
    const enc = await key.getEncryptionKey();
    const list = new openpgp.PacketList<any>();
    list.push(key.keyPacket);
    // v6 keys carry their flags and preferences on direct-key signatures.
    for (const s of ((key as any).directSignatures ?? []) as unknown[]) list.push(s);
    list.push(user.userID);
    list.push(selfCertification);
    if (enc && enc.getKeyID().toHex() !== key.getKeyID().toHex()) {
      const sub = key.subkeys.find((s) => s.getKeyID().toHex() === enc.getKeyID().toHex());
      if (sub) {
        list.push(sub.keyPacket);
        const binding = [...sub.bindingSignatures].sort((a, b) => b.created!.getTime() - a.created!.getTime())[0];
        if (binding) list.push(binding);
      }
    }
    const pruned = new openpgp.PublicKey(list);
    // Prove the result still works before using it.
    await pruned.getEncryptionKey();
    return pruned.write();
  } catch (e) {
    log.debug('minimal key failed, sending the full key', { err: (e as Error).message });
    return key.write();
  }
}

export async function buildAutocryptHeader(addr: string, preferEncrypt: PreferEncrypt, armoredPublicKey: string): Promise<string> {
  const keydata = Buffer.from(await minimalKey(armoredPublicKey)).toString('base64');
  return `addr=${addr.toLowerCase()}; ${preferEncrypt === 'mutual' ? 'prefer-encrypt=mutual; ' : ''}keydata=${keydata}`;
}

export async function buildGossipHeader(addr: string, armoredPublicKey: string): Promise<string> {
  const keydata = Buffer.from(await minimalKey(armoredPublicKey)).toString('base64');
  return `addr=${addr.toLowerCase()}; keydata=${keydata}`;
}

// JMAP servers differ in how they hand a header back: Stalwart answers a
// request for `header:Autocrypt:all:asRaw` under `header:Autocrypt` with a
// single string, others echo the requested name and return an array.
export function autocryptHeadersOf(e: any): string[] {
  for (const k of ['header:Autocrypt:all:asRaw', 'header:Autocrypt:all', 'header:Autocrypt:asRaw', 'header:Autocrypt']) {
    const v = e?.[k];
    if (v === undefined || v === null) continue;
    return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x.trim());
  }
  return [];
}

// ---------- peer state ----------

export async function getPeer(userId: number, email: string): Promise<PeerState | null> {
  return one<PeerState>('SELECT email, last_seen, autocrypt_timestamp, public_key, fingerprint, prefer_encrypt, gossip_timestamp, gossip_key, gossip_fingerprint FROM autocrypt_peers WHERE user_id=$1 AND email=$2', [userId, email.toLowerCase()]);
}

export async function listPeers(userId: number, limit = 200): Promise<PeerState[]> {
  return query<PeerState>('SELECT email, last_seen, autocrypt_timestamp, public_key, fingerprint, prefer_encrypt, gossip_timestamp, gossip_key, gossip_fingerprint FROM autocrypt_peers WHERE user_id=$1 ORDER BY last_seen DESC NULLS LAST LIMIT $2', [userId, limit]);
}

export async function forgetPeer(userId: number, email: string): Promise<void> {
  await query('DELETE FROM autocrypt_peers WHERE user_id=$1 AND email=$2', [userId, email.toLowerCase()]);
}

// §7.1.1. Called for every inbound message; `headers` is whatever the
// message carried under Autocrypt (zero, one or several values). Only a
// header whose addr matches the From address counts, and exactly one must.
export async function updatePeerFromMessage(userId: number, fromEmail: string, headers: string[] | string | null | undefined, effectiveDate: Date): Promise<'updated' | 'seen' | 'ignored'> {
  const from = fromEmail.trim().toLowerCase();
  if (!from.includes('@')) return 'ignored';
  const now = Date.now();
  const effective = new Date(Math.min(effectiveDate.getTime() || now, now));
  const list = (Array.isArray(headers) ? headers : headers ? [headers] : []).map((h) => String(h));
  const matching = list.map(parseAutocryptHeader).filter((h): h is AutocryptHeader => Boolean(h) && h!.addr === from);
  const header = matching.length === 1 ? matching[0] : null;
  const parsed = header ? await readKeydata(header.keydata) : null;
  if (!parsed) {
    await query(
      `INSERT INTO autocrypt_peers (user_id, email, last_seen) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, email) DO UPDATE SET last_seen = GREATEST(COALESCE(autocrypt_peers.last_seen, to_timestamp(0)), EXCLUDED.last_seen), updated_at=now()`,
      [userId, from, effective],
    );
    return 'seen';
  }
  const r = await query<{ changed: boolean }>(
    `INSERT INTO autocrypt_peers (user_id, email, last_seen, autocrypt_timestamp, public_key, fingerprint, prefer_encrypt)
     VALUES ($1,$2,$3,$3,$4,$5,$6)
     ON CONFLICT (user_id, email) DO UPDATE SET
       last_seen = GREATEST(COALESCE(autocrypt_peers.last_seen, to_timestamp(0)), EXCLUDED.last_seen),
       autocrypt_timestamp = CASE WHEN autocrypt_peers.autocrypt_timestamp IS NULL OR EXCLUDED.autocrypt_timestamp > autocrypt_peers.autocrypt_timestamp THEN EXCLUDED.autocrypt_timestamp ELSE autocrypt_peers.autocrypt_timestamp END,
       public_key = CASE WHEN autocrypt_peers.autocrypt_timestamp IS NULL OR EXCLUDED.autocrypt_timestamp > autocrypt_peers.autocrypt_timestamp THEN EXCLUDED.public_key ELSE autocrypt_peers.public_key END,
       fingerprint = CASE WHEN autocrypt_peers.autocrypt_timestamp IS NULL OR EXCLUDED.autocrypt_timestamp > autocrypt_peers.autocrypt_timestamp THEN EXCLUDED.fingerprint ELSE autocrypt_peers.fingerprint END,
       prefer_encrypt = CASE WHEN autocrypt_peers.autocrypt_timestamp IS NULL OR EXCLUDED.autocrypt_timestamp > autocrypt_peers.autocrypt_timestamp THEN EXCLUDED.prefer_encrypt ELSE autocrypt_peers.prefer_encrypt END,
       updated_at = now()
     RETURNING (autocrypt_timestamp = $3) AS changed`,
    [userId, from, effective, parsed.armored, parsed.fingerprint, header!.preferEncrypt],
  );
  return r[0]?.changed ? 'updated' : 'seen';
}

// §7.1.2. Gossip headers travel inside the encrypted part, so the browser
// hands them over after decrypting; only addresses the message was sent to
// are believed.
export async function updateGossip(userId: number, recipients: string[], headers: string[], effectiveDate: Date): Promise<number> {
  const allowed = new Set(recipients.map((r) => r.toLowerCase()));
  const now = Date.now();
  const effective = new Date(Math.min(effectiveDate.getTime() || now, now));
  let n = 0;
  for (const raw of headers.slice(0, 50)) {
    const h = parseAutocryptHeader(raw);
    if (!h || !allowed.has(h.addr)) continue;
    const parsed = await readKeydata(h.keydata);
    if (!parsed) continue;
    await query(
      `INSERT INTO autocrypt_peers (user_id, email, gossip_timestamp, gossip_key, gossip_fingerprint) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, email) DO UPDATE SET
         gossip_key = CASE WHEN autocrypt_peers.gossip_timestamp IS NULL OR EXCLUDED.gossip_timestamp > autocrypt_peers.gossip_timestamp THEN EXCLUDED.gossip_key ELSE autocrypt_peers.gossip_key END,
         gossip_fingerprint = CASE WHEN autocrypt_peers.gossip_timestamp IS NULL OR EXCLUDED.gossip_timestamp > autocrypt_peers.gossip_timestamp THEN EXCLUDED.gossip_fingerprint ELSE autocrypt_peers.gossip_fingerprint END,
         gossip_timestamp = GREATEST(COALESCE(autocrypt_peers.gossip_timestamp, to_timestamp(0)), EXCLUDED.gossip_timestamp),
         updated_at = now()`,
      [userId, h.addr, effective, parsed.armored, parsed.fingerprint],
    );
    n++;
  }
  return n;
}

// §7.2.3. What the composer should do for one recipient.
export function recommend(peer: PeerState | null, ownPrefer: PreferEncrypt, replyingToEncrypted = false): { recommendation: Recommendation; key: string | null; fingerprint: string | null; source: 'autocrypt' | 'autocrypt-gossip' | null } {
  if (!peer) return { recommendation: 'disable', key: null, fingerprint: null, source: null };
  const usable = peer.public_key ? { key: peer.public_key, fingerprint: peer.fingerprint, source: 'autocrypt' as const } : peer.gossip_key ? { key: peer.gossip_key, fingerprint: peer.gossip_fingerprint, source: 'autocrypt-gossip' as const } : null;
  if (!usable) return { recommendation: 'disable', key: null, fingerprint: null, source: null };
  let rec: Recommendation = 'available';
  if (usable.source === 'autocrypt-gossip') rec = 'discourage';
  else if (peer.last_seen && peer.autocrypt_timestamp && peer.last_seen.getTime() - peer.autocrypt_timestamp.getTime() > STALE_MS) rec = 'discourage';
  if (rec === 'available' && ((peer.prefer_encrypt === 'mutual' && ownPrefer === 'mutual') || replyingToEncrypted)) rec = 'encrypt';
  if (rec === 'discourage' && replyingToEncrypted) rec = 'encrypt';
  return { recommendation: rec, key: usable.key, fingerprint: usable.fingerprint, source: usable.source };
}

export function isStale(peer: PeerState): boolean {
  return Boolean(peer.last_seen && peer.autocrypt_timestamp && peer.last_seen.getTime() - peer.autocrypt_timestamp.getTime() > STALE_MS);
}
