// The two things about talking to Ollama that are easy to get wrong: how a
// keep-alive setting is spelled on the wire, and what to say when a model
// answers with nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiDefaults, embedIdentity, modelOfIdentity, emptyAnswer, isValidKeepAlive, keepAliveValue, sameModel, samplingOptions, predictTokens, openAiMaxTokens, anthropicMaxTokens } from './llm.js';

test('a duration keeps its unit and travels as a string', () => {
  for (const v of ['10m', '1h', '30s', '500ms']) assert.equal(keepAliveValue(v), v);
});

test('a bare number becomes a number, which is what Ollama means by seconds', () => {
  // As a string, "-1" is refused with `time: missing unit in duration "-1"`.
  assert.equal(keepAliveValue('-1'), -1);
  assert.equal(keepAliveValue('0'), 0);
  assert.equal(keepAliveValue('300'), 300);
  assert.equal(typeof keepAliveValue('-1'), 'number');
});

test('whitespace around the value does not change its meaning', () => {
  assert.equal(keepAliveValue('  -1 '), -1);
  assert.equal(keepAliveValue(' 10m '), '10m');
});

test('an empty setting falls back to the default rather than being sent empty', () => {
  assert.equal(keepAliveValue(''), '10m');
  assert.equal(keepAliveValue(undefined as any), '10m');
});

test('the admin field accepts durations and plain seconds', () => {
  for (const v of ['10m', '1h', '30s', '500ms', '-1', '0', '3600']) assert.equal(isValidKeepAlive(v), true, v);
});

test('the admin field refuses what Ollama would refuse', () => {
  for (const v of ['', 'forever', '10 minutes', '1d', 'm10', '10m30s']) assert.equal(isValidKeepAlive(v), false, v);
});

test('an empty answer after thinking says the retry was tried too', () => {
  // Thinking is retried once with reasoning off before anyone is told
  // anything, so by the time this message is shown the budget is the fix.
  const msg = emptyAnswer('qwen3.5:4b', 3031, 700);
  assert.match(msg, /only its reasoning/);
  assert.match(msg, /above 700 tokens/);
  assert.match(msg, /Admin → AI model/);
});

test('an empty answer with no thinking says something different', () => {
  const msg = emptyAnswer('qwen2.5:3b', 0, 700);
  assert.match(msg, /empty reply/);
  assert.doesNotMatch(msg, /reasoning model/);
});

test('min-p is only sent when it is actually turned on', () => {
  // Ollama's own default is 0, and an endpoint that does not know the option
  // should never have to see it, so the field is omitted rather than zeroed.
  const off = samplingOptions({ ...aiDefaults(), minP: 0 });
  assert.equal('min_p' in off, false);
  const on = samplingOptions({ ...aiDefaults(), minP: 0.05 });
  assert.equal(on.min_p, 0.05);
  assert.equal(on.top_p, 0.9);
  assert.equal(on.top_k, 40);
  // A per-call temperature wins over the stored one; everything else stands.
  assert.equal(samplingOptions(aiDefaults(), 0.2).temperature, 0.2);
  assert.equal(samplingOptions(aiDefaults()).temperature, 0.7);
});

test('the repetition window travels with the penalty it belongs to', () => {
  // Ollama's own default looks back 64 tokens, which is less than a
  // paragraph; Tern sends its own window on every call rather than relying
  // on whatever the model file happens to say.
  assert.equal(samplingOptions(aiDefaults()).repeat_last_n, 256);
  assert.equal(samplingOptions({ ...aiDefaults(), repeatLastN: -1 }).repeat_last_n, -1);
});

test('the penalties that cross over to OpenAI are only sent when set', () => {
  const off = samplingOptions(aiDefaults());
  assert.equal('presence_penalty' in off, false);
  assert.equal('frequency_penalty' in off, false);
  const on = samplingOptions({ ...aiDefaults(), presencePenalty: 0.4, frequencyPenalty: 0.2 });
  assert.equal(on.presence_penalty, 0.4);
  assert.equal(on.frequency_penalty, 0.2);
});

test('an install answers several people at once unless an admin says otherwise', () => {
  assert.equal(aiDefaults().concurrency, true);
});

test('an untagged model name is the same model as its :latest tag', () => {
  // The settings hold "qwen2.5"; /api/ps reports "qwen2.5:latest". Reading
  // those as two different models is what left both of them in memory.
  assert.equal(sameModel('qwen2.5', 'qwen2.5:latest'), true);
  assert.equal(sameModel('qwen2.5:latest', 'qwen2.5'), true);
  assert.equal(sameModel('qwen2.5:3b', 'qwen2.5:3b'), true);
  assert.equal(sameModel(' qwen2.5:3b ', 'qwen2.5:3b'), true);
});

test('different models, and empty names, are not the same model', () => {
  assert.equal(sameModel('qwen2.5:3b', 'qwen2.5:0.5b'), false);
  assert.equal(sameModel('qwen2.5', 'qwen3.5'), false);
  assert.equal(sameModel('llama3.2:latest', 'qwen2.5:latest'), false);
  // An unset model must never look equal to another unset one, or a switch
  // away from "nothing configured" would try to unload "".
  assert.equal(sameModel('', ''), false);
  assert.equal(sameModel('', 'qwen2.5'), false);
});

