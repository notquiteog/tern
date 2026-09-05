import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactContext, htmlToText, listFields, renderHtml, renderText, textToHtml } from './merge.js';

test('renderText substitutes fields and fallbacks', () => {
  const ctx = { first_name: 'Ada', company: '' };
  assert.equal(renderText('Hi {{first_name}} at {{company|your team}}', ctx), 'Hi Ada at your team');
  assert.equal(renderText('{{ missing | there }}', ctx), 'there');
  assert.equal(renderText('{{missing}}', ctx), '');
});

test('renderHtml escapes values but not trusted keys', () => {
  assert.equal(renderHtml('<p>{{name}}</p>', { name: '<b>x</b>' }), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.equal(renderHtml('{{signature}}', { signature: '<i>sig</i>' }), '<i>sig</i>');
});

test('contactContext exposes derived and custom fields', () => {
  const ctx = contactContext({ email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', fields: { city: 'London' } }, { sender_name: 'Bob' });
  assert.equal(ctx.full_name, 'Ada Lovelace');
  assert.equal(ctx.domain, 'example.com');
  assert.equal(ctx.city, 'London');
  assert.equal(ctx.sender_name, 'Bob');
});

test('listFields finds unique field names', () => {
  assert.deepEqual(listFields('{{a}} {{b|x}} {{a}}'), ['a', 'b']);
});

test('html/text conversions round trip the basics', () => {
  assert.equal(htmlToText('<p>Hello <b>you</b></p><p>Bye</p>'), 'Hello you\n\nBye');
  assert.equal(textToHtml('a\n\nb<c'), '<p>a</p><p>b&lt;c</p>');
});
