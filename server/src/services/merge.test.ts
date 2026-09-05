import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactContext, htmlToText, listFields, renderHtml, renderText, textToHtml, validateTemplate } from './merge.js';

test('fields, fallbacks and empty values', () => {
  const ctx = { first_name: 'Ada', company: '' };
  assert.equal(renderText('Hi {{first_name}} at {{company|your team}}', ctx), 'Hi Ada at your team');
  assert.equal(renderText('{{ missing | there }}', ctx), 'there');
  assert.equal(renderText('{{missing}}', ctx), '');
});

test('filters chain and apply after the fallback', () => {
  const ctx = { company: 'acme labs', name: 'ada lovelace', email: 'ada@example.com' };
  assert.equal(renderText('{{company:title}}', ctx), 'Acme Labs');
  assert.equal(renderText("{{company:title:possessive}} team", ctx), "Acme Labs' team");
  assert.equal(renderText('{{name:possessive}}', { name: 'Ada' }), "Ada's");
  assert.equal(renderText('{{name:first:capitalize}}', ctx), 'Ada');
  assert.equal(renderText('{{name:initials}}', ctx), 'AL');
  assert.equal(renderText('{{email:domain}}', ctx), 'example.com');
  assert.equal(renderText('{{nickname:upper|friend}}', ctx), 'FRIEND');
});

test('conditional blocks keep or drop content', () => {
  assert.equal(renderText('Hi{{#if company}} from {{company}}{{/if}}!', { company: 'Acme' }), 'Hi from Acme!');
  assert.equal(renderText('Hi{{#if company}} from {{company}}{{/if}}!', { company: '' }), 'Hi!');
  assert.equal(renderText('{{#unless phone}}What number works?{{/unless}}', { phone: '' }), 'What number works?');
  assert.equal(renderText('{{#unless phone}}What number works?{{/unless}}', { phone: '555' }), '');
  assert.equal(renderText('{{#if a}}A{{#if b}}B{{/if}}{{/if}}', { a: 'x', b: 'y' }), 'AB');
  assert.equal(renderText('{{#if a}}A{{#if b}}B{{/if}}{{/if}}', { a: 'x', b: '' }), 'A');
});

test('variations pick one option and are stable with a seed', () => {
  const out = renderText('{Hi|Hello|Hey} there', {});
  assert.ok(['Hi there', 'Hello there', 'Hey there'].includes(out));
  assert.equal(renderText('{a|b|c} {d|e}', {}, 42), renderText('{a|b|c} {d|e}', {}, 42));
  // a merge fallback with a pipe is not a variation
  assert.equal(renderText('{{x|one or two}}', {}), 'one or two');
});

test('html rendering escapes values except trusted keys', () => {
  assert.equal(renderHtml('<p>{{name}}</p>', { name: '<b>x</b>' }), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.equal(renderHtml('{{signature}}', { signature: '<i>sig</i>' }), '<i>sig</i>');
});

test('listFields and validateTemplate', () => {
  assert.deepEqual(listFields('{{a}} {{b|x}} {{#if c}}{{a:upper}}{{/if}}'), ['a', 'b', 'c']);
  assert.deepEqual(validateTemplate('{{#if a}}ok{{/if}} {{name:upper}}'), []);
  assert.ok(validateTemplate('{{#if a}}oops').some((e) => e.includes('{{/if}}')));
  assert.ok(validateTemplate('{{name:shout}}').some((e) => e.includes('shout')));
  assert.ok(validateTemplate('{{broken').length > 0);
});

test('contactContext exposes derived, date and custom fields', () => {
  const ctx = contactContext({ email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', fields: { city: 'London' } }, { sender_name: 'Bob' });
  assert.equal(ctx.full_name, 'Ada Lovelace');
  assert.equal(ctx.domain, 'example.com');
  assert.equal(ctx.city, 'London');
  assert.equal(ctx.sender_name, 'Bob');
  assert.equal(ctx.year, String(new Date().getFullYear()));
  assert.ok(/^Good (morning|afternoon|evening)$/.test(String(ctx.greeting)));
});

test('html/text conversions round trip the basics', () => {
  assert.equal(htmlToText('<p>Hello <b>you</b></p><p>Bye</p>'), 'Hello you\n\nBye');
  assert.equal(textToHtml('a\n\nb<c'), '<p>a</p><p>b&lt;c</p>');
});
