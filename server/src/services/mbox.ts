// F12, the parsing half: mbox and the RFC 5322 message inside it.
//
// Semantic search, learned triage and commitment tracking are all mediocre
// on two weeks of mail and immediately convincing on ten years of it. The
// difference between those two states is this file.
//
// It reads what people actually have: a Google Takeout mbox, a Thunderbird
// folder, an `mbox` an old client wrote. That means being tolerant — mbox
// has no specification, only four incompatible conventions about escaping —
// while staying bounded, because the file is chosen by whoever is importing
// and may be a hundred gigabytes or a fork bomb of nested multiparts.
//
// Pure functions over buffers and strings. Nothing here knows about the
// database, the vault or consent.
export interface ParsedAddress { name: string | null; email: string }

export interface ParsedPart { type: string; name: string | null; size: number; disposition: string | null; cid: string | null }

export interface ParsedMessage {
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  from: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  replyTo: ParsedAddress[];
  subject: string;
  date: Date | null;
  text: string | null;
  html: string | null;
  attachments: ParsedPart[];
  listId: string | null;
  listUnsubscribe: string | null;
  autoSubmitted: string | null;
  authResults: string | null;
  size: number;
}

// Ceilings. A message beyond these is skipped with a count rather than
// allowed to decide how much memory the import uses.
export const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_PARTS = 200;
const MAX_DEPTH = 12;
const MAX_BODY_CHARS = 400_000;

// ---------- Splitting an mbox ----------

// A message begins at a line starting "From " at the very start of the file
// or after a blank line. Checking the blank line matters: without it, a
// quoted "From the desk of…" at the start of a paragraph splits a message
// in half. Yields buffers so a large file is never held twice.
export function* splitMbox(buf: Buffer): Generator<Buffer> {
  const FROM = Buffer.from('\nFrom ');
  let start = buf.indexOf('From ') === 0 ? 0 : -1;
  if (start < 0) {
    // Not an mbox at all, or one with leading junk: look for the first
    // separator anywhere.
    const first = buf.indexOf(FROM);
    if (first < 0) { if (buf.length) yield buf; return; }
    start = first + 1;
  }
  let at = start;
  for (;;) {
    let next = buf.indexOf(FROM, at + 1);
    // Only a separator if the line before it was blank.
    while (next > 0 && !isBlankBefore(buf, next)) next = buf.indexOf(FROM, next + 1);
    const end = next < 0 ? buf.length : next + 1;
    const slice = buf.subarray(start, end);
    if (slice.length) yield slice;
    if (next < 0) return;
    start = next + 1;
    at = next + 1;
  }
}

function isBlankBefore(buf: Buffer, newlineAt: number): boolean {
  // buf[newlineAt] is the \n that begins the separator. The character before
  // it must end an empty line.
  if (newlineAt === 0) return true;
  const prev = buf[newlineAt - 1];
  if (prev === 0x0a) return true;
  return prev === 0x0d && newlineAt >= 2 && buf[newlineAt - 2] === 0x0a;
}

// ---------- Headers ----------

export interface Headers { get(name: string): string | null; all(name: string): string[] }

export function parseHeaders(text: string): Headers {
  const map = new Map<string, string[]>();
  // Unfold: a continuation line begins with whitespace.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let current = '';
  const flush = () => {
    if (!current) return;
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase();
      const value = current.slice(colon + 1).trim();
      const list = map.get(name) ?? [];
      list.push(value);
      map.set(name, list);
    }
    current = '';
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { current += ` ${line.trim()}`; continue; }
    flush();
    current = line;
  }
  flush();
  return {
    get: (name) => map.get(name.toLowerCase())?.[0] ?? null,
    all: (name) => map.get(name.toLowerCase()) ?? [],
  };
}

