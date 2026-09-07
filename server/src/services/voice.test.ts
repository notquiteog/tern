import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, voiceDefaults, voiceHealth, acceptableType, type VoiceSettings } from './voice.js';

const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...voiceDefaults(), enabled: true, baseUrl: 'http://whisper:8080', ...over });

// Stands in for the transcriber. Returns whatever the table says for the
// path being asked about, and records what it was sent.
function stubFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    seen.push({ url, headers: { ...(init.headers ?? {}) } });
    const path = new URL(url).pathname;
    const hit = routes[path] ?? { status: 404 };
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body,
      text: async () => JSON.stringify(hit.body ?? ''),
    } as any;
  }) as any;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test('an OpenAI-shaped transcriber is reachable and names its models', async () => {
  const f = stubFetch({ '/v1/models': { status: 200, body: { data: [{ id: 'Systran/faster-whisper-small' }] } } });
  try {
    const h = await voiceHealth(settings());
    assert.equal(h.ok, true);
    assert.deepEqual(h.models, ['Systran/faster-whisper-small']);
  } finally { f.restore(); }
});

// whisper.cpp's own server has no /v1/models: it serves / and /inference.
// A 404 there followed by a live root is a working transcriber, not a
// missing one, and treating it as missing is what would hide the bundled
// container behind a red badge.
test('a whisper.cpp server with no model list still counts as reachable', async () => {
  const f = stubFetch({ '/v1/models': { status: 404 }, '/': { status: 200 } });
  try {
    assert.equal((await voiceHealth(settings())).ok, true);
  } finally { f.restore(); }
});

test('a refused key is reported as a refused key, not as an unreachable server', async () => {
  const f = stubFetch({ '/v1/models': { status: 401 } });
  try {
    const h = await voiceHealth(settings({ apiKey: 'wrong' }));
    assert.equal(h.ok, false);
    assert.match(h.error ?? '', /API key/i);
  } finally { f.restore(); }
});

test('a stored key is sent to the transcriber, and nothing is sent when there is none', async () => {
  const withKey = stubFetch({ '/v1/models': { status: 200, body: { data: [] } } });
  try {
    await voiceHealth(settings({ apiKey: 'sk-secret' }));
    assert.equal((withKey.seen[0].headers as any).Authorization, 'Bearer sk-secret');
  } finally { withKey.restore(); }

  const without = stubFetch({ '/v1/models': { status: 200, body: { data: [] } } });
  try {
    await voiceHealth(settings());
    assert.equal('Authorization' in (without.seen[0].headers as any), false);
  } finally { without.restore(); }
});

test('an unset address is a clear message rather than a fetch of nothing', async () => {
  const h = await voiceHealth(settings({ baseUrl: '' }));
  assert.equal(h.ok, false);
  assert.match(h.error ?? '', /address/i);
});

test('non-speech markers and the silence hallucinations are dropped', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' Thanks for watching! '), '');
  assert.equal(cleanTranscript('(music) Send it on Tuesday.'), 'Send it on Tuesday.');
  assert.equal(cleanTranscript('Tell them  we  agreed.'), 'Tell them we agreed.');
});

test('only audio the server reads is accepted', () => {
  assert.equal(acceptableType('audio/webm;codecs=opus'), true);
  assert.equal(acceptableType('application/json'), false);
});
