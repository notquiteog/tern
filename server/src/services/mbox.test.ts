// The mbox and MIME reader, on the shapes real archives contain: Takeout's
// output, Thunderbird's escaping, encoded subject lines, nested multiparts
// and the many ways a Date header can be wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBody, decodeWords, parseAddresses, parseContentType, parseDate, parseHeaders,
  parseMessage, splitMbox, splitMultipart,
} from './mbox.js';

const mbox = (...messages: string[]) => Buffer.from(messages.join('\n'), 'utf8');

const SIMPLE = [
  'From ana@corp.example Mon Sep  8 09:00:00 2026',
  'Message-ID: <one@corp.example>',
  'From: Ana Duarte <ana@corp.example>',
  'To: me@mine.example',
  'Subject: Quarterly review',
  'Date: Mon, 8 Sep 2026 09:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Shall we meet on Thursday?',
  '',
].join('\n');

// ---------- Splitting ----------

test('an mbox splits on its separator lines', () => {
  const second = SIMPLE.replace('<one@', '<two@').replace('Quarterly review', 'Second message');
  const parts = [...splitMbox(mbox(SIMPLE, second))];
  assert.equal(parts.length, 2);
  assert.match(parts[0].toString(), /Quarterly review/);
  assert.match(parts[1].toString(), /Second message/);
});

test('a "From " inside a paragraph does not split a message', () => {
  const tricky = [
    'From ana@corp.example Mon Sep  8 09:00:00 2026',
    'From: Ana <ana@corp.example>',
    'Subject: Note',
    'Date: Mon, 8 Sep 2026 09:00:00 +0000',
    '',
    'I heard back.',
    'From the desk of somebody else, apparently.',
    '',
  ].join('\n');
  const parts = [...splitMbox(Buffer.from(tricky))];
  assert.equal(parts.length, 1, 'a mid-paragraph From is not a separator');
});

test('a file with leading junk still yields its messages', () => {
  const parts = [...splitMbox(Buffer.from(`some junk\n\n${SIMPLE}`))];
  assert.equal(parts.length, 1);
  assert.match(parts[0].toString(), /Quarterly review/);
});

test('an empty file yields nothing', () => {
  assert.equal([...splitMbox(Buffer.alloc(0))].length, 0);
});

// ---------- Headers ----------

test('folded headers are rejoined', () => {
  const h = parseHeaders('Subject: a very long\n  subject line\nTo: a@b.example');
  assert.equal(h.get('subject'), 'a very long subject line');
  assert.equal(h.get('to'), 'a@b.example');
});

test('header names are matched without regard to case', () => {
  const h = parseHeaders('MESSAGE-ID: <x>\nsubject: y');
  assert.equal(h.get('Message-Id'), '<x>');
  assert.equal(h.get('SUBJECT'), 'y');
});

test('repeated headers are all kept', () => {
  const h = parseHeaders('Received: one\nReceived: two');
  assert.deepEqual(h.all('received'), ['one', 'two']);
});

// ---------- Encoded words ----------

test('encoded subject lines are decoded, in both encodings', () => {
  assert.equal(decodeWords('=?utf-8?B?UmVjaG51bmc=?='), 'Rechnung');
  assert.equal(decodeWords('=?utf-8?Q?Caf=C3=A9?='), 'Café');
  assert.equal(decodeWords('=?iso-8859-1?Q?Gr=FC=DFe?='), 'Grüße');
});

test('adjacent encoded words join without the whitespace between them', () => {
  // RFC 2047: whitespace separating two encoded words is not part of the
  // text. Getting this wrong puts a space in the middle of a word.
  assert.equal(decodeWords('=?utf-8?Q?Rech?= =?utf-8?Q?nung?='), 'Rechnung');
});

test('text that is not encoded passes through untouched', () => {
  assert.equal(decodeWords('Plain subject'), 'Plain subject');
  assert.equal(decodeWords('2 + 2 =? 4'), '2 + 2 =? 4');
});

test('an unknown charset falls back rather than losing the line', () => {
  const out = decodeWords('=?x-unknown-charset?B?aGVsbG8=?=');
  assert.match(out, /hello/);
});

// ---------- Addresses ----------

test('address lists are split on the commas that are separators', () => {
  const list = parseAddresses('"Duarte, Ana" <ana@corp.example>, bob@corp.example, Carol <carol@corp.example>');
  assert.deepEqual(list.map((a) => a.email), ['ana@corp.example', 'bob@corp.example', 'carol@corp.example']);
  assert.equal(list[0].name, 'Duarte, Ana');
});

test('an encoded display name is decoded', () => {
  const [a] = parseAddresses('=?utf-8?Q?Ana_Duarte?= <ana@corp.example>');
  assert.equal(a.name, 'Ana Duarte');
});

test('rubbish in an address list is dropped, not guessed at', () => {
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddresses(null), []);
  assert.equal(parseAddresses('a@b.example, not-an-address, c@d.example').length, 2);
});

// ---------- Content-Type and bodies ----------

test('content type parameters are read, including RFC 2231 filenames', () => {
  const ct = parseContentType("multipart/mixed; boundary=\"abc\"; charset=UTF-8");
  assert.equal(ct.type, 'multipart/mixed');
  assert.equal(ct.params.boundary, 'abc');
  const cd = parseContentType("attachment; filename*=utf-8''Rechnung%20M%C3%A4rz.pdf");
  assert.match(cd.params.filename, /Rechnung M/);
});