export function splitHeadersAndBody(buf: Buffer): { headers: Headers; body: Buffer } {
  const limit = Math.min(buf.length, MAX_HEADER_BYTES);
  let split = -1, skip = 0;
  for (let i = 0; i < limit - 1; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) { split = i; skip = 2; break; }
    if (buf[i] === 0x0a && buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) { split = i; skip = 3; break; }
  }
  if (split < 0) return { headers: parseHeaders(buf.subarray(0, limit).toString('latin1')), body: Buffer.alloc(0) };
  return {
    headers: parseHeaders(buf.subarray(0, split).toString('latin1')),
    body: buf.subarray(split + skip),
  };
}

// ---------- Encoded words (RFC 2047) ----------

// =?utf-8?B?…?= and =?iso-8859-1?Q?…?=, which is how every non-ASCII subject
// line and display name arrives.
export function decodeWords(input: string): string {
  // UTF-8 first, then the encoded words: a header can be both, and the
  // encoded words are ASCII either way so reinterpreting the bytes cannot
  // disturb them.
  const s = utf8IfValid(String(input ?? ''));
  if (!s.includes('=?')) return s;
  // Adjacent encoded words separated only by whitespace are one run and the
  // whitespace between them is not part of the text.
  return s.replace(/(=\?[^?]{1,60}\?[bBqQ]\?[^?]*\?=)(\s*)(?==\?)/g, '$1')
    .replace(/=\?([^?]{1,60})\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes = enc.toLowerCase() === 'b'
          ? Buffer.from(data, 'base64')
          : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        return decodeBytes(bytes, charset);
      } catch { return whole; }
    });
}

