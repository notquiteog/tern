// Model recommendation by available memory. The same table lives in
// install.sh so the container and the installer agree; change both.
// Sizes are the q4 quantisations Ollama pulls by default, plus headroom for
// the KV cache and everything else on the box.
export interface ModelTier { minGiB: number; model: string; label: string; note: string }

export const MODEL_TIERS: ModelTier[] = [
  { minGiB: 0, model: 'qwen2.5:0.5b', label: 'Tiny (under 3.5 GB RAM)', note: 'Fast and small. Fine for subject lines and short rewrites; expect simple drafts.' },
  { minGiB: 3.5, model: 'qwen2.5:1.5b', label: 'Small (3.5 to 6 GB RAM)', note: 'The right pick for a 4.5 GB VPS. Good short outreach drafts, decent replies.' },
  { minGiB: 6, model: 'qwen2.5:3b', label: 'Medium (6 to 10 GB RAM)', note: 'Noticeably better tone and structure.' },
  { minGiB: 10, model: 'qwen2.5:7b', label: 'Large (10 to 20 GB RAM)', note: 'Strong general writing. Slow on CPU-only boxes, fast with a GPU.' },
  { minGiB: 20, model: 'qwen2.5:14b', label: 'Extra large (20+ GB RAM)', note: 'Best quality; needs a GPU or patience.' },
];

export function recommendModel(totalBytes: number): ModelTier {
  const gib = totalBytes / 1024 ** 3;
  let pick = MODEL_TIERS[0];
  for (const t of MODEL_TIERS) if (gib >= t.minGiB) pick = t;
  return pick;
}

export const CURATED_MODELS = [
  { name: 'qwen2.5:0.5b', sizeGB: 0.4, note: 'tiny' },
  { name: 'qwen2.5:1.5b', sizeGB: 1.0, note: 'small, recommended for 4-6 GB' },
  { name: 'qwen2.5:3b', sizeGB: 1.9, note: 'medium' },
  { name: 'qwen2.5:7b', sizeGB: 4.7, note: 'large' },
  { name: 'qwen2.5:14b', sizeGB: 9.0, note: 'extra large' },
  // Reasoning-capable. Good at holding a long thread; leave thinking off
  // unless there is a GPU, and give it the thinking budget if you turn it on.
  { name: 'qwen3.5:4b', sizeGB: 3.4, note: 'medium, best long-thread recall; can think' },
  { name: 'qwen3.5:8b', sizeGB: 6.6, note: 'large, can think' },
  { name: 'llama3.2:1b', sizeGB: 1.3, note: 'small alternative' },
  { name: 'llama3.2:3b', sizeGB: 2.0, note: 'medium alternative' },
  { name: 'gemma3:1b', sizeGB: 0.8, note: 'small alternative' },
  { name: 'gemma3:4b', sizeGB: 3.3, note: 'medium alternative, good writer' },
  { name: 'phi4-mini', sizeGB: 2.5, note: 'medium alternative' },
];

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
export interface CtxTier { minGiB: number; numCtx: number; note: string }

export const CTX_TIERS: CtxTier[] = [
  { minGiB: 0, numCtx: 4096, note: 'Small box: a short thread, trimmed from the middle beyond that.' },
  { minGiB: 6, numCtx: 8192, note: 'Enough for most conversations; a long one is packed from both ends.' },
  { minGiB: 12, numCtx: 16384, note: 'Holds a 50-message thread whole.' },
  { minGiB: 24, numCtx: 32768, note: 'Room for the longest threads and several parallel slots.' },
];

export function recommendNumCtx(totalBytes: number): number {
  const gib = totalBytes / 1024 ** 3;
  let pick = CTX_TIERS[0];
  for (const t of CTX_TIERS) if (gib >= t.minGiB) pick = t;
  return pick.numCtx;
}
