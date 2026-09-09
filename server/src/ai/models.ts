// Model recommendation by available memory. The same table lives in
// install.sh so the container and the installer agree; change both.
// Sizes are the q4 quantisations Ollama pulls by default, plus headroom for
// the KV cache and everything else on the box.
export interface ModelTier {
  minGiB: number;
  model: string;
  label: string;
  /** Meets the floor Tern's AI features are built and tested against. */
  floor?: boolean;
  note: string;
}

// ---------- The floor ----------
//
// What a FEATURE may assume, which is a different question from what an
// operator may install.
//
// **Chat: qwen3.5:9b or gemma4:12b. Meaning: qwen3-embedding:4b.**
//
// Drafting is the easy half and a small model does it well — that is why the
// tiers below go down to 0.8b and stay there. The floor is about everything
// else: an AI responder deciding whether a message needs a reply, a campaign
// step following a structured format, anything asked to return a shape rather
// than a paragraph. Below the floor those do not fail loudly, they drift —
// the fence in prompts.ts becomes a suggestion, the format becomes advice, and
// the send-side filter in llm.ts is left doing work it was never meant to be
// the only line of.
//
// **It is a warning, never a wall.** Every tier below is offered, install.sh
// recommends whatever fits the box, and a 4.5 GB VPS gets a working install
// with a model that drafts perfectly well. What changes is that the installer
// now says which side of the line the box is on, instead of implying that the
// tier it picked is the intended experience.
//
// The other end is a first-class target: a hosted frontier model with thinking
// enabled is a supported configuration, not an edge case, and nothing here is
// gated on model size — see docs/SETUP.md.
//
// When the floor moves it moves here, in install.sh's rec_model, and in
// docs/SETUP.md — all three, or the installer recommends something the
// features are not tested against.
export const FLOOR_CHAT = ['qwen3.5:9b', 'gemma4:12b'] as const;
export const FLOOR_EMBED = 'qwen3-embedding:4b';

/** Is this tier below the floor the features are tested against? */
export function belowFloor(model: string): boolean {
  return !FLOOR_CHAT.includes(model.replace(/:latest$/, '') as typeof FLOOR_CHAT[number])
    && !ABOVE_FLOOR.includes(model.replace(/:latest$/, ''));
}

// Models larger than the floor. Kept explicit rather than inferred from size,
// because "bigger" and "newer" are not the same axis: gemma4:e4b is a larger
// file than gemma4:12b and about 4B of it works.
const ABOVE_FLOOR: readonly string[] = ['qwen3.8:27b', 'gemma4:31b', 'qwen3.5:27b'];

// Moved off qwen2.5 to the current generation. The sizes below are the real
// downloads, checked against registry.ollama.ai rather than remembered — the
// previous list had been overtaken twice, and CURATED_MODELS already recorded
// that qwen3.5:9b is the strongest thing measured on this suite while the
// tiers still handed out qwen2.5.
//
// These are RAM tiers, not VRAM: the model shares the box with Postgres, the
// app and possibly Stalwart, so a tier leaves room for all of that. On a
// CPU-only VPS a smaller model is also a much faster one.
export const MODEL_TIERS: ModelTier[] = [
  { minGiB: 0, model: 'qwen3.5:0.8b', label: 'Tiny (under 6 GB RAM)', note: 'One gigabyte, and shipped at Q8 so it is less lossy than its size suggests. The right pick for a 4.5 GB VPS: good subject lines and short rewrites, simple drafts.' },
  { minGiB: 6, model: 'qwen3.5:2b', label: 'Small (6 to 10 GB RAM)', note: 'Also Q8. Noticeably steadier tone and structure than the 0.8b.' },
  { minGiB: 10, model: 'qwen3.5:4b', label: 'Medium (10 to 16 GB RAM)', note: 'The best value measured on this suite: 36 of 42 cases for 3.4 GB.' },
  { minGiB: 16, model: 'qwen3.5:9b', floor: true, label: 'Large (16 to 24 GB RAM)', note: 'The floor, and the strongest measured here — 39 of 42 — for 2.4 GB more than the 4b and about half the speed. Wants a GPU on anything but a big box.' },
  { minGiB: 24, model: 'gemma4:12b', floor: true, label: 'Extra large (24+ GB RAM)', note: 'The floor, and the better of the two if the box has room. A true 12B in 7.6 GB, newest Gemma generation. Needs a GPU or patience.' },
];

