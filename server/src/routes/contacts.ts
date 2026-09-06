import { Router, text } from 'express';
import { one, query, withTx } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { guessMapping, parseCsv, toCsv } from '../util/csv.js';
import { openEmailWith } from '../services/mailVault.js';
import { dataKey } from '../services/vault.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

const contactSchema = z.object({
  email: z.string().email(),
  first_name: z.string().max(120).default(''),
  last_name: z.string().max(120).default(''),
  company: z.string().max(200).default(''),
  title: z.string().max(200).default(''),
  phone: z.string().max(60).default(''),
  website: z.string().max(300).default(''),
  fields: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string().max(60)).default([]),
  notes: z.string().max(20000).default(''),
  consent_source: z.string().max(300).default(''),
  status: z.enum(['active', 'unsubscribed', 'bounced', 'replied', 'do_not_contact']).optional(),
  timezone: z.string().max(64).nullable().optional(),
});

contactsRouter.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const tag = String(req.query.tag ?? '').trim();
  const status = String(req.query.status ?? '').trim();
  const page = Math.max(1, Number(req.query.page ?? 1));
  const size = Math.min(200, Math.max(10, Number(req.query.size ?? 50)));
  const sort = ['created_at', 'email', 'last_contacted_at', 'last_replied_at', 'company'].includes(String(req.query.sort)) ? String(req.query.sort) : 'created_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const where = ['c.user_id=$1'];
  const params: unknown[] = [req.user!.id];
  if (q) { params.push(q); where.push(`(c.search_tsv @@ websearch_to_tsquery('simple', $${params.length}) OR c.email ILIKE '%' || $${params.length} || '%')`); }
  if (tag) { params.push(tag); where.push(`$${params.length} = ANY(c.tags)`); }
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  const w = where.join(' AND ');
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${w}`, params);
  const rows = await query<any>(
    `SELECT c.id, c.user_id, c.email, c.first_name, c.last_name, c.company, c.title, c.phone, c.website, c.fields, c.tags, c.notes, c.source, c.consent_source, c.status, c.timezone, c.last_contacted_at, c.last_replied_at, c.created_at, c.updated_at,
            (CASE WHEN c.avatar_updated_at IS NULL THEN NULL ELSE (extract(epoch FROM c.avatar_updated_at) * 1000)::bigint END) AS avatar_version,
            (SELECT count(*)::int FROM enrollments e WHERE e.contact_id=c.id AND e.status IN ('active','waiting_review','paused')) AS active_enrollments,
            EXISTS (SELECT 1 FROM suppressions s WHERE s.user_id=c.user_id AND lower(s.email)=lower(c.email)) AS suppressed
     FROM contacts c WHERE ${w} ORDER BY c.${sort} ${dir} NULLS LAST, c.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
    params,
  );
  res.json({ contacts: rows, total: total?.n ?? 0, page, size });
});

contactsRouter.get('/tags', async (req, res) => {
  const rows = await query<{ tag: string; n: number }>(`SELECT t AS tag, count(*)::int AS n FROM contacts c, unnest(c.tags) t WHERE c.user_id=$1 GROUP BY t ORDER BY n DESC, t`, [req.user!.id]);
  res.json({ tags: rows });
});

