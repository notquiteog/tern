// Turns any SVG into a BIMI-ready "SVG Tiny Portable/Secure" document with
// no metadata left in it, then shrinks it until it fits the 32 KB limit.
//
// No XML library: a small tokenizer walks tags and attributes so nothing is
// interpreted, only rewritten. Everything not on the allow-list is dropped,
// which is the point: a logo is shapes and colours, not editor history.
export const BIMI_MAX_BYTES = 32 * 1024;

const ALLOWED_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'switch']);
// Elements removed together with everything inside them.
const DROP_WITH_CONTENT = new Set(['metadata', 'desc', 'script', 'style', 'foreignobject', 'image', 'use', 'filter', 'mask', 'clippath', 'pattern', 'marker', 'symbol', 'animate', 'animatetransform', 'animatemotion', 'set', 'video', 'audio', 'iframe', 'a:', 'font', 'font-face', 'glyph', 'missing-glyph', 'cursor', 'view']);
// Elements unwrapped: the tag goes, the children stay.
const UNWRAP = new Set(['a']);
const PRESENTATION = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color', 'display', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'stop-color', 'stop-opacity', 'transform', 'viewbox', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'offset', 'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'version', 'baseprofile', 'xmlns', 'xmlns:xlink', 'xlink:href', 'href', 'preserveaspectratio', 'dominant-baseline', 'letter-spacing', 'id']);
const NUMERIC_ATTRS = new Set(['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'stroke-width', 'font-size', 'fx', 'fy', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity']);

export type TinyResult = { ok: true; svg: string; bytes: number; report: TinyReport } | { ok: false; error: string; report?: TinyReport };
export interface TinyReport { removedElements: Record<string, number>; removedAttributes: number; stylesConverted: number; precision: number; originalBytes: number; bytes: number; warnings: string[] }

interface Tag { raw: string; name: string; attrs: [string, string][]; selfClosing: boolean; closing: boolean }

function parseTag(raw: string): Tag | null {
  const m = raw.match(/^<\s*(\/?)\s*([A-Za-z][\w:.-]*)([\s\S]*?)(\/?)\s*>$/);
  if (!m) return null;
  const attrs: [string, string][] = [];
  const body = m[3];
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(body))) attrs.push([a[1], a[2] ?? a[3] ?? a[4] ?? '']);
  return { raw, name: m[2].toLowerCase(), attrs, selfClosing: m[4] === '/', closing: m[1] === '/' };
}

export function roundNumbers(value: string, precision: number): string {
  return value.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return n;
    const r = Number(v.toFixed(precision));
    return String(r === 0 ? 0 : r);
  });
}

function minifyPath(d: string, precision: number): string {
  return roundNumbers(d, precision).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').replace(/\s*([MLHVCSQTAZmlhvcsqtaz])\s*/g, '$1').replace(/ -/g, '-').trim();
}