export function recommendModel(totalBytes: number): ModelTier {
  const gib = totalBytes / 1024 ** 3;
  let pick = MODEL_TIERS[0];
  for (const t of MODEL_TIERS) if (gib >= t.minGiB) pick = t;
  return pick;
}

// Ordered by size. qwen2.5 is gone from here: it was two generations behind
// and was still being offered as the default for every tier.
//
// Sizes are the real downloads, checked against registry.ollama.ai. Worth
// repeating that check whenever this list is edited — a tag that looks
// plausible and does not resolve fails at the pull, which is the least useful
// place to find out.
export const CURATED_MODELS = [
  { name: 'qwen3.5:0.8b', sizeGB: 1.0, note: 'tiny, current generation, Q8 so less lossy than its size suggests' },
  { name: 'qwen3.5:2b', sizeGB: 2.7, note: 'small, current generation, Q8' },
  { name: 'gemma3:1b', sizeGB: 0.8, note: 'tiny alternative' },
  { name: 'llama3.2:1b', sizeGB: 1.3, note: 'tiny alternative' },
  { name: 'llama3.2:3b', sizeGB: 2.0, note: 'small alternative' },
  { name: 'phi4-mini', sizeGB: 2.5, note: 'small alternative' },
  { name: 'gemma3:4b', sizeGB: 3.3, note: 'medium alternative, good writer' },
  // Reasoning-capable. Leave thinking off: measured at 11x to 50x the latency
  // for a difference inside the noise on every recall case tested.
  { name: 'qwen3.5:4b', sizeGB: 3.4, note: 'medium, the best value measured; can think' },
  // Was listed here as "qwen3.5:8b", which is not a tag that exists — anybody
  // who picked it got a pull failure. The 9b is the real one, and it is the
  // strongest model measured on this suite: 39 of 42 cases against the 4b's
  // 36, for 2.4 GB more and about half the speed.
  { name: 'qwen3.5:9b', sizeGB: 6.6, note: 'large, best measured quality; can think' },
  // A true 12B in a smaller file than gemma4:e4b, which is a nested build
  // with only about 4B parameters active. Size is not capability here.
  { name: 'gemma4:12b', sizeGB: 7.6, note: 'large, newest Gemma, true 12B' },
  // Measured alongside the others: level with qwen3.5:4b on quality and
  // roughly three times the memory, so an alternative rather than an upgrade.
  { name: 'phi4:14b', sizeGB: 9.1, note: 'large alternative' },
  { name: 'gemma4:e4b', sizeGB: 9.6, note: 'large alternative, nested: ~4B active, fast but weaker than gemma4:12b' },
  { name: 'qwen3.8:27b', sizeGB: 17.7, note: 'extra large, newest Qwen; 27b is the only size it ships' },
];

// Uncensored ("abliterated") builds, where the refusal direction is ablated
// out of the weights. Worth having for drafting: a stock model declining to
// help with a firm complaint, a debt letter or a frank performance review is a
// common and irritating failure, and the refusal protects nobody when the mail
// and the machine are yours.
//
// Two caveats that matter more in Tern than they would elsewhere. Ablation can
// soften instruction-following, which is the thing the send-side filter in
// llm.ts depends on. And an AI responder set to send without a human in the
// loop has, until now, had the model's own refusals as a last check before an
// odd prompt became an odd sent email — that check is gone with these, so keep
// responders on the review queue while judging one.
//
// Sizes verified against registry.ollama.ai; every tag here resolves.
export const UNCENSORED_MODELS = [
  { name: 'huihui_ai/qwen3.5-abliterated:4b', sizeGB: 3.3, note: 'medium, uncensored qwen3.5:4b' },
  { name: 'huihui_ai/qwen3.5-abliterated:9b', sizeGB: 6.6, note: 'large, uncensored qwen3.5:9b, identical size and quantisation to stock' },
  { name: 'huihui_ai/gemma-4-abliterated:12b', sizeGB: 7.6, note: 'large, uncensored gemma4:12b, best quality per gigabyte on a 16 GB card' },
  { name: 'huihui_ai/qwen3-abliterated:14b', sizeGB: 9.0, note: 'large, the biggest true parameter count that fits 16 GB with context headroom' },
  { name: 'huihui_ai/gemma-4-abliterated:e4b', sizeGB: 9.6, note: 'large alternative, nested: ~4B active, fast' },
  { name: 'huihui_ai/mistral-small-abliterated:24b', sizeGB: 14.3, note: 'extra large, wants 24 GB — too tight on 16 GB to leave room for context' },
];

