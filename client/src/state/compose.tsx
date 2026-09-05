import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Addr } from '../lib/format';

export interface ComposeSeed {
  accountId?: number | null;
  kind?: 'new' | 'reply' | 'reply_all' | 'forward';
  to?: Addr[]; cc?: Addr[]; bcc?: Addr[];
  subject?: string;
  html?: string;
  quoteHtml?: string;
  replyToEmailId?: number | null;
  forwardOfEmailId?: number | null;
  threadKey?: string | null;
  contactId?: number | null;
  draftId?: number | null;
  attachments?: { id: number; filename: string; size: number; content_type: string }[];
  autoAi?: 'reply' | 'compose' | null;
}
export interface ComposeWindow extends ComposeSeed { key: number; minimized: boolean; maximized: boolean }
interface Ctx { windows: ComposeWindow[]; open: (seed?: ComposeSeed) => void; close: (key: number) => void; update: (key: number, patch: Partial<ComposeWindow>) => void }

const C = createContext<Ctx>(null as any);
export const useCompose = () => useContext(C);
let seq = 1;

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<ComposeWindow[]>([]);
  const open = useCallback((seed: ComposeSeed = {}) => {
    setWindows((w) => {
      const maximized = window.innerWidth < 960;
      const next = [...w.map((x) => ({ ...x, minimized: w.length >= 1 ? true : x.minimized })), { key: seq++, minimized: false, maximized, kind: 'new' as const, ...seed }];
      return next.slice(-3);
    });
  }, []);
  const close = useCallback((key: number) => setWindows((w) => w.filter((x) => x.key !== key)), []);
  const update = useCallback((key: number, patch: Partial<ComposeWindow>) => setWindows((w) => w.map((x) => (x.key === key ? { ...x, ...patch } : x))), []);
  const value = useMemo(() => ({ windows, open, close, update }), [windows, open, close, update]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