function styleToAttrs(style: string): [string, string][] {
  const out: [string, string][] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim();
    if (PRESENTATION.has(k) && v && !/url\(\s*['"]?\s*https?:/i.test(v)) out.push([k, v]);
  }
  return out;
}

function esc(v: string): string { return v.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

export function toTinyPs(input: string, opts: { title?: string; precision?: number } = {}): TinyResult {
  const originalBytes = Buffer.byteLength(input);
  const report: TinyReport = { removedElements: {}, removedAttributes: 0, stylesConverted: 0, precision: opts.precision ?? 3, originalBytes, bytes: 0, warnings: [] };
  let src = input.trim();
  if (/<!ENTITY/i.test(src)) return { ok: false, error: 'SVG entities are not allowed', report };
  if (!/<svg[\s>]/i.test(src)) return { ok: false, error: 'The file must be an SVG document', report };
  src = src.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const precision = opts.precision ?? 3;
  const tokens = src.match(/<[^>]+>|[^<]+/g) ?? [];
  const out: string[] = [];
  const stack: { name: string; keep: boolean; dropUntil: boolean }[] = [];
  let dropDepth = 0;
  let sawTitle = false;
  const referencedIds = new Set<string>();
  for (const m of src.matchAll(/url\(\s*#([^)\s'"]+)\s*\)|(?:xlink:)?href\s*=\s*["']#([^"']+)["']/g)) referencedIds.add(m[1] ?? m[2]);
  const noteRemoved = (n: string) => { report.removedElements[n] = (report.removedElements[n] ?? 0) + 1; };

  for (const tok of tokens) {
    if (!tok.startsWith('<')) {
      if (dropDepth > 0) continue;
      const text = tok.replace(/\s+/g, ' ');
      const parent = stack[stack.length - 1]?.name;
      if (parent === 'text' || parent === 'tspan' || parent === 'title') out.push(esc(text.trim() ? text : ''));
      continue;
    }
    const tag = parseTag(tok);
    if (!tag) continue;
    const name = tag.name;
    if (tag.closing) {
      if (dropDepth > 0) { if (stack.length && stack[stack.length - 1].dropUntil) { dropDepth--; stack.pop(); } else stack.pop(); continue; }
      const top = stack.pop();
      if (top && top.keep) out.push(`</${top.name}>`);
      continue;
    }
    if (dropDepth > 0) { if (!tag.selfClosing) stack.push({ name, keep: false, dropUntil: false }); continue; }
    if (DROP_WITH_CONTENT.has(name) || name.includes(':')) {
      noteRemoved(name);
      if (!tag.selfClosing) { dropDepth++; stack.push({ name, keep: false, dropUntil: true }); }
      continue;
    }
    if (UNWRAP.has(name)) { noteRemoved(name); if (!tag.selfClosing) stack.push({ name, keep: false, dropUntil: false }); continue; }
    if (!ALLOWED_ELEMENTS.has(name)) { noteRemoved(name); if (!tag.selfClosing) stack.push({ name, keep: false, dropUntil: false }); continue; }
    if (name === 'title') { noteRemoved('title'); if (!tag.selfClosing) { dropDepth++; stack.push({ name, keep: false, dropUntil: true }); } continue; }

    const attrs: [string, string][] = [];
    for (const [rawKey, rawVal] of tag.attrs) {
      const key = rawKey.toLowerCase();
      if (key === 'style') { const conv = styleToAttrs(rawVal); report.stylesConverted += conv.length; attrs.push(...conv); continue; }
      if (key.startsWith('on') || key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'class' || key === 'xml:space' || key === 'tabindex' || key === 'contentscripttype' || key === 'contentstyletype') { report.removedAttributes++; continue; }
      if (key.startsWith('xmlns:') && key !== 'xmlns:xlink') { report.removedAttributes++; continue; }
      if (key.includes(':') && key !== 'xmlns:xlink' && key !== 'xlink:href') { report.removedAttributes++; continue; }
      if (!PRESENTATION.has(key)) { report.removedAttributes++; continue; }
      if (key === 'id' && !referencedIds.has(rawVal)) { report.removedAttributes++; continue; }
      if ((key === 'href' || key === 'xlink:href') && !rawVal.startsWith('#')) { report.removedAttributes++; continue; }
      if (/url\(\s*['"]?\s*(https?:|\/\/)/i.test(rawVal)) { report.removedAttributes++; continue; }
      if (name === 'svg' && (key === 'x' || key === 'y' || key === 'version' || key === 'baseprofile' || key === 'xmlns')) continue;
      attrs.push([key, rawVal]);
    }
    if (name === 'svg') {
      const get = (k: string) => attrs.find((a) => a[0] === k)?.[1];
      let vb = get('viewbox');
      if (!vb && get('width') && get('height')) vb = `0 0 ${parseFloat(get('width')!)} ${parseFloat(get('height')!)}`;
      const kept = attrs.filter((a) => !['viewbox', 'width', 'height'].includes(a[0]));
      const head = [['xmlns', 'http://www.w3.org/2000/svg'], ['version', '1.2'], ['baseProfile', 'tiny-ps'], ...(vb ? [['viewBox', roundNumbers(vb, precision)]] : []), ...kept];
      if (!vb) report.warnings.push('The SVG has no viewBox or size; clients may scale it unpredictably');
      out.push(`<svg${head.map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('')}>`);
      out.push(`<title>${esc(opts.title ?? 'Logo')}</title>`);
      sawTitle = true;
      stack.push({ name, keep: true, dropUntil: false });
      continue;
    }
    const rendered = attrs.map(([k, v]) => {
      let val = v;
      if (k === 'd') val = minifyPath(v, precision);
      else if (k === 'points' || k === 'transform' || k === 'gradienttransform') val = roundNumbers(v, precision).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
      else if (NUMERIC_ATTRS.has(k)) val = roundNumbers(v, precision);
      const attrName = k === 'viewbox' ? 'viewBox' : k === 'gradientunits' ? 'gradientUnits' : k === 'gradienttransform' ? 'gradientTransform' : k === 'spreadmethod' ? 'spreadMethod' : k === 'preserveaspectratio' ? 'preserveAspectRatio' : k;
      return ` ${attrName}="${esc(val)}"`;
    }).join('');
    const tagName = name === 'lineargradient' ? 'linearGradient' : name === 'radialgradient' ? 'radialGradient' : name;
    if (tag.selfClosing) out.push(`<${tagName}${rendered}/>`);
    else { out.push(`<${tagName}${rendered}>`); stack.push({ name: tagName, keep: true, dropUntil: false }); }
  }
  while (stack.length) { const top = stack.pop(); if (top?.keep) out.push(`</${top.name}>`); }
  if (!sawTitle) return { ok: false, error: 'No <svg> root element found', report };
  const svg = out.join('').replace(/>\s+</g, '><');
  report.bytes = Buffer.byteLength(svg);
  report.precision = precision;
  return { ok: true, svg, bytes: report.bytes, report };
}

// Shrink precision step by step until the document fits. Returns the first
// result under the limit, or the smallest one with ok=false.
export function fitToBimi(input: string, title?: string): TinyResult {
  let last: TinyResult | null = null;
  for (const precision of [3, 2, 1, 0]) {
    const r = toTinyPs(input, { title, precision });
    if (!r.ok) return r;
    last = r;
    if (r.bytes <= BIMI_MAX_BYTES) return r;
  }
  return { ok: false, error: `Still ${Math.round((last as any).bytes / 1024)} KB after stripping metadata and rounding coordinates; the BIMI limit is 32 KB. Use "Simplify by tracing" to rebuild it with fewer shapes.`, report: (last as any).report };
}