// ---------- Meaning search ----------
//
// The model that turns a message into a vector. A different job from writing,
// and a much smaller model: it never generates a word, it only has to place
// similar messages near each other. It loads *beside* the writing model
// rather than instead of it, which is why "wants" here matters more than the
// download size — that is the memory it occupies while search is in use.
//
// The same list, with the same numbers, is what perch offers on the GPU side
// (`server/src/system.ts`, EMBED_MODELS). Change one, change both: somebody
// choosing a model there and setting it here should not be reading two
// different descriptions of it.
//
// This is the list of models the bundled Ollama can PULL. The wider catalogue
// — hosted embedders on OpenAI, Gemini and Voyage, and the vector width of
// each — is `ai/providers.ts`, which is what the settings page draws its
// picker from. Two lists because they answer different questions: this one is
// "what can this box download", that one is "what can this connection reach".
//
// Changing this is not free in a way the writing model is: existing vectors
// were made by the old model and are not comparable with the new one's, so
// meaning search is degraded until they are rebuilt.
export interface EmbedModel {
  name: string;
  /** The download. */
  sizeBytes: number;
  /** Roughly what it occupies once loaded, which is the number that decides whether it fits. */
  needsBytes: number;
  params: string;
  /** How much of a message goes into one vector before it is truncated. */
  contextTokens: number;
  note: string;
}

export const EMBED_MODELS: EmbedModel[] = [
  {
    name: 'all-minilm', sizeBytes: 0.05e9, needsBytes: 0.3e9, params: '23M', contextTokens: 512,
    note: 'The default. Tiny, and loads beside the writing model without competing for room.',
  },
  {
    name: 'nomic-embed-text', sizeBytes: 0.27e9, needsBytes: 0.6e9, params: '137M', contextTokens: 8192,
    note: 'Better search quality and a much longer input window, so a whole message embeds as one vector instead of just its opening.',
  },
  {
    name: 'embeddinggemma', sizeBytes: 0.62e9, needsBytes: 1.1e9, params: '300M', contextTokens: 2048,
    note: 'Larger again. Worth it only if you search a big mailbox and find the others imprecise.',
  },
  // The two Qwen3 embedders. A different class from the three above — they
  // want a graphics card, not a corner of a VPS — and they are here rather
  // than only in providers.ts because these tags really are pullable onto the
  // bundled Ollama, which is what this list is for.
  //
  // Their vectors are much wider, and it is worth being precise about what
  // that does and does not cost, because the instinct is a reasonable one and
  // this comment used to teach it wrongly. It said the 8B builds an index five
  // times the size of an all-minilm one. It does not, and has not since the
  // keyed projection went in: every vector is cut to `EMBED_DIMS` (256) before
  // it is stored, so a 384-wide model and a 4096-wide one both leave a
  // 256-byte row. Measured across this whole catalogue.
  //
  // What width actually costs is the pull, the memory to hold it, and wanting
  // a card. Those are real and they are what the tiers below are sized on.
  // Disk is not one of them — which, if anything, is an argument FOR the wider
  // model rather than against it.
  {
    name: 'qwen3-embedding:0.6b', sizeBytes: 0.64e9, needsBytes: 1.1e9, params: '0.6B', contextTokens: 32768,
    note: 'The Qwen3 family without a graphics card: the same long window and the same query instruction as its siblings, in 1024-wide vectors.',
  },
  {
    name: 'mxbai-embed-large', sizeBytes: 0.67e9, needsBytes: 1.1e9, params: '335M', contextTokens: 512,
    note: 'Strong English retrieval in a small download, 1024 wide. The 512-token window is the catch: only the opening of a long message reaches the vector.',
  },
  {
    name: 'bge-m3', sizeBytes: 1.2e9, needsBytes: 1.6e9, params: '567M', contextTokens: 8192,
    note: 'Multilingual retrieval over a hundred languages, 1024 wide. The usual choice for a mailbox that is not mostly English but has no card to give Qwen3.',
  },
  {
    name: 'snowflake-arctic-embed2', sizeBytes: 1.2e9, needsBytes: 1.6e9, params: '568M', contextTokens: 8192,
    note: 'Multilingual and Matryoshka-trained, 1024 wide. A middle between the tiny defaults and the Qwen3 pair.',
  },
  {
    name: 'qwen3-embedding:4b', sizeBytes: 2.5e9, needsBytes: 3.4e9, params: '4B', contextTokens: 32768,
    note: 'The floor: what meaning search is built and tested against. Strong multilingual retrieval, 2560-wide vectors, and a window wide enough that Tern sends it the whole of any ordinary message. Wants a GPU; on CPU the first index pass over a real mailbox is an overnight job. Costs no more disk than all-minilm — every vector is stored at the same width.',
  },
  {
    name: 'qwen3-embedding:8b', sizeBytes: 4.7e9, needsBytes: 6.2e9, params: '8B', contextTokens: 32768,
    note: 'The best open-weight retrieval model here and the widest at 4096. Only worth it with a card that has room for it beside the writing model.',
  },
];

