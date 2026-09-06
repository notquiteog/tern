// The body of a message being written has three parts: what the person
// typed, their signature, and the quoted original. The editor holds them as
// plain HTML; these helpers take that HTML apart and put it together so the
// composer can swap a signature, collapse a quote, or drop AI text in
// without disturbing the rest.
import { htmlToPlain } from './mime';
import { inertDocument } from './sanitize';

export interface BodyParts { main: string; signature: string | null; quote: string | null }

export const SIGNATURE_CLASS = 'tern-signature';
export const QUOTE_CLASS = 'tern-quote';

export function signatureBlock(signatureHtml: string): string {
  return `<div class="${SIGNATURE_CLASS}" style="margin-top:16px">${signatureHtml}</div>`;
}

// Takes the first signature block and the first quote block out of the
// HTML and returns the three pieces. Anything after the quote stays with it.
// Parsed in an inert document: looking at a draft must not load its images
// or run anything in it.
export function splitBody(html: string): BodyParts {
  if (!html) return { main: '', signature: null, quote: null };
  const doc = inertDocument(html);
  const root = doc.body;
  let signature: string | null = null;
  const s = root.querySelector(`.${SIGNATURE_CLASS}`);
  if (s) { signature = s.innerHTML; s.remove(); }
  let quote: string | null = null;
  const q = root.querySelector(`.${QUOTE_CLASS}`);
  if (q) {
    // The quote and everything that follows it (a second quote, trailing text) is the quoted part.
    const r = doc.createRange();
    r.setStartBefore(q);
    r.setEnd(root, root.childNodes.length);
    const frag = r.extractContents();
    const d = doc.createElement('div');
    d.appendChild(frag);
    quote = d.innerHTML;
  }
  return { main: root.innerHTML, signature, quote };
}

export function joinBody(p: BodyParts): string {
  let out = p.main || '';
  if (p.signature !== null && p.signature !== undefined && p.signature.trim()) out += signatureBlock(p.signature);
  if (p.quote) out += p.quote;
  return out;
}

export function isBlankHtml(html: string): boolean {
  if (!html) return true;
  if (/<img\b/i.test(html)) return false;
  return htmlToPlain(html).trim().length === 0;
}

// "Please see the attached" with nothing attached is the classic mistake;
// the composer asks before sending. Quoted text is excluded by the caller.
const ATTACH_RE = /\b(attach(?:ed|ment|ments|ing)?|enclosed|see (?:the )?(?:file|document|pdf)|(?:file|document|pdf|photo|screenshot)s? (?:is|are) (?:attached|enclosed|included))\b/i;
export function mentionsAttachment(text: string): boolean {
  return ATTACH_RE.test(text ?? '');
}

// Words that need no attachment: "detach", "attachment point" is rare enough to ignore.
export function bodyText(html: string): string {
  return htmlToPlain(html ?? '');
}
