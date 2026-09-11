// How hard the model thinks, in the spelling the server on the other end
// actually accepts.
//
// ── Why this is its own file ────────────────────────────────────────────────
//
// Tern has one dial — reasoning on or off, and how hard — and the servers it
// can be pointed at share the OpenAI request shape while agreeing about
// nothing on this one field:
//
//   api.openai.com   `reasoning_effort`, on a ladder that differs per model
//   OpenRouter       `reasoning: { effort }`, which OpenRouter maps itself
//   Groq             `reasoning_effort`, with a different set per model
//   Fireworks        `reasoning_effort` none|low|medium|high, on any model
//   Together         `reasoning: { enabled }` on hybrids, effort on gpt-oss
//   SiliconFlow      `enable_thinking` + `thinking_budget`
//   Alibaba (Qwen)   `enable_thinking` + `thinking_budget`
//   Gemini (compat)  `reasoning_effort`, and 2.5 Pro / 3.x cannot be off
//
// On several of them the wrong value is not ignored. Groq answers 400 to
// `reasoning_effort: "low"` on a Qwen that takes only none|default; OpenAI to
// `none` on GPT-6 Astra, and to any effort at all on a model that does not
// reason. `openaiStream` used to send `reasoning_effort: s.thinkEffort` to
// every model whenever thinking was on — so turning reasoning on against
// gpt-4o, or against Groq's Qwen, cost the whole draft rather than nothing.
//
// So the dial stays one dial and this is the only place it is translated.
// WHICH host is read off the address: the settings store a shape and a URL
// rather than a vendor (see `providers.ts`), and the URL cannot be mislabelled.
//
// ── The two rules every table below follows ─────────────────────────────────
//
//  - **Never above what was asked, never a value the model refuses.** A level
//    a model does not have clamps DOWN to the nearest one it does, so `max` on
//    a local model is its hardest setting rather than a 400. The exception is
//    a model whose lowest rung is above the ask — `gpt-5-pro` takes only
//    `high` — where the lowest rung is the answer.
//  - **`off` means as little as the model allows.** On a model with no off
//    switch that is its lowest rung, not its default: somebody asked for less,
//    and less is always expressible.
//
// A model this does not recognise, on a host that needs telling per model,
// gets nothing sent: the host's own default is a correct answer, and an
// invented parameter might be a 400.
//
// The same tables live in cryptostore's `services/ai/reasoning.js` and
// openmirror's `providers/reasoning.py`; a host added to one belongs in all
// three.

/** The dial, in order. `off` is `allowThinking: false`; the rest are `thinkEffort`. */
export const THINK_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];
export type ThinkEffort = Exclude<ThinkLevel, 'off'>;
export const THINK_EFFORTS: readonly ThinkEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Every effort name any host uses, in order of how hard it thinks. */
export const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Rung = (typeof ORDER)[number];

