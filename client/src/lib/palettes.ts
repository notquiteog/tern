// Colour palettes. Each has an accent set for light and dark surfaces, the
// colour drawn on top of the accent (buttons, badges), and four gradient
// colours the shader backgrounds mix. Adding one here is all it takes to
// offer it in Settings → Appearance; public/theme-init.js carries a copy for
// the first paint and is regenerated from this file (see docs/CUSTOMIZING.md).
export interface PaletteTones { accent: string; hover: string; soft: string; text: string; on: string }
export interface Palette { key: string; name: string; hint: string; light: PaletteTones; dark: PaletteTones; gradient: [string, string, string, string] }

export const PALETTES: Palette[] = [
  { key: 'ink', name: 'Ink', hint: 'black on white, the default', light: { accent: '#16181d', hover: '#000000', soft: '#eef0f3', text: '#16181d', on: '#ffffff' }, dark: { accent: '#f2f3f7', hover: '#ffffff', soft: '#262930', text: '#e6e8ee', on: '#0f1117' }, gradient: ['#2b3140', '#6b7280', '#a3adc2', '#dfe4ee'] },
  { key: 'graphite', name: 'Graphite', hint: 'cool grey', light: { accent: '#556080', hover: '#46506b', soft: '#e9ecf3', text: '#3b4560', on: '#ffffff' }, dark: { accent: '#9aa6c8', hover: '#b0bbd8', soft: '#232838', text: '#c5cde3', on: '#0f1117' }, gradient: ['#64748b', '#94a3b8', '#475569', '#7dd3fc'] },
  { key: 'slate', name: 'Slate', hint: 'blue-grey', light: { accent: '#475569', hover: '#334155', soft: '#e8ecf2', text: '#334155', on: '#ffffff' }, dark: { accent: '#94a3b8', hover: '#b0bcd0', soft: '#222a36', text: '#cbd5e1', on: '#0f1117' }, gradient: ['#334155', '#64748b', '#94a3b8', '#38bdf8'] },
  { key: 'indigo', name: 'Indigo', hint: 'classic blue-violet', light: { accent: '#4f6df5', hover: '#3f5be3', soft: '#e8edff', text: '#2f48c9', on: '#ffffff' }, dark: { accent: '#6d86ff', hover: '#8298ff', soft: '#1f2542', text: '#9fb0ff', on: '#ffffff' }, gradient: ['#4f6df5', '#8b5cf6', '#e0567b', '#0ea5b7'] },
  { key: 'arctic', name: 'Arctic', hint: 'icy blue', light: { accent: '#2563eb', hover: '#1d4fd7', soft: '#e4ecff', text: '#1e40af', on: '#ffffff' }, dark: { accent: '#7aa2ff', hover: '#93b4ff', soft: '#1c2743', text: '#b4c8ff', on: '#0f1117' }, gradient: ['#60a5fa', '#a5f3fc', '#e0f2fe', '#c7d2fe'] },
  { key: 'midnight', name: 'Midnight', hint: 'deep navy', light: { accent: '#1e3a8a', hover: '#172d6e', soft: '#e6e9f6', text: '#1e3a8a', on: '#ffffff' }, dark: { accent: '#8ea2ff', hover: '#a6b6ff', soft: '#1b2140', text: '#c3cdff', on: '#0f1117' }, gradient: ['#0f172a', '#1e3a8a', '#312e81', '#0ea5e9'] },
  { key: 'ocean', name: 'Ocean', hint: 'teal and blue', light: { accent: '#0e9fb5', hover: '#0b8a9d', soft: '#dff5f8', text: '#0a6f7e', on: '#ffffff' }, dark: { accent: '#2cc4dc', hover: '#4fd1e6', soft: '#12303a', text: '#8de3f0', on: '#0f1117' }, gradient: ['#0ea5b7', '#2563eb', '#14b8a6', '#7c3aed'] },
  { key: 'violet', name: 'Violet', hint: 'electric purple', light: { accent: '#7c5cff', hover: '#6a49ec', soft: '#eee9ff', text: '#5537d1', on: '#ffffff' }, dark: { accent: '#a58bff', hover: '#b9a4ff', soft: '#261f45', text: '#c9bbff', on: '#0f1117' }, gradient: ['#7c5cff', '#c084fc', '#22d3ee', '#f472b6'] },
  { key: 'lavender', name: 'Lavender', hint: 'soft purple', light: { accent: '#7c6cf0', hover: '#6a5ae0', soft: '#eeeafd', text: '#5648c4', on: '#ffffff' }, dark: { accent: '#a99cff', hover: '#bcb1ff', soft: '#26224a', text: '#cfc6ff', on: '#0f1117' }, gradient: ['#8b7cf6', '#c4b5fd', '#f5d0fe', '#a5f3fc'] },
  { key: 'rose', name: 'Rose', hint: 'pink and magenta', light: { accent: '#e0567b', hover: '#cb4467', soft: '#fde8ee', text: '#a8325a', on: '#ffffff' }, dark: { accent: '#ff7aa2', hover: '#ff94b5', soft: '#3a1f2a', text: '#ffb1c8', on: '#0f1117' }, gradient: ['#e0567b', '#f472b6', '#a855f7', '#fb7185'] },
  { key: 'sakura', name: 'Sakura', hint: 'blossom pink', light: { accent: '#db5f8f', hover: '#c94f7e', soft: '#fde9f1', text: '#a8386a', on: '#ffffff' }, dark: { accent: '#ff8fb8', hover: '#ffa6c7', soft: '#3a1f2c', text: '#ffc0d8', on: '#0f1117' }, gradient: ['#fbcfe8', '#f9a8d4', '#fda4af', '#e9d5ff'] },
  { key: 'sunset', name: 'Sunset', hint: 'orange to pink', light: { accent: '#e8603c', hover: '#d4502e', soft: '#fdebe4', text: '#b3411f', on: '#ffffff' }, dark: { accent: '#ff8a5c', hover: '#ffa07a', soft: '#3a2219', text: '#ffb899', on: '#0f1117' }, gradient: ['#f97316', '#ec4899', '#f59e0b', '#8b5cf6'] },
  { key: 'peach', name: 'Peach', hint: 'warm and soft', light: { accent: '#e8763e', hover: '#d5652f', soft: '#fdeee5', text: '#b2521f', on: '#ffffff' }, dark: { accent: '#ff9a6a', hover: '#ffb08a', soft: '#3b241a', text: '#ffc4a6', on: '#0f1117' }, gradient: ['#fb923c', '#fda4af', '#fcd34d', '#f9a8d4'] },
  { key: 'amber', name: 'Amber', hint: 'gold and red', light: { accent: '#d98a11', hover: '#c27a0c', soft: '#fdf1dc', text: '#9a5f06', on: '#ffffff' }, dark: { accent: '#f0b249', hover: '#f5c46f', soft: '#3a2d15', text: '#ffd28a', on: '#0f1117' }, gradient: ['#f59e0b', '#ef4444', '#f97316', '#fde047'] },
  { key: 'copper', name: 'Copper', hint: 'burnt orange', light: { accent: '#b45309', hover: '#9a4607', soft: '#fbeee0', text: '#7c3d05', on: '#ffffff' }, dark: { accent: '#f0a45a', hover: '#f5b877', soft: '#3a2a18', text: '#fbc98f', on: '#0f1117' }, gradient: ['#b45309', '#f59e0b', '#fbbf24', '#7c2d12'] },
  { key: 'forest', name: 'Forest', hint: 'green and teal', light: { accent: '#1f9d64', hover: '#188652', soft: '#e1f5eb', text: '#136b45', on: '#ffffff' }, dark: { accent: '#3ccf8a', hover: '#5fdca0', soft: '#14322a', text: '#8fe6bd', on: '#0f1117' }, gradient: ['#10b981', '#14b8a6', '#84cc16', '#0ea5b7'] },
  { key: 'mint', name: 'Mint', hint: 'fresh teal', light: { accent: '#0f9f8a', hover: '#0c8a77', soft: '#dcf7f1', text: '#0a7264', on: '#ffffff' }, dark: { accent: '#34d3b8', hover: '#5ee0c9', soft: '#123833', text: '#9df0dd', on: '#0f1117' }, gradient: ['#14b8a6', '#6ee7b7', '#a7f3d0', '#67e8f9'] },
  { key: 'lime', name: 'Lime', hint: 'bright green', light: { accent: '#4d7c0f', hover: '#3f6a0a', soft: '#ecf7dc', text: '#365314', on: '#ffffff' }, dark: { accent: '#a3e635', hover: '#bef264', soft: '#26330f', text: '#d9f99d', on: '#0f1117' }, gradient: ['#84cc16', '#bef264', '#4ade80', '#fde047'] },
];

