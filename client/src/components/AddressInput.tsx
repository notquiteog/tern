import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useDebounced } from '../lib/hooks';
import type { Addr } from '../lib/format';
import { cls } from '../lib/format';
import { X } from 'lucide-react';

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// "Name <a@b.c>", "a@b.c, d@e.f" and bare addresses all become chips.
export function parseAddresses(text: string): Addr[] {
  const out: Addr[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
    if (m) out.push({ name: m[1].trim() || null, email: m[2].trim() });
    else out.push({ name: null, email: t.replace(/^<|>$/g, '') });
  }
  return out;
}

export function AddressInput({ value, onChange, placeholder, autoFocus, onTab }: { value: Addr[]; onChange: (v: Addr[]) => void; placeholder?: string; autoFocus?: boolean; onTab?: () => void }) {
  const [text, setText] = useState('');
  const [sug, setSug] = useState<{ email: string; name: string; source: string }[]>([]);
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(text, 180);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) { setSug([]); return; }
    api.get<{ suggestions: any[] }>(`/api/mail/suggest?q=${encodeURIComponent(debounced.trim())}`).then((r) => { if (!cancelled) { setSug(r.suggestions.filter((s) => !value.some((v) => v.email.toLowerCase() === s.email.toLowerCase()))); setIdx(0); setOpen(true); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [debounced, value]);

  function commit(raw?: string) {
    const src = raw ?? text;
    if (!src.trim()) return;
    const parsed = parseAddresses(src);
    onChange([...value, ...parsed]);
    setText(''); setSug([]); setOpen(false);
  }
  function pick(s: { email: string; name: string }) {
    onChange([...value, { name: s.name || null, email: s.email }]);
    setText(''); setSug([]); setOpen(false);
    inputRef.current?.focus();
  }
  return (
    <div className="addr-field" onClick={() => inputRef.current?.focus()}>
      {value.map((a, i) => (
        <span key={i} className={cls('chip', !EMAIL_RE.test(a.email) && 'invalid')} title={a.email}>
          <span className="truncate">{a.name ? `${a.name}` : a.email}</span>
          <button type="button" className="chip-x" aria-label="Remove" onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }}><X size={12} /></button>
        </span>
      ))}
      <input ref={inputRef} autoFocus={autoFocus} value={text} placeholder={value.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { setTimeout(() => { commit(); setOpen(false); }, 120); }}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\n<]/.test(t) || (t.match(/@/g)?.length ?? 0) > 1) { e.preventDefault(); commit(t); } }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && (text.trim() || (open && sug[idx]))) { e.preventDefault(); if (open && sug[idx] && e.key === 'Enter') pick(sug[idx]); else commit(); }
          else if (e.key === 'Tab') { if (text.trim()) { e.preventDefault(); if (open && sug[idx]) pick(sug[idx]); else commit(); } else if (onTab) { /* natural tab */ } }
          else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          else if (e.key === 'ArrowDown' && sug.length) { e.preventDefault(); setIdx((i) => Math.min(sug.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp' && sug.length) { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {open && sug.length > 0 && (
        <div className="menu suggest">
          {sug.map((s, i) => <button key={s.email} type="button" className={cls('menu-item', i === idx && 'active')} onMouseDown={(e) => { e.preventDefault(); pick(s); }}><span className="col" style={{ gap: 0, minWidth: 0 }}><span className="truncate">{s.name || s.email}</span>{s.name && <span className="small faint truncate">{s.email}</span>}</span><span className="shortcut">{s.source}</span></button>)}
        </div>
      )}
    </div>
  );
}
