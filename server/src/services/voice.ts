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
import { logger } from '../log.js';
import { assertCapability } from './capabilities.js';
import { badRequest } from '../errors.js';

const log = logger('voice');

// A minute of speech is a long sentence; anything beyond it is a recording
// somebody meant to stop. Sixteen-bit mono at 16 kHz is about 2 MB a minute,
// and compressed formats are far smaller, so this is generous.
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const MAX_SECONDS = 120;

export const AUDIO_TYPES = [
  'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/flac', 'audio/m4a',
] as const;

export interface Transcription { text: string; ms: number; model: string | null }

export function voiceConfigured(): boolean {
  return Boolean(config.whisperUrl);
}

export function acceptableType(contentType: string): boolean {
  const t = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  return (AUDIO_TYPES as readonly string[]).includes(t);
}

// The transcript, and nothing else. `audio` is zeroed before this returns
// whatever happens, including on the way out of a throw.
export async function transcribe(userId: number, audio: Buffer, contentType: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Transcription> {
  await assertCapability(userId, 'voice');
  if (!voiceConfigured()) throw badRequest('Dictation is not set up on this server. An administrator needs to add the transcription container.');
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
    if (opts.language) form.append('language', opts.language.slice(0, 8));

    const res = await fetch(`${config.whisperUrl}/v1/audio/transcriptions`, {
      method: 'POST',
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
