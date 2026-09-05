import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { BUILTIN_FIELDS, FILTERS, contactContext, listFields, renderHtml, renderText, validateTemplate } from '../services/merge.js';
import { getUserAccount } from '../services/accounts.js';
import { LIBRARY, LIBRARY_CATEGORIES } from '../services/templateLibrary.js';
import { composeAndSend } from '../services/compose.js';

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

const base = {
  name: z.string().min(1).max(200), subject: z.string().max(998), body_html: z.string().max(500000), category: z.string().max(60), ai_brief: z.string().max(20000),
  description: z.string().max(500), include_signature: z.boolean(), starred: z.boolean(),
};
const createSchema = z.object({ ...base, subject: base.subject.default(''), body_html: base.body_html.default(''), category: base.category.default('outreach'), ai_brief: base.ai_brief.default(''), description: base.description.default(''), include_signature: base.include_signature.default(true), starred: base.starred.default(false) });
const updateSchema = z.object(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])) as any) as z.ZodType<Partial<z.infer<typeof createSchema>>>;

const SAMPLE = { id: 0, email: 'jane.doe@example.com', first_name: 'Jane', last_name: 'Doe', company: 'Example Co', title: 'Head of Operations', phone: '+1 555 0100', website: 'example.com', timezone: null, fields: { city: 'Lisbon', plan: 'Growth' } };

function shape(t: any) {
  return { ...t, fields: listFields(`${t.subject} ${t.body_html}`), errors: validateTemplate(`${t.subject}\n${t.body_html}`) };
}

templatesRouter.get('/', async (req, res) => {
  const rows = await query<any>(
    `SELECT t.*, (SELECT count(*)::int FROM sequence_steps s WHERE s.template_id=t.id) AS used_in_steps,
            (SELECT count(*)::int FROM send_log l WHERE l.template_id=t.id AND l.status='sent') AS sent_count
     FROM templates t WHERE t.user_id=$1 ORDER BY t.starred DESC, t.updated_at DESC`,
    [req.user!.id],
  );
  res.json({ templates: rows.map(shape), categories: [...new Set([...rows.map((r) => r.category), ...LIBRARY_CATEGORIES])] });
});

templatesRouter.get('/help', (_req, res) => {
  res.json({ fields: BUILTIN_FIELDS, filters: Object.keys(FILTERS), syntax: { fallback: '{{first_name|there}}', filter: '{{company:possessive}} team', block: '{{#if company}}at {{company}}{{/if}}', unless: '{{#unless phone}}What number works?{{/unless}}', variation: '{Hi|Hello|Hey} {{first_name}}' } });
});

templatesRouter.get('/library', (_req, res) => {
  res.json({ templates: LIBRARY.map((t) => ({ ...t, fields: listFields(`${t.subject} ${t.body_html}`) })), categories: LIBRARY_CATEGORIES });
});

