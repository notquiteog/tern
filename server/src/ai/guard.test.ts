import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSendable, findTemplateArtifacts, TemplateGuardError, findGreetingProblems, findInventedSpecifics, extractSpecifics } from './guard.js';
import { cleanOutput } from './prompts.js';

const kinds = (r: ReturnType<typeof findTemplateArtifacts>) => [...new Set(r.map((h) => h.kind))];

test('clean mail passes', () => {
  assert.deepEqual(findTemplateArtifacts({ subject: 'Quick question', html: '<p>Hi Dana,</p><p>Thanks for the note. Tuesday at 10 works; see you then [1].</p><p>Best,<br>Alex</p>' }), []);
  assert.deepEqual(findTemplateArtifacts({ text: 'Prices start at $400/month; the {budget} we discussed is fine.' }).filter((h) => h.kind !== 'merge_field'), []);
  assert.doesNotThrow(() => assertSendable({ subject: 'Re: hello', html: '<p>Sure, sounds good.</p>' }));
});

test('unrendered merge fields and spin syntax are caught', () => {
  assert.deepEqual(kinds(findTemplateArtifacts({ html: '<p>Hi {{first_name}},</p>' })), ['merge_field']);
  assert.deepEqual(kinds(findTemplateArtifacts({ subject: 'Hello {{ company | there }}' })), ['merge_field']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: '{Hi|Hello|Hey} Dana' })), ['merge_field']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Dear ${name}, {% if company %}x{% endif %}' })), ['merge_field']);
  assert.equal(findTemplateArtifacts({ text: 'Hi {{first_name}} and {{first_name}} again' }).length, 1);
});

test('bracket and angle placeholders are caught, citations and code are not', () => {
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Best regards,\n[Your Name]' })), ['placeholder']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Dear [Name], welcome to [Company Name].' })), ['placeholder']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'We can meet on [insert date] at <time>.' })), ['placeholder']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Regards, __NAME__' })), ['placeholder']);
  assert.deepEqual(findTemplateArtifacts({ text: 'See the paper [1] and [Smith 2020]; the value is < 10 and > 5.' }), []);
  assert.deepEqual(findTemplateArtifacts({ html: '<p>Fine, thanks.</p><p>Read <a href="https://x.test">this</a></p>' }), []);
});

test('echoed prompt scaffolding and AI self-references are caught', () => {
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Hi Dana,\n\nThanks.\n\nRecipient facts (use only these):\nName: Dana' })), ['prompt_leak']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Hi,\n\n--- From Dana <d@x> on Mon\nhello' })), ['prompt_leak']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'As an AI language model I cannot promise a discount.' })), ['ai_disclosure']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: "I'm an AI assistant helping Alex." })), ['ai_disclosure']);
  assert.deepEqual(kinds(findTemplateArtifacts({ text: 'Lorem ipsum dolor sit amet.' })), ['filler']);
});

test('quoted text from the other side is not inspected', () => {
  const html = '<p>Sure thing.</p><div class="tern-quote"><blockquote>Hi {{first_name}}, [Your Name] wrote as an AI</blockquote></div>';
  assert.deepEqual(findTemplateArtifacts({ html }), []);
  assert.deepEqual(findTemplateArtifacts({ text: 'Ok.\n> Dear [Name]' }), []);
});

test('assertSendable throws a descriptive error', () => {
  assert.throws(() => assertSendable({ html: '<p>Hi {{first_name}},</p><p>[Your Name]</p>' }), (e: unknown) => e instanceof TemplateGuardError && e.hits.length === 2 && /unrendered merge field "\{\{first_name\}\}"/.test(e.message) && /placeholder "\[Your Name\]"/.test(e.message));
});

