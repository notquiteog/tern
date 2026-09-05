// Minimal JMAP client (RFC 8620 / 8621 / 8887 event source). Written against
// the standard rather than any one server so Fastmail, Stalwart, Cyrus and
// whatever comes next all work through the same code path. Provider-specific
// differences live in the account record (session URL, auth header, whether
// to pin returned URLs to the session origin), never in this file.
import { logger } from '../log.js';

const log = logger('jmap');

export const CORE = 'urn:ietf:params:jmap:core';
export const MAIL = 'urn:ietf:params:jmap:mail';
export const SUBMISSION = 'urn:ietf:params:jmap:submission';

export type MethodCall = [string, Record<string, unknown>, string];
export type MethodResponse = [string, any, string];

export interface JmapSession {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  eventSourceUrl: string | null;
  accountId: string;
  username: string;
  capabilities: Record<string, unknown>;
  accountCapabilities: Record<string, unknown>;
  state: string;
  hasSubmission: boolean;
}

export interface JmapClientOptions {
  sessionUrl: string;
  authHeader: string;
  // Stalwart returns absolute URLs built from its configured public hostname.
  // When the app reaches it over an internal address (a compose network, a
  // tunnel) those URLs are unreachable, so rewrite their origin to the one we
  // actually connected to. Fastmail returns same-origin URLs, so it is a no-op.
  pinOrigin: boolean;
  timeoutMs?: number;
}

export class JmapError extends Error {
  type: string;
  status?: number;
  detail?: unknown;
  constructor(type: string, message: string, status?: number, detail?: unknown) {
    super(message);
    this.type = type;
    this.status = status;
    this.detail = detail;
  }
}