test('uncapped means the parameter is not sent at all', () => {
  // 0 means "no ceiling", and that has to reach the wire as a MISSING
  // `num_predict` rather than a large one: a big number is still a ceiling,
  // merely a less visible one, and it would be the wrong ceiling on the next
  // model. `undefined` is what the Ollama path spreads away.
  assert.deepEqual(predictTokens({ replyTokens: 0, thinkingTokens: 0 }), {});
  // No window is consulted, so nothing about the prompt can turn an uncapped
  // reply into a capped one.
  assert.deepEqual(predictTokens({ replyTokens: 0, thinkingTokens: 16_000 }), {});
});

test('the reply ceiling is what decides whether anything is sent', () => {
  // `num_predict` bounds reasoning and answer TOGETHER, so a thinking budget
  // cannot be enforced through it while the reply is unbounded — an uncapped
  // reply is an uncapped total, whatever the thinking budget says.
  assert.deepEqual(predictTokens({ replyTokens: 0, thinkingTokens: 4_000 }), {});
  // A reply ceiling that IS set still gets its number, and the thinking
  // budget is added on top so reasoning does not eat the answer's allowance.
  assert.deepEqual(predictTokens({ replyTokens: 700, thinkingTokens: 0 }), { numPredict: 700 });
  assert.deepEqual(predictTokens({ replyTokens: 700, thinkingTokens: 4_000 }), { numPredict: 4_700 });
});

test('each API says "no ceiling" in its own way, and none of them says it with a big number', () => {
  // Three APIs, three spellings. The shared mistake to avoid is substituting a
  // large constant, which is still a ceiling and is wrong on any model whose
  // real limit differs.
  assert.deepEqual(openAiMaxTokens(0, 0), {}, 'OpenAI: the key must be absent');
  assert.deepEqual(openAiMaxTokens(0, 16_000), {}, 'an uncapped reply is an uncapped total');
  assert.deepEqual(openAiMaxTokens(700, 4_000), { max_tokens: 4_700 });

  // Anthropic requires the field, so uncapped becomes the model's own limit —
  // read from the Models API, never guessed, because a number above the real
  // ceiling is a 400 and a broken adapter rather than a shorter answer.
  assert.equal(anthropicMaxTokens(0, 0, 64_000), 64_000);
  assert.equal(anthropicMaxTokens(0, 16_000, 64_000), 64_000);
  assert.equal(anthropicMaxTokens(700, 4_000, 64_000), 4_700);
  assert.equal(anthropicMaxTokens(100_000, 0, 64_000), 64_000, 'never ask for more than the model takes');
});

// ---------- What counts as a change of embedder ----------

const embedBase = () => ({
  ...aiDefaults(),
  embedProvider: 'openai' as const,
  embedBaseUrl: 'https://vectors.example/v1',
  embedModel: 'all-minilm',
});

test('the same name at two providers is two different embedders', () => {
  // The bug this exists for: `all-minilm` on the Ollama next door and
  // `all-minilm` through a gateway share a string and not a vector space. While
  // only the name was compared, switching between them invalidated nothing and
  // search scored both together.
  const a = embedIdentity({ ...embedBase(), embedProvider: 'openai' });
  const b = embedIdentity({ ...embedBase(), embedProvider: 'ollama' });
  assert.notEqual(a, b);
});

test('the same name on two hosts is two different embedders', () => {
  const a = embedIdentity({ ...embedBase(), embedBaseUrl: 'https://vectors.example/v1' });
  const b = embedIdentity({ ...embedBase(), embedBaseUrl: 'https://other.example/v1' });
  assert.notEqual(a, b);
});

test('a path or a trailing slash is not a different embedder', () => {
  // A rebuild of every mailbox is far too expensive to spend on a URL that was
  // retyped, so the identity keeps the origin and drops the rest.
  const a = embedIdentity({ ...embedBase(), embedBaseUrl: 'https://vectors.example/v1' });
  const b = embedIdentity({ ...embedBase(), embedBaseUrl: 'https://vectors.example/v1/' });
  const c = embedIdentity({ ...embedBase(), embedBaseUrl: 'https://vectors.example/openai/v1' });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('changing the model is still a change of embedder', () => {
  assert.notEqual(
    embedIdentity({ ...embedBase(), embedModel: 'all-minilm' }),
    embedIdentity({ ...embedBase(), embedModel: 'qwen3-embedding:4b' }),
  );
});

test('an inherited embedder follows the language model’s address', () => {
  // `embedProvider: 'same'` means the embedder moves when the drafting server
  // moves, with nobody touching an embedding setting at all.
  const a = embedIdentity({ ...aiDefaults(), embedProvider: 'same', baseUrl: 'http://a.example:11434', embedModel: 'all-minilm' });
  const b = embedIdentity({ ...aiDefaults(), embedProvider: 'same', baseUrl: 'http://b.example:11434', embedModel: 'all-minilm' });
  assert.notEqual(a, b);
});

test('the identity is stable for settings that did not change', () => {
  // It is compared on every settings save and every index pass; an identity
  // that varied would rebuild the whole mailbox for nothing.
  assert.equal(embedIdentity(embedBase()), embedIdentity(embedBase()));
});

test('the model can be read back out of an identity for a page to show', () => {
  assert.equal(modelOfIdentity(embedIdentity(embedBase())), 'all-minilm');
  // A model name with the separator in it still comes back whole.
  assert.equal(modelOfIdentity('ollama|h|a|b'), 'a|b');
  // And something that is not an identity at all is returned as it is.
  assert.equal(modelOfIdentity('all-minilm'), 'all-minilm');
});
