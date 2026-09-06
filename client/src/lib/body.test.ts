import './testdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlankHtml, joinBody, mentionsAttachment, signatureBlock, splitBody } from './body';

test('splitBody separates typed text, signature and quote', () => {
  const html = '<p>Hello</p><div class="tern-signature" style="margin-top:16px">Alex · Tern</div><div class="tern-quote"><blockquote>old</blockquote></div>';
  assert.deepEqual(splitBody(html), { main: '<p>Hello</p>', signature: 'Alex · Tern', quote: '<div class="tern-quote"><blockquote>old</blockquote></div>' });
});
test('splitBody without signature or quote', () => {
  assert.deepEqual(splitBody('<p>Just text</p>'), { main: '<p>Just text</p>', signature: null, quote: null });
  assert.deepEqual(splitBody(''), { main: '', signature: null, quote: null });
});
test('text after the quote belongs to the quote', () => {
  const r = splitBody('<p>a</p><div class="tern-quote">q</div><p>trailing</p>');
  assert.equal(r.main, '<p>a</p>');
  assert.equal(r.quote, '<div class="tern-quote">q</div><p>trailing</p>');
});
test('a signature placed after the quote (responder drafts) is still found', () => {
  const r = splitBody('<p>a</p><div class="tern-quote">q</div><div class="tern-signature">sig</div>');
  assert.equal(r.signature, 'sig');
  assert.equal(r.quote, '<div class="tern-quote">q</div>');
  assert.equal(r.main, '<p>a</p>');
});
test('joinBody puts them back in order and skips empty parts', () => {
  assert.equal(joinBody({ main: '<p>a</p>', signature: 'S', quote: '<div class="tern-quote">q</div>' }), '<p>a</p>' + signatureBlock('S') + '<div class="tern-quote">q</div>');
  assert.equal(joinBody({ main: '<p>a</p>', signature: '  ', quote: null }), '<p>a</p>');
  assert.equal(joinBody({ main: '', signature: null, quote: null }), '');
});
test('split and join round-trip', () => {
  const html = '<p>x</p>' + signatureBlock('<b>Me</b>') + '<div class="tern-quote">q</div>';
  assert.equal(joinBody(splitBody(html)), html);
});
test('isBlankHtml', () => {
  assert.equal(isBlankHtml(''), true);
  assert.equal(isBlankHtml('<p><br></p>'), true);
  assert.equal(isBlankHtml('<p>&nbsp;</p>'), true);
  assert.equal(isBlankHtml('<p>hi</p>'), false);
  assert.equal(isBlankHtml('<img src="x">'), false);
});
test('mentionsAttachment catches the usual phrasings', () => {
  for (const s of ['Please see attached.', 'I have attached the invoice', 'See the attachment', 'Enclosed is the contract', 'the file is attached', 'PDF attached', 'attaching the deck']) assert.equal(mentionsAttachment(s), true, s);
});
test('mentionsAttachment leaves innocent text alone', () => {
  for (const s of ['Let us meet tomorrow', 'I am quite detached from it', 'Thanks!', '']) assert.equal(mentionsAttachment(s), false, s);
});
test('signatureBlock carries the marker class', () => {
  assert.ok(signatureBlock('x').startsWith('<div class="tern-signature"'));
});
