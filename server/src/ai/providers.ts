// The hosts a model connection can be pointed at, and the embedders worth
// naming across all of them.
//
// ── Why a catalogue, when the setting is already a shape and an address ─────
//
// Because that pair is correct and unhelpful. `endpoint.ts` is right that
// `openai` means "the OpenAI-compatible request shape" rather than a company —
// it is what Groq, OpenRouter, Together, Fireworks, NanoGPT, vLLM and perch's
// own /v1 all serve, and encoding a vendor there would have made a vLLM in
// somebody's rack a special case. But the cost of that correctness lands on an
// admin looking at an empty URL box who has to know that Groq lives at
// `https://api.groq.com/openai/v1` and that Together drops the `openai`
// segment. Every one of those is a 404 that Admin → AI model reports as
// "unreachable", which sends somebody to check a firewall over a typo.
//
// So the settings stay shapes and this is a list of starting points. Choosing
// one fills the shape and the address in and then gets out of the way: nothing
// here is stored, nothing validates against it, and the address stays editable
// afterwards. A host that is not on this list is configured exactly as it
// always was — an allowlist of vendors would be a worse product, and this
// install in particular should not be shipping one.

import type { ApiShape } from './endpoint.js';

/** Which kind of model a host can serve, in Tern's own words for the slots. */
export type Slot = 'llm' | 'embed' | 'stt';

export interface ProviderPreset {
  id: string;
  label: string;
  /** A value of the endpoint's `provider` enum. This list adds no new concept. */
  shape: ApiShape;
  baseUrl: string;
  /** The slots this host can actually fill, so a card does not offer the rest. */
  slots: Slot[];
  /** Whether a key is needed, for the hint beside the field. */
  key: 'none' | 'required';
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    shape: 'ollama',
    // The bundled container over the compose network. An install reaching an
    // Ollama on another box replaces this, which is the ordinary case and not
    // a departure.
    baseUrl: 'http://127.0.0.1:11434',
    slots: ['llm', 'embed'],
    key: 'none',
    note: 'Models on hardware you control, on this box or another. No key unless you have put a proxy in front of it.',
  },
  {
    id: 'perch',
    label: 'perch',
    // perch speaks all three of Ollama's, OpenAI's and Anthropic's shapes.
    // Ollama's is the richest through it — the only one that reports which
    // models are pulled and which are resident, which is what the Models page
    // is drawn from — so that is the one offered.
    shape: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    slots: ['llm', 'embed'],
    key: 'required',
    note: 'Your own GPU box behind an authenticated endpoint. The address is wherever the tunnel comes out — usually still loopback on this machine — and the key is a perch token.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    shape: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    slots: ['llm', 'embed', 'stt'],
    key: 'required',
    note: 'Chat, embeddings and Whisper transcription from one key.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    shape: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    // Drafting only, and not an oversight: the Messages API has no embeddings
    // endpoint at all. An install drafting here points meaning search at its
    // own Ollama, which is exactly why the embedding connection is separable.
    slots: ['llm'],
    key: 'required',
    note: 'Claude, through the Messages API. It has no embeddings endpoint, so meaning search needs a connection of its own.',
  },
  {
    id: 'groq',
    label: 'Groq',
    shape: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    slots: ['llm', 'stt'],
    key: 'required',
    note: 'Open-weight models on their own silicon — the fastest tokens per second here, which is what a composer waiting on a draft actually feels. Also serves Whisper.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    shape: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    slots: ['llm', 'embed'],
    key: 'required',
    note: 'One key for hundreds of models from every vendor. Model IDs carry a vendor prefix — "openai/gpt-5", "qwen/qwen3-embedding-8b".',
  },
  {
    id: 'together',
    label: 'Together AI',
    shape: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    slots: ['llm', 'embed'],
    key: 'required',
    note: 'Open-weight models hosted, including the Qwen3 embedders at their full width.',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    shape: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    slots: ['llm', 'embed'],
    key: 'required',
    note: 'Open-weight models hosted. Model IDs are paths — "accounts/fireworks/models/...".',
  },
  {
    id: 'nanogpt',
    label: 'NanoGPT',
    shape: 'openai',
    baseUrl: 'https://nano-gpt.com/api/v1',
    slots: ['llm', 'embed'],
    key: 'required',
    note: 'Pay per request rather than per month, and it takes cryptocurrency — worth knowing for an install that would rather not put a card on file to draft email.',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    // Drafting goes through Google's OpenAI-compatible endpoint rather than
    // its native generateContent shape: one adapter instead of two, and the
    // compatibility layer loses nothing Tern sends.
    shape: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    slots: ['llm'],
    key: 'required',
    note: 'Gemini for drafting, through Google’s OpenAI-compatible endpoint. Gemini embeddings are a different API — choose "Google (Gemini embeddings)" for those.',
  },
  {
    id: 'gemini',
    label: 'Google (Gemini embeddings)',
    shape: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    slots: ['embed'],
    key: 'required',
    note: 'Gemini Embedding 2 through Google’s own API, which is the one that can ask for a vector narrower than the full 3072.',
  },
  {
    id: 'voyage',
    label: 'Voyage AI',
    shape: 'voyage',
    baseUrl: 'https://api.voyageai.com/v1',
    slots: ['embed'],
    key: 'required',
    note: 'Retrieval embeddings, and the only host here that is told whether it is embedding a search or a message.',
  },
];

export function presetsForSlot(slot: Slot): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.slots.includes(slot));
}

