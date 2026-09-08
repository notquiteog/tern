// F9: dictation, on this box.
//
// The point of this feature is entirely the location. Dictating a reply is
// ordinary; dictating it without the recording leaving the building is not,
// and it is the one place where the privacy argument stops being abstract —
// the alternative is streaming your voice to a company that keeps it.
//
// So the rules here are stricter than anywhere else in the app:
//   - The audio is never written to disk. It arrives in memory, goes to the
//     transcriber, and the buffer is zeroed in a `finally`.
//   - The transcript is never stored. It is returned to the browser that
//     sent the clip and forgotten; if the person does not paste it into
//     something, it is gone.
//   - Nothing is logged but a duration and a byte count.
//
// The transcriber is a separate container (whisper.cpp behind its small HTTP
// server, or anything speaking the same shape), off unless an admin installs
// it. It is optional because it is the one item on this list that costs the
// base install real memory.
import { config } from './../config.js';
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { assertCapability } from './capabilities.js';
import { badRequest } from '../errors.js';
import { outboundFetch } from '../util/outbound.js';
import { endpointHeaders, transportFor, type ModelEndpoint } from '../ai/endpoint.js';

const log = logger('voice');

// Where the transcriber lives, and how to speak to it.
//
// This is a setting rather than only an environment variable because the box
// that runs Tern is often not the box with the spare cores: a 4.5 GB VPS
// cannot hold a chat model and a whisper model at once, and the answer is
// usually a machine on the LAN, or one behind a reverse proxy on the far
// side of a WireGuard link. WHISPER_URL is still read — it is what
// compose.voice.yml sets, and it stays the default — but an admin can point
// this somewhere else without editing a file and restarting the container.
export interface VoiceSettings {
  /** Off means the microphone buttons do not appear at all. */
  enabled: boolean;
  /**
   * The wire shape this transcriber speaks.
   *
   * One value today, and not a placeholder for a choice that is coming:
   * whisper.cpp, speaches, faster-whisper and every hosted transcriber worth
   * pointing at all serve OpenAI's `/v1/audio/transcriptions`. It is stored
   * because a connection here is configured exactly like the language model's
   * and the embedder's, and because a second shape should be a one-line change
   * rather than a new settings layout.
   */
  provider: 'openai';
  /** Origin of something speaking OpenAI's /v1/audio/transcriptions shape. */
  baseUrl: string;
  /** Bearer token, for a remote transcriber behind a proxy that wants one. */
  apiKey: string;
  /**
   * Accept a certificate this machine cannot verify, for the transcriber only.
   *
   * It did not have one, and the gap was invisible: every call in this file
   * used plain `fetch`, so an admin who ticked "trust this certificate" on the
   * AI page found drafting worked and dictation did not — the setting was on
   * the wrong connection, and there was no right one to put it on.
   */
  tlsInsecure: boolean;
  /**
   * Reach the transcriber through the local Tor proxy.
   *
   * Its own switch, separate from the language model's. Speech is the most
   * identifying thing an install sends anywhere, and which wire carries it is
   * not a decision to inherit from whatever the drafting model happened to
   * need. Off by default, and pointless for the bundled container.
   */
  useTor: boolean;
  /** Empty means whatever the server was started with, which is the bundled case. */
  model: string;
  /** ISO code, or empty to let the model detect the language. */
  language: string;
}

const VOICE_DEFAULTS: VoiceSettings = {
  // The bundled overlay sets WHISPER_URL, so an install that added the
  // container has dictation on without an admin having to find this page,
  // and an install that did not has it off and says so.
  enabled: Boolean(config.whisperUrl),
  provider: 'openai',
  baseUrl: config.whisperUrl,
  apiKey: '',
  tlsInsecure: false,
  useTor: false,
  model: '',
  language: '',
};

let cache: { at: number; value: VoiceSettings } | null = null;

