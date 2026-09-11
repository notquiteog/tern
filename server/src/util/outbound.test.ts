// The three things that broke every attempt to point Tern at a model server
// somewhere else: a trailing slash on the address, a certificate nobody can
// verify, and an error message that said "fetch failed" about all of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { apiUrl, explainOutboundError, normalizeBaseUrl, outboundFetch, requestWithTls } from './outbound.js';

test('a base URL that already names its version is not given a second one', () => {
  // The documented SDK base of every hosted OpenAI-compatible API carries the
  // version, and every call here is spelled from the root. Joined as strings
  // that was `/api/v1/v1/chat/completions` — a 404 on OpenRouter, and on every
  // other preset that ends in a version.
  assert.equal(apiUrl('https://openrouter.ai/api/v1', '/v1/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(apiUrl('https://openrouter.ai/api/v1/', '/v1/models'), 'https://openrouter.ai/api/v1/models');
  assert.equal(apiUrl('https://api.groq.com/openai/v1', '/v1/audio/transcriptions'), 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(apiUrl('https://generativelanguage.googleapis.com/v1beta/openai', '/v1/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(apiUrl('https://api.anthropic.com/v1', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(apiUrl('https://openrouter.ai/api/v1', `/v1/videos/${encodeURIComponent('a b')}/content`), 'https://openrouter.ai/api/v1/videos/a%20b/content');
});

test('a bare origin, or a proxy under a path that is not a version, is joined as it always was', () => {
  assert.equal(apiUrl('http://127.0.0.1:11434', '/v1/chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(apiUrl('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(apiUrl('https://gpu.example.com/ollama', '/v1/embeddings'), 'https://gpu.example.com/ollama/v1/embeddings');
  // `/v10` and `/v1beta` are versions; `/video` and `/vllm` are not.
  assert.equal(apiUrl('https://gpu.example.com/vllm', '/v1/models'), 'https://gpu.example.com/vllm/v1/models');
  // Paths that are not versioned API paths are never touched.
  assert.equal(apiUrl('https://openrouter.ai/api/v1', '/inference'), 'https://openrouter.ai/api/v1/inference');
  assert.equal(apiUrl('http://127.0.0.1:11434', '/api/chat'), 'http://127.0.0.1:11434/api/chat');
  assert.equal(apiUrl('', '/v1/models'), '/v1/models');
});

test('a trailing slash is taken off, because every call appends a path to this', () => {
  // `${baseUrl}/api/chat` with a stored slash is `//api/chat`, which Ollama
  // answers 404 to — health, tags and chat alike, so the page says "not
  // reachable" about a server that is running.
  assert.equal(normalizeBaseUrl('http://ollama:11434/'), 'http://ollama:11434');
  assert.equal(normalizeBaseUrl('https://203.0.113.10:40123///'), 'https://203.0.113.10:40123');
  assert.equal(normalizeBaseUrl('  https://gpu.example.com:8443/  '), 'https://gpu.example.com:8443');
});

test('an address with no slash to remove is left exactly as it was', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(undefined as any), '');
});

test('a certificate nobody can vouch for is named as such, and says what to do', () => {
  for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    const msg = explainOutboundError(Object.assign(new Error('fetch failed'), { cause: { code } }), 'https://203.0.113.10:40123/api/version');
    assert.match(msg, /certificate/i, code);
    assert.match(msg, /Trust this server's certificate/, code);
    assert.match(msg, /203\.0\.113\.10:40123/, code);
    assert.doesNotMatch(msg, /fetch failed/, code);
  }
});

test('the other ways a remote address goes wrong each get their own fix', () => {
  const at = (code: string) => explainOutboundError(Object.assign(new Error('fetch failed'), { cause: { code } }), 'https://gpu.example.com:8443');
  assert.match(at('ENOTFOUND'), /looked up|hostname/i);
  assert.match(at('ECONNREFUSED'), /port/i);
  assert.match(at('ETIMEDOUT'), /timed out|firewall/i);
  assert.match(at('CERT_HAS_EXPIRED'), /expired/i);
  assert.match(at('ERR_TLS_CERT_ALTNAME_INVALID'), /not made out to that address/i);
  // An https address pointed at a plain-http port, which is the other half of
  // "I pasted what the host gave me and it does not work". Node spells this
  // one at least three ways depending on where it fails.
  for (const code of ['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG']) {
    assert.match(at(code), /TLS handshake/i, code);
    assert.match(at(code), /try http instead/i, code);
  }
});

test('an OpenSSL wall of text is not what the admin is shown', () => {
  // The real thing, from an https address pointed at a plain-http port:
  // `C0AC:error:0A00010B:SSL routines:tls_validate_record_header:wrong
  // version number:../deps/openssl/openssl/ssl/record/methods/...`
  const raw = 'C0AC0A9A36740000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:../deps/openssl/openssl/ssl/record/methods/tlsany_meth.c:77:\n';
  const msg = explainOutboundError(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error(raw), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }) }), 'https://127.0.0.1:11434');
  assert.match(msg, /try http instead/i);
  assert.doesNotMatch(msg, /openssl|SSL routines/i);
});

test('an error with nothing recognisable still says something, and says where', () => {
  const msg = explainOutboundError(new Error('socket hang up'), 'https://gpu.example.com:8443/api/tags');
  assert.match(msg, /socket hang up/);
  assert.match(msg, /gpu\.example\.com:8443/);
  // The origin, not the path: the path is Tern's, not the admin's.
  assert.doesNotMatch(msg, /api\/tags/);
});

test('a timeout is reported as one rather than as an abort', () => {
  assert.match(explainOutboundError(Object.assign(new Error('x'), { name: 'TimeoutError' })), /did not answer in time/);
});

// The trusting path is a hand-rolled request rather than the platform fetch,
// so it has to behave like fetch in every way llm.ts uses it: status, ok,
// json(), text(), and a body read a chunk at a time. Called directly rather
// than through `outboundFetch`, which only reaches it for https — testing it
// through the front door would mean shipping a certificate to test with.
test('the trusting path answers like fetch does, streaming included', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"version":"0.12.0"}'); return; }
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"message":{"content":"one"}}\n');
      res.end('{"message":{"content":"two"},"done":true}\n');
      return;
    }
    res.writeHead(404); res.end('404 page not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const v = await requestWithTls(`${base}/api/version`, {});
    assert.equal(v.ok, true);
    assert.equal(v.status, 200);
    assert.deepEqual(await v.json(), { version: '0.12.0' });

    const missing = await requestWithTls(`${base}/nope`, {});
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    // Read twice: the error paths in llm.ts call text() on a body an earlier
    // branch may already have taken, and that must not hang.
    assert.match(await missing.text(), /404/);
    assert.match(await missing.text(), /404/);

    const chat = await requestWithTls(`${base}/api/chat`, { method: 'POST', body: '{}' });
    const reader = chat.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const lines: any[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) lines.push(JSON.parse(line));
      }
    }
    assert.deepEqual(lines.map((l) => l.message.content), ['one', 'two']);
  } finally {
    server.close();
  }
});

