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
// Generate into an automated send. The hard filter in `ai/sendGuard.ts` reads
// text and can say whether a draft still contains a merge field or a
// placeholder; nothing reads a picture and says whether it is fit to put in
// front of a stranger. So a sequence step, a responder and every other path
// that puts mail on the wire without a person looking first does not get to
// make one, and that is not going to change while the asymmetry holds.
//
// The rule is therefore about the PERSON, not about the composer, and it is
// worth stating that way round because the two came apart. This was originally
// written as "everything here is reached from a composer", which was true when
// the composer was the only caller. The assistant is now a second one: it can
// draw a picture inside a conversation, because somebody is sitting there
// having asked for it in the last few seconds. What it cannot do — see
// `ai/tools.ts` — is attach the result to anything. It hands back a card, and
// putting that card in a message is the person's own click, which lands them
// in the composer, which is where a message gets looked at one more time
// before it goes.
//
// So the invariant survives intact and is narrower than its first wording: no
// picture reaches a stranger without a human having seen it. What changed is
// that "a human saw it" no longer implies "a composer made it".
import { randomUUID } from 'node:crypto';
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { assertCapability, type Capability } from '../services/capabilities.js';
import { apiUrl, explainOutboundError, normalizeBaseUrl, outboundFetch, type OutboundResponse } from '../util/outbound.js';
import { dialectFor } from './reasoning.js';
import { explainTorError } from '../util/tor.js';
import { assertPublicUrl } from '../util/netguard.js';
import { endpointHeaders, notConfigured, transportFor, type ModelEndpoint } from './endpoint.js';

const log = logger('media');

/**
 * The wire shapes that draw a picture. See `ApiShape` for why the two OpenAI
 * ones are two rather than one. ComfyUI's is a queue instead of a request: a
 * graph goes in, a job id comes out, and the picture is collected once the
 * job says it is done — see `comfyGenerate`.
 */
export type MediaShape = 'openai' | 'openai-chat' | 'comfyui';

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
  /**
   * The graph ComfyUI runs, as its "Save (API format)" JSON with the prompt
   * written `%prompt%` wherever it belongs. Empty means the built-in one —
   * ComfyUI's own default text-to-image graph, which runs any SD 1.x or SDXL
   * checkpoint with nothing but core nodes. Read only on the `comfyui` shape.
   */
  comfyWorkflow: string;

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
  comfyWorkflow: '',
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
    // OpenRouter's Image API always answers base64 and has no such field.
    ...(takesResponseFormat(model) && dialectFor(m.baseUrl) !== 'openrouter' ? { response_format: 'b64_json' } : {}),
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
  if (m.provider === 'comfyui') return comfyGenerate(e, m, prompt, opts);

  // OpenRouter's Image API is the path shape on a path of its own: `/images`
  // rather than `/images/generations`, answering the same `{data:[…]}`.
  const path = m.provider === 'openai-chat' ? '/v1/chat/completions'
    : dialectFor(e.baseUrl) === 'openrouter' ? '/v1/images' : '/v1/images/generations';
  const res = await outboundFetch(apiUrl(e.baseUrl, path), {
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

// ---------- ComfyUI ----------
//
// ComfyUI does not take a prompt. It takes a graph — nodes wired together,
// with the prompt a string inside one of them — queues it, and hands back a
// job id; the picture is collected from its history once the job says it is
// done. So this is a small job runner rather than a request, and the graph is
// either the admin's own (exported with "Save (API format)", the prompt
// marked `%prompt%`) or the built-in one below.

/**
 * ComfyUI's own default text-to-image graph, in API format.
 *
 * Built in because it is the one graph that runs on any install: every node
 * is a core node, and it takes any SD 1.x or SDXL checkpoint — which is what
 * `imageModel` names on this shape. Anything fancier (FLUX's separate
 * loaders, an upscaler, a LoRA) depends on what that particular ComfyUI has
 * installed, which is exactly what the workflow field is for.
 */
export function defaultComfyGraph(): Record<string, unknown> {
  return {
    3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: 25, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'tern', images: ['8', 0] } },
  };
}

const COMFY_TOKENS = ['prompt', 'negative', 'seed', 'width', 'height', 'model'] as const;
type ComfyToken = (typeof COMFY_TOKENS)[number];

/** `1024x768` → [1024, 768], rounded down to the multiple of 8 a latent needs. */
export function comfySize(size: string): [number, number] {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size ?? '').trim());
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
  return [Math.max(64, w - (w % 8)), Math.max(64, h - (h % 8))];
}

/**
 * The graph to queue — the admin's or the built-in one — with its tokens
 * filled in.
 *
 * A token that is a whole value becomes a real number where one belongs:
 * ComfyUI validates input types and refuses `"1024"` for a width. One inside a
 * longer string is substituted as text, so `"%prompt%, film grain"` works.
 */
