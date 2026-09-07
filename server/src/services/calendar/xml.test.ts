import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, find, findAll, parseXml, textOf, xmlEscape } from './xml.js';

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/calendars/user/sam/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Work &amp; travel</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <cs:getctag>"tag-17"</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

test('a multistatus response gives up its calendars', () => {
  const doc = parseXml(MULTISTATUS);
  const responses = findAll(doc, 'response');
  assert.equal(responses.length, 1);
  assert.equal(textOf(responses[0], 'href'), '/dav/calendars/user/sam/work/');
  assert.equal(textOf(responses[0], 'displayname'), 'Work & travel');
  assert.equal(textOf(responses[0], 'getctag'), '"tag-17"');
  assert.equal(find(find(responses[0], 'resourcetype'), 'calendar') !== null, true);
});

test('namespace prefixes are resolved rather than assumed', () => {
  // The same document with different prefixes has to read identically; a
  // parser that matched on "d:href" would break against Radicale, which uses
  // a default namespace and no prefix at all.
  const other = MULTISTATUS.replace(/d:/g, 'D:').replace(/xmlns:D=/g, 'xmlns:D=');
  assert.equal(textOf(parseXml(other), 'href'), '/dav/calendars/user/sam/work/');
  const bare = `<multistatus xmlns="DAV:"><response><href>/x/</href></response></multistatus>`;
  assert.equal(textOf(parseXml(bare), 'href'), '/x/');
});

test('calendar data survives with its line breaks', () => {
  const doc = parseXml(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:response><d:href>/x.ics</d:href><d:propstat><d:prop>
      <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a@b
END:VEVENT
END:VCALENDAR</c:calendar-data>
    </d:prop></d:propstat></d:response></d:multistatus>`);
  assert.match(find(doc, 'calendar-data')!.text, /BEGIN:VEVENT/);
});

test('CDATA is taken as text, not as markup', () => {
  const doc = parseXml(`<a><b><![CDATA[<not-an-element/> & raw]]></b></a>`);
  assert.equal(find(doc, 'b')!.text, '<not-an-element/> & raw');
  assert.equal(findAll(doc, 'not-an-element').length, 0);
});

// The billion-laughs family. The entity is never declared into anything, so
// there is nothing to expand and the reference stays literal text.
test('a document declaring entities expands none of them', () => {
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [ <!ENTITY lol "haha"> <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;"> ]>
<lolz>&lol2;</lolz>`;
  const doc = parseXml(bomb);
  const text = find(doc, 'lolz')!.text;
  assert.equal(text.includes('haha'), false);
  assert.equal(text, '&lol2;');
});

test('a DOCTYPE without a subset is skipped without eating the document', () => {
  const doc = parseXml(`<!DOCTYPE html><a><b>x</b></a>`);
  assert.equal(textOf(doc, 'b'), 'x');
});

test('the standard entities and numeric references are decoded', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;'), 'a & b <c> "d" A B');
  // A lone surrogate is not a character and is left as written.
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('attributes are read whichever quote they use, and a > inside one is not a tag end', () => {
  const doc = parseXml(`<a href='/x?a=1&amp;b=2' title="one > two"><b/></a>`);
  const a = find(doc, 'a')!;
  assert.equal(a.attrs.href, '/x?a=1&b=2');
  assert.equal(a.attrs.title, 'one > two');
  assert.equal(a.children.length, 1);
});

test('a truncated document returns what it managed to read', () => {
  const doc = parseXml('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a.ics</d:href>');
  assert.equal(textOf(doc, 'href'), '/a.ics');
});

test('nesting is bounded, so a pathological document cannot exhaust the stack', () => {
  const deep = '<a>'.repeat(500) + 'x' + '</a>'.repeat(500);
  assert.doesNotThrow(() => parseXml(deep));
});

test('what is written out comes back unchanged', () => {
  const nasty = `Sam & "Dana" <sam@example.com> 'x'`;
  assert.equal(decodeEntities(xmlEscape(nasty)), nasty);
});