test('a draft that is only a greeting is not sendable', () => {
  // What a small model leaves behind when it produces nothing and the
  // salutation pass writes the first line for it.
  assert.equal(findTemplateArtifacts({ text: 'Hi Dana,' }).map((h) => h.kind).includes('no_body'), true);
  assert.equal(findTemplateArtifacts({ subject: 'Quick question', html: '<p>Hi Dana,</p>' }).map((h) => h.kind).includes('no_body'), true);
  assert.equal(findTemplateArtifacts({ text: 'Hi Dana,\n\nBest,\nAlex' }).map((h) => h.kind).includes('no_body'), true);
  assert.equal(findTemplateArtifacts({ text: '' }).map((h) => h.kind).includes('no_body'), true);
  assert.throws(() => assertSendable({ text: 'Hi Dana,' }), /no message body/);
});

test('a short but real email is sendable', () => {
  assert.deepEqual(findTemplateArtifacts({ text: 'Hi Dana,\n\nThursday at 10 works for me. See you then.\n\nAlex' }), []);
  assert.deepEqual(findTemplateArtifacts({ text: 'Yes, Thursday at 10 works for me.' }), []);
});

test('the quoted original does not count as a body of our own', () => {
  const html = '<p>Hi Dana,</p><div class="tern-quote">On Monday, dana@acme.example wrote: a long message with plenty of words in it that would otherwise look like a body.</div>';
  assert.equal(findTemplateArtifacts({ html }).map((h) => h.kind).includes('no_body'), true);
});

// ---------- Who it is addressed to ----------

test('the guard asserts the salutation names the recipient and nobody else', () => {
  const forbidden = ['Tomasz Nowak', 'Priya Raman', 'Alex Rivera'];
  // The trap a long thread sets: a name mentioned throughout, never the recipient.
  assert.equal(findGreetingProblems('Hi Tomasz,\n\nThanks for approving.', { first: 'Dana', forbidden }).length > 0, true);
  // The sender's own name.
  assert.equal(findGreetingProblems('Hi Alex,\n\nThanks.', { first: 'Dana', forbidden }).length > 0, true);
  // A name where none was known is an invention, not a lookup.
  assert.equal(findGreetingProblems('Hi Sarah,\n\nThanks.', { first: '' })[0]?.kind, 'wrong_name');
  // The neutral greeting is the right answer when nothing resolved.
  assert.deepEqual(findGreetingProblems('Hi there,\n\nThanks.', { first: '' }), []);
  assert.deepEqual(findGreetingProblems('Hello everyone,\n\nThanks.', { first: '' }), []);
  // Right person, right greeting.
  assert.deepEqual(findGreetingProblems('Hi Dana,\n\nAs Tomasz mentioned, it is approved.', { first: 'Dana', forbidden }), []);
  // A second salutation halfway down: the model started writing to somebody else.
  assert.equal(findGreetingProblems('Hi Dana,\n\nThanks.\n\nHi Priya, one more thing.', { first: 'Dana', forbidden }).length > 0, true);
  // The full name after the first is still the right person.
  assert.deepEqual(findGreetingProblems('Dear Dana Osei,\n\nThanks.', { first: 'Dana', forbidden }), []);
});

// ---------- Facts it was never given ----------

test('specifics normalise so the same fact written two ways compares equal', () => {
  const tok = (s: string) => extractSpecifics(s).map((x) => x.token);
  assert.deepEqual(tok('four thousand eight hundred pounds'), ['money:4800']);
  assert.deepEqual(tok('£4,800'), ['money:4800']);
  assert.deepEqual(tok('$150'), ['money:150']);
  assert.deepEqual(tok('10am'), ['time:10:00']);
  assert.deepEqual(tok('10:00'), ['time:10:00']);
  assert.deepEqual(tok('2.30pm'), ['time:14:30']);
  assert.deepEqual(tok('30 September'), ['day:sep-30']);
  assert.deepEqual(tok('Sept 30th'), ['day:sep-30']);
  assert.deepEqual(tok('2026-09-30'), ['day:sep-30']);
  assert.deepEqual(tok('three-month term'), ['term:3-month']);
  assert.deepEqual(tok('3 months'), ['term:3-month']);
  assert.deepEqual(tok('15%'), ['pct:15']);
  assert.deepEqual(tok('15 per cent'), ['pct:15']);
  // Not money, and not a term: a count of things.
  assert.deepEqual(tok('1,900 rows across three warehouses'), []);
});

