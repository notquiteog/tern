import { Router, text } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { query } from '../db.js';
import { generateDefaultSvg, getBrand, sanitizeSvg, saveBrand } from '../services/brand.js';
import { config } from '../config.js';

export const brandRouter = Router();
brandRouter.use(requireAuth);

const domainParam = (v: string) => {
  const d = String(v).toLowerCase().replace(/\.svg$/, '');
  if (!/^[a-z0-9.-]{3,253}$/.test(d)) throw badRequest('Invalid domain');
  return d;
};

export function bimiUrlFor(domain: string): string {
  return `${config.appUrl}/bimi/${domain}.svg`;
}

brandRouter.get('/:domain', async (req, res) => {
  const b = await getBrand(domainParam(String(req.params.domain)));
  if (!b) { res.json({ brand: null }); return; }
  const { svg, ...rest } = b;
  res.json({ brand: { ...rest, url: bimiUrlFor(b.domain), size: Buffer.byteLength(svg) } });
});

// Upload an SVG (raw body) or generate a default avatar from initials.
brandRouter.put('/:domain', requireAdmin, text({ type: ['image/svg+xml', 'text/plain'], limit: '200kb' }), async (req, res) => {
  const domain = domainParam(String(req.params.domain));
  const ct = String(req.headers['content-type'] ?? '');
  let svg: string; let name = domain; let color = '#ffffff'; let bg = '#4f6df5'; let initials = '';
  if (ct.includes('application/json')) {
    // express.json has already parsed JSON bodies on /api; the text parser only sees SVG uploads.
    const raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
    const b = parse(z.object({ name: z.string().max(120).default(''), initials: z.string().min(1).max(3), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), bg: z.string().regex(/^#[0-9a-fA-F]{6}$/) }), raw);
    name = b.name || domain; color = b.color; bg = b.bg; initials = b.initials;
    svg = generateDefaultSvg({ initials, color, bg, name });
  } else {
    const r = sanitizeSvg(String(req.body ?? ''));
    if (!r.ok) throw badRequest(r.error);
    svg = r.svg;
    const existing = await getBrand(domain);
    if (existing) { name = existing.name; color = existing.color; bg = existing.bg; initials = existing.initials; }
  }
  const b = await saveBrand(domain, { name, svg, color, bg, initials }, req.user!.id);
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'brand.updated',$2)`, [req.user!.id, domain]);
  const { svg: _s, ...rest } = b;
  res.json({ brand: { ...rest, url: bimiUrlFor(domain), size: Buffer.byteLength(svg) } });
});

brandRouter.delete('/:domain', requireAdmin, async (req, res) => {
  await query('DELETE FROM brands WHERE domain=$1', [domainParam(String(req.params.domain))]);
  res.json({ ok: true });
});

// Public: the logo itself. No auth, long cache, referenced by the BIMI record.
export const bimiRouter = Router();
bimiRouter.get('/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!file.endsWith('.svg')) throw notFound();
  const b = await getBrand(file.slice(0, -4).toLowerCase());
  if (!b) throw notFound('No logo for this domain');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(b.svg);
});
