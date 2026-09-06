// What the four tabs must get right. The expensive mistake is filing a
// message a person wrote into Promotions, so most of these check that
// ordinary mail stays in Primary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { categorize, looksAutomated, isCategory } from './categorize.js';

test('a person writing to a person is Primary', () => {
  assert.equal(categorize({ subject: 'Tuesday?', fromEmail: 'dana@acme.test', fromName: 'Dana Reed' }), 'primary');
  assert.equal(categorize({ subject: 'Re: the contract', fromEmail: 'lee@firm.test' }), 'primary');
  // No headers at all: nothing to go on, so nothing is filed away.
  assert.equal(categorize({}), 'primary');
});

test('a subject full of marketing words still stays put without bulk headers', () => {
  // A colleague can write "the sale closed" without it being an advert.
  assert.equal(categorize({ subject: 'the sale closed today', fromEmail: 'dana@acme.test' }), 'primary');
  assert.equal(categorize({ subject: 'exclusive: our new pricing', fromEmail: 'lee@firm.test' }), 'primary');
});

test('a contact is never filed away, whatever the headers say', () => {
  const bulk = { listUnsubscribe: '<https://x.test/u>', precedence: 'bulk', subject: '50% off everything', fromEmail: 'marketing@shop.test' };
  assert.equal(categorize(bulk), 'promotions');
  assert.equal(categorize({ ...bulk, knownContact: true }), 'primary');
});

test('receipts, orders and invoices are Transactions', () => {
  for (const subject of ['Your receipt from Acme', 'Order #10428 confirmed', 'Invoice 2201 is due', 'Your payment was received', 'Your parcel has shipped', 'Booking confirmation: Rome', 'Refund processed']) {
    assert.equal(categorize({ subject, fromEmail: 'noreply@shop.test', listUnsubscribe: '<https://x.test/u>' }), 'transactions', subject);
  }
  // The sender alone is enough when the subject says little.
  assert.equal(categorize({ subject: 'A note about your account', fromEmail: 'billing@shop.test', autoSubmitted: 'auto-generated' }), 'transactions');
});

test('a receipt from a shop that also advertises is still a receipt', () => {
  // Shops put marketing in the footer of every order mail; the order number
  // is what the person will come back looking for.
  assert.equal(categorize({ subject: 'Your order #55-2201 has shipped — plus 20% off your next order', fromEmail: 'orders@shop.test', listUnsubscribe: '<https://x.test/u>' }), 'transactions');
});

test('marketing sends are Promotions', () => {
  for (const subject of ['30% off this weekend only', 'Flash sale: last chance', 'Our September newsletter', 'New arrivals just landed', "Don't miss our webinar"]) {
    assert.equal(categorize({ subject, fromEmail: 'marketing@shop.test', listUnsubscribe: '<https://x.test/u>' }), 'promotions', subject);
  }
});

test('machine mail that is neither a receipt nor an advert is an Update', () => {
  for (const c of [
    { subject: 'Your sign-in code is 402118', fromEmail: 'no-reply@bank.test', autoSubmitted: 'auto-generated' },
    { subject: 'Security alert for your account', fromEmail: 'security@service.test', autoSubmitted: 'auto-generated' },
    { subject: 'Dana commented on your pull request', fromEmail: 'notifications@github.test', listId: 'repo.github.test' },
    { subject: 'Scheduled maintenance this Sunday', fromEmail: 'status@host.test', precedence: 'bulk' },
  ]) assert.equal(categorize(c), 'updates', String(c.subject));
});

test('bulk mail with nothing else to go on splits on List-Id', () => {
  // A real mailing list has a List-Id; a marketing blast usually has only
  // the unsubscribe link.
  assert.equal(categorize({ subject: 'Weekly roundup', fromEmail: 'list@group.test', listId: '<weekly.group.test>' }), 'updates');
  assert.equal(categorize({ subject: 'Hello from us', fromEmail: 'hello@brand.test', listUnsubscribe: '<https://x.test/u>' }), 'promotions');
});

test('looksAutomated reads the headers that mark bulk mail', () => {
  assert.equal(looksAutomated({ listId: '<l.test>' }), true);
  assert.equal(looksAutomated({ listUnsubscribe: '<https://x.test/u>' }), true);
  assert.equal(looksAutomated({ precedence: 'bulk' }), true);
  assert.equal(looksAutomated({ autoSubmitted: 'auto-replied' }), true);
  // "no" is what a human-sent message says when it says anything at all.
  assert.equal(looksAutomated({ autoSubmitted: 'no' }), false);
  assert.equal(looksAutomated({ subject: 'hi', fromEmail: 'a@b.test' }), false);
});

test('a surname that reads like marketing does not move a person', () => {
  // "Sale" is a name, "Exclusive" is a company. Matching the display name
  // against advert words filed real people under Promotions.
  assert.equal(categorize({ subject: 'Notes from today', fromEmail: 'chris@firm.test', fromName: 'Chris Sale' }), 'primary');
  assert.equal(categorize({ subject: 'Contract draft', fromEmail: 'ops@exclusive.test', fromName: 'Exclusive Ltd' }), 'primary');
});

test('only the four known values are categories', () => {
  for (const v of ['primary', 'transactions', 'updates', 'promotions']) assert.equal(isCategory(v), true, v);
  for (const v of ['social', '', null, undefined, 1, 'PRIMARY']) assert.equal(isCategory(v), false, String(v));
});
