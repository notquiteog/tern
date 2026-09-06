// HTML from outside (received mail, drafts that quote it, templates, model
// output) never reaches the live page as it came. Two profiles:
//   view    for the sandboxed message frame: keeps the mail's look, blocks
//           anything active, marks links whose text lies about their target.
//   editor  for the contentEditable composer, which is part of the app page
//           itself: stricter, since nothing in there is sandboxed.
// Both are on top of the page's Content-Security-Policy (no inline
// scripts, no remote images outside the frame), which catches what a
// sanitiser bug lets through.
import DOMPurify from 'dompurify';

export type SanitizeProfile = 'view' | 'editor';

const FORBID_TAGS_COMMON = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'option', 'meta', 'link', 'base', 'svg', 'math', 'template', 'noscript', 'dialog', 'portal', 'slot'];
const FORBID_TAGS_EDITOR = [...FORBID_TAGS_COMMON, 'video', 'audio', 'source', 'track', 'picture', 'canvas', 'map', 'area', 'details', 'summary'];
const FORBID_ATTR = ['srcset', 'formaction', 'autofocus', 'contenteditable', 'tabindex', 'draggable', 'accesskey', 'ping', 'download', 'xlink:href', 'action', 'poster', 'background', 'dynsrc', 'lowsrc'];

const URL_LIKE = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#].*)?$/i;

function hostOf(url: string): string | null {
  try { return new URL(url, 'http://x.invalid').hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}
function registrable(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

// A link whose visible text is itself an address on another site.
export function linkMismatch(text: string, href: string): { shown: string; real: string } | null {
  const t = text.trim();
  const m = t.match(URL_LIKE);
  if (!m || t.length > 200) return null;
  if (!/^https?:/i.test(href)) return null;
  const shown = m[1].toLowerCase().replace(/^www\./, '');
  const real = hostOf(href);
  if (!real) return null;
  if (registrable(shown) === registrable(real)) return null;
  return { shown, real };
}

// Inline styles: keep the look, drop what lets content leave its box or
// call out. The frame's CSP already blocks remote resources; this keeps a
// quoted newsletter from covering the composer with a fixed overlay.
function cleanStyle(style: string, profile: SanitizeProfile): string {
  return style.split(';').map((d) => d.trim()).filter((d) => {
    if (!d) return false;
    const lower = d.toLowerCase();
    if (/expression\s*\(|behavior\s*:|-moz-binding|javascript:|vbscript:/.test(lower)) return false;
    if (/^position\s*:\s*(fixed|sticky)/.test(lower)) return false;
    if (profile === 'editor' && /^position\s*:\s*absolute/.test(lower)) return false;
    if (profile === 'editor' && /url\s*\(/.test(lower)) return false;
    return true;
  }).join('; ');
}

let hooked: SanitizeProfile | null = null;
function installHooks(profile: SanitizeProfile, ctx: { cidMap?: Map<string, string>; onRemote?: () => void }): void {
  DOMPurify.removeAllHooks();
  hooked = profile;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (href && !/^(https?:|mailto:|tel:|#)/i.test(href)) el.removeAttribute('href');
      if (profile === 'view') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      else { el.removeAttribute('target'); el.setAttribute('rel', 'noopener noreferrer'); }
      const mm = href ? linkMismatch(el.textContent ?? '', href) : null;
      if (mm) el.setAttribute('data-tern-link-warn', `${mm.shown}|${mm.real}`); else el.removeAttribute('data-tern-link-warn');
    }
    const src = el.getAttribute('src');
    if (src) {
      if (src.startsWith('cid:')) {
        const u = ctx.cidMap?.get(src.slice(4).replace(/^<|>$/g, ''));
        if (u) el.setAttribute('src', u); else if (profile === 'editor') { /* keep cid: for a forward; the server rewrites it */ } else el.removeAttribute('src');
      } else if (/^https?:/i.test(src)) {
        ctx.onRemote?.();
      } else if (!/^(data:image\/|blob:|\/api\/mail\/(uploads|blob)\/)/i.test(src)) {
        el.removeAttribute('src');
      }
    }
    const style = el.getAttribute('style');
    if (style) {
      if (/url\(\s*['"]?https?:/i.test(style)) ctx.onRemote?.();
      const cleaned = cleanStyle(style, profile);
      if (cleaned) el.setAttribute('style', cleaned); else el.removeAttribute('style');
    }
    // id/name could shadow the app's own anchors and form fields; classes
    // could borrow the app's styles. Only the composer's own markers
    // (tern-quote, tern-signature) are kept, since the body helpers find
    // the quote and the signature by them.
    if (profile === 'editor') {
      el.removeAttribute('id'); el.removeAttribute('name');
      const kept = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => /^tern-(quote|quote-head|signature)$/.test(c));
      if (kept.length) el.setAttribute('class', kept.join(' ')); else el.removeAttribute('class');
    }
  });
}

export interface SanitizeOptions { cidMap?: Map<string, string>; onRemote?: () => void }

export function sanitizeHtml(html: string, profile: SanitizeProfile, opts: SanitizeOptions = {}): string {
  if (!html) return '';
  installHooks(profile, opts);
  try {
    return DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: profile === 'editor' ? FORBID_TAGS_EDITOR : FORBID_TAGS_COMMON,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: profile === 'view' ? ['target'] : [],
      ALLOW_UNKNOWN_PROTOCOLS: false,
    }) as string;
  } finally {
    DOMPurify.removeAllHooks();
    hooked = null;
  }
}

export function sanitizeForEditor(html: string): string { return sanitizeHtml(html, 'editor'); }
export function sanitizeForView(html: string, opts: SanitizeOptions = {}): string { return sanitizeHtml(html, 'view', opts); }

// Parse without side effects: nothing loads, nothing runs, so a helper that
// only wants the text or structure of some HTML never fires an image
// request or a handler while looking at it.
export function inertDocument(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, 'text/html');
}

export function isHooked(): SanitizeProfile | null { return hooked; }
