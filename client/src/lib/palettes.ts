// Colour palettes. Each has an accent set for light and dark surfaces plus
// four gradient colours the shader backgrounds mix. Adding one here is all
// it takes to offer it in Settings → Appearance.
export interface PaletteTones { accent: string; hover: string; soft: string; text: string }
export interface Palette { key: string; name: string; light: PaletteTones; dark: PaletteTones; gradient: [string, string, string, string] }

export const PALETTES: Palette[] = [
  { key: 'indigo', name: 'Indigo', light: { accent: '#4f6df5', hover: '#3f5be3', soft: '#e8edff', text: '#2f48c9' }, dark: { accent: '#6d86ff', hover: '#8298ff', soft: '#1f2542', text: '#9fb0ff' }, gradient: ['#4f6df5', '#8b5cf6', '#e0567b', '#0ea5b7'] },
  { key: 'ocean', name: 'Ocean', light: { accent: '#0e9fb5', hover: '#0b8a9d', soft: '#dff5f8', text: '#0a6f7e' }, dark: { accent: '#2cc4dc', hover: '#4fd1e6', soft: '#12303a', text: '#8de3f0' }, gradient: ['#0ea5b7', '#2563eb', '#14b8a6', '#7c3aed'] },
  { key: 'sunset', name: 'Sunset', light: { accent: '#e8603c', hover: '#d4502e', soft: '#fdebe4', text: '#b3411f' }, dark: { accent: '#ff8a5c', hover: '#ffa07a', soft: '#3a2219', text: '#ffb899' }, gradient: ['#f97316', '#ec4899', '#f59e0b', '#8b5cf6'] },
  { key: 'forest', name: 'Forest', light: { accent: '#1f9d64', hover: '#188652', soft: '#e1f5eb', text: '#136b45' }, dark: { accent: '#3ccf8a', hover: '#5fdca0', soft: '#14322a', text: '#8fe6bd' }, gradient: ['#10b981', '#14b8a6', '#84cc16', '#0ea5b7'] },
  { key: 'rose', name: 'Rose', light: { accent: '#e0567b', hover: '#cb4467', soft: '#fde8ee', text: '#a8325a' }, dark: { accent: '#ff7aa2', hover: '#ff94b5', soft: '#3a1f2a', text: '#ffb1c8' }, gradient: ['#e0567b', '#f472b6', '#a855f7', '#fb7185'] },
  { key: 'violet', name: 'Violet', light: { accent: '#7c5cff', hover: '#6a49ec', soft: '#eee9ff', text: '#5537d1' }, dark: { accent: '#a58bff', hover: '#b9a4ff', soft: '#261f45', text: '#c9bbff' }, gradient: ['#7c5cff', '#c084fc', '#22d3ee', '#f472b6'] },
  { key: 'amber', name: 'Amber', light: { accent: '#d98a11', hover: '#c27a0c', soft: '#fdf1dc', text: '#9a5f06' }, dark: { accent: '#f0b249', hover: '#f5c46f', soft: '#3a2d15', text: '#ffd28a' }, gradient: ['#f59e0b', '#ef4444', '#f97316', '#fde047'] },
  { key: 'graphite', name: 'Graphite', light: { accent: '#556080', hover: '#46506b', soft: '#e9ecf3', text: '#3b4560' }, dark: { accent: '#9aa6c8', hover: '#b0bbd8', soft: '#232838', text: '#c5cde3' }, gradient: ['#64748b', '#94a3b8', '#475569', '#7dd3fc'] },
];

export const BACKGROUNDS: { key: string; name: string; hint: string }[] = [
  { key: 'aurora', name: 'Aurora', hint: 'slow bands of light' },
  { key: 'mesh', name: 'Mesh', hint: 'drifting colour blobs' },
  { key: 'nebula', name: 'Nebula', hint: 'warped noise clouds' },
  { key: 'waves', name: 'Waves', hint: 'glowing ribbons' },
  { key: 'orbs', name: 'Orbs', hint: 'soft bokeh' },
  { key: 'grid', name: 'Grid', hint: 'moving glow grid' },
  { key: 'none', name: 'Plain', hint: 'flat colour, no motion' },
];

export function paletteByKey(key: string): Palette {
  return PALETTES.find((p) => p.key === key) ?? PALETTES[0];
}
