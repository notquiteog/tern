import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardSubject, replyRecipients, replySubject } from './reply.js';

const alice = { name: 'Alice', email: 'alice@probe.test' };
const bob = { name: 'Bob', email: 'bob@probe.test' };
const carol = { name: 'Carol', email: 'carol@probe.test' };
const dave = { name: null, email: 'dave@probe.test' };
const list = { name: 'Team list', email: 'team@lists.example' };
const emails = (l: { email: string }[]) => l.map((a) => a.email);

test('reply goes to the sender only', () => {
  const r = replyRecipients({ from: [bob], to: [alice], cc: [carol] }, 'alice@probe.test');
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
  assert.deepEqual(r.cc, []);
});

test('reply all adds every other To and Cc recipient without duplicating the sender or me', () => {
  const r = replyRecipients({ from: [bob], to: [alice, carol], cc: [dave, bob] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
  assert.deepEqual(emails(r.cc), ['carol@probe.test', 'dave@probe.test']);
});

test('Reply-To wins over From', () => {
  const r = replyRecipients({ from: [bob], replyTo: [list], to: [alice] }, 'alice@probe.test');
  assert.deepEqual(emails(r.to), ['team@lists.example']);
});

test('Reply-To with reply all keeps the original sender in cc when they are not the Reply-To', () => {
  const r = replyRecipients({ from: [bob], replyTo: [list], to: [alice], cc: [carol] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['team@lists.example']);
  assert.deepEqual(emails(r.cc), ['carol@probe.test']);
});

test('replying to my own sent message answers the people I wrote to', () => {
  const r = replyRecipients({ from: [alice], to: [bob, carol], cc: [dave] }, 'alice@probe.test');
  assert.deepEqual(emails(r.to), ['bob@probe.test', 'carol@probe.test']);
  const all = replyRecipients({ from: [alice], to: [bob, carol], cc: [dave] }, 'alice@probe.test', true);
  assert.deepEqual(emails(all.to), ['bob@probe.test', 'carol@probe.test']);
  assert.deepEqual(emails(all.cc), ['dave@probe.test']);
});

test('a note to self replies to me', () => {
  const r = replyRecipients({ from: [alice], to: [alice] }, 'alice@probe.test');
  assert.deepEqual(emails(r.to), ['alice@probe.test']);
});

test('addresses compare case-insensitively and with surrounding whitespace', () => {
  const r = replyRecipients({ from: [{ name: 'Bob', email: ' Bob@Probe.Test ' }], to: [{ email: 'ALICE@probe.test' }], cc: [{ email: 'bob@probe.test' }] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['Bob@Probe.Test']);
  assert.deepEqual(r.cc, []);
});

test('several own addresses (aliases) are all excluded', () => {
  const r = replyRecipients({ from: [bob], to: [alice, { email: 'alias@probe.test' }], cc: [carol] }, ['alice@probe.test', 'alias@probe.test'], true);
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
  assert.deepEqual(emails(r.cc), ['carol@probe.test']);
});

test('malformed and empty entries are ignored', () => {
  const r = replyRecipients({ from: [{ email: '' } as any, bob], to: [null as any, { email: 'not-an-address' }, alice], cc: [undefined as any] }, 'alice@probe.test', true);
  assert.deepEqual(emails(r.to), ['bob@probe.test']);
  assert.deepEqual(r.cc, []);
});

test('missing headers give an empty reply rather than a crash', () => {
  const r = replyRecipients({}, 'alice@probe.test', true);
  assert.deepEqual(r, { to: [], cc: [] });
});

test('names travel with the address', () => {
  const r = replyRecipients({ from: [bob], to: [alice], cc: [carol] }, 'alice@probe.test', true);
  assert.equal(r.to[0].name, 'Bob');
  assert.equal(r.cc[0].name, 'Carol');
});

test('reply subjects get exactly one Re: and forwards exactly one Fwd:', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('Re: Hello'), 'Re: Hello');
  assert.equal(replySubject('RE: Hello'), 'RE: Hello');
  assert.equal(replySubject('Fwd: Hello'), 'Re: Fwd: Hello');
  assert.equal(replySubject('AW: Hello'), 'Re: Hello');
  assert.equal(replySubject(''), 'Re: (no subject)');
  assert.equal(replySubject(null), 'Re: (no subject)');
  assert.equal(forwardSubject('Hello'), 'Fwd: Hello');
  assert.equal(forwardSubject('Fwd: Hello'), 'Fwd: Hello');
  assert.equal(forwardSubject('FW: Hello'), 'FW: Hello');
  assert.equal(forwardSubject('Re: Hello'), 'Fwd: Re: Hello');
  assert.equal(forwardSubject(undefined), 'Fwd: (no subject)');
});
