// Neither voice key leaves the server. There are two — the transcriber's and
// the voice's own, for a voice on a server of its own — and the routes used to
// strip only the one called `apiKey`, so the other went to the admin page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { voiceDefaults, voiceSettingsView } from './voice.js';

test('the settings view carries whether each key is set, never the key', () => {
  const view = voiceSettingsView({
    ...voiceDefaults(),
    baseUrl: 'http://whisper:8080',
    apiKey: 'transcriber-secret',
    speech: true,
    speechProvider: 'openai',
    speechBaseUrl: 'https://voice.example',
    speechApiKey: 'voice-secret',
  });
  assert.ok(!('apiKey' in view), 'the transcriber key was in the view');
  assert.ok(!('speechApiKey' in view), 'the voice key was in the view');
  assert.ok(!JSON.stringify(view).includes('secret'));
  assert.equal(view.hasApiKey, true);
  assert.equal(view.hasSpeechApiKey, true);
  // Everything that is not a credential is still there for the form.
  assert.equal(view.speechBaseUrl, 'https://voice.example');
  assert.equal(view.speechProvider, 'openai');

  const none = voiceSettingsView(voiceDefaults());
  assert.equal(none.hasApiKey, false);
  assert.equal(none.hasSpeechApiKey, false);
});

test('GET and PUT /api/ai/voice answer with that view and nothing else', () => {
  // The routes need a database to run, so this reads them instead: each
  // handler has to build `settings` from the view and must not spread a
  // settings object of its own, which is how the second key got out.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const routes = fs.readFileSync(path.join(here, '../routes/ai.ts'), 'utf8');
  for (const method of ['get', 'put']) {
    const handler = new RegExp(`aiRouter\\.${method}\\('/voice',[\\s\\S]*?\\n}\\);`).exec(routes)?.[0];
    assert.ok(handler, `no ${method.toUpperCase()} /voice handler found`);
    assert.match(handler, /settings: voiceSettingsView\((v|next)\)/);
    assert.doesNotMatch(handler, /\.\.\.safe\b/);
  }
});
