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
// The shipped presets, one per model family, in the two modes a family has.
//
// Every number here is the vendor's own published recommendation, checked
// against what Ollama actually bakes into the model file rather than taken
// from a blog post. Where a vendor says nothing, that is said out loud rather
// than filled in with a plausible-looking value.
//
//   Qwen3.5   thinking      temp 1.0  top_p 0.95  top_k 20  min_p 0  presence 1.5
//             non-thinking  temp 0.7  top_p 0.8   top_k 20  min_p 0  presence 1.5
//             Qwen publishes both modes explicitly and states min_p = 0 for
//             each; Ollama bakes the *thinking* pair in as the model default,
//             which is the wrong one for a mail client answering straight.
//   Phi-4     no official recommendation exists. The technical report's own
//             evaluations use temperature 0.5, and the reasoning variants ask
//             for top_k 50 / top_p 0.95, so that is what is used here — and
//             labelled as inference rather than instruction.
//   Mistral   temp 0.15, which is the one number its model card gives and the
//             only parameter Ollama ships for it. Far lower than anything
//             else here, and it matters: measured at 0.7 this model scored
//             1/10 on subject lines and 0/10 on one-line summaries.
//
// `repeatPenalty` is 1.0 — off — wherever the vendor asks for a presence
// penalty instead: applying both stacks two different repetition controls on
// top of each other, which is how a model ends up avoiding words it needs.
export const BUILT_IN_PRESETS: AiPreset[] = [
  {
    id: 'builtin-balanced',
    name: 'Balanced (general)',
    note: "A safe general-purpose setting for a model with no published recommendation of its own: qwen2.5, llama3.2, gemma3 and the rest of the curated list. Thinking off.",
    builtIn: true,
    values: { temperature: 0.7, topP: 0.9, topK: 40, minP: 0, repeatPenalty: 1.1, repeatLastN: 256, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 1500, allowThinking: false },
  },
  {
    id: 'builtin-qwen35-fast',
    name: 'Qwen3.5 — straight answer',
    note: "Qwen's own published non-thinking numbers. The right setting for email: a draft in under a second rather than over a minute. This is what a Qwen3.5 install gets by default.",
    forModel: 'qwen3.5',
    builtIn: true,
    values: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, repeatPenalty: 1.0, repeatLastN: 256, presencePenalty: 1.5, frequencyPenalty: 0, maxTokens: 1500, allowThinking: false },
  },
  {
    id: 'builtin-qwen35-thinking',
    name: 'Qwen3.5 — thinking',
    note: "Qwen's own thinking numbers, with room to finish. Measured on long threads it is more accurate — 15 clean runs of 15, against 27 of 30 with thinking off — and slow: about 75 seconds before a word appears. Right for a responder working in the background, wrong for a composer somebody is watching.",
    forModel: 'qwen3.5',
    builtIn: true,
    values: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, repeatPenalty: 1.0, repeatLastN: 256, presencePenalty: 1.5, frequencyPenalty: 0, maxTokens: 1500, allowThinking: true, thinkEffort: 'medium', thinkingBudget: 16000 },
  },
  {
    id: 'builtin-phi4',
    name: 'Phi-4',
    note: 'Microsoft publish no sampling recommendation for Phi-4 and Ollama ships none. These are the numbers its own technical report evaluates at, plus the top-k and top-p its reasoning variants ask for. Inference rather than instruction, so treat them as a starting point.',
    forModel: 'phi4',
    builtIn: true,
    values: { temperature: 0.5, topP: 0.95, topK: 50, minP: 0, repeatPenalty: 1.1, repeatLastN: 256, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 1500, allowThinking: false },
  },
  {
    id: 'builtin-mistral-small',
    name: 'Mistral Small',
    note: 'Temperature 0.15, which is the single number Mistral publish for this model and the only parameter Ollama ships with it. Much lower than anything else here, and it matters: at 0.7 the model scored 1/10 on subject lines and 0/10 on one-line summaries.',
    forModel: 'mistral-small',
    builtIn: true,
    values: { temperature: 0.15, topP: 0.9, topK: 40, minP: 0, repeatPenalty: 1.05, repeatLastN: 256, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 1500, allowThinking: false },
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


// ---------- The tuning a fresh install starts with ----------
//
// The audit this exists for: Tern's shipped sampling defaults — temperature
// 0.7, top-p 0.9, top-k 40, repeat penalty 1.1 — are qwen2.5's numbers, and
// they were being applied to whatever model the install ended up running.
// An install that picked qwen3.5:4b got a model tuned for a different one,
// with no indication that anything was wrong and no reason for anybody to
// open the tuning panel. That is precisely the failure the product rules
// forbid: a default that is not good enough, hidden behind a knob.
//
// A preset already carries the right numbers per model. This makes the
// shipped default *be* that preset, chosen by the model the install is
// actually going to run, so the zero-config path gets the tuning its model
// asks for and the panel stays something nobody has to open.
//
// Matching is on the family rather than the exact tag, because "qwen3.5:4b",
// "qwen3.5:8b" and "qwen3.5:4b-instruct-q4_K_M" all want the same sampling.
export function defaultTuningFor(model: string): PresetValues {
  return presetFor(model, 'straight');
}

// The same choice, in the mode asked for. `thinking` falls back to the
// straight profile for a model that cannot reason, because pretending
// otherwise would hand somebody a thinking budget that does nothing.
export function presetFor(model: string, mode: 'straight' | 'thinking'): PresetValues {
  const m = String(model ?? '').toLowerCase();
  const byId = (id: string) => BUILT_IN_PRESETS.find((p) => p.id === id)!.values;
  if (/^qwen3\.?[5-9]/.test(m) || /^qwen[4-9]/.test(m)) {
    return byId(mode === 'thinking' ? 'builtin-qwen35-thinking' : 'builtin-qwen35-fast');
  }
  if (/^phi-?4/.test(m)) return byId('builtin-phi4');
  if (/^(mistral|devstral|magistral)/.test(m)) return byId('builtin-mistral-small');
  return byId('builtin-balanced');
}

// Whether a family has a distinct thinking profile at all. Used by the
// settings page so a model with one mode does not offer two.
export function hasThinkingProfile(model: string): boolean {
  return presetFor(model, 'thinking') !== presetFor(model, 'straight');
}

// Which shipped preset an install is currently sitting on, if any, so the
// settings route can tell whether the tuning has been touched by hand.
export function matchesPreset(values: PresetValues, preset: PresetValues): boolean {
  // Only the fields the preset actually states. A preset that says nothing
  // about `thinkEffort` is not claiming a value for it, so settings that have
  // one still match — the earlier version compared every field and therefore
  // matched nothing at all, which silently disabled the migration it exists
  // to enable: switching from qwen3.5 to mistral left qwen's numbers in place.
  return PRESET_FIELDS.every((k) => preset[k] === undefined || values[k] === preset[k]);
}
