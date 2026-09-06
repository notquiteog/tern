import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface Toast {
  id: number; message: string; kind?: 'info' | 'success' | 'error';
  action?: { label: string; onClick: () => void }; ttl?: number;
  // How long the action stays available, in ms. Draws a depleting ring with
  // the seconds left inside it, so an undo window is something you can see
  // running out rather than a guess.
  countdownMs?: number;
}
interface Ctx { toast: (message: string, opts?: Omit<Toast, 'id' | 'message'>) => void; error: (e: unknown, fallback?: string) => void; success: (m: string) => void }

const ToastCtx = createContext<Ctx>({ toast: () => {}, error: () => {}, success: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback((message: string, opts: Omit<Toast, 'id' | 'message'> = {}) => {
    const id = seq.current++;
    setItems((l) => [...l.slice(-3), { id, message, ...opts }]);
    window.setTimeout(() => dismiss(id), opts.ttl ?? (opts.kind === 'error' ? 7000 : 4000));
  }, [dismiss]);
  const value = useMemo<Ctx>(() => ({
    toast,
    success: (m) => toast(m, { kind: 'success' }),
    error: (e, fallback = 'Something went wrong') => toast(e instanceof Error ? e.message : typeof e === 'string' ? e : fallback, { kind: 'error' }),
  }), [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ''}`}>
            {t.countdownMs ? <Countdown ms={t.countdownMs} /> : null}
            <span>{t.message}</span>
            {t.action && <button onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// A ring that empties over `ms`, with the whole seconds left in the middle.
// The ring is a CSS animation so it stays smooth; only the number is redrawn,
// once a second.
const R = 9;
const CIRC = 2 * Math.PI * R;
function Countdown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(() => Math.ceil(ms / 1000));
  useEffect(() => {
    const until = Date.now() + ms;
    const id = window.setInterval(() => {
      const s = Math.ceil((until - Date.now()) / 1000);
      setLeft(s > 0 ? s : 0);
      if (s <= 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [ms]);
  return (
    <span className="toast-ring" aria-hidden="true" style={{ '--dur': `${ms}ms`, '--circ': CIRC } as any}>
      <svg viewBox="0 0 24 24" width="24" height="24">
        <circle cx="12" cy="12" r={R} className="ring-track" />
        <circle cx="12" cy="12" r={R} className="ring-fill" strokeDasharray={CIRC} />
      </svg>
      <b>{left}</b>
    </span>
  );
}
