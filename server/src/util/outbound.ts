// Talking to somebody else's server: how the address is spelled, whether its
// certificate is trusted, and what to say when the call fails.
//
// All three exist because of remote model servers. Tern's own Ollama is
// reached over the compose network on plain http and none of this matters
// there, but the moment an admin points the assistant at a box on the
// internet — a rented GPU, an Ollama behind Caddy — every one of them does:
// the URL arrives with a trailing slash from a copy button, the certificate
// is self-signed because the host generated it at boot, and Node reports the
// lot as `fetch failed`.
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { Readable } from 'node:stream';

// `${baseUrl}/api/chat` is how every call is built, so a stored trailing
// slash becomes `//api/chat` and Ollama answers 404 to all of it — health,
// tags, chat — leaving the page saying "not reachable" about a server that
// is running perfectly. Whitespace goes too: pasted URLs bring it.
export function normalizeBaseUrl(raw: string): string {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

// Whether to require a certificate this machine can verify. Off is a real
// choice an admin gets to make — a rented GPU host issues itself a
// certificate at boot and there is no authority that will vouch for it — but
// it is theirs to make knowingly, so it is stored per install, defaults to
// on, and the page says what it costs. It is never inferred from a failure.
export interface TlsTrust {
  insecure?: boolean;
  /**
   * A proxy agent, when this install routes model traffic through Tor.
   *
   * Typed loosely on purpose: this module is about transport mechanics and has
   * no business importing the SOCKS library, which is only ever constructed by
   * util/tor.ts. What matters here is that its presence forces the node path,
   * because the platform's `fetch` cannot be given one.
   */
  agent?: http.Agent | https.Agent;
}

export interface OutboundResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<any>;
}

// A fetch-shaped call that can carry TLS options. The verified path is the
// platform's own `fetch`; only an install that has turned verification off
// takes the second one, which exists because `fetch` has no way to pass
// `rejectUnauthorized` without pulling in undici as a dependency.
export function outboundFetch(url: string, init: RequestInit = {}, trust: TlsTrust = {}): Promise<OutboundResponse> {
  const isHttps = /^https:/i.test(url);
  // An agent forces the node path whatever the scheme, because `fetch` has no
  // way to be given one — and unlike the certificate setting, a proxy is not
  // meaningless over http. Getting this wrong is silent: the request succeeds,
  // it simply goes out directly instead of through Tor, which is the one
  // outcome the setting exists to prevent.
  if (trust.agent) {
    return requestWithTls(url, init, {
      agent: trust.agent,
      ...(isHttps && trust.insecure ? { rejectUnauthorized: false } : {}),
    });
  }
  // http has no certificate to relax, so the setting is meaningless there and
  // the platform path — pooled, redirect-following, well-tested — is kept.
  if (!trust.insecure || !isHttps) return fetch(url, init) as unknown as Promise<OutboundResponse>;
  return requestWithTls(url, init, { rejectUnauthorized: false });
}

// The fallback path on its own. Exported for tests: `outboundFetch` only
// reaches it for https, and a test would otherwise need a certificate to
// exercise the part of this file that is not the platform's.
export function requestWithTls(url: string, init: RequestInit, tlsOpts: https.RequestOptions = {}): Promise<OutboundResponse> {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const mod = secure ? https : http;
  // Everything llm.ts sends is a JSON string. Measuring it means a plain
  // request with a Content-Length rather than a chunked one, which is what
  // the proxy in front of a hosted model server expects to see.
  const body = typeof init.body === 'string' ? init.body : init.body == null ? null : String(init.body);
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: init.method ?? 'GET',
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        ...(body === null ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
      },
      // TLS options only mean anything over https, but the AGENT means
      // something over both — and an .onion model server is almost always
      // plain http, which is exactly the case Tor routing exists for. Passing
      // only `tlsOpts` here dropped the proxy for every http URL and sent the
      // request out directly, succeeding, with nothing to show it had.
      ...(secure ? tlsOpts : (tlsOpts.agent ? { agent: tlsOpts.agent } : {})),
    }, (res) => {
      // The streaming callers read `body.getReader()` a chunk at a time and
      // the rest read the whole thing; both are served from one stream, and
      // the text is memoised so a caller that reads it twice — an error path
      // reading a body an earlier branch already took — does not hang.
      const web = Readable.toWeb(res) as ReadableStream<Uint8Array>;
      let consumed: Promise<string> | null = null;
      const all = () => (consumed ??= new Response(web as any).text());
      const status = res.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: web,
        text: all,
        json: async () => JSON.parse(await all()),
      });
    });
    req.on('error', reject);
    const signal = init.signal as AbortSignal | undefined;
    if (signal) {
      if (signal.aborted) { req.destroy(abortError()); return; }
      signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
    }
    if (body !== null) req.write(body);
    req.end();
  });
}

