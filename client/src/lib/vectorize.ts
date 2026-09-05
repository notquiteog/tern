// Browser side of the tracer: decode any image on a canvas, then hand the
// pixels to the shared tracer and shrink until the SVG fits the BIMI limit.
import { trace, FIT_STEPS, type Pixels, type TraceResult } from '../../../server/src/services/vectorize';
export { trace, FIT_STEPS };
export type { Pixels, TraceResult, TraceOptions } from '../../../server/src/services/vectorize';

// Browser-only: draw an image (or an SVG) square onto a canvas at the given size.
export async function rasterize(source: Blob | string, size: number): Promise<Pixels> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Could not decode the image')); i.src = url; });
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const iw = img.naturalWidth || img.width || size, ih = img.naturalHeight || img.height || size;
    const s = Math.min(size / iw, size / ih);
    const dw = Math.max(1, Math.round(iw * s)), dh = Math.max(1, Math.round(ih * s));
    ctx.drawImage(img, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
    const d = ctx.getImageData(0, 0, size, size);
    return { width: size, height: size, data: d.data };
  } finally { if (typeof source !== 'string') URL.revokeObjectURL(url); }
}

// Try progressively coarser settings until the result fits under maxBytes.
export async function traceToFit(source: Blob | string, opts: { title?: string; background?: string | null; maxBytes?: number; start?: { size: number; colors: number; tolerance: number } }, onStep?: (step: { size: number; colors: number; tolerance: number }, bytes: number) => void): Promise<TraceResult & { step: { size: number; colors: number; tolerance: number } }> {
  const max = opts.maxBytes ?? 30 * 1024;
  const steps = opts.start ? [opts.start, ...FIT_STEPS.filter((s) => s.size <= opts.start!.size && (s.size < opts.start!.size || s.colors < opts.start!.colors))] : FIT_STEPS;
  let last: (TraceResult & { step: any }) | null = null;
  for (const step of steps) {
    const px = await rasterize(source, step.size);
    const r = trace(px, { colors: step.colors, tolerance: step.tolerance, background: opts.background, title: opts.title });
    onStep?.(step, r.bytes);
    last = { ...r, step };
    if (r.bytes <= max) return last;
  }
  return last!;
}
