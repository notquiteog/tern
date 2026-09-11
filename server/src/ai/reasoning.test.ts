// The thinking dial, spelled for each host.
//
// Every table here guards a refusal rather than a degradation: a value a host
// does not take is a 400, and a 400 is the whole draft gone. None of these
// servers can be run locally with somebody's key, so the request fragments are
// asserted directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicBudget, anthropicReasoning, clampEffort, dialectFor, levelOf, ollamaThink,
  openAiCompatReasoning, openAiMaxTokensField, openAiTakesSampling, ORDER, THINK_LEVELS,
} from './reasoning.js';

const OPENAI = 'https://api.openai.com/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const GROQ = 'https://api.groq.com/openai/v1';
const FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const TOGETHER = 'https://api.together.xyz/v1';
const SILICONFLOW = 'https://api.siliconflow.com/v1';
const DASHSCOPE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';
const VLLM = 'http://10.0.0.5:8000/v1';

const effortOf = (level: (typeof THINK_LEVELS)[number], model: string, url: string, stream = true) =>
  openAiCompatReasoning(level, model, url, { stream }).reasoning_effort as string | undefined;

test('the host is read off the address, including every Alibaba region', () => {
  assert.equal(dialectFor(OPENAI), 'openai');
  assert.equal(dialectFor(OPENROUTER), 'openrouter');
  assert.equal(dialectFor(GROQ), 'groq');
  assert.equal(dialectFor(FIREWORKS), 'fireworks');
  assert.equal(dialectFor(TOGETHER), 'together');
  assert.equal(dialectFor('https://api.siliconflow.cn/v1'), 'siliconflow');
  assert.equal(dialectFor(DASHSCOPE), 'dashscope');
  assert.equal(dialectFor('https://ws1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'), 'dashscope');
  assert.equal(dialectFor(GEMINI), 'gemini');
  assert.equal(dialectFor(VLLM), 'generic');
  assert.equal(dialectFor('not a url'), 'generic');
});

test('the level comes from the two settings, and noThink always wins', () => {
  assert.equal(levelOf({ allowThinking: true, thinkEffort: 'xhigh' }), 'xhigh');
  assert.equal(levelOf({ allowThinking: false, thinkEffort: 'xhigh' }), 'off');
  assert.equal(levelOf({ allowThinking: true, thinkEffort: 'max' }, true), 'off');
});