export async function getVoiceSettings(): Promise<VoiceSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await one<{ value: Partial<VoiceSettings> }>(`SELECT value FROM settings WHERE key='voice'`);
  const value = { ...VOICE_DEFAULTS, ...(row?.value ?? {}) };
  // A row that was saved with a base URL and then had it cleared is off,
  // whatever the flag says: a switch that is on with nowhere to send audio
  // is a microphone button that fails when it is pressed.
  if (!value.baseUrl) value.enabled = false;
  cache = { at: Date.now(), value };
  return value;
}

export async function saveVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const current = await getVoiceSettings();
  const next: VoiceSettings = { ...current, ...patch };
  next.baseUrl = String(next.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!next.baseUrl) next.enabled = false;
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('voice', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(next)],
  );
  cache = null;
  // A new address is a different server with different abilities, so what the
  // old one could do is forgotten with it.
  capCache = null;
  return next;
}

export function voiceDefaults(): VoiceSettings { return { ...VOICE_DEFAULTS }; }

/**
 * The transcriber as a connection, in the shape the shared transport wants.
 *
 * Every request in this file goes through it. Before it existed each call used
 * plain `fetch`, which meant nine places that each independently did not honour
 * the certificate rule and could not use a proxy — not a decision, just what
 * nine separately written call sites converge on.
 */
export function sttEndpoint(v: VoiceSettings): ModelEndpoint {
  return {
    id: 'stt',
    label: 'the transcriber',
    provider: v.provider ?? 'openai',
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    tlsInsecure: Boolean(v.tlsInsecure),
    useTor: Boolean(v.useTor),
    inheritedFrom: null,
  };
}

// ---------- What this particular transcriber can do ----------
//
// "A server speaking OpenAI's transcription shape" covers two very different
// things, and the Dictation card was written as though it covered one.
//
// The bundled whisper.cpp is started with a single model file and has no
// model API at all: /v1/models is a 404 there, and there is nothing to list,
// download or delete. speaches (and faster-whisper-server before it) hosts
// many, lists them at /v1/models, publishes a registry of everything it could
// fetch at /v1/registry, and downloads and deletes through POST and DELETE on
// /v1/models/{id}. A hosted API lists models and lets you manage none of them.
//
// So the card asks rather than assumes. What it can do is probed once and
// remembered for a minute, and the page shows the controls the answer
// justifies — which is why the model name is a free-text box against
// whisper.cpp and a live table against speaches, instead of a free-text box
// that quietly does not match anything against either.
export interface VoiceCapabilities {
  /** Reachable at all. */
  ok: boolean;
  error?: string;
  /** Answers GET /v1/models with a list. */
  lists: boolean;
  /** Publishes GET /v1/registry, which is what makes downloading possible. */
  registry: boolean;
  /** POST and DELETE on /v1/models/{id} are worth offering. */
  manages: boolean;
  /** Told apart for the page's wording, not for behaviour. */
  kind: 'speaches' | 'openai-shaped' | 'whisper.cpp' | 'unknown';
}

let capCache: { at: number; key: string; value: VoiceCapabilities } | null = null;

export function forgetVoiceCapabilities(): void { capCache = null; }

export async function voiceCapabilities(s?: VoiceSettings): Promise<VoiceCapabilities> {
  const cfg = s ?? (await getVoiceSettings());
  const key = `${cfg.baseUrl}|${cfg.apiKey ? 'k' : ''}`;
  if (capCache && capCache.key === key && Date.now() - capCache.at < 60_000) return capCache.value;
  const value = await probeVoice(cfg);
  capCache = { at: Date.now(), key, value };
  return value;
}

