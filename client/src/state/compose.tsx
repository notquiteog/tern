import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Addr } from '../lib/format';

export interface Upload { id: number; filename: string; size: number; content_type: string; scrubbed?: { changed: boolean; removed: string[]; note: string | null } | null }
// An attachment of the message being forwarded, still on the mail server.
export interface ForwardAttachment { blobId: string; name: string; size: number; type: string }

export interface ComposeSeed {
  accountId?: number | null;
  kind?: 'new' | 'reply' | 'reply_all' | 'forward';
  to?: Addr[]; cc?: Addr[]; bcc?: Addr[];
  subject?: string;
  // Full body HTML, possibly containing a signature and a quote block.
  html?: string;
  // The original, quoted; shown collapsed under the editor.
  quoteHtml?: string;
  replyToEmailId?: number | null;
  forwardOfEmailId?: number | null;
  forwardAttachments?: ForwardAttachment[];
  threadKey?: string | null;
  contactId?: number | null;
  draftId?: number | null;
  attachments?: Upload[];
  autoAi?: 'reply' | 'compose' | null;
  // Text to start the body with (a quick reply suggestion).
  initialText?: string;
}
export interface ComposeWindow extends ComposeSeed { key: number; minimized: boolean; maximized: boolean }
interface Ctx {
  windows: ComposeWindow[];
  open: (seed?: ComposeSeed) => void;
  close: (key: number) => void;
  update: (key: number, patch: Partial<ComposeWindow>) => void;
  // Draft ids currently open somewhere (dock windows and the inline reply),
  // so a thread view does not also list them as resumable drafts.
  openDraftIds: Set<number>;
  setInlineDraftId: (id: number | null) => void;
}

const C = createContext<Ctx>(null as any);
export const useCompose = () => useContext(C);
let seq = 1;

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<ComposeWindow[]>([]);
  const [inlineDraftId, setInlineDraftId] = useState<number | null>(null);
  const open = useCallback((seed: ComposeSeed = {}) => {
    setWindows((w) => {
      // A draft already open in a window comes to the front instead of opening twice.
      if (seed.draftId && w.some((x) => x.draftId === seed.draftId)) return w.map((x) => (x.draftId === seed.draftId ? { ...x, minimized: false } : x));
      const maximized = window.innerWidth < 960;
      const next = [...w.map((x) => ({ ...x, minimized: true })), { key: seq++, minimized: false, maximized, kind: 'new' as const, ...seed }];
      return next.slice(-3);
    });
  }, []);
  const close = useCallback((key: number) => setWindows((w) => w.filter((x) => x.key !== key)), []);
  const update = useCallback((key: number, patch: Partial<ComposeWindow>) => setWindows((w) => w.map((x) => (x.key === key ? { ...x, ...patch } : x))), []);
  const openDraftIds = useMemo(() => new Set([...windows.map((w) => w.draftId).filter((x): x is number => Boolean(x)), ...(inlineDraftId ? [inlineDraftId] : [])]), [windows, inlineDraftId]);
  const value = useMemo(() => ({ windows, open, close, update, openDraftIds, setInlineDraftId }), [windows, open, close, update, openDraftIds]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

// A saved draft, as the API returns it, back into a composer seed.
export function seedFromDraft(d: any): ComposeSeed {
  return {
    draftId: d.id, accountId: d.account_id ?? null, kind: d.kind ?? 'new', to: d.to_addr ?? [], cc: d.cc_addr ?? [], bcc: d.bcc_addr ?? [], subject: d.subject ?? '', html: d.body_html ?? '',
    replyToEmailId: d.reply_to_email_id ?? null, forwardOfEmailId: d.forward_of_email_id ?? null,
    forwardAttachments: (d.forward_attachments ?? []).map((a: any) => ({ blobId: a.blobId, name: a.name ?? 'attachment', size: a.size ?? 0, type: a.type ?? 'application/octet-stream' })),
    threadKey: d.thread_id && d.account_id ? `${d.account_id}:${d.thread_id}` : null, attachments: d.attachments ?? [], contactId: null,
  };
}
