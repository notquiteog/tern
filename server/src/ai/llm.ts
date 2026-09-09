// LLM access. Ollama's native API is the default (streams NDJSON); an
// OpenAI-compatible endpoint is supported for people who already run one; and
// Anthropic's Messages API is supported for people who would rather rent the
// model than run it. Nothing here is in the mail path: if the model is down,
// drafting is unavailable and everything else keeps working.
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
import { explainTorError, torProxyAddress } from '../util/tor.js';
import {
  endpointHeaders, notConfigured, transportFor as endpointTransport,
  type ModelEndpoint,
} from './endpoint.js';
import { embedInputChars, embedModelInfo, embedModelsForShape } from './providers.js';

const log = logger('ai');

export type AiProvider = 'ollama' | 'openai' | 'anthropic';

// Where embeddings come from, which is not always where drafting comes from.
// `same` is the default and what every install had before this existed. There
// is deliberately no `anthropic`: the Messages API has no embeddings endpoint
// at all, so an option for it would be an option that cannot work.
//
// `gemini` and `voyage` are here and NOT on `AiProvider`, which is the same
// rule pointing the other way: neither serves chat, so offering either for
// drafting would be a setting that cannot work either. A test asserts both
// halves, because the two enums are edited at different times by people
// thinking about different things.
export type EmbedProvider = 'same' | 'ollama' | 'openai' | 'gemini' | 'voyage';

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  // Whether a certificate this machine cannot verify is accepted from the
  // model server. Off, and it has to be one a public authority vouches for.
  // On is for a model server that issued itself a certificate at boot, which
  // is what a rented GPU host does — see util/outbound.ts.
  tlsInsecure: boolean;
  // Reach the model through the local Tor proxy.
  //
  // For one situation, and off by default because it is useless in every
  // other: the model is somebody else's machine, and a rented GPU host
  // otherwise learns this mail server's address from every request. It also
  // makes an .onion model server reachable at all. It does NOT change what is
  // sent — the same prompt crosses either way — only who learns where this
  // install is, so a model running on this box has nothing to gain from it.
  useTor: boolean;
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
  // ...and, since one of the three providers cannot embed at all, its own
  // server as well. An install that drafts on Anthropic still wants meaning
  // search, so it points this at the Ollama it was already running. Left on
  // `same`, everything below behaves exactly as it did before this existed.
  embedProvider: EmbedProvider;
  embedBaseUrl: string;
  embedApiKey: string;
  // Its own certificate rule and its own proxy, not the language model's.
  // While these did not exist, an embedder on a separate box inherited both
  // from whatever the drafting server happened to need — so pointing meaning
  // search at a machine on the LAN silently sent it through Tor if the GPU was
  // reached that way. `same` still inherits, but now it inherits deliberately
  // and inherits everything.
  embedTlsInsecure: boolean;
  embedUseTor: boolean;
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
  useTor: false,
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
  //
  // **0 now, meaning no ceiling at all**, which is where that measurement was
  // pointing the whole time: the honest reading of "16,000 truncates none" is
  // that the ceiling was never the thing doing the work. The distribution has
  // a long tail — 3,223 to 12,479 tokens across six identical runs — and a
  // fixed number is a bet that the tail stops where it was last observed to
  // stop. It does not, on a harder thread or a different model.
  //
  // It matters more now than when this was written, because a frontier model
  // with reasoning enabled is an explicitly supported configuration rather
  // than an edge case, and those deliberate for far longer than any local
  // model measured here. A budget sized to gemma4:12b silently truncates the
  // configuration the ceiling is supposed to serve.
  //
  // Note the interaction that made this a real bug rather than a tidy-up:
  // reply and reasoning share one `num_predict` on Ollama, so a thinking model
  // given only the email's budget spends it all working out loud and returns
  // nothing at all. Uncapping both removes the interaction.
  thinkingBudget: 0,
  systemPrompt: '',
  topP: 0.9,
  topK: 40,
  minP: 0,
  repeatPenalty: 1.1,
  repeatLastN: 256,
  presencePenalty: 0,
  frequencyPenalty: 0,
  // The ceiling on the reply itself, separate from the reasoning budget.
  //
  // **0 means no ceiling, and it is the default.** This was 1500, raised from
  // 700 because a "long" draft plus a sign-off ran close to it. Both numbers
  // were the same mistake at different sizes: the prompt is what decides how
  // long an answer should be, and a ceiling on top of it can only ever cut a
  // good answer short. Nothing was gained by guessing where to put it.
  //
  // Uncapped is expressed by NOT SENDING the parameter, not by sending a large
  // number — a big sentinel is still a ceiling, just a less visible one, and
  // it would be wrong on the next model with a different limit. Each adapter
  // omits its own field; the one exception is Anthropic, where `max_tokens` is
  // required by the API and the model's own maximum is sent instead.
  //
  // An operator who wants a hard ceiling can still set one, and it is then
  // honoured exactly as before.
  maxTokens: 0,
  wipeAfterUse: true,
  wipeIdleSeconds: 90,
  embedModel: config.aiEmbedModel,
  embedProvider: 'same',
  embedBaseUrl: '',
  embedApiKey: '',
  embedTlsInsecure: false,
  embedUseTor: false,
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
  // Anthropic does not read `Authorization`. It reads `x-api-key`, and it
  // needs `anthropic-version` on every single request or it refuses the lot —
  // a mandatory version header is unusual enough to be worth naming, because
  // the failure it produces is a 400 on every call that reads like a
  // malformed body rather than a missing header.
  if (cfg.provider === 'anthropic') {
    return {
      'anthropic-version': ANTHROPIC_VERSION,
      ...(cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {}),
    };
  }
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

// The Messages API is versioned by a header rather than by its path. Pinned
// rather than tracking whatever is newest: a version bump is a wire-format
// change and an install should not adopt one the day it ships.
const ANTHROPIC_VERSION = '2023-06-01';

// ---------- The connections ----------
//
// The stored settings stay flat — one JSON row, and an install upgrading must
// not lose its configuration — while everything that opens a socket reads a
// `ModelEndpoint`. So the shape on disk is stable and the shape at the point
// of use is uniform, which is the pair that matters: a caller cannot reach for
// the wrong server's key or the wrong server's proxy, because it never has
// more than one endpoint in its hand.

