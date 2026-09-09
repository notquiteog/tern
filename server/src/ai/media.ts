// Pictures and video, made by a model that is somewhere else.
//
// ── Why this is not part of llm.ts ──────────────────────────────────────────
//
// Because it is a different machine, and almost always a different company.
// The box that drafts an email is a 4 GB language model; the box that draws a
// picture is a diffusion model that wants a graphics card to itself, and the
// box that makes eight seconds of video is renting time on a cluster. An
// install that runs its own Ollama for drafting and buys pictures by the
// request is the ordinary case, not the exotic one, so images and video get
// their own connections — with their own key, their own certificate rule and
// their own Tor switch — exactly as embeddings and the transcriber do.
//
// Video gets a connection separate from images again, defaulting to sharing
// the image one. Same reason the embedder can be split off the writer: the
// two are frequently not the same host, and inheriting an address without
// inheriting the proxy is the specific bug `ai/endpoint.ts` was written to
// stop happening a fourth time.
//
// ── What is deliberately absent ─────────────────────────────────────────────
//
// Ollama. It has no image-generation endpoint at all — it runs vision models
// that READ a picture, which is the opposite direction — so offering it here
// would be a setting that cannot work, the same judgement `EmbedProvider`
// makes about Anthropic. Anything that does serve pictures over an
// OpenAI-shaped `/v1/images/generations` is configured here by address,
// including a local ComfyUI or SwarmUI behind their OpenAI shims, and a perch
// or vLLM host that has one loaded.
//
// ── What this file will not do ──────────────────────────────────────────────
//
// Generate into an automated send. Everything here is reached from a composer
// with a person in front of it. The hard filter in `ai/sendGuard.ts` reads
// text and can say whether a draft still contains a merge field; nothing
// reads a picture and says whether it is fit to put in front of a stranger,
// so a sequence step does not get to make one.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { assertCapability, type Capability } from '../services/capabilities.js';
import { explainOutboundError, normalizeBaseUrl, outboundFetch, type OutboundResponse } from '../util/outbound.js';
import { explainTorError } from '../util/tor.js';
import { assertPublicUrl } from '../util/netguard.js';
import { endpointHeaders, notConfigured, transportFor, type ModelEndpoint } from './endpoint.js';

const log = logger('media');

/**
 * The two wire shapes that draw a picture. See `ApiShape` for why there are
 * two of them rather than one.
 */
export type MediaShape = 'openai' | 'openai-chat';

/** Video is only ever asked for over the path shape; see `startVideo`. */
export type VideoShape = 'openai';

export interface MediaSettings {
  /** Whether the composer offers to draw at all. */
  images: boolean;
  /** Whether it offers to film. Separate, because most hosts serve one and not the other. */
  videos: boolean;

  // ---- The connection that draws ----
  provider: MediaShape;
  baseUrl: string;
  apiKey: string;
  tlsInsecure: boolean;
  /**
   * Reach the image host through the local Tor proxy.
   *
   * Its own switch, like every other model connection here. A prompt is
   * somebody's sentence about what they want a picture of, and which company
   * learns this server's address while receiving it is not a decision to
   * inherit from whatever the drafting model happened to need.
   */
  useTor: boolean;
  imageModel: string;
  /** `1024x1024`, or empty for whatever the host defaults to. */
  imageSize: string;

  // ---- The connection that films ----
  /** `same` takes the image connection whole — address, key, certificate rule and proxy. */
  videoProvider: 'same' | VideoShape;
  videoBaseUrl: string;
  videoApiKey: string;
  videoTlsInsecure: boolean;
  videoUseTor: boolean;
  videoModel: string;
  videoSeconds: number;
  videoSize: string;
}

const DEFAULTS: MediaSettings = {
  // Off, with nowhere to send a prompt. There is no bundled image server and
  // there is not going to be one: the smallest useful diffusion model is
  // larger than everything else this install ships put together.
  images: false,
  videos: false,
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  tlsInsecure: false,
  useTor: false,
  imageModel: '',
  imageSize: '1024x1024',
  videoProvider: 'same',
  videoBaseUrl: '',
  videoApiKey: '',
  videoTlsInsecure: false,
  videoUseTor: false,
  videoModel: '',
  videoSeconds: 4,
  videoSize: '',
};