contactsRouter.get('/stats', async (req, res) => {
  const r = await one<any>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='replied')::int AS replied,
            count(*) FILTER (WHERE status='unsubscribed')::int AS unsubscribed, count(*) FILTER (WHERE status='bounced')::int AS bounced FROM contacts WHERE user_id=$1`,
    [req.user!.id],
  );
  res.json(r);
});

contactsRouter.get('/export.csv', async (req, res) => {
  const rows = await query<any>('SELECT * FROM contacts WHERE user_id=$1 ORDER BY id', [req.user!.id]);
  const custom = [...new Set(rows.flatMap((r) => Object.keys(r.fields ?? {})))];
  const headers = ['email', 'first_name', 'last_name', 'company', 'title', 'phone', 'website', 'tags', 'status', 'consent_source', 'notes', 'last_contacted_at', 'last_replied_at', ...custom];
  const body = toCsv(headers, rows.map((r) => [r.email, r.first_name, r.last_name, r.company, r.title, r.phone, r.website, (r.tags ?? []).join('; '), r.status, r.consent_source, r.notes, r.last_contacted_at?.toISOString?.() ?? '', r.last_replied_at?.toISOString?.() ?? '', ...custom.map((k) => r.fields?.[k] ?? '')]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(body);
});

contactsRouter.get('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const c = await one<any>(`SELECT *, (CASE WHEN avatar_updated_at IS NULL THEN NULL ELSE (extract(epoch FROM avatar_updated_at) * 1000)::bigint END) AS avatar_version FROM contacts WHERE id=$1 AND user_id=$2`, [id, req.user!.id]);
  if (!c) throw notFound('Contact not found');
  delete c.avatar; delete c.avatar_type;
  const sends = await query<any>(`SELECT l.*, s.name AS sequence_name FROM send_log l LEFT JOIN sequences s ON s.id=l.sequence_id WHERE l.contact_id=$1 ORDER BY l.sent_at DESC LIMIT 100`, [id]);
  const enrollments = await query<any>(`SELECT e.*, s.name AS sequence_name FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE e.contact_id=$1 ORDER BY e.created_at DESC`, [id]);
  const threads = await query<any>(
    `SELECT ct.account_id, ct.thread_id, (SELECT jsonb_build_object('subject', x.subject, 'received_at', x.received_at, 'from', x.from_addr, 'preview', x.preview) FROM emails x WHERE x.account_id=ct.account_id AND x.thread_id=ct.thread_id ORDER BY x.received_at DESC LIMIT 1) AS latest
     FROM contact_threads ct WHERE ct.contact_id=$1 ORDER BY ct.created_at DESC LIMIT 50`,
    [id],
  );
  const dek = await dataKey(req.user!.id);
  for (const t of threads) {
    if (!t.latest) continue;
    const o = openEmailWith(dek, { subject: t.latest.subject, preview: t.latest.preview, from_addr: t.latest.from });
    t.latest = { ...t.latest, subject: o.subject, preview: o.preview, from: o.from_addr };
  }
  const suppressed = await one<any>('SELECT * FROM suppressions WHERE user_id=$1 AND lower(email)=lower($2)', [req.user!.id, c.email]);
  res.json({ contact: c, sends, enrollments, threads: threads.filter((t) => t.latest), suppression: suppressed });
});

contactsRouter.post('/', async (req, res) => {
  const b = parse(contactSchema, req.body);
  const rows = await query<any>(
    `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, phone, website, fields, tags, notes, consent_source, status, timezone, source)
     VALUES ($1, lower($2), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual')
     ON CONFLICT (user_id, email) DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, company=EXCLUDED.company, title=EXCLUDED.title, phone=EXCLUDED.phone, website=EXCLUDED.website,
       fields=contacts.fields || EXCLUDED.fields, tags=(SELECT array_agg(DISTINCT t) FROM unnest(contacts.tags || EXCLUDED.tags) t), notes=EXCLUDED.notes, consent_source=EXCLUDED.consent_source, updated_at=now()
     RETURNING *`,
    [req.user!.id, b.email, b.first_name, b.last_name, b.company, b.title, b.phone, b.website, JSON.stringify(b.fields), b.tags, b.notes, b.consent_source, b.status ?? 'active', b.timezone ?? null],
  );
  res.json({ contact: rows[0] });
});

// Update schemas carry no defaults: a partial update must leave untouched
// fields alone, and Zod applies .default() even through .partial().
const contactUpdateSchema = z.object({
  email: z.string().email().optional(),
  first_name: z.string().max(120).optional(), last_name: z.string().max(120).optional(), company: z.string().max(200).optional(), title: z.string().max(200).optional(),
  phone: z.string().max(60).optional(), website: z.string().max(300).optional(), fields: z.record(z.string(), z.unknown()).optional(), tags: z.array(z.string().max(60)).optional(),
  notes: z.string().max(20000).optional(), consent_source: z.string().max(300).optional(),
  status: z.enum(['active', 'unsubscribed', 'bounced', 'replied', 'do_not_contact']).optional(), timezone: z.string().max(64).nullable().optional(),
});

contactsRouter.put('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(contactUpdateSchema, req.body);
  const c = await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  if (!c) throw notFound('Contact not found');
  const rows = await query<any>(
    `UPDATE contacts SET email=COALESCE($3,email), first_name=COALESCE($4,first_name), last_name=COALESCE($5,last_name), company=COALESCE($6,company), title=COALESCE($7,title), phone=COALESCE($8,phone), website=COALESCE($9,website),
       fields=COALESCE($10,fields), tags=COALESCE($11,tags), notes=COALESCE($12,notes), consent_source=COALESCE($13,consent_source), status=COALESCE($14,status), timezone=COALESCE($15,timezone), updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, req.user!.id, b.email?.toLowerCase() ?? null, b.first_name ?? null, b.last_name ?? null, b.company ?? null, b.title ?? null, b.phone ?? null, b.website ?? null, b.fields ? JSON.stringify(b.fields) : null, b.tags ?? null, b.notes ?? null, b.consent_source ?? null, b.status ?? null, b.timezone ?? null],
  );
  if (b.status === 'unsubscribed' || b.status === 'do_not_contact') {
    await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), 'manual', 'contact status') ON CONFLICT (user_id, email) DO NOTHING`, [req.user!.id, rows[0].email]);
    await query(`UPDATE enrollments SET status='unsubscribed', updated_at=now(), finished_at=now() WHERE contact_id=$1 AND status IN ('active','waiting_review','paused')`, [id]);
  } else if (b.status === 'active') {
    await query(`DELETE FROM suppressions WHERE user_id=$1 AND lower(email)=lower($2) AND reason IN ('manual','import')`, [req.user!.id, rows[0].email]);
  }
  res.json({ contact: rows[0] });
});

contactsRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM contacts WHERE id=$1 AND user_id=$2', [idParam(req.params.id), req.user!.id]);
  res.json({ ok: true });
});

contactsRouter.post('/bulk', async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.number().int()).min(1).max(5000), action: z.enum(['delete', 'tag', 'untag', 'status']), tag: z.string().max(60).optional(), status: z.enum(['active', 'unsubscribed', 'do_not_contact']).optional() }), req.body);
  const uid = req.user!.id;
  switch (b.action) {
    case 'delete': await query('DELETE FROM contacts WHERE id = ANY($1) AND user_id=$2', [b.ids, uid]); break;
    case 'tag': if (!b.tag) throw badRequest('tag required'); await query(`UPDATE contacts SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(tags || ARRAY[$3]::text[]) t), updated_at=now() WHERE id = ANY($1) AND user_id=$2`, [b.ids, uid, b.tag]); break;
    case 'untag': if (!b.tag) throw badRequest('tag required'); await query(`UPDATE contacts SET tags = array_remove(tags, $3), updated_at=now() WHERE id = ANY($1) AND user_id=$2`, [b.ids, uid, b.tag]); break;
    case 'status': {
      if (!b.status) throw badRequest('status required');
      await query(`UPDATE contacts SET status=$3, updated_at=now() WHERE id = ANY($1) AND user_id=$2`, [b.ids, uid, b.status]);
      if (b.status !== 'active') {
        await query(`INSERT INTO suppressions (user_id, email, reason, source) SELECT user_id, lower(email), 'manual', 'bulk' FROM contacts WHERE id = ANY($1) AND user_id=$2 ON CONFLICT (user_id, email) DO NOTHING`, [b.ids, uid]);
        await query(`UPDATE enrollments SET status='unsubscribed', updated_at=now(), finished_at=now() WHERE contact_id = ANY($1) AND status IN ('active','waiting_review','paused')`, [b.ids]);
      } else {
        await query(`DELETE FROM suppressions s USING contacts c WHERE c.id = ANY($1) AND c.user_id=$2 AND s.user_id=c.user_id AND lower(s.email)=lower(c.email) AND s.reason IN ('manual','import')`, [b.ids, uid]);
      }
      break;
    }
  }
  res.json({ ok: true });
});

// ---------- CSV import ----------

const csvBody = text({ type: () => true, limit: '50mb' });

contactsRouter.post('/import/preview', csvBody, async (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  if (!raw.trim()) throw badRequest('The file is empty');
  const parsed = parseCsv(raw, undefined, 2000);
  if (!parsed.headers.length) throw badRequest('Could not find a header row');
  const upload = await query<any>('INSERT INTO uploads (user_id, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.user!.id, String(req.query.filename ?? 'import.csv').slice(0, 255), 'text/csv', Buffer.byteLength(raw), Buffer.from(raw, 'utf8')]);
  const full = parseCsv(raw, parsed.delimiter);
  res.json({ uploadId: upload[0].id, headers: parsed.headers, sample: parsed.rows.slice(0, 5), total: full.rows.length, delimiter: parsed.delimiter, guess: guessMapping(parsed.headers) });
});

const importSchema = z.object({
  uploadId: z.number().int(),
  mapping: z.record(z.string(), z.string().nullable()),
  customFields: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string().max(60)).default([]),
  consentSource: z.string().max(300).default(''),
  existing: z.enum(['skip', 'update']).default('update'),
});

contactsRouter.post('/import', async (req, res) => {
  const b = parse(importSchema, req.body);
  const up = await one<any>('SELECT data FROM uploads WHERE id=$1 AND user_id=$2', [b.uploadId, req.user!.id]);
  if (!up) throw notFound('Upload not found; start the import again');
  const parsed = parseCsv(up.data.toString('utf8'));
  const col = (name: string | null | undefined) => (name ? parsed.headers.indexOf(name) : -1);
  const emailIdx = col(b.mapping.email);
  if (emailIdx < 0) throw badRequest('Map the email column first');
  const idx = { first: col(b.mapping.first_name), last: col(b.mapping.last_name), full: col(b.mapping.full_name), company: col(b.mapping.company), title: col(b.mapping.title), phone: col(b.mapping.phone), website: col(b.mapping.website), tags: col(b.mapping.tags), notes: col(b.mapping.notes) };
  const customIdx = Object.entries(b.customFields).map(([header, key]) => [parsed.headers.indexOf(header), key.trim()] as const).filter(([i, k]) => i >= 0 && k);
  const stats = { created: 0, updated: 0, skipped: 0, invalid: 0, suppressed: 0 };
  const seen = new Set<string>();
  const suppressed = new Set((await query<{ email: string }>('SELECT email FROM suppressions WHERE user_id=$1', [req.user!.id])).map((r) => r.email));
  await withTx(async (c) => {
    for (const row of parsed.rows) {
      const email = (row[emailIdx] ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) { stats.invalid++; continue; }
      seen.add(email);
      if (suppressed.has(email)) stats.suppressed++;
      let first = idx.first >= 0 ? (row[idx.first] ?? '').trim() : '';
      let last = idx.last >= 0 ? (row[idx.last] ?? '').trim() : '';
      if (!first && !last && idx.full >= 0) { const parts = (row[idx.full] ?? '').trim().split(/\s+/); first = parts.shift() ?? ''; last = parts.join(' '); }
      const tags = [...b.tags, ...(idx.tags >= 0 ? (row[idx.tags] ?? '').split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [])];
      const fields: Record<string, string> = {};
      for (const [i, k] of customIdx) if ((row[i] ?? '').trim()) fields[k] = (row[i] ?? '').trim();
      const vals = [req.user!.id, email, first, last, idx.company >= 0 ? (row[idx.company] ?? '').trim() : '', idx.title >= 0 ? (row[idx.title] ?? '').trim() : '', idx.phone >= 0 ? (row[idx.phone] ?? '').trim() : '', idx.website >= 0 ? (row[idx.website] ?? '').trim() : '', JSON.stringify(fields), tags, idx.notes >= 0 ? (row[idx.notes] ?? '').trim() : '', b.consentSource, suppressed.has(email) ? 'unsubscribed' : 'active'];
      const r = await c.query(
        b.existing === 'skip'
          ? `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, phone, website, fields, tags, notes, consent_source, status, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'import') ON CONFLICT (user_id, email) DO NOTHING RETURNING (xmax = 0) AS inserted`
          : `INSERT INTO contacts (user_id, email, first_name, last_name, company, title, phone, website, fields, tags, notes, consent_source, status, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'import')
             ON CONFLICT (user_id, email) DO UPDATE SET first_name=CASE WHEN EXCLUDED.first_name<>'' THEN EXCLUDED.first_name ELSE contacts.first_name END, last_name=CASE WHEN EXCLUDED.last_name<>'' THEN EXCLUDED.last_name ELSE contacts.last_name END,
               company=CASE WHEN EXCLUDED.company<>'' THEN EXCLUDED.company ELSE contacts.company END, title=CASE WHEN EXCLUDED.title<>'' THEN EXCLUDED.title ELSE contacts.title END, phone=CASE WHEN EXCLUDED.phone<>'' THEN EXCLUDED.phone ELSE contacts.phone END,
               website=CASE WHEN EXCLUDED.website<>'' THEN EXCLUDED.website ELSE contacts.website END, fields=contacts.fields || EXCLUDED.fields, tags=(SELECT array_agg(DISTINCT t) FROM unnest(contacts.tags || EXCLUDED.tags) t),
               notes=CASE WHEN EXCLUDED.notes<>'' THEN EXCLUDED.notes ELSE contacts.notes END, consent_source=CASE WHEN EXCLUDED.consent_source<>'' THEN EXCLUDED.consent_source ELSE contacts.consent_source END, updated_at=now()
             RETURNING (xmax = 0) AS inserted`,
        vals,
      );
      if (!r.rows.length) stats.skipped++;
      else if (r.rows[0].inserted) stats.created++;
      else stats.updated++;
    }
    await c.query('DELETE FROM uploads WHERE id=$1', [b.uploadId]);
  });
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'contacts.imported',$2)`, [req.user!.id, JSON.stringify(stats)]);
  res.json({ ok: true, ...stats });
});

