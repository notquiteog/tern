// LLM access. Ollama's native API is the default (streams NDJSON); an
// OpenAI-compatible endpoint is supported for people who already run one.
// Nothing here is in the mail path: if the model is down, drafting is
// unavailable and everything else keeps working.
import { config } from '../config.js';
import { assertFreshConversation } from './prompts.js';
import { one, query } from '../db.js';
import { recommendModel, recommendNumCtx } from './models.js';
import { defaultTuningFor } from './presets.js';
import { acquireSlot, busyMessage, kvBytesPerToken, slotPlan } from './slots.js';
import { assertCapability, type Capability } from '../services/capabilities.js';
import { beginSession, endSession, onWipe } from './session.js';
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
  // Min-p keeps tokens whose probability is at least this fraction of the
  // most likely one's, which cuts the tail without the flat ceiling top-p
  // imposes. 0 leaves it off, which is Ollama's own default.
  minP: number;
  repeatPenalty: number;
  // How far back the repetition penalty looks. Ollama's own default of 64
  // tokens is less than a paragraph, so a model that opens every paragraph
  // the same way is never penalised for it; -1 is the whole context.
  repeatLastN: number;
  // The portable pair. Unlike `repeat_penalty` and `top_k`, which real
  // OpenAI refuses outright, these two are accepted by OpenAI, vLLM,
  // llama.cpp and Ollama alike, so they are the only repetition control the
  // OpenAI-compatible provider has. 0 is off on both.
  presencePenalty: number;
  frequencyPenalty: number;
  maxTokens: number;
  // Unload the model once nothing is generating, so the KV cache holding the
  // last prompt — somebody's email — does not sit in memory for the rest of
  // the keep-alive window. Costs a model load the next time somebody asks.
  wipeAfterUse: boolean;
  wipeIdleSeconds: number;
  // The model that turns a message into a vector for meaning search. Its own
  // setting because it is a different, much smaller model from the one that
  // writes, and an install may want one without the other.
  embedModel: string;
  // Whether several people may be answered at once. Off serialises every
  // generation on this install, which is the right setting for a small box:
  // each slot Ollama serves in parallel costs another context window of KV
  // cache. See ai/slots.ts.
  concurrency: boolean;
}

// Chosen before the defaults are built, because the sampling defaults depend
// on which model this install is going to run.
const DEFAULT_MODEL = config.aiModel || recommendModel(config.totalMemBytes).model;

const BASE_DEFAULTS: AiSettings = {
  enabled: config.aiEnabled,
  provider: 'ollama',
  baseUrl: config.ollamaUrl,
  apiKey: '',
  model: DEFAULT_MODEL,
  temperature: 0.7,
  // How much conversation the model is shown, sized to the machine rather
  // than fixed at 8192 for everybody — see models.ts. `threadBudgetChars`
  // sizes the thread to whatever this is, so on a box with the memory for it
  // a long thread now arrives whole instead of being trimmed from the middle.
  numCtx: recommendNumCtx(config.totalMemBytes),
  keepAlive: '10m',
  allowThinking: false,
  thinkEffort: 'low',
  thinkingBudget: 3000,
  systemPrompt: '',
  topP: 0.9,
  topK: 40,
  minP: 0,
  repeatPenalty: 1.1,
  repeatLastN: 256,
  presencePenalty: 0,
  frequencyPenalty: 0,
  maxTokens: 700,
  wipeAfterUse: true,
  wipeIdleSeconds: 90,
  embedModel: config.aiEmbedModel,
  concurrency: true,
};

// The numbers above are the general-purpose ones; the model's own preset wins
// where it has an opinion. See presets.ts for why this is not left to an
// admin to notice and apply by hand.
const DEFAULTS: AiSettings = { ...BASE_DEFAULTS, ...defaultTuningFor(DEFAULT_MODEL) };

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