// Node's TextDecoder knows the whole WHATWG encoding set, which covers every
// charset that turns up in mail. An unknown label falls back to Latin-1
// rather than throwing away the line.
export function decodeBytes(bytes: Buffer, charset: string | null | undefined): string {
  const label = String(charset ?? 'utf-8').toLowerCase().replace(/^["']|["']$/g, '').trim() || 'utf-8';
  try { return new TextDecoder(label, { fatal: false }).decode(bytes); } catch { /* unknown label */ }
  try { return new TextDecoder('windows-1252', { fatal: false }).decode(bytes); } catch { return bytes.toString('latin1'); }
}

/**
 * A header that arrived as raw UTF-8, read as the text it is.
 *
 * `splitHeadersAndBody` decodes the header block as latin1, which is
 * lossless — every byte becomes the code point of the same value — and RFC
 * 2047 encoded words are then decoded from it. What that misses is a header
 * carrying UTF-8 with no encoded word at all, which RFC 6532 allows and
 * which mainstream clients send: an em dash arrives as its three bytes and
 * is shown as "â" and two more. An imported subject read
 * "Quarterly review â which day suits?".
 *
 * So the latin1 round trip is undone and the bytes are tried as UTF-8, and
 * kept only if they really are UTF-8 — `fatal` is what decides that. A
 * genuine windows-1252 or latin1 header is almost never valid UTF-8, so it
 * fails the check and is returned untouched.
 */
function utf8IfValid(s: string): string {
  // Pure ASCII cannot change, so there is nothing to try.
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1')); } catch { return s; }
}

// ---------- Addresses ----------

export function parseAddresses(value: string | null): ParsedAddress[] {
  if (!value) return [];
  const out: ParsedAddress[] = [];
  for (const chunk of splitAddressList(value)) {
    const angle = /<([^>]*)>/.exec(chunk);
    const email = (angle ? angle[1] : chunk).trim().replace(/^mailto:/i, '').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) continue;
    let name = angle ? chunk.slice(0, angle.index).trim() : '';
    name = decodeWords(name).replace(/^["']|["']$/g, '').trim();
    out.push({ name: name || null, email: email.slice(0, 320) });
    if (out.length >= 200) break;
  }
  return out;
}

// Commas inside quotes and inside groups are not separators.
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let cur = '', inQuotes = false, depth = 0;
  for (const c of value) {
    if (c === '"') { inQuotes = !inQuotes; cur += c; continue; }
    if (!inQuotes && (c === '(' || c === '<')) depth++;
    if (!inQuotes && (c === ')' || c === '>')) depth = Math.max(0, depth - 1);
    if (c === ',' && !inQuotes && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---------- Content-Type ----------

export interface ContentType { type: string; params: Record<string, string> }

export function parseContentType(value: string | null): ContentType {
  const v = String(value ?? 'text/plain');
  const [head, ...rest] = v.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
    // RFC 2231 continuations and charset-tagged values: filename*=utf-8''…
    if (name.endsWith('*')) {
      const m = /^([^']*)'[^']*'(.*)$/.exec(val);
      if (m) val = decodeBytes(Buffer.from(decodeURIComponent(m[2].replace(/%/g, '%')), 'latin1'), m[1]);
      params[name.slice(0, -1)] = val;
      continue;
    }
    params[name] = decodeWords(val);
  }
  return { type: head.trim().toLowerCase() || 'text/plain', params };
}

// ---------- Bodies ----------

export function decodeBody(body: Buffer, encoding: string | null): Buffer {
  const e = String(encoding ?? '').toLowerCase().trim();
  if (e === 'base64') {
    return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (e === 'quoted-printable') {
    const text = body.toString('latin1')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(text, 'latin1');
  }
  return body;
}

interface Walked { text: string | null; html: string | null; attachments: ParsedPart[] }

// Walks a MIME tree, collecting the first readable text and HTML bodies and
// listing everything else. Bounded on depth and part count: a message that
// nests a thousand multiparts is malformed or malicious and either way is
// not worth the stack.
export function walkParts(headers: Headers, body: Buffer, depth = 0, out: Walked = { text: null, html: null, attachments: [] }): Walked {
  if (depth > MAX_DEPTH || out.attachments.length > MAX_PARTS) return out;
  const ct = parseContentType(headers.get('content-type'));
  const disposition = String(headers.get('content-disposition') ?? '').split(';')[0].trim().toLowerCase() || null;

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return out;
    for (const piece of splitMultipart(body, boundary)) {
      const sub = splitHeadersAndBody(piece);
      walkParts(sub.headers, sub.body, depth + 1, out);
      if (out.attachments.length > MAX_PARTS) break;
    }
    return out;
  }

  const encoding = headers.get('content-transfer-encoding');
  const filename = parseContentType(headers.get('content-disposition') ?? '').params.filename ?? ct.params.name ?? null;
  const isAttachment = disposition === 'attachment' || (filename && !ct.type.startsWith('text/'));

  if (!isAttachment && ct.type === 'text/plain' && out.text === null) {
    out.text = decodeBytes(decodeBody(body, encoding), ct.params.charset).slice(0, MAX_BODY_CHARS);
    return out;
  }
  if (!isAttachment && ct.type === 'text/html' && out.html === null) {
    out.html = decodeBytes(decodeBody(body, encoding), ct.params.charset).slice(0, MAX_BODY_CHARS);
    return out;
  }
  if (ct.type.startsWith('text/') || ct.type === 'message/rfc822') {
    // A nested message or an odd text part: worth listing, not worth
    // becoming the body.
  }
  out.attachments.push({
    type: ct.type,
    name: filename ? decodeWords(filename).slice(0, 300) : null,
    // The encoded length is what the file cost; close enough for a listing.
    size: body.length,
    disposition,
    cid: (headers.get('content-id') ?? '').replace(/^<|>$/g, '') || null,
  });
  return out;
}

export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delim = Buffer.from(`--${boundary}`);
  const out: Buffer[] = [];
  let at = body.indexOf(delim);
  if (at < 0) return out;
  at += delim.length;
  for (;;) {
    // Skip the CRLF after the boundary line.
    while (at < body.length && (body[at] === 0x0d || body[at] === 0x0a)) at++;
    const next = body.indexOf(delim, at);
    if (next < 0) { if (at < body.length) out.push(body.subarray(at)); break; }
    // Trim the CRLF that belongs to the delimiter, not to the part.
    let end = next;
    if (end > 0 && body[end - 1] === 0x0a) end--;
    if (end > 0 && body[end - 1] === 0x0d) end--;
    out.push(body.subarray(at, end));
    at = next + delim.length;
    if (body[at] === 0x2d && body[at + 1] === 0x2d) break; // closing --boundary--
    if (out.length > MAX_PARTS) break;
  }
  return out;
}

// ---------- One message ----------

export function parseMessage(raw: Buffer): ParsedMessage | null {
  if (!raw?.length || raw.length > MAX_MESSAGE_BYTES) return null;
  // Drop the mbox "From " separator line, which is not a header.
  let buf = raw;
  if (buf.subarray(0, 5).toString('latin1') === 'From ') {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return null;
    buf = buf.subarray(nl + 1);
  }
  // Undo whichever escaping the writer used. ">From " at the start of a body
  // line is the mboxo convention; ">>From " is mboxrd's.
  const unescaped = Buffer.from(buf.toString('latin1').replace(/^>(>*From )/gm, '$1'), 'latin1');

  const { headers, body } = splitHeadersAndBody(unescaped);
  const from = parseAddresses(headers.get('from'));
  const subject = decodeWords(headers.get('subject') ?? '').slice(0, 2000);
  // A message with neither a sender nor a subject nor a date is a fragment,
  // usually the tail of a badly split file.
  if (!from.length && !subject && !headers.get('date')) return null;

  const walked = walkParts(headers, body);
  return {
    messageId: (headers.get('message-id') ?? '').trim().replace(/^<|>$/g, '').slice(0, 500) || null,
    inReplyTo: refs(headers.get('in-reply-to')),
    references: refs(headers.get('references')),
    from,
    to: parseAddresses(headers.get('to')),
    cc: parseAddresses(headers.get('cc')),
    bcc: parseAddresses(headers.get('bcc')),
    replyTo: parseAddresses(headers.get('reply-to')),
    subject,
    date: parseDate(headers.get('date')),
    text: walked.text,
    html: walked.html,
    attachments: walked.attachments,
    listId: (headers.get('list-id') ?? '').trim().slice(0, 500) || null,
    listUnsubscribe: (headers.get('list-unsubscribe') ?? '').trim().slice(0, 2000) || null,
    autoSubmitted: (headers.get('auto-submitted') ?? '').trim().slice(0, 100) || null,
    authResults: (headers.get('authentication-results') ?? '').trim().slice(0, 2000) || null,
    size: raw.length,
  };
}

function refs(value: string | null): string[] {
  if (!value) return [];
  return [...String(value).matchAll(/<([^>]{1,500})>/g)].map((m) => m[1]).slice(0, 50);
}

// RFC 5322 dates, plus the several ways clients get them wrong. Anything
// unparseable comes back null and the importer uses the mbox order instead
// of inventing a time.
export function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const cleaned = String(value).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const native = new Date(cleaned);
  if (plausible(native)) return native;
  // "8 Sep 2026 14:00:00 +0100" with a stray day name, a two-digit year, or
  // no seconds — all of which Date refuses and real archives contain.
  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4})?/.exec(cleaned);
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  let year = Number(m[3]);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  let ms = Date.UTC(year, month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? 1 : -1;
    ms += sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5))) * 60_000;
  }
  const out = new Date(ms);
  return plausible(out) ? out : null;
}

// One bound, applied to whichever path produced the date. The epoch is what
// a client with no clock writes, and a date in the far future is a typo; in
// both cases the importer would rather have nothing and fall back to the
// order the messages were in.
function plausible(d: Date): boolean {
  if (Number.isNaN(d.getTime())) return false;
  const year = d.getUTCFullYear();
  return year > 1970 && year < 2100;
}
