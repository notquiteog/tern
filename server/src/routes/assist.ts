// The brief, commitments, plain-English rules, invitations, dictation and
// importing an archive.
//
// Every route that costs the model real time carries a proof of work as well
// as its capability: the model is a shared resource with a fixed number of
// slots, so the throttle has to scale with contention rather than refuse at
// a fixed count. The cheap ones (reading a stored brief, listing
// commitments) carry neither, because they are ordinary reads.
import { Router, raw } from 'express';
import { requireAuth } from '../auth.js';
import { parse, z, idParam } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { rateLimit } from '../util/rateLimit.js';
import { requireCapability } from '../services/capabilities.js';
import { powGuard } from '../services/workGuard.js';
import { getUserAccount } from '../services/accounts.js';
import { generateBrief, getBrief } from '../services/brief.js';
import { addCommitment, closeCommitment, listCommitments, moveCommitment, openCount } from '../services/commitments.js';
import { draftRule, draftSearch } from '../services/nlRules.js';
import { buildReply, freeSlots, getInvitation, invitationsFor, recordReply, upcoming } from '../services/calendarMail.js';
import { MAX_AUDIO_BYTES, AUDIO_TYPES, transcribe, voiceConfigured } from '../services/voice.js';
import { cancelImport, progress, runImport, startImport } from '../services/mailImport.js';
import { MAX_MESSAGE_BYTES } from '../services/mbox.js';

export const assistRouter = Router();
assistRouter.use(requireAuth);

// ---------- F8: the brief ----------

// Reading the stored one is free and never generates. A page that quietly
// spent a minute of model time because somebody opened it would be
// unusable on the box this runs on.
assistRouter.get('/brief', requireCapability('brief'), async (req, res) => {
  res.json({ brief: await getBrief(req.user!.id) });
});

assistRouter.post(
  '/brief',
  requireCapability('brief'),
  powGuard('brief'),
  rateLimit({ name: 'brief', perMinute: 4, message: 'A brief is still being written; give it a moment' }),
  async (req, res) => {
    res.json({ brief: await generateBrief(req.user!.id) });
  },
);

// ---------- F6: commitments ----------

assistRouter.get('/commitments', requireCapability('commitments'), async (req, res) => {
  const status = req.query.status === 'all' ? 'all' : 'open';
  res.json({ commitments: await listCommitments(req.user!.id, status), counts: await openCount(req.user!.id) });
});

assistRouter.post('/commitments', requireCapability('commitments'), async (req, res) => {
  const b = parse(z.object({
    accountId: z.number().int(),
    threadId: z.string().max(200).optional(),
    kind: z.enum(['owed', 'awaiting']),
    text: z.string().min(3).max(200),
    counterparty: z.string().max(120).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
  }), req.body);
  if (!(await getUserAccount(req.user!.id, b.accountId))) throw notFound('Account not found');
  res.json({ id: await addCommitment(req.user!.id, b) });
});

// Moving one, which is what "reschedule" and "nudge" both do to the ledger.
//
// The draft itself is written by /api/ai/draft; this is only the bookkeeping,
// and it is deliberately a separate call made when the mail is actually
// handed to the composer. Generating a draft you then abandon should not move
// a date in the ledger.
assistRouter.post('/commitments/:id/move', requireCapability('commitments'), async (req, res) => {
  const b = parse(z.object({ dueAt: z.string().datetime().nullable().optional() }), req.body);
  const moved = await moveCommitment(req.user!.id, idParam(req.params.id), b.dueAt);
  if (!moved) throw notFound('Commitment not found, or already closed');
  res.json({ commitment: moved });
});

assistRouter.post('/commitments/:id/close', requireCapability('commitments'), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['done', 'dropped']) }), req.body);
  if (!(await closeCommitment(req.user!.id, idParam(req.params.id), status))) throw notFound('That is not an open commitment');
  res.json({ ok: true });
});

// ---------- F7: plain English ----------

assistRouter.post(
  '/rule',
  requireCapability('nlrules'),
  powGuard('ai'),
  rateLimit({ name: 'nl-rule', perMinute: 20 }),
  async (req, res) => {
    const { text } = parse(z.object({ text: z.string().min(4).max(500) }), req.body);
    // A draft, not a rule. It is returned for the editor to show; saving it
    // is a separate, ordinary request to /api/rules.
    res.json({ draft: await draftRule(req.user!.id, text) });
  },
);

assistRouter.post(
  '/search-query',
  requireCapability('nlrules'),
  powGuard('ai'),
  rateLimit({ name: 'nl-search', perMinute: 30 }),
  async (req, res) => {
    const { text } = parse(z.object({ text: z.string().min(3).max(300) }), req.body);
    res.json({ query: await draftSearch(req.user!.id, text) });
  },
);

// ---------- F10: invitations ----------

assistRouter.get('/invitations', requireCapability('calendar'), async (req, res) => {
  const days = Math.min(180, Math.max(1, Number(req.query.days ?? 30)));
  res.json({ invitations: await upcoming(req.user!.id, days) });
});

