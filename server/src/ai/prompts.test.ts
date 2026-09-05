import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, cleanOutput, DEFAULT_SYSTEM_PROMPT } from './prompts.js';

test('cleanOutput strips labels, markdown emphasis and code fences', () => {
  assert.equal(cleanOutput('**Alice:** Sure, I am **all** ears.', 'reply'), 'Sure, I am all ears.');
  assert.equal(cleanOutput('Here is the email:\n\nHi Bob,\n\nThanks.', 'compose'), 'Hi Bob,\n\nThanks.');
  assert.equal(cleanOutput('```\nHello there\n```', 'compose'), 'Hello there');
  assert.equal(cleanOutput('Subject: "Quick question about pricing."', 'subject'), 'Quick question about pricing');
  assert.equal(cleanOutput('Dear Ada, welcome.', 'compose'), 'Dear Ada, welcome.');
});

test('buildMessages uses the custom system prompt and voice', () => {
  const m = buildMessages({ mode: 'compose', instruction: 'say hi', systemPrompt: 'Be brief.', voice: 'No greetings.' });
  assert.equal(m[0].content, 'Be brief.');
  assert.ok(m[1].content.includes('No greetings.'));
  const d = buildMessages({ mode: 'compose', instruction: 'say hi' });
  assert.equal(d[0].content, DEFAULT_SYSTEM_PROMPT);
});
