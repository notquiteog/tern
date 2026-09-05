import { Router, text } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { query } from '../db.js';
import { generateDefaultSvg, getBrand, sanitizeSvg, saveBrand, setBrandVmc } from '../services/brand.js';
import { fitToBimi, BIMI_MAX_BYTES } from '../services/svgTiny.js';
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

function publicBrand(b: any) {
  const { svg, ...rest } = b;
  return { ...rest, url: bimiUrlFor(b.domain), size: Buffer.byteLength(svg), maxBytes: BIMI_MAX_BYTES, record: `v=BIMI1; l=${bimiUrlFor(b.domain)}; a=${b.vmc_url || ''};` };
}

brandRouter.get('/:domain', async (req, res) => {
  const b = await getBrand(domainParam(String(req.params.domain)));
  if (!b) { res.json({ brand: null, maxBytes: BIMI_MAX_BYTES }); return; }
  res.json({ brand: publicBrand(b) });
});

// BIMI record options: the optional Verified/Common Mark Certificate URL.
brandRouter.put('/:domain/options', requireAdmin, async (req, res) => {
  const domain = domainParam(String(req.params.domain));
  const b = parse(z.object({ vmcUrl: z.string().max(500).refine((v) => v === '' || /^https:\/\/[^\s]+\.pem$/i.test(v), 'The certificate must be an https URL ending in .pem') }), req.body);
  if (!(await getBrand(domain))) throw notFound('No logo for this domain yet');
  await setBrandVmc(domain, b.vmcUrl);
  const updated = await getBrand(domain);
  res.json({ brand: publicBrand(updated) });
});

// Upload an SVG (raw body) or generate a default avatar from initials.
brandRouter.put('/:domain', requireAdmin, text({ type: ['image/svg+xml', 'text/plain'], limit: '4mb' }), async (req, res) => {
  const domain = domainParam(String(req.params.domain));
  const ct = String(req.headers['content-type'] ?? '');
  let svg: string; let name = domain; let color = '#ffffff'; let bg = '#4f6df5'; let initials = '';
  if (ct.includes('application/json')) {
    // express.json has already parsed JSON bodies on /api; the text parser only sees SVG uploads.
    const raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
    const b = parse(z.object({ name: z.string().max(120).default(''), initials: z.string().min(1).max(3), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), bg: z.string().regex(/^#[0-9a-fA-F]{6}$/) }), raw);
    name = b.name || domain; color = b.color; bg = b.bg; initials = b.initials;
    svg = generateDefaultSvg({ initials, color, bg, name });
    const saved = await saveBrand(domain, { name, svg, color, bg, initials, source: 'generated', report: { originalBytes: Buffer.byteLength(svg), bytes: Buffer.byteLength(svg) } }, req.user!.id);
    await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'brand.updated',$2)`, [req.user!.id, domain]);
    res.json({ brand: publicBrand(saved) });
    return;
  }
  // Uploaded or traced SVG: safety checks first, then strip every bit of
  // metadata and shrink until it fits the BIMI limit.
  const raw = String(req.body ?? '');
  const safety = sanitizeSvg(raw);
  if (!safety.ok && !/Tiny PS|32 KB|Raster/.test(safety.error)) throw badRequest(safety.error);
  const existing = await getBrand(domain);
  if (existing) { name = existing.name; color = existing.color; bg = existing.bg; initials = existing.initials; }
  const fit = fitToBimi(raw, name || domain);
  if (!fit.ok) {
    // A document that cannot be made small enough is 413 (the client offers tracing); anything else is a validation error.
    res.status(/32 KB/.test(fit.error) ? 413 : 400).json({ error: fit.error, report: fit.report });
    return;
  }
  const source = String(req.query.source ?? 'upload');
  const b = await saveBrand(domain, { name, svg: fit.svg, color, bg, initials, source, report: { ...fit.report } as any }, req.user!.id);
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'brand.updated',$2,$3)`, [req.user!.id, domain, JSON.stringify({ source, bytes: fit.bytes, originalBytes: fit.report.originalBytes })]);
  res.json({ brand: publicBrand(b) });
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
