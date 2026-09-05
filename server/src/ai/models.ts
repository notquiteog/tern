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
  { name: 'llama3.2:1b', sizeGB: 1.3, note: 'small alternative' },
  { name: 'llama3.2:3b', sizeGB: 2.0, note: 'medium alternative' },
  { name: 'gemma3:1b', sizeGB: 0.8, note: 'small alternative' },
  { name: 'gemma3:4b', sizeGB: 3.3, note: 'medium alternative, good writer' },
  { name: 'phi4-mini', sizeGB: 2.5, note: 'medium alternative' },
];