test('an already-aborted signal is refused rather than sent', async () => {
  await assert.rejects(
    requestWithTls('http://127.0.0.1:1/api/version', { signal: AbortSignal.abort() }),
    (e: any) => e.name === 'AbortError',
  );
});

test('an http address keeps the platform path, trust setting or not', async () => {
  // There is no certificate to relax on http, so turning the setting on must
  // not quietly move an install onto the hand-rolled request.
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"version":"0.12.0"}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const res = await outboundFetch(`${base}/api/version`, {}, { insecure: true });
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), { version: '0.12.0' });
    // The platform's Response, which is how we know which path it took.
    assert.equal(res instanceof Response, true);
  } finally {
    server.close();
  }
});

test('a body is measured rather than sent chunked', async () => {
  // A proxy in front of a hosted model server is happier with a length than
  // with a chunked POST, and Ollama itself does not care either way.
  let seen: Record<string, string | undefined> = {};
  const server = http.createServer((req, res) => {
    seen = { len: req.headers['content-length'], te: req.headers['transfer-encoding'] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const body = JSON.stringify({ model: 'qwen3.5:4b', messages: [] });
    await requestWithTls(`${base}/api/chat`, { method: 'POST', body });
    assert.equal(seen.len, String(Buffer.byteLength(body)));
    assert.equal(seen.te, undefined);
  } finally {
    server.close();
  }
});