let cache: { at: number; value: MediaSettings } | null = null;

export function mediaDefaults(): MediaSettings { return { ...DEFAULTS }; }

export async function getMediaSettings(): Promise<MediaSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await one<{ value: Partial<MediaSettings> }>(`SELECT value FROM settings WHERE key='media'`);
  const value = { ...DEFAULTS, ...(row?.value ?? {}) };
  // A switch that is on with nowhere to send a prompt is a button that fails
  // when it is pressed, which is worse than a button that is not there.
  if (!value.baseUrl) value.images = false;
  if (!videoAddress(value)) value.videos = false;
  cache = { at: Date.now(), value };
  return value;
}

export async function saveMediaSettings(patch: Partial<MediaSettings>): Promise<MediaSettings> {
  const current = await getMediaSettings();
  const next: MediaSettings = { ...current, ...patch };
  next.baseUrl = normalizeBaseUrl(next.baseUrl);
  next.videoBaseUrl = normalizeBaseUrl(next.videoBaseUrl);
  if (!next.baseUrl) next.images = false;
  if (!videoAddress(next)) next.videos = false;
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('media', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(next)],
  );
  cache = null;
  return next;
}

export function forgetMediaSettings(): void { cache = null; }

/** Where video would actually be asked for, following the inheritance. */
function videoAddress(m: MediaSettings): string {
  return m.videoProvider === 'same' ? m.baseUrl : m.videoBaseUrl;
}

// ---------- The connections ----------

export function imageEndpoint(m: MediaSettings): ModelEndpoint {
  return {
    id: 'image',
    label: 'the image model',
    provider: m.provider ?? 'openai',
    baseUrl: normalizeBaseUrl(m.baseUrl),
    apiKey: m.apiKey,
    tlsInsecure: Boolean(m.tlsInsecure),
    useTor: Boolean(m.useTor),
    inheritedFrom: null,
  };
}

/**
 * The server that films.
 *
 * `same` returns the image connection ENTIRELY — address, key, certificate
 * rule and Tor switch — rather than only its address. Inheriting half a
 * connection is the mistake `embedEndpoint` records having made: an address
 * borrowed without its proxy sends the request out in the clear while the
 * page still says Tor is on, and it succeeds, so nothing complains.
 */
export function videoEndpoint(m: MediaSettings): ModelEndpoint {
  if (m.videoProvider === 'same') {
    return { ...imageEndpoint(m), id: 'video', label: 'the video model', inheritedFrom: 'image' };
  }
  return {
    id: 'video',
    label: 'the video model',
    provider: m.videoProvider,
    baseUrl: normalizeBaseUrl(m.videoBaseUrl),
    apiKey: m.videoApiKey,
    tlsInsecure: Boolean(m.videoTlsInsecure),
    useTor: Boolean(m.videoUseTor),
    inheritedFrom: null,
  };
}

/** Why a request failed, in terms of the thing that actually broke. */
export function reachError(e: ModelEndpoint, err: unknown): string {
  if (e.useTor) { const tor = explainTorError(err); if (tor) return tor; }
  return explainOutboundError(err, e.baseUrl);
}

// ---------- Building the request ----------

/** `1024x1024`, `1792x1024`, and nothing else. Empty means "the host decides". */
export function isValidSize(v: string): boolean {
  const s = String(v ?? '').trim();
  return s === '' || /^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(s);
}

/**
 * Whether this model will accept `response_format: "b64_json"`.
 *
 * Worth a predicate rather than always sending it. `gpt-image-1` and its
 * successors REFUSE the parameter — "Unknown parameter: response_format" —
 * and always answer with base64 anyway, while `dall-e-3` defaults to handing
 * back a URL that expires in an hour and needs to be asked for base64
 * explicitly. Sending it unconditionally breaks the newer models; never
 * sending it means the older ones hand back a link this server then has to go
 * and fetch. So it is asked for exactly where it is understood.
 */
