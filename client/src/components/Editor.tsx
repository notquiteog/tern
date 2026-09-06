import { useEffect, useImperativeHandle, useRef, useState, forwardRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bold, Italic, Underline, Strikethrough, List, ListOrdered, Link2, Quote, RemoveFormatting, Undo2, Redo2, AlignLeft, AlignCenter, AlignRight, Indent, Outdent, Image as ImageIcon, Smile, Type, Palette } from 'lucide-react';
import { IconButton, Menu } from './ui';
import { cls } from '../lib/format';

export interface EditorHandle {
  getHtml: () => string;
  setHtml: (h: string) => void;
  insertHtml: (h: string) => void;
  insertText: (t: string) => void;
  focus: () => void;
  focusStart: () => void;
  appendText: (t: string) => void;
  element: () => HTMLDivElement | null;
}

const SIZES: [string, string][] = [['Small', '1'], ['Normal', '3'], ['Large', '5'], ['Huge', '7']];
const COLORS = ['#000000', '#5b6274', '#9aa0b3', '#ffffff', '#d9364a', '#e08a3c', '#f2b01e', '#1f9d64', '#0ea5b7', '#4f6df5', '#8b5cf6', '#d946ef'];
const EMOJI = ['😀', '😄', '😊', '🙂', '😉', '😍', '🤔', '😅', '😂', '🙏', '👍', '👎', '👋', '🙌', '👏', '💪', '🎉', '✅', '❌', '⭐', '🔥', '💡', '📎', '📅', '📞', '✉️', '💬', '❤️', '🚀', '☕', '🍕', '🎯', '⏰', '📌', '🔔', '🤝', '😎', '🤷', '🙈', '💯'];

