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
  /** Origin of something speaking OpenAI's /v1/audio/transcriptions shape. */
  baseUrl: string;
  /** Bearer token, for a remote transcriber behind a proxy that wants one. */
  apiKey: string;
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
  baseUrl: config.whisperUrl,
  apiKey: '',
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
  return next;
}

export function voiceDefaults(): VoiceSettings { return { ...VOICE_DEFAULTS }; }

// For tests, and for the settings route after it writes.
export function forgetVoiceSettings(): void { cache = null; }

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
    const res = await fetch(`${cfg.baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const j: any = await res.json().catch(() => null);
      const models = Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : undefined;
      return { ok: true, models };
    }
    // 401/403 is a live server refusing the key, which is a different fault
    // from an address that goes nowhere, and worth saying so.
    if (res.status === 401 || res.status === 403) return { ok: false, error: `The transcriber refused the API key (HTTP ${res.status})` };
    const root = await fetch(`${cfg.baseUrl}/`, { headers, signal: AbortSignal.timeout(6000) });
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

    const res = await fetch(`${cfg.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: voiceAuthHeaders(cfg),
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    });
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
