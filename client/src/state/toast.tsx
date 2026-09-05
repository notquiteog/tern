import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export interface Toast { id: number; message: string; kind?: 'info' | 'success' | 'error'; action?: { label: string; onClick: () => void }; ttl?: number }
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
            <span>{t.message}</span>
            {t.action && <button onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
