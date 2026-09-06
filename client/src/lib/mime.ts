// Just enough MIME for OpenPGP in the browser: build the part that gets
// signed or encrypted (text and HTML alternatives plus attachments), and
// parse the part that comes back out of a decrypted message so it can be
// shown like any other mail. Handles multipart nesting, base64 and
// quoted-printable transfer encodings, RFC 2047 encoded words in headers,
// and RFC 2231 filename parameters. Charsets go through TextDecoder.

export interface MimePart { headers: Record<string, string>; headerList: [string, string][]; type: string; params: Record<string, string>; body: Uint8Array; parts: MimePart[] }
export interface FlatMessage { html: string | null; text: string | null; attachments: { name: string; type: string; data: Uint8Array; cid: string | null; inline: boolean }[] }

const CRLF = '\r\n';

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function wrap76(s: string): string { return s.replace(/(.{76})/g, `$1${CRLF}`).replace(/\r\n$/, ''); }
function boundary(): string { return `----=_tern_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; }

function encodeWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64encode(new TextEncoder().encode(s))}?=`;
}

export function buildMime(msg: { html: string; text?: string; attachments?: { name: string; type: string; data: Uint8Array; cid?: string | null }[]; headers?: [string, string][] }): string {
  const enc = new TextEncoder();
  // Headers that belong inside the protected part (Autocrypt-Gossip); long
  // values are folded at 76 columns, which the readers unfold.
  const extra = (msg.headers ?? []).map(([k, v]) => `${k}: ${v.replace(/(.{76})/g, `$1${CRLF} `)}${CRLF}`).join('');
  const textPart = (type: string, body: string) => `Content-Type: ${type}; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${wrap76(b64encode(enc.encode(body)))}${CRLF}`;
  const altB = boundary();
  const alt = `Content-Type: multipart/alternative; boundary="${altB}"${CRLF}${CRLF}--${altB}${CRLF}${textPart('text/plain', msg.text ?? htmlToPlain(msg.html))}--${altB}${CRLF}${textPart('text/html', msg.html)}--${altB}--${CRLF}`;
  if (!msg.attachments?.length) return extra + alt;
  const mixB = boundary();
  let out = `${extra}Content-Type: multipart/mixed; boundary="${mixB}"${CRLF}${CRLF}--${mixB}${CRLF}${alt}`;
  for (const a of msg.attachments) {
    const name = encodeWord(a.name.replace(/["\r\n]/g, '_'));
    out += `--${mixB}${CRLF}Content-Type: ${a.type || 'application/octet-stream'}; name="${name}"${CRLF}Content-Disposition: ${a.cid ? 'inline' : 'attachment'}; filename="${name}"${CRLF}${a.cid ? `Content-ID: <${a.cid}>${CRLF}` : ''}Content-Transfer-Encoding: base64${CRLF}${CRLF}${wrap76(b64encode(a.data))}${CRLF}`;
  }
  return out + `--${mixB}--${CRLF}`;
}

export function htmlToPlain(html: string): string {
  const d = document.createElement('div');
  d.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n');
  return (d.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- parsing ----------

function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, kind: string, text: string) => {
    try {
      const bytes = kind.toLowerCase() === 'b' ? b64decode(text) : qpDecode(text.replace(/_/g, ' '));
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch { return text; }
  }).replace(/\?=\s+=\?/g, '?==?');
}

function qpDecode(s: string): Uint8Array {
  const out: number[] = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function parseHeaders(block: string): { headers: Record<string, string>; list: [string, string][] } {
  const headers: Record<string, string> = {};
  const list: [string, string][] = [];
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    headers[name] = value;
    list.push([name, value]);
  }
  return { headers, list };
}

function parseParams(value: string): { type: string; params: Record<string, string> } {
  const [type, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  const cont: Record<string, string[]> = {};
  for (const p of rest) {
    const m = p.match(/^\s*([^=]+?)(\*(\d+))?(\*)?\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let v = m[5].replace(/^"(.*)"$/, '$1');
    if (m[4]) { // RFC 2231: charset'lang'percent-encoded
      const parts = v.split("'");
      const encoded = parts.length >= 3 ? parts.slice(2).join("'") : v;
      try { v = new TextDecoder(parts[0] || 'utf-8').decode(new Uint8Array([...encoded.matchAll(/%([0-9A-Fa-f]{2})|(.)/g)].map((x) => x[1] ? parseInt(x[1], 16) : x[2].charCodeAt(0)))); } catch { /* keep */ }
    }
    if (m[3] !== undefined) { (cont[key] ??= [])[Number(m[3])] = v; } else params[key] = decodeWords(v);
  }
  for (const [k, pieces] of Object.entries(cont)) params[k] = pieces.join('');
  return { type: type.trim().toLowerCase(), params };
}

export function parseMime(raw: string): MimePart {
  const norm = raw.replace(/\r?\n/g, CRLF);
  const split = norm.indexOf(CRLF + CRLF);
  const headerBlock = split < 0 ? norm : norm.slice(0, split);
  const bodyText = split < 0 ? '' : norm.slice(split + 4);
  const { headers, list } = parseHeaders(headerBlock);
  const { type, params } = parseParams(headers['content-type'] ?? 'text/plain');
  const part: MimePart = { headers, headerList: list, type, params, body: new Uint8Array(), parts: [] };
  if (type.startsWith('multipart/') && params.boundary) {
    const b = `--${params.boundary}`;
    const chunks = bodyText.split(new RegExp(`(?:^|\\r\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const c of chunks.slice(1)) {
      if (c.startsWith('--')) break;
      part.parts.push(parseMime(c.replace(/^\r\n/, '')));
    }
    return part;
  }
  const cte = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase();
  if (cte === 'base64') part.body = b64decode(bodyText);
  else if (cte === 'quoted-printable') part.body = qpDecode(bodyText);
  else part.body = new TextEncoder().encode(bodyText);
  return part;
}

function textOf(p: MimePart): string {
  const charset = (p.params.charset ?? 'utf-8').toLowerCase();
  try { return new TextDecoder(charset).decode(p.body); } catch { return new TextDecoder().decode(p.body); }
}

export function flatten(root: MimePart): FlatMessage {
  const out: FlatMessage = { html: null, text: null, attachments: [] };
  const walk = (p: MimePart, inAlternative: boolean) => {
    if (p.type.startsWith('multipart/')) { for (const c of p.parts) walk(c, p.type === 'multipart/alternative'); return; }
    const disp = parseParams(p.headers['content-disposition'] ?? '');
    const name = disp.params.filename ?? p.params.name ?? '';
    const isAttachment = disp.type === 'attachment' || (Boolean(name) && !p.type.startsWith('text/'));
    if (!isAttachment && p.type === 'text/html' && out.html === null) { out.html = textOf(p); return; }
    if (!isAttachment && p.type === 'text/plain' && out.text === null) { out.text = textOf(p); return; }
    if (isAttachment || !inAlternative) out.attachments.push({ name: name || 'attachment', type: p.type, data: p.body, cid: (p.headers['content-id'] ?? '').replace(/^<|>$/g, '') || null, inline: disp.type === 'inline' });
  };
  walk(root, false);
  return out;
}
