// Tuning presets.
//
// One model does not want the settings another model wants, and a reasoning
// model does not want the settings it wants itself with thinking turned off:
// Qwen3.5 asks for temperature 1.0 and top-p 0.95 while it reasons, and 0.7
// with top-p 0.8 when it answers straight. Rather than making an admin
// remember that, the numbers travel together under a name.
//
// A preset carries how the model writes — sampling, and whether it thinks —
// and nothing about the machine: the context window, the keep-alive and the
// provider stay where they are, because they are decisions about memory and
// hardware, not about writing, and a preset that quietly resized the context
// would resize every parallel slot with it.
import { one, query } from '../db.js';
import type { AiSettings } from './llm.js';

export const PRESET_FIELDS = ['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'repeatLastN', 'presencePenalty', 'frequencyPenalty', 'maxTokens', 'allowThinking', 'thinkEffort', 'thinkingBudget'] as const;
export type PresetField = typeof PRESET_FIELDS[number];
export type PresetValues = Partial<Pick<AiSettings, PresetField>>;

export interface AiPreset {
  id: string;
  name: string;
  // What it is for, in a sentence. Shown under the picker.
  note: string;
  // The model these numbers were written for, if any. A label and a badge —
  // applying a preset never changes which model is in use, because that is a
  // download and a reload, not a tuning change.
  forModel?: string;
  // Shipped with Tern: applied and copied freely, never edited or deleted.
  builtIn?: boolean;
  values: PresetValues;
}

// The shipped presets. The Qwen3.5 numbers are that model's own published
// recommendations for general use — and the same ones Ollama bakes into its
// model file — not something tuned here by guesswork: temperature 1.0 with
// top-p 0.95 while it reasons, 0.7 with top-p 0.8 when it does not, top-k 20
// and a presence penalty of 1.5 either way, with the repeat penalty left off
// at 1.0 because on this model the presence penalty is what does that work.
export const BUILT_IN_PRESETS: AiPreset[] = [
  {
    id: 'builtin-balanced',
    name: 'Balanced (small models)',
    note: "Tern's own defaults. A good starting point for qwen2.5, llama3.2, gemma3 and anything else in the curated list, thinking off.",
    builtIn: true,
    values: { temperature: 0.7, topP: 0.9, topK: 40, minP: 0, repeatPenalty: 1.1, repeatLastN: 256, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 700, allowThinking: false },
  },
  {
    id: 'builtin-qwen35-fast',
    name: 'Qwen3.5 — straight answer',
    note: 'Qwen3.5 with thinking off: what it asks for in non-thinking mode. The setting to use for email on a CPU-only box — a draft in seconds rather than minutes.',
    forModel: 'qwen3.5:4b',
    builtIn: true,
    values: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, repeatPenalty: 1.0, repeatLastN: 256, presencePenalty: 1.5, frequencyPenalty: 0, maxTokens: 700, allowThinking: false },
  },
  {
    id: 'builtin-qwen35-thinking',
    name: 'Qwen3.5 — thinking',
    note: 'Qwen3.5 while it reasons: the wider sampling it asks for in thinking mode, with room to work out an answer before writing it. Several times slower without a GPU, and worth it for a reply that has to weigh a long thread.',
    forModel: 'qwen3.5:4b',
    builtIn: true,
    values: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, repeatPenalty: 1.0, repeatLastN: 256, presencePenalty: 1.5, frequencyPenalty: 0, maxTokens: 700, allowThinking: true, thinkEffort: 'medium', thinkingBudget: 3000 },
  },
];

// Only the fields a preset is allowed to carry, and only the ones it set.
// Anything else in a stored preset — from an older version, or from a
// hand-edited row — is dropped rather than applied.
export function presetValues(input: unknown): PresetValues {
  const out: Record<string, unknown> = {};
  const v = (input ?? {}) as Record<string, unknown>;
  for (const k of PRESET_FIELDS) if (v[k] !== undefined) out[k] = v[k];
  return out as PresetValues;
}

// A readable id that stays stable while a name is edited, and never collides
// with a shipped one.
export function presetId(name: string, taken: string[]): string {
  const base = `p-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'preset'}`;
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

async function stored(): Promise<AiPreset[]> {
  const row = await one<{ value: { presets?: AiPreset[] } }>(`SELECT value FROM settings WHERE key='ai_presets'`);
  const list = Array.isArray(row?.value?.presets) ? row!.value!.presets! : [];
  return list
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    .map((p) => ({ id: p.id, name: p.name, note: String(p.note ?? ''), forModel: p.forModel || undefined, values: presetValues(p.values) }));
}

async function put(list: AiPreset[]): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('ai_presets', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify({ presets: list })],
  );
}

// Shipped first, then the install's own, in the order they were made.
export async function listPresets(): Promise<AiPreset[]> {
  return [...BUILT_IN_PRESETS, ...(await stored())];
}

export async function createPreset(p: { name: string; note?: string; forModel?: string; values: PresetValues }): Promise<AiPreset[]> {
  const custom = await stored();
  const preset: AiPreset = {
    id: presetId(p.name, [...BUILT_IN_PRESETS.map((b) => b.id), ...custom.map((c) => c.id)]),
    name: p.name.trim(),
    note: (p.note ?? '').trim(),
    forModel: p.forModel?.trim() || undefined,
    values: presetValues(p.values),
  };
  await put([...custom, preset]);
  return [...BUILT_IN_PRESETS, ...custom, preset];
}

export async function updatePreset(id: string, p: { name?: string; note?: string; forModel?: string; values?: PresetValues }): Promise<AiPreset[]> {
  if (BUILT_IN_PRESETS.some((b) => b.id === id)) throw new Error('A shipped preset cannot be edited. Save a copy under your own name instead.');
  const custom = await stored();
  const i = custom.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('No such preset');
  custom[i] = {
    ...custom[i],
    name: p.name?.trim() || custom[i].name,
    note: p.note === undefined ? custom[i].note : p.note.trim(),
    forModel: p.forModel === undefined ? custom[i].forModel : (p.forModel.trim() || undefined),
    values: p.values === undefined ? custom[i].values : presetValues(p.values),
  };
  await put(custom);
  return [...BUILT_IN_PRESETS, ...custom];
}

export async function deletePreset(id: string): Promise<AiPreset[]> {
  if (BUILT_IN_PRESETS.some((b) => b.id === id)) throw new Error('A shipped preset cannot be deleted.');
  const custom = await stored();
  if (!custom.some((c) => c.id === id)) throw new Error('No such preset');
  const left = custom.filter((c) => c.id !== id);
  await put(left);
  return [...BUILT_IN_PRESETS, ...left];
}
