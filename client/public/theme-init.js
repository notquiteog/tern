// Runs before first paint: applies the saved theme, palette and glass level
// so the page never flashes the wrong colours. Mirrors state/theme.ts. The
// palette table is generated from src/lib/palettes.ts (npm run gen:theme).
(function () {
  try {
    // Three layers, same order as state/theme.ts: what Tern ships with, the
    // install's default cached from /api/setup/status, then this person's own
    // choices. Reading them here keeps the first paint from flashing.
    var house = {};
    try { house = (JSON.parse(localStorage.getItem('tern.appearance.house') || '{}').defaults) || {}; } catch (e) { house = {}; }
    var mine = {};
    try { mine = JSON.parse(localStorage.getItem('tern.appearance') || '{}') || {}; } catch (e) { mine = {}; }
    var a = {};
    for (var hk in house) a[hk] = house[hk];
    for (var mk in mine) a[mk] = mine[mk];
    var theme = a.theme || localStorage.getItem('tern.theme') || 'system';
    var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.glass = a.glass || 'balanced';
    root.dataset.motion = a.motion || 'full';
    root.dataset.background = a.background || 'mist';
    if (a.density === 'compact') root.dataset.density = 'compact';
    var P = {
      ink: {'l': ['#16181d', '#000000', '#eef0f3', '#16181d', '#ffffff'], 'd': ['#f2f3f7', '#ffffff', '#262930', '#e6e8ee', '#0f1117'], 'g': ['#2b3140', '#6b7280', '#a3adc2', '#dfe4ee']},
      graphite: {'l': ['#556080', '#46506b', '#e9ecf3', '#3b4560', '#ffffff'], 'd': ['#9aa6c8', '#b0bbd8', '#232838', '#c5cde3', '#0f1117'], 'g': ['#64748b', '#94a3b8', '#475569', '#7dd3fc']},
      slate: {'l': ['#475569', '#334155', '#e8ecf2', '#334155', '#ffffff'], 'd': ['#94a3b8', '#b0bcd0', '#222a36', '#cbd5e1', '#0f1117'], 'g': ['#334155', '#64748b', '#94a3b8', '#38bdf8']},
      indigo: {'l': ['#4867f5', '#3255f4', '#e8edff', '#2f48c9', '#ffffff'], 'd': ['#6d86ff', '#8298ff', '#1f2542', '#9fb0ff', '#0f1117'], 'g': ['#4f6df5', '#8b5cf6', '#e0567b', '#0ea5b7']},
      arctic: {'l': ['#2563eb', '#1d4fd7', '#e4ecff', '#1e40af', '#ffffff'], 'd': ['#7aa2ff', '#93b4ff', '#1c2743', '#b4c8ff', '#0f1117'], 'g': ['#60a5fa', '#a5f3fc', '#e0f2fe', '#c7d2fe']},
      midnight: {'l': ['#1e3a8a', '#172d6e', '#e6e9f6', '#1e3a8a', '#ffffff'], 'd': ['#8ea2ff', '#a6b6ff', '#1b2140', '#c3cdff', '#0f1117'], 'g': ['#0f172a', '#1e3a8a', '#312e81', '#0ea5e9']},
      ocean: {'l': ['#0b8091', '#0a7180', '#dff5f8', '#0a6f7e', '#ffffff'], 'd': ['#2cc4dc', '#4fd1e6', '#12303a', '#8de3f0', '#0f1117'], 'g': ['#0ea5b7', '#2563eb', '#14b8a6', '#7c3aed']},
      violet: {'l': ['#7857ff', '#6640ff', '#eee9ff', '#5537d1', '#ffffff'], 'd': ['#a58bff', '#b9a4ff', '#261f45', '#c9bbff', '#0f1117'], 'g': ['#7c5cff', '#c084fc', '#22d3ee', '#f472b6']},
      lavender: {'l': ['#705eef', '#604bed', '#eeeafd', '#5648c4', '#ffffff'], 'd': ['#a99cff', '#bcb1ff', '#26224a', '#cfc6ff', '#0f1117'], 'g': ['#8b7cf6', '#c4b5fd', '#f5d0fe', '#a5f3fc']},
      rose: {'l': ['#d9315e', '#c5244f', '#fde8ee', '#a8325a', '#ffffff'], 'd': ['#ff7aa2', '#ff94b5', '#3a1f2a', '#ffb1c8', '#0f1117'], 'g': ['#e0567b', '#f472b6', '#a855f7', '#fb7185']},
      sakura: {'l': ['#d23773', '#bf2b64', '#fde9f1', '#a8386a', '#ffffff'], 'd': ['#ff8fb8', '#ffa6c7', '#3a1f2c', '#ffc0d8', '#0f1117'], 'g': ['#fbcfe8', '#f9a8d4', '#fda4af', '#e9d5ff']},
      sunset: {'l': ['#d54119', '#bc3916', '#fdebe4', '#b3411f', '#ffffff'], 'd': ['#ff8a5c', '#ffa07a', '#3a2219', '#ffb899', '#0f1117'], 'g': ['#f97316', '#ec4899', '#f59e0b', '#8b5cf6']},
      peach: {'l': ['#c75118', '#ae4715', '#fdeee5', '#b2521f', '#ffffff'], 'd': ['#ff9a6a', '#ffb08a', '#3b241a', '#ffc4a6', '#0f1117'], 'g': ['#fb923c', '#fda4af', '#fcd34d', '#f9a8d4']},
      amber: {'l': ['#a3670d', '#905b0b', '#fdf1dc', '#9a5f06', '#ffffff'], 'd': ['#f0b249', '#f5c46f', '#3a2d15', '#ffd28a', '#0f1117'], 'g': ['#f59e0b', '#ef4444', '#f97316', '#fde047']},
      copper: {'l': ['#b45309', '#9a4607', '#fbeee0', '#7c3d05', '#ffffff'], 'd': ['#f0a45a', '#f5b877', '#3a2a18', '#fbc98f', '#0f1117'], 'g': ['#b45309', '#f59e0b', '#fbbf24', '#7c2d12']},
      forest: {'l': ['#1a8655', '#17754a', '#e1f5eb', '#136b45', '#ffffff'], 'd': ['#3ccf8a', '#5fdca0', '#14322a', '#8fe6bd', '#0f1117'], 'g': ['#10b981', '#14b8a6', '#84cc16', '#0ea5b7']},
      mint: {'l': ['#0c8372', '#0b7566', '#dcf7f1', '#0a7264', '#ffffff'], 'd': ['#34d3b8', '#5ee0c9', '#123833', '#9df0dd', '#0f1117'], 'g': ['#14b8a6', '#6ee7b7', '#a7f3d0', '#67e8f9']},
      lime: {'l': ['#4d7c0f', '#3f6a0a', '#ecf7dc', '#365314', '#ffffff'], 'd': ['#a3e635', '#bef264', '#26330f', '#d9f99d', '#0f1117'], 'g': ['#84cc16', '#bef264', '#4ade80', '#fde047']},
      crimson: {'l': ['#c62b47', '#ab2039', '#fde7eb', '#9c1e35', '#ffffff'], 'd': ['#ff7089', '#ff8b9f', '#3b1a23', '#ffb0bf', '#0f1117'], 'g': ['#c62b47', '#f43f5e', '#fb7185', '#7f1d1d']},
      coral: {'l': ['#c9412f', '#b03828', '#fdeae7', '#ab3527', '#ffffff'], 'd': ['#ff8a76', '#ffa08f', '#3b2019', '#ffbbaa', '#0f1117'], 'g': ['#fb7185', '#fb923c', '#fda4af', '#fcd34d']},
      bronze: {'l': ['#8f6224', '#7a521c', '#f8f0e2', '#7a5318', '#ffffff'], 'd': ['#dfb173', '#e9c48f', '#352a19', '#f0d2a5', '#0f1117'], 'g': ['#b45309', '#d97706', '#a16207', '#78350f']},
      olive: {'l': ['#63711f', '#525e18', '#f1f4e0', '#55611f', '#ffffff'], 'd': ['#c3d465', '#d3e185', '#2a3016', '#dfe9a5', '#0f1117'], 'g': ['#65a30d', '#a3a635', '#4d7c0f', '#bef264']},
      emerald: {'l': ['#0d7f57', '#0a6b49', '#e0f5ec', '#0b6b49', '#ffffff'], 'd': ['#34d399', '#5fe0b0', '#123329', '#99edc8', '#0f1117'], 'g': ['#10b981', '#34d399', '#059669', '#a7f3d0']},
      cobalt: {'l': ['#1d5fd0', '#1750b4', '#e5edfd', '#1a4fae', '#ffffff'], 'd': ['#7fa7ff', '#9abaff', '#1a2540', '#b9ccff', '#0f1117'], 'g': ['#1d4ed8', '#3b82f6', '#60a5fa', '#1e40af']},
      plum: {'l': ['#8a3d86', '#763372', '#f7e9f6', '#74316f', '#ffffff'], 'd': ['#d78fd2', '#e3a8de', '#331b32', '#ecc0e8', '#0f1117'], 'g': ['#a21caf', '#c026d3', '#7e22ce', '#f0abfc']},
      magenta: {'l': ['#b52483', '#9c1c70', '#fce7f4', '#9c1d72', '#ffffff'], 'd': ['#f778c4', '#fa93d1', '#3a1930', '#fcb5de', '#0f1117'], 'g': ['#db2777', '#e879f9', '#f472b6', '#a21caf']}
    };
    var p = P[a.palette] || P.ink; var t = dark ? p.d : p.l;
    root.style.setProperty('--accent', t[0]); root.style.setProperty('--accent-hover', t[1]); root.style.setProperty('--accent-soft', t[2]); root.style.setProperty('--accent-text', t[3]); root.style.setProperty('--on-accent', t[4]);
    var h = t[0].replace('#', ''); root.style.setProperty('--accent-rgb', parseInt(h.slice(0, 2), 16) + ', ' + parseInt(h.slice(2, 4), 16) + ', ' + parseInt(h.slice(4, 6), 16));
    for (var i = 0; i < 4; i++) root.style.setProperty('--g' + (i + 1), p.g[i]);
  } catch (e) {}
})();
