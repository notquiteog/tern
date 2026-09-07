// Settings → Features (everyone) and Admin → Features (admins).
//
// One page each, and between them every switch that decides whether anything
// reads a mailbox or reaches the model. There is nothing else: a feature that
// is not listed here does not exist as far as consent is concerned, because
// the gate it would have to pass is the same registry this page renders.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest } from '../errors.js';
import {
  CAPABILITIES, CAPABILITY_META, adminEnabled, consentedSet, featureFlags,
  grant, revoke, setFeatureFlag, type Capability,
} from '../services/capabilities.js';
import { eraseCapabilityData, capabilityFootprint } from '../services/capabilityData.js';
import { issueWork, WORK_PURPOSES, workSubject, type WorkPurpose } from '../services/workGuard.js';

export const featuresRouter = Router();
featuresRouter.use(requireAuth);

const capParam = z.enum(CAPABILITIES as unknown as [string, ...string[]]);

// What this person sees: every capability, whether the install allows it,
// whether they have turned it on, and how much of their data it is holding.
featuresRouter.get('/', async (req, res) => {
  const flags = await featureFlags();
  const mine = await consentedSet(req.user!.id);
  const admin = req.user!.role === 'admin';
  const footprint = await capabilityFootprint(req.user!.id);
  const list = CAPABILITIES
    .filter((c) => !CAPABILITY_META[c].adminOnly || admin)
    .map((c) => ({
      ...CAPABILITY_META[c],
      available: flags[c] !== false,
      granted: mine.has(c),
      holds: footprint[c] ?? 0,
    }));
  res.json({ capabilities: list });
});

featuresRouter.post('/:cap/grant', async (req, res) => {
  const cap = parse(capParam, req.params.cap) as Capability;
  const meta = CAPABILITY_META[cap];
  if (meta.adminOnly && req.user!.role !== 'admin') throw badRequest('That feature is for administrators');
  if (!(await adminEnabled(cap))) throw badRequest(`${meta.label} is turned off for this server by an administrator`);
  await grant(req.user!.id, cap);
  res.json({ ok: true, granted: true });
});

// Withdrawing consent destroys what the capability produced. It is not a
// pause: leaving an index built from mail somebody has said to stop reading
// would make the switch a lie.
featuresRouter.post('/:cap/revoke', async (req, res) => {
  const cap = parse(capParam, req.params.cap) as Capability;
  await revoke(req.user!.id, cap);
  const erased = await eraseCapabilityData(req.user!.id, cap);
  res.json({ ok: true, granted: false, erased });
});

// A challenge for one of the expensive endpoints. Issued to the session, so
// the work cannot be done once and shared.
featuresRouter.get('/work', async (req, res) => {
  const purpose = String(req.query.purpose ?? '') as WorkPurpose;
  if (!(WORK_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('Unknown purpose');
  res.json(issueWork(purpose, workSubject(req)));
});

// ---- Admin ----
export const adminFeaturesRouter = Router();
adminFeaturesRouter.use(requireAuth, requireAdmin);

adminFeaturesRouter.get('/', async (_req, res) => {
  const flags = await featureFlags();
  const counts = await query<{ capability: string; n: number }>(
    'SELECT capability, count(*)::int AS n FROM user_capabilities GROUP BY capability',
  );
  const byCap = new Map(counts.map((c) => [c.capability, c.n]));
  res.json({
    capabilities: CAPABILITIES.map((c) => ({
      ...CAPABILITY_META[c],
      enabled: flags[c] !== false,
      // How many people would notice if this were switched off now.
      users: byCap.get(c) ?? 0,
    })),
  });
});

// The switch an admin reaches for when the box is struggling. It takes effect
// on the next request and the next scheduler tick — there is no cache longer
// than five seconds in front of it — and it leaves everybody's consent alone,
// so turning it back on restores what people had already chosen.
adminFeaturesRouter.put('/:cap', async (req, res) => {
  const cap = parse(capParam, req.params.cap) as Capability;
  const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
  const flags = await setFeatureFlag(cap, enabled);
  await query(
    `INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,$2,$3,$4)`,
    [req.user!.id, enabled ? 'feature.enabled' : 'feature.disabled', cap, JSON.stringify({ label: CAPABILITY_META[cap].label })],
  );
  res.json({ flags });
});
