// Runs before first paint: applies the saved theme, palette and glass level
// so the page never flashes the wrong colours. Mirrors state/theme.ts.
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
    root.dataset.background = a.background || 'aurora';
    if (a.density === 'compact') root.dataset.density = 'compact';
    var P = {
      indigo: { l: ['#4f6df5', '#3f5be3', '#e8edff', '#2f48c9'], d: ['#6d86ff', '#8298ff', '#1f2542', '#9fb0ff'], g: ['#4f6df5', '#8b5cf6', '#e0567b', '#0ea5b7'] },
      ocean: { l: ['#0e9fb5', '#0b8a9d', '#dff5f8', '#0a6f7e'], d: ['#2cc4dc', '#4fd1e6', '#12303a', '#8de3f0'], g: ['#0ea5b7', '#2563eb', '#14b8a6', '#7c3aed'] },
      sunset: { l: ['#e8603c', '#d4502e', '#fdebe4', '#b3411f'], d: ['#ff8a5c', '#ffa07a', '#3a2219', '#ffb899'], g: ['#f97316', '#ec4899', '#f59e0b', '#8b5cf6'] },
      forest: { l: ['#1f9d64', '#188652', '#e1f5eb', '#136b45'], d: ['#3ccf8a', '#5fdca0', '#14322a', '#8fe6bd'], g: ['#10b981', '#14b8a6', '#84cc16', '#0ea5b7'] },
      rose: { l: ['#e0567b', '#cb4467', '#fde8ee', '#a8325a'], d: ['#ff7aa2', '#ff94b5', '#3a1f2a', '#ffb1c8'], g: ['#e0567b', '#f472b6', '#a855f7', '#fb7185'] },
      violet: { l: ['#7c5cff', '#6a49ec', '#eee9ff', '#5537d1'], d: ['#a58bff', '#b9a4ff', '#261f45', '#c9bbff'], g: ['#7c5cff', '#c084fc', '#22d3ee', '#f472b6'] },
      amber: { l: ['#d98a11', '#c27a0c', '#fdf1dc', '#9a5f06'], d: ['#f0b249', '#f5c46f', '#3a2d15', '#ffd28a'], g: ['#f59e0b', '#ef4444', '#f97316', '#fde047'] },
      graphite: { l: ['#556080', '#46506b', '#e9ecf3', '#3b4560'], d: ['#9aa6c8', '#b0bbd8', '#232838', '#c5cde3'], g: ['#64748b', '#94a3b8', '#475569', '#7dd3fc'] }
    };
    var p = P[a.palette] || P.indigo; var t = dark ? p.d : p.l;
    root.style.setProperty('--accent', t[0]); root.style.setProperty('--accent-hover', t[1]); root.style.setProperty('--accent-soft', t[2]); root.style.setProperty('--accent-text', t[3]);
    var h = t[0].replace('#', ''); root.style.setProperty('--accent-rgb', parseInt(h.slice(0, 2), 16) + ', ' + parseInt(h.slice(2, 4), 16) + ', ' + parseInt(h.slice(4, 6), 16));
    for (var i = 0; i < 4; i++) root.style.setProperty('--g' + (i + 1), p.g[i]);
  } catch (e) {}
})();