const THREE: Rung[] = ['low', 'medium', 'high'];
const EFFORTS: Rung[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The level one generation runs at, from the two settings that hold it. */
export function levelOf(s: { allowThinking: boolean; thinkEffort: ThinkEffort }, noThink = false): ThinkLevel {
  return !noThink && s.allowThinking ? s.thinkEffort : 'off';
}

export function isEffort(v: unknown): v is ThinkEffort {
  return typeof v === 'string' && (THINK_EFFORTS as readonly string[]).includes(v);
}

/** The last path segment, lower-cased: `openai/gpt-5` and `Qwen/Qwen3-8B` alike. */
function bare(model: string): string {
  return String(model ?? '').trim().toLowerCase().split('/').pop() ?? '';
}

function hostOf(baseUrl: string): string {
  try { return new URL(String(baseUrl ?? '')).hostname.toLowerCase(); } catch { return ''; }
}

export type Dialect = 'openai' | 'openrouter' | 'groq' | 'fireworks' | 'together' | 'siliconflow' | 'dashscope' | 'gemini' | 'deepseek' | 'generic';

/**
 * Which host's rules apply, from the address alone. `generic` is everything
 * else — vLLM, llama.cpp, LM Studio, NanoGPT, perch's own /v1 — which gets the
 * conservative treatment in `genericReasoning`.
 */
export function dialectFor(baseUrl: string): Dialect {
  const host = hostOf(baseUrl);
  if (host === 'api.openai.com') return 'openai';
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  if (host === 'api.groq.com') return 'groq';
  if (host === 'api.fireworks.ai') return 'fireworks';
  if (host === 'api.together.xyz' || host === 'api.together.ai') return 'together';
  if (host === 'api.siliconflow.com' || host === 'api.siliconflow.cn') return 'siliconflow';
  // Model Studio has moved to per-workspace hosts under `maas.aliyuncs.com`
  // and the regional `dashscope*.aliyuncs.com` ones still answer; the suffix
  // covers both, in every region.
  if (host.endsWith('.aliyuncs.com')) return 'dashscope';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (host === 'api.deepseek.com') return 'deepseek';
  return 'generic';
}

/**
 * The nearest rung a model accepts, never above the level asked for.
 * `ladder` is ascending in ORDER; `none` and `minimal` are only for `off`.
 */
export function clampEffort(level: ThinkLevel, ladder: readonly Rung[] | null): Rung | null {
  if (!ladder?.length) return null;
  if (level === 'off') {
    if (ladder.includes('none')) return 'none';
    if (ladder.includes('minimal')) return 'minimal';
    return ladder[0]!;
  }
  const want = ORDER.indexOf(level);
  const graded = ladder.filter((r) => r !== 'none' && r !== 'minimal');
  let best: Rung | null = null;
  for (const rung of graded) if (ORDER.indexOf(rung) <= want) best = rung;
  return best ?? graded[0] ?? ladder[0]!;
}

/**
 * Thinking allowance in tokens, for the hosts that take a budget rather than a
 * level. Only ever sent because a level was chosen — nothing here caps a
 * setting nobody made.
 */
export const BUDGETS: Record<Exclude<ThinkEffort, 'max'>, number> = { low: 1024, medium: 4096, high: 16384, xhigh: 32768 };

// ── api.openai.com ─────────────────────────────────────────────────────────

/**
 * Which efforts one OpenAI model takes, or null for a model that does not
 * reason — where sending the field at all is a 400.
 *
 * As OpenAI documents it in September 2026: the 5.6 family takes none … max,
 * GPT-6 Astra takes low … max and refuses `none`, 5.2–5.5 stop at xhigh, 5.1
 * at high, and the original gpt-5 has `minimal` where the later ones have
 * `none`. An unrecognised later generation gets the three rungs every
 * reasoning model since o1 has taken, which is never a 400.
 */
export function openAiLadder(model: string): Rung[] | null {
  const m = bare(model);
  if (/^gpt-oss/.test(m)) return THREE;
  if (/^gpt-5(?:\.\d+)?-chat/.test(m)) return null;
  if (/^gpt-5-pro/.test(m)) return ['high'];
  if (/^gpt-5\.\d+-pro/.test(m)) return ['medium', 'high', 'xhigh'];
  if (/^gpt-6/.test(m) || /^gpt-5\.\d+-cyber/.test(m)) return EFFORTS;
  const minor = /^gpt-5\.(\d+)/.exec(m);
  if (minor) {
    const n = Number(minor[1]);
    if (n >= 6) return ['none', ...EFFORTS];
    if (n >= 2) return ['none', 'low', 'medium', 'high', 'xhigh'];
    return ['none', ...THREE];
  }
  if (/^gpt-5(?:$|-)/.test(m)) return ['minimal', ...THREE];
  if (/^o[1-9](?:$|-)/.test(m)) return THREE;
  if (/^gpt-(?:[7-9]|\d{2})/.test(m)) return THREE;
  return null;
}

// ── Groq ───────────────────────────────────────────────────────────────────

/**
 * A different parameter set per model, and a value outside it is a 400.
 * `reasoning_format: 'parsed'` on Qwen and MiniMax is not decoration: with
 * `raw` the reasoning arrives inside `<think>` tags in the DRAFT, and `raw`
 * with tools is refused outright. GPT-OSS takes no `reasoning_format` at all.
 */
function groqReasoning(level: ThinkLevel, model: string): Record<string, unknown> {
  const m = bare(model);
  if (/gpt-oss/.test(m)) return { reasoning_effort: clampEffort(level, THREE) };
  if (/qwen/.test(m)) {
    // qwen3.6 takes none|default; qwen3.8 adds low|medium|high.
    const graded = /qwen3\.(?:[89]|\d{2,})/.test(m);
    const effort = level === 'off' ? 'none' : graded ? clampEffort(level, THREE) : 'default';
    return { reasoning_effort: effort, reasoning_format: 'parsed' };
  }
  if (/minimax/.test(m)) return { reasoning_format: 'parsed' };
  return {};
}

// ── Together ───────────────────────────────────────────────────────────────

const NO_SWITCH = /thinking|instruct|coder|(?:^|[-/])r1\b|qwq/;
const TOGETHER_HYBRID = /deepseek-v(?:3\.[1-9]|[4-9])|glm-(?:4\.[5-9]|[5-9])|kimi-k[2-9]|qwen3|minimax-m[1-9]/;

/** Hybrids switch on `reasoning.enabled`; gpt-oss takes an effort; reasoning-only models are left alone. */
function togetherReasoning(level: ThinkLevel, model: string): Record<string, unknown> {
  const m = bare(model);
  if (/gpt-oss/.test(m)) return { reasoning_effort: clampEffort(level, THREE) };
  if (TOGETHER_HYBRID.test(m) && !NO_SWITCH.test(m)) return { reasoning: { enabled: level !== 'off' } };
  return {};
}

// ── SiliconFlow ────────────────────────────────────────────────────────────

const SF_HYBRID = /qwen3|glm-|hunyuan|deepseek-v3\.[1-9]|deepseek-v[4-9]/;

/**
 * `enable_thinking` on hybrids, `thinking_budget` (128–32,768) on anything
 * that reasons. SiliconFlow's own default budget is 4,096, which is not its
 * ceiling, so `max` sends the ceiling rather than nothing.
 */
function siliconflowReasoning(level: ThinkLevel, model: string): Record<string, unknown> {
  const m = bare(model);
  const hybrid = SF_HYBRID.test(m) && !NO_SWITCH.test(m);
  const reasoningOnly = /(?:^|[-/])r1\b|thinking|qwq/.test(m);
  const out: Record<string, unknown> = {};
  if (hybrid) out.enable_thinking = level !== 'off';
  const spend = level === 'off' ? (reasoningOnly ? ('low' as const) : null) : level;
  if (spend && (hybrid || reasoningOnly)) out.thinking_budget = spend === 'max' ? 32768 : BUDGETS[spend];
  return out;
}

// ── Alibaba Cloud Model Studio (DashScope) ─────────────────────────────────

const DS_HYBRID = /qwen3|qwen-plus|qwen-flash|qwen-turbo|deepseek-v3\.[1-9]|deepseek-v[4-9]|kimi-k2|glm-/;
const DS_OPEN_QWEN3 = /^qwen3(?:\.\d+)?-(?:next-)?\d+(?:\.\d+)?b/;

/**
 * The same switch and budget as SiliconFlow, with two differences that each
 * fail a request if missed: some hybrids think by default and some do not
 * (qwen3.6-plus on, qwen3-max off), so `off` is always said out loud; and the
 * open-source Qwen3 builds refuse a NON-streamed call with thinking on. The
 * default budget here IS the model's ceiling, so `max` sends none.
 */
function dashscopeReasoning(level: ThinkLevel, model: string, stream: boolean): Record<string, unknown> {
  const m = bare(model);
  const reasoningOnly = /qwq|(?:^|[-/])(?:deepseek-)?r1\b|thinking/.test(m);
  const hybrid = DS_HYBRID.test(m) && !NO_SWITCH.test(m);
  const out: Record<string, unknown> = {};
  let thinks = reasoningOnly;
  if (hybrid) {
    thinks = level !== 'off' && (stream || !DS_OPEN_QWEN3.test(m));
    out.enable_thinking = thinks;
  }
  if (thinks) {
    const spend = level === 'off' ? 'low' : level;
    if (spend !== 'max') out.thinking_budget = BUDGETS[spend];
  }
  return out;
}

// ── Gemini, through Google's OpenAI-compatible endpoint ────────────────────

/** `none` only on the 2.5 Flash models; 2.5 Pro and every 3.x always think. */
export function geminiLadder(model: string): Rung[] | null {
  const m = bare(model).replace(/^models\//, '');
  if (!/^gemini-/.test(m) || /^gemini-(?:1|2\.0)/.test(m)) return null;
  if (/^gemini-2\.5-flash/.test(m)) return ['none', ...THREE];
  return THREE;
}

// ── Anything else speaking the OpenAI shape ────────────────────────────────

const GENERIC_REASONERS = /^(?:o[1-9](?:-|$)|gpt-[5-9]|gpt-oss|deepseek|qwen|qwq|glm|minimax|kimi)/;

/**
 * vLLM, llama.cpp, LM Studio and friends accept or ignore `reasoning_effort`
 * rather than refusing it, but only a model that reasons does anything with
 * it — so it goes to those families and nobody else, and never at `off`.
 */
function genericReasoning(level: ThinkLevel, model: string): Record<string, unknown> {
  if (level === 'off' || !GENERIC_REASONERS.test(bare(model))) return {};
  return { reasoning_effort: clampEffort(level, THREE) };
}

/**
 * The reasoning half of an OpenAI-shaped body, for one host and one model.
 * Spread it straight into the body.
 */
export function openAiCompatReasoning(level: ThinkLevel, model: string, baseUrl = '', opts: { stream?: boolean } = {}): Record<string, unknown> {
  const lv: ThinkLevel = (THINK_LEVELS as readonly string[]).includes(level) ? level : 'off';
  switch (dialectFor(baseUrl)) {
    case 'openai': {
      const effort = clampEffort(lv, openAiLadder(model));
      return effort ? { reasoning_effort: effort } : {};
    }
    // OpenRouter maps one effort onto every vendor behind it and drops it for
    // models that do not reason, so the level goes through as it is.
    case 'openrouter': return { reasoning: { effort: lv === 'off' ? 'none' : lv } };
    case 'groq': return groqReasoning(lv, model);
    // Fireworks accepts the field on every model and handles the ones that
    // cannot use it itself.
    case 'fireworks': return { reasoning_effort: lv === 'off' ? 'none' : clampEffort(lv, THREE) };
    case 'together': return togetherReasoning(lv, model);
    case 'siliconflow': return siliconflowReasoning(lv, model);
    case 'dashscope': return dashscopeReasoning(lv, model, opts.stream ?? true);
    case 'gemini': {
      const effort = clampEffort(lv, geminiLadder(model));
      return effort ? { reasoning_effort: effort } : {};
    }
    // DeepSeek's own API picks reasoning by model name and has no field for it.
    case 'deepseek': return {};
    default: return genericReasoning(lv, model);
  }
}

/**
 * Whether an OpenAI-shaped call may carry the sampling knobs — temperature,
 * top_p and the two penalties.
 *
 * OpenAI's reasoning models refuse them with a 400 rather than ignoring them,
 * so one tuning slider took out every draft on gpt-5. Decided by name rather
 * than host, because the same models arrive through OpenRouter and other
 * proxies under a vendor prefix and refuse there too.
 */
export function openAiTakesSampling(model: string): boolean {
  return !/^(?:o[1-9](?:-|$)|gpt-(?:[5-9]|\d{2}))/.test(bare(model));
}

/**
 * Which field caps an OpenAI-shaped completion. OpenAI itself refuses
 * `max_tokens` on its reasoning models and wants `max_completion_tokens`;
 * most other servers know only the older name.
 */
export function openAiMaxTokensField(baseUrl: string): 'max_tokens' | 'max_completion_tokens' {
  return dialectFor(baseUrl) === 'openai' ? 'max_completion_tokens' : 'max_tokens';
}

// ── Ollama ─────────────────────────────────────────────────────────────────

/**
 * Ollama takes `false` or low|medium|high; anything above high clamps. gpt-oss
 * IGNORES booleans and thinks at its default whatever `false` says, so `off`
 * there is `low`, the least it will do.
 */
export function ollamaThink(level: ThinkLevel, model = ''): false | 'low' | 'medium' | 'high' {
  if (level === 'off') return /gpt-oss/i.test(String(model)) ? 'low' : false;
  if (level === 'low' || level === 'medium') return level;
  return 'high';
}

// ── Anthropic ──────────────────────────────────────────────────────────────

export interface AnthropicFamily { adaptive: boolean; budget: boolean; efforts: Rung[]; alwaysThinks?: boolean; quietOff?: boolean }

/**
 * What one Claude model accepts, from its id — used until the Models API has
 * said, and as the whole answer when it cannot be asked. Three request shapes
 * and every mismatch a 400: adaptive + `output_config.effort` on 4.6 and later
 * (`xhigh` arriving at Opus 4.7, so 4.6 has four efforts); `{ type:
 * 'enabled', budget_tokens }` on Haiku 4.5, Opus 4.5 and older, which reject
 * adaptive; and Fable/Mythos, which always think and refuse `disabled`.
 */
export function anthropicFamily(model: string): AnthropicFamily {
  const m = String(model ?? '').toLowerCase();
  if (/^claude-(?:fable|mythos)/.test(m)) return { adaptive: true, budget: false, efforts: EFFORTS, alwaysThinks: true };
  if (/^claude-opus-5/.test(m)) return { adaptive: true, budget: false, efforts: EFFORTS, quietOff: true };
  if (/^claude-(?:opus-4-[78]|sonnet-5)/.test(m)) return { adaptive: true, budget: false, efforts: EFFORTS };
  if (/^claude-(?:opus|sonnet)-4-6/.test(m)) return { adaptive: true, budget: true, efforts: ['low', 'medium', 'high', 'max'] };
  if (/^claude-opus-4-5/.test(m)) return { adaptive: false, budget: true, efforts: THREE };
  if (/^claude-(?:haiku-4|sonnet-4|opus-4|3)/.test(m)) return { adaptive: false, budget: true, efforts: [] };
  // A model released after this was written: the current generation's shape.
  return { adaptive: true, budget: false, efforts: EFFORTS, quietOff: true };
}

/** The same facts from `GET /v1/models/{id}`'s capability tree, or null when it carried none. */
export function anthropicCapabilities(capabilities: any): Pick<AnthropicFamily, 'adaptive' | 'budget' | 'efforts'> | null {
  const t = capabilities?.thinking;
  const e = capabilities?.effort;
  if (!t && !e) return null;
  return {
    adaptive: Boolean(t?.types?.adaptive?.supported),
    budget: Boolean(t?.types?.enabled?.supported),
    efforts: e?.supported ? EFFORTS.filter((l) => e?.[l]?.supported) : [],
  };
}

/** The thinking allowance on a budget-only model, always below `max_tokens`. */
export function anthropicBudget(level: ThinkEffort, maxTokens: number): number {
  const ceiling = maxTokens > 0 ? maxTokens : 8192;
  const want = level === 'max' ? Math.floor(ceiling / 2) : BUDGETS[level];
  return Math.max(1024, Math.min(want, Math.floor(ceiling / 2)));
}

export interface AnthropicReasoning {
  /** Spread into the request. */
  body: Record<string, unknown>;
  /** Whether the model deliberates on this call. */
  thinking: boolean;
  /** Whether temperature may be sent — never while thinking, which is a 400. */
  sampling: boolean;
  /** What `max_tokens` must be at least, when a budget has to fit under it. */
  minMaxTokens?: number;
}

/**
 * The reasoning half of a Messages API body.
 *
 * `allowDisabled: false` is for the assistant's tool loop, where `{ type:
 * 'disabled' }` is the dangerous way to switch thinking off: the model
 * sometimes writes a tool call into its visible text instead of a tool_use
 * block, and the turn succeeds with the call never having run.
 */
export function anthropicReasoning(
  model: string,
  level: ThinkLevel,
  opts: { capabilities?: unknown; maxTokens?: number; allowDisabled?: boolean; takesSampling?: boolean } = {},
): AnthropicReasoning {
  const { capabilities, maxTokens = 0, allowDisabled = true, takesSampling = false } = opts;
  const lv: ThinkLevel = (THINK_LEVELS as readonly string[]).includes(level) ? level : 'off';
  const fam: AnthropicFamily = { ...anthropicFamily(model), ...(anthropicCapabilities(capabilities) ?? {}) };
  const effort = fam.efforts.length ? clampEffort(lv === 'off' ? 'low' : lv, fam.efforts) : null;
  const withEffort = (body: Record<string, unknown>) => (effort ? { ...body, output_config: { effort } } : body);

  if (lv === 'off') {
    // No off switch: the parameter is omitted, and with no display asked for
    // the working-out comes back empty — the only thing `off` can mean here.
    if (fam.alwaysThinks) return { body: withEffort({}), thinking: false, sampling: false };
    if (fam.adaptive && (fam.quietOff || !allowDisabled)) {
      return { body: withEffort({ thinking: { type: 'adaptive', display: 'omitted' } }), thinking: false, sampling: false };
    }
    if (fam.adaptive) return { body: { thinking: { type: 'disabled' } }, thinking: false, sampling: takesSampling };
    return { body: {}, thinking: false, sampling: takesSampling };
  }

  if (fam.adaptive) {
    // `display: 'summarized'` is what makes the working-out non-empty; the
    // current models default to `omitted`, a silent change from 4.6.
    return { body: withEffort({ thinking: { type: 'adaptive', display: 'summarized' } }), thinking: true, sampling: false };
  }
  if (fam.budget) {
    const budget = anthropicBudget(lv, maxTokens);
    return {
      body: withEffort({ thinking: { type: 'enabled', budget_tokens: budget } }),
      thinking: true,
      sampling: false,
      minMaxTokens: budget + 1024,
    };
  }
  return { body: {}, thinking: false, sampling: takesSampling };
}
