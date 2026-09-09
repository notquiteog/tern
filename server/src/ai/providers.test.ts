// The provider catalogue, and the two embedding shapes that are not OpenAI's.
//
// Neither Gemini's embedding API nor Voyage has a version of itself that runs
// on a developer's machine, so a wrong request is not found until a real key
// is in a real install's settings and meaning search has quietly indexed
// nothing. The cases here name the failure each one prevents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBED_CATALOGUE, PROVIDER_PRESETS, embedModelInfo, embedModelsForShape, presetsForSlot } from './providers.js';
import { embeddingText } from './llm.js';
import { endpointHeaders, type ModelEndpoint } from './endpoint.js';
import { EMBED_MODELS } from './models.js';

const endpoint = (over: Partial<ModelEndpoint>): ModelEndpoint => ({
  id: 'embed', label: 'embeddings', provider: 'openai', baseUrl: 'https://example',
  apiKey: '', tlsInsecure: false, useTor: false, inheritedFrom: null, ...over,
});

test('every preset names a shape its slot can actually use', () => {
  // A preset that wrote a shape the settings validator refuses would be a
  // button that produces a save error, which is worse than no button.
  const llmShapes = new Set(['ollama', 'openai', 'anthropic']);
  const embedShapes = new Set(['ollama', 'openai', 'gemini', 'voyage']);
  for (const p of PROVIDER_PRESETS) {
    assert.doesNotThrow(() => new URL(p.baseUrl), `${p.id}: unusable base URL`);
    assert.ok(p.note.length > 20, `${p.id}: needs a sentence saying what it is`);
    if (p.slots.includes('llm')) assert.ok(llmShapes.has(p.shape), `${p.id} offers ${p.shape} for drafting`);
    if (p.slots.includes('embed')) assert.ok(embedShapes.has(p.shape), `${p.id} offers ${p.shape} for embeddings`);
  }
});

test('the two embedding-only shapes are never offered for drafting, and Anthropic never for embeddings', () => {
  // The same rule, pointing both ways: a setting that cannot work should not
  // be reachable. Neither Gemini's embedding API nor Voyage serves chat; the
  // Messages API has no embeddings endpoint at all.
  for (const shape of ['gemini', 'voyage'] as const) {
    const offered = PROVIDER_PRESETS.filter((p) => p.shape === shape);
    assert.ok(offered.length > 0, `${shape} is not offered anywhere`);
    for (const p of offered) assert.deepEqual(p.slots, ['embed'], `${p.id} offers ${shape} outside embeddings`);
  }
  const anthropic = PROVIDER_PRESETS.filter((p) => p.shape === 'anthropic');
  assert.ok(anthropic.length > 0);
  for (const p of anthropic) assert.ok(!p.slots.includes('embed'), `${p.id} offers Anthropic for embeddings`);
  assert.equal(embedModelsForShape('anthropic').length, 0);
});

test('a host is reachable for every slot Tern has a connection for', () => {
  // Not "every slot has a preset" as a tidiness rule — the point is that an
  // admin opening any connection card finds at least one starting point there
  // rather than an empty URL box and a guess.
  for (const slot of ['llm', 'embed', 'stt'] as const) {
    assert.ok(presetsForSlot(slot).length >= 2, `${slot} has fewer than two hosts to start from`);
  }
});

test('an embedder is recognised under every name its hosts give it', () => {
  // The same weights arrive as an Ollama tag, a Hugging Face id, and an
  // OpenRouter id with a vendor prefix. A catalogue that only matched one of
  // them would show the width for a locally pulled model and hide it for the
  // identical hosted one.
  assert.equal(embedModelInfo('qwen3-embedding:8b')?.dims, 4096);
  assert.equal(embedModelInfo('Qwen/Qwen3-Embedding-8B')?.dims, 4096);
  assert.equal(embedModelInfo('qwen/qwen3-embedding-8b')?.dims, 4096);
  assert.equal(embedModelInfo('qwen3-embedding:4b')?.dims, 2560);
  assert.equal(embedModelInfo('text-embedding-3-large')?.dims, 3072);
  assert.equal(embedModelInfo('gemini-embedding-2')?.dims, 3072);
  assert.equal(embedModelInfo('voyage-3-large')?.dims, 1024);
  // Ollama tags an untagged name `:latest`; the settings never carry that.
  assert.equal(embedModelInfo('nomic-embed-text:latest')?.dims, 768);
  assert.equal(embedModelInfo('something-nobody-has-heard-of'), null);
  assert.equal(embedModelInfo(''), null);

  // Every model this install can PULL is one the catalogue knows the width of,
  // or the picker shows a size for local models and nothing for the same model
  // reached over the network.
  for (const m of EMBED_MODELS) assert.ok(embedModelInfo(m.name), `${m.name} is pullable but has no catalogue entry`);
});