export function rewriteOrigin(url: string, base: string, pin: boolean): string {
  // Resolve relative URLs against the session URL, then optionally pin the origin.
  const resolved = new URL(url, base);
  if (pin) {
    const origin = new URL(base);
    resolved.protocol = origin.protocol;
    resolved.host = origin.host;
  }
  // URL parsing percent-encodes the RFC 6570 placeholders ({accountId},
  // {blobId}, {name}, {type}) in the path, which then never match the
  // template substitution and every upload/download 404s. Put them back.
  return resolved.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

export class JmapClient {
  private opts: JmapClientOptions;
  session: JmapSession | null = null;

  constructor(opts: JmapClientOptions) {
    this.opts = { timeoutMs: 60_000, ...opts };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.opts.authHeader, Accept: 'application/json', ...extra };
  }

  async fetchSession(): Promise<JmapSession> {
    const res = await fetch(this.opts.sessionUrl, {
      headers: this.headers(),
      redirect: 'follow',
      signal: AbortSignal.timeout(this.opts.timeoutMs!),
    });
    if (res.status === 401 || res.status === 403) throw new JmapError('unauthorized', `Mail server rejected the credentials (${res.status})`, res.status);
    if (!res.ok) throw new JmapError('http', `Session request failed with HTTP ${res.status}`, res.status, await safeText(res));
    const body: any = await res.json();
    const base = res.url || this.opts.sessionUrl;
    const pin = this.opts.pinOrigin;
    const accountId: string | undefined = body.primaryAccounts?.[MAIL] ?? Object.keys(body.accounts ?? {})[0];
    if (!accountId) throw new JmapError('no-mail-account', 'The server session has no mail account');
    const session: JmapSession = {
      apiUrl: rewriteOrigin(body.apiUrl, base, pin),
      uploadUrl: rewriteOrigin(body.uploadUrl, base, pin),
      downloadUrl: rewriteOrigin(body.downloadUrl, base, pin),
      eventSourceUrl: body.eventSourceUrl ? rewriteOrigin(body.eventSourceUrl, base, pin) : null,
      accountId,
      username: body.username ?? '',
      capabilities: body.capabilities ?? {},
      accountCapabilities: body.accounts?.[accountId]?.accountCapabilities ?? {},
      state: body.state ?? '',
      hasSubmission: Boolean(body.accounts?.[accountId]?.accountCapabilities?.[SUBMISSION] ?? body.capabilities?.[SUBMISSION]),
    };
    this.session = session;
    return session;
  }

  async ensureSession(): Promise<JmapSession> {
    return this.session ?? this.fetchSession();
  }

  // One JMAP request with any number of method calls. Throws on transport
  // errors and on a method-level "error" response, which keeps callers honest:
  // a sync that silently skipped an errored call would drift from the server.
  async call(methodCalls: MethodCall[], using: string[] = [CORE, MAIL]): Promise<MethodResponse[]> {
    const s = await this.ensureSession();
    const res = await fetch(s.apiUrl, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ using, methodCalls }),
      signal: AbortSignal.timeout(this.opts.timeoutMs!),
    });
    if (res.status === 401) throw new JmapError('unauthorized', 'Mail server rejected the credentials', 401);
    if (!res.ok) throw new JmapError('http', `JMAP request failed with HTTP ${res.status}`, res.status, await safeText(res));
    const body: any = await res.json();
    const responses: MethodResponse[] = body.methodResponses ?? [];
    for (const [name, args, tag] of responses) {
      if (name === 'error') {
        throw new JmapError(args?.type ?? 'serverError', `JMAP method error (${tag}): ${args?.type}${args?.description ? ' - ' + args.description : ''}`, undefined, args);
      }
    }
    if (body.sessionState && this.session && body.sessionState !== this.session.state) {
      this.session.state = body.sessionState;
    }
    return responses;
  }

  // Convenience: single call, returns the response arguments.
  async one(name: string, args: Record<string, unknown>, using?: string[]): Promise<any> {
    const [[, resArgs]] = await this.call([[name, args, 'c0']], using);
    return resArgs;
  }

  async upload(data: Buffer | Uint8Array, contentType: string): Promise<{ blobId: string; size: number; type: string }> {
    const s = await this.ensureSession();
    const url = s.uploadUrl.replace('{accountId}', encodeURIComponent(s.accountId));
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': contentType }),
      body: data as any,
      signal: AbortSignal.timeout(Math.max(this.opts.timeoutMs!, 120_000)),
    });
    if (!res.ok) throw new JmapError('upload', `Blob upload failed with HTTP ${res.status}`, res.status, await safeText(res));
    return (await res.json()) as any;
  }

  downloadUrl(blobId: string, name: string, type: string): string {
    const s = this.session!;
    return s.downloadUrl
      .replace('{accountId}', encodeURIComponent(s.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'file'))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
  }

  async download(blobId: string, name: string, type: string): Promise<Response> {
    await this.ensureSession();
    const res = await fetch(this.downloadUrl(blobId, name, type), {
      headers: this.headers(),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new JmapError('download', `Blob download failed with HTTP ${res.status}`, res.status);
    return res;
  }

  // Server-sent events push. Resolves when the connection closes; the caller
  // owns reconnection. Node's fetch keeps the Authorization header, which a
  // browser EventSource cannot do, so push lives on the server.
  async eventSource(onEvent: (ev: { type: string; data: any }) => void, signal: AbortSignal): Promise<void> {
    const s = await this.ensureSession();
    if (!s.eventSourceUrl) throw new JmapError('no-push', 'Server has no eventSourceUrl');
    const url = s.eventSourceUrl.replace('{types}', '*').replace('{closeafter}', 'no').replace('{ping}', '30');
    const res = await fetch(url, { headers: this.headers({ Accept: 'text/event-stream' }), signal });
    if (!res.ok || !res.body) throw new JmapError('push', `Event source failed with HTTP ${res.status}`, res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = 'message';
    let dataLines: string[] = [];
    const flush = () => {
      if (dataLines.length) {
        const raw = dataLines.join('\n');
        let data: any = raw;
        try { data = JSON.parse(raw); } catch { /* keep raw */ }
        onEvent({ type: eventType, data });
      }
      eventType = 'message';
      dataLines = [];
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') { flush(); continue; }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') eventType = val;
        else if (field === 'data') dataLines.push(val);
      }
    }
    flush();
  }
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 2000); } catch { return ''; }
}

export function basicAuth(user: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${user}:${secret}`, 'utf8').toString('base64');
}
export function bearerAuth(token: string): string {
  return 'Bearer ' + token;
}

export function jmapErrorMessage(e: unknown): string {
  if (e instanceof JmapError) return e.message;
  if (e instanceof Error) {
    if ((e as any).cause?.code) return `${e.message} (${(e as any).cause.code})`;
    return e.message;
  }
  return String(e);
}

export { log as jmapLog };