export function isEmbedModel(name: string): boolean {
  const bare = String(name ?? '').replace(/:latest$/, '');
  return EMBED_MODELS.some((m) => m.name === bare);
}

// ---------- How much conversation the model is given ----------
//
// `num_ctx` shipped as a flat 8192 whatever the machine was, and paired with
// a 14,000-character ceiling on the thread that meant raising it changed
// nothing anyone could see. Both are now real: the ceiling is an upper bound
// (see prompts.ts) and this is the window.
//
// The number matters because it decides whether a long thread is shown whole
// or trimmed from the middle. Measured on the fixture the evaluations use, a
// realistic 24-message B2B thread is about 8,500 tokens and a 50-message one
// about 12,500, so a window of 16k holds the deepest thread the sweep tests
// with room for the instructions and the reply.
//
// It is not free. Every parallel slot Ollama serves holds its own copy of the
// KV cache — measured on qwen3.5:4b, about 290 MB per 8k of window — and on a
// CPU-only box the prompt has to be read before a single token comes back, so
// a big window turns into a long wait rather than a better answer. Hence a
// tier table rather than a constant, and a ceiling well below what the model
// advertises: qwen3.5:4b claims 262k, which no box this ships to can afford
// and no 4B model uses well.
//
// The tiers were raised once the thread budget stopped being capped at 14,000
// characters: with the window actually governing how much conversation the
// model sees, the bottom tier had to be able to hold a real thread rather
// than a fragment of one. `clampNumCtx` then bounds the result by what the
// model itself was trained for.
export interface CtxTier { minGiB: number; numCtx: number; note: string }

export const CTX_TIERS: CtxTier[] = [
  { minGiB: 0, numCtx: 8192, note: 'Small box: most conversations fit; a long one is packed from both ends.' },
  { minGiB: 8, numCtx: 16384, note: 'Holds a 50-message thread whole.' },
  { minGiB: 16, numCtx: 32768, note: 'Room for the longest threads, or for thinking, on top.' },
  { minGiB: 32, numCtx: 65536, note: 'Nothing this app produces will trouble it.' },
];

// A window is only as big as the model was trained for. Ollama will accept a
// larger `num_ctx` and extend the model past its training length, which
// degrades quality quietly rather than failing — and the models here differ
// enormously: qwen3.5 is trained to 262k, mistral-small to 32k, and phi4 to
// only 16k. A default sized from host memory alone would have run phi4 at
// double its native window without a word.
export function clampNumCtx(wanted: number, modelLimit: number | null): number {
  if (!modelLimit || modelLimit <= 0) return wanted;
  return Math.min(wanted, modelLimit);
}

export function recommendNumCtx(totalBytes: number): number {
  const gib = totalBytes / 1024 ** 3;
  let pick = CTX_TIERS[0];
  for (const t of CTX_TIERS) if (gib >= t.minGiB) pick = t;
  return pick.numCtx;
}
