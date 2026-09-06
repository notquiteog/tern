// The two things about talking to Ollama that are easy to get wrong: how a
// keep-alive setting is spelled on the wire, and what to say when a model
// answers with nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiDefaults, emptyAnswer, isValidKeepAlive, keepAliveValue, samplingOptions } from './llm.js';

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