/** The server that writes. */
export function llmEndpoint(s: AiSettings): ModelEndpoint {
  return {
    id: 'llm',
    label: 'the language model',
    provider: s.provider,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    tlsInsecure: Boolean(s.tlsInsecure),
    useTor: Boolean(s.useTor),
    inheritedFrom: null,
  };
}

/**
 * The server that embeds.
 *
 * `same` returns the language model's connection ENTIRELY — address, key,
 * certificate rule and Tor switch. Inheriting only the address is the bug this
 * whole file was restructured to prevent, so inheritance takes everything or
 * nothing.
 */
export function embedEndpoint(s: AiSettings): ModelEndpoint {
  if (s.embedProvider === 'same') {
    return { ...llmEndpoint(s), id: 'embed', label: 'embeddings', inheritedFrom: 'llm' };
  }
  return {
    id: 'embed',
    label: 'embeddings',
    provider: s.embedProvider,
    baseUrl: normalizeBaseUrl(s.embedBaseUrl),
    apiKey: s.embedApiKey,
    tlsInsecure: Boolean(s.embedTlsInsecure),
    useTor: Boolean(s.embedUseTor),
    inheritedFrom: null,
  };
}

// Models that still accept `temperature`.
//
// The trap the Messages API sets for an adapter written from older
// documentation: `temperature`, `top_p` and `top_k` were REMOVED on the
// current generation, and sending one is not ignored — it is a 400 and the
// whole draft fails. So Tern's tuning panel cannot simply be forwarded.
//
// An allowlist, so a model released after this was written is treated as not
// taking it. That is the safe direction: omitting temperature costs an admin
// some control over how varied the drafts are, while sending it to a model
// that refuses it costs them every draft.
export function anthropicTakesSampling(model: string): boolean {
  return /^claude-(3|opus-4-[0-6]|sonnet-4|haiku-4)/i.test(String(model ?? ''));
}

// Anthropic keeps the system prompt OUT of the message list: a top-level
// `system` string, and the role itself is rejected. Tern builds prompts as
// message lists, so the lifting happens here rather than in prompts.ts.
//
// Several system messages are joined rather than the last one winning — a
// dropped instruction produces a model that mostly behaves, which is much
// harder to spot than one that plainly does not.
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: string }[] } {
  const system: string[] = [];
  const rest: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') { system.push(m.content); continue; }
    rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return { system: system.filter(Boolean).join('\n\n'), messages: rest };
}

// How this install talks to its model server, in the shape util/outbound.ts
// wants: whether to accept an unverifiable certificate, and whether to go
// through Tor. Read from the same settings as the key, so a single place
// decides every part of "how do we reach that box".
//
// It is async and it is one function rather than two because of how the
// alternative failed: `trustOf` was synchronous and returned only the
// certificate half, so adding the proxy would have meant a second call that
// every existing call site had to remember. One of the fifteen had already
// forgotten the first one — `openaiStream` shipped without it, and the symptom
// was a connection test that passed beside a feature that never worked. A
// single call that carries everything cannot be half-applied.
// Why a request failed, said in terms of the thing that actually broke.
//
// With Tor on there are two candidates — the proxy and the model server — and
// they have completely different fixes. `explainTorError` recognises only the
// proxy's own failures and returns null otherwise, so a model server refusing
// a key still gets the far better explanation outbound.ts has for it.
export function reachError(s: { useTor: boolean; baseUrl: string }, e: unknown): string {
  if (s.useTor) { const tor = explainTorError(e); if (tor) return tor; }
  return explainOutboundError(e, s.baseUrl);
}

