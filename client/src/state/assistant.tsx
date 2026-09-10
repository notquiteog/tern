// What the assistant is looking at, and whether it is open.
//
// ── Why the view context lives in a provider ────────────────────────────────
//
// Because "summarise this" is the whole point, and the word "this" is not in
// the message. Somebody reading a conversation and typing four words has told
// the assistant everything they intend to; what makes it answerable is that
// the thread they are looking at travels with the question.
//
// The alternative — the panel reaching into the router and guessing from the
// URL — was the first version and it was wrong in both directions. It could
// not see a draft in a composer window, which has no URL at all, and it
// happily claimed a thread on a page where the reading pane was closed. So
// the screens announce what they are showing instead: a thread view registers
// its thread while it is mounted and unregisters on the way out, a composer
// registers its draft, and the provider holds whatever is currently true.
//
// Last registration wins, and that is deliberate rather than incidental: a
// composer opened on top of a thread is the thing in front of the person, so
// "make it shorter" means the draft. The thread is still reachable — it is
// named in the same prompt — but the draft is what "it" points at.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ThreadContext { accountId: number; threadId: string }
export interface DraftContext { to?: string[]; subject?: string; body?: string }

/**
 * What the page is about, where it is about one thing.
 *
 * `page` says which screen; this says which *thing on it*. The difference is
 * the one between "they are on the contacts page" — which answers nothing —
 * and "they are looking at Dana Okafor", which is what makes "what do I owe
 * them?" a question with a referent.
 */
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

interface Ctx {
  open: boolean;
  /** Open the panel, optionally with a question already typed. */
  show: (prompt?: string) => void;
  hide: () => void;
  toggle: () => void;
  /** A question to send as soon as the panel is ready, consumed once. */
  takePending: () => string | null;
  /** What is on screen right now, for the server to resolve "this" against. */
  view: () => ViewContext;
  registerThread: (t: ThreadContext | null) => void;
  /**
   * A draft is registered as a GETTER rather than a value.
   *
   * The composer keeps its body in a ref and its editor in the DOM, because
   * re-rendering a rich text editor on every keystroke is the one thing it
   * must not do. A value-shaped registration would therefore be stale by
   * exactly the amount somebody had typed since the last render, which on the
   * question this exists to answer — "make this shorter" — is most of it.
   * Asking at send time reads whatever is in the editor at send time.
   */
  registerDraft: (get: (() => DraftContext | null) | null) => void;
  registerPage: (p: string | null) => void;
  registerFocus: (f: FocusContext | null) => void;
}

const C = createContext<Ctx>(null as any);
export const useAssistant = () => useContext(C);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pending = useRef<string | null>(null);
  // Refs rather than state, and that is the point of this file rather than a
  // shortcut. The view context is read at the moment a message is sent and is
  // never rendered, so putting it in state would re-render every screen in the
  // app each time somebody scrolled a reading pane into a different thread.
  const thread = useRef<ThreadContext | null>(null);
  const draft = useRef<(() => DraftContext | null) | null>(null);
  const page = useRef<string | null>(null);
  const focus = useRef<FocusContext | null>(null);

  const show = useCallback((prompt?: string) => {
    if (prompt) pending.current = prompt;
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const takePending = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    return p;
  }, []);

  const value = useMemo<Ctx>(() => ({
    open, show, hide, toggle, takePending,
    view: () => ({ thread: thread.current, draft: draft.current?.() ?? null, page: page.current, focus: focus.current }),
    registerThread: (t) => { thread.current = t; },
    registerDraft: (get) => { draft.current = get; },
    registerPage: (p) => { page.current = p; },
    registerFocus: (f) => { focus.current = f; },
  }), [open, show, hide, toggle, takePending]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

/**
 * Announce a thread for as long as this component is mounted.
 *
 * The cleanup is the half that matters. Without it, closing a conversation
 * would leave the assistant still believing it was open, and the next "what
 * does this say?" would answer about a thread that is no longer on screen —
 * which is worse than not knowing, because it is confidently wrong.
 */
export function useThreadContext(t: ThreadContext | null): void {
  const { registerThread } = useAssistant();
  const key = t ? `${t.accountId}:${t.threadId}` : '';
  useEffect(() => {
    registerThread(t);
    return () => registerThread(null);
    // Keyed on the identity rather than the object, so a parent re-render with
    // a fresh object literal does not churn the registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * Announce a draft, for as long as this composer is open.
 *
 * The getter is held in a ref and re-pointed on every render, so the closure
 * the assistant calls is always the current one — a composer whose `subject`
 * state has changed since mount would otherwise hand back the subject it had
 * at mount, which is the stale-closure bug this shape exists to avoid.
 *
 * Registration itself runs once, on mount, so opening a composer does not
 * churn the provider on every keystroke.
 */
export function useDraftContext(get: () => DraftContext | null): void {
  const { registerDraft } = useAssistant();
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => {
    registerDraft(() => latest.current());
    return () => registerDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function usePageContext(name: string | null): void {
  const { registerPage } = useAssistant();
  useEffect(() => {
    registerPage(name);
    return () => registerPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
}

/**
 * Announce the one thing this screen is about, while it is showing it.
 *
 * Keyed on the contents rather than on the object, like `useThreadContext` and
 * for the same reason: a parent that re-renders with a fresh object literal
 * would otherwise churn the registration on every keystroke elsewhere on the
 * page. The cleanup matters just as much here — a closed contact drawer that
 * left its registration behind would have the assistant confidently answering
 * about somebody who is no longer on screen.
 */
export function useFocusContext(f: FocusContext | null): void {
  const { registerFocus } = useAssistant();
  const key = f ? `${f.kind}:${f.label}:${f.ref ?? ''}:${f.detail ?? ''}` : '';
  useEffect(() => {
    registerFocus(f);
    return () => registerFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
