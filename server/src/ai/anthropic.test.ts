// The Anthropic request shape.
//
// This is the provider with no version of itself that runs on a developer's
// machine: there is no local Messages API to point at, so a wrong body is not
// found until a real key is in a real install's settings and every draft is a
// 400. Each case below names the refusal it prevents — and they are refusals
// rather than degradations, so getting one wrong does not make drafting worse,
// it makes drafting unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicTakesSampling, embedEndpoint, toAnthropicMessages, aiDefaults, type AiSettings } from './llm.js';

test('the system prompt is lifted out of the message list', () => {
  // Ollama and the OpenAI shape both take `{ role: 'system' }` as the first
  // message. The Messages API rejects that role and wants a top-level field,
  // and Tern builds its prompts as message lists, so the lifting is here.
  const out = toAnthropicMessages([
    { role: 'system', content: 'You write email.' },
    { role: 'user', content: 'Draft a reply.' },
  ]);
  assert.equal(out.system, 'You write email.');
  assert.deepEqual(out.messages, [{ role: 'user', content: 'Draft a reply.' }]);
  assert.ok(!out.messages.some((m) => (m.role as string) === 'system'), 'a system role reached the message list');
});

test('several system messages are joined rather than the last one winning', () => {
  // A dropped instruction produces a model that mostly behaves, which is much
  // harder to notice than one that plainly does not.
  const out = toAnthropicMessages([
    { role: 'system', content: 'One.' },
    { role: 'system', content: 'Two.' },
    { role: 'user', content: 'Hi' },
  ]);
  assert.equal(out.system, 'One.\n\nTwo.');
});

test('an assistant turn keeps its role and everything else becomes a user turn', () => {
  const out = toAnthropicMessages([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(out.system, '');
});

test('temperature is withheld from the models that answer 400 to it', () => {
  // The trap an adapter written from older documentation walks into:
  // temperature, top_p and top_k were removed on the current generation, and
  // sending one is not ignored — it fails the whole request.
  for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
    assert.equal(anthropicTakesSampling(m), false, `${m} would be sent a temperature it refuses`);
  }
  // Still sent where it is accepted, so an install pointing at an older model
  // does not lose the tuning panel.
  for (const m of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022']) {
    assert.equal(anthropicTakesSampling(m), true, `${m} lost the configured temperature`);
  }
  // Anything unrecognised — a model released after this was written — is
  // treated as refusing it. Omitting costs a little control; sending costs
  // every draft.
  assert.equal(anthropicTakesSampling('claude-something-9'), false);
  assert.equal(anthropicTakesSampling(''), false);
});

test('embeddings default to the drafting server and move only when told', () => {
  const base: AiSettings = { ...aiDefaults(), baseUrl: 'http://ollama:11434', apiKey: 'main' };
  // `same` is what every install had before the embedding slot became
  // separable, and it must still resolve to the language model's own
  // connection: a change here re-points every existing install's vectors.
  const inherited = embedEndpoint(base);
  assert.equal(inherited.baseUrl, base.baseUrl);
  assert.equal(inherited.apiKey, base.apiKey);
  assert.equal(inherited.inheritedFrom, 'llm');

  const split: AiSettings = {
    ...base,
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-xxx',
    embedProvider: 'ollama',
    embedBaseUrl: 'http://ollama:11434/',
    embedApiKey: 'embed-key',
  };
  const t = embedEndpoint(split);
  assert.equal(t.provider, 'ollama');
  // Normalised on the way out as well as on the way in: a trailing slash makes
  // every call `//api/embed`, which 404s.
  assert.equal(t.baseUrl, 'http://ollama:11434');
  assert.equal(t.apiKey, 'embed-key');
  // The drafting credential must not travel to the embedding server. It is a
  // different operator's box in the case this feature exists for.
  assert.notEqual(t.apiKey, split.apiKey);
});