export function transportFor(s: AiSettings): TlsTrust {
  return endpointTransport(llmEndpoint(s));
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

/**
 * `/api/show` for one model, remembered.
 *
 * Takes an ENDPOINT rather than a bare address, and that is load-bearing
 * rather than tidiness. The version that took only a `baseUrl` read the
 * language model's key, certificate rule and proxy out of the settings to
 * reach whatever address it was handed — so describing a model on the
 * EMBEDDING server would have sent the drafting server's credential to it, and
 * routed it through the drafting server's Tor switch. That is the exact
 * failure `endpoint.ts` was written to make impossible, reintroduced through a
 * back door.
 *
 * The default keeps every existing caller behaving as it did: they pass the
 * language model's own address, and the language model's connection is what
 * they get.
 */
async function describeModel(baseUrl: string, model: string, endpoint?: ModelEndpoint): Promise<{ capabilities: string[]; info: Record<string, unknown> } | null> {
  const key = `${normalizeBaseUrl(baseUrl)}|${model}`;
  const known = described.get(key);
  if (known !== undefined) return known;
  let out: { capabilities: string[]; info: Record<string, unknown> } | null = null;
  try {
    const t = endpoint ?? llmEndpoint(await getAiSettings());
    const res = await outboundFetch(`${normalizeBaseUrl(baseUrl)}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...endpointHeaders(t) }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000) }, endpointTransport(t));
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

// ---------- "As much as it takes", per API ----------
//
// `maxTokens` and `thinkingBudget` of 0 mean no ceiling (see DEFAULTS). The
// three APIs express that differently, and getting it wrong is not a
// no-op on any of them:
//
// * **Ollama** — omit `num_predict`. Handled in predictTokens.
// * **OpenAI-compatible** — omit `max_tokens`. Real OpenAI answers 400 to an
//   unknown parameter but is perfectly happy with a missing optional one, and
//   omitting it means "up to the model's limit", which is exactly the
//   intention.
// * **Anthropic** — `max_tokens` is REQUIRED. There is no omitting it, so
//   uncapped has to be expressed as the model's own maximum.
//
// The Anthropic number is deliberately not a constant. Output ceilings differ
// per model and change with each generation, so a hardcoded 128,000 is a 400
// (`max_tokens: greater than the maximum`) on the first model that does not
// have it — which is a broken adapter, not a degraded one. The Models API
// reports the real figure per model, so it is asked and remembered, exactly as
// `modelContextLimit` does for the context window.

/** Output ceilings, remembered per base URL and model. */
const outputLimits = new Map<string, number>();

// Only used when the Models API cannot be reached or does not report a
// ceiling. Conservative on purpose: every current Anthropic model accepts at
// least this, so a wrong guess costs a shorter answer rather than a 400. The
// live answer is preferred whenever there is one.
const ANTHROPIC_FALLBACK_MAX_OUTPUT = 8192;

/**
 * The model's own output ceiling, from `GET /v1/models/{id}`.
 *
 * `max_tokens` on that response is the output cap and `max_input_tokens` is
 * the context window — two different fields, and reading the wrong one would
 * ask for an output eight times the real ceiling.
 */
export async function anthropicOutputLimit(baseUrl: string, model: string, headers: Record<string, string>, trust: TlsTrust): Promise<number> {
  const key = `${normalizeBaseUrl(baseUrl)}|${model}`;
  const known = outputLimits.get(key);
  if (known !== undefined) return known;
  let limit = ANTHROPIC_FALLBACK_MAX_OUTPUT;
  try {
    // The endpoint's own transport — its proxy rule and certificate trust —
    // exactly as every other call to this server does. A capability lookup is
    // still a call to the model server, and one written without it would
    // succeed by going direct.
    const res = await outboundFetch(`${baseUrl}/v1/models/${encodeURIComponent(model)}`, { headers, signal: AbortSignal.timeout(8000) }, trust);
    if (res.ok) {
      const body = await res.json() as { max_tokens?: unknown };
      if (typeof body.max_tokens === 'number' && body.max_tokens > 0) limit = body.max_tokens;
      else log.debug('the models API did not report an output ceiling; using the fallback', { model });
    }
  } catch (err) {
    // A model list that cannot be fetched is not a reason to fail the
    // generation — it is a reason to be conservative about its length.
    log.debug('could not read the model output ceiling; using the fallback', { model, err: String(err) });
  }
  outputLimits.set(key, limit);
  return limit;
}

export function forgetOutputLimits(): void { outputLimits.clear(); }

/**
 * `max_tokens` for Anthropic, which requires one.
 *
 * `limit` is what the model itself allows. When both ceilings are off, that is
 * the answer; when either is set, the sum is, bounded by what the model takes.
 */
export function anthropicMaxTokens(reply: number, thinking: number, limit: number): number {
  // Same rule as the other two — this bounds the whole response, so an
  // uncapped reply is an uncapped total, which here means the model's own
  // ceiling because the field cannot be left out.
  if (reply <= 0) return limit;
  return Math.min(reply + Math.max(0, thinking), limit);
}

/**
 * `max_tokens` for an OpenAI-compatible endpoint — an object to spread, so
 * that "uncapped" is the absence of the key rather than a value standing in
 * for it.
 */
export function openAiMaxTokens(reply: number, thinking: number): { max_tokens?: number } {
  // As with `num_predict`, this bounds the whole completion, so an uncapped
  // reply is an uncapped total and the key is simply absent.
  if (reply <= 0) return {};
  return { max_tokens: reply + Math.max(0, thinking) };
}

// One model's answers, dropped. Deleting a model and pulling it again gives a
// different build under the same name, so the remembered capabilities have to
// go with it — otherwise a model that has just been replaced is still
// described by whatever the old one could do.
export function forgetModel(baseUrl: string, model: string): void {
  const prefix = `${normalizeBaseUrl(baseUrl)}|`;
  for (const key of described.keys()) {
    if (key === `${prefix}${model}` || key === `${prefix}${model.replace(/:latest$/, '')}` || key === `${prefix}${model}:latest`) described.delete(key);
  }
}

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
export function predictTokens(opts: { numCtx: number; promptChars: number; replyTokens: number; thinkingTokens: number }): { numPredict?: number; clamped: boolean } {
  // Uncapped: send nothing and let the model stop when it is finished. There
  // is no arithmetic to do, because there is no budget to fit — the context
  // window is the only limit, and the server enforces that itself.
  //
  // The condition is the REPLY ceiling alone, not both, and that is a fact
  // about `num_predict` rather than a simplification: it bounds the SUM of
  // reasoning and answer, so there is no way to cap thinking through it while
  // leaving the reply unbounded. An uncapped reply IS an uncapped total. The
  // thinking budget still does its job in the capped case, where it exists to
  // stop reasoning eating the answer's allowance.
  //
  // Writing this as "both must be 0" produced a result that clamped every
  // time: `wanted` became the whole remaining window plus the thinking budget,
  // which by construction never fits, so an uncapped reply logged a warning
  // about not fitting a budget nobody had set.
  if (opts.replyTokens <= 0) return { clamped: false };

  // 3.2 characters per token deliberately over-estimates the prompt on
  // English prose (measured nearer 3.9), which is the safe direction.
  const promptTokens = Math.ceil(opts.promptChars / 3.2);
  const room = opts.numCtx - promptTokens - 128;
  const wanted = opts.replyTokens + Math.max(0, opts.thinkingTokens);
  if (room <= 0) return { numPredict: Math.max(256, opts.replyTokens), clamped: true };
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
    if (s.provider === 'anthropic') {
      // Same reasoning as the OpenAI branch below: a hosted API decides its
      // own concurrency, there is no single loaded model being shared with
      // this install, and the slot gate would only add a queue in front of
      // one that already exists on the other side.
      yield* anthropicStream(s, model, opts);
      return;
    }
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
        // Omitted entirely when uncapped — see predictTokens and DEFAULTS.
        ...(predict.numPredict !== undefined ? { num_predict: predict.numPredict } : {}),
        ...samplingOptions(s, opts.temperature),
        ...(opts.stop?.length ? { stop: opts.stop } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      },
    }),
    signal: opts.signal,
  }, transportFor(s)).catch((e) => { throw new Error(reachError(s, e)); });
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

async function* anthropicStream(s: AiSettings, model: string, opts: ChatOptions): AsyncGenerator<string> {
  const reply = opts.maxTokens ?? s.maxTokens;
  const think = !opts.noThink && s.allowThinking;
  const { system, messages } = toAnthropicMessages(opts.messages);
  const headers = { 'Content-Type': 'application/json', ...(await providerHeaders(s)) };
  // Asked once per model and remembered: this API will not take a missing
  // `max_tokens`, so "no ceiling" has to become the model's real ceiling.
  const outputLimit = await anthropicOutputLimit(s.baseUrl, model, headers, transportFor(s));
  const res = await outboundFetch(`${s.baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      ...(system ? { system } : {}),
      stream: true,
      // Required — there is no "as much as it takes" on this API, so this is
      // the one adapter that cannot express "uncapped" by omission. It sends
      // the model's own maximum instead, which is the nearest true statement.
      //
      // As on the other two providers, reasoning gets its own allowance on top
      // rather than eating the email's — but when either is uncapped there is
      // no sum to compute and the model's ceiling is what applies.
      max_tokens: anthropicMaxTokens(reply, think ? s.thinkingBudget : 0, outputLimit),
      // `budget_tokens` is a 400 on the current models; depth is `adaptive`
      // plus an effort level now. `display: 'summarized'` is what makes the
      // working-out non-empty — without it the composer's thinking panel
      // would stay blank through a two-minute generation, which is the exact
      // failure the setting's own comment above describes.
      ...(think
        ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: s.thinkEffort } }
        // `{ type: 'disabled' }` is itself refused on the models that always
        // think, so there the parameter is omitted. Not a silent failure to
        // honour the setting: with no display asked for, the reasoning comes
        // back empty and the draft arrives as it always did.
        : /^claude-(fable|mythos)/i.test(model) ? {} : { thinking: { type: 'disabled' } }),
      // The tuning that crosses over, and only that. `top_k`, `min_p`,
      // `repeat_penalty`, `presence_penalty`, `frequency_penalty` and `seed`
      // have no equivalent here and an unknown parameter is a 400, so they
      // are dropped rather than guessed at.
      ...(anthropicTakesSampling(model) ? { temperature: opts.temperature ?? s.temperature, top_p: s.topP } : {}),
      ...(opts.stop?.length ? { stop_sequences: opts.stop } : {}),
    }),
    signal: opts.signal,
  }, transportFor(s)).catch((e) => { throw new Error(reachError(s, e)); });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw new Error(`Anthropic refused the request (HTTP ${res.status}). Check the API key in Admin → AI model.`);
    // A 404 here is the base URL, not a missing model: the Messages API has
    // exactly one path, and an unknown model name comes back as a 400 naming
    // it. Saying "pull the model" for this would send an admin to fix the one
    // thing that is fine.
    if (res.status === 404) throw new Error(`No Messages API at ${s.baseUrl}. The base URL is the server's root — https://api.anthropic.com, with no path and no trailing slash.`);
    if (res.status === 429) throw new Error('Anthropic is rate-limiting this key. Try again shortly.');
    throw new Error(`Anthropic returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
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
      // SSE carries `event:` lines and blank separators beside the payloads.
      // The type is in the data line too, so the event line carries nothing
      // the payload does not and is skipped rather than parsed.
      if (!line.startsWith('data:')) continue;
      let j: any;
      try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (j.type === 'error') throw new Error(String(j.error?.message ?? 'the model server reported an error'));
      // The terminator is a typed event rather than a sentinel string.
      if (j.type === 'message_stop') {
        if (!produced) throw new Error(emptyAnswer(model, think ? 1 : 0, reply));
        return;
      }
      if (j.type !== 'content_block_delta') continue;
      // Unlike the other two shapes, the answer and the working-out do not
      // arrive as two fields of one object — one delta comes at a time and
      // says which kind it is. Reading `delta.text` unconditionally would
      // render the model's private deliberation as the draft.
      if (j.delta?.type === 'thinking_delta') { opts.onThinking?.(String(j.delta.thinking ?? '')); continue; }
      if (j.delta?.type === 'text_delta') {
        const piece = String(j.delta.text ?? '');
        if (piece) { produced = true; yield piece; }
      }
    }
  }
  if (!produced) throw new Error(emptyAnswer(model, think ? 1 : 0, reply));
}

async function* openaiStream(s: AiSettings, model: string, opts: ChatOptions): AsyncGenerator<string> {
  const reply = opts.maxTokens ?? s.maxTokens;
  const res = await outboundFetch(`${s.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) },
    body: JSON.stringify({
      model, messages: opts.messages, stream: true,
      temperature: opts.temperature ?? s.temperature,
      // As with Ollama, reasoning is spent out of the same ceiling as the
      // answer, so it gets its own allowance rather than eating the email —
      // and omitted entirely when either is uncapped, which is this API's own
      // way of saying "up to the model's limit". Sending a large number here
      // instead would be a guess that is wrong on every model but one.
      ...(openAiMaxTokens(reply, !opts.noThink && s.allowThinking ? s.thinkingBudget : 0)),
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
    // This argument was missing, and its absence was invisible: the Admin →
    // AI model connection test passes `transportFor` and so succeeded, while
    // every draft on this path went out without the install's TLS decision
    // and failed on a self-signed certificate. A page reporting the provider
    // as reachable beside a feature that never works is a bad pair of
    // symptoms to debug, and both halves now read the same settings.
  }, transportFor(s)).catch((e) => { throw new Error(reachError(s, e)); });
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