export function buildComfyGraph(workflow: string, values: Record<ComfyToken, string | number>): Record<string, unknown> {
  const graph: unknown = workflow.trim() ? JSON.parse(workflow) : defaultComfyGraph();
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = /^%([a-z]+)%$/.exec(v);
      if (whole && (COMFY_TOKENS as readonly string[]).includes(whole[1]!)) return values[whole[1] as ComfyToken];
      return v.replace(/%([a-z]+)%/g, (all, k: string) => ((COMFY_TOKENS as readonly string[]).includes(k) ? String(values[k as ComfyToken]) : all));
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(graph) as Record<string, unknown>;
}

/**
 * Why a pasted workflow will not run, or null when it will — checked when it
 * is saved, so the failure is a sentence on the settings page rather than a
 * refused job the first time somebody asks for a picture.
 */
export function comfyWorkflowProblem(text: string): string | null {
  if (!text.trim()) return null;
  let graph: unknown;
  try { graph = JSON.parse(text); } catch { return 'That workflow is not JSON. Export it from ComfyUI with "Save (API format)".'; }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return 'That workflow is not a ComfyUI graph.';
  const nodes = Object.values(graph as Record<string, unknown>);
  if (!nodes.length || !nodes.every((n) => Boolean(n) && typeof (n as { class_type?: unknown }).class_type === 'string')) {
    // The editor's own "Save" writes a layout — nodes, links, positions —
    // which ComfyUI's API refuses. Easy to confuse, so it is named.
    return 'That is the editor’s layout rather than the graph. Use "Save (API format)" in ComfyUI.';
  }
  if (!text.includes('%prompt%')) return 'Put %prompt% where the prompt goes, or every picture will ignore what was asked for.';
  return null;
}

export type ComfyOutcome =
  | { state: 'running' }
  | { state: 'error'; error: string }
  | { state: 'done'; image: { filename: string; subfolder: string; type: string } | null };

/**
 * What one job's history entry says. ComfyUI only writes the entry once the
 * job has run, so no entry means still queued or running; an entry with an
 * `execution_error` carries the node's own exception, which is what an admin
 * needs to see.
 */
export function readComfyHistory(entry: any): ComfyOutcome {
  if (!entry || typeof entry !== 'object') return { state: 'running' };
  const status = entry.status ?? {};
  if (status.status_str === 'error') {
    const reason = (Array.isArray(status.messages) ? status.messages : [])
      .map((m: any) => (Array.isArray(m) && m[0] === 'execution_error' ? m[1]?.exception_message : null))
      .find(Boolean);
    return { state: 'error', error: String(reason || 'ComfyUI reported the job failed') };
  }
  const images = Object.values(entry.outputs ?? {}).flatMap((o: any) => (Array.isArray(o?.images) ? o.images : []));
  // `output` is SaveImage's; `temp` is a preview node's, kept only as a fallback.
  const pick = images.find((i: any) => i?.type === 'output') ?? images[0];
  if (!pick && !status.completed) return { state: 'running' };
  return {
    state: 'done',
    image: pick ? { filename: String(pick.filename), subfolder: String(pick.subfolder ?? ''), type: String(pick.type ?? 'output') } : null,
  };
}

/** ComfyUI's validation reply in one sentence: which node refused what. */
export function comfyRefusal(body: string): string {
  try {
    const j = JSON.parse(body);
    const node = Object.values(j?.node_errors ?? {})[0] as any;
    const first = node?.errors?.[0];
    if (first) return `${node.class_type ?? 'a node'}: ${first.message}${first.details ? ` — ${first.details}` : ''}`;
    if (j?.error?.message) return String(j.error.message);
  } catch { /* not JSON */ }
  return body.slice(0, 200) || 'no reason given';
}

/** How often ComfyUI is asked about the job, and when to stop asking. */
const COMFY_POLL_MS = 1_500;
const COMFY_MAX_WAIT_MS = 10 * 60_000;

