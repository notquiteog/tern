// Admin → Security: recovery shares for the master key, and what the box is
// actually running.
//
// The shares are shown once and never stored. That is the entire design: an
// escrowed share would be a copy of the key with extra steps, and a key an
// admin can print on demand is a key an attacker with an admin session can
// print too. What the database keeps is how many shares exist, when they
// were made, a fingerprint per share so a recovery tool can say "that is
// share 3 again", and a check value that recognises the right key without
// being it.
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest } from '../errors.js';
import { config } from '../config.js';
import { keyMaterial } from '../crypto.js';
import { encodeShare, secretCheck, shareFingerprint, split } from '../services/shamir.js';
import { attestation, pinCurrent } from '../services/attestation.js';
import { RETENTION_BOUNDS, RETENTION_DEFAULTS, retentionFootprint, retentionSettings, saveRetentionSettings } from '../services/retentionPolicy.js';

export const vaultRouter = Router();
vaultRouter.use(requireAuth, requireAdmin);

interface RecoveryRecord {
  createdAt: string;
  n: number;
  k: number;
  check: string;
  fingerprints: string[];
  /** Who made them, for the audit trail. Never who holds them. */
  by: number;
}

vaultRouter.get('/recovery', async (_req, res) => {
  const row = await one<{ value: RecoveryRecord }>(`SELECT value FROM settings WHERE key='vault_recovery'`);
  const key = keyMaterial();
  res.json({
    // Whether the shares that exist are for the key this install is using.
    // A restored backup with a different ENCRYPTION_KEY makes them useless,
    // and saying so before somebody needs them is the whole point.
    record: row?.value
      ? { createdAt: row.value.createdAt, n: row.value.n, k: row.value.k, fingerprints: row.value.fingerprints, current: row.value.check === secretCheck(key) }
      : null,
    keyBytes: key.length,
  });
});

// Makes a fresh set. Any previous set stops being usable the moment this
// returns, because the record naming their fingerprints is replaced — the
// old shares still reconstruct the same key, so the warning matters and the
// UI says it.
vaultRouter.post('/recovery', async (req, res) => {
  const b = parse(z.object({
    shares: z.number().int().min(2).max(16),
    threshold: z.number().int().min(2).max(16),
  }), req.body);
  if (b.threshold > b.shares) throw badRequest('The threshold cannot be larger than the number of shares');

  const key = keyMaterial();
  const shares = split(key, b.shares, b.threshold);
  const printed = shares.map((s) => encodeShare(s, b.threshold));

  const record: RecoveryRecord = {
    createdAt: new Date().toISOString(),
    n: b.shares,
    k: b.threshold,
    check: secretCheck(key),
    fingerprints: shares.map(shareFingerprint),
    by: req.user!.id,
  };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('vault_recovery', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(record)],
  );
  await query(
    `INSERT INTO audit_log (user_id, action, details) VALUES ($1,'vault.recovery_created',$2)`,
    [req.user!.id, JSON.stringify({ n: b.shares, k: b.threshold })],
  );

  // The only time these exist outside this function's stack.
  res.json({
    shares: printed,
    threshold: b.threshold,
    record: { createdAt: record.createdAt, n: record.n, k: record.k, fingerprints: record.fingerprints, current: true },
    howToUse: `Keep any ${b.threshold} of these ${b.shares} in separate places. To rebuild the key: ./bin/tern recover-key`,
  });
});

vaultRouter.delete('/recovery', async (req, res) => {
  await query(`DELETE FROM settings WHERE key='vault_recovery'`);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'vault.recovery_forgotten')`, [req.user!.id]);
  res.json({ ok: true });
});

// ---------- F14 ----------

vaultRouter.get('/attestation', async (_req, res) => {
  res.json(await attestation());
});

vaultRouter.post('/attestation/pin', async (req, res) => {
  try {
    res.json({ pinned: await pinCurrent(req.user!.id) });
  } catch (e) {
    throw badRequest((e as Error).message);
  }
});

// ---------- Retention ----------

vaultRouter.get('/retention', async (_req, res) => {
  res.json({
    retention: await retentionSettings(),
    defaults: RETENTION_DEFAULTS,
    bounds: RETENTION_BOUNDS,
    holding: await retentionFootprint(),
  });
});

vaultRouter.put('/retention', async (req, res) => {
  const b = parse(z.object({
    outboxDays: z.number().int().optional(),
    reviewDays: z.number().int().optional(),
    aiJobHours: z.number().int().optional(),
    auditDays: z.number().int().optional(),
    briefDays: z.number().int().optional(),
    commitmentDays: z.number().int().optional(),
    calendarDays: z.number().int().optional(),
  }), req.body);
  const next = await saveRetentionSettings(b);
  await query(
    `INSERT INTO audit_log (user_id, action, details) VALUES ($1,'retention.changed',$2)`,
    [req.user!.id, JSON.stringify(next)],
  );
  res.json({ retention: next });
});

export const VAULT_KEY_SOURCE = config.encryptionKey ? 'environment' : 'unset';
