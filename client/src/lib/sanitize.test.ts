import './testdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkMismatch, sanitizeForEditor, sanitizeForView } from './sanitize';

test('scripts, handlers, forms and meta refresh never survive either profile', () => {
  const bad = '<p>hi</p><script>x()</script><img src=x onerror="alert(1)"><meta http-equiv="refresh" content="0;url=https://evil.example"><form action="https://evil.example"><input name=pw></form><a href="javascript:alert(1)">j</a><iframe src="https://evil.example"></iframe><base href="https://evil.example/">';
  for (const out of [sanitizeForView(bad), sanitizeForEditor(bad)]) {
    assert.ok(!/script|onerror|<meta|<form|<input|javascript:|<iframe|<base/i.test(out), out);
    assert.ok(out.includes('<p>hi</p>'));
  }
});

test('the editor profile also drops style blocks, ids and fixed positioning', () => {
  const out = sanitizeForEditor('<style>body{display:none}</style><div id="root" class="x" style="position:fixed;top:0;color:red">t</div>');
  assert.ok(!out.includes('<style'));
  assert.ok(!out.includes('id="root"'));
  assert.ok(!out.includes('position'));
  assert.ok(out.includes('color:red'));
});

test('inline images the app serves are kept; cid: images are mapped in the view profile', () => {
  const map = new Map([['img1', '/api/mail/blob/1/abc']]);
  assert.ok(sanitizeForView('<img src="cid:img1">', { cidMap: map }).includes('/api/mail/blob/1/abc'));
  assert.ok(sanitizeForEditor('<img src="/api/mail/uploads/5?inline=1">').includes('/api/mail/uploads/5'));
  assert.ok(!sanitizeForEditor('<img src="file:///etc/passwd">').includes('file:'));
});

test('remote resources are reported but kept for the reader to allow', () => {
  let remote = 0;
  const out = sanitizeForView('<img src="https://t.example/p.gif"><div style="background:url(https://t.example/b.png)">x</div>', { onRemote: () => { remote++; } });
  assert.equal(remote, 2);
  assert.ok(out.includes('https://t.example/p.gif'));
});

test('links: view profile opens in a new tab; text that names another site is flagged', () => {
  const out = sanitizeForView('<a href="https://evil.example/login">https://bank.example/login</a>');
  assert.ok(out.includes('target="_blank"'));
  assert.ok(out.includes('data-tern-link-warn="bank.example|evil.example"'));
  assert.ok(!sanitizeForView('<a href="https://bank.example/x">www.bank.example/x</a>').includes('data-tern-link-warn'));
  assert.deepEqual(linkMismatch('paypal.com', 'https://login.paypa1.example/'), { shown: 'paypal.com', real: 'login.paypa1.example' });
  assert.equal(linkMismatch('Click here', 'https://evil.example/'), null);
  assert.equal(linkMismatch('mail.example.com', 'https://www.example.com/'), null, 'same registrable domain');
});

test("the editor profile keeps the composer's own marker classes and nothing else", () => {
  const out = sanitizeForEditor('<div class="tern-quote foo"><div class="tern-quote-head">On x wrote:</div><blockquote class="gmail_quote">q</blockquote></div><div class="tern-signature">S</div>');
  assert.ok(out.includes('class="tern-quote"'));
  assert.ok(out.includes('class="tern-quote-head"'));
  assert.ok(out.includes('class="tern-signature"'));
  assert.ok(!out.includes('gmail_quote') && !out.includes('foo'));
});