// The key, on every request to either provider.
//
// Ollama has no authentication of its own, so anybody who runs one anywhere
// but on this box has put it behind a proxy that wants a token — and until
// this was sent on the Ollama path too, "remote Ollama" meant "an Ollama
// open to whoever finds it". It is the same stored key the OpenAI-compatible
// provider uses; an install with an empty key sends nothing, which is the
// bundled container over the compose network.
export async function providerHeaders(s?: AiSettings): Promise<Record<string, string>> {
  const cfg = s ?? (await getAiSettings());
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

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

// Who this generation is for and which capability they turned on to get it.
// Required, and checked before a single byte leaves the process: the gate is
// an argument rather than a convention, so a new code path that forgets to
// ask does not compile. `assertCapability` throws when the person has not
// consented or an admin has switched the feature off for the install.
export interface AiConsent { userId: number; capability: Capability }

export interface ChatOptions {
  messages: ChatMessage[]; consent: AiConsent; model?: string; temperature?: number; signal?: AbortSignal; maxTokens?: number;
  // Forces reasoning off for this call whatever the install has turned on.
  // Some tasks are not worth thinking about: a one-line summary of an email
  // costs a whole reasoning budget and a minute of CPU to answer a question
  // the first sentence already answers.
  noThink?: boolean;
  // A reasoning model's working-out, as it arrives. It is never part of a
  // draft; the composer shows it so a two-minute generation looks like
  // something happening rather than a stalled spinner.
  onThinking?: (piece: string) => void;
  // Sequences that end a generation early. Set per mode rather than by an
  // admin: they exist to cut off a small model that starts a second turn of
  // the conversation it was never in, not to shape the writing.
  stop?: string[];
  // Fixes the sampling so the same prompt gives the same answer. Used by the
  // evaluation scripts, which compare runs; never set for a person, whose
  // "try again" has to be able to produce something different.
  seed?: number;
  // Work nobody is waiting on: inbox summaries, campaign bodies, automatic
  // replies. It queues behind interactive drafting rather than beside it, so
  // a sequence run cannot take every slot the model has.
  background?: boolean;
  // Who this generation is for, so one person cannot hold more than their
  // share of the slots. Anything without an owner is the install's own work.
  owner?: string | number;
}

// What /api/show says about a model: what it can do, and the shape of its
// attention. Read once per model and remembered, because both answers are
// wanted on every settings page and neither changes while a model exists.
const described = new Map<string, { capabilities: string[]; info: Record<string, unknown> } | null>();
async function describeModel(baseUrl: string, model: string): Promise<{ capabilities: string[]; info: Record<string, unknown> } | null> {
  const key = `${baseUrl}|${model}`;
  const known = described.get(key);
  if (known !== undefined) return known;
  let out: { capabilities: string[]; info: Record<string, unknown> } | null = null;
  try {
    const res = await fetch(`${baseUrl}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders()) }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j: any = await res.json();
      out = { capabilities: Array.isArray(j.capabilities) ? j.capabilities : [], info: j.model_info ?? {} };
    }
  } catch { /* unreachable model: the chat call reports it properly */ }
  described.set(key, out);
  return out;
}

// Ollama refuses `think` outright on a model that cannot reason
// (`"qwen2.5:1.5b" does not support thinking`), so turning the setting on
// with the model most small boxes run would break every AI feature. Anything
// unknown is treated as not able to think, which is the safe way to be wrong.
export async function modelCanThink(baseUrl: string, model: string): Promise<boolean> {
  return (await describeModel(baseUrl, model))?.capabilities.includes('thinking') ?? false;
}

// What one token of context costs this model in memory, which is what makes
// a parallel slot expensive: Ollama holds `num_ctx` tokens of KV cache per
// slot. Null when the model does not describe its attention well enough to
// say — Admin → AI model then talks about slots and people and leaves memory
// out of it rather than guessing.
export async function modelKvBytesPerToken(baseUrl: string, model: string, cacheType = config.ollamaKvCacheType): Promise<number | null> {
  return kvBytesPerToken((await describeModel(baseUrl, model))?.info, cacheType);
}

export function forgetModelCapabilities(): void { described.clear(); }

// How the model picks its next token. Shared so the Ollama and the
// OpenAI-compatible paths sample the same way. Min-p is only sent when it is
// in use: a zero would be a no-op, and an endpoint that does not know the
// option should not have to see it.
export function samplingOptions(s: AiSettings, temperature?: number): Record<string, number> {
  return {
    temperature: temperature ?? s.temperature,
    top_p: s.topP,
    top_k: s.topK,
    ...(s.minP > 0 ? { min_p: s.minP } : {}),
    repeat_penalty: s.repeatPenalty,
    // The window the penalty above looks back over. Sent whenever it differs
    // from Ollama's default so an install that never touched the setting
    // still gets the wider window Tern prefers for email.
    repeat_last_n: s.repeatLastN,
    // Both default to 0, which is off, and both are omitted at 0 so a
    // stricter endpoint never has to see a parameter that does nothing.
    ...(s.presencePenalty ? { presence_penalty: s.presencePenalty } : {}),
    ...(s.frequencyPenalty ? { frequency_penalty: s.frequencyPenalty } : {}),
  };
}

export async function* chatStream(opts: ChatOptions): AsyncGenerator<string> {
  assertFreshConversation(opts.messages);
  // Before anything else, and before the prompt is looked at: is this person
  // allowed to have asked?
  await assertCapability(opts.consent.userId, opts.consent.capability);
  const s = await getAiSettings();
  if (!s.enabled) throw new Error('AI drafting is turned off in Settings → AI');
  const model = opts.model || s.model;
  const session = beginSession();
  try {
    if (s.provider === 'openai') {
      // Somebody else's endpoint decides how much it will do at once, and it
      // is not sharing one loaded model with this install; the gate below
      // would only slow it down.
      yield* openaiStream(s, model, opts);
      return;
    }
    yield* ollamaGeneration(s, model, opts);
  } finally {
    // The prompt goes now, whether this ended in an answer, an abort or a
    // throw. Nothing above this line is allowed to keep it.
    endSession(session, opts.messages, s);
  }
}

async function* ollamaGeneration(s: AiSettings, model: string, opts: ChatOptions): AsyncGenerator<string> {
  // One generation per slot Ollama has, and the retry below runs inside the
  // same slot: a model that answered with reasoning only should not have to
  // queue again to say something usable.
  const release = await acquireSlot(slotPlan(s.concurrency), opts.background ? 'background' : 'interactive', String(opts.owner ?? 'system'), opts.signal);
  try {
    const think = !opts.noThink && s.allowThinking && (await modelCanThink(s.baseUrl, model));
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
  } finally {
    release();
  }
}

async function* ollamaStream(s: AiSettings, model: string, opts: ChatOptions, think: boolean, stats: { thoughtChars: number }): AsyncGenerator<string> {
  const reply = opts.maxTokens ?? s.maxTokens;
  const res = await fetch(`${s.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) },
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
        num_ctx: s.numCtx,
        num_predict: think ? reply + Math.max(0, s.thinkingBudget) : reply,
        ...samplingOptions(s, opts.temperature),
        ...(opts.stop?.length ? { stop: opts.stop } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      },
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 && /not found/i.test(body)) throw new Error(`Model "${model}" is not downloaded. Pull it in Settings → AI.`);
    // Ollama's own queue is full (OLLAMA_MAX_QUEUE). That is a busy machine,
    // not a broken one, and saying so is the difference between "try again in
    // a moment" and an admin reading logs for a fault that is not there.
    if (res.status === 503) throw new Error(busyMessage());
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
      if (j.message?.thinking) {
        const t = String(j.message.thinking);
        stats.thoughtChars += t.length;
        opts.onThinking?.(t);
      }
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
      max_tokens: !opts.noThink && s.allowThinking ? reply + Math.max(0, s.thinkingBudget) : reply,
      top_p: s.topP,
      // Not an OpenAI parameter, but vLLM, llama.cpp and LM Studio all take
      // it; sent only when set so a stricter endpoint never sees it.
      ...(s.minP > 0 ? { min_p: s.minP } : {}),
      // The repetition controls this side understands. `repeat_penalty` and
      // `top_k` are deliberately not sent: real OpenAI answers 400 to an
      // unknown parameter, so the tuning that crosses over is this pair.
      ...(s.presencePenalty ? { presence_penalty: s.presencePenalty } : {}),
      ...(s.frequencyPenalty ? { frequency_penalty: s.frequencyPenalty } : {}),
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(!opts.noThink && s.allowThinking ? { reasoning_effort: s.thinkEffort } : {}),
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
      if (data === '[DONE]') { if (!produced) throw new Error(emptyAnswer(model, !opts.noThink && s.allowThinking ? 1 : 0, reply)); return; }
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(String(j.error?.message ?? j.error));
        const d = j.choices?.[0]?.delta;
        // Reasoning arrives on its own field on most OpenAI-compatible
        // servers; the ones that inline it in <think> tags are cleaned up
        // after generation instead.
        const reasoning = d?.reasoning_content ?? d?.reasoning;
        if (reasoning) { const t = String(reasoning); opts.onThinking?.(t); continue; }
        const piece = d?.content;
        if (piece) { produced = true; yield piece; }
      } catch (e) { if (e instanceof Error && !(e instanceof SyntaxError)) throw e; }
    }
  }
  if (!produced) throw new Error(emptyAnswer(model, !opts.noThink && s.allowThinking ? 1 : 0, reply));
}

