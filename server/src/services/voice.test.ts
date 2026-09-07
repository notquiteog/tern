import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, forgetVoiceCapabilities, listVoiceModels, validVoiceModelId, voiceCapabilities, voiceDefaults, voiceHealth, voiceModelView, acceptableType, type VoiceSettings } from './voice.js';

const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...voiceDefaults(), enabled: true, baseUrl: 'http://whisper:8080', ...over });

// Stands in for the transcriber. Returns whatever the table says for the
// path being asked about, and records what it was sent.
function stubFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method ?? 'GET').toUpperCase();
    seen.push({ url, method, headers: { ...(init.headers ?? {}) } });
    // A route may be keyed by path or by "METHOD path", so a test can say
    // that DELETE is answered differently from GET on the same path.
    const path = new URL(url).pathname;
    const hit = routes[`${method} ${path}`] ?? routes[path] ?? { status: 404 };
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


// ---------- What the transcriber can do ----------
//
// Everything below exists because "an OpenAI-shaped transcriber" is not one
// thing. The card used to offer the same free-text model box to a whisper.cpp
// that has exactly one model and to a speaches that has forty, and neither
// was well served by it.

test('a transcriber with no model list is reachable and manages nothing', async () => {
  forgetVoiceCapabilities();
  const f = stubFetch({ '/v1/models': { status: 404 }, '/': { status: 200 } });
  try {
    const caps = await voiceCapabilities(settings());
    assert.equal(caps.ok, true);
    assert.equal(caps.lists, false);
    assert.equal(caps.manages, false);
    assert.equal(caps.kind, 'whisper.cpp');
  } finally { f.restore(); forgetVoiceCapabilities(); }
});

test('a registry is what marks a transcriber as one that can download', async () => {
  forgetVoiceCapabilities();
  const f = stubFetch({
    '/v1/models': { status: 200, body: { data: [{ id: 'Systran/faster-whisper-small' }] } },
    '/v1/registry': { status: 200, body: { data: [] } },
  });
  try {
    const caps = await voiceCapabilities(settings());
    assert.equal(caps.lists, true);
    assert.equal(caps.manages, true);
    assert.equal(caps.kind, 'speaches');
  } finally { f.restore(); forgetVoiceCapabilities(); }
});

test('a transcriber that lists but has no registry is not offered downloads', async () => {
  forgetVoiceCapabilities();
  const f = stubFetch({ '/v1/models': { status: 200, body: { data: [{ id: 'whisper-1' }] } } });
  try {
    const caps = await voiceCapabilities(settings());
    assert.equal(caps.lists, true);
    assert.equal(caps.registry, false);
    assert.equal(caps.manages, false);
    assert.equal(caps.kind, 'openai-shaped');
  } finally { f.restore(); forgetVoiceCapabilities(); }
});

test('only speech models are listed: a server that also does text to speech lists both', async () => {
  const f = stubFetch({
    '/v1/models': { status: 200, body: { data: [
      { id: 'Systran/faster-whisper-small', task: 'automatic-speech-recognition' },
      { id: 'speaches-ai/Kokoro-82M', task: 'text-to-speech' },
    ] } },
  });
  try {
    const models = await listVoiceModels(settings());
    assert.deepEqual(models.map((m) => m.id), ['Systran/faster-whisper-small']);
  } finally { f.restore(); }
});

test('the registry drops what is already downloaded, so nothing is offered twice', async () => {
  forgetVoiceCapabilities();
  const f = stubFetch({
    '/v1/models': { status: 200, body: { data: [{ id: 'Systran/faster-whisper-small' }] } },
    '/v1/registry': { status: 200, body: { data: [{ id: 'Systran/faster-whisper-small' }, { id: 'Systran/faster-whisper-medium' }] } },
  });
  try {
    const view = await voiceModelView(settings());
    assert.deepEqual(view.installed.map((m) => m.id), ['Systran/faster-whisper-small']);
    assert.deepEqual(view.available.map((m) => m.id), ['Systran/faster-whisper-medium']);
  } finally { f.restore(); forgetVoiceCapabilities(); }
});

test('an unreachable transcriber reports why rather than an empty list', async () => {
  forgetVoiceCapabilities();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as any;
  try {
    const view = await voiceModelView(settings());
    assert.equal(view.installed.length, 0);
    assert.match(view.error ?? '', /ECONNREFUSED/);
    assert.equal(view.capabilities.ok, false);
  } finally { globalThis.fetch = original; forgetVoiceCapabilities(); }
});

// A model id becomes part of a URL path, so it is checked before it gets
// there rather than trusted because an admin typed it.
test('a model id has to look like a repository path', () => {
  for (const ok of ['whisper-1', 'Systran/faster-whisper-large-v3', 'deepdml/faster-whisper-large-v3-turbo-ct2']) {
    assert.equal(validVoiceModelId(ok), true, ok);
  }
  for (const bad of ['', '../etc/passwd', 'a/b/c/d/e', 'has space', 'x?y=1', '/leading']) {
    assert.equal(validVoiceModelId(bad), false, bad);
  }
});
