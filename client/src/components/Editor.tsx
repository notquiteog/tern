import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Bold, Italic, Underline, List, ListOrdered, Link2, Quote, RemoveFormatting, Undo2, Redo2 } from 'lucide-react';
import { IconButton } from './ui';

export interface EditorHandle { getHtml: () => string; setHtml: (h: string) => void; insertHtml: (h: string) => void; focus: () => void; appendText: (t: string) => void }

// contentEditable with a small toolbar. Uses execCommand, which every
// browser still ships and which is plenty for email formatting.
export const Editor = forwardRef<EditorHandle, { initialHtml?: string; placeholder?: string; onChange?: (html: string) => void; minHeight?: number; toolbar?: boolean; className?: string; extraToolbar?: React.ReactNode }>(function Editor({ initialHtml = '', placeholder, onChange, minHeight = 160, toolbar = true, className, extraToolbar }, ref) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { if (el.current && el.current.innerHTML !== initialHtml) el.current.innerHTML = initialHtml; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useImperativeHandle(ref, () => ({
    getHtml: () => el.current?.innerHTML ?? '',
    setHtml: (h) => { if (el.current) { el.current.innerHTML = h; onChange?.(h); } },
    insertHtml: (h) => { el.current?.focus(); document.execCommand('insertHTML', false, h); onChange?.(el.current?.innerHTML ?? ''); },
    appendText: (t) => { if (!el.current) return; const last = el.current.lastElementChild; const span = document.createTextNode(t); if (last && last.tagName === 'P') last.appendChild(span); else { const p = document.createElement('p'); p.appendChild(span); el.current.appendChild(p); } },
    focus: () => el.current?.focus(),
  }));
  const cmd = (c: string, v?: string) => { el.current?.focus(); document.execCommand(c, false, v); onChange?.(el.current?.innerHTML ?? ''); };
  return (
    <div className={`editor-wrap ${className ?? ''}`}>
      <div ref={el} className="editor" contentEditable suppressContentEditableWarning data-placeholder={placeholder} style={{ minHeight }}
        onInput={() => onChange?.(el.current?.innerHTML ?? '')}
        onPaste={(e) => {
          // Keep paste plain unless it is HTML from another mail; strips tracking pixels and font soup.
          const html = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          if (!html || html.length > 20000) { e.preventDefault(); document.execCommand('insertText', false, text); }
        }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); const url = prompt('Link URL'); if (url) cmd('createLink', url); } }}
      />
      {toolbar && (
        <div className="editor-toolbar">
          <IconButton label="Bold (Ctrl+B)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('bold'); }}><Bold size={15} /></IconButton>
          <IconButton label="Italic (Ctrl+I)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('italic'); }}><Italic size={15} /></IconButton>
          <IconButton label="Underline (Ctrl+U)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('underline'); }}><Underline size={15} /></IconButton>
          <span className="sep" />
          <IconButton label="Bulleted list" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('insertUnorderedList'); }}><List size={15} /></IconButton>
          <IconButton label="Numbered list" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('insertOrderedList'); }}><ListOrdered size={15} /></IconButton>
          <IconButton label="Quote" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('formatBlock', 'blockquote'); }}><Quote size={15} /></IconButton>
          <IconButton label="Link (Ctrl+K)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); const url = prompt('Link URL'); if (url) cmd('createLink', url); }}><Link2 size={15} /></IconButton>
          <IconButton label="Clear formatting" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('removeFormat'); cmd('formatBlock', 'p'); }}><RemoveFormatting size={15} /></IconButton>
          <span className="sep" />
          <IconButton label="Undo" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('undo'); }}><Undo2 size={15} /></IconButton>
          <IconButton label="Redo" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('redo'); }}><Redo2 size={15} /></IconButton>
          {extraToolbar && <><span className="sep" />{extraToolbar}</>}
        </div>
      )}
    </div>
  );
});