// Backgrounds are grouped by mood so the calm ones (fit for a workday) come
// first and the showy ones are a deliberate choice.
export interface BackgroundOption { key: string; name: string; hint: string; mood: 'calm' | 'lively' | 'none' }
export const BACKGROUNDS: BackgroundOption[] = [
  { key: 'mist', name: 'Mist', hint: 'a barely-there haze, the default', mood: 'calm' },
  { key: 'silk', name: 'Silk', hint: 'slow folding fabric', mood: 'calm' },
  { key: 'halo', name: 'Halo', hint: 'breathing rings of light', mood: 'calm' },
  { key: 'horizon', name: 'Horizon', hint: 'a soft sunrise', mood: 'calm' },
  { key: 'topo', name: 'Topo', hint: 'drifting contour lines', mood: 'calm' },
  { key: 'dust', name: 'Dust', hint: 'motes floating in light', mood: 'calm' },
  { key: 'aurora', name: 'Aurora', hint: 'slow bands of light', mood: 'calm' },
  { key: 'orbs', name: 'Orbs', hint: 'soft bokeh', mood: 'calm' },
  { key: 'mesh', name: 'Mesh', hint: 'drifting colour blobs', mood: 'lively' },
  { key: 'liquid', name: 'Liquid', hint: 'merging drops', mood: 'lively' },
  { key: 'nebula', name: 'Nebula', hint: 'warped noise clouds', mood: 'lively' },
  { key: 'plasma', name: 'Plasma', hint: 'rolling colour waves', mood: 'lively' },
  { key: 'prism', name: 'Prism', hint: 'refracted light bands', mood: 'lively' },
  { key: 'waves', name: 'Waves', hint: 'glowing ribbons', mood: 'lively' },
  { key: 'grid', name: 'Grid', hint: 'moving glow grid', mood: 'lively' },
  { key: 'none', name: 'Plain', hint: 'flat colour, no motion', mood: 'none' },
];

export function paletteByKey(key: string): Palette {
  return PALETTES.find((p) => p.key === key) ?? PALETTES[0];
}
