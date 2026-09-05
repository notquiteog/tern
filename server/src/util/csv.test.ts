import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessMapping, parseCsv, sniffDelimiter, toCsv } from './csv.js';

test('parseCsv handles quotes, embedded delimiters, CRLF and BOM', () => {
  const text = '﻿Email,Name,Notes\r\na@x.com,"Doe, Jane","said ""hi""\nthen left"\r\nb@x.com,Bob,\r\n';
  const r = parseCsv(text);
  assert.deepEqual(r.headers, ['Email', 'Name', 'Notes']);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], ['a@x.com', 'Doe, Jane', 'said "hi"\nthen left']);
  assert.equal(r.delimiter, ',');
});

test('sniffDelimiter prefers a consistent separator', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t');
});

test('guessMapping recognises common headers', () => {
  const m = guessMapping(['E-mail', 'First Name', 'Surname', 'Organisation', 'Job Title', 'Mobile']);
  assert.equal(m.email, 'E-mail');
  assert.equal(m.first_name, 'First Name');
  assert.equal(m.last_name, 'Surname');
  assert.equal(m.company, 'Organisation');
  assert.equal(m.title, 'Job Title');
  assert.equal(m.phone, 'Mobile');
});

test('toCsv escapes what it must', () => {
  assert.equal(toCsv(['a', 'b'], [['x,y', 'plain'], ['q"q', null]]), 'a,b\r\n"x,y",plain\r\n"q""q",\r\n');
});