export function takesResponseFormat(model: string): boolean {
  return !/^(?:.*\/)?gpt-image/i.test(String(model ?? '').trim());
}

export function imageRequestBody(m: MediaSettings, prompt: string, size?: string): Record<string, unknown> {
  const model = m.imageModel.trim();
  const chosen = (size ?? m.imageSize ?? '').trim();
  if (m.provider === 'openai-chat') {
    // The chat-completions spelling. `modalities` is what asks for a picture
    // rather than a paragraph about one; a host that ignores it answers with
    // prose, which `readImageReply` reports as "no image came back" instead of
    // storing a text file with a .png on the end.
    return {
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
    };
  }
  return {
    model,
    prompt,
    n: 1,
    ...(chosen ? { size: chosen } : {}),
    ...(takesResponseFormat(model) ? { response_format: 'b64_json' } : {}),
  };
}

// ---------- Reading the reply ----------

export interface ImageReply {
  /** Base64 bytes, when the host sent the picture itself. */
  b64?: string;
  /** A link to it, when the host sent one of those instead. */
  url?: string;
  /** Some hosts rewrite the prompt before drawing and say what they used. */
  revisedPrompt?: string;
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?;base64,(.+)$/is;

/**
 * The picture out of one reply, whichever of the two shapes sent it.
 *
 * Returns null rather than throwing, so the caller can say "that host
 * answered, and there was no picture in it" — which is a different problem
 * from an unreachable host and has a different fix (usually a model name that
 * is a chat model).
 */
export function readImageReply(shape: MediaShape, j: any): ImageReply | null {
  if (shape === 'openai-chat') {
    const message = j?.choices?.[0]?.message;
    // Two spellings in the wild: a dedicated `images` array (OpenRouter), and
    // an image part inside a content array (Google's compatibility layer).
    const candidates = [
      ...(Array.isArray(message?.images) ? message.images : []),
      ...(Array.isArray(message?.content) ? message.content : []),
    ];
    for (const part of candidates) {
      const url = part?.image_url?.url ?? part?.url ?? (typeof part === 'string' ? part : null);
      if (typeof url !== 'string' || !url) continue;
      const data = DATA_URL.exec(url);
      if (data) return { b64: data[2] };
      if (/^https?:/i.test(url)) return { url };
    }
    return null;
  }
  const first = Array.isArray(j?.data) ? j.data[0] : null;
  if (!first) return null;
  const revisedPrompt = typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined;
  if (typeof first.b64_json === 'string' && first.b64_json) return { b64: first.b64_json, revisedPrompt };
  if (typeof first.url === 'string' && first.url) {
    const data = DATA_URL.exec(first.url);
    return data ? { b64: data[2], revisedPrompt } : { url: first.url, revisedPrompt };
  }
  return null;
}

/**
 * What kind of file this actually is, read from the bytes.
 *
 * Not from the `Content-Type` header and not from the model name. A host that
 * labels a WebP as a PNG is common enough, and the label is what decides
 * whether the composer will show the picture inline at all — `GET
 * /api/mail/uploads/:id?inline=1` serves an image inline only for a type it
 * recognises, and refuses to guess, so a wrong label is an attachment nobody
 * can see rather than a cosmetic error.
 */
export function sniffMediaType(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  // EBML, spelled out in bytes rather than as a string literal: the magic is
  // 1A 45 DF A3, and written as a latin1 string it carries a raw control
  // character that no editor, diff or code review renders.
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
}

/**
 * What filing a finished generation gives back.
 *
 * The whole row rather than its id, because the job view is the only thing
 * the browser ever sees of a video: the panel that started it may have been
 * closed and reopened, and there is no endpoint that hands back an upload's
 * name and size. An id alone left the composer inventing both.
 */
export interface DeliveredUpload { id: number; filename: string; contentType: string; size: number }

export interface GeneratedMedia {
  data: Buffer;
  contentType: string;
  filename: string;
  model: string;
  revisedPrompt?: string;
}

/**
 * A link the host sent instead of the bytes, followed safely.
 *
 * The address in a reply is not one an admin typed, so it does not inherit
 * their permission to point this server wherever they like. A host that has
 * been compromised — or is simply hostile — answering with
 * `http://169.254.169.254/latest/meta-data/` would otherwise have this server
 * fetch its own cloud credentials and file them as a picture.
 *
 * Same origin as the configured address is allowed outright, because that IS
 * the address the admin chose and a local image server on the LAN answers
 * with its own `http://…:7860/file=…`. Anywhere else goes through the same
 * guard every other user-influenced URL does. Either way the fetch carries the
 * endpoint's transport, so a host reached over Tor does not have its pictures
 * collected in the clear.
 */
async function fetchLinked(e: ModelEndpoint, url: string, signal?: AbortSignal): Promise<Buffer> {
  const sameOrigin = (() => {
    try { return new URL(url).origin === new URL(e.baseUrl).origin; } catch { return false; }
  })();
  if (!sameOrigin) await assertPublicUrl(url, { what: 'The address that host sent the picture back at' });
  const res = await outboundFetch(url, { signal }, transportFor(e))
    .catch((err) => { throw new Error(reachError(e, err)); });
  if (!res.ok) throw new Error(`That host offered the picture at a link that answered HTTP ${res.status}.`);
  return readAllBytes(res);
}

/**
 * The whole body as bytes, with a ceiling.
 *
 * Not `res.text()`, which is the mistake this is here to make impossible:
 * `text()` decodes as UTF-8, and every byte sequence that is not valid UTF-8
 * — which is most of a PNG — is replaced with U+FFFD. The picture arrives,
 * the request succeeds, and what gets stored is a corrupted file roughly the
 * right size, so nothing anywhere reports a problem except the person looking
 * at a broken image.
 *
 * The ceiling is here rather than at the database because this is where the
 * bytes are still arriving: a host answering with something enormous should
 * be stopped mid-stream, not after it has all been held in memory.
 */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;

async function readAllBytes(res: OutboundResponse): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`That host sent back more than ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB, which is larger than anything that can be attached to mail.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function assertConfigured(e: ModelEndpoint, what: string): void {
  if (e.baseUrl) return;
  throw new Error(e.inheritedFrom
    ? `No address is set for the image model, which ${what} is set to share.`
    : notConfigured(e));
}

// ---------- Drawing ----------

export interface MediaConsent { userId: number; capability: Capability }

export async function generateImage(
  prompt: string,
  consent: MediaConsent,
  opts: { size?: string; signal?: AbortSignal } = {},
): Promise<GeneratedMedia> {
  await assertCapability(consent.userId, consent.capability);
  const m = await getMediaSettings();
  if (!m.images) throw new Error('Image generation is turned off in Admin → Pictures and video');
  const e = imageEndpoint(m);
  assertConfigured(e, 'images');
  if (!m.imageModel.trim()) throw new Error('No image model is named in Admin → Pictures and video.');

  const path = m.provider === 'openai-chat' ? '/v1/chat/completions' : '/v1/images/generations';
  const res = await outboundFetch(`${e.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...endpointHeaders(e) },
    body: JSON.stringify(imageRequestBody(m, prompt, opts.size)),
    signal: opts.signal,
  }, transportFor(e)).catch((err) => { throw new Error(reachError(e, err)); });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`The image model returned HTTP ${res.status}: ${body}`);
  }
  const reply = readImageReply(m.provider, await res.json().catch(() => null));
  if (!reply) {
    throw new Error(m.provider === 'openai-chat'
      ? `"${m.imageModel}" answered without a picture in it. On this shape the model has to be one that can return images — a chat model will answer in words instead.`
      : `"${m.imageModel}" answered without a picture in it.`);
  }

  const data = reply.b64 ? Buffer.from(reply.b64, 'base64') : await fetchLinked(e, reply.url!, opts.signal);
  if (!data.length) throw new Error('The image model returned an empty picture.');
  const contentType = sniffMediaType(data) ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    // Storing whatever came back under a .png would put an unrecognised file
    // in somebody's outgoing mail on the model host's say-so.
    throw new Error('That host sent back something that is not a picture.');
  }
  log.info('image generated', { model: m.imageModel, bytes: data.length, type: contentType });
  return {
    data,
    contentType,
    filename: `generated.${contentType.split('/')[1].replace('jpeg', 'jpg')}`,
    model: m.imageModel,
    revisedPrompt: reply.revisedPrompt,
  };
}

