// A small XML reader, for CalDAV and nothing else.
//
// WebDAV replies are XML, and there is no parser in this project's
// dependencies. Adding one for this is a poor trade: the documents in
// question are machine-generated, shallow, and use a handful of elements,
// and a general parser brings a general parser's attack surface to a job
// that does not need it. So this reads exactly what a multistatus response
// is made of and refuses everything else.
//
// What it deliberately does NOT do, because these are how XML parsers get
// people hurt: no DTDs, no entity declarations, no external references, no
// processing instructions with meaning. `<!DOCTYPE` and `<!ENTITY` are
// skipped as text, so the billion-laughs family of attacks has nothing to
// expand. Depth and node count are capped.

export interface XmlNode {
  /** Local name, lower-cased; the namespace prefix is resolved away. */
  name: string;
  /** Namespace URI where one was declared, lower-cased. */
  ns: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 40;
const MAX_NODES = 20_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Only real characters, and never a surrogate half.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function parseXml(text: string): XmlNode | null {
  const src = String(text ?? '');
  let i = 0;
  let nodes = 0;
  const root: XmlNode = { name: '#root', ns: '', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  // Prefix → namespace URI, one frame per open element.
  const nsStack: Record<string, string>[] = [{ '': '' }];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const chunk = src.slice(i, lt);
      if (chunk.trim()) stack[stack.length - 1].text += decodeEntities(chunk);
    }
    // Comments, doctypes, CDATA and processing instructions.
    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt); if (end < 0) break; i = end + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) break;
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3; continue;
    }
    // A DOCTYPE, with or without an internal subset. Skipped entirely: any
    // entity it declares is never expanded, so it can define nothing.
    if (src.startsWith('<!', lt)) {
      const bracket = src.indexOf('[', lt);
      const close = src.indexOf('>', lt);
      if (bracket >= 0 && close >= 0 && bracket < close) {
        const endSubset = src.indexOf(']', bracket);
        const after = endSubset < 0 ? -1 : src.indexOf('>', endSubset);
        i = after < 0 ? src.length : after + 1;
      } else {
        i = close < 0 ? src.length : close + 1;
      }
      continue;
    }
    if (src.startsWith('<?', lt)) { const end = src.indexOf('?>', lt); i = end < 0 ? src.length : end + 2; continue; }

    const gt = findTagEnd(src, lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      if (stack.length > 1) { stack.pop(); nsStack.pop(); }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const spaceAt = body.search(/\s/);
    const qname = (spaceAt < 0 ? body : body.slice(0, spaceAt)).trim();
    const attrText = spaceAt < 0 ? '' : body.slice(spaceAt);

    const attrs: Record<string, string> = {};
    const frame: Record<string, string> = { ...nsStack[nsStack.length - 1] };
    for (const m of attrText.matchAll(/([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g)) {
      const key = (m[1] ?? m[3] ?? '').trim();
      const value = decodeEntities(m[2] ?? m[4] ?? '');
      if (!key) continue;
      if (key === 'xmlns') frame[''] = value.toLowerCase();
      else if (key.startsWith('xmlns:')) frame[key.slice(6)] = value.toLowerCase();
      else attrs[key.toLowerCase()] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const name = (colon < 0 ? qname : qname.slice(colon + 1)).toLowerCase();

    if (++nodes > MAX_NODES) break;
    const node: XmlNode = { name, ns: frame[prefix] ?? '', attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) break;
      stack.push(node);
      nsStack.push(frame);
    }
    i = gt + 1;
  }
  return root.children.length ? root : null;
}

// The '>' that closes a tag, skipping any inside a quoted attribute value.
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

// ---------- Walking ----------

/** Every descendant with this local name, at any depth. */
export function findAll(node: XmlNode | null, name: string): XmlNode[] {
  if (!node) return [];
  const out: XmlNode[] = [];
  const want = name.toLowerCase();
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === want) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function find(node: XmlNode | null, name: string): XmlNode | null {
  return findAll(node, name)[0] ?? null;
}

/** The text of the first descendant with this name, trimmed. */
export function textOf(node: XmlNode | null, name: string): string {
  return (find(node, name)?.text ?? '').trim();
}

/** Direct children with this local name. */
export function childrenNamed(node: XmlNode | null, name: string): XmlNode[] {
  const want = name.toLowerCase();
  return (node?.children ?? []).filter((c) => c.name === want);
}

// ---------- Writing ----------

export function xmlEscape(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
