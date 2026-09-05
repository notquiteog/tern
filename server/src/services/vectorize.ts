// Raster → SVG tracing, shared by the browser (which decodes the image) and
// the server tests. A PNG or JPEG logo becomes real vector paths, because
// BIMI forbids embedded bitmaps. Pipeline: median-cut colour quantisation
// with a k-means tightening pass, one binary mask per colour, exact
// pixel-edge boundary loops, Douglas-Peucker simplification, then paths with
// even-odd fill so holes come out right. No DOM, no Node APIs.
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface TraceOptions { colors: number; tolerance: number; background?: string | null; title?: string; precision?: number }
export interface TraceResult { svg: string; bytes: number; colors: number; width: number; height: number; paths: number }

type RGB = [number, number, number];

function medianCut(pixels: RGB[], count: number): RGB[] {
  if (!pixels.length) return [];
  let boxes: RGB[][] = [pixels];
  while (boxes.length < count) {
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift()!;
    if (box.length < 2) { boxes.push(box); break; }
    const ranges = [0, 1, 2].map((c) => { let lo = 255, hi = 0; for (const p of box) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; } return hi - lo; });
    const ch = ranges.indexOf(Math.max(...ranges));
    if (ranges[ch] === 0) { boxes.push(box); break; }
    box.sort((a, b) => a[ch] - b[ch]);
    // Split at the midpoint of the value range rather than the median index,
    // so two distinct colours never end up sharing a box.
    const midValue = (box[0][ch] + box[box.length - 1][ch]) / 2;
    let cut = box.findIndex((p) => p[ch] > midValue);
    if (cut <= 0 || cut >= box.length) cut = box.length >> 1;
    boxes.push(box.slice(0, cut), box.slice(cut));
  }
  let palette = boxes.map((b) => { const s = [0, 0, 0]; for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length)] as RGB; });
  // Two k-means passes tighten the palette around the real colours.
  for (let pass = 0; pass < 2; pass++) {
    const sums = palette.map(() => [0, 0, 0, 0]);
    for (const p of pixels) { const i = nearest(p, palette); sums[i][0] += p[0]; sums[i][1] += p[1]; sums[i][2] += p[2]; sums[i][3]++; }
    palette = palette.map((c, i) => (sums[i][3] ? [Math.round(sums[i][0] / sums[i][3]), Math.round(sums[i][1] / sums[i][3]), Math.round(sums[i][2] / sums[i][3])] as RGB : c));
  }
  return palette;
}

function nearest(p: RGB, palette: RGB[]): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) { const q = palette[i]; const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

// Boundary loops of a binary mask, walking pixel edges clockwise. Each edge
// shared by two mask pixels cancels out; the rest link into closed loops.
function edgeLoops(mask: Uint8Array, w: number, h: number): [number, number][][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // directed edges: key = from vertex, value = to vertex(es)
  const next = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  const add = (x1: number, y1: number, x2: number, y2: number) => { const k = key(x1, y1); const arr = next.get(k); if (arr) arr.push(key(x2, y2)); else next.set(k, [key(x2, y2)]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);           // top edge, left→right
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);   // right edge, top→bottom
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);   // bottom edge, right→left
    if (!at(x - 1, y)) add(x, y + 1, x, y);           // left edge, bottom→top
  }
  const loops: [number, number][][] = [];
  const W = w + 1;
  while (next.size) {
    const start = next.keys().next().value as number;
    const loop: [number, number][] = [];
    let cur = start;
    let guard = 0;
    for (;;) {
      loop.push([cur % W, Math.floor(cur / W)]);
      const outs = next.get(cur);
      if (!outs || !outs.length) break;
      // Prefer continuing straight/turning consistently: pick the first; ambiguity at pinch points is rare and harmless for fill.
      const to = outs.shift()!;
      if (!outs.length) next.delete(cur);
      cur = to;
      if (cur === start || ++guard > 4_000_000) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function simplify(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length < 4 || tolerance <= 0) return points;
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a], [bx, by] = points[b];
    let maxD = -1, idx = -1;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i] === 1);
}

const hex = (c: RGB) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const fmt = (n: number, p: number) => { const r = Number(n.toFixed(p)); return String(r === 0 ? 0 : r); };

export function trace(img: Pixels, opts: TraceOptions): TraceResult {
  const { width: w, height: h, data } = img;
  const precision = opts.precision ?? 1;
  const opaque: RGB[] = [];
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a >= 128) { alpha[i] = 1; opaque.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]); }
  }
  const palette = medianCut(opaque, Math.max(1, Math.min(32, opts.colors)));
  const index = new Int16Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) if (alpha[i]) index[i] = nearest([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]], palette);
  // Larger colour areas first so small details paint on top.
  const counts = palette.map((_, ci) => { let n = 0; for (let i = 0; i < w * h; i++) if (index[i] === ci) n++; return n; });
  const order = palette.map((_, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a]);
  const parts: string[] = [];
  let paths = 0;
  if (opts.background) parts.push(`<rect width="${w}" height="${h}" fill="${opts.background}"/>`);
  for (const ci of order) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (index[i] === ci) mask[i] = 1;
    const loops = edgeLoops(mask, w, h);
    const d: string[] = [];
    for (const loop of loops) {
      // Close explicitly so simplification treats the seam like any other edge, then drop the duplicate end.
      let pts = simplify([...loop, loop[0]], opts.tolerance);
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
      if (pts.length < 3) continue;
      d.push('M' + pts.map((p) => `${fmt(p[0], precision)},${fmt(p[1], precision)}`).join('L') + 'Z');
    }
    if (d.length) { parts.push(`<path fill="${hex(palette[ci])}" fill-rule="evenodd" d="${d.join('')}"/>`); paths++; }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 ${w} ${h}"><title>${(opts.title ?? 'Logo').replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]!))}</title>${parts.join('')}</svg>`;
  return { svg, bytes: new TextEncoder().encode(svg).length, colors: order.length, width: w, height: h, paths };
}

export const FIT_STEPS: { size: number; colors: number; tolerance: number }[] = [
  { size: 160, colors: 16, tolerance: 0.7 }, { size: 128, colors: 16, tolerance: 0.8 }, { size: 128, colors: 12, tolerance: 1 }, { size: 112, colors: 10, tolerance: 1.1 },
  { size: 96, colors: 8, tolerance: 1.2 }, { size: 80, colors: 8, tolerance: 1.4 }, { size: 64, colors: 6, tolerance: 1.5 }, { size: 56, colors: 5, tolerance: 1.8 },
  { size: 48, colors: 4, tolerance: 2 }, { size: 40, colors: 4, tolerance: 2.2 }, { size: 32, colors: 3, tolerance: 2.5 },
];

