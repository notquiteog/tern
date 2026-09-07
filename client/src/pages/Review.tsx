// The queue every automated send passes through.
//
// This page gates more than any other in Tern — nothing a sequence step or a
// responder writes reaches anybody without a decision made here — and it was
// the least designed thing in the app: a flat column of cards, no keyboard,
// no way to see what came from where, and no way to reach the conversation a
// draft was answering. Deciding meant scrolling, and scrolling a queue is how
// a queue stops being read and starts being approved.
//
// Three things fix that, and they are all about the same idea: a decision
// needs its context beside it.
//
//   Grouped by where it came from. Fifteen drafts is unreadable; "Onboarding
//   sequence, step 2 — 9 drafts" is a decision you can make once. The group
//   header carries the bulk approve, and it refuses to bulk-approve anything
//   the guard held back, because those are exactly the ones that need eyes.
//
//   Held apart from ordinary. A draft waiting because a responder is in
//   review mode and a draft stopped because it still says "[Your Name]" are
//   different situations wearing the same card. The filter separates them and
//   the held ones lead.
//
//   Keyboard, like the mail list. j/k to move, a to approve, x to reject, e
//   to edit, Enter to open the conversation. Someone working through fifteen
//   of these should never reach for the mouse.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Sparkles, X, Pencil, ShieldAlert, Bot, Workflow, Mail, Contact, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useHotkeys } from '../lib/hooks';
import { Avatar, Badge, Button, Empty, Input, PageHeader, Callout, Segmented, Kbd } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { SafeHtml } from '../components/SafeHtml';
import { cls, fmtRelative } from '../lib/format';

type Filter = 'all' | 'held' | 'sequences' | 'replies';

interface Group {
  key: string;
  title: string;
  sub: string;
  icon: React.ReactNode;
  /** Where the thing that produced these lives, when it has a page. */
  to: string | null;
  items: any[];
}

const isHeld = (it: any) => Boolean(it.hold_reason);
const isReply = (it: any) => it.kind === 'reply';

// One group per source, held items first inside each. Two drafts from the
// same sequence step are the same decision made twice; two from different
// steps are not, so the step is part of the key.
function groupItems(items: any[]): Group[] {
  const by = new Map<string, Group>();
  for (const it of items) {
    const key = isReply(it) ? `r:${it.responder_id ?? 0}` : `s:${it.sequence_id ?? 0}:${it.step_position ?? 0}`;
    let g = by.get(key);
    if (!g) {
      g = isReply(it)
        ? {
          key,
          title: it.responder_name || 'AI responder',
          sub: 'replies written for incoming mail',
          icon: <Bot size={14} />,
          to: '/responders',
          items: [],
        }
        : {
          key,
          title: it.sequence_name || 'Sequence',
          sub: `step ${(it.step_position ?? 0) + 1}`,
          icon: <Workflow size={14} />,
          to: it.sequence_id ? `/sequences/${it.sequence_id}` : null,
          items: [],
        };
      by.set(key, g);
    }
    g.items.push(it);
  }
  for (const g of by.values()) g.items.sort((a, b) => Number(isHeld(b)) - Number(isHeld(a)));
  // A group containing something held leads, because those are the ones that
  // cannot be waved through.
  return [...by.values()].sort((a, b) => Number(b.items.some(isHeld)) - Number(a.items.some(isHeld)));
}

