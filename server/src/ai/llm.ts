// LLM access. Ollama's native API is the default (streams NDJSON); an
// OpenAI-compatible endpoint is supported for people who already run one.
// Nothing here is in the mail path: if the model is down, drafting is
// unavailable and everything else keeps working.
import { config } from '../config.js';
import { assertFreshConversation } from './prompts.js';
import { one, query } from '../db.js';
import { clampNumCtx, recommendModel, recommendNumCtx } from './models.js';
import { defaultTuningFor, matchesPreset, PRESET_FIELDS } from './presets.js';
import { acquireSlot, busyMessage, kvBytesPerToken, slotPlan } from './slots.js';
import { assertCapability, type Capability } from '../services/capabilities.js';
import { beginSession, endSession, onWipe } from './session.js';
import { logger } from '../log.js';
import { explainOutboundError, inspectCertificate, normalizeBaseUrl, outboundFetch, type CertInfo, type TlsTrust } from '../util/outbound.js';

const log = logger('ai');

export interface AiSettings {
  enabled: boolean;
  provider: 'ollama' | 'openai';
  baseUrl: string;
  apiKey: string;
  // Whether a certificate this machine cannot verify is accepted from the
  // model server. Off, and it has to be one a public authority vouches for.
  // On is for a model server that issued itself a certificate at boot, which
  // is what a rented GPU host does — see util/outbound.ts.
  tlsInsecure: boolean;
  model: string;
  temperature: number;
  numCtx: number;
  keepAlive: string;
  // Reasoning models (qwen3, deepseek-r1 and the like) answer in two parts:
  // their working-out and the reply. Tern wants the reply, so thinking is
  // off unless an admin turns it on — and when it is on, the reasoning is
  // paid for out of its own budget rather than out of the email's.
  //
  // It is off by default because of the clock, not the quality: measured on
  // the hardest recall cases it is more accurate with thinking on (15 clean
  // runs of 15, against 27 of 30 without), and it takes about 75 seconds a
  // draft instead of under a second. Nobody waits that long at a composer.
  // A responder answering one message in the background is the case where
  // the trade goes the other way.
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
  tlsInsecure: false,
  model: DEFAULT_MODEL,
  temperature: 0.7,
  // How much conversation the model is shown, sized to the machine rather
  // than fixed at 8192 for everybody — see models.ts. `threadBudgetChars`
  // sizes the thread to whatever this is, so on a box with the memory for it
  // a long thread now arrives whole instead of being trimmed from the middle.
  numCtx: recommendNumCtx(config.totalMemBytes),
  keepAlive: '10m',
  allowThinking: false,
  // Ollama accepts an effort level, and on qwen3.5:4b it changes nothing:
  // low, medium and high produce byte-identical output, seed for seed, over
  // six runs each. The model has one reasoning mode and Ollama passes any
  // truthy value through as "on". Kept because models that do expose levels
  // (gpt-oss and friends) honour it, but on the model Tern ships with this
  // setting is inert and the tuning panel should not promise otherwise.
  thinkEffort: 'low',
  // How much reasoning a generation may spend before the ceiling stops it.
  //
  // This was 3,000, and the first attempt at fixing it — 6,000 — was wrong
  // for an instructive reason. The evidence was the `thoughtChars` of
  // generations that had *run out*, which is a censored measurement: it says
  // where the wall was, not how far the model wanted to walk. Every sample
  // was piled against the cap, so a bigger cap just moved the pile.
  //
  // Measured properly, by removing the ceiling and watching where reasoning
  // stops on its own — six runs on the deep-thread reply, identical at every
  // effort level: 3,223 / 3,924 / 5,595 / 6,082 / 7,308 / 12,479 tokens. A
  // budget of 3,000 truncates all six; 6,000 truncates three; 16,000
  // truncates none and leaves room above the observed maximum.
  //
  // It costs nothing to set generously — it is a ceiling, not an allocation,
  // and only tokens actually generated are paid for. What it must not exceed
  // is the context window, which `predictTokens` below enforces.
  thinkingBudget: 16000,
  systemPrompt: '',
  topP: 0.9,
  topK: 40,
  minP: 0,
  repeatPenalty: 1.1,
  repeatLastN: 256,
  presencePenalty: 0,
  frequencyPenalty: 0,
  // The ceiling on the reply itself, separate from the reasoning budget. 700
  // was tight: a "long" draft plus a sign-off runs close to it, and a
  // summary of a 50-message thread closer still. It is a ceiling rather than
  // a target — the prompt is what decides length — so a generous one costs
  // nothing and stops the occasional answer being cut mid-sentence.
  maxTokens: 1500,
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
  const merged = { ...DEFAULTS, ...(row?.value ?? {}) };
  // Normalised coming out as well as going in: an install that saved a
  // trailing slash before this was fixed answered 404 to every call, and
  // repairing it here means an upgrade fixes it rather than an admin having
  // to notice and re-save.
  const value = { ...merged, baseUrl: normalizeBaseUrl(merged.baseUrl) };
  cache = { at: Date.now(), value };
  return value;
}
export async function saveAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await getAiSettings();
  let next = { ...current, ...patch };
  next.baseUrl = normalizeBaseUrl(next.baseUrl);
  // Changing the model moves the sampling with it — but only when nobody has
  // touched the sampling by hand.
  //
  // `saveAiSettings` writes every field, so once an install has saved AI
  // settings even once, the model-aware defaults in `DEFAULTS` never apply
  // again: switching from qwen2.5 to qwen3.5 left the old model's numbers in
  // place with nothing to indicate it. The test for "untouched" is exact
  // equality with the previous model's preset, so an admin who has tuned
  // anything at all keeps every number they chose.
  const changingModel = patch.model && patch.model !== current.model;
  const tuningInPatch = PRESET_FIELDS.some((k) => patch[k] !== undefined);
  if (changingModel && !tuningInPatch && matchesPreset(current, defaultTuningFor(current.model))) {
    next = { ...next, ...defaultTuningFor(patch.model!) };
    log.info('model changed and the tuning was untouched; moved it to the new model\'s preset', { from: current.model, to: patch.model });
  }
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

