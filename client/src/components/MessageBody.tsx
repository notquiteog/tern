import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ImageOff, MoreHorizontal } from 'lucide-react';
import { Button } from './ui';
import { splitQuotedHtml, splitQuotedText } from '../lib/quote';

// Senders whose remote images are always shown, remembered in this browser.
const ALLOW_KEY = 'tern.showImagesFrom';
export function allowedSenders(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(ALLOW_KEY) ?? '[]')); } catch { return new Set(); }
}
export function allowSender(email: string, on = true): void {
  const s = allowedSenders();
  if (on) s.add(email.toLowerCase()); else s.delete(email.toLowerCase());
  try { localStorage.setItem(ALLOW_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

// HTML mail renders inside a sandboxed iframe: no scripts, no forms, a CSP
// that blocks remote resources until the reader opts in, and links that open
// in a new tab. Inline (cid:) images are rewritten to the blob proxy. The
// quoted earlier messages are folded behind a "…" button, as in Gmail.
export function MessageBody({ html, text, attachments, accountId, allowRemote: allowRemoteDefault, senderEmail, autoAllow, collapseQuote = true }: { html: string | null; text: string | null; attachments: any[]; accountId: number; allowRemote?: boolean; senderEmail?: string; autoAllow?: boolean; collapseQuote?: boolean }) {
  const sender = (senderEmail ?? '').toLowerCase();
  const [allowRemote, setAllowRemote] = useState(Boolean(allowRemoteDefault) || Boolean(autoAllow) || (sender ? allowedSenders().has(sender) : false));
  const [showQuote, setShowQuote] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  // "Designed" mail (newsletters with their own backgrounds and tables) keeps its
  // colours on a light card; plain correspondence follows the app theme.
  const designed = useMemo(() => Boolean(html && (/background(-color)?\s*:|bgcolor=|<table[^>]+(width|bgcolor)/i.test(html))), [html]);

  // Sanitize once, then split off the quote; both are independent of theme.
  const { clean, hasRemote, main, quoted } = useMemo(() => {
    if (!html) return { clean: '', hasRemote: false, main: '', quoted: null as string | null };
    const cidMap = new Map<string, string>();
    for (const a of attachments ?? []) if (a.cid && a.blobId) cidMap.set(a.cid.replace(/^<|>$/g, ''), `/api/mail/blob/${accountId}/${encodeURIComponent(a.blobId)}?name=${encodeURIComponent(a.name ?? 'image')}&type=${encodeURIComponent(a.type ?? 'image/png')}`);
    let remote = false;
    DOMPurify.removeAllHooks();
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      const src = node.getAttribute?.('src');
      if (src) {
        if (src.startsWith('cid:')) { const u = cidMap.get(src.slice(4)); if (u) node.setAttribute('src', u); else node.removeAttribute('src'); }
        else if (/^https?:/i.test(src)) { remote = true; }
      }
      const style = node.getAttribute?.('style');
      if (style && /url\(\s*['"]?https?:/i.test(style)) { remote = true; }
    });
    const cleanHtml = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link', 'base', 'svg', 'math'], FORBID_ATTR: ['onerror', 'onload', 'srcset', 'formaction'], ALLOW_DATA_ATTR: false });
    DOMPurify.removeAllHooks();
    const split = collapseQuote ? splitQuotedHtml(cleanHtml) : { main: cleanHtml, quoted: null };
    return { clean: cleanHtml, hasRemote: remote, main: split.main, quoted: split.quoted };
  }, [html, attachments, accountId, collapseQuote]);

  const doc = useMemo(() => {
    if (!html) return '';
    const body = quoted && !showQuote ? main : clean;
    const csp = `default-src 'none'; img-src 'self' data: cid: blob:${allowRemote ? ' http: https:' : ''}; style-src 'unsafe-inline'; font-src data:; media-src 'self'`;
    const themed = dark && !(designed && original);
    const text = themed ? '#e8eaf1' : '#1c1f2b', muted = themed ? '#a4a9ba' : '#5b6274', link = themed ? '#9fb0ff' : '#2f48c9', rule = themed ? '#363b4b' : '#d0d4e0';
    const bg = designed && !themed ? '#ffffff' : 'transparent';
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${themed ? 'dark' : 'light'}"><base target="_blank"><style>
      html,body{margin:0;padding:0;background:${bg}}body{font-family:"Inter Variable",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:${text};word-break:break-word;padding:4px 2px}
      img{max-width:100%;height:auto}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid ${rule};color:${muted}}pre{white-space:pre-wrap}a{color:${link}}table{max-width:100%}hr{border:0;border-top:1px solid ${rule}}
      ${themed && designed ? 'body{filter:invert(1) hue-rotate(180deg);background:#fff}img,video,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)}' : ''}
    </style></head><body>${body}</body></html>`;
  }, [html, clean, main, quoted, showQuote, allowRemote, dark, designed, original]);

  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    let ro: ResizeObserver | null = null;
    const measure = () => { try { const h = f.contentDocument?.documentElement?.scrollHeight ?? f.contentDocument?.body?.scrollHeight; if (h) setHeight(Math.min(Math.max(h + 8, 40), 20000)); } catch { /* cross-origin safety */ } };
    const onLoad = () => {
      measure();
      try { const body = f.contentDocument?.body; if (body && 'ResizeObserver' in window) { ro = new ResizeObserver(measure); ro.observe(body); } } catch { /* ignore */ }
      setTimeout(measure, 150); setTimeout(measure, 800);
    };
    f.addEventListener('load', onLoad);
    return () => { f.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [doc]);

  if (!html && text) {
    const split = collapseQuote ? splitQuotedText(text) : { main: text, quoted: null };
    return (
      <div>
        <div className="msg-text">{split.quoted && !showQuote ? split.main : text}</div>
        {split.quoted && !showQuote && <button type="button" className="quote-toggle" title="Show quoted text" onClick={() => setShowQuote(true)}><MoreHorizontal size={14} /></button>}
      </div>
    );
  }
  if (!html) return <div className="msg-text faint">(empty message)</div>;
  return (
    <div>
      {hasRemote && !allowRemote && <div className="msg-remote"><ImageOff size={14} /><span className="flex-1">Remote images are hidden to protect your privacy.</span><Button size="sm" onClick={() => setAllowRemote(true)}>Show images</Button>{sender && <Button size="sm" variant="ghost" onClick={() => { allowSender(sender); setAllowRemote(true); }}>Always from this sender</Button>}</div>}
      {designed && dark && <div className="row small faint mb-8" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOriginal((o) => !o)}>{original ? 'Match theme' : 'Show original colours'}</button></div>}
      <iframe ref={ref} className={designed && (!dark || original) ? 'msg-frame designed' : 'msg-frame'} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height }} />
      {quoted && !showQuote && <button type="button" className="quote-toggle" title="Show quoted text" onClick={() => setShowQuote(true)}><MoreHorizontal size={14} /></button>}
    </div>
  );
}