function abortError(): Error {
  const e = new Error('This request was cancelled');
  e.name = 'AbortError';
  return e;
}

// What actually went wrong, in words an admin can act on.
//
// Node reports every one of these as `fetch failed` and hides the reason in
// `cause.code`, so the admin page used to show "fetch failed" for a bad
// hostname, a closed port, a self-signed certificate and a timeout alike —
// four different fixes behind one useless sentence.
export function explainOutboundError(err: unknown, url?: string): string {
  const e = err as any;
  const code = String(e?.cause?.code ?? e?.code ?? '');
  const msg = String(e?.cause?.message ?? e?.message ?? 'the request failed');
  const where = url ? ` (${safeOrigin(url)})` : '';
  switch (code) {
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `That server${where} presented a certificate this machine cannot verify — normally a self-signed one, which is what a rented GPU host or an Ollama behind its own proxy issues itself. Turn on "Trust this server's certificate" to connect anyway.`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `That server's certificate${where} is not made out to that address. Use the hostname the certificate names, or turn on "Trust this server's certificate".`;
    case 'CERT_HAS_EXPIRED':
      return `That server's certificate${where} has expired. Renew it, or turn on "Trust this server's certificate".`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `That address${where} could not be looked up. Check the hostname.`;
    case 'ECONNREFUSED':
      return `Nothing answered${where}. Check the port, and that the server is running and reachable from here.`;
    case 'ECONNRESET':
      return `The connection${where} was closed before an answer came back. If the address is https, check the server is not plain http on that port.`;
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'ERR_SSL_PACKET_LENGTH_TOO_LONG':
      return wrongScheme(where);
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `The connection${where} timed out. A firewall between here and there is the usual cause.`;
    default:
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return `That server${where} did not answer in time.`;
      // OpenSSL's own failures arrive as a wall of `error:0A00010B:SSL
      // routines:...:../deps/openssl/...`, which is a stack trace from a
      // library the admin did not know they were using. Every one of them
      // that reaches here means the handshake did not happen, and the reason
      // it did not is almost always the scheme.
      if (code.startsWith('ERR_SSL_') || /SSL routines/.test(msg)) return wrongScheme(where);
      return `${msg}${where}`;
  }
}

function wrongScheme(where: string): string {
  return `That address${where} did not complete a TLS handshake. An https address pointed at a plain-http port is the usual cause: try http instead, or check the port.`;
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

// What certificate an address is actually presenting, so the page can show
// the admin what they are being asked to trust before they turn verification
// off, rather than after. Deliberately does not verify: the whole point is to
// look at a certificate that would not pass.
export interface CertInfo { subject: string; issuer: string; fingerprint: string; validTo: string; selfSigned: boolean }

export function inspectCertificate(url: string, timeoutMs = 6000): Promise<CertInfo | null> {
  let u: URL;
  try { u = new URL(url); } catch { return Promise.resolve(null); }
  if (u.protocol !== 'https:') return Promise.resolve(null);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const done = (v: CertInfo | null) => { clearTimeout(timer); try { socket.destroy(); } catch { /* already gone */ } resolve(v); };
    const socket = tls.connect({
      host,
      port: Number(u.port || 443),
      rejectUnauthorized: false,
      // An IP is not a valid SNI value and Node warns about sending one.
      ...(require_isIP(host) ? {} : { servername: host }),
    }, () => {
      const c = socket.getPeerCertificate();
      if (!c || !c.subject) return done(null);
      done({
        subject: String(c.subject.CN ?? Object.values(c.subject).join(', ')),
        issuer: String(c.issuer?.CN ?? Object.values(c.issuer ?? {}).join(', ')),
        fingerprint: String(c.fingerprint256 ?? ''),
        validTo: String(c.valid_to ?? ''),
        selfSigned: JSON.stringify(c.subject) === JSON.stringify(c.issuer),
      });
    });
    socket.on('error', () => done(null));
    const timer = setTimeout(() => done(null), timeoutMs);
  });
}

function require_isIP(host: string): boolean {
  // Cheap enough to keep local rather than importing net for one call.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}
