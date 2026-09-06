// LLM access. Ollama's native API is the default (streams NDJSON); an
// OpenAI-compatible endpoint is supported for people who already run one.
// Nothing here is in the mail path: if the model is down, drafting is
// unavailable and everything else keeps working.
import { config } from '../config.js';
import { assertFreshConversation } from './prompts.js';
import { one, query } from '../db.js';
import { recommendModel } from './models.js';
import { logger } from '../log.js';

const log = logger('ai');

export interface AiSettings {
  enabled: boolean;
  provider: 'ollama' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  numCtx: number;
  keepAlive: string;
  // Reasoning models (qwen3, deepseek-r1 and the like) answer in two parts:
  // their working-out and the reply. Tern wants the reply, so thinking is
  // off unless an admin turns it on — and when it is on, the reasoning is
  // paid for out of its own budget rather than out of the email's.
  allowThinking: boolean;
  thinkEffort: 'low' | 'medium' | 'high';
  thinkingBudget: number;
  systemPrompt: string;
  topP: number;
  topK: number;
  repeatPenalty: number;
  maxTokens: number;
}

const DEFAULTS: AiSettings = {
  enabled: config.aiEnabled,
  provider: 'ollama',
  baseUrl: config.ollamaUrl,
  apiKey: '',
  model: config.aiModel || recommendModel(config.totalMemBytes).model,
  temperature: 0.7,
  // Big enough to hold a long thread and still leave room for the answer;
  // `threadBudgetChars` sizes the conversation to whatever this is set to.
  numCtx: 8192,
  keepAlive: '10m',
  allowThinking: false,
  thinkEffort: 'low',
  thinkingBudget: 3000,
  systemPrompt: '',
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  maxTokens: 700,
};

let cache: { at: number; value: AiSettings } | null = null;
export async function getAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await one<{ value: Partial<AiSettings> }>(`SELECT value FROM settings WHERE key='ai'`);
  const value = { ...DEFAULTS, ...(row?.value ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}
export async function saveAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await getAiSettings();
  const next = { ...current, ...patch };
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ('ai', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(next)]);
  cache = null;
  return next;
}
export function aiDefaults(): AiSettings { return { ...DEFAULTS }; }