export async function chat(opts: ChatOptions): Promise<string> {
  let out = '';
  for await (const piece of chatStream(opts)) out += piece;
  return out.trim();
}

// ---------- Embeddings ----------
// Meaning search needs a vector per message, from a much smaller model than
// the one that writes. It goes through the same consent gate: turning a
// message into a vector is reading it.
//
// The vectors leave here raw. services/embeddings.ts is what makes them safe
// to store, and nothing writes one to the database without passing through
// it first.
export interface EmbedResult { vectors: number[][]; model: string; dims: number }

export async function embed(texts: string[], consent: AiConsent, signal?: AbortSignal): Promise<EmbedResult> {
  await assertCapability(consent.userId, consent.capability);
  const s = await getAiSettings();
  if (!s.enabled) throw new Error('The model is turned off in Admin → AI model');
  const model = s.embedModel || DEFAULTS.embedModel;
  const input = texts.map((t) => String(t ?? '').slice(0, 8000)).filter(Boolean);
  if (!input.length) return { vectors: [], model, dims: 0 };

  const session = beginSession();
  try {
    if (s.provider === 'openai') {
      const res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
        body: JSON.stringify({ model, input }),
        signal,
      });
      if (!res.ok) throw new Error(`Embedding endpoint returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const j: any = await res.json();
      const vectors = (j.data ?? []).map((d: any) => (Array.isArray(d.embedding) ? d.embedding : []));
      return { vectors, model, dims: vectors[0]?.length ?? 0 };
    }
    const res = await fetch(`${s.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) },
      body: JSON.stringify({ model, input, keep_alive: keepAliveValue(s.keepAlive), truncate: true }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 404) throw new Error(`The embedding model "${model}" is not downloaded. Pull it in Admin → AI model.`);
      throw new Error(`Ollama returned HTTP ${res.status} for embeddings: ${body.slice(0, 200)}`);
    }
    const j: any = await res.json();
    const vectors: number[][] = Array.isArray(j.embeddings) ? j.embeddings : [];
    return { vectors, model, dims: vectors[0]?.length ?? 0 };
  } finally {
    // The texts handed in were mail. Same rule as a chat prompt: they do not
    // outlive the call.
    input.length = 0;
    texts.length = 0;
    endSession(session, undefined, s);
  }
}