// ---------- Suppressions ----------

contactsRouter.get('/suppressions/list', async (req, res) => {
  const rows = await query<any>('SELECT * FROM suppressions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 2000', [req.user!.id]);
  res.json({ suppressions: rows });
});

contactsRouter.post('/suppressions', async (req, res) => {
  const b = parse(z.object({ emails: z.array(z.string().email()).min(1).max(5000), reason: z.enum(['manual', 'import']).default('manual') }), req.body);
  for (const e of b.emails) {
    await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), $3, 'manual') ON CONFLICT (user_id, email) DO NOTHING`, [req.user!.id, e, b.reason]);
    await query(`UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE user_id=$1 AND lower(email)=lower($2) AND status='active'`, [req.user!.id, e]);
  }
  await query(`UPDATE enrollments e SET status='unsubscribed', updated_at=now(), finished_at=now() FROM contacts c WHERE e.contact_id=c.id AND c.user_id=$1 AND lower(c.email) = ANY($2) AND e.status IN ('active','waiting_review','paused')`, [req.user!.id, b.emails.map((e) => e.toLowerCase())]);
  res.json({ ok: true });
});

contactsRouter.delete('/suppressions/:id', async (req, res) => {
  const rows = await query<any>('DELETE FROM suppressions WHERE id=$1 AND user_id=$2 RETURNING email', [idParam(req.params.id), req.user!.id]);
  if (rows.length) await query(`UPDATE contacts SET status='active', updated_at=now() WHERE user_id=$1 AND lower(email)=lower($2) AND status IN ('unsubscribed','bounced')`, [req.user!.id, rows[0].email]);
  res.json({ ok: true });
});