// ---------- Filming ----------
//
// Video is the one thing here that does not fit in a request. A few seconds of
// it is minutes of somebody else's cluster, so the host takes the prompt,
// hands back a job id and is asked later how it went — and the browser that
// started it cannot be what drives that, for exactly the reasons `ai/pulls.ts`
// gives about model downloads: switching tabs, reloading, a phone locking.
// Losing the connection there cost a download; losing it here costs a
// generation somebody paid for.
//
// So a generation is a job in this process, watched over SSE, and only an
// explicit cancel stops it. What this does NOT survive is a restart of the
// server: the handle is in memory. The remote id is published in the view for
// exactly that case, so a generation that outlives its handle can still be
// collected by hand rather than being silently lost.

export interface VideoJobView {
  id: string;
  userId: number;
  /** The host's own id for it, so a job orphaned by a restart is still findable. */
  remoteId: string | null;
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** The word the host last used for where it is. */
  status: string;
  /** Whole percent where the host reports one, null where it does not. */
  pct: number | null;
  model: string;
  seconds: number;
  startedAt: number;
  endedAt: number | null;
  /** The upload the finished video was filed as, as the composer needs it. */
  upload?: DeliveredUpload;
  error?: string;
}

interface VideoJob {
  view: VideoJobView;
  abort: AbortController;
  watchers: Set<(v: VideoJobView) => void>;
  sweep?: NodeJS.Timeout;
}