test('the credential goes in the header form each provider actually reads', () => {
  // Every one of these is a refusal rather than a degradation: the wrong
  // header is a 401 on every request, and a page reporting "unreachable"
  // sends an admin to check a firewall over a header.
  assert.deepEqual(endpointHeaders(endpoint({ provider: 'openai', apiKey: 'k' })), { Authorization: 'Bearer k' });
  assert.deepEqual(endpointHeaders(endpoint({ provider: 'voyage', apiKey: 'k' })), { Authorization: 'Bearer k' });
  assert.deepEqual(endpointHeaders(endpoint({ provider: 'gemini', apiKey: 'k' })), { 'x-goog-api-key': 'k' });
  // Google will also take the key as a `?key=` query parameter, and that is
  // exactly why it does not: a credential in a URL is a credential in every
  // log, proxy and error message between here and there.
  const gemini = endpointHeaders(endpoint({ provider: 'gemini', apiKey: 'k' }));
  assert.equal(gemini.Authorization, undefined);
  // Anthropic reads neither, and needs its version header on every request or
  // it refuses the lot.
  const anthropic = endpointHeaders(endpoint({ provider: 'anthropic', apiKey: 'k' }));
  assert.equal(anthropic['x-api-key'], 'k');
  assert.ok(anthropic['anthropic-version']);
  // An empty key sends nothing, which is the bundled Ollama.
  assert.deepEqual(endpointHeaders(endpoint({ provider: 'ollama', apiKey: '' })), {});
});

test('a search carries a task instruction and the mailbox it is searched against does not', () => {
  // Asymmetric on purpose. These models are trained so the query carries the
  // instruction; prefixing the documents too would put the same words in every
  // vector in the mailbox and flatten the distinction the prefix exists for.
  for (const model of ['qwen3-embedding:8b', 'Qwen/Qwen3-Embedding-4B', 'gemini-embedding-2']) {
    assert.match(embeddingText('invoices from March', model, 'query'), /^Instruct: .+\nQuery: invoices from March$/, model);
    assert.equal(embeddingText('Re: your invoice', model, 'document'), 'Re: your invoice', model);
  }
  // gemini-embedding-001 DOES take a task-type parameter, so it must not be
  // given the instruction in words as well.
  assert.equal(embeddingText('invoices', 'gemini-embedding-001', 'query'), 'invoices');
  // Voyage takes `input_type` as a real request field, which is better than a
  // prefix — so it is deliberately not given one here.
  assert.equal(embeddingText('invoices', 'voyage-3-large', 'query'), 'invoices');
  // And a model with no such convention is left entirely alone.
  assert.equal(embeddingText('invoices', 'text-embedding-3-large', 'query'), 'invoices');
  assert.equal(embeddingText('invoices', 'all-minilm', 'query'), 'invoices');
});

test('an embedder is told from a writer by capability, wherever the build reports it', async () => {
  // This was a live bug and a silent one. Ollama's documented `/api/tags`
  // response carries NO capability field — `/api/show` is what reports one —
  // and some builds put it under `details`. Reading only the top level of the
  // listing therefore got an empty list from every Ollama, so every model came
  // back unclassified and an embedder somebody had pulled appeared in the
  // WRITING table with a "Use" button on it. Setting the drafting model to
  // something that cannot draft breaks every AI feature at once.
  //
  // Found by a sibling project hitting it against a live daemon with
  // qwen3-embedding:4b pulled alongside a chat model.
  const { listModels } = await import('./llm.js');
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const href = String(url);
    seen.push(href);
    if (href.endsWith('/api/tags')) {
      return new Response(JSON.stringify({
        models: [
          // Three builds, three places the answer might be.
          { name: 'top-level:latest', capabilities: ['embedding'], details: {} },
          { name: 'under-details:latest', details: { capabilities: ['embedding'] } },
          { name: 'says-nothing:latest', details: {} },
        ],
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (href.endsWith('/api/show')) {
      const model = JSON.parse(String(init?.body ?? '{}')).model;
      return new Response(JSON.stringify({
        capabilities: model === 'says-nothing:latest' ? ['embedding'] : ['completion'],
        model_info: {},
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const models = await listModels({
      id: 'embed', label: 'embeddings', provider: 'ollama', baseUrl: 'http://embedder.test',
      apiKey: 'embedding-key', tlsInsecure: false, useTor: false, inheritedFrom: null,
    });
    const by = Object.fromEntries(models.map((m) => [m.name, m.capabilities]));
    assert.deepEqual(by['top-level:latest'], ['embedding']);
    assert.deepEqual(by['under-details:latest'], ['embedding']);
    // The listing said nothing, so `/api/show` was asked — and it does say.
    assert.deepEqual(by['says-nothing:latest'], ['embedding']);
    // Only the one that needed it: the cached describe is not a per-poll cost
    // on models the listing already classified.
    assert.equal(seen.filter((u) => u.endsWith('/api/show')).length, 1);
    // Every call went to the EMBEDDING server, not the language model's.
    assert.ok(seen.every((u) => u.startsWith('http://embedder.test')), seen.join(', '));
  } finally {
    globalThis.fetch = real;
  }
});

test('every catalogue entry says how wide its vectors are and what that costs', () => {
  for (const m of EMBED_CATALOGUE) {
    assert.ok(m.dims >= 128, `${m.name}: an implausible width`);
    assert.ok(m.contextTokens >= 512, `${m.name}: an implausible input window`);
    assert.ok(m.shapes.length > 0, `${m.name}: reachable through no shape`);
    assert.ok(m.note.length > 20, `${m.name}: needs a sentence saying what it is for`);
  }
});