assistRouter.get('/invitations/message/:id', requireCapability('calendar'), async (req, res) => {
  res.json({ invitations: await invitationsFor(req.user!.id, idParam(req.params.id)) });
});

// Times to offer somebody, worked out from the calendar and never from the
// model. The zone comes from the browser because "nine in the morning" is a
// fact about where the person is sitting, and the server has no way to know
// that: no IP is stored, and the account's send window is about when mail may
// leave rather than when its owner is awake.
assistRouter.get('/invitations/slots', requireCapability('calendar'), async (req, res) => {
  const num = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  res.json({
    slots: await freeSlots(req.user!.id, {
      minutes: num(req.query.minutes, 30),
      days: num(req.query.days, 10),
      count: num(req.query.count, 6),
      startHour: num(req.query.startHour, 9),
      endHour: num(req.query.endHour, 17),
      tz: typeof req.query.tz === 'string' ? req.query.tz.slice(0, 64) : undefined,
    }),
  });
});

// Records the answer and hands back the REPLY body. Sending it is the
// composer's job, through the ordinary send path, so an invitation reply
// goes out under the same rules, pacing and signature as any other message.
assistRouter.post('/invitations/:id/reply', requireCapability('calendar'), async (req, res) => {
  const { reply } = parse(z.object({ reply: z.enum(['accepted', 'declined', 'tentative']) }), req.body);
  const inv = await getInvitation(req.user!.id, idParam(req.params.id));
  if (!inv) throw notFound('Invitation not found');
  const acc = await getUserAccount(req.user!.id, inv.accountId);
  if (!acc) throw notFound('Account not found');
  const updated = await recordReply(req.user!.id, inv.id, reply);
  const partstat = reply === 'accepted' ? 'ACCEPTED' : reply === 'declined' ? 'DECLINED' : 'TENTATIVE';
  res.json({
    invitation: updated,
    ics: buildReply(inv, { email: acc.email, name: acc.name }, partstat),
    to: inv.organizer ? [inv.organizer] : [],
    subject: `${reply === 'accepted' ? 'Accepted' : reply === 'declined' ? 'Declined' : 'Tentative'}: ${inv.summary ?? 'Invitation'}`,
  });
});

// ---------- F9: dictation ----------

assistRouter.get('/voice', async (_req, res) => {
  res.json({ configured: await voiceConfigured(), maxBytes: MAX_AUDIO_BYTES, types: AUDIO_TYPES });
});

// The clip arrives as the request body with its own content type — no
// multipart, no temporary file, nothing written down. It exists as one
// Buffer, which services/voice.ts zeroes before returning.
assistRouter.post(
  '/voice',
  requireCapability('voice'),
  powGuard('voice'),
  rateLimit({ name: 'voice', perMinute: 20, message: 'Too many recordings at once; wait a moment' }),
  raw({ type: [...AUDIO_TYPES], limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Send the recording as the request body with its content type');
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;
    const out = await transcribe(req.user!.id, req.body, String(req.headers['content-type'] ?? ''), { language });
    res.json(out);
  },
);

// ---------- F12: importing an archive ----------

assistRouter.get('/import/:id', requireCapability('import'), async (req, res) => {
  const p = await progress(req.user!.id, idParam(req.params.id));
  if (!p) throw notFound('Import not found');
  res.json({ import: p });
});

assistRouter.post('/import/:id/cancel', requireCapability('import'), async (req, res) => {
  res.json({ cancelled: await cancelImport(req.user!.id, idParam(req.params.id)) });
});

// The archive is held in memory and never written down, which is what makes
// "nothing is left behind" a fact rather than a promise about cleanup code.
// The price is a ceiling: this has to fit in the app container, which is
// sized for a 4.5 GB box. 256 MB is a large personal archive — a decade of
// text mail is usually well under it — and a Takeout that is bigger can be
// imported a folder at a time, which docs/CUSTOMIZING.md says.
const IMPORT_LIMIT = 256 * 1024 * 1024;

assistRouter.post(
  '/import',
  requireCapability('import'),
  powGuard('import'),
  rateLimit({ name: 'import', perMinute: 2, message: 'One import at a time' }),
  raw({ type: ['application/mbox', 'application/octet-stream', 'text/plain'], limit: IMPORT_LIMIT }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 10) throw badRequest('Send the mbox file as the request body');
    const accountId = Number(req.query.accountId);
    const acc = await getUserAccount(req.user!.id, accountId);
    if (!acc) throw notFound('Account not found');
    const filename = typeof req.query.filename === 'string' ? req.query.filename : null;

    const id = await startImport(req.user!.id, acc.id, filename);
    // The browser gets the id at once and polls; a decade of mail is not a
    // request anybody should hold open.
    res.json({ import: await progress(req.user!.id, id) });
    void runImport(req.user!.id, acc, id, req.body);
  },
);

export const MBOX_MESSAGE_LIMIT = MAX_MESSAGE_BYTES;