async function probeVoice(cfg: VoiceSettings): Promise<VoiceCapabilities> {
  const none: VoiceCapabilities = { ok: false, lists: false, registry: false, manages: false, kind: 'unknown' };
  if (!cfg.baseUrl) return { ...none, error: 'No transcriber address is set' };
  const headers = voiceAuthHeaders(cfg);
  let lists = false;
  try {
    const res = await outboundFetch(`${cfg.baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(6000) }, transportFor(sttEndpoint(cfg)));
    if (res.status === 401 || res.status === 403) return { ...none, error: `The transcriber refused the API key (HTTP ${res.status})` };
    lists = res.ok;
  } catch (e) {
    return { ...none, error: (e as Error).message };
  }
  if (!lists) {
    // No model list. whisper.cpp serves / and the inference path and nothing
    // else, so a live root here is a working transcriber with exactly one
    // model — which the card then says, rather than showing an empty table.
    try {
      const root = await outboundFetch(`${cfg.baseUrl}/`, { headers, signal: AbortSignal.timeout(6000) }, transportFor(sttEndpoint(cfg)));
      if (root.status < 500) return { ...none, ok: true, kind: 'whisper.cpp' };
      return { ...none, error: `HTTP ${root.status}` };
    } catch (e) {
      return { ...none, error: (e as Error).message };
    }
  }
  // A registry is the thing that separates a transcriber that can fetch a
  // model from one that only reports the models it was given.
  let registry = false;
  try {
    const res = await outboundFetch(`${cfg.baseUrl}/v1/registry?task=automatic-speech-recognition`, { headers, signal: AbortSignal.timeout(8000) }, transportFor(sttEndpoint(cfg)));
    registry = res.ok;
  } catch { /* no registry: listed but not managed */ }
  return { ok: true, lists: true, registry, manages: registry, kind: registry ? 'speaches' : 'openai-shaped' };
}

// ---------- The models, live ----------

export interface VoiceModel {
  id: string;
  task?: string;
  language?: string[] | string;
  ownedBy?: string;
  created?: number;
  installed: boolean;
}

function readModelList(j: any, installed: boolean): VoiceModel[] {
  const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return rows
    .map((m: any) => ({
      id: String(m?.id ?? m?.model ?? ''),
      task: typeof m?.task === 'string' ? m.task : undefined,
      language: m?.language,
      ownedBy: typeof m?.owned_by === 'string' ? m.owned_by : undefined,
      created: typeof m?.created === 'number' ? m.created : undefined,
      installed,
    }))
    .filter((m: VoiceModel) => Boolean(m.id));
}

async function voiceJson(cfg: VoiceSettings, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
  const res = await outboundFetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { ...voiceAuthHeaders(cfg), ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  }, transportFor(sttEndpoint(cfg)));
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw badRequest(`The transcriber answered HTTP ${res.status}${body ? `: ${body}` : ''}`);
  }
  return res.json().catch(() => null);
}

/** What the transcriber has now. Asked every time; nothing about it is cached. */
export async function listVoiceModels(s?: VoiceSettings): Promise<VoiceModel[]> {
  const cfg = s ?? (await getVoiceSettings());
  const j = await voiceJson(cfg, '/v1/models');
  // A server that hosts several tasks lists them all; only the ones that turn
  // speech into text belong on a dictation page.
  return readModelList(j, true).filter((m) => !m.task || m.task === 'automatic-speech-recognition');
}

/** What it could fetch but has not. Empty for a transcriber with no registry. */
export async function voiceRegistry(s?: VoiceSettings): Promise<VoiceModel[]> {
  const cfg = s ?? (await getVoiceSettings());
  const caps = await voiceCapabilities(cfg);
  if (!caps.registry) return [];
  const j = await voiceJson(cfg, '/v1/registry?task=automatic-speech-recognition', {}, 20_000).catch(() => null);
  return readModelList(j, false);
}

/** Both lists in one call, plus what the page is allowed to offer for them. */
export async function voiceModelView(s?: VoiceSettings): Promise<{
  capabilities: VoiceCapabilities; installed: VoiceModel[]; available: VoiceModel[]; error?: string; at: string;
}> {
  const cfg = s ?? (await getVoiceSettings());
  const capabilities = await voiceCapabilities(cfg);
  const at = new Date().toISOString();
  if (!capabilities.lists) return { capabilities, installed: [], available: [], error: capabilities.error, at };
  try {
    const installed = await listVoiceModels(cfg);
    const have = new Set(installed.map((m) => m.id));
    const available = (await voiceRegistry(cfg).catch(() => [])).filter((m) => !have.has(m.id));
    return { capabilities, installed, available, at };
  } catch (e) {
    return { capabilities, installed: [], available: [], error: (e as Error).message, at };
  }
}

// A model id is a Hugging Face repository path — `Systran/faster-whisper-small`
// — or one of the server's own aliases. It goes into a URL path, so it is
// checked before it gets there rather than trusted because an admin typed it.
export function validVoiceModelId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}){0,2}$/.test(String(id ?? ''));
}

const encodeModelId = (id: string) => id.split('/').map(encodeURIComponent).join('/');

/**
 * Fetch a model onto the transcriber.
 *
 * speaches downloads in one blocking call and reports nothing while it works,
 * so there is no byte count to show — the job that wraps this says
 * "downloading" and how long it has been doing it, and the page says plainly
 * that this server does not report progress. What it does not do is guess a
 * percentage, and what it does do is confirm the result against the model
 * list rather than against the status code.
 */
export async function pullVoiceModel(id: string, signal?: AbortSignal): Promise<void> {
  const cfg = await getVoiceSettings();
  const caps = await voiceCapabilities(cfg);
  if (!caps.manages) throw badRequest('That transcriber does not download models: it serves the ones it was started with');
  const res = await outboundFetch(`${cfg.baseUrl}/v1/models/${encodeModelId(id)}`, {
    method: 'POST',
    headers: voiceAuthHeaders(cfg),
    signal: signal ?? AbortSignal.timeout(60 * 60 * 1000),
  }, transportFor(sttEndpoint(cfg)));
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 404) throw badRequest(`The transcriber does not know a model called "${id}"`);
    if (res.status === 401) throw badRequest(`"${id}" is a gated repository: the transcriber needs its own Hugging Face token to fetch it`);
    throw badRequest(`The transcriber refused to download "${id}": HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }
  await res.text().catch(() => '');
  const after = await listVoiceModels(cfg).catch(() => null);
  if (after && !after.some((m) => m.id === id)) {
    throw new Error(`"${id}" was accepted but is still not in the transcriber's model list`);
  }
}

/** Remove one, and believe the list rather than the status code. */
export async function deleteVoiceModel(id: string): Promise<VoiceModel[]> {
  const cfg = await getVoiceSettings();
  const caps = await voiceCapabilities(cfg);
  if (!caps.manages) throw badRequest('That transcriber does not manage models from here');
  const res = await outboundFetch(`${cfg.baseUrl}/v1/models/${encodeModelId(id)}`, {
    method: 'DELETE',
    headers: voiceAuthHeaders(cfg),
    signal: AbortSignal.timeout(60_000),
  }, transportFor(sttEndpoint(cfg)));
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 404) throw badRequest(`The transcriber has no model called "${id}"`);
    throw badRequest(`The transcriber refused to delete "${id}": HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }
  await res.text().catch(() => '');
  const after = await listVoiceModels(cfg).catch(() => null);
  if (after && after.some((m) => m.id === id)) {
    throw new Error(`"${id}" is still on the transcriber after the delete was accepted`);
  }
  return after ?? [];
}

// For tests, and for the settings route after it writes.
export function forgetVoiceSettings(): void { cache = null; capCache = null; }

// A minute of speech is a long sentence; anything beyond it is a recording
// somebody meant to stop. Sixteen-bit mono at 16 kHz is about 2 MB a minute,
// and compressed formats are far smaller, so this is generous.
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const MAX_SECONDS = 120;

export const AUDIO_TYPES = [
  'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/flac', 'audio/m4a',
] as const;

export interface Transcription { text: string; ms: number; model: string | null }

export async function voiceConfigured(): Promise<boolean> {
  const s = await getVoiceSettings();
  return s.enabled && Boolean(s.baseUrl);
}

// Whether the transcriber answers, asked before somebody records a minute of
// speech and finds out that it does not. There is no health path every
// implementation agrees on: the OpenAI-shaped servers serve /v1/models, and
// whisper.cpp's own server serves only / and /inference. Either answering at
// all is the signal — a 404 from a live server still means the address is
// right and something is listening.
export async function voiceHealth(s?: VoiceSettings): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const cfg = s ?? (await getVoiceSettings());
  if (!cfg.baseUrl) return { ok: false, error: 'No transcriber address is set' };
  const headers = voiceAuthHeaders(cfg);
  try {
    const res = await outboundFetch(`${cfg.baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(6000) }, transportFor(sttEndpoint(cfg)));
    if (res.ok) {
      const j: any = await res.json().catch(() => null);
      const models = Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : undefined;
      return { ok: true, models };
    }
    // 401/403 is a live server refusing the key, which is a different fault
    // from an address that goes nowhere, and worth saying so.
    if (res.status === 401 || res.status === 403) return { ok: false, error: `The transcriber refused the API key (HTTP ${res.status})` };
    const root = await outboundFetch(`${cfg.baseUrl}/`, { headers, signal: AbortSignal.timeout(6000) }, transportFor(sttEndpoint(cfg)));
    if (root.status < 500) return { ok: true };
    return { ok: false, error: `HTTP ${root.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function voiceAuthHeaders(s: VoiceSettings): Record<string, string> {
  return s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {};
}

export function acceptableType(contentType: string): boolean {
  const t = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  return (AUDIO_TYPES as readonly string[]).includes(t);
}

// The transcript, and nothing else. `audio` is zeroed before this returns
// whatever happens, including on the way out of a throw.
export async function transcribe(userId: number, audio: Buffer, contentType: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Transcription> {
  await assertCapability(userId, 'voice');
  const cfg = await getVoiceSettings();
  if (!cfg.enabled || !cfg.baseUrl) throw badRequest('Dictation is not set up on this server. An administrator needs to add a transcriber under Admin \u2192 AI model.');
  if (!audio?.length) throw badRequest('That recording was empty');
  if (audio.length > MAX_AUDIO_BYTES) throw badRequest('That recording is too long; keep it under two minutes');
  if (!acceptableType(contentType)) throw badRequest('That is not an audio format this server reads');

  const started = Date.now();
  try {
    const form = new FormData();
    // A name is required by the multipart encoding and is not a real file:
    // nothing is written anywhere, on this side or the other.
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), 'clip');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    // The browser's guess wins over the install's default, because the
    // person dictating knows which language they are speaking.
    const language = opts.language || cfg.language;
    if (language) form.append('language', language.slice(0, 8));
    // Bundled whisper.cpp was started with one model and ignores this; a
    // remote server that hosts several needs to be told which.
    if (cfg.model) form.append('model', cfg.model);

    const res = await outboundFetch(`${cfg.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: voiceAuthHeaders(cfg),
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    }, transportFor(sttEndpoint(cfg)));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw badRequest(`The transcriber answered HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const j: any = await res.json();
    const text = cleanTranscript(String(j.text ?? ''));
    const ms = Date.now() - started;
    // Length, not content. This line is the only trace a dictation leaves.
    log.info('transcribed a clip', { user: userId, bytes: audio.length, chars: text.length, ms });
    return { text, ms, model: typeof j.model === 'string' ? j.model : null };
  } finally {
    audio.fill(0);
  }
}

// Whisper models emit bracketed non-speech markers, and on silence they
// hallucinate whichever caption line was most common in their training data.
// A person who says nothing should get nothing, not a sentence about
// subtitles.
const HALLUCINATIONS = [
  /^\s*thanks? for watching[.!]?\s*$/i,
  /^\s*subtitles? by .*$/i,
  /^\s*subs? by .*$/i,
  /^\s*please subscribe[.!]?\s*$/i,
  /^\s*thank you[.!]?\s*$/i,
  /^\s*you\s*$/i,
  /^\s*bye[.!]?\s*$/i,
  /^\s*\.\s*$/,
];

export function cleanTranscript(raw: string): string {
  let t = String(raw ?? '')
    // [BLANK_AUDIO], (music), ♪ … ♪
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .replace(/\((?:music|silence|inaudible|laughter|applause)[^)]{0,30}\)/gi, ' ')
    .replace(/♪/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (HALLUCINATIONS.some((re) => re.test(t))) return '';
  return t;
}