test('transfer encodings are undone', () => {
  assert.equal(decodeBody(Buffer.from('SGVsbG8gdGhlcmU='), 'base64').toString(), 'Hello there');
  assert.equal(decodeBody(Buffer.from('caf=C3=A9'), 'quoted-printable').toString('utf8'), 'café');
  // A soft line break is removed, not turned into a space.
  assert.equal(decodeBody(Buffer.from('one=\r\ntwo'), 'quoted-printable').toString(), 'onetwo');
  assert.equal(decodeBody(Buffer.from('plain'), null).toString(), 'plain');
});

test('a multipart body splits into its parts and stops at the closing marker', () => {
  const body = Buffer.from([
    '--abc', 'Content-Type: text/plain', '', 'first', '--abc', 'Content-Type: text/html', '', '<p>second</p>', '--abc--', 'trailing junk',
  ].join('\r\n'));
  const parts = splitMultipart(body, 'abc');
  assert.equal(parts.length, 2);
  assert.match(parts[0].toString(), /first/);
  assert.ok(!parts.some((p) => /trailing junk/.test(p.toString())));
});

// ---------- Whole messages ----------

test('a plain message parses end to end', () => {
  const m = parseMessage(Buffer.from(SIMPLE))!;
  assert.equal(m.messageId, 'one@corp.example');
  assert.equal(m.from[0].email, 'ana@corp.example');
  assert.equal(m.from[0].name, 'Ana Duarte');
  assert.equal(m.subject, 'Quarterly review');
  assert.equal(m.date?.toISOString(), '2026-09-08T09:00:00.000Z');
  assert.match(m.text ?? '', /Thursday/);
  assert.equal(m.html, null);
});

test('a multipart/alternative gives up both bodies', () => {
  const raw = [
    'From ana@corp.example Mon Sep  8 09:00:00 2026',
    'From: ana@corp.example',
    'Subject: Both',
    'Date: Mon, 8 Sep 2026 09:00:00 +0000',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain version',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html version</p>',
    '--b1--',
    '',
  ].join('\r\n');
  const m = parseMessage(Buffer.from(raw))!;
  assert.match(m.text ?? '', /plain version/);
  assert.match(m.html ?? '', /html version/);
});

test('attachments are listed without their bytes being kept', () => {
  const raw = [
    'From ana@corp.example Mon Sep  8 09:00:00 2026',
    'From: ana@corp.example',
    'Subject: With a file',
    'Date: Mon, 8 Sep 2026 09:00:00 +0000',
    'Content-Type: multipart/mixed; boundary="b2"',
    '',
    '--b2',
    'Content-Type: text/plain',
    '',
    'see attached',
    '--b2',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjcK',
    '--b2--',
    '',
  ].join('\r\n');
  const m = parseMessage(Buffer.from(raw))!;
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].name, 'invoice.pdf');
  assert.equal(m.attachments[0].type, 'application/pdf');
  assert.match(m.text ?? '', /see attached/);
});

test('mbox escaping is undone', () => {
  const raw = [
    'From ana@corp.example Mon Sep  8 09:00:00 2026',
    'From: ana@corp.example',
    'Subject: Quoting',
    'Date: Mon, 8 Sep 2026 09:00:00 +0000',
    '',
    '>From now on, please use the new address.',
    '>>From the mboxrd convention.',
    '',
  ].join('\n');
  const m = parseMessage(Buffer.from(raw))!;
  assert.match(m.text ?? '', /^From now on/m);
  assert.match(m.text ?? '', /^>From the mboxrd/m);
});

test('threading headers are collected', () => {
  const raw = SIMPLE.replace('Subject:', 'In-Reply-To: <parent@corp.example>\nReferences: <root@corp.example> <parent@corp.example>\nSubject:');
  const m = parseMessage(Buffer.from(raw))!;
  assert.deepEqual(m.inReplyTo, ['parent@corp.example']);
  assert.deepEqual(m.references, ['root@corp.example', 'parent@corp.example']);
});

test('a fragment with no sender, subject or date is rejected', () => {
  assert.equal(parseMessage(Buffer.from('From x\nX-Odd: 1\n\nbody')), null);
  assert.equal(parseMessage(Buffer.alloc(0)), null);
});

test('deeply nested multiparts terminate', () => {
  // Twenty levels of nesting: the parser must stop rather than recurse to
  // the stack limit on a file somebody chose.
  let body = 'Content-Type: text/plain\r\n\r\ndeep';
  for (let i = 0; i < 20; i++) {
    body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
  }
  const raw = `From x\r\nFrom: a@b.example\r\nSubject: Nested\r\nDate: Mon, 8 Sep 2026 09:00:00 +0000\r\n${body}`;
  const m = parseMessage(Buffer.from(raw));
  assert.ok(m, 'it returns rather than overflowing');
});

// ---------- Dates ----------

test('dates parse in the shapes clients actually write', () => {
  const cases: [string, string][] = [
    ['Mon, 8 Sep 2026 09:00:00 +0000', '2026-09-08T09:00:00.000Z'],
    ['Mon, 8 Sep 2026 10:00:00 +0100', '2026-09-08T09:00:00.000Z'],
    ['8 Sep 2026 09:00:00 +0000', '2026-09-08T09:00:00.000Z'],
    ['Mon, 8 Sep 2026 09:00:00 GMT (GMT)', '2026-09-08T09:00:00.000Z'],
  ];
  for (const [input, want] of cases) {
    assert.equal(parseDate(input)?.toISOString(), want, input);
  }
});

test('an unparseable date is null rather than invented', () => {
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('Thu, 1 Jan 1970 00:00:00 +0000'), null, 'the epoch is what a broken client writes');
});
