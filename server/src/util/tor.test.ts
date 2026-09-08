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
const { transportFor, aiDefaults } = await import('../ai/llm.js');

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