/**
 * Whether these texts are the thing being searched FOR or the things being
 * searched THROUGH.
 *
 * Retrieval models embed the two differently, and Tern has always known which
 * it is holding — `indexPass` embeds messages, `semanticSearch` embeds one
 * query — but until there was somewhere to say so, both went out identically.
 * On the models below that is a measurable loss of recall rather than a
 * nicety.
 */
export type EmbedPurpose = 'document' | 'query';

/**
 * The instruction some retrieval models expect in front of a SEARCH.
 *
 * Asymmetric on purpose. These models are trained so that a query carries a
 * task instruction and the documents it is matched against do not; prefixing
 * both would put the same words in every vector in the mailbox and flatten
 * exactly the distinction the prefix exists to sharpen.
 *
 * Qwen3-Embedding takes it in this documented `Instruct:`/`Query:` form.
 * Gemini Embedding 2 needs it for a different reason: unlike gemini-embedding-001
 * it accepts NO task-type parameter at all, and Google's guidance is to put the
 * task in the text instead — so the parameter became a prompt, and this is
 * where it goes.
 *
 * Voyage is deliberately absent: it takes `input_type` as a real request
 * field, which is better than a prefix, so `embed` sends that instead.
 */
const QUERY_INSTRUCTION = 'Given a search over somebody\'s own email, retrieve the messages that answer it.';

export function embeddingText(text: string, model: string, purpose: EmbedPurpose): string {
  if (purpose !== 'query') return text;
  const wantsInstruction = /qwen3[-_]embedding/i.test(model)
    // The 001 generation DOES take a task type, so it must not be given the
    // instruction in words as well.
    || /^(?:models\/)?gemini-embedding-(?!001\b)/i.test(model);
  return wantsInstruction ? `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${text}` : text;
}

