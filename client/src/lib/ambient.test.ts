// The background follows the hour and the category. Both shifts have to stay
// small and stay in range: this is the surface behind someone's mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayFraction, tintColor, tintPalette, warmthAt, type RGB } from './ambient';

test('warmth peaks around sunrise and sunset, not at midnight', () => {
  const dawn = warmthAt(7), noon = warmthAt(12), dusk = warmthAt(19), night = warmthAt(2);
  assert.ok(dawn > noon, 'dawn should be warmer than noon');
  assert.ok(dusk > noon, 'dusk should be warmer than noon');
  assert.ok(night < 0, 'the small hours should be cool');
  assert.ok(night < noon);
});

test('warmth stays in range at every hour, including nonsense ones', () => {
  for (let h = -25; h <= 49; h++) {
    const w = warmthAt(h);
    assert.ok(w >= -1 && w <= 1, `hour ${h} gave ${w}`);
    assert.ok(Number.isFinite(w));
  }
});

test('a tinted colour stays a colour', () => {
  // Channels must not leave 0..1, or the shader draws bands of pure white.
  for (const c of [[0, 0, 0], [1, 1, 1], [0.5, 0.2, 0.9]] as RGB[]) {
    for (const h of [0, 7, 12, 19, 23]) {
      for (const mood of ['neutral', 'transactions', 'updates', 'promotions'] as const) {
        const out = tintColor(c, warmthAt(h), mood);
        assert.equal(out.length, 3);
        for (const v of out) assert.ok(v >= 0 && v <= 1, `${v} out of range for ${mood} at ${h}`);
      }
    }
  }
});

test('the shift is small enough to be a mood and not a filter', () => {
  const c: RGB = [0.5, 0.5, 0.5];
  const warmed = tintColor(c, 1, 'neutral');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(warmed[i] - c[i]) <= 0.1, 'warmth moved a channel too far');
  const tinted = tintColor(c, 0, 'promotions');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(tinted[i] - c[i]) <= 0.15, 'mood moved a channel too far');
});

test('neutral at a neutral hour changes nothing at all', () => {
  const palette: RGB[] = [[0.2, 0.3, 0.4], [0.5, 0.5, 0.5]];
  // warmthAt returns exactly 0 only by coincidence, so this pins the
  // short-circuit that keeps the common case free.
  const same = tintPalette(palette, { hour: 12, mood: 'neutral', strength: 0 });
  assert.deepEqual(same, palette);
});

test('primary is left alone; the other three are not', () => {
  const c: RGB = [0.5, 0.5, 0.5];
  assert.deepEqual(tintColor(c, 0, 'primary'), c);
  for (const mood of ['transactions', 'updates', 'promotions'] as const) {
    assert.notDeepEqual(tintColor(c, 0, mood), c);
  }
});

test('the day fraction runs from 0 to just under 1', () => {
  assert.equal(dayFraction(new Date(2026, 0, 1, 0, 0, 0)), 0);
  assert.equal(dayFraction(new Date(2026, 0, 1, 12, 0, 0)), 0.5);
  const end = dayFraction(new Date(2026, 0, 1, 23, 59, 59));
  assert.ok(end > 0.999 && end < 1);
});
