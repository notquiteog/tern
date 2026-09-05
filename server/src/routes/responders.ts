import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { getUserAccount, listAccounts } from '../services/accounts.js';
import { generateResponderReply } from '../workers/scheduler.js';
import { isListMail } from '../services/automation.js';

export const respondersRouter = Router();
respondersRouter.use(requireAuth);

const condition = z.object({ field: z.enum(['from', 'to', 'cc', 'subject', 'body', 'any', 'has_attachment', 'list']), op: z.enum(['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'matches', 'is_true', 'is_false']), value: z.string().max(500).optional() });
const schema = z.object({
  name: z.string().min(1).max(200),
  account_id: z.number().int().nullable().optional(),
  enabled: z.boolean().default(true),
  mode: z.enum(['draft', 'review', 'send']).default('draft'),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(condition).max(20).default([]),
  only_contacts: z.boolean().default(false),
  skip_lists: z.boolean().default(true),
  instructions: z.string().max(5000).default(''),
  tone: z.string().max(60).default('friendly'),
  length: z.enum(['short', 'medium', 'long']).default('medium'),
  reply_all: z.boolean().default(false),
  humanize: z.boolean().default(true),
  daily_cap: z.number().int().min(1).max(500).default(20),
  cooldown_hours: z.number().int().min(1).max(720).default(24),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(), account_id: z.number().int().nullable().optional(), enabled: z.boolean().optional(), mode: z.enum(['draft', 'review', 'send']).optional(),
  match: z.enum(['all', 'any']).optional(), conditions: z.array(condition).max(20).optional(), only_contacts: z.boolean().optional(), skip_lists: z.boolean().optional(),
  instructions: z.string().max(5000).optional(), tone: z.string().max(60).optional(), length: z.enum(['short', 'medium', 'long']).optional(), reply_all: z.boolean().optional(),
  humanize: z.boolean().optional(), daily_cap: z.number().int().min(1).max(500).optional(), cooldown_hours: z.number().int().min(1).max(720).optional(),
});

respondersRouter.get('/', async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*, a.email AS account_email,
       (SELECT count(*)::int FROM send_log l WHERE l.responder_id=r.id AND l.status='sent') AS sent_count,
       (SELECT count(*)::int FROM drafts d WHERE d.responder_id=r.id) AS draft_count,
       (SELECT count(*)::int FROM review_queue q WHERE q.responder_id=r.id AND q.status='pending') AS pending_count
     FROM responders r LEFT JOIN accounts a ON a.id=r.account_id WHERE r.user_id=$1 ORDER BY r.position, r.id`,
    [req.user!.id],
  );
  const jobs = await query<any>(`SELECT id, status, error, result, created_at, payload->>'responderId' AS responder_id FROM ai_jobs WHERE user_id=$1 AND kind='responder' ORDER BY id DESC LIMIT 30`, [req.user!.id]);
  res.json({ responders: rows, jobs });
});

respondersRouter.post('/', async (req, res) => {
  const b = parse(schema, req.body);
  if (b.account_id && !(await getUserAccount(req.user!.id, b.account_id))) throw badRequest('Account not found');
  const pos = await one<{ n: number }>('SELECT coalesce(max(position),0)+1 AS n FROM responders WHERE user_id=$1', [req.user!.id]);
  const rows = await query<any>(
    `INSERT INTO responders (user_id, account_id, name, enabled, mode, match, conditions, only_contacts, skip_lists, instructions, tone, length, reply_all, humanize, daily_cap, cooldown_hours, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [req.user!.id, b.account_id ?? null, b.name, b.enabled, b.mode, b.match, JSON.stringify(b.conditions), b.only_contacts, b.skip_lists, b.instructions, b.tone, b.length, b.reply_all, b.humanize, b.daily_cap, b.cooldown_hours, pos?.n ?? 0],
  );
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'responders.created',$2,$3)`, [req.user!.id, String(rows[0].id), JSON.stringify({ mode: b.mode, name: b.name })]);
  res.json({ responder: rows[0] });
});

respondersRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(updateSchema, req.body);
  const rows = await query<any>(
    `UPDATE responders SET name=COALESCE($3,name), account_id=CASE WHEN $4::boolean THEN $5 ELSE account_id END, enabled=COALESCE($6,enabled), mode=COALESCE($7,mode), match=COALESCE($8,match),
       conditions=COALESCE($9,conditions), only_contacts=COALESCE($10,only_contacts), skip_lists=COALESCE($11,skip_lists), instructions=COALESCE($12,instructions), tone=COALESCE($13,tone), length=COALESCE($14,length),
       reply_all=COALESCE($15,reply_all), humanize=COALESCE($16,humanize), daily_cap=COALESCE($17,daily_cap), cooldown_hours=COALESCE($18,cooldown_hours), updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, req.user!.id, b.name ?? null, b.account_id !== undefined, b.account_id ?? null, b.enabled ?? null, b.mode ?? null, b.match ?? null, b.conditions ? JSON.stringify(b.conditions) : null, b.only_contacts ?? null, b.skip_lists ?? null, b.instructions ?? null, b.tone ?? null, b.length ?? null, b.reply_all ?? null, b.humanize ?? null, b.daily_cap ?? null, b.cooldown_hours ?? null],
  );
  if (!rows.length) throw notFound('Responder not found');
  if (b.mode === 'send') await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'responders.auto_send_enabled',$2,'{}')`, [req.user!.id, String(id)]);
  res.json({ responder: rows[0] });
});

respondersRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM responders WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

// Dry run: generate what the responder would say to a real message, without
// filing or sending anything.
respondersRouter.post('/:id/test', async (req, res) => {
  const id = idParam(req.params.id);
  const responder = await one<any>('SELECT * FROM responders WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  if (!responder) throw notFound('Responder not found');
  const b = parse(z.object({ emailId: z.number().int().optional() }), req.body ?? {});
  const accounts = responder.account_id ? [await getUserAccount(req.user!.id, responder.account_id)] : await listAccounts(req.user!.id);
  const accIds = accounts.filter(Boolean).map((a) => a!.id);
  const email = b.emailId
    ? await one<any>('SELECT * FROM emails WHERE id=$1 AND account_id = ANY($2)', [b.emailId, accIds])
    : await one<any>(`SELECT e.* FROM emails e WHERE e.account_id = ANY($1) AND e.from_email <> ALL($2) ORDER BY e.received_at DESC LIMIT 1`, [accIds, accounts.map((a) => a!.email.toLowerCase())]);
  if (!email) throw badRequest('No inbound message to test with yet');
  const acc = accounts.find((a) => a!.id === email.account_id)!;
  const skipped = responder.skip_lists && isListMail({ from: email.from_addr, 'header:List-Unsubscribe:asText': null });
  const gen = await generateResponderReply(responder, acc!, email);
  res.json({ email: { id: email.id, subject: email.subject, from: email.from_addr, preview: email.preview, received_at: email.received_at }, wouldSkipAsList: skipped, subject: gen.subject, text: gen.text, to: gen.to, model: gen.model });
});