test('a figure, date or term the message was never given is held back', () => {
  const facts = 'The clean-up is a fixed £4,800. Monthly close is £950 a month on a rolling three month term. About 1,900 VAT rows.';
  const kinds = (body: string) => findInventedSpecifics(body, { facts }).map((h) => h.kind);
  // A correct paraphrase, including the figure spelled out, is clean.
  assert.deepEqual(kinds('The clean-up is four thousand eight hundred pounds and the close is £950 a month on a rolling three month term.'), []);
  // "three-year" where the conversation said three months.
  assert.deepEqual(kinds('£950 a month on a rolling three-year term.'), ['invented_term']);
  // A price nobody gave it.
  assert.deepEqual(kinds('It costs $150 per month.'), ['invented_figure']);
  // A time nobody proposed.
  assert.deepEqual(kinds('Would Tuesday at 10am suit you?'), ['invented_date']);
  // A document that does not exist.
  assert.deepEqual(findInventedSpecifics('Please find the plan attached.', { facts }).map((h) => h.kind), ['false_attachment']);
  // ...unless it does.
  assert.deepEqual(findInventedSpecifics('Please find the plan attached.', { facts, hasAttachment: true }), []);
});

test('a model arguing with its own prompt inside the email is caught', () => {
  // Taken verbatim from a campaign preview the guard previously called ready
  // to send.
  const leaked = [
    'Hi Dana,',
    '',
    'I am pleased to say our same-day reports are live.',
    '',
    '"Hi Dana," should not precede the text as per strict instruction about no other name usage but the prompt requires it exactly. Wait, re-reading rule: ... Okay. Proceeding.',
  ].join('\n');
  const hits = findTemplateArtifacts({ text: leaked });
  assert.equal(hits.some((h) => h.kind === 'prompt_leak'), true, 'inline reasoning must be caught, not only line-anchored labels');
  // Ordinary prose that happens to contain one of those words is not a leak.
  assert.deepEqual(findTemplateArtifacts({ text: 'Hi Dana,\n\nI will check the rule about VAT on freight and come back to you.' }), []);
  assert.deepEqual(findTemplateArtifacts({ text: 'Hi Dana,\n\nLet me know what works best and I will hold the slot.' }), []);
});

test('a whole email arriving as a subject line is cut down to one', () => {
  const wholeEmail = 'Hi Dana, Same-day bookkeeping reports are now live through January for our Northwind Supply team. Given your experience managing Sage across multiple warehouses in Leeds, could we schedule a quick walk-through sometime next week?';
  const subject = cleanOutput(wholeEmail, 'subject');
  assert.ok(subject.length <= 90, `subject is ${subject.length} chars: ${subject}`);
  assert.ok(!/^hi\b/i.test(subject), 'the greeting is dropped');
  // A subject that is already a subject is left exactly as it is.
  assert.equal(cleanOutput('Same-Day Bookkeeping Reports Free Until January', 'subject'), 'Same-Day Bookkeeping Reports Free Until January');
});

test('a weekday proposed with a time of day counts as a specific', () => {
  const facts = 'Ask if they would like a 15 minute walkthrough next week.';
  const kinds = (b: string) => findInventedSpecifics(b, { facts }).map((h) => h.kind);
  assert.deepEqual(kinds('Would Tuesday afternoon work for the walkthrough?'), ['invented_date']);
  // A weekday on its own is a pleasantry, not a proposal.
  assert.deepEqual(kinds('Hope you have a good Monday.'), []);
});
