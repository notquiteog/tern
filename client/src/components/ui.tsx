import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X, Inbox, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { cls, colorFor, initials } from '../lib/format';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'soft' | 'ai'; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; loading?: boolean; iconOnly?: boolean };
export function Button({ variant = 'default', size = 'md', icon, loading, iconOnly, className, children, ...rest }: BtnProps) {
  return (
    <button className={cls('btn', variant !== 'default' && `btn-${variant}`, variant === 'ai' && 'ai-btn', size === 'sm' && 'btn-sm', size === 'lg' && 'btn-lg', iconOnly && 'btn-icon', className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children}
    </button>
  );
}
export function IconButton({ label, className, size = 16, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number; children: ReactNode }) {
  return <button className={cls('btn btn-icon', className)} title={label} aria-label={label} {...rest} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={cls('input', props.className)} />; }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={cls('select', props.className)} />; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={cls('textarea', props.className)} />; }
export function Field({ label, hint, children, className }: { label?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <div className={cls('field', className)}>{label && <label>{label}</label>}{children}{hint && <div className="hint">{hint}</div>}</div>;
}
export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!checked)} />;
}
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return <div className="segmented">{options.map((o) => <button key={o.value} type="button" className={cls(o.value === value && 'active')} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function Badge({ kind, children, dot }: { kind?: 'accent' | 'success' | 'danger' | 'warning' | 'info'; children: ReactNode; dot?: boolean }) {
  return <span className={cls('badge', kind && `badge-${kind}`, dot && 'badge-dot')}>{children}</span>;
}
export function Avatar({ name, email, color, size, src, className }: { name?: string | null; email?: string; color?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; src?: string | null; className?: string }) {
  const label = name || email || '?';
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  const base = color ?? colorFor(email || label);
  return (
    <span className={cls('avatar', size === 'sm' && 'avatar-sm', size === 'lg' && 'avatar-lg', size === 'xl' && 'avatar-xl', className)} style={{ backgroundColor: base }} title={email}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : initials(label)}
    </span>
  );
}
export function Spinner({ size = 18 }: { size?: number }) { return <div className="spinner" style={{ width: size, height: size }} />; }
export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon ?? <Inbox size={26} />}</div><h3>{title}</h3>{children && <div className="muted" style={{ maxWidth: 420 }}>{children}</div>}{action && <div className="mt-8">{action}</div>}</div>;
}
export function Callout({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const Icon = kind === 'warning' ? AlertTriangle : kind === 'danger' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;
  return <div className={cls('callout', kind)}><Icon size={16} /><div>{children}</div></div>;
}
export function Kbd({ children }: { children: ReactNode }) { return <kbd>{children}</kbd>; }

export function Modal({ open, onClose, title, children, footer, size }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'wide' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cls('modal', size)} role="dialog" aria-modal="true">
        {title !== undefined && <div className="modal-header"><h2>{title}</h2><IconButton label="Close" onClick={onClose}><X size={18} /></IconButton></div>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger }: { open: boolean; onClose: () => void; onConfirm: () => void | Promise<void>; title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</Button></>}>
      <div className="muted">{message}</div>
    </Modal>
  );
}

// Anchored dropdown menu. Positioned with the trigger's rect and flipped when
// it would leave the viewport.
export function Menu({ trigger, children, align = 'left', width }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const mw = width ?? menuRef.current?.offsetWidth ?? 220;
    const mh = menuRef.current?.offsetHeight ?? 200;
    let left = align === 'right' ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    setPos({ top, left });
  }, [open, align, width]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <>
      <span ref={anchor} style={{ display: 'inline-flex' }}>{trigger(() => setOpen((o) => !o), open)}</span>
      {open && createPortal(<div ref={menuRef} className="menu" style={{ position: 'fixed', top: pos.top, left: pos.left, width }} onClick={(e) => e.stopPropagation()}>{children(() => setOpen(false))}</div>, document.body)}
    </>
  );
}
export function MenuItem({ icon, children, onClick, danger, shortcut, active }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; shortcut?: string; active?: boolean }) {
  return <button type="button" className={cls('menu-item', danger && 'danger', active && 'active')} onClick={onClick}>{icon}{children}{shortcut && <span className="shortcut">{shortcut}</span>}</button>;
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return <div className="tabs">{tabs.map((t) => <button key={t.value} type="button" className={cls(t.value === value && 'active')} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

export function Progress({ value, max, warnAt = 0.8 }: { value: number; max: number; warnAt?: number }) {
  const r = max ? Math.min(1, value / max) : 0;
  return <div className={cls('progress', r >= 1 && 'full', r >= warnAt && r < 1 && 'warn')}><div style={{ width: `${r * 100}%` }} /></div>;
}

export function Drawer({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <>
      <div className="modal-backdrop" style={{ justifyContent: 'flex-end', padding: 0, background: 'rgba(10,12,20,.25)' }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} />
      <div className="drawer" role="dialog">
        <div className="drawer-head"><div className="flex-1 strong">{title}</div>{actions}<IconButton label="Close" onClick={onClose}><X size={18} /></IconButton></div>
        <div className="drawer-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const colors = ['#4f6df5', '#e0567b', '#e08a3c', '#2fa572', '#8b5cf6', '#0ea5b7', '#d946ef', '#f59e0b', '#10b981', '#ef4444', '#64748b', '#0f172a'];
  return <div className="color-dots">{colors.map((c) => <button key={c} type="button" className={cls(value === c && 'active')} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />)}</div>;
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>{actions && <div className="row wrap">{actions}</div>}</div>;
}
