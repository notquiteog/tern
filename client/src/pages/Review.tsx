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
import { Check, Sparkles, X, Pencil, ShieldAlert, Bot, Workflow, Mail, Contact, ChevronRight, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useHotkeys } from '../lib/hooks';
import { useCan } from '../state/features';
import { postWithWork } from '../lib/work';
import { Avatar, Badge, Button, Confirm, Empty, Input, PageHeader, Callout, Segmented, Kbd, Textarea } from '../components/ui';
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
  // Rejecting a whole group pauses every enrollment behind it, so it asks.
  // Approving does not: an approval is still gated by the send window, the
  // daily cap and the guard, and the held ones are skipped.
  const [confirmReject, setConfirmReject] = useState<Group | null>(null);

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

  // A whole group in one decision.
  //
  // One request rather than nine, because the server now applies them in order
  // through the same code path a single decision uses — each approval can start
  // a send, and firing nine at a mail server at once is a good way to be
  // rate-limited by it. The route also carries on past an item that fails, so a
  // queue of twenty where the fourth has a deleted account is still nineteen
  // decisions somebody wanted made.
  //
  // Approving skips anything the guard held; rejecting does not. That asymmetry
  // is the point of the whole page: the held ones are exactly the drafts that
  // need eyes before they go, and no eyes at all before they are binned.
  const decideGroup = useCallback(async (g: Group, action: 'approve' | 'reject') => {
    const chosen = action === 'approve' ? g.items.filter((it) => !isHeld(it)) : g.items;
    if (!chosen.length) return;
    setBusyAll(`${g.key}:${action}`);
    try {
      const r = await api.post<{ done: number; failed: { id: number; error: string }[] }>('/api/review/bulk', {
        ids: chosen.map((it) => it.id),
        action,
      });
      const verb = action === 'approve' ? 'Approved' : 'Rejected';
      if (r.failed.length) toast.toast(`${verb} ${r.done}; ${r.failed.length} could not be: ${r.failed[0].error}`, { kind: 'error' });
      else toast.success(`${verb} ${r.done} draft${r.done === 1 ? '' : 's'} from ${g.title}`);
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
                {g.items.length > 1 && (
                  <div className="row gap-4 ml-auto">
                    {safe > 1 && (
                      <Button
                        size="sm"
                        icon={<Check size={13} />}
                        loading={busyAll === `${g.key}:approve`}
                        onClick={() => void decideGroup(g, 'approve')}
                        title={safe < g.items.length ? `Approves ${safe}; the held ones are left for you` : undefined}
                      >
                        Approve {safe === g.items.length ? `all ${safe}` : safe}
                      </Button>
                    )}
                    {/* A misfiring responder produces twenty near-identical bad
                        drafts in an afternoon, and rejecting them one at a time
                        is the thing that makes people stop reading the queue. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<X size={13} />}
                      loading={busyAll === `${g.key}:reject`}
                      onClick={() => setConfirmReject(g)}
                    >
                      Reject all {g.items.length}
                    </Button>
                  </div>
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

      <Confirm
        open={Boolean(confirmReject)}
        onClose={() => setConfirmReject(null)}
        danger
        title={confirmReject ? `Reject all ${confirmReject.items.length} from ${confirmReject.title}?` : ''}
        message="Nothing is sent. Every sequence enrollment behind these drafts is paused, and you restart them from the sequence."
        confirmLabel="Reject them"
        onConfirm={async () => { const g = confirmReject; setConfirmReject(null); if (g) await decideGroup(g, 'reject'); }}
      />
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
  const [redoing, setRedoing] = useState(false);
  const [note, setNote] = useState('');
  const [fixes, setFixes] = useState<any[]>(item.fixes ?? []);
  const [heldReason, setHeldReason] = useState<string | null>(item.hold_reason ?? null);
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = useCan('ai.compose');
  // Whether this draft has been changed here since it was loaded.
  //
  // The queue refetches — on window focus, and after any decision — and every
  // refetch hands back fresh objects for the same rows. Resetting from `item`
  // on each of those threw away an edit in progress: you filled in a merge
  // field, alt-tabbed to check something, and came back to the placeholder.
  // The correction buttons made that easy to hit, but the hazard was already
  // there for anything typed into the editor.
  //
  // So a row that has been touched keeps what is in front of the person until
  // they decide it, and only a genuinely different row resets.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    setSubject(item.subject);
    html.current = item.body_html;
    setFixes(item.fixes ?? []);
    setHeldReason(item.hold_reason ?? null);
  }, [item]);
  // A different draft in this slot is a different question, so it resets.
  useEffect(() => {
    touched.current = false;
    setSubject(item.subject);
    html.current = item.body_html;
    setFixes(item.fixes ?? []);
    setHeldReason(item.hold_reason ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // A correction applied to the body in place.
  //
  // Done against the DOM rather than against the HTML as a string, because the
  // string version cannot see structure: a placeholder sitting after a `<br>`
  // inside the sign-off paragraph is one "line" to a reader and one text node
  // in the middle of a block to a regular expression. The first version of
  // this matched neither and reported success, which is worse than not
  // offering the button.
  //
  // The editor is opened if it is not already: a change made to a body nobody
  // can see is a change nobody agreed to.
  function applyFix(f: any) {
    const before = editor.current?.getHtml() ?? html.current ?? '';
    const doc = new DOMParser().parseFromString(`<body>${before}</body>`, 'text/html');
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let changed = false;

    if (f.fix === 'fill') {
      // Every occurrence: a merge field the template used twice is unfilled
      // twice, and leaving the second one would hold the message again.
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      for (const n of nodes) {
        if (!n.nodeValue?.includes(f.sample)) continue;
        n.nodeValue = n.nodeValue.split(f.sample).join(String(f.value ?? ''));
        changed = true;
      }
    } else if (f.fix === 'remove') {
      // The LINE, not the paragraph. "Best,<br>[Your Name]" should lose the
      // name and keep the sign-off; a placeholder that is the whole of its
      // block takes the block with it.
      let node: Text | null = null;
      while (walker.nextNode()) {
        const t = walker.currentNode as Text;
        if (t.nodeValue?.includes(f.sample)) { node = t; break; }
      }
      if (node) {
        const block = node.parentElement?.closest('p,div,li,td,blockquote') ?? node.parentElement;
        // Everything between the <br> before it and the <br> after it.
        const siblings = block ? [...block.childNodes] : [];
        const at = siblings.indexOf(node as ChildNode);
        let from = at;
        while (from > 0 && (siblings[from - 1] as HTMLElement)?.tagName !== 'BR') from--;
        let to = at;
        while (to < siblings.length - 1 && (siblings[to + 1] as HTMLElement)?.tagName !== 'BR') to++;
        const doomed = siblings.slice(from, to + 1);
        // The <br> that separated this line from the one above goes too, or
        // the sign-off is left with a blank line hanging off it.
        const brBefore = from > 0 ? siblings[from - 1] : null;
        for (const n of doomed) n.parentNode?.removeChild(n);
        if (brBefore && (brBefore as HTMLElement).tagName === 'BR') brBefore.parentNode?.removeChild(brBefore);
        if (block && !block.textContent?.trim() && block !== doc.body) block.remove();
        changed = true;
      }
    }

    if (!changed) { toast.error('That text is no longer in the draft'); return; }
    const after = doc.body.innerHTML;
    touched.current = true;
    html.current = after;
    // An editor that is already open is written to now. Only the case where
    // this opens it needs to wait, and even then the mount reads `html.current`
    // — which is already the corrected text — so the deferred set is a
    // belt-and-braces for an editor that was open and lost its ref, not the
    // thing the correction depends on. Deferring unconditionally was the bug:
    // a second correction applied to an editor that was already open computed
    // the right text, reported success, and never wrote it.
    if (editing) editor.current?.setHtml(after);
    else { onEdit(true); requestAnimationFrame(() => editor.current?.setHtml(after)); }
    setFixes((l) => l.filter((x) => x !== f));
  }

  async function regenerate() {
    setBusy('redo');
    try {
      const r = await postWithWork<any>('ai', `/api/review/${item.id}/regenerate`, { note: note.trim() });
      touched.current = true;
      setSubject(r.subject);
      html.current = r.body_html;
      editor.current?.setHtml(r.body_html);
      setFixes(r.hold_hits?.length ? [] : []);
      setHeldReason(r.hold_reason ?? null);
      setRedoing(false);
      setNote('');
      if (r.hold_reason) toast.toast('Written again, and held again for the same kind of reason — read it before approving', { kind: 'error' });
      else toast.success('Written again');
      // The row on the server has changed; the list refetches so a reload
      // shows what is now stored rather than what was stored before.
      void qc.invalidateQueries({ queryKey: ['review'] });
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  }
  // The keyboard moved the focus, so the page follows it.
  useEffect(() => { if (focused) card.current?.scrollIntoView({ block: 'nearest' }); }, [focused]);

  const reply = isReply(item);
  const held = Boolean(heldReason);
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
          <ShieldAlert size={14} /> <b>Not sent automatically.</b> {String(heldReason).replace(/^Held for review: /, 'It still contains ')}.
          Fix it here and approve, or reject it.
          {/* The guard has always named the problem and never offered the
              answer, although for two of the four kinds it is mechanical: the
              real value for an unfilled merge field is on the contact record,
              and a placeholder is a line to delete. Only the rest need
              writing again. */}
          {fixes.length > 0 && (
            <div className="review-fixes">
              {fixes.map((f: any, i: number) => (
                <div key={i} className="row small">
                  <code>{f.sample}</code>
                  {f.fix === 'fill' && <Button size="sm" onClick={() => applyFix(f)}>Use “{f.value}”</Button>}
                  {f.fix === 'remove' && <Button size="sm" onClick={() => applyFix(f)}>Remove that line</Button>}
                  {f.fix === 'rewrite' && <span className="faint">needs writing again</span>}
                </div>
              ))}
            </div>
          )}
        </Callout>
      )}

      {/* Not like that: try again.
          The queue could approve, hand-edit or reject, and a draft that is
          nearly right needs a sentence rather than a rewrite. The reason it
          was held goes to the model along with the note, so the second
          attempt fixes the actual failure instead of rolling the dice on the
          same prompt. */}
      {canWrite && (
        redoing ? (
          <div className="review-redo">
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={held ? 'What should change? The reason it was held goes with this automatically.' : 'What should change? “Shorter, and mention the invoice.”'}
              style={{ minHeight: 56 }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void regenerate(); } }}
            />
            <div className="row gap-4">
              <Button size="sm" variant="ai" icon={<RefreshCw size={13} />} loading={busy === 'redo'} disabled={!note.trim() && !held} onClick={() => void regenerate()}>Write it again</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRedoing(false); setNote(''); }}>Cancel</Button>
            </div>
          </div>
        ) : null
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
        ? <Input value={subject} onChange={(e) => { touched.current = true; setSubject(e.target.value); }} className="mb-8" />
        : <div className="strong mb-8">{subject || <span className="faint">(no subject)</span>}</div>}

      {editing
        ? <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <Editor ref={editor} initialHtml={html.current} minHeight={160} onChange={(h) => { touched.current = true; html.current = h; }} />
          </div>
        : <SafeHtml className="msg-text" html={reply ? String(item.body_html).split('<div class="tern-quote"')[0] : item.body_html} />}

      <div className="row mt-16">
        <Button variant="primary" icon={<Check size={15} />} loading={busy === 'approve'} onClick={async () => {
          setBusy('approve');
          await onDecide(item.id, 'approve', editing ? { subject, body_html: html.current } : undefined);
          setBusy(null);
        }}>{editing ? 'Approve edited' : 'Approve'}</Button>
        <Button icon={<Pencil size={15} />} onClick={() => onEdit(!editing)}>{editing ? 'Stop editing' : 'Edit'}</Button>
        {canWrite && !redoing && <Button icon={<RefreshCw size={15} />} onClick={() => setRedoing(true)}>Not like that</Button>}
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
