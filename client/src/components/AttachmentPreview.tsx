import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { IconButton, Spinner } from './ui';
import { fmtBytes } from '../lib/format';

export interface PreviewItem { url: string; name: string; type: string; size?: number }

export function canPreview(type: string | null | undefined): boolean {
  const t = (type ?? '').toLowerCase();
  return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/.test(t) || t === 'application/pdf' || /^text\/(plain|csv|markdown|html)$/.test(t) || /^(audio|video)\//.test(t);
}

// A lightbox for attachments: images, PDFs, text and media, with arrows to
// walk through everything in the conversation. The file is fetched to a
// blob URL so the preview is not subject to the download route's sandbox.
export function AttachmentPreview({ items, index, onClose, onIndex }: { items: PreviewItem[]; index: number | null; onClose: () => void; onIndex: (i: number) => void }) {
  const item = index === null ? null : items[index];
  const [blob, setBlob] = useState<{ url: string; text?: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setBlob(null); setError('');
    if (!item) return;
    let objectUrl = '';
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(item.url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Could not load (${res.status})`);
        const b = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b.type ? b : new Blob([b], { type: item.type }));
        const isText = /^text\//.test(item.type) && item.type !== 'text/html';
        setBlob({ url: objectUrl, text: isText ? await b.text() : undefined });
      } catch (e: any) { if (!cancelled) setError(e.message ?? String(e)); }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item?.url, item?.type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (index === null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [index, items.length, onClose, onIndex]);
  if (!item || index === null) return null;
  const t = item.type.toLowerCase();
  const body = error ? <div className="lightbox-msg">{error}</div>
    : !blob ? <Spinner size={26} />
    : /^image\//.test(t) ? <img src={blob.url} alt={item.name} />
    : t === 'application/pdf' ? <iframe title={item.name} src={blob.url} />
    : blob.text !== undefined ? <pre className="lightbox-text">{blob.text}</pre>
    : /^video\//.test(t) ? <video src={blob.url} controls />
    : /^audio\//.test(t) ? <audio src={blob.url} controls />
    : <div className="lightbox-msg">No preview for this file type.<br /><a className="btn mt-8" href={`${item.url}&download=1`}>Download</a></div>;
  return createPortal(
    <div className="lightbox" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lightbox-head">
        <span className="truncate strong">{item.name}</span>
        {item.size ? <span className="small faint">{fmtBytes(item.size)}</span> : null}
        <span className="small faint">{index + 1} / {items.length}</span>
        <span className="ml-auto row gap-4">
          <a className="btn btn-icon" title="Open in a new tab" href={blob?.url ?? item.url} target="_blank" rel="noopener"><ExternalLink size={16} /></a>
          <a className="btn btn-icon" title="Download" href={`${item.url}&download=1`}><Download size={16} /></a>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </span>
      </div>
      {index > 0 && <button type="button" className="lightbox-nav prev" aria-label="Previous" onClick={() => onIndex(index - 1)}><ChevronLeft size={22} /></button>}
      {index < items.length - 1 && <button type="button" className="lightbox-nav next" aria-label="Next" onClick={() => onIndex(index + 1)}><ChevronRight size={22} /></button>}
      <div className="lightbox-body">{body}</div>
    </div>,
    document.body,
  );
}