// The TLS trust for this install's model server, in the shape
// util/outbound.ts wants. Read from the same settings as the key, so a single
// place decides both halves of "how do we talk to that box".
export function trustOf(s: AiSettings): TlsTrust { return { insecure: Boolean(s.tlsInsecure) }; }

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
    const s = await getAiSettings();
    const res = await outboundFetch(`${normalizeBaseUrl(baseUrl)}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000) }, trustOf(s));
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

// What the model was actually trained for, out of /api/show. Null when the
// endpoint does not say. Ollama will happily accept a `num_ctx` larger than
// this and extend the model past its training length, which costs quality
// silently — phi4 is trained to 16k, mistral-small to 32k, qwen3.5 to 262k.
export async function modelContextLimit(baseUrl: string, model: string): Promise<number | null> {
  const info = (await describeModel(baseUrl, model))?.info;
  if (!info) return null;
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) return v;
  }
  return null;
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


// How many tokens a generation may produce, given what the window has left.
//
// `num_predict` is not bounded by `num_ctx`: ask for more than the window can
// hold and the generation is cut off by the context limit instead, which
// looks identical to a model that stopped early and is much harder to
// diagnose. With thinking on and a generous budget that is easy to hit — a
// 16,000-token budget on an 8,192-token window cannot possibly be honoured.
//
// So the ceiling is computed rather than sent blind: the window, minus a
// conservative estimate of the prompt, minus a little slack. When that leaves
// less than the reply needs there is nothing useful to do but say so.
export function predictTokens(opts: { numCtx: number; promptChars: number; replyTokens: number; thinkingTokens: number }): { numPredict: number; clamped: boolean } {
  // 3.2 characters per token deliberately over-estimates the prompt on
  // English prose (measured nearer 3.9), which is the safe direction.
  const promptTokens = Math.ceil(opts.promptChars / 3.2);
  const room = opts.numCtx - promptTokens - 128;
  const wanted = opts.replyTokens + Math.max(0, opts.thinkingTokens);
  if (room <= 0) return { numPredict: opts.replyTokens, clamped: true };
  return room < wanted ? { numPredict: Math.max(256, room), clamped: true } : { numPredict: wanted, clamped: false };
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
  // Never ask for a window the model was not trained for.
  const ctx = clampNumCtx(s.numCtx, await modelContextLimit(s.baseUrl, model));
  if (ctx < s.numCtx) log.debug('context window clamped to the model\'s own limit', { model, asked: s.numCtx, limit: ctx });
  const predict = predictTokens({
    numCtx: ctx,
    promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
    replyTokens: reply,
    thinkingTokens: think ? s.thinkingBudget : 0,
  });
  if (predict.clamped) {
    log.warn('the reply and reasoning budget do not fit the context window; shortening them', {
      model, numCtx: s.numCtx, asked: reply + (think ? s.thinkingBudget : 0), allowed: predict.numPredict,
    });
  }
  const res = await outboundFetch(`${s.baseUrl}/api/chat`, {
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
        num_ctx: ctx,
        num_predict: predict.numPredict,
        ...samplingOptions(s, opts.temperature),
        ...(opts.stop?.length ? { stop: opts.stop } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      },
    }),
    signal: opts.signal,
  }, trustOf(s)).catch((e) => { throw new Error(explainOutboundError(e, s.baseUrl)); });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    // A 404 with Ollama's own "model not found" body is a missing model; a
    // 404 with anything else is the address being wrong, and saying "pull
    // the model" for that sends an admin to fix the one thing that is fine.
    if (res.status === 404 && /not found/i.test(body) && /model/i.test(body)) throw new Error(`Model "${model}" is not downloaded. Pull it in Settings → AI.`);
    if (res.status === 404) throw new Error(`No Ollama API at ${s.baseUrl}. Check the base URL in Admin → AI model: it wants the server's root, with no path and no trailing slash.`);
    if (res.status === 401 || res.status === 403) throw new Error(`That model server refused the request (HTTP ${res.status}). It is behind authentication: put its token in the API key field in Admin → AI model.`);
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
  const res = await outboundFetch(`${s.baseUrl}/v1/chat/completions`, {
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
      const res = await outboundFetch(`${s.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
        body: JSON.stringify({ model, input }),
        signal,
      }, trustOf(s)).catch((e) => { throw new Error(explainOutboundError(e, s.baseUrl)); });
      if (!res.ok) throw new Error(`Embedding endpoint returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const j: any = await res.json();
      const vectors = (j.data ?? []).map((d: any) => (Array.isArray(d.embedding) ? d.embedding : []));
      return { vectors, model, dims: vectors[0]?.length ?? 0 };
    }
    const res = await outboundFetch(`${s.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) },
      body: JSON.stringify({ model, input, keep_alive: keepAliveValue(s.keepAlive), truncate: true }),
      signal,
    }, trustOf(s)).catch((e) => { throw new Error(explainOutboundError(e, s.baseUrl)); });
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

export async function ollamaHealth(candidate?: AiSettings): Promise<{ ok: boolean; version?: string; error?: string }> {
  const s = candidate ?? (await getAiSettings());
  if (!s.baseUrl) return { ok: false, error: 'No address is set for the model server' };
  try {
    const res = await outboundFetch(`${s.baseUrl}/api/version`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(6000) }, trustOf(s));
    if (!res.ok) return { ok: false, error: httpHint(res.status, s) };
    const j: any = await res.json();
    return { ok: true, version: j.version };
  } catch (e) {
    // The reason, not `fetch failed`: a self-signed certificate, a closed
    // port and a bad hostname have three different fixes.
    return { ok: false, error: explainOutboundError(e, s.baseUrl) };
  }
}

// What a refusal from the other end most likely means. Written for the two
// that a remote model server actually produces: a proxy wanting a token, and
// a base URL with a path or a trailing slash on it.
export function httpHint(status: number, s: AiSettings): string {
  if (status === 401 || status === 403) return `HTTP ${status}: that server wants authentication. Put its token in the API key field — it is sent as \`Authorization: Bearer\`.`;
  if (status === 404) return `HTTP 404: nothing is serving the Ollama API at ${s.baseUrl}. The base URL is the server's root — no path, no trailing slash.`;
  if (status === 502 || status === 503 || status === 504) return `HTTP ${status}: a proxy in front of that server could not reach it.`;
  return `HTTP ${status}`;
}

// Whether a provider an admin has typed in but not yet saved actually works,
// and if not, precisely which part of it does not.
//
// Saving first and reading the status line afterwards was the only way to
// find out, and saving has side effects — it unloads the model the install
// was using. This asks the question without changing anything, which is what
// makes a wrong address recoverable in one step instead of three.
export interface ProviderCheck {
  ok: boolean;
  version?: string;
  error?: string;
  models?: string[];
  modelInstalled?: boolean;
  cert?: CertInfo | null;
}

export async function checkProvider(candidate: AiSettings): Promise<ProviderCheck> {
  const s = { ...candidate, baseUrl: normalizeBaseUrl(candidate.baseUrl) };
  if (!s.baseUrl) return { ok: false, error: 'Give the model server\'s address first' };
  // Looked at whichever way the check goes: an admin deciding whether to
  // trust a certificate should be able to see it, and an admin who already
  // has should be able to confirm it is still the same one.
  const cert = await inspectCertificate(s.baseUrl).catch(() => null);

  if (s.provider === 'openai') {
    try {
      const res = await outboundFetch(`${s.baseUrl}/v1/models`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(6000) }, trustOf(s));
      if (!res.ok) return { ok: false, error: httpHint(res.status, s), cert };
      const j: any = await res.json().catch(() => null);
      const models = Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : undefined;
      return { ok: true, models, modelInstalled: models ? models.includes(s.model) : undefined, cert };
    } catch (e) {
      return { ok: false, error: explainOutboundError(e, s.baseUrl), cert };
    }
  }

  const health = await ollamaHealth(s);
  if (!health.ok) return { ok: false, error: health.error, cert };
  // Reachable is not the same as usable: the model named in the settings has
  // to be one this server actually has, and on somebody else's Ollama it
  // very often is not.
  try {
    const res = await outboundFetch(`${s.baseUrl}/api/tags`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(8000) }, trustOf(s));
    if (!res.ok) return { ok: true, version: health.version, cert, error: `Reachable, but it would not list its models: ${httpHint(res.status, s)}` };
    const j: any = await res.json();
    const models = (j.models ?? []).map((m: any) => String(m.name ?? '')).filter(Boolean);
    return { ok: true, version: health.version, models, modelInstalled: models.some((n: string) => sameModel(n, s.model)), cert };
  } catch (e) {
    return { ok: true, version: health.version, cert, error: explainOutboundError(e, s.baseUrl) };
  }
}

export async function listModels(): Promise<{ name: string; size: number; modified: string; family?: string; parameterSize?: string; quantization?: string; capabilities: string[] }[]> {
  const s = await getAiSettings();
  const res = await outboundFetch(`${s.baseUrl}/api/tags`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(8000) }, trustOf(s)).catch((e) => { throw new Error(explainOutboundError(e, s.baseUrl)); });
  if (!res.ok) throw new Error(httpHint(res.status, s));
  const j: any = await res.json();
  // `capabilities` is what separates a model that writes from one that only
  // embeds. Without it the page offered "Use" on all-minilm, which would have
  // set the drafting model to something that cannot draft.
  return (j.models ?? []).map((m: any) => ({ name: m.name, size: m.size, modified: m.modified_at, family: m.details?.family, parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level, capabilities: Array.isArray(m.capabilities) ? m.capabilities : [] }));
}