// ---------- Ollama management ----------

export async function ollamaHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const s = await getAiSettings();
  try {
    const res = await fetch(`${s.baseUrl}/api/version`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j: any = await res.json();
    return { ok: true, version: j.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listModels(): Promise<{ name: string; size: number; modified: string; family?: string; parameterSize?: string; quantization?: string }[]> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/tags`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => ({ name: m.name, size: m.size, modified: m.modified_at, family: m.details?.family, parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level }));
}

// What Ollama currently holds in memory. `size` is the total the model is
// taking; `sizeVram` is how much of that is on a GPU and is 0 on the
// CPU-only boxes Tern is usually installed on — reporting only the VRAM
// figure there makes a resident 3 GB model look free.
export async function loadedModels(): Promise<{ name: string; size: number; sizeVram: number; expiresAt: string }[]> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/ps`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(4000) });
  if (!res.ok) return [];
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => ({ name: m.name, size: m.size ?? 0, sizeVram: m.size_vram ?? 0, expiresAt: m.expires_at }));
}

export async function* pullModel(name: string, signal?: AbortSignal): AsyncGenerator<{ status: string; completed?: number; total?: number; error?: string }> {
  const s = await getAiSettings();
  const res = await fetch(`${s.baseUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) }, body: JSON.stringify({ model: name, stream: true }), signal });
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
  // Dropped from memory first. Ollama removes the files either way, but a
  // copy that is already resident stays in RAM holding exactly the memory
  // the deletion was meant to give back.
  await unloadModel(s.baseUrl, name).catch(() => {});
  const res = await fetch(`${s.baseUrl}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) }, body: JSON.stringify({ model: name }) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 404) throw new Error(`Ollama has no model called "${name}"`);
    throw new Error(`Ollama refused to delete "${name}": HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }
  log.info('model deleted', { name });
}

// ---------- Residency ----------

// Ollama tags an untagged name with `:latest` when it loads it, so the model
// in the settings and the one in `/api/ps` often differ by that suffix alone.
export function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => { const t = String(s ?? '').trim(); return t.includes(':') ? t : `${t}:latest`; };
  return norm(a) === norm(b) && Boolean(String(a ?? '').trim());
}

// A load request with no prompt sets how long a model stays in memory:
// `keep_alive: 0` drops it at once, anything else resets its timer. Ollama
// will not load a model for this call, so re-timing one that is not resident
// is a no-op rather than a surprise 4 GB read.
async function setResidency(baseUrl: string, model: string, keepAlive: string | number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders()) },
      body: JSON.stringify({ model, keep_alive: keepAlive }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    await res.text().catch(() => '');
    return true;
  } catch { return false; }
}

// Which of the models Ollama is holding right now matches `model`.
async function residentAt(baseUrl: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { headers: await providerHeaders(), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const j: any = await res.json();
    return (j.models ?? []).some((m: any) => sameModel(String(m.name ?? ''), model));
  } catch { return false; }
}

export async function unloadModel(baseUrl: string, model: string): Promise<boolean> {
  if (!model) return false;
  if (!(await residentAt(baseUrl, model))) return false;
  const ok = await setResidency(baseUrl, model, 0);
  log.info(ok ? 'model unloaded' : 'model unload refused', { model, baseUrl });
  return ok;
}

// Called after the AI settings are saved. Picking a different model — or
// moving to a different server, or off Ollama altogether — leaves the old one
// resident until its keep-alive runs out, which on a 4.5 GB box means two
// models in memory and an out-of-memory kill on the next generation. The
// model Tern was using is dropped; anything else on a shared Ollama is left
// alone, because it is not ours to evict.
export async function releaseReplacedModel(before: AiSettings, after: AiSettings): Promise<void> {
  if (before.provider !== 'ollama' || !before.model) return;
  const movedOff = after.provider !== 'ollama' || after.baseUrl !== before.baseUrl;
  const swapped = !sameModel(before.model, after.model);
  if (movedOff || swapped) { await unloadModel(before.baseUrl, before.model); return; }
  // Same model, same server: only the keep-alive can have changed, and a
  // model already in memory keeps the expiry it was given when it was loaded.
  // "Never unload" (-1) sets that expiry centuries out, so without this a
  // change to the setting would not take effect until the process restarted.
  if (after.keepAlive !== before.keepAlive && (await residentAt(after.baseUrl, after.model))) {
    const ok = await setResidency(after.baseUrl, after.model, keepAliveValue(after.keepAlive));
    log.info(ok ? 'model residency updated' : 'model residency update refused', { model: after.model, keepAlive: after.keepAlive });
  }
}

// The idle wipe needs a way to unload; wiring it here rather than importing
// llm.ts from session.ts keeps that file free of HTTP.
onWipe(async () => {
  const s = await getAiSettings();
  if (s.provider !== 'ollama') return;
  for (const m of new Set([s.model, s.embedModel].filter(Boolean))) {
    await unloadModel(s.baseUrl, m);
  }
});
