import './testdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitQuotedHtml, splitQuotedText } from './quote';

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('Gmail: div.gmail_quote after the reply', () => {
  const r = splitQuotedHtml('<div dir="ltr">Sounds good, see you then.</div><br><div class="gmail_quote"><div>On Mon, Bob wrote:</div><blockquote>Can we meet?</blockquote></div>');
  assert.equal(text(r.main), 'Sounds good, see you then.');
  assert.ok(r.quoted && r.quoted.includes('gmail_quote') && text(r.quoted).includes('Can we meet?'));
});
test('Apple Mail: "On … wrote:" then blockquote type=cite', () => {
  const r = splitQuotedHtml('<div>Yes please.</div><div><br></div><div>On 5 Sep 2026, at 10:00, Bob &lt;bob@probe.test&gt; wrote:</div><br><blockquote type="cite"><div>Coffee?</div></blockquote>');
  assert.equal(text(r.main), 'Yes please.');
  assert.ok(text(r.quoted!).startsWith('On 5 Sep 2026'));
});
test('Outlook: bold From/Sent/To/Subject header block', () => {
  const r = splitQuotedHtml('<p>Thanks, noted.</p><div style="border-top:1px solid"><p><b>From:</b> Bob<br><b>Sent:</b> Monday<br><b>To:</b> Alice<br><b>Subject:</b> Plan</p></div><p>Original text here</p>');
  assert.equal(text(r.main), 'Thanks, noted.');
  assert.ok(text(r.quoted!).includes('Original text here'));
});
test('Outlook: hr followed by the header block', () => {
  const r = splitQuotedHtml('<p>Reply text</p><hr><div><b>From:</b> Bob<br><b>Sent:</b> Mon<br><b>To:</b> Me<br><b>Subject:</b> Hi</div><p>body</p>');
  assert.equal(text(r.main), 'Reply text');
  assert.ok(r.quoted!.startsWith('<hr>'));
});
test('Tern: our own quote wrapper', () => {
  const r = splitQuotedHtml('<p>Sure.</p><div class="tern-quote"><div>On x, y wrote:</div><blockquote>orig</blockquote></div>');
  assert.equal(text(r.main), 'Sure.');
  assert.equal(text(r.quoted!), 'On x, y wrote: orig');
});
test('Yahoo and Proton containers', () => {
  assert.equal(text(splitQuotedHtml('<div>ok</div><div class="yahoo_quoted"><div>old</div></div>').main), 'ok');
  assert.equal(text(splitQuotedHtml('<div>ok</div><div class="protonmail_quote">old</div>').main), 'ok');
});
test('"-----Original Message-----" marker', () => {
  const r = splitQuotedHtml('<div>Will do.</div><div>-----Original Message-----</div><div>From: Bob</div><div>text</div>');
  assert.equal(text(r.main), 'Will do.');
  assert.ok(text(r.quoted!).startsWith('-----Original Message-----'));
});
test('a reply written below the quote is never hidden', () => {
  const r = splitQuotedHtml('<div>Top line</div><blockquote>quoted stuff</blockquote><div>My answer is below the quote.</div>');
  assert.equal(r.quoted, null);
  assert.ok(r.main.includes('My answer'));
});
test('a message that is nothing but a quote (a forward) is left whole', () => {
  const r = splitQuotedHtml('<div class="gmail_quote"><div>---------- Forwarded message ---------</div><div>body</div></div>');
  assert.equal(r.quoted, null);
});
test('message without any quote is untouched', () => {
  const html = '<p>Hello</p><p>World</p>';
  assert.deepEqual(splitQuotedHtml(html), { main: html, quoted: null });
  assert.deepEqual(splitQuotedHtml(''), { main: '', quoted: null });
});
test('everything wrapped in one outer div (common in HTML mail) still splits', () => {
  const r = splitQuotedHtml('<div class="wrapper"><div>Fine by me</div><div class="gmail_quote"><blockquote>old</blockquote></div></div>');
  assert.equal(text(r.main), 'Fine by me');
  assert.equal(text(r.quoted!), 'old');
});
test('a blockquote used for emphasis in the middle of a newsletter does not split', () => {
  const r = splitQuotedHtml('<p>Intro</p><blockquote>Quote of the day</blockquote><p>More news after the quote.</p>');
  assert.equal(r.quoted, null);
});
test('images count as content, so an image-only reply above a quote is kept', () => {
  const r = splitQuotedHtml('<img src="cid:x"><div class="gmail_quote">old</div>');
  assert.equal(r.main, '<img src="cid:x">');
  assert.equal(text(r.quoted!), 'old');
});
test('trailing whitespace and <br> after the quote still count as trailing', () => {
  const r = splitQuotedHtml('<div>Yes</div><blockquote>old</blockquote><br>\n<div>&nbsp;</div>');
  assert.equal(text(r.main), 'Yes');
});
test('German and French wrote lines', () => {
  assert.equal(text(splitQuotedHtml('<div>Ja</div><div>Am 05.09.2026 um 10:00 schrieb Bob:</div><blockquote>x</blockquote>').main), 'Ja');
  assert.equal(text(splitQuotedHtml('<div>Oui</div><div>Le 5 sept. 2026 à 10:00, Bob a écrit :</div><blockquote>x</blockquote>').main), 'Oui');
});

test('plain text: "> " lines to the end', () => {
  const r = splitQuotedText('Sounds good.\n\n> Can we meet?\n> Tomorrow?');
  assert.equal(r.main, 'Sounds good.');
  assert.equal(r.quoted, '> Can we meet?\n> Tomorrow?');
});
test('plain text: wrote line wrapped over two lines', () => {
  const r = splitQuotedText('Yes.\n\nOn Mon, 5 Sep 2026 at 10:00, Bob Probe\n<bob@probe.test> wrote:\n> hi');
  assert.equal(r.main, 'Yes.');
  assert.ok(r.quoted!.startsWith('On Mon'));
});
test('plain text: original message rule', () => {
  const r = splitQuotedText('Noted.\n-----Original Message-----\nFrom: Bob\n\nhello');
  assert.equal(r.main, 'Noted.');
});
test('plain text: quote lines with a reply after them are not split', () => {
  assert.equal(splitQuotedText('> old\n\nmy answer').quoted, null);
});
test('plain text: quote-only and empty', () => {
  assert.equal(splitQuotedText('> only quote').quoted, null);
  assert.equal(splitQuotedText('').quoted, null);
});
