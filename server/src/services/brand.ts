// Brand logos: an SVG per domain, served publicly for BIMI and used inside
// Tern as the default avatar for senders on that domain. Uploaded SVGs are
// checked against the BIMI "SVG Tiny Portable/Secure" rules that matter for
// safety (no scripts, no external references, no raster images); a default
// avatar can be generated from initials and a colour.
import { one, query } from '../db.js';
import { escapeHtml } from './merge.js';

export interface Brand { domain: string; name: string; svg: string; color: string; bg: string; initials: string; updated_at: Date; updated_by: number | null }

export function sanitizeSvg(svg: string): { ok: true; svg: string } | { ok: false; error: string } {
  const s = svg.trim();
  if (!/^<\?xml[^>]*>\s*<svg[\s>]|^<svg[\s>]/i.test(s)) return { ok: false, error: 'The file must be an SVG document' };
  if (Buffer.byteLength(s) > 32 * 1024) return { ok: false, error: 'BIMI logos must be 32 KB or smaller' };
  if (/<script/i.test(s) || /\son[a-z]+\s*=/i.test(s)) return { ok: false, error: 'Scripts and event handlers are not allowed' };
  if (/<(image|foreignObject|iframe|embed|object|video|audio|use)\b/i.test(s)) return { ok: false, error: 'Raster images, embedded objects and <use> references are not allowed in a BIMI logo' };
  if (/(href|src)\s*=\s*["']\s*(https?:|\/\/)/i.test(s) || /url\(\s*['"]?\s*https?:/i.test(s)) return { ok: false, error: 'External references are not allowed' };
  if (/<style/i.test(s)) return { ok: false, error: 'Move styles to presentation attributes; <style> is not allowed in the Tiny PS profile' };
  let out = s.replace(/<\?xml[^>]*>\s*/i, '');
  if (!/baseProfile\s*=/i.test(out)) out = out.replace(/<svg\b/i, '<svg baseProfile="tiny-ps"');
  if (!/<title>/i.test(out)) out = out.replace(/(<svg\b[^>]*>)/i, '$1<title>Logo</title>');
  return { ok: true, svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + out };
}

export function generateDefaultSvg(input: { initials: string; color: string; bg: string; name: string }): string {
  const initials = escapeHtml(input.initials.slice(0, 3).toUpperCase() || 'A');
  const size = initials.length === 1 ? 480 : initials.length === 2 ? 400 : 320;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 1024 1024"><title>${escapeHtml(input.name || initials)}</title><rect width="1024" height="1024" rx="0" fill="${escapeHtml(input.bg)}"/><circle cx="512" cy="512" r="440" fill="${escapeHtml(input.color)}" fill-opacity="0.18"/><text x="512" y="512" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="${escapeHtml(input.color)}">${initials}</text></svg>`;
}

export async function getBrand(domain: string): Promise<Brand | null> {
  return one<Brand>('SELECT * FROM brands WHERE domain=$1', [domain.toLowerCase()]);
}

export async function saveBrand(domain: string, fields: { name: string; svg: string; color: string; bg: string; initials: string }, userId: number): Promise<Brand> {
  const rows = await query<Brand>(
    `INSERT INTO brands (domain, name, svg, color, bg, initials, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (domain) DO UPDATE SET name=EXCLUDED.name, svg=EXCLUDED.svg, color=EXCLUDED.color, bg=EXCLUDED.bg, initials=EXCLUDED.initials, updated_at=now(), updated_by=EXCLUDED.updated_by RETURNING *`,
    [domain.toLowerCase(), fields.name, fields.svg, fields.color, fields.bg, fields.initials, userId],
  );
  return rows[0];
}

export async function brandDomains(): Promise<Map<string, number>> {
  const rows = await query<{ domain: string; v: number }>(`SELECT domain, (extract(epoch FROM updated_at) * 1000)::bigint AS v FROM brands`);
  return new Map(rows.map((r) => [r.domain, Number(r.v)]));
}