/**
 * Google names a model `models/gemini-embedding-2` in its own catalogue and
 * accepts it either way round. Stripping the prefix here means the setting can
 * hold whichever form an admin copied, and the path is built once, correctly.
 */
function geminiModelId(model: string): string {
  return String(model ?? '').replace(/^models\//, '');
}

/**
 * The vectors out of one reply, whichever shape sent it.
 *
 * Ordering is the part worth being careful about. The OpenAI shape is
 * explicitly allowed to answer out of order and carries an `index` to say so —
 * a reader that trusted arrival order would build an index where every
 * message's vector belongs to a different message, which nothing downstream
 * can detect. Ollama and Google both answer strictly in request order and
 * carry no index at all, so there, arrival order IS the answer.
 */
function readVectors(provider: ApiShapeOf<ModelEndpoint>, j: any): number[][] {
  if (provider === 'gemini') {
    return (Array.isArray(j?.embeddings) ? j.embeddings : [])
      .map((e: any) => (Array.isArray(e?.values) ? e.values : []));
  }
  if (provider === 'openai' || provider === 'voyage') {
    return [...(j?.data ?? [])]
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any, i: number) => (d.index === i && Array.isArray(d.embedding) ? d.embedding : []));
  }
  return Array.isArray(j?.embeddings) ? j.embeddings : [];
}

type ApiShapeOf<T> = T extends { provider: infer P } ? P : never;

export async function embed(texts: string[], consent: AiConsent, signal?: AbortSignal, purpose: EmbedPurpose = 'document'): Promise<EmbedResult> {
  await assertCapability(consent.userId, consent.capability);
  const s = await getAiSettings();
  if (!s.enabled) throw new Error('The model is turned off in Admin → AI model');
  // Embeddings have their own connection — address, key, certificate rule and
  // Tor switch — which by default inherits the language model's whole
  // connection rather than merely its URL. Everything below reads `t`, and
  // nothing reads `s.baseUrl` or `s.apiKey`, so an install drafting on
  // Anthropic over Tor and embedding on the Ollama next door does not take a
  // wrong turn here.
  const t = embedEndpoint(s);
  const model = s.embedModel || DEFAULTS.embedModel;
  // Cut to what this particular model can hold rather than to a constant. The
  // constant was 8,000 for everything, which was simultaneously too much for
  // all-minilm's 512-token window — the tail was sent and silently dropped at
  // the far end — and beside the point for a 32k one. `embedInputChars` is the
  // single place that decides, so the indexer and this agree by construction.
  const limit = embedInputChars(model);
  const input = texts.map((x) => String(x ?? '').slice(0, limit)).filter(Boolean);
  if (!input.length) return { vectors: [], model, dims: 0 };
  // Named for the setting that fixes it. An admin who hits this has configured
  // a model server — it just cannot embed, and sending them to the base URL
  // they are about to go and check would waste the trip.
  if (t.provider === 'anthropic') {
    throw new Error('Anthropic has no embeddings endpoint. Point "Where embeddings come from" at an Ollama, OpenAI-compatible, Gemini or Voyage server in Admin → AI model.');
  }
  if (!t.baseUrl) throw new Error(t.inheritedFrom
    ? 'No address is set for the language model, which embeddings are set to share.'
    : notConfigured(t));

  const session = beginSession();
  try {
    // One request per shape. The three OpenAI-descended ones differ by a
    // field; Google's differs by everything — model in the path, a batch of
    // single-part documents rather than a list of strings, and `values` rather
    // than `embedding` on the way back.
    if (t.provider === 'gemini') {
      const path = `models/${geminiModelId(model)}`;
      const res = await outboundFetch(`${t.baseUrl}/${path}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...endpointHeaders(t) },
        // Each entry repeats the model. Google requires it to match the one in
        // the path and refuses the batch otherwise, which reads as a malformed
        // body rather than as the redundancy it is.
        body: JSON.stringify({
          requests: input.map((text) => ({
            model: path,
            content: { parts: [{ text: embeddingText(text, model, purpose) }] },
          })),
        }),
        signal,
      }, endpointTransport(t)).catch((e) => { throw new Error(reachError(t, e)); });
      if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status} for embeddings: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const vectors = readVectors('gemini', await res.json());
      return { vectors, model, dims: vectors[0]?.length ?? 0 };
    }
    if (t.provider === 'openai' || t.provider === 'voyage') {
      const res = await outboundFetch(`${t.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...endpointHeaders(t) },
        body: JSON.stringify({
          model,
          input: input.map((x) => embeddingText(x, model, purpose)),
          // The whole reason Voyage is its own shape. A search and a message
          // are embedded differently by this model, and Tern has always known
          // which it is holding — until now it had nowhere to say so. Leaving
          // it off is Voyage's own default and measurably worse.
          ...(t.provider === 'voyage' ? { input_type: purpose } : {}),
        }),
        signal,
      }, endpointTransport(t)).catch((e) => { throw new Error(reachError(t, e)); });
      if (!res.ok) throw new Error(`Embedding endpoint returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const vectors = readVectors(t.provider, await res.json());
      return { vectors, model, dims: vectors[0]?.length ?? 0 };
    }
    const res = await outboundFetch(`${t.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...endpointHeaders(t) },
      body: JSON.stringify({
        model,
        input: input.map((x) => embeddingText(x, model, purpose)),
        keep_alive: keepAliveValue(s.keepAlive),
        truncate: true,
      }),
      signal,
    }, endpointTransport(t)).catch((e) => { throw new Error(reachError(t, e)); });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 404) throw new Error(`The embedding model "${model}" is not downloaded. Pull it in Admin → AI model.`);
      throw new Error(`Ollama returned HTTP ${res.status} for embeddings: ${body.slice(0, 200)}`);
    }
    const vectors = readVectors('ollama', await res.json());
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
    const res = await outboundFetch(`${s.baseUrl}/api/version`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(6000) }, transportFor(s));
    if (!res.ok) return { ok: false, error: httpHint(res.status, s) };
    const j: any = await res.json();
    return { ok: true, version: j.version };
  } catch (e) {
    // The reason, not `fetch failed`: a self-signed certificate, a closed
    // port and a bad hostname have three different fixes.
    return { ok: false, error: reachError(s, e) };
  }
}

