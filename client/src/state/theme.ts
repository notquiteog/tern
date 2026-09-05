export type Theme = 'system' | 'light' | 'dark';
export function getTheme(): Theme { return (localStorage.getItem('tern.theme') as Theme) || 'system'; }
export function applyTheme(t: Theme) {
  localStorage.setItem('tern.theme', t);
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export function getDensity(): 'comfortable' | 'compact' { return (localStorage.getItem('tern.density') as any) || 'comfortable'; }
export function applyDensity(d: 'comfortable' | 'compact') {
  localStorage.setItem('tern.density', d);
  if (d === 'compact') document.documentElement.dataset.density = 'compact'; else delete document.documentElement.dataset.density;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'system') applyTheme('system'); });
