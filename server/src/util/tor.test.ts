// Tor routing for the model server.
//
// The failure being guarded against is silent: with the proxy dropped the
// request still succeeds and the answer still comes back, it just went out
// directly. Nothing in the response says which way it travelled — so a stub
// SOCKS5 proxy stands in for Tor and records what it was asked to connect to.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';

process.env.TOR_SOCKS_HOST = '127.0.0.1';

const connects: string[] = [];
const socks = net.createServer((client) => {
  let stage = 0;
  client.on('data', (chunk: Buffer) => {
    if (stage === 0) { client.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
    if (stage !== 1) return;
    const atyp = chunk[3];
    let host: string; let off: number;
    if (atyp === 0x03) { const len = chunk[4]!; host = chunk.slice(5, 5 + len).toString(); off = 5 + len; }
    else if (atyp === 0x01) { host = Array.from(chunk.slice(4, 8)).join('.'); off = 8; }
    else { client.end(); return; }
    const port = chunk.readUInt16BE(off);
    connects.push(`${host}:${port}`);
    const up = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.pipe(up); up.pipe(client);
    });
    up.on('error', () => client.end());
    stage = 2;
  });
  client.on('error', () => {});
});

const hits: string[] = [];
const model = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    hits.push(req.url!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

await new Promise<void>((r) => socks.listen(0, '127.0.0.1', () => r()));
await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
process.env.TOR_SOCKS_PORT = String((socks.address() as net.AddressInfo).port);
const modelPort = (model.address() as net.AddressInfo).port;
const base = `http://127.0.0.1:${modelPort}`;

const { outboundFetch } = await import('./outbound.js');
const { explainTorError, torProxyAddress, torTimeoutMs, TOR_MIN_TIMEOUT_MS } = await import('./tor.js');
const { transportFor, aiDefaults, llmEndpoint, embedEndpoint } = await import('../ai/llm.js');
const { transportFor: endpointTransport } = await import('../ai/endpoint.js');
const { voiceDefaults, sttEndpoint } = await import('../services/voice.js');

test.after(() => { socks.close(); model.close(); });

test('the toggle is opt-in: a fresh install routes nothing through Tor', () => {
  assert.equal(aiDefaults().useTor, false);
  assert.equal(transportFor({ ...aiDefaults(), useTor: false }).agent, undefined);
  assert.ok(transportFor({ ...aiDefaults(), useTor: true }).agent, 'the toggle built no agent');
});

test('every model path goes through the proxy when the toggle is on', async () => {
  // One transport decision serves all three providers, so this asserts the
  // paths each of them actually calls. A provider added later that builds its
  // own request would answer correctly and travel directly.
  for (const path of ['/api/chat', '/v1/chat/completions', '/v1/messages', '/api/embed']) {
    connects.length = 0; hits.length = 0;
    const res = await outboundFetch(`${base}${path}`, { method: 'POST', body: '{}' },
      transportFor({ ...aiDefaults(), useTor: true }));
    await res.text();
    assert.equal(hits[0], path);
    assert.ok(connects.length > 0, `${path} did NOT go through the Tor proxy`);
  }
});

test('with the toggle off the proxy is never contacted', async () => {
  connects.length = 0; hits.length = 0;
  const res = await outboundFetch(`${base}/api/chat`, { method: 'POST', body: '{}' },
    transportFor({ ...aiDefaults(), useTor: false }));
  await res.text();
  assert.equal(hits[0], '/api/chat');
  assert.equal(connects.length, 0, 'a request went through Tor with the setting off');
});

test('the proxy survives onto plain http, which is what an .onion address is', async () => {
  // The bug this pins: `requestWithTls` passed its options only for https, so
  // an http URL silently lost the agent and went out directly. Every .onion
  // model server is plain http, so that is exactly the case Tor exists for.
  connects.length = 0;
  const res = await outboundFetch(`${base}/api/chat`, { method: 'POST', body: '{}' },
    transportFor({ ...aiDefaults(), useTor: true }));
  await res.text();
  assert.ok(connects.length > 0, 'the agent was dropped on an http URL');
});

test('a refused proxy is explained as a proxy, and anything else is left alone', () => {
  // "connection refused" on its own sends somebody to check whether Tor is
  // running when it plainly is — the usual cause is the C daemon on 9050
  // against this default of 9150.
  const refused = explainTorError(new Error('connect ECONNREFUSED 127.0.0.1:9150'));
  assert.ok(refused && refused.includes(torProxyAddress()));

  // Null, not a guess: a model server refusing an API key is not a Tor
  // problem, and outbound.ts explains that far better than tor.ts could.
  assert.equal(explainTorError(new Error('HTTP 401 unauthorized')), null);
});

test('a Tor timeout floor is applied, because a circuit is slower than a socket', () => {
  // socks-proxy-agent otherwise caps at 30s, which is inside the normal range
  // for an onion rendezvous — so a working server reads as unreachable.
  assert.equal(torTimeoutMs(undefined), TOR_MIN_TIMEOUT_MS);
  assert.equal(torTimeoutMs(5_000), TOR_MIN_TIMEOUT_MS);
  assert.equal(torTimeoutMs(TOR_MIN_TIMEOUT_MS + 1_000), TOR_MIN_TIMEOUT_MS + 1_000);
});


// ── One connection per kind of model ───────────────────────────────────────
//
// The regression these guard is the one that motivated splitting them: the
// transcriber used plain `fetch`, so it honoured neither the certificate rule
// nor any proxy, and the embedder silently borrowed both from the drafting
// model. Neither was decided; it is what separately written call sites
// converge on.

test('each kind of model carries its own proxy decision', () => {
  const ai = { ...aiDefaults(), useTor: true, embedProvider: 'ollama' as const, embedBaseUrl: 'http://ollama:11434', embedUseTor: false };
  assert.ok(endpointTransport(llmEndpoint(ai)).agent, 'the language model lost its proxy');
  assert.equal(endpointTransport(embedEndpoint(ai)).agent, undefined,
    'the embedder was dragged through Tor by the language model');

  // And the other way, which was equally impossible before.
  const flipped = { ...ai, useTor: false, embedUseTor: true };
  assert.equal(endpointTransport(llmEndpoint(flipped)).agent, undefined);
  assert.ok(endpointTransport(embedEndpoint(flipped)).agent, 'the embedder could not use Tor on its own');
});

test('the transcriber has a connection of its own, not the language model\'s', () => {
  // It had an address and a key and nothing else — no shape, no certificate
  // rule, no proxy — so an admin who ticked "trust this certificate" on the AI
  // page found drafting worked and dictation did not.
  const quiet = sttEndpoint({ ...voiceDefaults(), useTor: false, tlsInsecure: false });
  assert.equal(endpointTransport(quiet).agent, undefined);
  assert.equal(endpointTransport(quiet).insecure, false);

  const hidden = sttEndpoint({ ...voiceDefaults(), useTor: true, tlsInsecure: true });
  assert.ok(endpointTransport(hidden).agent, 'the transcriber cannot be routed through Tor');
  assert.equal(endpointTransport(hidden).insecure, true);

  // It is a separate settings row entirely, so no value of the AI settings can
  // reach it. That is the property, not an implementation detail.
  assert.equal(sttEndpoint(voiceDefaults()).id, 'stt');
  assert.equal(sttEndpoint(voiceDefaults()).inheritedFrom, null);
});

test('an endpoint set to inherit takes the whole connection, not just the address', () => {
  // Copying the URL and leaving the proxy behind is the bug in miniature.
  const ai = { ...aiDefaults(), baseUrl: 'https://gpu.example:11434', apiKey: 'llm-key', useTor: true, tlsInsecure: true, embedProvider: 'same' as const };
  const e = embedEndpoint(ai);
  assert.equal(e.inheritedFrom, 'llm');
  assert.equal(e.baseUrl, 'https://gpu.example:11434');
  assert.equal(e.apiKey, 'llm-key');
  assert.equal(e.useTor, true);
  assert.equal(e.tlsInsecure, true);
});

test('each endpoint keeps its own credential', () => {
  // A key belongs to one machine. Handing the drafting model's key to a
  // transcriber somebody else runs would be a disclosure, not a convenience.
  const ai = { ...aiDefaults(), apiKey: 'llm-key', embedProvider: 'openai' as const, embedBaseUrl: 'https://embed.example', embedApiKey: 'embed-key' };
  assert.equal(llmEndpoint(ai).apiKey, 'llm-key');
  assert.equal(embedEndpoint(ai).apiKey, 'embed-key');
  assert.equal(sttEndpoint({ ...voiceDefaults(), apiKey: 'stt-key' }).apiKey, 'stt-key');
});

test('the old settings-shaped transport still means the language model', () => {
  // `transportFor(settings)` is kept for the callers that legitimately hold
  // the whole settings object. It must resolve to the language model's
  // connection and nothing else, or a caller that looks unchanged silently
  // starts using the wrong one.
  // Compared by shape rather than by value: each call builds a fresh agent
  // object, so deep equality would fail on two correct results.
  for (const ai of [
    { ...aiDefaults(), useTor: true, tlsInsecure: true },
    { ...aiDefaults(), useTor: false, tlsInsecure: false },
  ]) {
    const viaSettings = transportFor(ai);
    const viaEndpoint = endpointTransport(llmEndpoint(ai));
    assert.equal(viaSettings.insecure, viaEndpoint.insecure);
    assert.equal(Boolean(viaSettings.agent), Boolean(viaEndpoint.agent));
    assert.equal(Boolean(viaSettings.agent), ai.useTor);
  }
});