// What a refusal from the other end most likely means. Written for the two
// that a remote model server actually produces: a proxy wanting a token, and
// a base URL with a path or a trailing slash on it.
export function httpHint(status: number, s: { provider: string; baseUrl: string }): string {
  // Named for the header that connection actually sends. Telling somebody with
  // a Gemini key to check their bearer token sends them to look at the one
  // thing that is right.
  const header = s.provider === 'anthropic' ? '`x-api-key`' : s.provider === 'gemini' ? '`x-goog-api-key`' : '`Authorization: Bearer`';
  const api = s.provider === 'anthropic' ? 'Messages API'
    : s.provider === 'gemini' ? 'Gemini API'
      : s.provider === 'ollama' ? 'Ollama API' : 'OpenAI-compatible API';
  if (status === 401 || status === 403) return `HTTP ${status}: that server wants authentication. Put its token in the API key field — it is sent as ${header}.`;
  if (status === 404) return `HTTP 404: nothing is serving the ${api} at ${s.baseUrl}. The base URL is the server's root — no path, no trailing slash.`;
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
  // NOT inspected when Tor is on. This opens its own TLS connection straight
  // to the model host, outside the proxy — so an admin with Tor switched on,
  // merely loading this page, would have announced their address to the exact
  // machine the setting exists to hide it from. A leak from a diagnostic is
  // still a leak, and this one fires without anybody asking for it.
  const cert = s.useTor ? null : await inspectCertificate(s.baseUrl).catch(() => null);

  // Anthropic lists models at the same path as the OpenAI shape and returns
  // the same `{ data: [{ id }] }` envelope, so the two share a branch. What
  // they do not share is the credential header — `providerHeaders` handles
  // that, which is why this reads it rather than building one inline.
  // Everything that is not Ollama answers a catalogue rather than holding
  // files, so "does it work" is the same question as "what does it have".
  // `hostedCatalogue` is the one implementation of that question, shared with
  // `liveModels` — and it takes an endpoint rather than reading the settings,
  // which is what lets this check an address the admin has typed but not yet
  // saved. That property is the entire point of this function: saving first
  // and reading the status line afterwards unloads the model the install was
  // using.
  if (s.provider !== 'ollama') {
    const cat = await hostedCatalogue(llmEndpoint(s));
    const models = cat.models.map((m) => m.name);
    if (!cat.ok) return { ok: false, error: cat.error, models, cert };
    return { ok: true, models, modelInstalled: models.length ? models.includes(s.model) : undefined, cert };
  }

  const health = await ollamaHealth(s);
  if (!health.ok) return { ok: false, error: health.error, cert };
  // Reachable is not the same as usable: the model named in the settings has
  // to be one this server actually has, and on somebody else's Ollama it
  // very often is not.
  try {
    const res = await outboundFetch(`${s.baseUrl}/api/tags`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(8000) }, transportFor(s));
    if (!res.ok) return { ok: true, version: health.version, cert, error: `Reachable, but it would not list its models: ${httpHint(res.status, s)}` };
    const j: any = await res.json();
    const models = (j.models ?? []).map((m: any) => String(m.name ?? '')).filter(Boolean);
    return { ok: true, version: health.version, models, modelInstalled: models.some((n: string) => sameModel(n, s.model)), cert };
  } catch (e) {
    return { ok: true, version: health.version, cert, error: reachError(s, e) };
  }
}

export interface InstalledModel {
  name: string;
  size: number;
  modified: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  /**
   * What the server said this model can do. EMPTY means it did not say, and
   * an unclassified model is offered for every slot rather than for none:
   * hiding a model somebody just pulled, with no way to find out why, is a
   * worse failure than listing one that turns out to be wrong for the job.
   */
  capabilities: string[];
  /** From providers.ts, for the embedders Tern knows. Advisory — see `annotate`. */
  dims?: number;
  contextTokens?: number;
}

export async function listModels(endpoint?: ModelEndpoint): Promise<InstalledModel[]> {
  // The whole connection, resolved once: address, key, certificate rule and
  // proxy together. Everything below reads `target`, so listing the embedding
  // server's models cannot reach for the language model's credential.
  const target = endpoint ?? llmEndpoint(await getAiSettings());
  const s = ollamaProbeFor(target);
  const res = await outboundFetch(`${target.baseUrl}/api/tags`, { headers: endpointHeaders(target), signal: AbortSignal.timeout(8000) }, endpointTransport(target)).catch((e) => { throw new Error(reachError(s, e)); });
  if (!res.ok) throw new Error(httpHint(res.status, s));
  const j: any = await res.json();
  const rows = (j.models ?? []).map((m: any) => ({
    name: m.name,
    size: m.size,
    modified: m.modified_at,
    family: m.details?.family,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    // `capabilities` is what separates a model that writes from one that only
    // embeds. Without it the page offered "Use" on all-minilm, which would
    // have set the drafting model to something that cannot draft.
    //
    // It is read from BOTH places a build might put it, and this was a real
    // bug rather than caution. Ollama's documented `/api/tags` response has no
    // capability field at all — it is `/api/show` that reports one — and some
    // builds put it under `details`. Reading only the top level therefore got
    // an empty list from every Ollama, so every model was "unclassified" and
    // an embedder somebody had pulled appeared in the WRITING table with a Use
    // button: exactly the failure the paragraph above says was fixed.
    capabilities: Array.isArray(m.capabilities) ? m.capabilities
      : Array.isArray(m.details?.capabilities) ? m.details.capabilities
        : [],
  }));

  // Whatever the listing did not say, asked of `/api/show`, which does say.
  //
  // Cheap despite being one request per model: `describeModel` remembers each
  // answer for the life of the process — a model's capabilities do not change
  // while it exists — so this costs a round trip once per model rather than on
  // every poll, and the admin page polls this endpoint every few seconds.
  //
  // A few at a time. Sequentially an admin with thirty models waits thirty
  // round trips; all at once it is thirty sockets at a model server that may
  // be a Raspberry Pi at the end of an SSH tunnel. A model whose `/api/show`
  // fails stays unclassified, and the rest of the list is unaffected.
  const unknown = rows.filter((r: InstalledModel) => !r.capabilities.length);
  const POOL = 5;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < unknown.length; i = next++) {
      const row = unknown[i];
      // The endpoint, not just its address: this may be the embedding server,
      // which has its own key and its own proxy.
      const described = await describeModel(target.baseUrl, row.name, target).catch(() => null);
      if (described?.capabilities.length) row.capabilities = described.capabilities;
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, unknown.length) }, worker));

  return rows;
}

