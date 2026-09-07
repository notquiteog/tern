// The rail beside a conversation: everything the rest of the app already
// knows about the thread you are reading.
//
// Before this, the app knew a great deal about a conversation and said none
// of it here. Commitments were found by reading this thread and then listed
// on a page somewhere else. The meaning index could name the four other
// conversations about the same thing and was only ever asked from the search
// box. Both were features you had to go and visit; neither was where the
// work happens.
//
// The rule for the rail is that a card which has nothing to say does not
// appear. A conversation with no commitments and nothing related shows the
// contact card alone, exactly as before — no empty shells, no headings over
// nothing.
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCheck, Clock, Loader2, Plus, Telescope, Timer, X } from 'lucide-react';
import { api } from '../api';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';
import { Badge, Button, IconButton, Input, Segmented } from './ui';
import { fmtDate } from '../lib/format';
import type { SemanticHit } from './SearchExtras';

export interface ThreadCommitment {
  id: number;
  kind: 'owed' | 'awaiting';
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  threadId: string;
  accountId: number;
  source: 'ai' | 'manual';
}

// ---------- Commitments, in the thread they came from ----------

// Closing one from here is the whole point. An "owed" item settles itself
// when you send into the thread, so the common case never needs a button at
// all — but the one it cannot see (you rang them instead) is settled in two
// clicks without leaving what you are reading.
export function ThreadCommitments({ accountId, threadId, items, counterparty, onChanged }: {
  accountId: number;
  threadId: string;
  items: ThreadCommitment[];
  /** The other person in the conversation, used to fill in a new item. */
  counterparty: string | null;
  onChanged: () => void;
}) {
  const can = useCan('commitments');
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'owed' | 'awaiting'>('owed');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<number | 'new' | null>(null);

  if (!can) return null;

  const close = async (id: number, status: 'done' | 'dropped') => {
    setBusy(id);
    try { await api.post(`/api/assist/commitments/${id}/close`, { status }); onChanged(); }
    catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  const add = async () => {
    const t = text.trim();
    if (t.length < 3) return;
    setBusy('new');
    try {
      await api.post('/api/assist/commitments', { accountId, threadId, kind, text: t, counterparty });
      setText(''); setAdding(false); onChanged();
      toast.success(kind === 'owed' ? 'Added to what you owe' : 'Added to what you are waiting on');
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  // Nothing here and nothing being written: the card would be a heading over
  // an empty box, so it is not drawn.
  if (!items.length && !adding) {
    return (
      <div className="aside-card aside-quiet">
        <button type="button" className="link-btn small" onClick={() => setAdding(true)}>
          <Plus size={13} /> Track something from this conversation
        </button>
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className="aside-card">
      <div className="aside-head">
        <ClipboardCheck size={14} />
        <span>Commitments</span>
        {items.length > 0 && <span className="aside-count">{items.length}</span>}
        {!adding && <IconButton label="Track something else" className="btn-sm ml-auto" onClick={() => setAdding(true)}><Plus size={14} /></IconButton>}
      </div>

      {items.map((c) => {
        const overdue = c.dueAt ? new Date(c.dueAt).getTime() < now : false;
        return (
          <div key={c.id} className="aside-commit">
            <span className={`aside-commit-kind ${c.kind}`} title={c.kind === 'owed' ? 'You said you would' : 'You are waiting on someone'}>
              {c.kind === 'owed' ? <Clock size={13} /> : <Timer size={13} />}
            </span>
            <div className="aside-commit-body">
              <div className="aside-commit-text">{c.text}</div>
              {(c.dueAt || c.counterparty) && (
                <div className="aside-commit-meta">
                  {c.dueAt && <Badge kind={overdue ? 'danger' : undefined}>{overdue ? 'Overdue' : 'By'} {fmtDate(c.dueAt, { always: true })}</Badge>}
                  {c.counterparty && <span className="muted">{c.counterparty}</span>}
                </div>
              )}
            </div>
            <span className="aside-commit-acts">
              {busy === c.id ? <Loader2 size={13} className="spin" /> : <>
                <IconButton label="Mark done" className="btn-sm" onClick={() => close(c.id, 'done')}><Check size={13} /></IconButton>
                <IconButton label="Not a commitment" className="btn-sm" onClick={() => close(c.id, 'dropped')}><X size={13} /></IconButton>
              </>}
            </span>
          </div>
        );
      })}

      {adding && (
        <div className="aside-add">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[{ value: 'owed', label: 'I owe' }, { value: 'awaiting', label: 'Waiting' }]}
          />
          <Input
            autoFocus
            className="input-sm"
            value={text}
            maxLength={200}
            placeholder={kind === 'owed' ? 'Send the revised quote' : 'Their answer on the date'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } if (e.key === 'Escape') { setAdding(false); setText(''); } }}
          />
          <div className="row gap-4">
            <Button size="sm" variant="primary" loading={busy === 'new'} disabled={text.trim().length < 3} onClick={add}>Track</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setText(''); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- The other conversations about this ----------

// The meaning index, asked the question it is best at and was never given:
// not "find me the words I typed" but "what else is about this". No model
// runs — the vectors already exist — so this is a database read, which is
// why it can happen on open rather than behind a button.
export function RelatedThreads({ emailId, threadId }: { emailId: number | null; threadId: string }) {
  const can = useCan('semantic');
  const nav = useNavigate();
  const { data } = useQuery({
    queryKey: ['similar', emailId],
    queryFn: () => api.get<{ hits: SemanticHit[] }>(`/api/discover/similar/${emailId}`),
    enabled: can && Boolean(emailId),
    staleTime: 5 * 60_000,
  });

  if (!can || !emailId) return null;
  // Everything from this same conversation is not "related", it is what you
  // are already looking at.
  const hits = (data?.hits ?? []).filter((h) => h.threadId !== threadId).slice(0, 5);
  // No card while it is loading and none if it finds nothing: a heading that
  // appears and then empties is worse than one that never appeared.
  if (!hits.length) return null;

  return (
    <div className="aside-card">
      <div className="aside-head"><Telescope size={14} /><span>Related</span></div>
      {hits.map((h) => (
        <button key={h.emailId} type="button" className="aside-related" onClick={() => nav(`/mail/all/t/${h.accountId}:${h.threadId}`)}>
          <span className="aside-related-subject">{h.subject || '(no subject)'}</span>
          <span className="aside-related-meta">
            {h.from?.name || h.from?.email || 'Unknown sender'}
            {h.receivedAt ? ` · ${fmtDate(h.receivedAt)}` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------- The words inside the attachments ----------

export interface AttachmentPart { name: string | null; type: string; text: string; chars: number; error: string | null }

// F5 built an index over the text in attachments and then showed that text
// to nobody: the only way to know it had worked was that a search matched a
// word that was inside a PDF. This is the text itself, under the files it
// came out of, with the one thing it is really for — quoting a figure back
// into a reply without opening the file to go and find it.
export function AttachmentText({ emailId, onQuote }: { emailId: number; onQuote: (text: string) => void }) {
  const can = useCan('attachments');
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['attachment-text', emailId],
    queryFn: () => api.get<{ parts: AttachmentPart[] }>(`/api/discover/attachments/${emailId}`),
    enabled: can && open,
    staleTime: 5 * 60_000,
  });

  if (!can) return null;
  const parts = data?.parts ?? [];
  const readable = parts.filter((p) => p.text);

  return (
    <div className="att-text">
      <button type="button" className="link-btn small" onClick={() => setOpen((v) => !v)}>
        {isLoading ? <Loader2 size={12} className="spin" /> : <Telescope size={12} />}
        {open ? 'Hide the text in these files' : 'Read the text in these files'}
      </button>
      {open && !isLoading && !parts.length && (
        <p className="muted small">
          Nothing has been read out of these files yet. Attachments are read in the background a
          few at a time; a file that is an image or is over the size limit is never read at all.
        </p>
      )}
      {open && readable.map((p, i) => <ExtractedPart key={i} part={p} onQuote={onQuote} />)}
      {open && parts.filter((p) => !p.text).map((p, i) => (
        <p key={`e${i}`} className="muted small">{p.name ?? 'attachment'} — {p.error ?? 'no text in this file'}.</p>
      ))}
    </div>
  );
}

// One file's worth of text. The quote button prefers whatever is selected
// inside it, because the useful gesture is "that line, in my reply" and a
// whole PDF pasted into an email is not a reply. With nothing selected it
// takes the opening of the file, capped, rather than refusing.
const QUOTE_CAP = 1200;

function ExtractedPart({ part, onQuote }: { part: AttachmentPart; onQuote: (text: string) => void }) {
  const pre = useRef<HTMLPreElement>(null);

  const quote = () => {
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && pre.current && sel.anchorNode && pre.current.contains(sel.anchorNode)
      ? sel.toString().trim()
      : '';
    const text = picked || part.text.slice(0, QUOTE_CAP) + (part.text.length > QUOTE_CAP ? '…' : '');
    onQuote(`${part.name ? `From ${part.name}:\n` : ''}${text}`);
  };

  return (
    <div className="att-text-part">
      <div className="att-text-head">
        <strong className="truncate">{part.name ?? 'attachment'}</strong>
        <span className="muted small">{part.chars.toLocaleString()} characters</span>
        {/* The reason this exists: the figure in the invoice reaches the
            reply without the file being opened to go and find it. */}
        <button type="button" className="link-btn small ml-auto" title="Select some of the text to quote just that part" onClick={quote}>
          Quote in a reply
        </button>
      </div>
      <pre ref={pre} className="att-text-body">{part.text}</pre>
    </div>
  );
}

// ---------- Why this conversation is near the top ----------

export interface TriageWhy { priority: number | null; reasons: string[]; note: string }

// Priority ordering moves mail up a list on the strength of a guess, and
// until now gave no way to ask why. The server has always been able to
// answer; nothing called it. An ordering you cannot interrogate is one
// people stop trusting the first time it is wrong.
export function useTriageWhy(emailId: number | null) {
  return useQuery({
    queryKey: ['triage-why', emailId],
    queryFn: () => api.get<TriageWhy>(`/api/discover/triage/why/${emailId}`),
    enabled: Boolean(emailId),
    staleTime: 60_000,
  });
}

// ---------- Promoting a line of the brief into a tracked commitment ----------

export function useTrackCommitment(onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { accountId: number; threadId?: string; kind: 'owed' | 'awaiting'; text: string }) =>
      api.post<{ id: number }>('/api/assist/commitments', input),
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: ['commitments'] });
      qc.invalidateQueries({ queryKey: ['commitment-counts'] });
      toast.success(input.kind === 'owed' ? 'Added to what you owe' : 'Added to what you are waiting on');
      onDone?.();
    },
    onError: (e) => toast.error(e as Error),
  });
}