// What Ollama currently holds in memory. `size` is the total the model is
// taking; `sizeVram` is how much of that is on a GPU and is 0 on the
// CPU-only boxes Tern is usually installed on — reporting only the VRAM
// figure there makes a resident 3 GB model look free.
export async function loadedModels(): Promise<{ name: string; size: number; sizeVram: number; expiresAt: string }[]> {
  const s = await getAiSettings();
  const res = await outboundFetch(`${s.baseUrl}/api/ps`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(4000) }, trustOf(s));
  if (!res.ok) return [];
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => ({ name: m.name, size: m.size ?? 0, sizeVram: m.size_vram ?? 0, expiresAt: m.expires_at }));
}

export async function* pullModel(name: string, signal?: AbortSignal): AsyncGenerator<{ status: string; completed?: number; total?: number; error?: string }> {
  const s = await getAiSettings();
  const res = await outboundFetch(`${s.baseUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) }, body: JSON.stringify({ model: name, stream: true }), signal }, trustOf(s)).catch((e) => { throw new Error(explainOutboundError(e, s.baseUrl)); });
  if (!res.ok || !res.body) throw new Error(`${httpHint(res.status, s)}${(await res.text().catch(() => '')).slice(0, 200)}`);
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
  const res = await outboundFetch(`${s.baseUrl}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) }, body: JSON.stringify({ model: name }) }, trustOf(s));
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
    const s = await getAiSettings();
    const res = await outboundFetch(`${normalizeBaseUrl(baseUrl)}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) },
      body: JSON.stringify({ model, keep_alive: keepAlive }),
      signal: AbortSignal.timeout(15_000),
    }, trustOf(s));
    if (!res.ok) return false;
    await res.text().catch(() => '');
    return true;
  } catch { return false; }
}

// Which of the models Ollama is holding right now matches `model`.
async function residentAt(baseUrl: string, model: string): Promise<boolean> {
  try {
    const s = await getAiSettings();
    const res = await outboundFetch(`${normalizeBaseUrl(baseUrl)}/api/ps`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(4000) }, trustOf(s));
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
  if (before.provider !== 'ollama') return;
  const movedOff = after.provider !== 'ollama' || after.baseUrl !== before.baseUrl;
  // The embedding model is resident in its own right — it loads beside the
  // writing one rather than instead of it — so replacing it leaves the old
  // one holding memory until its keep-alive runs out unless it is dropped.
  if (before.embedModel && (movedOff || !sameModel(before.embedModel, after.embedModel))) {
    await unloadModel(before.baseUrl, before.embedModel).catch(() => {});
  }
  if (!before.model) return;
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
