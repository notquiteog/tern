import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshConversation, buildMessages, cleanOutput, ensureGreeting, finalizeOutput, parseQuickReplies, DEFAULT_SYSTEM_PROMPT } from './prompts.js';

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

test('buildMessages names the recipient once and refuses to guess when unknown', () => {
  const known = buildMessages({ mode: 'compose', instruction: 'say hi', recipient: { name: 'Dana Osei', email: 'dana@acme.example' }, senderName: 'Alex Rivera', senderEmail: 'alex@team.example' })[1].content;
  assert.ok(known.includes('Write to Dana Osei <dana@acme.example>'));
  assert.ok(known.includes('exactly "Hi Dana,"'));
  assert.ok(known.includes('You are writing as Alex Rivera <alex@team.example>'));
  assert.ok(known.includes('use only "Alex"'));
  const unknown = buildMessages({ mode: 'reply', recipient: { email: 'someone@example.org' } })[1].content;
  assert.ok(unknown.includes('name is not known') && unknown.includes('guessed or invented'));
  const none = buildMessages({ mode: 'rewrite', draft: 'x', recipient: { name: 'Dana' } })[1].content;
  assert.ok(!none.includes('Write to'));
});

test('thread messages from the sender are marked so the model knows which side it is on', () => {
  const m = buildMessages({ mode: 'reply', senderEmail: 'alex@team.example', thread: [{ from: 'Dana <dana@acme.example>', date: 'Mon', text: 'Can we talk?' }, { from: 'Alex <alex@team.example>', date: 'Tue', text: 'Sure.' }] })[1].content;
  assert.ok(m.includes('From Alex <alex@team.example> (this is the sender, you)'));
  assert.ok(!m.includes('Dana <dana@acme.example> (this is the sender'));
});

test('cleanOutput preamble stripping stops at the colon and keeps a one-line draft', () => {
  assert.equal(cleanOutput("Here's the corrected draft: Hi Dana, thanks for your time. Best, Alex", 'polish'), 'Hi Dana, thanks for your time. Best, Alex');
  assert.equal(cleanOutput('Sure! Here is a reply you could send:\n\nHi Dana,\n\nYes.', 'reply'), 'Hi Dana,\n\nYes.');
  assert.equal(cleanOutput("I've sent it. Let me know if there's anything else.", 'reply'), "I've sent it. Let me know if there's anything else.");
});

test('ensureGreeting addresses the actual recipient and never a guessed one', () => {
  const dana = { name: 'Dana Osei', email: 'dana@acme.example' };
  assert.equal(ensureGreeting('Sure thing! Tuesday works.\nAlex', 'reply', dana), 'Hi Dana,\n\nSure thing! Tuesday works.\nAlex');
  assert.equal(ensureGreeting('Hi Alex,\n\nTuesday works.', 'reply', dana), 'Hi Dana,\n\nTuesday works.');
  assert.equal(ensureGreeting('Hello Sam, thanks.', 'compose', dana), 'Hi Dana, thanks.');
  assert.equal(ensureGreeting('Dana,\n\nGreat to hear.', 'reply', dana), 'Dana,\n\nGreat to hear.');
  assert.equal(ensureGreeting('Dear Dana Osei,\n\nGreat.', 'compose', dana), 'Dear Dana Osei,\n\nGreat.');
  assert.equal(ensureGreeting('Hi Marcus,\n\nWe launched.', 'compose', { email: 'hello@bluefin.example' }), 'Hi there,\n\nWe launched.');
  assert.equal(ensureGreeting('Hi there,\n\nWe launched.', 'compose', { email: 'x@y.z' }), 'Hi there,\n\nWe launched.');
  assert.equal(ensureGreeting('We launched.', 'compose', undefined), 'Hi there,\n\nWe launched.');
  assert.equal(ensureGreeting('Quick question about pricing', 'subject', dana), 'Quick question about pricing');
});