const videoJobs = new Map<string, VideoJob>();

/** How long a finished job stays visible, so a page that reconnects learns the outcome. */
const KEEP_FINISHED_MS = 10 * 60_000;
/** How often the host is asked. Generous: every poll is a request somebody is billed for. */
export const POLL_MS = 4_000;
/** When to stop asking. A host that has not finished in this long has lost it. */
export const MAX_WAIT_MS = 15 * 60_000;

function publish(job: VideoJob): void {
  const snapshot = { ...job.view };
  for (const fn of job.watchers) {
    try { fn(snapshot); } catch { /* a dead socket is not this job's problem */ }
  }
}

function finish(job: VideoJob, state: VideoJobView['state'], patch: Partial<VideoJobView> = {}): void {
  if (job.view.state !== 'running') return;
  Object.assign(job.view, patch, { state, endedAt: Date.now() });
  if (state === 'done') job.view.pct = 100;
  publish(job);
  log.info(`video ${state}`, { model: job.view.model, remote: job.view.remoteId, error: job.view.error });
  job.sweep = setTimeout(() => { if (videoJobs.get(job.view.id) === job) videoJobs.delete(job.view.id); }, KEEP_FINISHED_MS);
  job.sweep.unref?.();
}

/**
 * What a poll of a video job means, across the words different hosts use.
 *
 * Exported because it is the part most likely to be wrong against a host
 * nobody here has an account with, and the part a fixture can check without
 * one. A status this does not recognise is treated as still running rather
 * than as a failure: a host inventing a new word for "rendering" must not
 * throw away a generation that is going fine.
 */
