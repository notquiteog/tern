// Link hygiene. The risk in this feature is not missing a tracker — it is
// breaking a link, which is why most of what follows is about leaving things
// alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtmlLinks, cleanLink, cleanTextLinks } from './links.js';

test('campaign parameters come off and the rest of the link survives', () => {
  const r = cleanLink('https://shop.example/product/42?utm_source=news&utm_campaign=spring&colour=blue&size=m');
  assert.equal(r.url, 'https://shop.example/product/42?colour=blue&size=m');
  assert.ok(r.changed);
  assert.deepEqual(r.removed.sort(), ['utm_campaign', 'utm_source']);
});

test('per-recipient identifiers come off, because those are the ones that name you', () => {
  const r = cleanLink('https://news.example/read?mc_eid=abc123&mc_cid=def&id=7');
  assert.equal(r.url, 'https://news.example/read?id=7');
});

test('a clean link is returned untouched and unmarked', () => {
  const url = 'https://example.com/a/b?page=2&sort=date#section-3';
  const r = cleanLink(url);
  assert.equal(r.url, url);
  assert.equal(r.changed, false);
  assert.deepEqual(r.removed, []);
});

test('a link with nothing left keeps no dangling question mark', () => {
  assert.equal(cleanLink('https://example.com/x?utm_source=a').url, 'https://example.com/x');
});

test('non-http schemes are never rewritten', () => {
  for (const url of ['mailto:ana@corp.example?subject=Hi', 'tel:+441234567890', 'cid:image001.png@01D9']) {
    const r = cleanLink(url);
    assert.equal(r.url, url);
    assert.equal(r.changed, false);
  }
});

test('rubbish is handed back rather than thrown over', () => {
  for (const url of ['', 'not a url', 'http://', '://broken']) {
    assert.equal(cleanLink(url).changed, false);
  }
});

// ---------- Unwrapping ----------

test('a Safelinks wrapper gives up its destination', () => {
  const r = cleanLink('https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fdocs.example%2Fplan&data=05%7C01&reserved=0');
  assert.equal(r.url, 'https://docs.example/plan');
  assert.equal(r.unwrapped, 'nam02.safelinks.protection.outlook.com');
});

test('nested wrappers unwrap all the way down', () => {
  const inner = encodeURIComponent('https://real.example/page?utm_source=mail');
  const middle = encodeURIComponent(`https://nam02.safelinks.protection.outlook.com/?url=${inner}`);
  const r = cleanLink(`https://protect-eu.mimecast.com/s/?u=${middle}`);
  // Unwrapped twice, and the tracking on the real destination is stripped too.
  assert.equal(r.url, 'https://real.example/page');
  assert.deepEqual(r.removed, ['utm_source']);
});

test('a wrapper whose destination is not a URL is left alone', () => {
  // Google's ?q= is a search as often as it is a redirect. Rewriting a search
  // into nothing would break the link.
  const url = 'https://www.google.com/search?q=cheese';
  assert.equal(cleanLink(url).url, url);
});

test('an unknown redirector is not guessed at', () => {
  // A link through somebody's own shortener may well be tracking, but the
  // destination is not in the URL and inventing one would send the reader
  // somewhere they did not ask to go.
  const url = 'https://link.somecompany.example/c/abc123';
  const r = cleanLink(url);
  assert.equal(r.url, url);
  assert.equal(r.unwrapped, null);
});

test('unwrapping cannot be talked into a non-http destination', () => {
  const r = cleanLink(`https://l.facebook.com/l.php?u=${encodeURIComponent('javascript:alert(1)')}`);
  assert.ok(r.url.startsWith('https://l.facebook.com/'), 'the wrapper is kept rather than following a script URL');
});

// ---------- HTML ----------

test('every href in a fragment is cleaned, and nothing else is touched', () => {
  const html = '<p>Hi <a href="https://a.example/?utm_source=x&keep=1">one</a> and <a href=\'https://b.example/\'>two</a><img src="https://c.example/px?utm_source=y"></p>';
  const out = cleanHtmlLinks(html);
  assert.match(out.html, /href="https:\/\/a\.example\/\?keep=1"/);
  assert.match(out.html, /href='https:\/\/b\.example\/'/);
  // The image is a tracking pixel and is somebody else's job — the remote
  // image blocker already holds it. Rewriting it here would be a second
  // opinion on the same question.
  assert.match(out.html, /src="https:\/\/c\.example\/px\?utm_source=y"/);
  assert.equal(out.removed, 1);
});

test('an ampersand-escaped href round-trips as valid HTML', () => {
  const out = cleanHtmlLinks('<a href="https://a.example/?utm_source=x&amp;a=1&amp;b=2">x</a>');
  assert.match(out.html, /href="https:\/\/a\.example\/\?a=1&amp;b=2"/);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(out.html), 'no bare ampersands left in the attribute');
});

test('a quote in a rewritten URL cannot break out of the attribute', () => {
  const out = cleanHtmlLinks('<a href="https://a.example/?utm_source=x&q=%22onmouseover%3D">x</a>');
  assert.ok(!/href="[^"]*"[^>]*onmouseover/.test(out.html));
});

test('plain text links are cleaned in place', () => {
  const text = 'See https://a.example/x?utm_source=news&id=3 for details.';
  assert.equal(cleanTextLinks(text), 'See https://a.example/x?id=3 for details.');
});

test('text that merely mentions a URL-ish thing is not mangled', () => {
  const text = 'Read docs at example.com or ask me.';
  assert.equal(cleanTextLinks(text), text);
});