async function comfyGenerate(e: ModelEndpoint, m: MediaSettings, prompt: string, opts: { size?: string; signal?: AbortSignal }): Promise<GeneratedMedia> {
  const [width, height] = comfySize(opts.size || m.imageSize || '');
  const graph = buildComfyGraph(m.comfyWorkflow ?? '', {
    prompt, negative: '', model: m.imageModel.trim(), width, height, seed: Math.floor(Math.random() * 2 ** 32),
  });
  const queued = await outboundFetch(`${e.baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...endpointHeaders(e) },
    body: JSON.stringify({ prompt: graph, client_id: `tern-${randomUUID()}` }),
    signal: opts.signal,
  }, transportFor(e)).catch((err) => { throw new Error(reachError(e, err)); });
  if (!queued.ok) {
    // The validation reply names the node and the input it refused — usually
    // a checkpoint that is not on that machine — which is the fix.
    throw new Error(`ComfyUI refused the job (HTTP ${queued.status}): ${comfyRefusal(await queued.text().catch(() => ''))}`);
  }
  const id = String(((await queued.json().catch(() => null)) as { prompt_id?: unknown } | null)?.prompt_id ?? '');
  if (!id) throw new Error('ComfyUI accepted the job but gave it no id.');

  // `/history/{id}` is the obvious way to ask about one job, and perch's
  // allowlist matches exact paths, so through perch it is refused. Bare
  // `/history` returns the recent jobs keyed by id; it is used from the first
  // time the precise path is refused, and works on both.
  let bare = false;
  const deadline = Date.now() + COMFY_MAX_WAIT_MS;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('The picture was cancelled.');
    if (Date.now() > deadline) {
      throw new Error(`ComfyUI had not finished after ${COMFY_MAX_WAIT_MS / 60_000} minutes. Job ${id} may still finish there.`);
    }
    await sleep(COMFY_POLL_MS, opts.signal ?? new AbortController().signal);
    const res = await outboundFetch(bare ? `${e.baseUrl}/history?max_items=64` : `${e.baseUrl}/history/${encodeURIComponent(id)}`, {
      headers: endpointHeaders(e), signal: opts.signal,
    }, transportFor(e)).catch((err) => { throw new Error(reachError(e, err)); });
    if (!bare && (res.status === 404 || res.status === 403)) { bare = true; continue; }
    if (!res.ok) throw new Error(`ComfyUI answered HTTP ${res.status} while the picture was being made.`);
    const outcome = readComfyHistory(((await res.json().catch(() => null)) as Record<string, unknown> | null)?.[id]);
    if (outcome.state === 'running') continue;
    if (outcome.state === 'error') throw new Error(`ComfyUI could not make that picture: ${outcome.error}`);
    if (!outcome.image) throw new Error('ComfyUI finished the job without saving a picture. The workflow needs a SaveImage node.');

    const q = new URLSearchParams(outcome.image);
    const file = await outboundFetch(`${e.baseUrl}/view?${q}`, { headers: endpointHeaders(e), signal: opts.signal }, transportFor(e))
      .catch((err) => { throw new Error(reachError(e, err)); });
    if (!file.ok) throw new Error(`ComfyUI made the picture but would not hand it over (HTTP ${file.status}).`);
    const data = await readAllBytes(file);
    const contentType = sniffMediaType(data) ?? 'application/octet-stream';
    if (!contentType.startsWith('image/')) throw new Error('ComfyUI sent back something that is not a picture.');
    log.info('image generated', { model: m.imageModel, bytes: data.length, type: contentType, via: 'comfyui' });
    return {
      data,
      contentType,
      filename: `generated.${contentType.split('/')[1]!.replace('jpeg', 'jpg')}`,
      model: m.imageModel,
    };
  }
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
      const create = await outboundFetch(apiUrl(e.baseUrl, '/v1/videos'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...endpointHeaders(e) },
        // `seconds` goes out as a string: that is what the documented shape
        // asks for, and a host that wants a number parses one out of it,
        // whereas a host that wants the string refuses a number. OpenRouter
        // is the exception: it reads `duration`, a number, and quietly ignores
        // `seconds`, so the clip came back at the model's default length —
        // billed by the second — whatever was chosen here.
        body: JSON.stringify({
          model: m.videoModel.trim(),
          prompt,
          ...(dialectFor(e.baseUrl) === 'openrouter' ? { duration: seconds } : { seconds: String(seconds) }),
          ...(size ? { size } : {}),
        }),
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
        const poll = await outboundFetch(apiUrl(e.baseUrl, `/v1/videos/${encodeURIComponent(remoteId)}`), {
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

      const content = await outboundFetch(apiUrl(e.baseUrl, `/v1/videos/${encodeURIComponent(remoteId)}/content`), {
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
    if (e.provider === 'comfyui') {
      // No /v1/models here. `/system_stats` answers on every build, and the
      // checkpoint list is what an admin is choosing a model from.
      const res = await outboundFetch(`${e.baseUrl}/system_stats`, { headers: endpointHeaders(e), signal: AbortSignal.timeout(8000) }, transportFor(e));
      if (res.status === 401 || res.status === 403) return { ok: false, error: `That host refused the key (HTTP ${res.status})` };
      if (!res.ok) return { ok: false, error: `That host answered HTTP ${res.status}` };
      const info = await outboundFetch(`${e.baseUrl}/object_info/CheckpointLoaderSimple`, { headers: endpointHeaders(e), signal: AbortSignal.timeout(8000) }, transportFor(e)).catch(() => null);
      const j: any = info?.ok ? await info.json().catch(() => null) : null;
      const names = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
      return { ok: true, models: Array.isArray(names) ? names.map(String).slice(0, 200) : undefined };
    }
    // OpenRouter's `/models` is its chat catalogue; the models that draw and
    // film are listed on paths of their own, in the same envelope.
    const listing = dialectFor(e.baseUrl) !== 'openrouter' ? '/v1/models'
      : e.id === 'video' ? '/v1/videos/models' : '/v1/images/models';
    const res = await outboundFetch(apiUrl(e.baseUrl, listing), {
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