// What Ollama currently holds in memory. `size` is the total the model is
// taking; `sizeVram` is how much of that is on a GPU and is 0 on the
// CPU-only boxes Tern is usually installed on — reporting only the VRAM
// figure there makes a resident 3 GB model look free.
export async function loadedModels(endpoint?: ModelEndpoint): Promise<{ name: string; size: number; sizeVram: number; expiresAt: string }[]> {
  const s = endpoint ?? llmEndpoint(await getAiSettings());
  const res = await outboundFetch(`${s.baseUrl}/api/ps`, { headers: endpointHeaders(s), signal: AbortSignal.timeout(4000) }, endpointTransport(s));
  if (!res.ok) return [];
  const j: any = await res.json();
  return (j.models ?? []).map((m: any) => ({ name: m.name, size: m.size ?? 0, sizeVram: m.size_vram ?? 0, expiresAt: m.expires_at }));
}

// Everything the Models tables are drawn from, asked of the model server
// every time and never cached here.
//
// This is the whole point of the endpoint that calls it: what Ollama holds is
// not Tern's to know. Somebody pulls a model from the perch console on the
// GPU box, or `ollama rm` on the host, and the admin page has to show that
// within seconds rather than after whatever cache happens to expire. A
// failure is reported as a failure, too — an empty table and an unreachable
// server used to look identical, which read as "you have no models" about a
// box with forty gigabytes of them.
export interface LiveModels {
  ok: boolean;
  provider: string;
  baseUrl: string;
  version?: string;
  error?: string;
  models: InstalledModel[];
  loaded: { name: string; size: number; sizeVram: number; expiresAt: string }[];
  at: string;
  /**
   * Whether models can be pulled and deleted here. Only an Ollama holds files
   * on somebody's disk; a hosted API has a catalogue, not an install. The page
   * draws its pull and delete controls from this rather than re-deciding what
   * "the provider is ollama" implies, so a second manageable backend later is
   * one flag rather than a hunt through the UI.
   */
  manageable: boolean;
  /**
   * Whether this list came from the server or from Tern's own table. True
   * everywhere except Voyage, which publishes no catalogue endpoint at all —
   * see `liveModels`. A list presented as live when it is not is how a page
   * confidently shows a model the server has never heard of.
   */
  live: boolean;
}

/**
 * What one hosted API says it has, for any shape that is not Ollama.
 *
 * Takes an ENDPOINT rather than reading the settings, and that is the property
 * that matters: `checkProvider` uses it to test an address an admin has typed
 * and not yet saved, and `liveModels` uses it for the address that is saved.
 * One implementation, so the connection test and the model list cannot
 * disagree about what a provider has — which they did, in an earlier shape
 * where the test read `/v1/models` and the list simply refused.
 */
async function hostedCatalogue(t: ModelEndpoint): Promise<{ ok: boolean; live: boolean; error?: string; models: InstalledModel[] }> {
  // Voyage publishes no catalogue endpoint at all — there is nothing to ask.
  // So this is the one list that is not live, and it says so out loud rather
  // than presenting a table from providers.ts as though it had come from the
  // server. `ok` is still true: the connection is fine and any model ID can be
  // typed in.
  if (t.provider === 'voyage') {
    return {
      ok: true,
      live: false,
      error: 'Voyage publishes no model list, so these are the ones Tern knows about rather than a live answer. Any other Voyage model ID can be typed in.',
      models: embedModelsForShape('voyage').map((m) => ({
        name: m.name, size: 0, modified: '', capabilities: ['embedding'], dims: m.dims, contextTokens: m.contextTokens,
      })),
    };
  }

  // Google's catalogue is its own, and unlike the OpenAI shape it really does
  // say what each model can do: `supportedGenerationMethods` is what separates
  // an embedder from a chat model.
  if (t.provider === 'gemini') {
    try {
      const res = await outboundFetch(`${t.baseUrl}/models?pageSize=200`, {
        headers: endpointHeaders(t), signal: AbortSignal.timeout(8000),
      }, endpointTransport(t));
      if (!res.ok) return { ok: false, live: true, error: httpHint(res.status, t), models: [] };
      const j: any = await res.json();
      const models = (j?.models ?? [])
        .filter((m: any) => m?.name)
        .map((m: any) => {
          const methods: string[] = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
          return annotate({
            name: geminiModelId(String(m.name)),
            size: 0,
            modified: '',
            family: 'gemini',
            // Only embedding is claimed even for a model that also generates:
            // this connection is wired for batchEmbedContents and nothing
            // else, so a Gemini chat model listed here would be a choice that
            // cannot be used. Drafting on Gemini goes through the
            // OpenAI-compatible preset instead.
            capabilities: methods.some((x) => /embed/i.test(x)) ? ['embedding'] : [],
          });
        })
        .sort((a: InstalledModel, b: InstalledModel) => a.name.localeCompare(b.name));
      return { ok: true, live: true, models };
    } catch (e) {
      return { ok: false, live: true, error: reachError(t, e), models: [] };
    }
  }

  // Anthropic lists models at the same path as the OpenAI shape and returns
  // the same `{data:[{id}]}` envelope, so the two share a branch. What they do
  // not share is the credential header — `endpointHeaders` handles that.
  try {
    const res = await outboundFetch(`${t.baseUrl}/v1/models`, {
      headers: endpointHeaders(t), signal: AbortSignal.timeout(8000),
    }, endpointTransport(t));
    if (!res.ok) return { ok: false, live: true, error: httpHint(res.status, t), models: [] };
    const j: any = await res.json().catch(() => null);
    const models = (j?.data ?? [])
      .map((m: any) => String(m?.id ?? ''))
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b))
      .map((id: string) => annotate({
        name: id,
        size: 0,
        modified: '',
        // A hosted catalogue says nothing about what a model can do, so
        // nothing is claimed — and an empty list means "offered for every
        // slot", not "for none". Anthropic's real limitation is encoded
        // elsewhere and more strongly: `EmbedProvider` has no `anthropic`, so
        // its models can never reach the embedding picker at all.
        capabilities: [],
      }));
    return { ok: true, live: true, models };
  } catch (e) {
    return { ok: false, live: true, error: reachError(t, e), models: [] };
  }
}

