// Screens register context while mounted. Drafts remain getters so a question
// sees the current editor text without re-rendering the app on every keystroke.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ThreadContext { accountId: number; threadId: string }
export interface DraftContext { to?: string[]; subject?: string; body?: string }
export interface FocusContext {
  kind: 'contact' | 'sequence' | 'day';
  label: string;
  ref?: string | null;
  detail?: string | null;
}
export interface ViewContext {
  thread?: ThreadContext | null;
  draft?: DraftContext | null;
  page?: string | null;
  focus?: FocusContext | null;
}
export interface AssistantQuestion { prompt: string; view: ViewContext }
type Register<T> = (value: T) => () => void;
interface Ctx {
  open: boolean;
  /** A supplied question captures its context now, even if another turn is running. */
  show: (prompt?: string, context?: ViewContext) => void;
  hide: () => void;
  toggle: () => void;
  pendingCount: number;
  takePending: () => AssistantQuestion | null;
  clearPending: () => void;
  view: () => ViewContext;
  registerThread: Register<ThreadContext | null>;
  registerDraft: Register<(() => DraftContext | null) | null>;
  registerPage: Register<string | null>;
  registerFocus: Register<FocusContext | null>;
}
const C = createContext<Ctx>(null as any);
export const useAssistant = () => useContext(C);

// Each registration owns its cleanup. Closing a pop-out composer restores the
// inline draft beneath it; an older screen's cleanup cannot clear a newer one.
function useRegistration<T>(changed: () => void): [() => T | null, Register<T>] {
  const entries = useRef(new Map<symbol, T>());
  const read = useCallback(() => [...entries.current.values()].at(-1) ?? null, []);
  const register = useCallback((value: T) => {
    const key = Symbol();
    entries.current.set(key, value);
    changed();
    return () => { entries.current.delete(key); changed(); };
  }, [changed]);
  return [read, register];
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const [thread, registerThread] = useRegistration<ThreadContext | null>(changed);
  const [draft, registerDraft] = useRegistration<(() => DraftContext | null) | null>(changed);
  const [page, registerPage] = useRegistration<string | null>(changed);
  const [focus, registerFocus] = useRegistration<FocusContext | null>(changed);
  const view = useCallback((): ViewContext => ({ thread: thread(), draft: draft()?.() ?? null, page: page(), focus: focus() }), [thread, draft, page, focus]);
  const pending = useRef<AssistantQuestion[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const show = useCallback((prompt?: string, context?: ViewContext) => {
    if (prompt?.trim()) {
      pending.current.push({ prompt, view: structuredClone(context ?? view()) });
      setPendingCount(pending.current.length);
    }
    setOpen(true);
  }, [view]);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const takePending = useCallback(() => {
    const question = pending.current.shift() ?? null;
    setPendingCount(pending.current.length);
    return question;
  }, []);
  const clearPending = useCallback(() => { pending.current = []; setPendingCount(0); }, []);
  const value = useMemo<Ctx>(() => ({
    open, show, hide, toggle, pendingCount, takePending, clearPending, view,
    registerThread, registerDraft, registerPage, registerFocus,
  }), [open, show, hide, toggle, pendingCount, takePending, clearPending, view,
    registerThread, registerDraft, registerPage, registerFocus, revision]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useThreadContext(t: ThreadContext | null): void {
  const { registerThread } = useAssistant();
  const key = t ? `${t.accountId}:${t.threadId}` : '';
  useEffect(() => registerThread(t), [key, registerThread]);
}
export function useDraftContext(get: () => DraftContext | null): void {
  const { registerDraft } = useAssistant();
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => registerDraft(() => latest.current()), [registerDraft]);
}
export function usePageContext(name: string | null): void {
  const { registerPage } = useAssistant();
  useEffect(() => registerPage(name), [name, registerPage]);
}
export function useFocusContext(f: FocusContext | null): void {
  const { registerFocus } = useAssistant();
  const key = JSON.stringify(f);
  useEffect(() => registerFocus(f), [key, registerFocus]);
}