export function readVideoStatus(j: any): { state: 'running' | 'done' | 'error'; status: string; pct: number | null; error?: string } {
  const raw = String(j?.status ?? j?.state ?? '').toLowerCase();
  const progress = Number(j?.progress);
  const pct = Number.isFinite(progress) && progress >= 0 ? Math.min(100, Math.round(progress <= 1 ? progress * 100 : progress)) : null;
  const error = j?.error ? String(j.error?.message ?? j.error).slice(0, 300) : undefined;
  if (/^(completed|succeeded|success|done|ready)$/.test(raw)) return { state: 'done', status: raw, pct: 100 };
  if (/^(failed|error|cancelled|canceled|rejected)$/.test(raw)) {
    return { state: 'error', status: raw, pct, error: error ?? `The host reported the generation ${raw}.` };
  }
  return { state: 'running', status: raw || 'working', pct };
}

export function listVideoJobs(userId: number): VideoJobView[] {
  return [...videoJobs.values()]
    .filter((j) => j.view.userId === userId)
    .map((j) => ({ ...j.view }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function getVideoJob(userId: number, id: string): VideoJobView | null {
  const job = videoJobs.get(id);
  return job && job.view.userId === userId ? { ...job.view } : null;
}

/** Watch a job. Its current state arrives immediately; detaching does not stop it. */
export function watchVideoJob(userId: number, id: string, onUpdate: (v: VideoJobView) => void): (() => void) | null {
  const job = videoJobs.get(id);
  if (!job || job.view.userId !== userId) return null;
  onUpdate({ ...job.view });
  if (job.view.state !== 'running') return () => {};
  job.watchers.add(onUpdate);
  return () => { job.watchers.delete(onUpdate); };
}

export function cancelVideoJob(userId: number, id: string): boolean {
  const job = videoJobs.get(id);
  if (!job || job.view.userId !== userId || job.view.state !== 'running') return false;
  job.abort.abort();
  finish(job, 'cancelled', { status: 'cancelled', error: 'cancelled' });
  return true;
}

/** Tests only: the registry is process-wide state. */
export function resetVideoJobs(): void {
  for (const job of videoJobs.values()) { if (job.sweep) clearTimeout(job.sweep); job.abort.abort(); }
  videoJobs.clear();
}

/**
 * Start a generation and drive it to the end.
 *
 * `deliver` is how the finished bytes become something the composer can
 * attach. It is passed in rather than done here so this file never learns
 * about the uploads table: what it knows is model servers.
 */
export async function startVideo(
  prompt: string,
  consent: MediaConsent,
  deliver: (media: GeneratedMedia) => Promise<DeliveredUpload>,
  opts: { seconds?: number; size?: string } = {},
): Promise<VideoJobView> {
  await assertCapability(consent.userId, consent.capability);
  const m = await getMediaSettings();
  if (!m.videos) throw new Error('Video generation is turned off in Admin → Pictures and video');
  const e = videoEndpoint(m);
  assertConfigured(e, 'video');
  if (!m.videoModel.trim()) throw new Error('No video model is named in Admin → Pictures and video.');

  const seconds = Math.max(1, Math.min(60, Math.floor(opts.seconds ?? m.videoSeconds) || m.videoSeconds));
  const size = (opts.size ?? m.videoSize ?? '').trim();
  const abort = new AbortController();
  const id = `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: VideoJob = {
    view: {
      id, userId: consent.userId, remoteId: null, state: 'running', status: 'starting',
      pct: null, model: m.videoModel, seconds, startedAt: Date.now(), endedAt: null,
    },
    abort,
    watchers: new Set(),
  };
  videoJobs.set(id, job);
  log.info('video started', { model: m.videoModel, seconds, user: consent.userId });

  void (async () => {
    try {
      const create = await outboundFetch(`${e.baseUrl}/v1/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...endpointHeaders(e) },
        // `seconds` goes out as a string: that is what the documented shape
        // asks for, and a host that wants a number parses one out of it,
        // whereas a host that wants the string refuses a number.
        body: JSON.stringify({ model: m.videoModel.trim(), prompt, seconds: String(seconds), ...(size ? { size } : {}) }),
        signal: abort.signal,
      }, transportFor(e)).catch((err) => { throw new Error(reachError(e, err)); });
      if (!create.ok) {
        const body = (await create.text().catch(() => '')).slice(0, 300);
        throw new Error(`The video model returned HTTP ${create.status}: ${body}`);
      }
      const started = await create.json().catch(() => null);
      const remoteId = String(started?.id ?? '');
      if (!remoteId) throw new Error('That host accepted the prompt without giving the job an id, so there is nothing to ask about it.');
      job.view.remoteId = remoteId;
      Object.assign(job.view, readVideoStatus(started), { state: 'running' as const });
      publish(job);

      const deadline = Date.now() + MAX_WAIT_MS;
      for (;;) {
        if (abort.signal.aborted) return;
        if (Date.now() > deadline) throw new Error(`That host has not finished in ${Math.round(MAX_WAIT_MS / 60000)} minutes. The generation may still complete there; its id is ${remoteId}.`);
        await sleep(POLL_MS, abort.signal);
        if (abort.signal.aborted) return;
        const poll = await outboundFetch(`${e.baseUrl}/v1/videos/${encodeURIComponent(remoteId)}`, {
          headers: endpointHeaders(e),
          signal: abort.signal,
        }, transportFor(e)).catch((err) => { throw new Error(reachError(e, err)); });
        if (!poll.ok) throw new Error(`Asking after the generation returned HTTP ${poll.status}.`);
        const read = readVideoStatus(await poll.json().catch(() => null));
        if (read.state === 'error') throw new Error(read.error ?? 'The host reported the generation failed.');
        job.view.status = read.status;
        job.view.pct = read.pct;
        publish(job);
        if (read.state === 'done') break;
      }

      const content = await outboundFetch(`${e.baseUrl}/v1/videos/${encodeURIComponent(remoteId)}/content`, {
        headers: endpointHeaders(e),
        signal: abort.signal,
      }, transportFor(e)).catch((err) => { throw new Error(reachError(e, err)); });
      if (!content.ok) throw new Error(`Collecting the finished video returned HTTP ${content.status}.`);
      const data = await readAllBytes(content);
      if (!data.length) throw new Error('The host reported the video was ready and then sent nothing.');
      const contentType = sniffMediaType(data) ?? 'application/octet-stream';
      if (!contentType.startsWith('video/')) throw new Error('That host sent back something that is not a video.');
      const upload = await deliver({
        data,
        contentType,
        filename: `generated.${contentType === 'video/quicktime' ? 'mov' : contentType.split('/')[1]}`,
        model: m.videoModel,
      });
      finish(job, 'done', { status: 'ready', upload });
    } catch (err) {
      if (abort.signal.aborted) finish(job, 'cancelled', { status: 'cancelled', error: 'cancelled' });
      else finish(job, 'error', { status: 'failed', error: (err as Error)?.message ?? String(err) });
    }
  })();

  return { ...job.view };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

