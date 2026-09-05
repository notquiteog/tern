import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ImageOff } from 'lucide-react';
import { Button } from './ui';

// HTML mail renders inside a sandboxed iframe: no scripts, no forms, a CSP
// that blocks remote resources until the reader opts in, and links that open
// in a new tab. Inline (cid:) images are rewritten to the blob proxy.
export function MessageBody({ html, text, attachments, accountId, allowRemote: allowRemoteDefault }: { html: string | null; text: string | null; attachments: any[]; accountId: number; allowRemote?: boolean }) {
  const [allowRemote, setAllowRemote] = useState(Boolean(allowRemoteDefault));
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

  const { doc, hasRemote } = useMemo(() => {
    if (!html) return { doc: '', hasRemote: false };
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
    const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link', 'base', 'svg', 'math'], FORBID_ATTR: ['onerror', 'onload', 'srcset', 'formaction'], ALLOW_DATA_ATTR: false });
    DOMPurify.removeAllHooks();
    const csp = `default-src 'none'; img-src 'self' data: cid: blob:${allowRemote ? ' http: https:' : ''}; style-src 'unsafe-inline'; font-src data:; media-src 'self'`;
    const themed = dark && !(designed && original);
    const text = themed ? '#e8eaf1' : '#1c1f2b', muted = themed ? '#a4a9ba' : '#5b6274', link = themed ? '#9fb0ff' : '#2f48c9', rule = themed ? '#363b4b' : '#d0d4e0';
    const bg = designed && !themed ? '#ffffff' : 'transparent';
    const docHtml = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${themed ? 'dark' : 'light'}"><base target="_blank"><style>
      html,body{margin:0;padding:0;background:${bg}}body{font-family:"Inter Variable",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:${text};word-break:break-word;padding:4px 2px}
      img{max-width:100%;height:auto}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid ${rule};color:${muted}}pre{white-space:pre-wrap}a{color:${link}}table{max-width:100%}hr{border:0;border-top:1px solid ${rule}}
      ${themed && designed ? 'body{filter:invert(1) hue-rotate(180deg);background:#fff}img,video,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)}' : ''}
    </style></head><body>${clean}</body></html>`;
    return { doc: docHtml, hasRemote: remote };
  }, [html, attachments, accountId, allowRemote, dark, designed, original]);

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

  if (!html && text) return <div className="msg-text">{text}</div>;
  if (!html) return <div className="msg-text faint">(empty message)</div>;
  return (
    <div>
      {hasRemote && !allowRemote && <div className="msg-remote"><ImageOff size={14} /><span className="flex-1">Remote images are hidden to protect your privacy.</span><Button size="sm" onClick={() => setAllowRemote(true)}>Show images</Button></div>}
      {designed && dark && <div className="row small faint mb-8" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOriginal((o) => !o)}>{original ? 'Match theme' : 'Show original colours'}</button></div>}
      <iframe ref={ref} className={designed && (!dark || original) ? 'msg-frame designed' : 'msg-frame'} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height }} />
    </div>
  );
}