/**
 * Every embedder Tern knows, hosted and local alike, and how wide its vectors
 * are.
 *
 * ── Why width is written down, and still not trusted ────────────────────────
 *
 * `email_vectors` stores one row per message at the model's width, so this is
 * the number that decides what meaning search costs on disk: a 4096-wide model
 * is five times a 768-wide one over the same mailbox. Nothing on the wire
 * reports it before you have embedded something, so an admin choosing between
 * two models cannot see it anywhere else.
 *
 * It is NOT what gets indexed. `embed` reads the real width off the vectors
 * that came back, because several of these support Matryoshka truncation and
 * will answer narrower than their default if asked. A table that silently
 * disagreed with the server would corrupt an index rather than fail.
 *
 * ── Changing one is not free ────────────────────────────────────────────────
 *
 * Vectors made by one model are not comparable with another's. Existing rows
 * stay at the old width and are simply never matched again — `semanticSearch`
 * filters on `dims` — so meaning search degrades to whatever has been
 * re-indexed until the pass catches up.
 */
export interface EmbedCatalogueEntry {
  name: string;
  label: string;
  /** The shapes this model can be reached through. */
  shapes: ApiShape[];
  /** The same weights under another host's name for them. */
  alternateNames?: string[];
  dims: number;
  contextTokens: number;
  note: string;
}

export const EMBED_CATALOGUE: EmbedCatalogueEntry[] = [
  {
    name: 'all-minilm',
    label: 'all-MiniLM',
    shapes: ['ollama'],
    dims: 384,
    contextTokens: 512,
    note: 'The default. Tiny enough to load beside the writing model on a 4.5 GB VPS without competing for room.',
  },
  {
    name: 'nomic-embed-text',
    label: 'Nomic Embed Text',
    shapes: ['ollama'],
    dims: 768,
    contextTokens: 8192,
    note: 'Better search quality and a much longer input window, so a whole message embeds as one vector rather than just its opening.',
  },
  {
    name: 'embeddinggemma',
    label: 'EmbeddingGemma',
    shapes: ['ollama'],
    dims: 768,
    contextTokens: 2048,
    note: 'Larger again, and Matryoshka-trained so it survives truncation. Worth it on a big mailbox where the others feel imprecise.',
  },
  {
    name: 'qwen3-embedding:4b',
    label: 'Qwen3-Embedding-4B',
    // One set of weights, several names: the Ollama library tag, and the
    // Hugging Face id that hosted OpenAI-compatible servers use.
    shapes: ['ollama', 'openai'],
    alternateNames: ['Qwen/Qwen3-Embedding-4B', 'qwen/qwen3-embedding-4b'],
    dims: 2560,
    contextTokens: 32768,
    note: 'Strong multilingual retrieval that still fits a modest card — 2.5 GB pulled. Vectors are 2560 wide, so the index is over three times an all-minilm one.',
  },
  {
    name: 'qwen3-embedding:8b',
    label: 'Qwen3-Embedding-8B',
    shapes: ['ollama', 'openai'],
    alternateNames: ['Qwen/Qwen3-Embedding-8B', 'qwen/qwen3-embedding-8b'],
    dims: 4096,
    contextTokens: 32768,
    note: 'The best open-weight retrieval model here and the widest at 4096. Wants a GPU: on a CPU-only box the first index pass over a real mailbox is an overnight job.',
  },
  {
    name: 'text-embedding-3-large',
    label: 'OpenAI text-embedding-3-large',
    shapes: ['openai'],
    dims: 3072,
    contextTokens: 8191,
    note: 'OpenAI’s best embedder. It will return a narrower vector if asked; Tern asks for the model’s own default and indexes whatever comes back.',
  },
  {
    name: 'text-embedding-3-small',
    label: 'OpenAI text-embedding-3-small',
    shapes: ['openai'],
    dims: 1536,
    contextTokens: 8191,
    note: 'A fifth of the price of the large one and most of the quality. The right first choice on OpenAI.',
  },
  {
    name: 'gemini-embedding-2',
    label: 'Gemini Embedding 2',
    shapes: ['gemini'],
    dims: 3072,
    contextTokens: 8192,
    note: 'Google’s multimodal embedder. Unlike the 001 generation it takes no task type at all, so a search is marked as one by instructing it in the text — which Tern does.',
  },
  {
    name: 'voyage-3-large',
    label: 'Voyage voyage-3-large',
    shapes: ['voyage'],
    dims: 1024,
    contextTokens: 32000,
    note: 'Built for retrieval rather than general similarity, and told on every call whether it is embedding a search or a message. 1024 wide by default; it will return 256, 512 or 2048 if asked.',
  },
];

/**
 * What Tern knows about an embedder by name, across the several names one set
 * of weights goes by — and past Ollama's `:latest` suffix, which the settings
 * never carry but `/api/tags` always does.
 *
 * Returns null for anything unknown, which is the common case and not a
 * problem: the width that matters is read off the wire.
 */
export function embedModelInfo(name: string): EmbedCatalogueEntry | null {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const bare = raw.replace(/:latest$/, '').toLowerCase();
  return EMBED_CATALOGUE.find((m) => m.name.toLowerCase() === bare
    || (m.alternateNames ?? []).some((a) => a.toLowerCase() === bare)) ?? null;
}

/** The embedders Tern knows for one shape — the fallback where there is no live list. */
export function embedModelsForShape(shape: ApiShape): EmbedCatalogueEntry[] {
  return EMBED_CATALOGUE.filter((m) => m.shapes.includes(shape));
}
