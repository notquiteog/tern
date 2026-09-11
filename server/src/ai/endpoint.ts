// One kind of model, one connection.
//
// Tern talks to several kinds of model server — the one that writes, the one
// that embeds, the one that hears, and the ones that draw and film — and they
// are routinely that many different machines. A 4.5 GB VPS cannot hold a chat
// model and a whisper model at once, let alone a diffusion model, so the usual
// shape is a chat model on a rented GPU, an embedder on the bundled Ollama, a
// transcriber on a box on the LAN, and pictures bought by the request from
// somebody who already owns the hardware for them.
//
// ── Why this type exists ────────────────────────────────────────────────────
//
// Because "how do we reach that box" was previously answered in three places
// with three different amounts of care. The language model had an API shape, a
// certificate rule and a Tor switch. Embeddings had an address and a key and
// silently borrowed the rest. The transcriber had an address and a key and
// borrowed nothing — it called plain `fetch`, so an admin who had turned on
// "trust this certificate" found drafting worked and dictation did not, and
// there was no way to route a transcriber over Tor at all.
//
// None of that was decided; it is just what three separately written call
// sites converge on. A `ModelEndpoint` is the whole answer for one server, and
// `transportFor` is the only place it is turned into a socket, so a kind of
// model added later gets the certificate rule and the proxy by construction
// rather than by whoever writes it remembering.
import type { TlsTrust } from '../util/outbound.js';
import { torAgent } from '../util/tor.js';

/**
 * The wire shapes Tern speaks. Not hosts, not companies — request shapes.
 *
 * `openai` is the one that won: OpenAI itself, but also Groq, OpenRouter,
 * Together, Fireworks, NanoGPT, vLLM, llama.cpp, whisper.cpp, Kokoro and
 * perch's own /v1 all answer it, so "which company" is a base URL rather than
 * a branch. `providers.ts` lists the ones worth offering as a starting point.
 *
 * `gemini` and `voyage` are embedding-only, and are shapes rather than base
 * URLs because neither fits the OpenAI one without losing something. Google
 * puts the model in the path, authenticates with `x-goog-api-key` and answers
 * `{embeddings:[{values}]}`; going through its OpenAI-compatible shim instead
 * would work but could not ask for a vector narrower than 3072, which is most
 * of the reason to pick that model. Voyage's format IS OpenAI's, with one
 * field on top — `input_type` — that tells the model whether it is embedding a
 * question or a document, which Tern already knows and which measurably
 * changes what comes back.
 *
 * `openai-chat` is the odd one, and it is a shape rather than a quirk because
 * image generation genuinely arrived twice. OpenAI put it on its own path,
 * `/v1/images/generations`, and Together, Fireworks, NanoGPT and every local
 * server copied that. OpenRouter and Google's compatibility layer put it on
 * `/v1/chat/completions` instead, asked for with `modalities` and answered
 * with a data URL inside the assistant's message. Same company's shape, same
 * bearer token, different endpoint and different reply — so a host that draws
 * pictures has to be told which of the two it is, and there is no way to
 * infer it from the address.
 *
 * `comfyui` draws too, and is a shape for the opposite reason: it is not a
 * request at all. It takes a whole graph, queues it and answers with a job id,
 * and the picture is collected from its history afterwards — see `ai/media.ts`.
 */
export type ApiShape = 'ollama' | 'openai' | 'openai-chat' | 'anthropic' | 'gemini' | 'voyage' | 'comfyui';

/** Everything needed to reach one model server, and nothing about the model. */
export interface ModelEndpoint {
  /** Which kind of model this is, for error text an admin has to act on. */
  id: 'llm' | 'embed' | 'stt' | 'image' | 'video';
  /** A human name for the same, so a message can say what is unreachable. */
  label: string;
  provider: ApiShape;
  baseUrl: string;
  apiKey: string;
  /**
   * Accept a certificate this machine cannot verify, for THIS server only. A
   * rented GPU host issues itself one at boot and no public authority will
   * vouch for it; the box next door on the LAN is a different decision.
   */
  tlsInsecure: boolean;
  /**
   * Reach this server through the local Tor proxy.
   *
   * Per connection, and that is the point rather than a detail. An install
   * that drafts on a rented GPU it would rather not hand its address to, and
   * transcribes on a machine in the same rack, wants exactly one of these on.
   * A single install-wide switch cannot say that, and the version that cannot
   * say it ends up either leaking or pointlessly slow.
   */
  useTor: boolean;
  /** Set when this endpoint is configured to use another one's connection. */
  inheritedFrom: string | null;
}

/**
 * The credential header, in whichever form the server on the other end wants.
 *
 * Anthropic does not read `Authorization`. It reads `x-api-key`, and it needs
 * `anthropic-version` on every request or it refuses the lot — a mandatory
 * version header is unusual enough to be worth naming, because the failure it
 * produces is a 400 on every call that reads like a malformed body rather than
 * a missing header.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

export function endpointHeaders(e: ModelEndpoint): Record<string, string> {
  if (e.provider === 'anthropic') {
    return {
      'anthropic-version': ANTHROPIC_VERSION,
      ...(e.apiKey ? { 'x-api-key': e.apiKey } : {}),
    };
  }
  // Google reads neither of the other two. The same key can go in a `?key=`
  // query parameter instead, and that is exactly why it does not: a credential
  // in a URL is a credential in every log, proxy and error message between
  // here and there.
  if (e.provider === 'gemini') {
    return e.apiKey ? { 'x-goog-api-key': e.apiKey } : {};
  }
  // Voyage takes a bearer token, like the OpenAI shape it otherwise copies.
  return e.apiKey ? { Authorization: `Bearer ${e.apiKey}` } : {};
}

/**
 * How the wire is opened for one endpoint: the certificate decision and the
 * optional proxy, together.
 *
 * Deliberately one call rather than two. The version of this that returned
 * only the certificate half shipped with one of fifteen call sites having
 * forgotten it — `openaiStream` went out bare, so the connection test passed
 * while every draft failed. A single value that carries everything cannot be
 * half-applied.
 */
export function transportFor(e: ModelEndpoint): TlsTrust {
  return {
    insecure: Boolean(e.tlsInsecure),
    ...(e.useTor ? { agent: torAgent() } : {}),
  };
}

/** A sentence naming the endpoint, for an admin who has to go and fix one. */
export function notConfigured(e: ModelEndpoint): string {
  return `No address is set for ${e.label}.`;
}