// contentEditable with a Gmail-shaped toolbar. execCommand is what every
// browser still ships, and the tags it produces (b, i, u, font, blockquote,
// ul/ol) are exactly the ones mail clients render best.
export const Editor = forwardRef<EditorHandle, {
  initialHtml?: string; placeholder?: string; onChange?: (html: string) => void; minHeight?: number; maxHeight?: number; toolbar?: boolean; className?: string; extraToolbar?: ReactNode;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  // Files pasted or dropped into the text. Return true to say they were handled.
  onFiles?: (files: File[], kind: 'paste' | 'drop') => boolean | void;
  // Insert an image: given the file, resolve to the URL to embed.
  onInsertImage?: (file: File) => Promise<string | null>;
  autoFocus?: boolean;
}>(function Editor({ initialHtml = '', placeholder, onChange, minHeight = 160, maxHeight, toolbar = true, className, extraToolbar, onKeyDown, onFiles, onInsertImage, autoFocus }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const [linkUrl, setLinkUrl] = useState('');
  useEffect(() => { if (el.current && el.current.innerHTML !== initialHtml) el.current.innerHTML = initialHtml; if (autoFocus) focusStart(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const emit = () => onChange?.(el.current?.innerHTML ?? '');
  const saveSel = () => { const s = window.getSelection(); if (s && s.rangeCount && el.current?.contains(s.anchorNode)) saved.current = s.getRangeAt(0).cloneRange(); };
  const restoreSel = () => { const r = saved.current; if (!r) return; const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); };
  const cmd = (c: string, v?: string) => { el.current?.focus(); restoreSel(); document.execCommand(c, false, v); saveSel(); emit(); };
  function focusStart() {
    const node = el.current;
    if (!node) return;
    node.focus();
    const r = document.createRange();
    r.setStart(node, 0); r.collapse(true);
    const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
  }
  useImperativeHandle(ref, () => ({
    getHtml: () => el.current?.innerHTML ?? '',
    setHtml: (h) => { if (el.current) { el.current.innerHTML = h; emit(); } },
    insertHtml: (h) => { el.current?.focus(); restoreSel(); document.execCommand('insertHTML', false, h); emit(); },
    insertText: (t) => { el.current?.focus(); restoreSel(); document.execCommand('insertText', false, t); emit(); },
    appendText: (t) => { if (!el.current) return; const last = el.current.lastElementChild; const span = document.createTextNode(t); if (last && last.tagName === 'P') last.appendChild(span); else { const p = document.createElement('p'); p.appendChild(span); el.current.appendChild(p); } emit(); },
    focus: () => el.current?.focus(),
    focusStart,
    element: () => el.current,
  }));

  async function pickImage(file: File | undefined) {
    if (!file || !onInsertImage) return;
    const url = await onInsertImage(file);
    if (url) { el.current?.focus(); restoreSel(); document.execCommand('insertHTML', false, `<img src="${url}" alt="${file.name.replace(/"/g, '')}" style="max-width:100%">`); emit(); }
  }

  return (
    <div className={cls('editor-wrap', className)}>
      <div ref={el} className="editor" contentEditable suppressContentEditableWarning data-placeholder={placeholder} style={{ minHeight, maxHeight }} spellCheck
        onInput={emit}
        onKeyUp={saveSel} onMouseUp={saveSel} onBlur={saveSel}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); saveSel(); const url = prompt('Link URL'); if (url) cmd('createLink', url); }
          if (e.key === 'Tab' && !e.shiftKey && document.queryCommandState('insertUnorderedList') === false && document.queryCommandState('insertOrderedList') === false) { /* let Tab move focus */ }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files ?? []);
          if (files.length && onFiles) { const handled = onFiles(files, 'paste'); if (handled !== false) { e.preventDefault(); return; } }
          // Keep paste plain unless it is HTML from another mail; strips tracking pixels and font soup.
          const html = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          if (!html || html.length > 20000) { e.preventDefault(); document.execCommand('insertText', false, text); }
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length && onFiles) { const handled = onFiles(files, 'drop'); if (handled !== false) e.preventDefault(); }
        }}
      />
      {toolbar && (
        <div className="editor-toolbar">
          <IconButton label="Undo" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('undo'); }}><Undo2 size={15} /></IconButton>
          <IconButton label="Redo" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('redo'); }}><Redo2 size={15} /></IconButton>
          <span className="sep" />
          <Menu width={140} trigger={(open) => <IconButton label="Text size" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); saveSel(); open(); }}><Type size={15} /></IconButton>}>
            {(c) => <>{SIZES.map(([l, v]) => <button key={v} type="button" className="menu-item" style={{ fontSize: v === '1' ? 12 : v === '3' ? 14 : v === '5' ? 17 : 21 }} onMouseDown={(e) => { e.preventDefault(); cmd('fontSize', v); c(); }}>{l}</button>)}</>}
          </Menu>
          <IconButton label="Bold (Ctrl+B)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('bold'); }}><Bold size={15} /></IconButton>
          <IconButton label="Italic (Ctrl+I)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('italic'); }}><Italic size={15} /></IconButton>
          <IconButton label="Underline (Ctrl+U)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('underline'); }}><Underline size={15} /></IconButton>
          <IconButton label="Strikethrough" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('strikeThrough'); }}><Strikethrough size={15} /></IconButton>
          <Menu width={196} trigger={(open) => <IconButton label="Text colour" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); saveSel(); open(); }}><Palette size={15} /></IconButton>}>
            {(c) => <div className="color-grid">{COLORS.map((col) => <button key={col} type="button" aria-label={col} style={{ background: col }} onMouseDown={(e) => { e.preventDefault(); cmd('foreColor', col); c(); }} />)}</div>}
          </Menu>
          <span className="sep" />
          <Menu width={150} trigger={(open) => <IconButton label="Align" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); saveSel(); open(); }}><AlignLeft size={15} /></IconButton>}>
            {(c) => <>
              <button type="button" className="menu-item" onMouseDown={(e) => { e.preventDefault(); cmd('justifyLeft'); c(); }}><AlignLeft size={14} /> Left</button>
              <button type="button" className="menu-item" onMouseDown={(e) => { e.preventDefault(); cmd('justifyCenter'); c(); }}><AlignCenter size={14} /> Centre</button>
              <button type="button" className="menu-item" onMouseDown={(e) => { e.preventDefault(); cmd('justifyRight'); c(); }}><AlignRight size={14} /> Right</button>
            </>}
          </Menu>
          <IconButton label="Numbered list" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('insertOrderedList'); }}><ListOrdered size={15} /></IconButton>
          <IconButton label="Bulleted list" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('insertUnorderedList'); }}><List size={15} /></IconButton>
          <IconButton label="Indent less" className="btn-sm desktop-only" onMouseDown={(e) => { e.preventDefault(); cmd('outdent'); }}><Outdent size={15} /></IconButton>
          <IconButton label="Indent more" className="btn-sm desktop-only" onMouseDown={(e) => { e.preventDefault(); cmd('indent'); }}><Indent size={15} /></IconButton>
          <IconButton label="Quote" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('formatBlock', 'blockquote'); }}><Quote size={15} /></IconButton>
          <span className="sep" />
          <Menu width={300} trigger={(open) => <IconButton label="Link (Ctrl+K)" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); saveSel(); setLinkUrl(''); open(); }}><Link2 size={15} /></IconButton>}>
            {(c) => <div style={{ padding: 6 }} className="row"><input className="input input-sm" autoFocus placeholder="https://" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (linkUrl.trim()) cmd('createLink', /^https?:\/\/|^mailto:/i.test(linkUrl) ? linkUrl.trim() : `https://${linkUrl.trim()}`); c(); } }} /><button type="button" className="btn btn-sm btn-primary" onMouseDown={(e) => { e.preventDefault(); if (linkUrl.trim()) cmd('createLink', /^https?:\/\/|^mailto:/i.test(linkUrl) ? linkUrl.trim() : `https://${linkUrl.trim()}`); c(); }}>Apply</button></div>}
          </Menu>
          {onInsertImage && <>
            <IconButton label="Insert image" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); saveSel(); imgInput.current?.click(); }}><ImageIcon size={15} /></IconButton>
            <input ref={imgInput} type="file" accept="image/*" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }} />
          </>}
          <Menu width={252} trigger={(open) => <IconButton label="Emoji" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); saveSel(); open(); }}><Smile size={15} /></IconButton>}>
            {(c) => <div className="emoji-grid">{EMOJI.map((em) => <button key={em} type="button" onMouseDown={(e) => { e.preventDefault(); el.current?.focus(); restoreSel(); document.execCommand('insertText', false, em); emit(); c(); }}>{em}</button>)}</div>}
          </Menu>
          <IconButton label="Clear formatting" className="btn-sm" onMouseDown={(e) => { e.preventDefault(); cmd('removeFormat'); cmd('formatBlock', 'p'); }}><RemoveFormatting size={15} /></IconButton>
          {extraToolbar && <><span className="sep" />{extraToolbar}</>}
        </div>
      )}
    </div>
  );
});
