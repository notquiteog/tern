import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSendable, findTemplateArtifacts, TemplateGuardError } from './guard.js';

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
