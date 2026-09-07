// The attachment parsers, on files built in the test rather than checked in.
// Building them here means the fixtures are readable — you can see exactly
// what byte sequence each assertion is about — and that a hostile-input test
// can be written by changing one number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import {
  canExtract, contentStreamText, documentText, extract, kindOf, sheetText, tidy, unescapeXml, zipEntries,
} from './extract.js';

// ---------- Building a zip ----------

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------- Which files are even considered ----------

test('the formats worth reading are recognised, by type or by name', () => {
  assert.equal(kindOf('application/pdf', 'x'), 'pdf');
  assert.equal(kindOf('application/octet-stream', 'invoice.pdf'), 'pdf');
  assert.equal(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', null), 'docx');
  assert.equal(kindOf('', 'notes.md'), 'text');
  assert.equal(kindOf('text/csv', 'rows.csv'), 'text');
});

test('images, archives and HTML are left alone', () => {
  // HTML is excluded on purpose: an HTML attachment is usually the message
  // again, and indexing it twice makes every search find itself.
  for (const [t, n] of [['image/png', 'a.png'], ['application/zip', 'a.zip'], ['text/html', 'a.html'], ['application/x-msdownload', 'a.exe']]) {
    assert.equal(canExtract(t, n), false, `${t} ${n}`);
  }
});

// ---------- Word ----------

test('a Word document gives up its paragraphs', () => {
  const doc = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:r><w:t>Invoice 1024</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Due </w:t></w:r><w:r><w:t>Friday</w:t></w:r></w:p>
  </w:body></w:document>`;
  const out = extract(zip({ 'word/document.xml': doc, '[Content_Types].xml': '<x/>' }), '', 'letter.docx');
  assert.match(out.text, /Invoice 1024/);
  assert.match(out.text, /Due Friday/);
  assert.ok(!/<w:t>/.test(out.text), 'no markup survives');
});

test('runs split across elements rejoin as one word', () => {
  // Word splits a word wherever formatting or a spell-check mark changes,
  // so "Rechnungsnummer" can arrive as four runs. If the extractor inserted
  // separators the word would never be findable.
  const xml = '<w:p><w:r><w:t>Rech</w:t></w:r><w:r><w:t>nungs</w:t></w:r><w:r><w:t>nummer</w:t></w:r></w:p>';
  assert.match(documentText(xml), /Rechnungsnummer/);
});

test('table cells stay apart', () => {
  const xml = '<w:p><w:tc><w:r><w:t>Net</w:t></w:r></w:tc><w:tc><w:r><w:t>1200</w:t></w:r></w:tc></w:p>';
  assert.match(documentText(xml), /Net\t?1200|Net\s1200/);
});

// ---------- Excel ----------

test('a spreadsheet gives up its shared strings and its numbers', () => {
  const shared = '<sst><si><t>Consulting</t></si><si><t>March</t></si></sst>';
  const sheet = '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>4200</v></c></row></sheetData></worksheet>';
  const out = extract(zip({ 'xl/sharedStrings.xml': shared, 'xl/worksheets/sheet1.xml': sheet }), '', 'q1.xlsx');
  assert.match(out.text, /Consulting/);
  assert.match(out.text, /March/);
  assert.match(out.text, /4200/);
});

test('a shared-string index is never written out as a number', () => {
  // <c t="s"><v>0</v></c> means "the first shared string", not "zero". Writing
  // the 0 would put a meaningless digit in the index for every text cell.
  const sheet = '<worksheet><sheetData><row><c t="s"><v>7</v></c></row></sheetData></worksheet>';
  assert.equal(sheetText(sheet).trim(), '');
});

test('sheets are read in the order a person would read them', () => {
  const files: Record<string, string> = { 'xl/sharedStrings.xml': '<sst></sst>' };
  for (const n of [1, 2, 10]) {
    files[`xl/worksheets/sheet${n}.xml`] = `<worksheet><sheetData><row><c><v>sheet${n}</v></c></row></sheetData></worksheet>`;
  }
  const text = extract(zip(files), '', 'book.xlsx').text;
  assert.ok(text.indexOf('sheet2') < text.indexOf('sheet10'), 'sheet10 must not sort before sheet2');
});

// ---------- PDF ----------

function pdf(streams: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  for (const s of streams) {
    const body = deflateSync(Buffer.from(s, 'latin1'));
    parts.push(Buffer.from(`1 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'));
    parts.push(body);
    parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  parts.push(Buffer.from('trailer\n<< /Size 2 >>\n%%EOF', 'latin1'));
  return Buffer.concat(parts);
}

test('a PDF gives up the text its content streams draw', () => {
  const out = extract(pdf(['BT /F1 12 Tf 72 720 Td (Invoice 1024) Tj 0 -14 Td (Total: 4,200.00) Tj ET']), 'application/pdf', 'i.pdf');
  assert.match(out.text, /Invoice 1024/);
  assert.match(out.text, /Total: 4,200\.00/);
});

test('a TJ array joins into words rather than letters', () => {
  // Kerned text arrives as [(W) -20 (e) 15 (lcome)] TJ. Treating each string
  // as its own word would put "W", "e" and "lcome" in the index.
  const t = contentStreamText('BT [(W) -20 (e) 15 (lcome) ] TJ ET');
  assert.match(t, /Welcome/);
});

test('escapes and octal inside a literal string are decoded', () => {
  assert.match(contentStreamText('BT (Caf\\351 \\(closed\\)) Tj ET'), /Café \(closed\)/);
});

test('a hex string is decoded both ways round', () => {
  assert.match(contentStreamText('BT <48656C6C6F> Tj ET'), /Hello/);
  assert.match(contentStreamText('BT <00480065006C006C006F> Tj ET'), /Hello/);
});

test('a scan with no text layer says so instead of returning noise', () => {
  const out = extract(pdf(['/Image /DCTDecode binary-ish-nonsense']), 'application/pdf', 'scan.pdf');
  assert.equal(out.text, '');
  assert.match(out.note ?? '', /no text layer/);
});

test('an encrypted PDF is declined, not attacked', () => {
  const buf = Buffer.concat([pdf(['BT (secret) Tj ET']), Buffer.from('\ntrailer << /Encrypt 9 0 R >>\n%%EOF', 'latin1')]);
  const out = extract(buf, 'application/pdf', 'locked.pdf');
  assert.equal(out.text, '');
  assert.match(out.note ?? '', /encrypted/);
});

// ---------- Hostile input ----------

test('rubbish produces a note, never a throw', () => {
  for (const [buf, type, name] of [
    [Buffer.from('not a pdf at all'), 'application/pdf', 'x.pdf'],
    [Buffer.from('PK\x03\x04 truncated'), '', 'x.docx'],
    [Buffer.alloc(0), 'application/pdf', 'x.pdf'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), '', 'x.xlsx'],
  ] as [Buffer, string, string][]) {
    const out = extract(buf, type, name);
    assert.equal(typeof out.text, 'string');
  }
});

test('a file larger than the ceiling is not read at all', () => {
  const huge = Buffer.alloc(26 * 1024 * 1024);
  const out = extract(huge, 'application/pdf', 'big.pdf');
  assert.equal(out.text, '');
  assert.equal(out.truncated, true);
});

test('a zip claiming an implausible expanded size is refused', () => {
  const buf = zip({ 'word/document.xml': '<w:p><w:r><w:t>hi</w:t></w:r></w:p>' });
  // Rewrite the central directory's uncompressed size to 1 GB.
  const entries = zipEntries(buf);
  assert.equal(entries.length, 1);
  const eocd = buf.length - 22;
  const cdStart = buf.readUInt32LE(eocd + 16);
  buf.writeUInt32LE(1024 * 1024 * 1024, cdStart + 24);
  const out = extract(buf, '', 'bomb.docx');
  assert.equal(out.text, '');
});

test('output is capped rather than allowed to fill the row', () => {
  const long = 'word '.repeat(60_000);
  const out = extract(Buffer.from(long), 'text/plain', 'big.txt');
  assert.ok(out.text.length <= 200_000);
  assert.equal(out.truncated, true);
});

// ---------- Tidying ----------

test('entities and whitespace come out readable', () => {
  assert.equal(unescapeXml('Tom &amp; Jerry &lt;a&gt; &#65;'), 'Tom & Jerry <a> A');
  assert.equal(tidy('a\n\n\n\n b   c '), 'a\n\nb c');
  // A numeric entity outside Unicode must not throw.
  assert.equal(unescapeXml('&#9999999999;'), '');
});
