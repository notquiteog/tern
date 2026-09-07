// Meaning search, priority ordering and the impersonation guard, as HTTP.
//
// Everything here is scoped to the signed-in person's own accounts by the
// service beneath it, gated by a capability, and — for the parts that cost
// the model real time — priced in proof of work rather than refused by a
// counter. See services/workGuard.ts for why that is the throttle.
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { parse, z, idParam } from '../util/validate.js';
import { notFound } from '../errors.js';
import { requireCapability } from '../services/capabilities.js';
import { powGuard } from '../services/workGuard.js';
import { rateLimit } from '../util/rateLimit.js';
import { listAccounts } from '../services/accounts.js';
import { semanticSearch, similarTo, indexPending } from '../services/semantic.js';
import { explain, featuresOf, loadModel, retrain } from '../services/triage.js';
import { describe as describeGuard, guardFor } from '../services/guard.js';
import { enrichmentStatus } from '../workers/enrichment.js';
import { textFor } from '../services/attachments.js';
import { openEmails } from '../services/mailVault.js';

export const discoverRouter = Router();
discoverRouter.use(requireAuth);

// How much of each index is still being built, for the settings pages and
// for the banner that says "meaning search is still reading your mail".
discoverRouter.get('/status', async (req, res) => {
  const model = await loadModel(req.user!.id);
  res.json({
    pending: await enrichmentStatus(req.user!.id),
    triage: model ? { samples: model.samples, accuracy: model.accuracy } : null,
  });
});

// ---------- F1 ----------

discoverRouter.post(
  '/search',
  requireCapability('semantic'),
  powGuard('search'),
  rateLimit({ name: 'semantic-search', perMinute: 40, message: 'Too many searches at once; wait a moment' }),
  async (req, res) => {
    const b = parse(z.object({
      q: z.string().min(2).max(500),
      accountId: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).default(40),
    }), req.body);
    const accounts = (await listAccounts(req.user!.id)).filter((a) => a.enabled);
    const ids = b.accountId ? accounts.filter((a) => a.id === b.accountId).map((a) => a.id) : accounts.map((a) => a.id);
    const hits = await semanticSearch(req.user!.id, ids, b.q, { limit: b.limit });
    res.json({ hits: await describeHits(req.user!.id, hits), remaining: await indexPending(req.user!.id) });
  },
);

discoverRouter.get('/similar/:id', requireCapability('semantic'), async (req, res) => {
  res.json({ hits: await describeHits(req.user!.id, await similarTo(req.user!.id, idParam(req.params.id))) });
});

// A hit is an id and a score, which is not something anybody can read. This
// turns it into a row: who it is from, what it is about, and when. The
// reader is 'owner' because this is the person looking at their own mail —
// the capability that had to be granted was the one that built the index.
async function describeHits(userId: number, hits: { emailId: number; accountId: number; threadId: string; score: number }[]) {
  if (!hits.length) return [];
  const rows = await query<any>(
    `SELECT e.id, e.subject, e.preview, e.from_addr, e.received_at, e.has_attachment
       FROM emails e JOIN accounts a ON a.id = e.account_id
      WHERE e.id = ANY($1) AND a.user_id = $2`,
    [hits.map((h) => h.emailId), userId],
  );
  const opened = await openEmails(userId, 'owner', rows);
  const byId = new Map(opened.map((m: any) => [m.id, m]));
  return hits.map((h) => {
    const m: any = byId.get(h.emailId);
    return {
      ...h,
      subject: m?.subject ?? '',
      preview: (m?.preview ?? '').slice(0, 160),
      from: m?.from_addr?.[0] ? { name: m.from_addr[0].name ?? null, email: m.from_addr[0].email } : null,
      receivedAt: m?.received_at ? new Date(m.received_at).toISOString() : null,
      hasAttachment: Boolean(m?.has_attachment),
    };
  }).filter((h) => h.subject || h.preview);
}

// ---------- F2 ----------

discoverRouter.post('/triage/retrain', requireCapability('triage'), powGuard('index'), async (req, res) => {
  res.json(await retrain(req.user!.id));
});

// Why a message is where it is. Hashed terms cannot be turned back into
// words, so this answers from the plain signals and says so.
discoverRouter.get('/triage/why/:id', requireCapability('triage'), async (req, res) => {
  const id = idParam(req.params.id);
  const row = await one<any>(
    `SELECT e.search_terms, e.has_attachment, e.auto_submitted, e.received_at, e.list_id, e.priority,
            coalesce(e.recipient_count,1) AS to_count, e.from_blind, e.account_id, e.thread_id
       FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE e.id=$1 AND a.user_id=$2`,
    [id, req.user!.id],
  );
  if (!row) throw notFound('Message not found');
  const model = await loadModel(req.user!.id);
  if (!model) { res.json({ priority: row.priority, reasons: [], note: 'Priority ordering has not learned anything yet.' }); return; }
  const contacts = await query<{ email_blind: Buffer }>(
    'SELECT email_blind FROM contacts WHERE user_id=$1 AND email_blind IS NOT NULL', [req.user!.id],
  );
  const known = new Set(contacts.map((c) => c.email_blind.toString('hex')));
  const features = featuresOf({ ...row, from_contact: Boolean(row.from_blind && known.has(row.from_blind.toString('hex'))) });
  res.json({
    priority: row.priority,
    reasons: explain(model, features),
    note: 'Learned from what you have archived, starred, replied to and junked. The words themselves are hashed and cannot be shown.',
  });
});

// ---------- F3 ----------

// The banner above a message. Returned separately from the message itself so
// a mailbox with the guard turned off never pays for the join.
discoverRouter.get('/guard/:id', requireCapability('guard'), async (req, res) => {
  const found = await guardFor(req.user!.id, idParam(req.params.id));
  if (!found) throw notFound('Message not found');
  const { flags, detail } = found;
  res.json({ flags, detail, message: describeGuard(flags, detail), firstContact: flags.includes('first_contact') });
});

// ---------- F5 ----------

discoverRouter.get('/attachments/:id', requireCapability('attachments'), async (req, res) => {
  res.json({ parts: await textFor(req.user!.id, idParam(req.params.id)) });
});
