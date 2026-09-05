import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace, FIT_STEPS } from './vectorize.js';
import { fitToBimi } from './svgTiny.js';

// A 40x40 image: red square top-left, blue circle bottom-right, transparent elsewhere.
function sample(size = 40) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    if (x < 16 && y < 16) { data[i] = 220; data[i + 1] = 30; data[i + 2] = 30; data[i + 3] = 255; }
    else if ((x - 28) ** 2 + (y - 28) ** 2 < 81) { data[i] = 30; data[i + 1] = 60; data[i + 2] = 220; data[i + 3] = 255; }
    else if (x > 30 && y < 4) { data[i] = 100; data[i + 1] = 100; data[i + 2] = 100; data[i + 3] = 40; } // nearly transparent noise: dropped
  }
  return { width: size, height: size, data };
}

test('trace turns pixels into closed paths per colour with even-odd fill', () => {
  const r = trace(sample(), { colors: 4, tolerance: 0.8, title: 'T <x>' });
  assert.ok(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 40 40"><title>T &lt;x&gt;</title>'));
  assert.equal(r.colors, 2, 'two opaque colours');
  assert.equal(r.paths, 2);
  assert.ok(/fill="#dc1e1e"/.test(r.svg) && /fill="#1e3cdc"/.test(r.svg), r.svg.slice(0, 300));
  // the square is an exact 16x16 loop
  assert.ok(r.svg.includes('d="M0,0L16,0L16,16L0,16Z"'), r.svg);
  assert.ok(!r.svg.includes('<image'));
  assert.ok(fitToBimi(r.svg).ok);
});

test('holes are preserved as separate loops', () => {
  const size = 20; const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ring = x >= 2 && x < 18 && y >= 2 && y < 18 && !(x >= 7 && x < 13 && y >= 7 && y < 13);
    const i = (y * size + x) * 4; if (ring) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255; }
  }
  const r = trace({ width: size, height: size, data }, { colors: 2, tolerance: 0.5 });
  const d = r.svg.match(/d="([^"]+)"/)![1];
  assert.equal((d.match(/M/g) ?? []).length, 2, 'outer loop and hole loop');
  assert.ok(r.svg.includes('fill-rule="evenodd"'));
});

test('background option and fit steps', () => {
  const r = trace(sample(), { colors: 3, tolerance: 1, background: '#ffffff' });
  assert.ok(r.svg.includes('<rect width="40" height="40" fill="#ffffff"/>'));
  assert.ok(FIT_STEPS[0].size > FIT_STEPS[FIT_STEPS.length - 1].size);
});
