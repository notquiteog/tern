import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshConversation, buildMessages, cleanOutput, cleanRecipientName, ensureGreeting, finalizeOutput, firstNameOf, modeTuning, parseQuickReplies, threadBudgetChars, DEFAULT_SYSTEM_PROMPT } from './prompts.js';

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
  // Every mode the /draft route accepts, so a new one cannot be added
  // without this noticing.
  for (const mode of ['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish', 'quick_replies'] as const) {
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
  // A paragraph is not a quick reply, and a truncated one is worse than
  // none: it would go into the composer half-finished.
  assert.deepEqual(parseQuickReplies('word '.repeat(60).trim()), []);
  assert.deepEqual(parseQuickReplies('Yes, that works.\n' + 'word '.repeat(40).trim() + '\nCould we do Friday?'), ['Yes, that works.', 'Could we do Friday?']);
});

test('a quick reply carrying a placeholder is dropped, not offered', () => {
  assert.deepEqual(parseQuickReplies('I will confirm [insert specific facts] shortly.\nYes, Tuesday works.\nCould we do Friday?'), ['Yes, Tuesday works.', 'Could we do Friday?']);
  assert.deepEqual(parseQuickReplies('Thanks {{first_name}}, will do.\nSounds good to me.'), ['Sounds good to me.']);
  assert.deepEqual(parseQuickReplies('Sure, see you at <time>.\nSounds good to me.'), ['Sounds good to me.']);
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

test('a long thread keeps both ends: the opening terms and the newest messages', () => {
  const thread = Array.from({ length: 24 }, (_, i) => ({ from: i % 2 ? 'Alex <alex@team.example>' : 'Dana <dana@acme.example>', date: `Day ${i}`, text: `Message ${i}. ${'filler '.repeat(30)}` }));
  thread[0].text = 'Message 0. Our fiscal year ends 30 September.';
  thread[12].text = 'Message 12. The middle of the conversation.';
  const m = buildMessages({ mode: 'reply', thread, threadChars: 2500 })[1].content;
  assert.ok(m.includes('30 September'), 'the opening message survives');
  assert.ok(m.includes('Message 23'), 'the newest message survives');
  assert.ok(!m.includes('Message 12'), 'the middle is what gets dropped');
  assert.match(m, /24 messages in total/);
  assert.match(m, /messages? in the middle of the thread omitted/);
});

test('a thread that fits is shown whole, with no omission notice', () => {
  const thread = Array.from({ length: 24 }, (_, i) => ({ from: 'Dana <dana@acme.example>', date: `Day ${i}`, text: `Message ${i}.` }));
  const m = buildMessages({ mode: 'reply', thread, threadChars: 14_000 })[1].content;
  for (let i = 0; i < 24; i++) assert.ok(m.includes(`Message ${i}.`), `message ${i} is present`);
  assert.ok(!m.includes('omitted'));
  assert.ok(!m.includes('in total'));
});

test('the newest message is kept at greater length than the older ones', () => {
  const long = (n: number) => `M${n} ` + 'x'.repeat(3000);
  const thread = [{ from: 'Dana <d@x.test>', date: 'Mon', text: long(1) }, { from: 'Dana <d@x.test>', date: 'Tue', text: long(2) }, { from: 'Dana <d@x.test>', date: 'Wed', text: long(3) }];
  const m = buildMessages({ mode: 'reply', thread, threadChars: 14_000 })[1].content;
  const newest = m.slice(m.lastIndexOf('M3'));
  assert.ok(newest.length > 2900, 'the message being replied to is kept nearly whole');
  assert.match(m, /\[…\]/, 'the older ones are trimmed');
});

test('the thread budget shrinks with the context window and never goes to nothing', () => {
  assert.ok(threadBudgetChars(8192, 700) > threadBudgetChars(4096, 700));
  assert.equal(threadBudgetChars(8192, 700), 14_000); // capped
  assert.ok(threadBudgetChars(2048, 700) >= 2_400);
  assert.ok(threadBudgetChars(512, 4096) >= 2_400);
});

test('reasoning left inline in <think> tags never reaches the draft', () => {
  assert.equal(cleanOutput('<think>She asked about pricing. I should quote 950.</think>\nHi Dana,\n\nIt is 950 a month.', 'reply'), 'Hi Dana,\n\nIt is 950 a month.');
  assert.equal(cleanOutput('<thinking>hmm</thinking>Hi Dana,', 'reply'), 'Hi Dana,');
  // A budget that ran out mid-thought leaves the tag unclosed.
  assert.equal(cleanOutput('Hi Dana,\n\nYes.\n<think>wait, should I also', 'reply'), 'Hi Dana,\n\nYes.');
  assert.equal(cleanOutput('I think we should meet Tuesday.', 'reply'), 'I think we should meet Tuesday.');
});

test('the editing modes are anchored to the length of the draft they were given', () => {
  const draft = 'word '.repeat(50).trim();
  assert.match(buildMessages({ mode: 'shorten', draft })[1].content, /draft is 50 words; your answer is at most 30 words/);
  assert.match(buildMessages({ mode: 'expand', draft })[1].content, /at most 100 words/);
  assert.match(buildMessages({ mode: 'polish', draft })[1].content, /at most 55 words/);
  assert.ok(!buildMessages({ mode: 'compose', instruction: 'hi' })[1].content.includes('The draft is'));
});

test('each mode is tuned the same way wherever it is called from', () => {
  assert.equal(modeTuning('polish').temperature, 0.2);
  assert.equal(modeTuning('subject').maxTokens, 60);
  assert.equal(modeTuning('quick_replies').maxTokens, 220);
  assert.equal(modeTuning('gist').maxTokens, 60);
  // Compose takes the install's own temperature and ceiling rather than
  // carrying its own; only the stop sequences, which are about the shape of
  // the request, apply to every mode.
  const compose = modeTuning('compose');
  assert.equal(compose.temperature, undefined);
  assert.equal(compose.maxTokens, undefined);
  assert.equal(compose.threadChars, undefined);
});

test('every mode stops the model running on into an invented next turn', () => {
  // A small model handed a chat template keeps going and answers itself.
  // Asserted per mode rather than by comparing whole objects, so adding a
  // mode or a tuning value does not break this.
  for (const mode of ['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish', 'quick_replies', 'gist'] as const) {
    const stop = modeTuning(mode).stop ?? [];
    for (const marker of ['\nUser:', '\nAssistant:']) assert.ok(stop.includes(marker), `${mode} should stop at ${JSON.stringify(marker)}`);
  }
  // The two one-line modes stop at the first newline as well.
  for (const mode of ['subject', 'gist'] as const) assert.ok(modeTuning(mode).stop?.includes('\n'), `${mode} should stop at a newline`);
  // The others must not: an email has paragraphs.
  for (const mode of ['compose', 'reply', 'summarize'] as const) assert.ok(!modeTuning(mode).stop?.includes('\n'), `${mode} must not stop at a newline`);
});

test('a From name is tidied into something a greeting can use', () => {
  assert.equal(firstNameOf('Dana Osei'), 'Dana');
  assert.equal(firstNameOf('Osei, Dana'), 'Dana');            // the directory-export form
  assert.equal(firstNameOf('DANA OSEI'), 'Dana');             // shouting
  assert.equal(firstNameOf('dana osei'), 'Dana');
  assert.equal(firstNameOf('Dr Dana Osei'), 'Dana');
  assert.equal(firstNameOf('Dana Osei, ACA'), 'Dana');
  assert.equal(firstNameOf('Dana Osei | Northwind Supply'), 'Dana');
  assert.equal(firstNameOf('Dana Osei (Northwind)'), 'Dana');
  assert.equal(firstNameOf('"Dana Osei"'), 'Dana');
  // Nothing usable: better no name than the wrong one.
  assert.equal(firstNameOf('dana@northwind.example'), '');
  assert.equal(firstNameOf(''), '');
  assert.equal(firstNameOf(undefined), '');
  assert.equal(firstNameOf('   '), '');
  assert.equal(cleanRecipientName('Osei, Dana'), 'Dana Osei');
});

test('a display name that is really an address never becomes a greeting', () => {
  const m = buildMessages({ mode: 'reply', recipient: { name: 'dana@northwind.example', email: 'dana@northwind.example' } })[1].content;
  assert.ok(m.includes('name is not known'), 'the prompt asks for "Hi there,"');
  assert.ok(!m.includes('Hi dana@'));
  assert.equal(ensureGreeting('Hi dana@northwind.example,\n\nYes.', 'reply', { name: 'dana@northwind.example' }), 'Hi there,\n\nYes.');
});

test('the greeting uses the tidied name, whatever shape it arrived in', () => {
  assert.equal(ensureGreeting('Thanks for that.', 'reply', { name: 'Osei, Dana' }), 'Hi Dana,\n\nThanks for that.');
  assert.equal(ensureGreeting('Hi Osei,\n\nThanks.', 'reply', { name: 'Osei, Dana' }), 'Hi Dana,\n\nThanks.');
  assert.equal(ensureGreeting('Hi DANA,\n\nThanks.', 'reply', { name: 'DANA OSEI' }), 'Hi Dana,\n\nThanks.');
  assert.equal(finalizeOutput('Hi Dana,\n\nSee you then.', 'reply', { recipient: { name: 'Dana Osei | Northwind Supply' } }), 'Hi Dana,\n\nSee you then.');
});

test('when strictness would leave nothing, the wordier suggestions are kept', () => {
  const wordy = 'I have confirmed those details and the fixed fee is 4,800 pounds as we discussed earlier this month.\nThe monthly close after that is 950 a month on a rolling three month term as agreed.';
  const got = parseQuickReplies(wordy);
  assert.equal(got.length, 2, 'two long-but-usable suggestions beat none');
  // A placeholder is still refused in the lenient pass.
  assert.deepEqual(parseQuickReplies('I will send [insert date] once I have confirmed it with the team and checked the calendar.'), []);
});

test('three replies written as one paragraph are still recovered', () => {
  const run_together = 'Yes, those are correct and I will send the plan today. Does this cover everything you need? My apologies, I cannot confirm until Thursday.';
  assert.deepEqual(parseQuickReplies(run_together), [
    'Yes, those are correct and I will send the plan today.',
    'Does this cover everything you need?',
    'My apologies, I cannot confirm until Thursday.',
  ]);
  // One reply written as one line is left as one reply.
  assert.deepEqual(parseQuickReplies('Sounds good to me.\nCould we do Friday instead?'), ['Sounds good to me.', 'Could we do Friday instead?']);
});

test('the quick replies prompt refuses to let a suggestion state facts', () => {
  const m = buildMessages({ mode: 'quick_replies', thread: [{ from: 'Dana <d@x.test>', date: 'Mon', text: 'Can you confirm the dates?' }] })[1].content;
  assert.match(m, /Do not state any date, time, amount/);
});

test('a voice note that fights the greeting rule is told which one wins', () => {
  const m = buildMessages({ mode: 'compose', instruction: 'ask for a call', recipient: { name: 'Dana Osei', email: 'd@x.test' }, voice: 'Very terse. Never use greetings.' })[1].content;
  assert.match(m, /except where they contradict the first line stated above, which always wins/);
  // Modes with no salutation of their own have nothing to contradict.
  const edit = buildMessages({ mode: 'polish', draft: 'hello', voice: 'Very terse.' })[1].content;
  assert.ok(!edit.includes('which always wins'));
});
