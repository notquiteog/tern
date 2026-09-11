// The provider catalogue, and the two embedding shapes that are not OpenAI's.
//
// Neither Gemini's embedding API nor Voyage has a version of itself that runs
// on a developer's machine, so a wrong request is not found until a real key
// is in a real install's settings and meaning search has quietly indexed
// nothing. The cases here name the failure each one prevents.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARS_PER_TOKEN, EMBED_CATALOGUE, MIN_EMBED_CHARS, PROVIDER_PRESETS,
  embedInputChars, embedModelInfo, embedModelsForShape, presetsForSlot,
} from './providers.js';
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
  // Pictures come back either from a path of their own or out of a chat
  // reply; video only ever from the path shape.
  const imageShapes = new Set(['openai', 'openai-chat', 'comfyui']);
  const videoShapes = new Set(['openai']);
  for (const p of PROVIDER_PRESETS) {
    assert.doesNotThrow(() => new URL(p.baseUrl), `${p.id}: unusable base URL`);
    assert.ok(p.note.length > 20, `${p.id}: needs a sentence saying what it is`);
    if (p.slots.includes('llm')) assert.ok(llmShapes.has(p.shape), `${p.id} offers ${p.shape} for drafting`);
    if (p.slots.includes('embed')) assert.ok(embedShapes.has(p.shape), `${p.id} offers ${p.shape} for embeddings`);
    if (p.slots.includes('image')) assert.ok(imageShapes.has(p.shape), `${p.id} offers ${p.shape} for pictures`);
    if (p.slots.includes('video')) assert.ok(videoShapes.has(p.shape), `${p.id} offers ${p.shape} for video`);
  }
});

test('a host that cannot draw is not offered for drawing', () => {
  // The same rule that keeps Anthropic off the embedding list, pointing at
  // the newest slot. Ollama runs vision models that READ a picture and has no
  // endpoint that draws one, so offering it here would be a choice that
  // produces a save followed by a button that always fails.
  const ollama = PROVIDER_PRESETS.filter((p) => p.shape === 'ollama');
  assert.ok(ollama.length > 0, 'no Ollama-shaped host at all — this check would report clean on that');
  for (const p of ollama) {
    assert.ok(!p.slots.includes('image'), `${p.id} offers Ollama for pictures`);
    assert.ok(!p.slots.includes('video'), `${p.id} offers Ollama for video`);
  }
  // And the chat-completions shape exists only to draw: it is a picture
  // endpoint wearing a chat endpoint's clothes, and choosing it for drafting
  // would send a draft into an image parser.
  const chat = PROVIDER_PRESETS.filter((p) => p.shape === 'openai-chat');
  assert.ok(chat.length > 0, 'the chat-completions image shape is offered nowhere');
  for (const p of chat) assert.deepEqual(p.slots, ['image'], `${p.id} offers openai-chat outside pictures`);
  // ComfyUI only draws: it takes a graph, not a conversation or a sentence to embed.
  const comfy = PROVIDER_PRESETS.filter((p) => p.shape === 'comfyui');
  assert.ok(comfy.length > 0, 'ComfyUI is offered nowhere');
  for (const p of comfy) assert.deepEqual(p.slots, ['image'], `${p.id} offers ComfyUI outside pictures`);

  // Somewhere to start for both new slots, so an admin opening either card
  // finds a host rather than an empty URL box and a guess.
  assert.ok(presetsForSlot('image').length >= 3, 'fewer than three hosts to start from for pictures');
  assert.ok(presetsForSlot('video').length >= 1, 'no host to start from for video');
});

test('the whole of a model’s window is used, and nothing caps it but the window', () => {
  // `contextTokens` was written down, shown in the models table, and read by
  // nothing: every model got a flat 2,000 characters, so an install that
  // pulled a 2.5 GB embedder for its 32k window was paying for a window it
  // was never sent. Then a ceiling of Tern's own replaced the flat number and
  // reintroduced the same failure at 8,000 characters — harmless while the
  // catalogue topped out at 8,192 tokens, and a cap to 7% of the window once
  // a 32k model became the floor.
  //
  // So the property is now exact rather than bounded: the budget IS the
  // window, and the only thing that may raise it is the floor.
  for (const m of EMBED_CATALOGUE) {
    const chars = embedInputChars(m.name);
    const window = Math.round(m.contextTokens * CHARS_PER_TOKEN);
    assert.equal(chars, Math.max(MIN_EMBED_CHARS, window),
      `${m.name}: ${chars} characters for a ${m.contextTokens}-token window`);
    assert.ok(chars >= MIN_EMBED_CHARS, `${m.name}: below what every install already indexed`);
  }

  // And the case that motivated removing the ceiling: the documented floor
  // model must get most of its window, not a fixed slice of it.
  const qwen = embedInputChars('qwen3-embedding:4b');
  assert.ok(qwen > 60_000, `the 32k-window floor model gets only ${qwen} characters`);
  assert.ok(qwen > 8 * embedInputChars('all-minilm'), 'a 32k window buys barely more than a 512-token one');

  // An unknown model — a host's own name for something, or a fine-tune —
  // reports no window, so it gets the floor. Guessing generously at a window
  // nobody has written down is how a batch gets refused by the far end.
  assert.equal(embedInputChars('somebody-elses-fine-tune'), MIN_EMBED_CHARS);
  assert.equal(embedInputChars(''), MIN_EMBED_CHARS);
  // And it follows the aliases, so the same weights get the same budget
  // whether they were pulled locally or reached over the network.
  assert.equal(embedInputChars('Qwen/Qwen3-Embedding-4B'), qwen);
  assert.equal(embedInputChars('qwen3-embedding:4b:latest'), qwen);
});

test('the token estimate stays pessimistic, because it is now the only bound', () => {
  // With no ceiling above it, whatever this ratio produces is the promise made
  // to the far end — and Ollama truncates quietly while OpenAI, Gemini and
  // Voyage refuse input over the window. So it must under-estimate: an
  // English-prose ratio (around four) applied to a message in a script that
  // tokenises at one character per token would send four times the window and
  // fail the whole batch that message was in.
  assert.ok(CHARS_PER_TOKEN <= 2, `${CHARS_PER_TOKEN} chars/token is optimistic enough to overrun a strict window`);
  assert.ok(CHARS_PER_TOKEN >= 1, `${CHARS_PER_TOKEN} chars/token wastes most of every window`);
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
  assert.equal(embedModelInfo('qwen3-embedding:0.6b')?.dims, 1024);
  assert.equal(embedModelInfo('Qwen/Qwen3-Embedding-0.6B')?.dims, 1024);
  assert.equal(embedModelInfo('bge-m3')?.dims, 1024);
  assert.equal(embedModelInfo('BAAI/bge-m3')?.dims, 1024);
  assert.equal(embedModelInfo('mxbai-embed-large')?.dims, 1024);
  assert.equal(embedModelInfo('snowflake-arctic-embed2')?.dims, 1024);
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
  // Every name the Qwen3 family goes by, from the catalogue rather than from a
  // list written out here — a model added with an alias the prefix does not
  // match would be a whole family of embedders quietly searched without the
  // instruction they are trained to expect.
  const qwen = EMBED_CATALOGUE.filter((m) => /qwen3/i.test(m.name));
  assert.ok(qwen.length >= 3, 'the Qwen3 embedders are no longer in the catalogue');
  for (const m of qwen) {
    for (const name of [m.name, ...(m.alternateNames ?? [])]) {
      assert.match(embeddingText('invoices', name, 'query'), /^Instruct: /, name);
      assert.equal(embeddingText('invoices', name, 'document'), 'invoices', name);
    }
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