export default function ReviewPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['review'], queryFn: () => api.get<{ items: any[] }>('/api/review') });
  const [filter, setFilter] = useState<Filter>('all');
  const [focus, setFocus] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [busyAll, setBusyAll] = useState<string | null>(null);

  const all = data?.items ?? [];
  const held = all.filter(isHeld).length;

  const items = useMemo(() => all.filter((it) => {
    if (filter === 'held') return isHeld(it);
    if (filter === 'replies') return isReply(it);
    if (filter === 'sequences') return !isReply(it);
    return true;
  }), [all, filter]);

  const groups = useMemo(() => groupItems(items), [items]);
  // The same order the page is drawn in, so j/k walks down the screen rather
  // than down the order the server happened to return.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const decide = useCallback(async (id: number, action: 'approve' | 'reject', patch?: { subject?: string; body_html?: string }) => {
    try {
      await api.post(`/api/review/${id}`, { action, ...patch });
      qc.invalidateQueries({ queryKey: ['review'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
      toast.success(action === 'approve' ? 'Approved, sending at the next open slot' : 'Rejected; enrollment paused');
    } catch (e) { toast.error(e); }
  }, [qc, toast]);

  // Everything in one group that was not held back. Sequentially rather than
  // in parallel: each approval can start a send, and firing nine at a mail
  // server at once is a good way to be rate-limited by it.
  const approveGroup = useCallback(async (g: Group) => {
    const safe = g.items.filter((it) => !isHeld(it));
    if (!safe.length) return;
    setBusyAll(g.key);
    let done = 0;
    try {
      for (const it of safe) { await api.post(`/api/review/${it.id}`, { action: 'approve' }); done += 1; }
      toast.success(`Approved ${done} draft${done === 1 ? '' : 's'} from ${g.title}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusyAll(null);
      qc.invalidateQueries({ queryKey: ['review'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
    }
  }, [qc, toast]);

  // Focus survives the list shrinking under it: approving the last card
  // should leave you on the new last card, not off the end.
  useEffect(() => { setFocus((f) => Math.max(0, Math.min(f, flat.length - 1))); }, [flat.length]);
  useEffect(() => { setFocus(0); }, [filter]);

  const current = flat[focus];
  const threadOf = (it: any) => (it?.thread_id ? `/mail/all/t/${encodeURIComponent(`${it.account_id}:${it.thread_id}`)}` : null);

  useHotkeys({
    j: () => setFocus((f) => Math.min(flat.length - 1, f + 1)),
    k: () => setFocus((f) => Math.max(0, f - 1)),
    a: () => { if (current && editing === null) void decide(current.id, 'approve'); },
    x: () => { if (current && editing === null) void decide(current.id, 'reject'); },
    e: () => { if (current) setEditing((v) => (v === current.id ? null : current.id)); },
    Enter: () => { const to = threadOf(current); if (to && editing === null) nav(to); },
  }, [flat, focus, editing, current, decide, nav]);

  return (
    <div className="page page-narrow">
      <PageHeader
        title="AI review"
        sub="Drafts the model wrote for sequence steps and for AI responders, plus anything automation refused to send on its own because a placeholder, merge field or prompt text was left in it."
        actions={all.length > 0 ? (
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${all.length}` },
              ...(held ? [{ value: 'held' as Filter, label: <span className="row gap-4"><ShieldAlert size={13} /> Held {held}</span> }] : []),
              { value: 'sequences', label: 'Sequences' },
              { value: 'replies', label: 'Replies' },
            ]}
          />
        ) : undefined}
      />

      {!isLoading && !all.length && (
        <Empty icon={<Sparkles size={24} />} title="Nothing waiting" action={<Button onClick={() => nav('/sequences')}>Go to sequences</Button>}>
          Sequence steps with "AI personalise" and responders in review mode land here before anything goes out.
        </Empty>
      )}

      {all.length > 0 && (
        <>
          {held > 0 && filter !== 'held' && (
            <Callout kind="warning">
              <ShieldAlert size={14} /> <b>{held} of these were stopped, not queued.</b> Automation refused to send them
              because something was left in the text. They are marked below, and they are the only ones a bulk
              approval skips. <button type="button" className="link-btn" onClick={() => setFilter('held')}>Show just those</button>
            </Callout>
          )}
          <div className="review-help small muted">
            <Kbd>j</Kbd><Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>x</Kbd> reject · <Kbd>e</Kbd> edit · <Kbd>Enter</Kbd> open the conversation
          </div>
        </>
      )}

      {!items.length && all.length > 0 && (
        <Empty icon={<Sparkles size={24} />} title="Nothing under this filter">Everything waiting is of another kind.</Empty>
      )}

      <div className="col gap-24 mt-16">
        {groups.map((g) => {
          const safe = g.items.filter((it) => !isHeld(it)).length;
          return (
            <section key={g.key} className="review-group">
              <header className="review-group-head">
                <span className="review-group-icon">{g.icon}</span>
                <span className="col" style={{ gap: 0, minWidth: 0 }}>
                  <span className="strong truncate">
                    {g.to ? <a onClick={() => nav(g.to!)} style={{ cursor: 'pointer' }}>{g.title}</a> : g.title}
                  </span>
                  <span className="small muted truncate">{g.sub} · {g.items.length} draft{g.items.length === 1 ? '' : 's'}</span>
                </span>
                {safe > 1 && (
                  <Button
                    size="sm"
                    className="ml-auto"
                    icon={<Check size={13} />}
                    loading={busyAll === g.key}
                    onClick={() => void approveGroup(g)}
                    title={safe < g.items.length ? `Approves ${safe}; the held ones are left for you` : undefined}
                  >
                    Approve {safe === g.items.length ? `all ${safe}` : safe}
                  </Button>
                )}
              </header>
              <div className="col gap-12">
                {g.items.map((it) => (
                  <ReviewCard
                    key={it.id}
                    item={it}
                    focused={flat[focus]?.id === it.id}
                    editing={editing === it.id}
                    onEdit={(on) => setEditing(on ? it.id : null)}
                    onFocus={() => setFocus(flat.findIndex((f) => f.id === it.id))}
                    onDecide={decide}
                    threadTo={threadOf(it)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {items.length > 0 && (
        <p className="small muted mt-24">
          Approved messages still respect the account's daily cap, send window and randomised delay.
        </p>
      )}
    </div>
  );
}

function ReviewCard({ item, focused, editing, onEdit, onFocus, onDecide, threadTo }: {
  item: any;
  focused: boolean;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onFocus: () => void;
  onDecide: (id: number, a: 'approve' | 'reject', patch?: any) => Promise<void>;
  threadTo: string | null;
}) {
  const nav = useNavigate();
  const [subject, setSubject] = useState(item.subject);
  const html = useRef(item.body_html);
  const editor = useRef<EditorHandle>(null);
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setSubject(item.subject); html.current = item.body_html; }, [item]);
  // The keyboard moved the focus, so the page follows it.
  useEffect(() => { if (focused) card.current?.scrollIntoView({ block: 'nearest' }); }, [focused]);

  const reply = isReply(item);
  const held = isHeld(item);
  const toEmail = reply ? (item.to_addr ?? []).map((a: any) => a.email).join(', ') : item.email;
  const name = reply
    ? ((item.to_addr ?? [])[0]?.name || toEmail)
    : ([item.first_name, item.last_name].filter(Boolean).join(' ') || item.email);

  return (
    <div
      ref={card}
      className={cls('card review-card', focused && 'focused', held && 'held')}
      onMouseEnter={onFocus}
    >
      <div className="row mb-8">
        <Avatar name={name} email={toEmail} />
        <div className="flex-1 col" style={{ gap: 0, minWidth: 0 }}>
          <div className="strong truncate">
            {/* The contact card is one click from the decision, because
                "should this go to them" is a question about them. */}
            {item.contact_id
              ? <a onClick={() => nav(`/contacts/${item.contact_id}`)} style={{ cursor: 'pointer' }}>{name}</a>
              : name}
            <span className="muted small"> · {toEmail}{item.company ? ` · ${item.company}` : ''}</span>
          </div>
          <div className="small muted truncate">from {item.account_email} · {fmtRelative(item.created_at)}</div>
        </div>
        <div className="row gap-4">
          {item.contact_id && <Badge><Contact size={11} /> contact</Badge>}
          <Badge kind="accent"><Sparkles size={12} /> {item.ai_model}</Badge>
        </div>
      </div>

      {held && (
        <Callout kind="warning">
          <ShieldAlert size={14} /> <b>Not sent automatically.</b> {String(item.hold_reason).replace(/^Held for review: /, 'It still contains ')}.
          Fix it here and approve, or reject it.
        </Callout>
      )}

      {reply && item.original && (
        <button
          type="button"
          className="review-original"
          disabled={!threadTo}
          onClick={() => threadTo && nav(threadTo)}
          title={threadTo ? 'Open the conversation this answers' : undefined}
        >
          <span className="small muted">In reply to <b>{item.original.subject || '(no subject)'}</b> from {item.original.from?.[0]?.email}</span>
          <span className="small muted clamp-2">{item.original.preview}</span>
          {threadTo && <ChevronRight size={15} className="review-original-go" />}
        </button>
      )}

      {editing
        ? <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="mb-8" />
        : <div className="strong mb-8">{subject || <span className="faint">(no subject)</span>}</div>}

      {editing
        ? <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <Editor ref={editor} initialHtml={html.current} minHeight={160} onChange={(h) => { html.current = h; }} />
          </div>
        : <SafeHtml className="msg-text" html={reply ? String(item.body_html).split('<div class="tern-quote"')[0] : item.body_html} />}

      <div className="row mt-16">
        <Button variant="primary" icon={<Check size={15} />} loading={busy === 'approve'} onClick={async () => {
          setBusy('approve');
          await onDecide(item.id, 'approve', editing ? { subject, body_html: html.current } : undefined);
          setBusy(null);
        }}>{editing ? 'Approve edited' : 'Approve'}</Button>
        <Button icon={<Pencil size={15} />} onClick={() => onEdit(!editing)}>{editing ? 'Stop editing' : 'Edit'}</Button>
        <Button variant="ghost" icon={<X size={15} />} loading={busy === 'reject'} onClick={async () => {
          setBusy('reject');
          await onDecide(item.id, 'reject');
          setBusy(null);
        }}>Reject</Button>
        {threadTo && !reply && (
          <Button variant="ghost" className="ml-auto" icon={<Mail size={15} />} onClick={() => nav(threadTo)}>Conversation</Button>
        )}
      </div>
    </div>
  );
}