// Ollama's keep_alive is either a duration string ("10m", "1h") or a number
// of seconds, where -1 means "keep it loaded" and 0 "unload at once". A bare
// number sent as a string is refused with `missing unit in duration`, which
// is what "-1" in the admin field used to produce, so numbers go out as
// numbers.
export function keepAliveValue(setting: string): string | number {
  const v = String(setting ?? '').trim();
  if (!v) return DEFAULTS.keepAlive;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// The message a person gets when a model returns nothing usable. A reasoning
// model that spent its budget thinking is the common cause and is worth
// naming, because the fix is a setting rather than a bigger machine.
export function emptyAnswer(model: string, thoughtChars: number, budget: number): string {
  if (thoughtChars > 0) {
    return `"${model}" wrote only its reasoning, both with thinking on and with it off. Raise the reply length above ${budget} tokens in Admin → AI model, or try a different model.`;
  }
  return `"${model}" returned an empty reply. Try a different model, or raise the reply length in Admin → AI model.`;
}

// What the admin field accepts: a duration with a unit, or a plain number of
// seconds (-1 for "never unload", 0 to unload at once).
export function isValidKeepAlive(v: string): boolean {
  const t = String(v ?? '').trim();
  if (!t) return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return true;
  return /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)$/.test(t);
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatOptions { messages: ChatMessage[]; model?: string; temperature?: number; signal?: AbortSignal; maxTokens?: number }

// Ollama refuses `think` outright on a model that cannot reason
// (`"qwen2.5:1.5b" does not support thinking`), so turning the setting on
// with the model most small boxes run would break every AI feature. The
// capability is read once per model and remembered; anything unknown is
// treated as not able to think, which is the safe way to be wrong.
const thinkCapable = new Map<string, boolean>();
export async function modelCanThink(baseUrl: string, model: string): Promise<boolean> {
  const key = `${baseUrl}|${model}`;
  const known = thinkCapable.get(key);
  if (known !== undefined) return known;
  let can = false;
  try {
    const res = await fetch(`${baseUrl}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j: any = await res.json();
      can = Array.isArray(j.capabilities) && j.capabilities.includes('thinking');
    }
  } catch { /* unreachable model: the chat call reports it properly */ }
  thinkCapable.set(key, can);
  return can;
}
export function forgetModelCapabilities(): void { thinkCapable.clear(); }

export async function* chatStream(opts: ChatOptions): AsyncGenerator<string> {
  assertFreshConversation(opts.messages);
  const s = await getAiSettings();
  if (!s.enabled) throw new Error('AI drafting is turned off in Settings → AI');
  const model = opts.model || s.model;
  if (s.provider === 'openai') {
    yield* openaiStream(s, model, opts);
    return;
  }
  const think = s.allowThinking && (await modelCanThink(s.baseUrl, model));
  // How much working-out the model did, so the log and the error message can
  // say how big the budget wanted to be. Per call, not shared.
  const stats = { thoughtChars: 0 };
  let produced = false;
  for await (const piece of ollamaStream(s, model, opts, think, stats)) { produced = true; yield piece; }
  if (produced) return;
  // Nothing but reasoning came back. Rather than showing the person an error
  // for a model that is working, ask again with thinking off: that path is
  // known to answer, and the draft is what was wanted in the first place.
  if (think) {
    log.warn('model answered with reasoning only; retrying without thinking', { model, thoughtChars: stats.thoughtChars, thinkingBudget: s.thinkingBudget });
    for await (const piece of ollamaStream(s, model, opts, false, stats)) { produced = true; yield piece; }
    if (produced) return;
  }
  throw new Error(emptyAnswer(model, stats.thoughtChars, opts.maxTokens ?? s.maxTokens));
}

async function* ollamaStream(s: AiSettings, model: string, opts: ChatOptions, think: boolean, stats: { thoughtChars: number }): AsyncGenerator<string> {
  const reply = opts.maxTokens ?? s.maxTokens;
  const res = await fetch(`${s.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: opts.messages, // one system + one user message; never a `context` from a previous answer
      stream: true,
      // Ollama takes a boolean or an effort level. The reply and the
      // reasoning share one `num_predict`, so a thinking model given only
      // the email's budget spends it all working out loud and returns
      // nothing: reasoning gets its own allowance on top.
      think: think ? s.thinkEffort : false,
      keep_alive: keepAliveValue(s.keepAlive),
      options: {
        temperature: opts.temperature ?? s.temperature,
        num_ctx: s.numCtx,
        num_predict: think ? reply + Math.max(0, s.thinkingBudget) : reply,
        top_p: s.topP,
        top_k: s.topK,
        repeat_penalty: s.repeatPenalty,
      },
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 && /not found/i.test(body)) throw new Error(`Model "${model}" is not downloaded. Pull it in Settings → AI.`);
    throw new Error(`Ollama returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new Error(j.error);
      // `thinking` is the model's working-out and is never part of a draft.
      // Its length is kept only to tell an admin how big the budget wants
      // to be when a model spends the lot and writes nothing.
      if (j.message?.thinking) stats.thoughtChars += String(j.message.thinking).length;
      const piece = j.message?.content;
      if (piece) yield piece;
      if (j.done) return;
    }
  }
}

async function* openaiStream(s: AiSettings, model: string, opts: ChatOptions): AsyncGenerator<string> {
  const reply = opts.maxTokens ?? s.maxTokens;
  const res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({
      model, messages: opts.messages, stream: true,
      temperature: opts.temperature ?? s.temperature,
      // As with Ollama, reasoning is spent out of the same ceiling as the
      // answer, so it gets its own allowance rather than eating the email.
      max_tokens: s.allowThinking ? reply + Math.max(0, s.thinkingBudget) : reply,
      top_p: s.topP,
      ...(s.allowThinking ? { reasoning_effort: s.thinkEffort } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`LLM endpoint returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let produced = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { if (!produced) throw new Error(emptyAnswer(model, s.allowThinking ? 1 : 0, reply)); return; }
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(String(j.error?.message ?? j.error));
        const d = j.choices?.[0]?.delta;
        // Reasoning arrives on its own field on most OpenAI-compatible
        // servers; the ones that inline it in <think> tags are cleaned up
        // after generation instead.
        if (d?.reasoning_content || d?.reasoning) continue;
        const piece = d?.content;
        if (piece) { produced = true; yield piece; }
      } catch (e) { if (e instanceof Error && !(e instanceof SyntaxError)) throw e; }
    }
  }
  if (!produced) throw new Error(emptyAnswer(model, s.allowThinking ? 1 : 0, reply));
}

export async function chat(opts: ChatOptions): Promise<string> {
  let out = '';
  for await (const piece of chatStream(opts)) out += piece;
  return out.trim();
}

// ---------- Ollama management ----------

export async function ollamaHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const s = await getAiSettings();
  try {
    const res = await fetch(`${s.baseUrl}/api/version`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j: any = await res.json();
    return { ok: true, version: j.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listModels(): Promise<{ name: string; size: number; modified: string; family?: string; parameterSize?: string; quantization?: string }[]> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/tags`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => ({ name: m.name, size: m.size, modified: m.modified_at, family: m.details?.family, parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level }));
}

export async function loadedModels(): Promise<{ name: string; sizeVram: number; expiresAt: string }[]> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/ps`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return [];
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => ({ name: m.name, sizeVram: m.size_vram, expiresAt: m.expires_at }));
}

export async function* pullModel(name: string, signal?: AbortSignal): AsyncGenerator<{ status: string; completed?: number; total?: number; error?: string }> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }), signal });
  if (!res.ok || !res.body) throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* skip */ }
    }
  }
  log.info('model pulled', { name });
}

export async function deleteModel(name: string): Promise<void> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
}