test('finalizeOutput removes the signature block the model added', () => {
  const out = finalizeOutput('Hi Dana,\n\nFrom 400 a month.\n\nBest regards,\nAlex Rivera\nalex@team.example\n', 'reply', { recipient: { name: 'Dana Osei' }, senderName: 'Alex Rivera', senderEmail: 'alex@team.example' });
  assert.equal(out, 'Hi Dana,\n\nFrom 400 a month.\n\nBest regards,\nAlex Rivera');
  assert.equal(finalizeOutput('Hi Dana,\n\nOk.\n\n[Your Name]', 'compose', { recipient: { name: 'Dana' } }), 'Hi Dana,\n\nOk.');
  assert.equal(finalizeOutput('Hi Lee,\n\nLooking forward to it.\n\nAlex\nAlex Rivera', 'personalize', { recipient: { name: 'Lee Park' }, senderName: 'Alex Rivera' }), 'Hi Lee,\n\nLooking forward to it.\n\nAlex');
});

test('every mode builds a fresh single-turn conversation', () => {
  for (const mode of ['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish'] as const) {
    const msgs = buildMessages({ mode, draft: 'x', instruction: 'y', thread: [{ from: 'A <a@x.test>', date: 'today', text: 'hi' }] });
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'user'], mode);
    assert.doesNotThrow(() => assertFreshConversation(msgs));
  }
});

test('the transport refuses conversations with history', () => {
  assert.throws(() => assertFreshConversation([{ role: 'system', content: 's' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), /fresh conversation/);
  assert.throws(() => assertFreshConversation([{ role: 'user', content: 'a' }]), /fresh conversation/);
  assert.throws(() => assertFreshConversation([]), /fresh conversation/);
});

test('quick replies: three clean one-liners whatever the model decorated them with', () => {
  assert.deepEqual(parseQuickReplies('1. Yes, Tuesday at 10 works for me.\n2) Could we do Wednesday instead?\n- Thanks, but I will pass this time.'), ['Yes, Tuesday at 10 works for me.', 'Could we do Wednesday instead?', 'Thanks, but I will pass this time.']);
  assert.deepEqual(parseQuickReplies('"Sounds good!"\n\n"Sounds good!"\n"What time suits you?"\n"No thanks."\n"Extra line"'), ['Sounds good!', 'What time suits you?', 'No thanks.']);
  assert.deepEqual(parseQuickReplies('Here are three replies:\nHi Dana, yes please.\nOption 2: maybe next week?\n* not this time, sorry'), ['Yes please.', 'Maybe next week?', 'Not this time, sorry']);
  assert.deepEqual(parseQuickReplies(''), []);
  assert.deepEqual(parseQuickReplies('Alice, the update sounds good to me.\nBob\nDana, could we talk Friday?\nYes, Tuesday works.', ['Dana Osei', 'Alice Probe']), ['The update sounds good to me.', 'Could we talk Friday?', 'Yes, Tuesday works.']);
  assert.deepEqual(parseQuickReplies('```\nSure thing.\n```'), ['Sure thing.']);
  const long = parseQuickReplies('word '.repeat(60).trim());
  assert.ok(long[0].length <= 140 && long[0].endsWith('…'));
});

test('finalizeOutput joins quick replies with newlines and never adds a greeting to them', () => {
  assert.equal(finalizeOutput('1. Yes.\n2. No.\n3. Maybe.', 'quick_replies', { recipient: { name: 'Dana' } }), 'Yes.\nNo.\nMaybe.');
});

test('the quick replies prompt asks for exactly three lines and carries the thread', () => {
  const m = buildMessages({ mode: 'quick_replies', thread: [{ from: 'Dana <dana@acme.example>', date: 'Mon', text: 'Can we meet Tuesday?' }], senderEmail: 'alex@team.example' });
  assert.deepEqual(m.map((x) => x.role), ['system', 'user']);
  assert.ok(m[1].content.includes('exactly three lines'));
  assert.ok(m[1].content.includes('Can we meet Tuesday?'));
  assert.ok(!m[1].content.includes('Write to'));
});

test('cleanOutput cuts an echoed prompt off the end of a reply', () => {
  assert.equal(cleanOutput('Hi Bob,\n\nThank you! I will get back to you shortly.\n\n---\n\nBob Probe: Got it.\n--- From Alice <a@x> on Sun\nHi Bob, pricing?\nSubject of this email: Pricing', 'reply'), 'Hi Bob,\n\nThank you! I will get back to you shortly.');
  assert.equal(cleanOutput('Hi Bob,\n\nSee you Tuesday.\n\nSubject of this email: Meeting', 'reply'), 'Hi Bob,\n\nSee you Tuesday.');
  assert.equal(cleanOutput('A dash --- in the middle of a line stays.', 'reply'), 'A dash --- in the middle of a line stays.');
});
