import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY } from './templateLibrary.js';
import { contactContext, htmlToText, listFields, renderHtml, renderText, validateTemplate } from './merge.js';

// Every starter template, rendered for people with a lot, a little and no
// information on file, must read as a finished email that addresses the
// right person: no leftover braces, no "undefined", the greeting uses the
// first name when there is one and the fallback when there is not, and the
// sign-off uses the sender's first name.
const SENDER = { sender_name: 'Alex Rivera', sender_email: 'alex@team.example', sender_first_name: 'Alex', sender_tz: 'UTC', unsubscribe_url: 'https://tern.example/u/x' };
const PEOPLE = [
  { label: 'full record', c: { email: 'dana.osei@acme.example', first_name: 'Dana', last_name: 'Osei', company: 'Acme Robotics', title: 'Head of Ops', phone: '+1 555 0100', fields: { referrer: 'Sam Park', event_name: 'Ops Summit', event_date: 'Oct 3', invoice_number: '1042', amount: '$1,200', due_date: 'Sep 30' } }, first: 'Dana' },
  { label: 'first name only', c: { email: 'lee@northwind.example', first_name: 'Lee', last_name: '', company: '', title: '' }, first: 'Lee' },
  { label: 'address only', c: { email: 'info@example.org', first_name: '', last_name: '', company: '', title: '' }, first: null },
  { label: 'awkward characters', c: { email: "d'arcy@o'neil.example", first_name: "D'Arcy", last_name: 'O\'Neil <script>', company: 'Smith & Sons', title: '' }, first: "D'Arcy" },
];

test('starter library templates validate and list their fields', () => {
  for (const t of LIBRARY) {
    assert.deepEqual(validateTemplate(`${t.subject}\n${t.body_html}`), [], `${t.key} has template errors`);
    assert.ok(listFields(t.body_html).length > 0, `${t.key} uses no merge fields`);
    assert.ok(t.body_html.includes('{{sender_first_name}}') || t.body_html.includes('{{sender_name}}'), `${t.key} has no sign-off name`);
  }
});

for (const person of PEOPLE) {
  test(`every library template renders cleanly for a contact with ${person.label}`, () => {
    const ctx = contactContext(person.c, SENDER);
    for (const t of LIBRARY) {
      const subject = renderText(t.subject, ctx, 7);
      const html = renderHtml(t.body_html, ctx, 7);
      const text = htmlToText(html);
      for (const out of [subject, text]) {
        assert.ok(!/\{\{|\}\}/.test(out), `${t.key}: unrendered field in "${out.slice(0, 60)}"`);
        assert.ok(!/\{[^{}]*\|[^{}]*\}/.test(out), `${t.key}: unrendered variation in "${out.slice(0, 60)}"`);
        assert.ok(!/undefined|null|NaN/.test(out), `${t.key}: leaked value in "${out.slice(0, 60)}"`);
        assert.ok(!/\s,|\s\./.test(out), `${t.key}: dangling punctuation in "${out.slice(0, 80)}"`);
      }
      const firstLine = text.split('\n')[0];
      if (person.first) {
        // Greetings and "Great, Dana." style openers name the person exactly once.
        assert.ok(firstLine.includes(person.first), `${t.key}: first line "${firstLine}" does not address ${person.first}`);
        assert.ok(!firstLine.includes('there,') || t.key === 'reply-scheduling', `${t.key}: fallback used although a name exists: "${firstLine}"`);
      } else {
        assert.ok(/there|hello|thanks/i.test(firstLine), `${t.key}: no neutral greeting for an unnamed contact: "${firstLine}"`);
        assert.ok(!/Hi\s*,/.test(firstLine), `${t.key}: empty greeting "${firstLine}"`);
      }
      assert.ok(text.includes('Alex'), `${t.key}: sign-off lacks the sender's first name`);
      assert.ok(!html.includes('<script>'), `${t.key}: HTML injection survived`);
      // A square-bracket placeholder is a deliberate "fill this in" marker, so it must be visible.
      if (/\[[^\]]+\]/.test(t.body_html)) assert.ok(/\[[^\]]+\]/.test(text), `${t.key}: fill-in marker lost`);
    }
  });
}

test('variations differ between contacts but are stable for one contact', () => {
  const t = LIBRARY.find((x) => x.key === 'cold-intro')!;
  const ctx = contactContext(PEOPLE[0].c, SENDER);
  assert.equal(renderText(t.subject, ctx, 3), renderText(t.subject, ctx, 3));
  const seen = new Set<string>();
  for (let seed = 1; seed < 40; seed++) seen.add(renderText(t.subject, ctx, seed));
  assert.ok(seen.size >= 2, 'variations never vary');
});
