// Reading a sign-off, which is pattern matching rather than a model.
//
// The cases here are the ones that decide whether this is worth having. A
// parser that finds the job title in a tidy four-line signature is easy; one
// that does not mistake the legal footer for a company, does not read the
// quoted conversation below the reply, and does not take the sender's own name
// for a job title is the one that can be offered to somebody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSignature, signatureBlock } from './enrich.js';

const read = (body: string, name?: string) => readSignature(signatureBlock(body), name);

test('the standard delimiter starts the signature', () => {
  const body = [
    'Thanks for sending that over — Thursday works.',
    '',
    '--',
    'Dana Okafor',
    'Head of Operations, Meridian Logistics Ltd',
    '+44 20 7946 0958',
    'meridian-logistics.co.uk',
  ].join('\n');
  const found = read(body, 'Dana Okafor');
  assert.equal(found.title, 'Head of Operations');
  assert.equal(found.company, 'Meridian Logistics Ltd');
  assert.equal(found.phone, '+44 20 7946 0958');
  assert.equal(found.website, 'meridian-logistics.co.uk');
});

test('a sign-off line works when there is no delimiter', () => {
  const body = [
    'Sounds good.',
    '',
    'Best,',
    'Sam Whitfield',
    'Senior Engineer',
    'Ardent Systems',
  ].join('\n');
  const found = read(body, 'Sam Whitfield');
  assert.equal(found.title, 'Senior Engineer');
  assert.equal(found.company, 'Ardent Systems');
});

test('the sender\'s own name is not read as a job title', () => {
  // The commonest first line in a signature, and the commonest way a parser
  // like this embarrasses itself.
  const body = 'Cheers,\n\nPriya Raman\nDirector of Partnerships';
  const found = read(body, 'Priya Raman');
  assert.equal(found.title, 'Director of Partnerships');
  assert.ok(!/Priya/.test(found.company ?? ''));
});

test('the quoted conversation below a reply is never read', () => {
  // Every signature in a long thread but the newest belongs to somebody else,
  // or to an older version of this person's job.
  const body = [
    'Yes, that works.',
    '',
    '--',
    'Dana Okafor',
    'Head of Operations',
    '',
    'On Tuesday, Alex Cole wrote:',
    '> Thanks!',
    '> --',
    '> Alex Cole',
    '> Chief Executive, Someone Else Ltd',
  ].join('\n');
  const found = read(body, 'Dana Okafor');
  assert.equal(found.title, 'Head of Operations');
  assert.ok(!/Someone Else/.test(found.company ?? ''), 'read the quoted signature');
});

test('a corporate footer is not mistaken for the person', () => {
  const body = [
    'See attached.',
    '',
    '--',
    'Jo Bright',
    'Account Manager',
    '',
    'This email and any attachments are confidential and intended solely for the addressee.',
    'Registered in England and Wales, company number 04569321. VAT GB 123 4567 89.',
    'Please consider the environment before printing this email.',
  ].join('\n');
  const found = read(body, 'Jo Bright');
  assert.equal(found.title, 'Account Manager');
  assert.ok(!/England|company number|VAT/i.test(found.company ?? ''), 'read the legal footer as a company');
});

test('a line naming both is split on its separator', () => {
  for (const line of ['Head of Design | Northwind Studio', 'Head of Design · Northwind Studio', 'Head of Design — Northwind Studio']) {
    const found = read(`Regards,\n\nLee Park\n${line}`, 'Lee Park');
    assert.equal(found.title, 'Head of Design', `failed on: ${line}`);
    assert.equal(found.company, 'Northwind Studio', `failed on: ${line}`);
  }
});

test('an address on a line is not read as a website', () => {
  const found = read('Thanks,\n\nRae Lin\nProduct Manager\nrae@northwind.example\nnorthwind.example');
  assert.equal(found.website, 'northwind.example');
});

test('a number too short to be a phone number is left alone', () => {
  // An extension, a date or a reference number all match the shape and none of
  // them is a phone number worth writing onto somebody's contact card.
  const found = read('Best,\n\nKim Su\nAnalyst\next 4021');
  assert.equal(found.phone, undefined);
});

test('a message with no signature yields nothing rather than guessing', () => {
  assert.deepEqual(read('Can you send the invoice when you get a chance?'), {});
  assert.deepEqual(signatureBlock(''), []);
});
