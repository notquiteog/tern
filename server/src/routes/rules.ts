import { Router } from 'express';
import { query, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { getUserAccount } from '../services/accounts.js';
import { runRuleOnExisting } from '../services/automation.js';
import { syncManager } from '../workers/syncManager.js';

export const rulesRouter = Router();
rulesRouter.use(requireAuth);

const condition = z.object({ field: z.enum(['from', 'to', 'cc', 'subject', 'body', 'any', 'has_attachment', 'list']), op: z.enum(['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'matches', 'is_true', 'is_false']), value: z.string().max(500).optional() });
const action = z.object({ type: z.enum(['archive', 'trash', 'spam', 'mark_read', 'star', 'unstar', 'label']), mailboxId: z.string().optional() });
const schema = z.object({ name: z.string().min(1).max(200), account_id: z.number().int().nullable().optional(), enabled: z.boolean().default(true), match: z.enum(['all', 'any']).default('all'), conditions: z.array(condition).min(1).max(20), actions: z.array(action).min(1).max(10) });

rulesRouter.get('/', async (req, res) => {
  const rows = await query<any>('SELECT r.*, a.email AS account_email FROM rules r LEFT JOIN accounts a ON a.id=r.account_id WHERE r.user_id=$1 ORDER BY r.position, r.id', [req.user!.id]);
  res.json({ rules: rows });
});

rulesRouter.post('/', async (req, res) => {
  const b = parse(schema, req.body);
  if (b.account_id && !(await getUserAccount(req.user!.id, b.account_id))) throw badRequest('Account not found');
  const pos = await one<{ n: number }>('SELECT coalesce(max(position),0)+1 AS n FROM rules WHERE user_id=$1', [req.user!.id]);
  const rows = await query<any>('INSERT INTO rules (user_id, account_id, name, enabled, match, conditions, actions, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [req.user!.id, b.account_id ?? null, b.name, b.enabled, b.match, JSON.stringify(b.conditions), JSON.stringify(b.actions), pos?.n ?? 0]);
  res.json({ rule: rows[0] });
});

rulesRouter.put('/:id', async (req, res) => {
  const b = parse(schema.partial(), req.body);
  const rows = await query<any>(
    `UPDATE rules SET name=COALESCE($3,name), account_id=CASE WHEN $4::boolean THEN $5 ELSE account_id END, enabled=COALESCE($6,enabled), match=COALESCE($7,match), conditions=COALESCE($8,conditions), actions=COALESCE($9,actions), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
    [idParam(req.params.id), req.user!.id, b.name ?? null, b.account_id !== undefined, b.account_id ?? null, b.enabled ?? null, b.match ?? null, b.conditions ? JSON.stringify(b.conditions) : null, b.actions ? JSON.stringify(b.actions) : null],
  );
  if (!rows.length) throw notFound('Rule not found');
  res.json({ rule: rows[0] });
});

rulesRouter.post('/reorder', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.number().int()) }), req.body);
  for (let i = 0; i < ids.length; i++) await query('UPDATE rules SET position=$3 WHERE id=$1 AND user_id=$2', [ids[i], req.user!.id, i]);
  res.json({ ok: true });
});

rulesRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM rules WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

rulesRouter.post('/:id/run', async (req, res) => {
  const rule = await one<any>('SELECT * FROM rules WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  if (!rule) throw notFound('Rule not found');
  const accounts = rule.account_id ? [await getUserAccount(req.user!.id, rule.account_id)] : await query<any>('SELECT * FROM accounts WHERE user_id=$1', [req.user!.id]);
  let matched = 0;
  for (const acc of accounts) {
    if (!acc) continue;
    matched += await runRuleOnExisting(acc, rule);
    syncManager.requestSync(acc.id, 1500);
  }
  res.json({ ok: true, matched });
});
