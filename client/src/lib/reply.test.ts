import './testdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForwardHtml, buildQuoteHtml, forwardSubject, parseListUnsubscribe, replyRecipients, replySubject } from './reply';

const alice = { name: 'Alice', email: 'alice@probe.test' };
const bob = { name: 'Bob', email: 'bob@probe.test' };
const carol = { name: 'Carol', email: 'carol@probe.test' };
const dave = { name: null, email: 'dave@probe.test' };
const list = { name: 'Team list', email: 'team@lists.example' };
const emails = (l: { email: string }[]) => l.map((a) => a.email);

test('reply: sender only', () => {
  const r = replyRecipients({ from: [bob], to: [alice], cc: [carol] }, 'alice@probe.test');
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
  assert.deepEqual(r.cc, []);
});
test('reply all: everyone else in cc, nobody twice, never me', () => {
  const r = replyRecipients({ from: [bob], to: [alice, carol], cc: [dave, bob] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
  assert.deepEqual(emails(r.cc), ['carol@probe.test', 'dave@probe.test']);
});
test('Reply-To beats From', () => {
  assert.deepEqual(emails(replyRecipients({ from: [bob], replyTo: [list], to: [alice] }, 'alice@probe.test').to), ['team@lists.example']);
});
test('replying to my own sent mail goes to its recipients', () => {
  const r = replyRecipients({ from: [alice], to: [bob, carol], cc: [dave] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['bob@probe.test', 'carol@probe.test']);
  assert.deepEqual(emails(r.cc), ['dave@probe.test']);
});
test('note to self', () => {
  assert.deepEqual(emails(replyRecipients({ from: [alice], to: [alice] }, 'alice@probe.test').to), ['alice@probe.test']);
});
test('case and whitespace do not create duplicates', () => {
  const r = replyRecipients({ from: [{ email: ' Bob@Probe.Test ' }], to: [{ email: 'ALICE@probe.test' }], cc: [{ email: 'bob@probe.test' }] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['Bob@Probe.Test']);
  assert.deepEqual(r.cc, []);
});
test('aliases of mine are excluded too', () => {
  const r = replyRecipients({ from: [bob], to: [alice, { email: 'alias@probe.test' }], cc: [carol] }, ['alice@probe.test', 'alias@probe.test'], true);
  assert.deepEqual(emails(r.cc), ['carol@probe.test']);
});
test('garbage entries are ignored', () => {
  const r = replyRecipients({ from: [{ email: '' } as any, bob], to: [null as any, { email: 'nope' }, alice] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
});
test('empty source', () => { assert.deepEqual(replyRecipients({}, 'a@b.c', true), { to: [], cc: [] }); });
test('subjects', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('Re: Hello'), 'Re: Hello');
  assert.equal(replySubject('AW: Hello'), 'Re: Hello');
  assert.equal(replySubject(''), 'Re: (no subject)');
  assert.equal(forwardSubject('Hello'), 'Fwd: Hello');
  assert.equal(forwardSubject('FWD: Hello'), 'FWD: Hello');
  assert.equal(forwardSubject('Re: Hello'), 'Fwd: Re: Hello');
});
test('quote header names the writer and wraps the original in the marker div', () => {
  const q = buildQuoteHtml({ received_at: '2026-09-05T10:00:00Z', from_addr: [bob], body_html: '<p>Hi <b>there</b></p>' });
  assert.ok(q.startsWith('<div class="tern-quote">'));
  assert.ok(q.includes('Bob &lt;bob@probe.test&gt; wrote:'));
  assert.ok(q.includes('<blockquote') && q.includes('<p>Hi <b>there</b></p>'));
});
test('quote of a text-only message escapes it and keeps line breaks', () => {
  const q = buildQuoteHtml({ received_at: '2026-09-05T10:00:00Z', from_addr: [bob], body_text: 'line 1\n<not a tag>' });
  assert.ok(q.includes('white-space:pre-wrap'));
  assert.ok(q.includes('&lt;not a tag&gt;'));
});
test('forward header lists From, Date, Subject, To and Cc', () => {
  const f = buildForwardHtml({ received_at: '2026-09-05T10:00:00Z', from_addr: [bob], to_addr: [alice], cc_addr: [carol], subject: 'Plan', body_html: '<p>x</p>' });
  assert.ok(f.includes('Forwarded message'));
  for (const s of ['From: Bob', 'Subject: Plan', 'To: Alice', 'Cc: Carol']) assert.ok(f.includes(s), s);
  assert.ok(f.endsWith('<p>x</p></div>'));
});
test('List-Unsubscribe parsing handles mailto, https, both, and subjects', () => {
  assert.deepEqual(parseListUnsubscribe('<mailto:leave@lists.example?subject=unsubscribe%20me>, <https://lists.example/u/1>'), { mailto: 'leave@lists.example', subject: 'unsubscribe me', url: 'https://lists.example/u/1' });
  assert.deepEqual(parseListUnsubscribe('<https://x.example/u>'), { mailto: null, subject: null, url: 'https://x.example/u' });
  assert.deepEqual(parseListUnsubscribe('<mailto:a@b.c>'), { mailto: 'a@b.c', subject: null, url: null });
  assert.deepEqual(parseListUnsubscribe(null), { mailto: null, subject: null, url: null });
  assert.deepEqual(parseListUnsubscribe('garbage'), { mailto: null, subject: null, url: null });
});
