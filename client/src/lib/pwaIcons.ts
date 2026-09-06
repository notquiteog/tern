// Home-screen icons for a custom logo, rendered in the browser: the logo
// centred on a solid background, in the sizes the manifest and iOS want.
// Maskable icons keep the logo inside the safe zone so nothing gets cropped.
export const ICON_SPECS: { name: string; size: number; scale: number }[] = [
  { name: 'icon-192.png', size: 192, scale: 0.8 },
  { name: 'icon-512.png', size: 512, scale: 0.8 },
  { name: 'icon-512-maskable.png', size: 512, scale: 0.6 },
  { name: 'apple-touch-icon.png', size: 180, scale: 0.76 },
];

export async function renderIcons(logoUrl: string, bg: string): Promise<Record<string, string>> {
  const img = new Image();
  img.src = logoUrl;
  await img.decode();
  const out: Record<string, string> = {};
  for (const spec of ICON_SPECS) {
    const c = document.createElement('canvas');
    c.width = spec.size; c.height = spec.size;
    const x = c.getContext('2d')!;
    x.fillStyle = bg; x.fillRect(0, 0, spec.size, spec.size);
    const box = spec.size * spec.scale;
    const ratio = Math.min(box / (img.naturalWidth || 1), box / (img.naturalHeight || 1));
    const w = Math.round((img.naturalWidth || box) * ratio), h = Math.round((img.naturalHeight || box) * ratio);
    x.drawImage(img, Math.round((spec.size - w) / 2), Math.round((spec.size - h) / 2), w, h);
    out[spec.name] = c.toDataURL('image/png');
  }
  return out;
}
