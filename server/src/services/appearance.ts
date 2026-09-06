// The look everyone starts with. Appearance is otherwise a personal
// setting kept in the browser, but a install wants a house style: the
// colours a new person sees before they have chosen anything, and on the
// sign-in page where there is no person yet.
//
// Two things an admin can do, and they are deliberately different:
//   - Save the default. Anyone who has never chosen picks it up. Someone who
//     set their own palette keeps it.
//   - Apply to everyone. Bumps `version`, and a browser that sees a newer
//     version drops what it had and takes the new default. That is the only
//     way to overrule a choice someone made, so it is its own button.
import { one, query } from '../db.js';

export type Theme = 'system' | 'light' | 'dark';
export type Glass = 'subtle' | 'balanced' | 'strong';
export type Motion = 'full' | 'reduced';
export type Density = 'comfortable' | 'compact';

export interface Appearance {
  theme: Theme;
  palette: string;
  background: string;
  glass: Glass;
  motion: Motion;
  density: Density;
  split: boolean;
}

// Ink on Mist, the same first impression the client ships with. Kept in step
// with client/src/state/theme.ts.
export const APPEARANCE_DEFAULTS: Appearance = {
  theme: 'system', palette: 'ink', background: 'mist',
  glass: 'balanced', motion: 'full', density: 'comfortable', split: true,
};

export interface AppearanceSettings { defaults: Appearance; version: number; updatedAt: string | null }

// Palette and background keys are open sets (the client's tables grow), so
// they are checked for shape rather than membership: a key that no longer
// exists falls back to the built-in default when the client reads it.
const KEY_RE = /^[a-z0-9-]{1,32}$/;

export function normalizeAppearance(input: unknown): Appearance {
  const v = (input ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback);
  const key = (value: unknown, fallback: string): string =>
    (typeof value === 'string' && KEY_RE.test(value) ? value : fallback);
  return {
    theme: pick(v.theme, ['system', 'light', 'dark'] as const, APPEARANCE_DEFAULTS.theme),
    palette: key(v.palette, APPEARANCE_DEFAULTS.palette),
    background: key(v.background, APPEARANCE_DEFAULTS.background),
    glass: pick(v.glass, ['subtle', 'balanced', 'strong'] as const, APPEARANCE_DEFAULTS.glass),
    motion: pick(v.motion, ['full', 'reduced'] as const, APPEARANCE_DEFAULTS.motion),
    density: pick(v.density, ['comfortable', 'compact'] as const, APPEARANCE_DEFAULTS.density),
    split: typeof v.split === 'boolean' ? v.split : APPEARANCE_DEFAULTS.split,
  };
}

export async function getAppearanceSettings(): Promise<AppearanceSettings> {
  const row = await one<{ value: Partial<AppearanceSettings>; updated_at: Date }>(`SELECT value, updated_at FROM settings WHERE key='appearance'`);
  const v = row?.value ?? {};
  return {
    defaults: normalizeAppearance(v.defaults),
    version: Number.isFinite(Number(v.version)) ? Number(v.version) : 0,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function saveAppearanceSettings(defaults: unknown, applyToEveryone: boolean): Promise<AppearanceSettings> {
  const current = await getAppearanceSettings();
  const next: Pick<AppearanceSettings, 'defaults' | 'version'> = {
    defaults: normalizeAppearance(defaults),
    version: current.version + (applyToEveryone ? 1 : 0),
  };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('appearance', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(next)],
  );
  // Appearance lives in two places: the browser, and a copy in each person's
  // prefs so it follows them to a new device. The version bump clears the
  // first; without clearing the second, that copy would be adopted on the
  // next sign-in and quietly undo what the admin just did.
  if (applyToEveryone) await query(`UPDATE users SET prefs = prefs - 'appearance' WHERE prefs ? 'appearance'`);
  return { ...next, updatedAt: new Date().toISOString() };
}

// What the sign-in page and every first paint need, and nothing more.
export function publicAppearance(s: AppearanceSettings): { defaults: Appearance; version: number } {
  return { defaults: s.defaults, version: s.version };
}
