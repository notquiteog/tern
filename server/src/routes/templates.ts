import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { notFound } from '../errors.js';
import { contactContext, listFields, renderHtml, renderText } from '../services/merge.js';
import { getUserAccount } from '../services/accounts.js';

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

const schema = z.object({ name: z.string().min(1).max(200), subject: z.string().max(998).default(''), body_html: z.string().max(500000).default(''), category: z.string().max(60).default('outreach'), ai_brief: z.string().max(20000).default('') });

templatesRouter.get('/', async (req, res) => {
  const rows = await query<any>(`SELECT t.*, (SELECT count(*)::int FROM sequence_steps s WHERE s.template_id=t.id) AS used_in_steps FROM templates t WHERE t.user_id=$1 ORDER BY t.updated_at DESC`, [req.user!.id]);
  res.json({ templates: rows.map((t) => ({ ...t, fields: listFields(t.subject + ' ' + t.body_html) })) });
});

templatesRouter.post('/', async (req, res) => {
  const b = parse(schema, req.body);
  const rows = await query<any>('INSERT INTO templates (user_id, name, subject, body_html, category, ai_brief) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [req.user!.id, b.name, b.subject, b.body_html, b.category, b.ai_brief]);
  res.json({ template: rows[0] });
});

templatesRouter.put('/:id', async (req, res) => {
  const b = parse(schema.partial(), req.body);
  const rows = await query<any>(
    `UPDATE templates SET name=COALESCE($3,name), subject=COALESCE($4,subject), body_html=COALESCE($5,body_html), category=COALESCE($6,category), ai_brief=COALESCE($7,ai_brief), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
    [idParam(req.params.id), req.user!.id, b.name ?? null, b.subject ?? null, b.body_html ?? null, b.category ?? null, b.ai_brief ?? null],
  );
  if (!rows.length) throw notFound('Template not found');
  res.json({ template: rows[0] });
});

templatesRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM templates WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

templatesRouter.post('/:id/duplicate', async (req, res) => {
  const rows = await query<any>(`INSERT INTO templates (user_id, name, subject, body_html, category, ai_brief) SELECT user_id, name || ' (copy)', subject, body_html, category, ai_brief FROM templates WHERE id=$1 AND user_id=$2 RETURNING *`, [idParam(req.params.id), req.user!.id]);
  if (!rows.length) throw notFound('Template not found');
  res.json({ template: rows[0] });
});

// Render with a real contact (or a sample) so merge fields can be checked.
templatesRouter.post('/preview', async (req, res) => {
  const b = parse(z.object({ subject: z.string().default(''), body_html: z.string().default(''), contactId: z.number().int().nullable().optional(), accountId: z.number().int().nullable().optional() }), req.body);
  const contact = b.contactId ? await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [b.contactId, req.user!.id]) : null;
  const acc = b.accountId ? await getUserAccount(req.user!.id, b.accountId) : null;
  const sample = contact ?? { email: 'jane.doe@example.com', first_name: 'Jane', last_name: 'Doe', company: 'Example Co', title: 'Head of Operations', fields: { city: 'Lisbon' } };
  const ctx = contactContext(sample, { sender_name: acc?.name ?? req.user!.display_name, sender_email: acc?.email ?? '', sender_first_name: (acc?.name ?? req.user!.display_name).split(' ')[0], unsubscribe_url: '#unsubscribe' });
  res.json({ subject: renderText(b.subject, ctx), html: renderHtml(b.body_html, ctx), fields: listFields(b.subject + ' ' + b.body_html), missing: listFields(b.subject + ' ' + b.body_html).filter((f) => ctx[f] === undefined) });
});
