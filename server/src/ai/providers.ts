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
export type Slot = 'llm' | 'embed' | 'stt' | 'image' | 'video';

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
    // No `image`, and not an omission: Ollama runs vision models that READ a
    // picture and has no endpoint that draws one. Offering it for pictures
    // would be a choice that cannot work, which is the same rule that keeps
    // Anthropic off the embedding list.
    note: 'Models on hardware you control, on this box or another. No key unless you have put a proxy in front of it. It reads pictures but does not draw them, so it is not offered for those.',
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
    note: 'Your own GPU box behind an authenticated endpoint. The address is wherever the tunnel comes out — usually still loopback on this machine — and the key is a perch token. For pictures, point the image connection at whatever that box serves them on and choose the shape it speaks.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    shape: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    slots: ['llm', 'embed', 'stt', 'image', 'video'],
    key: 'required',
    note: 'Chat, embeddings, Whisper transcription, pictures and video from one key — the only host here that serves all five.',
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
    // The same company twice, because it is genuinely two endpoints. Drafting
    // and embedding go to `/v1/...` in the ordinary way; pictures come back
    // out of `/v1/chat/completions` as a data URL, which is a different reply
    // to parse and cannot be reached by picking the entry above.
    id: 'openrouter-images',
    label: 'OpenRouter (pictures)',
    shape: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    slots: ['image'],
    key: 'required',
    note: 'Pictures through chat completions, which is how OpenRouter serves them. Model IDs carry a vendor prefix, and it has to be one that returns images.',
  },
  {
    id: 'together',
    label: 'Together AI',
    shape: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    slots: ['llm', 'embed', 'image'],
    key: 'required',
    note: 'Open-weight models hosted, including the Qwen3 embedders at their full width, and open image models on the same key.',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    shape: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    slots: ['llm', 'embed', 'image'],
    key: 'required',
    note: 'Open-weight models hosted, pictures included. Model IDs are paths — "accounts/fireworks/models/...".',
  },
  {
    id: 'nanogpt',
    label: 'NanoGPT',
    shape: 'openai',
    baseUrl: 'https://nano-gpt.com/api/v1',
    slots: ['llm', 'embed', 'image', 'video'],
    key: 'required',
    note: 'Pay per request rather than per month, and it takes cryptocurrency — worth knowing for an install that would rather not put a card on file to draft email, and the one host here where that pairs sensibly with reaching it over Tor.',
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
    // Gemini draws through the compatibility layer too, and by the same
    // chat-completions route OpenRouter uses, so it is a separate entry for
    // the same reason: one address, two reply shapes.
    id: 'google-images',
    label: 'Google (Gemini pictures)',
    shape: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    slots: ['image'],
    key: 'required',
    note: 'Gemini’s image models through the OpenAI-compatible endpoint, which answers with the picture inside the chat reply.',
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
 * ── Why width is written down, and what it does NOT cost ────────────────────
 *
 * It is not the disk. This said it was — "a 4096-wide model is five times a
 * 768-wide one over the same mailbox" — and that stopped being true when the
 * keyed projection went in: every vector is cut to `EMBED_DIMS` before it is
 * stored, so a 384-wide model and a 4096-wide one both leave 256-byte rows
 * behind, and an index over the same mailbox is the same size whichever is
 * chosen. Worth stating in the negative because the claim survived in three
 * places and argued against exactly the models most worth picking.
 *
 * What width does decide is the geometry. The rotation is derived per input
 * width, so it is what makes one model's vectors incomparable with another's,
 * and it is why `semanticSearch` scopes its scan by model NAME — the stored
 * width cannot tell them apart. The real costs of a wide model are the pull,
 * what it wants resident, and whether it needs a card; `ai/models.ts` carries
 * those, and this number is here so the picker can show what an admin is
 * choosing between.
 *
 * It is NOT what gets indexed. `embed` reads the real width off the vectors
 * that came back, because several of these support Matryoshka truncation and
 * will answer narrower than their default if asked. A table that silently
 * disagreed with the server would corrupt an index rather than fail.
 *
 * ── Changing one is not free ────────────────────────────────────────────────
 *
 * Vectors made by one model are not comparable with another's, and the stored
 * width does not say which model made them: every row is projected down to
 * `EMBED_DIMS` regardless, so a 384-wide model and a 2560-wide one both leave
 * 256-byte rows behind. `semanticSearch` therefore scopes the scan by the
 * model NAME on the row. Rows from a previous model are left alone and never
 * matched, and the background pass rebuilds them — so meaning search narrows
 * to what has been re-indexed rather than quietly scoring the rest as noise.
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
    note: 'Better search quality, and a long enough window that Tern sends it the whole of an ordinary message rather than just its opening.',
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
    name: 'qwen3-embedding:0.6b',
    label: 'Qwen3-Embedding-0.6B',
    shapes: ['ollama', 'openai'],
    alternateNames: ['Qwen/Qwen3-Embedding-0.6B', 'qwen/qwen3-embedding-0.6b'],
    dims: 1024,
    contextTokens: 32768,
    note: 'The Qwen3 family’s smallest, and the one that makes the family reachable on a box without a card: the same 32k window and the same query instruction as its siblings, in 1024-wide vectors that cost a fifth of the 8B’s index.',
  },
  {
    name: 'bge-m3',
    label: 'BGE-M3',
    shapes: ['ollama', 'openai'],
    alternateNames: ['BAAI/bge-m3', 'baai/bge-m3'],
    dims: 1024,
    contextTokens: 8192,
    note: 'Multilingual retrieval over a hundred languages, and a long window for its size. The usual choice for a mailbox that is not mostly English but has no GPU to give Qwen3.',
  },
  {
    name: 'mxbai-embed-large',
    label: 'mxbai-embed-large',
    shapes: ['ollama'],
    alternateNames: ['mixedbread-ai/mxbai-embed-large-v1'],
    dims: 1024,
    contextTokens: 512,
    note: 'Strong English retrieval in a small download. The 512-token window is the catch: only the opening of a long message reaches the vector.',
  },
  {
    name: 'snowflake-arctic-embed2',
    label: 'Snowflake Arctic Embed 2',
    shapes: ['ollama'],
    alternateNames: ['Snowflake/snowflake-arctic-embed-l-v2.0'],
    dims: 1024,
    contextTokens: 8192,
    note: 'Multilingual, and Matryoshka-trained so it survives truncation. A good middle between the tiny defaults and the Qwen3 pair.',
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

/**
 * How much of one message goes into a vector, in characters, for a given
 * embedder.
 *
 * ── Why this is not one number ──────────────────────────────────────────────
 *
 * It was, and the number was 2,000, and that is what made the widths above
 * decorative. `contextTokens` was written down, shown in the models table, and
 * read by nothing: an install that pulled a 2.5 GB Qwen3 embedder for its 32k
 * window got exactly the same 2,000 characters per message as all-minilm's
 * 512-token one. The catalogue said the window mattered while the indexer
 * ignored it, which is the worst arrangement — the cost of the big model was
 * real and the benefit was not.
 *
 * ── Why there is still a ceiling ────────────────────────────────────────────
 *
 * Because "the model's whole window" is not the right answer either. One
 * vector is one point, and a point standing for 32,000 tokens of quoted
 * threads, footers and signatures stands for nothing in particular; retrieval
 * gets worse, not better, past a certain length. The ceiling is Tern's own
 * budget for what one message's vector should mean, and the floor is what
 * every install already had — so no mailbox indexes LESS than it did before,
 * and a wide-window model now earns four times the text a narrow one gets.
 */
export const MIN_EMBED_CHARS = 2000;
export const MAX_EMBED_CHARS = 8000;

/**
 * Characters per token, for turning a model's window into a character budget.
 *
 * Deliberately pessimistic. English prose runs about four characters to the
 * token; accented and non-Latin text runs closer to two, and a mailbox is not
 * required to be in English. Under-estimating costs a little of the window;
 * over-estimating sends more than the model can hold and has it silently
 * truncate the tail, which is the same bug this budget exists to remove.
 */
export const CHARS_PER_TOKEN = 3.5;

export function embedInputChars(model: string): number {
  const info = embedModelInfo(model);
  if (!info) return MIN_EMBED_CHARS;
  return Math.max(MIN_EMBED_CHARS, Math.min(MAX_EMBED_CHARS, Math.round(info.contextTokens * CHARS_PER_TOKEN)));
}

/** The embedders Tern knows for one shape — the fallback where there is no live list. */
export function embedModelsForShape(shape: ApiShape): EmbedCatalogueEntry[] {
  return EMBED_CATALOGUE.filter((m) => m.shapes.includes(shape));
}