export async function liveModels(which: 'llm' | 'embed' = 'llm'): Promise<LiveModels> {
  const s = await getAiSettings();
  const t = which === 'embed' ? embedEndpoint(s) : llmEndpoint(s);
  const at = new Date().toISOString();
  const base: Omit<LiveModels, 'ok'> = {
    provider: t.provider, baseUrl: t.baseUrl, models: [], loaded: [], at, manageable: false, live: true,
  };
  if (!t.baseUrl) {
    return {
      ...base,
      ok: false,
      error: t.inheritedFrom
        ? 'No address is set for the language model, which embeddings are set to share.'
        : notConfigured(t),
    };
  }

  if (t.provider !== 'ollama') {
    const cat = await hostedCatalogue(t);
    return { ...base, ok: cat.ok, live: cat.live, error: cat.error, models: cat.models };
  }

  const health = await ollamaHealth({ ...s, ...ollamaProbeFor(t) });
  if (!health.ok) return { ...base, ok: false, error: health.error };
  try {
    // Pulling and deleting only make sense for a server holding files on
    // somebody's disk, so it is Ollama alone that reports itself manageable —
    // and the page draws its pull and delete controls from that flag rather
    // than from re-deciding what "ollama" implies.
    const [models, loaded] = await Promise.all([
      listModels(t).then((ms) => ms.map(annotate)),
      loadedModels(t).catch(() => []),
    ]);
    return { ...base, ok: true, manageable: true, version: health.version, models, loaded };
  } catch (e) {
    return { ...base, ok: false, version: health.version, error: (e as Error).message };
  }
}

/**
 * What Tern knows about an embedder on top of what the server said.
 *
 * Only the vector width, and only for the models in `providers.ts` — but it is
 * the number an admin is actually choosing by. Meaning search stores one row
 * per message at the model's width, so a 4096-wide model is five times a
 * 768-wide one over the same mailbox, and no model server reports that in a
 * listing.
 *
 * Advisory, and never indexed by: `embed` reads the real width off the vectors
 * that came back, because several of these will answer narrower than their
 * default if asked.
 */
function annotate(m: InstalledModel): InstalledModel {
  const known = embedModelInfo(m.name);
  return known ? { ...m, dims: known.dims, contextTokens: known.contextTokens } : m;
}

/**
 * An endpoint's connection in the shape `ollamaHealth` and the outbound
 * helpers read.
 *
 * They take `AiSettings` because they were written when there was one
 * connection; this is the adapter rather than a second copy of them, so the
 * embedding endpoint's own address, key, certificate rule and proxy are what
 * get used and not the language model's.
 */
function ollamaProbeFor(t: ModelEndpoint): Pick<AiSettings, 'provider' | 'baseUrl' | 'apiKey' | 'tlsInsecure' | 'useTor'> {
  // The shapes that never appear on a drafting or embedding connection are
  // folded onto `ollama`, which is only ever used here to pick which health
  // path to try. `openai-chat` joins them: it exists solely for hosts that
  // draw pictures through chat completions, and nothing in this file can be
  // pointed at one — but the enum it comes from is shared, so the compiler is
  // right to ask, and answering with a guess rather than a case would be how
  // an image host's probe quietly became a drafting probe later.
  return {
    provider: t.provider === 'gemini' || t.provider === 'voyage' || t.provider === 'openai-chat' ? 'ollama' : t.provider,
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    tlsInsecure: t.tlsInsecure,
    useTor: t.useTor,
  };
}

export async function* pullModel(name: string, signal?: AbortSignal): AsyncGenerator<{ status: string; completed?: number; total?: number; error?: string }> {
  const s = await getAiSettings();
  const res = await outboundFetch(`${s.baseUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) }, body: JSON.stringify({ model: name, stream: true }), signal }, transportFor(s)).catch((e) => { throw new Error(reachError(s, e)); });
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

// A deletion is only done when the model server agrees it is done.
//
// A 200 from /api/delete was previously the whole story, and it is not: a
// remote Ollama behind a proxy can answer 200 to a request it never applied,
// perch refuses management with a 403 that used to arrive as an unexplained
// failure, and a name that differs only by `:latest` deletes nothing while
// reporting success. The page then showed a model that was still on disk as
// gone until the next reload put it back. So the list is read again
// afterwards and the answer is what that list says, not what the status code
// claimed.
export async function deleteModel(name: string): Promise<InstalledModel[]> {
  const s = await getAiSettings();
  if (s.provider !== 'ollama') throw new Error('Only an Ollama model can be deleted from here');
  // Dropped from memory first. Ollama removes the files either way, but a
  // copy that is already resident stays in RAM holding exactly the memory
  // the deletion was meant to give back.
  await unloadModel(s.baseUrl, name).catch(() => {});
  const res = await outboundFetch(`${s.baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(await providerHeaders(s)) },
    // `model` is what current Ollama reads; `name` is what it read before
    // 0.4 and what some compatible servers still expect. Sending both costs
    // nothing and covers a delete that silently matched nothing.
    body: JSON.stringify({ model: name, name }),
    signal: AbortSignal.timeout(60_000),
  }, transportFor(s)).catch((e) => { throw new Error(reachError(s, e)); });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 404) throw new Error(`That server has no model called "${name}"`);
    if (res.status === 403) throw new Error(`That server refused to delete "${name}": ${body || 'model management is switched off on it'}`);
    throw new Error(`That server refused to delete "${name}": ${httpHint(res.status, s)}${body ? ` ${body}` : ''}`);
  }
  forgetModel(s.baseUrl, name);
  // The real state. If listing fails the deletion is still reported as done —
  // the server accepted it — but nothing is invented about what remains.
  const after = await listModels().catch(() => null);
  if (after && after.some((m) => sameModel(m.name, name))) {
    throw new Error(`"${name}" is still on that server after the delete was accepted. It may be a model the server will not remove, or a proxy answered for it.`);
  }
  log.info('model deleted', { name });
  return after ?? [];
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
    }, transportFor(s));
    if (!res.ok) return false;
    await res.text().catch(() => '');
    return true;
  } catch { return false; }
}

// Which of the models Ollama is holding right now matches `model`.
async function residentAt(baseUrl: string, model: string): Promise<boolean> {
  try {
    const s = await getAiSettings();
    const res = await outboundFetch(`${normalizeBaseUrl(baseUrl)}/api/ps`, { headers: await providerHeaders(s), signal: AbortSignal.timeout(4000) }, transportFor(s));
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
