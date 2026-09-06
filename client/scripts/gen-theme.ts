// Regenerates public/theme-init.js from src/lib/palettes.ts so the first
// paint and the app agree on every palette. Run: npm run gen:theme -w client
import { writeFileSync } from 'node:fs';
import { PALETTES } from '../src/lib/palettes';
const o: Record<string, unknown> = {};
for (const p of PALETTES) o[p.key] = { l: [p.light.accent, p.light.hover, p.light.soft, p.light.text, p.light.on], d: [p.dark.accent, p.dark.hover, p.dark.soft, p.dark.text, p.dark.on], g: p.gradient };
const lines = Object.entries(o).map(([k, v]) => `      ${k}: ${JSON.stringify(v).replace(/"/g, "'").replace(/,/g, ', ').replace(/:/g, ': ')}`).join(',\n');
const js = `// Runs before first paint: applies the saved theme, palette and glass level
// so the page never flashes the wrong colours. Mirrors state/theme.ts. The
// palette table is generated from src/lib/palettes.ts (npm run gen:theme).
(function () {
  try {
    var raw = localStorage.getItem('tern.appearance');
    var a = raw ? JSON.parse(raw) : {};
    var theme = a.theme || localStorage.getItem('tern.theme') || 'system';
    var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.glass = a.glass || 'balanced';
    root.dataset.motion = a.motion || 'full';
    root.dataset.background = a.background || 'mist';
    if (a.density === 'compact') root.dataset.density = 'compact';
    var P = {
${lines}
    };
    var p = P[a.palette] || P.ink; var t = dark ? p.d : p.l;
    root.style.setProperty('--accent', t[0]); root.style.setProperty('--accent-hover', t[1]); root.style.setProperty('--accent-soft', t[2]); root.style.setProperty('--accent-text', t[3]); root.style.setProperty('--on-accent', t[4]);
    var h = t[0].replace('#', ''); root.style.setProperty('--accent-rgb', parseInt(h.slice(0, 2), 16) + ', ' + parseInt(h.slice(2, 4), 16) + ', ' + parseInt(h.slice(4, 6), 16));
    for (var i = 0; i < 4; i++) root.style.setProperty('--g' + (i + 1), p.g[i]);
  } catch (e) {}
})();
`;
writeFileSync(new URL('../public/theme-init.js', import.meta.url), js);
console.log('wrote public/theme-init.js');
