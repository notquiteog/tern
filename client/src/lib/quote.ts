// Quoted text in received mail. Every client appends the earlier messages
// under a marker of its own; a thread view that showed all of them would be
// the same conversation repeated once per message. This finds the point
// where the reply ends and the quote begins, so the quote can be tucked
// behind a "show quoted text" toggle.

export interface QuoteSplit { main: string; quoted: string | null }

const CONTAINER_SELECTOR = [
  'div.gmail_quote', 'div.tern-quote', 'blockquote[type="cite"]', 'blockquote.gmail_quote', 'div.moz-cite-prefix', 'div#divRplyFwdMsg', 'div#appendonsend',
  'div.yahoo_quoted', 'div[id^="yahoo_quoted"]', 'div.protonmail_quote', 'div#isForwardContent', 'div.zmail_extra', 'div[id^="ymail_android_signature"] ~ blockquote',
  'div.OutlookMessageHeader', 'div#mail-editor-reference-message-container', 'blockquote',
].join(',');

const WROTE_RE = /^\s*(On|Am|Le|El|Il)\b[\s\S]{4,400}?\b(wrote|schrieb|a écrit|escribió|ha scritto)\b[^:]{0,80}:\s*$/i;
const MARKER_RE = /^\s*-{2,}\s*(Original Message|Ursprüngliche Nachricht|Forwarded message|Weitergeleitete Nachricht|Message transféré)\s*-{2,}\s*$/i;
const OUTLOOK_RE = /^\s*(From|Von|De)\s*:[\s\S]{0,400}?\b(Sent|Gesendet|Envoyé|Date)\s*:[\s\S]{0,400}?\b(To|An|À)\s*:[\s\S]{0,600}?\b(Subject|Betreff|Objet)\s*:/i;

function textAfter(doc: Document, el: Element): string {
  const r = doc.createRange();
  r.setStartAfter(el);
  r.setEnd(doc.body, doc.body.childNodes.length);
  return r.toString().replace(/ /g, ' ').trim();
}

// textContent runs "From: Bob<br>Sent: Mon" together; the header patterns
// need the line breaks back.
function textOf(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const b of Array.from(c.querySelectorAll('br, p, div, tr, li, h1, h2, h3, h4'))) b.parentNode?.insertBefore(c.ownerDocument!.createTextNode('\n'), b);
  return (c.textContent ?? '').replace(/\u00a0/g, ' ').trim();
}

function serialize(frag: DocumentFragment): string {
  const d = frag.ownerDocument!.createElement('div');
  d.appendChild(frag);
  return d.innerHTML;
}

function hasContent(html: string): boolean {
  return /<img\b/i.test(html) || html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /g, ' ').trim().length > 0;
}

// The quote starts at the first element that looks like the beginning of
// quoted mail. Two kinds of evidence:
//   markers    a "wrote:" line, an "Original Message" rule, an Outlook
//              From/Sent/To/Subject header: everything after them is the
//              original, so they split wherever they are.
//   containers a blockquote or a client's quote wrapper: these split only
//              when nothing but whitespace follows, so a reply typed below a
//              quote, or a pull quote in a newsletter, is never hidden.
// Either way there has to be something above the split, or the whole
// message is a quote (a forward) and stays as it is.
export function findQuoteStart(doc: Document): Element | null {
  const body = doc.body;
  const all = body.querySelectorAll('*');
  for (const el of Array.from(all)) {
    const tag = el.tagName.toLowerCase();
    if (['html', 'head', 'body', 'style', 'script', 'br', 'img', 'b', 'i', 'span', 'a', 'font', 'strong', 'em', 'u', 'table', 'tbody', 'tr', 'td', 'th'].includes(tag)) continue;
    let kind: 'container' | 'marker' | null = null;
    if (el.matches(CONTAINER_SELECTOR)) kind = 'container';
    else if (['div', 'p', 'hr'].includes(tag)) {
      const own = textOf(el);
      if (own.length <= 500 && (WROTE_RE.test(own) || MARKER_RE.test(own))) kind = 'marker';
      else if (own.length <= 1500 && OUTLOOK_RE.test(own) && el.querySelector('b, strong')) kind = 'marker';
      else if (tag === 'hr') {
        const next = el.nextElementSibling;
        if (next && OUTLOOK_RE.test(textOf(next))) kind = 'marker';
      }
    }
    if (!kind) continue;
    if (kind === 'container' && textAfter(doc, el)) continue;
    const before = doc.createRange();
    before.setStart(body, 0);
    before.setEndBefore(el);
    if (!hasContent(serialize(before.cloneContents()))) continue;
    return el;
  }
  return null;
}

export function splitQuotedHtml(html: string): QuoteSplit {
  if (!html || typeof DOMParser === 'undefined') return { main: html, quoted: null };
  let doc: Document;
  try { doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html'); } catch { return { main: html, quoted: null }; }
  const el = findQuoteStart(doc);
  if (!el) return { main: html, quoted: null };
  const before = doc.createRange(); before.setStart(doc.body, 0); before.setEndBefore(el);
  const after = doc.createRange(); after.setStartBefore(el); after.setEnd(doc.body, doc.body.childNodes.length);
  const main = serialize(before.cloneContents());
  const quoted = serialize(after.cloneContents());
  if (!hasContent(quoted)) return { main: html, quoted: null };
  return { main, quoted };
}

// Plain-text mail: a "wrote:" line (possibly wrapped onto two lines), an
// "Original Message" rule, or a run of "> " lines that reaches the end.
export function splitQuotedText(text: string): QuoteSplit {
  if (!text) return { main: text, quoted: null };
  const lines = text.split('\n');
  const isQuoteLine = (l: string) => /^\s*>/.test(l);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const two = i + 1 < lines.length ? `${l} ${lines[i + 1]}` : l;
    if (MARKER_RE.test(l) || WROTE_RE.test(l) || (!/wrote\s*:\s*$/i.test(l) && WROTE_RE.test(two))) { start = i; break; }
    if (isQuoteLine(l)) {
      const rest = lines.slice(i).filter((x) => x.trim());
      if (rest.every((x) => isQuoteLine(x))) { start = i; break; }
    }
  }
  if (start <= 0) return { main: text, quoted: null };
  const main = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  if (!main.trim()) return { main: text, quoted: null };
  return { main, quoted: lines.slice(start).join('\n') };
}
