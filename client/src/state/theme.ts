// Appearance state: theme (system/light/dark), palette, shader background,
// glass intensity, motion and density. Applied as CSS custom properties on
// <html> so every component and the shader read the same values. Stored in
// localStorage for instant first paint (public/theme-init.js reads the same
// keys) and mirrored to the user's server-side prefs so it follows them.
import { paletteByKey } from '../lib/palettes';

export type Theme = 'system' | 'light' | 'dark';
export type Glass = 'subtle' | 'balanced' | 'strong';
export type Motion = 'full' | 'reduced';
export interface Appearance { theme: Theme; palette: string; background: string; glass: Glass; motion: Motion; density: 'comfortable' | 'compact'; split: boolean }

// Ink on Mist: monochrome accents over a barely moving haze. Anyone who
// chose something before keeps it; this only decides the first impression.
const DEFAULTS: Appearance = { theme: 'system', palette: 'ink', background: 'mist', glass: 'balanced', motion: 'full', density: 'comfortable', split: true };
const KEY = 'tern.appearance';
const listeners = new Set<(a: Appearance) => void>();

export function getAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    const legacyTheme = localStorage.getItem('tern.theme') as Theme | null;
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...DEFAULTS, ...(legacyTheme ? { theme: legacyTheme } : {}), ...parsed };
  } catch { return { ...DEFAULTS }; }
}

export function isDark(theme: Theme = getAppearance().theme): boolean {
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function applyAppearance(a: Appearance = getAppearance()): void {
  const root = document.documentElement;
  const dark = isDark(a.theme);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.glass = a.glass;
  root.dataset.motion = a.motion;
  root.dataset.background = a.background;
  if (a.density === 'compact') root.dataset.density = 'compact'; else delete root.dataset.density;
  const p = paletteByKey(a.palette);
  const t = dark ? p.dark : p.light;
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-hover', t.hover);
  root.style.setProperty('--accent-soft', t.soft);
  root.style.setProperty('--accent-text', t.text);
  root.style.setProperty('--on-accent', t.on);
  root.style.setProperty('--accent-rgb', hexToRgb(t.accent).join(', '));
  p.gradient.forEach((c, i) => root.style.setProperty(`--g${i + 1}`, c));
  for (const l of listeners) l(a);
}

export function setAppearance(patch: Partial<Appearance>, sync = true): Appearance {
  const next = { ...getAppearance(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); localStorage.setItem('tern.theme', next.theme); } catch { /* ignore */ }
  applyAppearance(next);
  if (sync) {
    // Best effort; the server copy is only used to restore on a new device.
    fetch('/api/auth/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tern' }, credentials: 'same-origin', body: JSON.stringify({ appearance: next }) }).catch(() => {});
  }
  return next;
}

// On sign-in, adopt the server copy if this browser has never chosen anything.
export function adoptServerAppearance(serverPrefs: Record<string, unknown> | undefined): void {
  const server = serverPrefs?.appearance as Partial<Appearance> | undefined;
  if (!server) return;
  let local: string | null = null;
  try { local = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (!local) setAppearance(server, false);
}

export function onAppearance(fn: (a: Appearance) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getAppearance().theme === 'system') applyAppearance(); });

// Back-compat helpers used by older call sites.
export function getTheme(): Theme { return getAppearance().theme; }
export function applyTheme(t: Theme): void { setAppearance({ theme: t }); }
export function getDensity(): 'comfortable' | 'compact' { return getAppearance().density; }
export function applyDensity(d: 'comfortable' | 'compact'): void { setAppearance({ density: d }); }
