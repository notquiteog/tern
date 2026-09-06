// What the background reacts to besides the cursor: the time of day, and the
// kind of mail being looked at.
//
// Every shader reads the same four palette colours through `u_c`, so the
// adjustment is made to those colours rather than inside fifteen fragment
// shaders. A shader that wants the raw values still gets `u_tod` and
// `u_mood` as uniforms.
//
// The shifts are deliberately small. This is the surface behind someone's
// mail, and a background that announces the hour is a background that gets
// turned off.

export type Mood = 'neutral' | 'primary' | 'transactions' | 'updates' | 'promotions';

export type RGB = [number, number, number];

// Where each mood pulls the palette. Chosen to agree with the category tabs:
// receipts read green, notifications blue, marketing amber, people untouched.
const MOOD_TINT: Record<Mood, { hue: RGB; amount: number }> = {
  neutral: { hue: [0.5, 0.5, 0.5], amount: 0 },
  primary: { hue: [0.5, 0.5, 0.5], amount: 0 },
  transactions: { hue: [0.13, 0.72, 0.52], amount: 0.14 },
  updates: { hue: [0.29, 0.55, 0.93], amount: 0.14 },
  promotions: { hue: [0.96, 0.65, 0.14], amount: 0.14 },
};

// How warm the light is at a given hour, from -1 (cool, the small hours) to
// +1 (warm, sunrise and sunset). Two peaks a day, a trough at night and a
// neutral middle, so it moves the way daylight does rather than sliding one
// way from midnight to midnight.
export function warmthAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  // Peaks near 07:00 and 19:00, lowest around 02:00 and flat-ish at noon.
  const dawn = Math.exp(-((h - 7) ** 2) / 8);
  const dusk = Math.exp(-((h - 19) ** 2) / 10);
  const night = h < 5 || h >= 22 ? 1 : 0;
  return Math.max(-1, Math.min(1, dawn + dusk - night * 0.85));
}

// The clock as a 0..1 position through the day, for shaders that want it.
export function dayFraction(d: Date = new Date()): number {
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86_400;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// One colour, warmed or cooled and pulled towards the mood.
export function tintColor(c: RGB, warmth: number, mood: Mood, strength = 1): RGB {
  const w = Math.max(-1, Math.min(1, warmth)) * 0.09 * strength;
  // Warm lifts red and drops blue; cool does the reverse. Green is moved half
  // as far so skin-adjacent hues do not go magenta.
  let out: RGB = [clamp01(c[0] + w), clamp01(c[1] + w * 0.35), clamp01(c[2] - w)];
  const { hue, amount } = MOOD_TINT[mood] ?? MOOD_TINT.neutral;
  const t = amount * strength;
  if (t > 0) out = [mix(out[0], hue[0], t), mix(out[1], hue[1], t), mix(out[2], hue[2], t)] as RGB;
  return out;
}

// The four palette stops the shaders mix, adjusted together.
export function tintPalette(colors: RGB[], opts: { hour?: number; mood?: Mood; strength?: number } = {}): RGB[] {
  const warmth = warmthAt(opts.hour ?? new Date().getHours());
  const mood = opts.mood ?? 'neutral';
  const strength = opts.strength ?? 1;
  if (warmth === 0 && mood === 'neutral') return colors;
  return colors.map((c) => tintColor(c, warmth, mood, strength));
}

// The mood is set by whatever the person is looking at and read by the
// background, which is mounted once at the top of the shell. A tiny store
// rather than context: the background is not in anyone's render tree.
let current: Mood = 'neutral';
const listeners = new Set<(m: Mood) => void>();

export function getMood(): Mood { return current; }
export function setMood(m: Mood): void {
  if (m === current) return;
  current = m;
  for (const l of listeners) l(m);
}
export function onMood(fn: (m: Mood) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