templatesRouter.post('/library', async (req, res) => {
  const { keys } = parse(z.object({ keys: z.array(z.string()).min(1).max(100) }), req.body);
  const existing = new Set((await query<{ library_key: string }>('SELECT library_key FROM templates WHERE user_id=$1 AND library_key IS NOT NULL', [req.user!.id])).map((r) => r.library_key));
  let added = 0, skipped = 0;
  for (const key of keys) {
    const t = LIBRARY.find((x) => x.key === key);
    if (!t) continue;
    if (existing.has(key)) { skipped++; continue; }
    await query('INSERT INTO templates (user_id, name, subject, body_html, category, ai_brief, description, library_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.user!.id, t.name, t.subject, t.body_html, t.category, t.ai_brief, t.description, t.key]);
    added++;
  }
  res.json({ ok: true, added, skipped });
});

templatesRouter.get('/export', async (req, res) => {
  const rows = await query<any>('SELECT name, subject, body_html, category, ai_brief, description, include_signature FROM templates WHERE user_id=$1 ORDER BY id', [req.user!.id]);
  res.setHeader('Content-Disposition', 'attachment; filename="tern-templates.json"');
  res.json({ version: 1, exportedAt: new Date().toISOString(), templates: rows });
});

templatesRouter.post('/import', async (req, res) => {
  const b = parse(z.object({ templates: z.array(z.object({ name: z.string().min(1).max(200), subject: z.string().max(998).default(''), body_html: z.string().max(500000).default(''), category: z.string().max(60).default('outreach'), ai_brief: z.string().max(20000).default(''), description: z.string().max(500).default(''), include_signature: z.boolean().default(true) })).min(1).max(500) }), req.body);
  for (const t of b.templates) await query('INSERT INTO templates (user_id, name, subject, body_html, category, ai_brief, description, include_signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.user!.id, t.name, t.subject, t.body_html, t.category, t.ai_brief, t.description, t.include_signature]);
  res.json({ ok: true, imported: b.templates.length });
});

templatesRouter.post('/', async (req, res) => {
  const b = parse(createSchema, req.body);
  const rows = await query<any>('INSERT INTO templates (user_id, name, subject, body_html, category, ai_brief, description, include_signature, starred) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.user!.id, b.name, b.subject, b.body_html, b.category, b.ai_brief, b.description, b.include_signature, b.starred]);
  res.json({ template: shape(rows[0]) });
});

templatesRouter.put('/:id', async (req, res) => {
  const b = parse(updateSchema, req.body);
  const rows = await query<any>(
    `UPDATE templates SET name=COALESCE($3,name), subject=COALESCE($4,subject), body_html=COALESCE($5,body_html), category=COALESCE($6,category), ai_brief=COALESCE($7,ai_brief),
       description=COALESCE($8,description), include_signature=COALESCE($9,include_signature), starred=COALESCE($10,starred), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
    [idParam(req.params.id), req.user!.id, b.name ?? null, b.subject ?? null, b.body_html ?? null, b.category ?? null, b.ai_brief ?? null, b.description ?? null, b.include_signature ?? null, b.starred ?? null],
  );
  if (!rows.length) throw notFound('Template not found');
  res.json({ template: shape(rows[0]) });
});

templatesRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM templates WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

templatesRouter.post('/:id/duplicate', async (req, res) => {
  const rows = await query<any>(`INSERT INTO templates (user_id, name, subject, body_html, category, ai_brief, description, include_signature) SELECT user_id, name || ' (copy)', subject, body_html, category, ai_brief, description, include_signature FROM templates WHERE id=$1 AND user_id=$2 RETURNING *`, [idParam(req.params.id), req.user!.id]);
  if (!rows.length) throw notFound('Template not found');
  res.json({ template: shape(rows[0]) });
});

// Render with a real contact (by id or address) or a sample, so merge fields,
// conditionals and variations can be checked before anything is sent. A seed
// keeps the variation stable between previews; "shuffle" passes a new one.
templatesRouter.post('/preview', async (req, res) => {
  const b = parse(z.object({ subject: z.string().default(''), body_html: z.string().default(''), contactId: z.number().int().nullable().optional(), contactEmail: z.string().max(320).nullable().optional(), accountId: z.number().int().nullable().optional(), seed: z.number().int().optional() }), req.body);
  const contact = b.contactId
    ? await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [b.contactId, req.user!.id])
    : b.contactEmail ? await one<any>('SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=lower($2)', [req.user!.id, b.contactEmail]) : null;
  const acc = b.accountId ? await getUserAccount(req.user!.id, b.accountId) : null;
  const sample = contact ?? (b.contactEmail ? { ...SAMPLE, email: b.contactEmail, first_name: '', last_name: '', company: '', title: '', fields: {} } : SAMPLE);
  const senderName = acc?.name ?? req.user!.display_name;
  const ctx = contactContext(sample, { sender_name: senderName, sender_email: acc?.email ?? '', sender_first_name: senderName.split(' ')[0], sender_company: '', sender_tz: acc?.send_window?.tz, unsubscribe_url: '#unsubscribe' });
  const used = listFields(`${b.subject} ${b.body_html}`);
  res.json({
    subject: renderText(b.subject, ctx, b.seed), html: renderHtml(b.body_html, ctx, b.seed),
    fields: used, missing: used.filter((f) => ctx[f] === undefined), errors: validateTemplate(`${b.subject}\n${b.body_html}`),
    contact: contact ? { id: contact.id, email: contact.email, name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') } : null, sample: !contact,
  });
});

// Send the rendered template to yourself from one of your accounts.
templatesRouter.post('/:id/test-send', async (req, res) => {
  const id = idParam(req.params.id);
  const t = await one<any>('SELECT * FROM templates WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  if (!t) throw notFound('Template not found');
  const b = parse(z.object({ accountId: z.number().int(), contactId: z.number().int().nullable().optional() }), req.body);
  const acc = await getUserAccount(req.user!.id, b.accountId);
  if (!acc) throw badRequest('Account not found');
  const contact = b.contactId ? await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [b.contactId, req.user!.id]) : null;
  const ctx = contactContext(contact ?? SAMPLE, { sender_name: acc.name, sender_email: acc.email, sender_first_name: acc.name.split(' ')[0], sender_tz: acc.send_window?.tz, unsubscribe_url: '#unsubscribe' });
  const { outcome } = await composeAndSend(acc, { to: [{ name: acc.name, email: acc.email }], subject: `[Test] ${renderText(t.subject, ctx) || t.name}`, html: renderHtml(t.body_html, ctx), kind: 'compose', includeSignature: t.include_signature !== false, templateId: t.id });
  res.json({ ok: true, messageId: outcome.messageId });
});
