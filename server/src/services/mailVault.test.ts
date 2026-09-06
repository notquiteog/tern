// What is sealed, what is left plain, and what a caller gets back. The
// column-level rules matter as much as the cipher: a field quietly left in
// the clear, or one handed to a caller still as ciphertext, is the whole
// point of this layer failing silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDraftWith, openEmailWith, openReviewWith } from './mailVault.js';
import { indexTermsWith, searchKey, sealWith, termsOverlap, queryTermGroupsWith } from './vault.js';

const DEK = Buffer.alloc(32, 3);
const SK = searchKey(DEK);
const seal = (v: string) => sealWith(DEK, v)!;
const sealJson = (v: unknown) => sealWith(DEK, JSON.stringify(v))!;

test('a message row opens into the shape the app has always seen', () => {
  const row = openEmailWith(DEK, {
    jmap_id: 'm1',
    received_at: '2026-01-01',
    mailbox_ids: ['inbox'],
    keywords: ['$seen'],
    subject: seal('Quarterly invoice'),
    preview: seal('Please find it attached'),
    body_text: seal('The body'),
    body_html: seal('<p>The body</p>'),
    from_addr: sealJson([{ name: 'Ana', email: 'Ana@Corp.Example' }]),
    to_addr: sealJson([{ name: null, email: 'me@corp.example' }]),
    cc_addr: sealJson([]),
    attachments: sealJson([{ name: 'invoice.pdf', type: 'application/pdf' }]),
    search_terms: [Buffer.from('secret')],
    address_terms: [Buffer.from('secret')],
    from_terms: [Buffer.from('secret')],
  });
  assert.equal(row.subject, 'Quarterly invoice');
  assert.equal(row.body_html, '<p>The body</p>');
  assert.deepEqual(row.from_addr, [{ name: 'Ana', email: 'Ana@Corp.Example' }]);
  assert.deepEqual(row.attachments, [{ name: 'invoice.pdf', type: 'application/pdf' }]);
  // The columns that were never secret are untouched.
  assert.equal(row.jmap_id, 'm1');
  assert.deepEqual(row.mailbox_ids, ['inbox']);
});

test('from_email is recomputed, lowercased, from the opened sender', () => {
  const row = openEmailWith(DEK, { from_addr: sealJson([{ name: 'Ana', email: 'Ana@Corp.Example' }]) });
  assert.equal(row.from_email, 'ana@corp.example');
});

test('a message with no sender gets a null from_email rather than a crash', () => {
  assert.equal(openEmailWith(DEK, { from_addr: sealJson([]) }).from_email, null);
});

test('index terms never reach a caller', () => {
  const row = openEmailWith(DEK, { subject: seal('x'), search_terms: [Buffer.from('a')], address_terms: [Buffer.from('b')], from_terms: [Buffer.from('c')] });
  assert.equal('search_terms' in row, false);
  assert.equal('address_terms' in row, false);
  assert.equal('from_terms' in row, false);
});

test('a row from before the migration opens unchanged', () => {
  const row = openEmailWith(DEK, {
    subject: 'Plain old subject',
    from_addr: '[{"name":"Ana","email":"ana@corp.example"}]',
    attachments: '[]',
  });
  assert.equal(row.subject, 'Plain old subject');
  assert.equal(row.from_email, 'ana@corp.example');
  assert.deepEqual(row.attachments, []);
});

test('a JSONB column mid-migration is not mistaken for ciphertext', () => {
  // Postgres hands back a parsed value while the column is still JSONB. That
  // is the plaintext this replaces, not something to fail on.
  const row = openEmailWith(DEK, { from_addr: [{ name: 'Ana', email: 'ana@corp.example' }] as any });
  assert.deepEqual(row.from_addr, [{ name: 'Ana', email: 'ana@corp.example' }]);
  assert.equal(row.from_email, 'ana@corp.example');
});

test('an unopenable value degrades rather than throws', () => {
  const row = openEmailWith(DEK, { subject: 'k1.rubbish', body_text: 'k1.rubbish', from_addr: 'k1.rubbish' });
  assert.equal(row.subject, '');
  assert.equal(row.body_text, null);
  assert.deepEqual(row.from_addr, []);
});

test('a draft opens its subject, body and every recipient list', () => {
  const d = openDraftWith(DEK, {
    id: 7,
    account_id: 1,
    attachment_ids: [3],
    subject: seal('Draft subject'),
    body_html: seal('<p>Hi</p>'),
    to_addr: sealJson([{ name: null, email: 'a@x.test' }]),
    cc_addr: sealJson([{ name: null, email: 'b@x.test' }]),
    bcc_addr: sealJson([]),
  });
  assert.equal(d.subject, 'Draft subject');
  assert.equal(d.body_html, '<p>Hi</p>');
  assert.equal(d.to_addr![0].email, 'a@x.test');
  assert.equal(d.cc_addr![0].email, 'b@x.test');
  assert.deepEqual(d.bcc_addr, []);
  // Upload ids are this user's own files, keyed by number: not secret.
  assert.deepEqual(d.attachment_ids, [3]);
});

test('a draft that is pushed to the mail server must be opened first', () => {
  // The regression this guards: building a message from the stored row gives
  // ciphertext where addresses belong, and `to.map` on a string throws.
  const stored = { to_addr: sealJson([{ name: null, email: 'a@x.test' }]), subject: seal('s'), body_html: seal('b') };
  assert.equal(typeof stored.to_addr, 'string');
  assert.equal(Array.isArray(openDraftWith(DEK, stored).to_addr), true);
});

test('a review item opens its reply and the context it answers', () => {
  const r = openReviewWith(DEK, {
    subject: seal('Re: your question'),
    body_html: seal('<p>Answer</p>'),
    context: seal('the original message text'),
    to_addr: sealJson([{ name: null, email: 'them@x.test' }]),
    ai_model: 'qwen',
  });
  assert.equal(r.subject, 'Re: your question');
  assert.equal(r.context, 'the original message text');
  assert.equal(r.to_addr![0].email, 'them@x.test');
  assert.equal(r.ai_model, 'qwen');
});

test('a review item with no context stays null', () => {
  assert.equal(openReviewWith(DEK, { context: null }).context, null);
});

test('the body is indexed by its text, not its markup', () => {
  // Tag names would otherwise fill every message with the same few hashes.
  const terms = indexTermsWith(SK, '<div class="wrapper"><p>quarterly invoice</p></div>');
  const hits = (w: string) => queryTermGroupsWith(SK, w).every((g) => termsOverlap(terms, g));
  assert.equal(hits('invoice'), true);
  assert.equal(hits('div'), true, 'raw markup would index the tag name');
});