// ---------- Is it reachable ----------

export interface MediaHealth { ok: boolean; error?: string; models?: string[] }

/**
 * Whether a connection answers, tried from the form rather than from what is
 * saved — an admin should not have to store a key to find out it is wrong.
 *
 * `/v1/models` is the only thing all of these agree on. A host that refuses it
 * but draws perfectly well is possible, so a 404 is reported as "reachable,
 * and it does not list its models" rather than as a failure.
 */
export async function mediaHealth(e: ModelEndpoint): Promise<MediaHealth> {
  if (!e.baseUrl) return { ok: false, error: notConfigured(e) };
  try {
    const res = await outboundFetch(`${e.baseUrl}/v1/models`, {
      headers: endpointHeaders(e),
      signal: AbortSignal.timeout(8000),
    }, transportFor(e));
    if (res.status === 401 || res.status === 403) return { ok: false, error: `That host refused the API key (HTTP ${res.status})` };
    if (res.status === 404) return { ok: true };
    if (!res.ok) return { ok: false, error: `That host answered HTTP ${res.status}` };
    const j: any = await res.json().catch(() => null);
    const models = (Array.isArray(j?.data) ? j.data : [])
      .map((x: any) => String(x?.id ?? '')).filter(Boolean).slice(0, 200);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: reachError(e, err) };
  }
}