test('a level clamps down, never up, and off is the least the model allows', () => {
  assert.equal(clampEffort('max', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffort('xhigh', ['low', 'medium', 'high', 'max']), 'high');
  assert.equal(clampEffort('off', ['none', 'low']), 'none');
  assert.equal(clampEffort('off', ['minimal', 'low']), 'minimal');
  assert.equal(clampEffort('off', ['low', 'medium']), 'low');
  assert.equal(clampEffort('low', ['minimal', 'low', 'medium']), 'low');
  assert.equal(clampEffort('low', ['high']), 'high');
  assert.equal(clampEffort('high', null), null);
});

test('OpenAI: each model gets a rung from its own ladder', () => {
  assert.equal(effortOf('off', 'gpt-6-astra', OPENAI), 'low', 'Astra refuses none');
  assert.equal(effortOf('max', 'gpt-6-astra', OPENAI), 'max');
  assert.equal(effortOf('off', 'gpt-5.6-luna', OPENAI), 'none');
  assert.equal(effortOf('max', 'gpt-5.2', OPENAI), 'xhigh');
  assert.equal(effortOf('xhigh', 'gpt-5.1', OPENAI), 'high');
  assert.equal(effortOf('off', 'gpt-5', OPENAI), 'minimal');
  assert.equal(effortOf('off', 'o3', OPENAI), 'low');
});

test('OpenAI: a model that does not reason is sent no effort, at any level', () => {
  for (const level of THINK_LEVELS) {
    assert.deepEqual(openAiCompatReasoning(level, 'gpt-4o', OPENAI), {}, level);
    // Positive control, so "nothing sent" cannot be a dead table.
    assert.ok(effortOf(level, 'gpt-5.6', OPENAI), `gpt-5.6 got nothing at ${level}`);
  }
});

test('OpenAI: the reasoning families lose sampling, and OpenAI wants the newer cap field', () => {
  for (const model of ['gpt-5.6', 'o3', 'openai/gpt-5', 'gpt-5-chat-latest']) assert.equal(openAiTakesSampling(model), false, model);
  for (const model of ['gpt-4o', 'qwen3:8b', 'openai/gpt-oss-120b']) assert.equal(openAiTakesSampling(model), true, model);
  assert.equal(openAiMaxTokensField(OPENAI), 'max_completion_tokens');
  assert.equal(openAiMaxTokensField(VLLM), 'max_tokens');
});

test('OpenRouter nests it, and off says none', () => {
  assert.deepEqual(openAiCompatReasoning('off', 'anthropic/claude-opus-5', OPENROUTER), { reasoning: { effort: 'none' } });
  assert.deepEqual(openAiCompatReasoning('max', 'openai/gpt-5.6', OPENROUTER), { reasoning: { effort: 'max' } });
});

test('Groq: only the values Groq documents for each model', () => {
  assert.deepEqual(openAiCompatReasoning('max', 'openai/gpt-oss-120b', GROQ), { reasoning_effort: 'high' });
  assert.deepEqual(openAiCompatReasoning('off', 'openai/gpt-oss-20b', GROQ), { reasoning_effort: 'low' });
  assert.deepEqual(openAiCompatReasoning('low', 'qwen/qwen3.6-27b', GROQ), { reasoning_effort: 'default', reasoning_format: 'parsed' });
  assert.deepEqual(openAiCompatReasoning('medium', 'qwen/qwen3.8-27b', GROQ), { reasoning_effort: 'medium', reasoning_format: 'parsed' });
  assert.deepEqual(openAiCompatReasoning('high', 'llama-3.3-70b-versatile', GROQ), {});
});

test('Fireworks, Together, SiliconFlow and Alibaba each get their own spelling', () => {
  assert.deepEqual(openAiCompatReasoning('off', 'accounts/fireworks/models/qwen3-8b', FIREWORKS), { reasoning_effort: 'none' });
  assert.deepEqual(openAiCompatReasoning('off', 'zai-org/GLM-5.2', TOGETHER), { reasoning: { enabled: false } });
  assert.deepEqual(openAiCompatReasoning('off', 'deepseek-ai/DeepSeek-R1', TOGETHER), {});
  assert.deepEqual(openAiCompatReasoning('high', 'Qwen/Qwen3-32B', SILICONFLOW), { enable_thinking: true, thinking_budget: 16384 });
  assert.deepEqual(openAiCompatReasoning('max', 'Qwen/Qwen3-32B', SILICONFLOW), { enable_thinking: true, thinking_budget: 32768 });
  assert.deepEqual(openAiCompatReasoning('off', 'qwen3.6-plus', DASHSCOPE), { enable_thinking: false });
  assert.deepEqual(openAiCompatReasoning('max', 'qwen3-max', DASHSCOPE), { enable_thinking: true });
  assert.deepEqual(openAiCompatReasoning('high', 'qwen3-32b', DASHSCOPE, { stream: false }), { enable_thinking: false });
});

test('Gemini: off is none only where the model has an off switch', () => {
  assert.equal(effortOf('off', 'gemini-2.5-flash', GEMINI), 'none');
  assert.equal(effortOf('off', 'gemini-2.5-pro', GEMINI), 'low');
  assert.equal(effortOf('max', 'gemini-3.1-pro', GEMINI), 'high');
  assert.deepEqual(openAiCompatReasoning('high', 'gemini-2.0-flash', GEMINI), {});
});

test('an unknown host hears about reasoning only when the model reasons', () => {
  assert.deepEqual(openAiCompatReasoning('high', 'qwen3:8b', VLLM), { reasoning_effort: 'high' });
  assert.deepEqual(openAiCompatReasoning('off', 'qwen3:8b', VLLM), {});
  assert.deepEqual(openAiCompatReasoning('high', 'llama3.3:70b', VLLM), {});
});

test('no host is ever sent an effort above the level asked for', () => {
  const cases: [string, string[]][] = [
    [OPENAI, ['gpt-6-astra', 'gpt-5.6', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o3']],
    [GROQ, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']],
    [FIREWORKS, ['accounts/fireworks/models/qwen3-8b']],
    [GEMINI, ['gemini-2.5-flash', 'gemini-3.1-pro']],
    [VLLM, ['qwen3:8b']],
  ];
  let checked = 0;
  for (const [url, models] of cases) {
    for (const model of models) {
      for (const level of THINK_LEVELS.filter((l) => l !== 'off')) {
        const effort = effortOf(level, model, url);
        if (effort === undefined || effort === 'default') continue;
        assert.ok(ORDER.indexOf(effort as never) <= ORDER.indexOf(level), `${url} ${model} ${level} → ${effort}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} combinations were checked — the tables stopped answering`);
});

test('Ollama: three names and false, except gpt-oss, which ignores false', () => {
  assert.equal(ollamaThink('off', 'qwen3.5:9b'), false);
  assert.equal(ollamaThink('off', 'gpt-oss:20b'), 'low');
  assert.equal(ollamaThink('medium', 'qwen3.5:9b'), 'medium');
  assert.equal(ollamaThink('max', 'qwen3.5:9b'), 'high');
});

test('Anthropic: each family is asked in the one form it accepts', () => {
  const opus = anthropicReasoning('claude-opus-5', 'xhigh');
  assert.deepEqual(opus.body, { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'xhigh' } });
  assert.equal(opus.sampling, false, 'temperature is a 400 while thinking');
  assert.deepEqual(anthropicReasoning('claude-sonnet-4-6', 'xhigh').body.output_config, { effort: 'high' }, '4.6 predates xhigh');
  const haiku = anthropicReasoning('claude-haiku-4-5', 'high', { maxTokens: 64000 });
  assert.equal((haiku.body.thinking as any).type, 'enabled', 'Haiku 4.5 rejects adaptive');
  assert.equal(haiku.body.output_config, undefined, 'and rejects effort');
  assert.ok(haiku.minMaxTokens! > (haiku.body.thinking as any).budget_tokens);
});

test('Anthropic: off is the right thing for each family', () => {
  assert.deepEqual(anthropicReasoning('claude-opus-5', 'off').body,
    { thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'low' } });
  const fable = anthropicReasoning('claude-fable-5-1', 'off');
  assert.equal(fable.body.thinking, undefined, '`disabled` is a 400 on Fable');
  const sonnet = anthropicReasoning('claude-sonnet-4-6', 'off', { takesSampling: true });
  assert.deepEqual(sonnet.body, { thinking: { type: 'disabled' } });
  assert.equal(sonnet.sampling, true);
  // The assistant's tool loop never sends `disabled`.
  assert.equal((anthropicReasoning('claude-sonnet-5', 'off', { allowDisabled: false }).body.thinking as any).type, 'adaptive');
});

test('Anthropic: the Models API overrides what the id suggests', () => {
  const caps = {
    thinking: { types: { adaptive: { supported: true }, enabled: { supported: false } } },
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
  };
  assert.deepEqual(anthropicReasoning('claude-something-9', 'xhigh', { capabilities: caps }).body.output_config, { effort: 'high' });
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    for (const ceiling of [8192, 64000, 128000]) {
      const b = anthropicBudget(level, ceiling);
      assert.ok(b >= 1024 && b <= ceiling / 2, `${level} @ ${ceiling}: ${b}`);
    }
  }
});
