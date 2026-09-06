import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlarmClock, Archive, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Download, Forward, MailOpen, MoreHorizontal, Paperclip, Reply, ReplyAll, ShieldAlert, Sparkles, Star, Tag, Trash2, Inbox, Printer, Contact, Workflow, ExternalLink, Bot, Send, Pencil, X, BellOff, Bell, Ban, ListFilter, ChevronsDownUp, ChevronsUpDown, MailX, Zap, FileText } from 'lucide-react';
import { api, apiStream } from '../api';
import { useCompose, seedFromDraft, type ComposeSeed, type ForwardAttachment } from '../state/compose';
import { useToast } from '../state/toast';
import { useHotkeys } from '../lib/hooks';
import { useMailboxes } from '../lib/queries';
import { useMailPrefs } from '../state/mailPrefs';
import { Avatar, Badge, Button, IconButton, Menu, MenuItem, Modal, Spinner, Field, Input } from './ui';
import { MessageBody } from './MessageBody';
import { EncryptedMessage, pgpKindOf } from './EncryptedMessage';
import { Composer, type ComposeKind, type KindOptions } from './Composer';
import { AttachmentPreview, canPreview, type PreviewItem } from './AttachmentPreview';
import { addrFull, addrName, cls, fmtBytes, fmtDateTime, fmtDate, fmtRelative, localDateTimeValue, type Addr } from '../lib/format';
import { buildForwardHtml, buildQuoteHtml, forwardSubject, parseListUnsubscribe, replyRecipients, replySubject } from '../lib/reply';

interface Msg { id: number; jmap_id: string; thread_id: string; mailbox_ids: string[]; keywords: string[]; received_at: string; sent_at: string | null; message_id: string[]; from_addr: Addr[]; to_addr: Addr[]; cc_addr: Addr[]; bcc_addr: Addr[]; reply_to: Addr[]; subject: string; preview: string; has_attachment: boolean; body_text: string | null; body_html: string | null; attachments: any[]; is_unread: boolean; is_flagged: boolean; is_draft: boolean; from_email: string; size: number; blob_id: string; avatar_url?: string | null; list_unsubscribe?: string | null; list_id?: string | null; auto_submitted?: string | null }
interface Undo { accountId: number; items: { jmapId: string; mailboxIds: string[] }[] }
interface InlineState { key: number; seed: ComposeSeed; kindOptions: KindOptions }

const isRealAttachment = (a: any, pgpKind: string | null) => (!a.cid || a.disposition === 'attachment') && !(pgpKind === 'signed' && (a.type === 'application/pgp-signature' || /^signature\.asc$/i.test(a.name ?? '')));
let inlineSeq = 1;

export function ThreadView({ accountId, threadId, box, onBack, onPrev, onNext, hasPrev, hasNext }: { accountId: number; threadId: string; box: string; onBack: () => void; onPrev?: () => void; onNext?: () => void; hasPrev?: boolean; hasNext?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const compose = useCompose();
  const nav = useNavigate();
  const [prefs] = useMailPrefs();
  const [params, setParams] = useSearchParams();
  const { data: mailboxes = [] } = useMailboxes();
  const { data, isLoading, error } = useQuery({ queryKey: ['thread', accountId, threadId], queryFn: () => api.get<any>(`/api/mail/threads/${accountId}/${encodeURIComponent(threadId)}`) });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeAt, setSnoozeAt] = useState('');
  const [inline, setInline] = useState<InlineState | null>(null);
  const [quick, setQuick] = useState<{ items: string[]; loading: boolean } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [unsub, setUnsub] = useState<{ m: Msg; mailto: string; subject: string | null } | null>(null);
  const [unsubDone, setUnsubDone] = useState<Set<number>>(new Set());
  const composerRef = useRef<HTMLDivElement>(null);
  const messages: Msg[] = data?.messages ?? [];
  const account = data?.account;
  const me = String(account?.email ?? '').toLowerCase();
  const roleOf = useMemo(() => new Map(mailboxes.filter((m) => m.account_id === accountId).map((m) => [m.jmap_id, m])), [mailboxes, accountId]);

  useEffect(() => {
    if (!messages.length) return;
    const unread = messages.filter((m) => m.is_unread).map((m) => m.jmap_id);
    setExpanded(new Set([...unread, messages[messages.length - 1].jmap_id]));
    let t: number | null = null;
    if (unread.length) {
      t = window.setTimeout(() => { api.post('/api/mail/actions', { accountId, jmapIds: unread, action: 'read' }).then(() => { qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); }).catch(() => {}); }, prefs.markReadDelay * 1000);
    }
    setSummary(null); setQuick(null);
    return () => { if (t) window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.messages?.length, threadId]);
  useEffect(() => { setInline(null); compose.setInlineDraftId(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [threadId]);
  useEffect(() => { if (inline) setTimeout(() => composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50); }, [inline?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(action: string, extra: Record<string, unknown> = {}, opts: { back?: boolean; msg?: string; jmapIds?: string[] } = {}) {
    try {
      const r = await api.post<{ undo: Undo | null }>('/api/mail/actions', { accountId, ...(opts.jmapIds ? { jmapIds: opts.jmapIds } : { threadIds: [threadId] }), action, ...extra });
      const refresh = () => { qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] }); };
      refresh();
      if (opts.msg) {
        if (r.undo?.items.length) toast.toast(opts.msg, { action: { label: 'Undo', onClick: () => api.post('/api/mail/actions', { accountId, action: 'restore', items: r.undo!.items }).then(() => { refresh(); toast.success('Restored'); }).catch((e) => toast.error(e)) } });
        else toast.success(opts.msg);
      }
      if (opts.back) onBack();
    } catch (e) { toast.error(e); }
  }
  const last = messages[messages.length - 1];
  const lastInbound = [...messages].reverse().find((m) => m.from_email !== me) ?? last;
  const starred = messages.some((m) => m.is_flagged);
  const inInbox = messages.some((m) => m.mailbox_ids.some((id) => roleOf.get(id)?.role === 'inbox'));

  // ---- reply / forward seeds: the same addressing rules as the AI responders ----
  function forwardAttachmentsOf(m: Msg): ForwardAttachment[] {
    const pgpKind = pgpKindOf(m);
    return (m.attachments ?? []).filter((a: any) => a.blobId && isRealAttachment(a, pgpKind)).map((a: any) => ({ blobId: a.blobId, name: a.name ?? 'attachment', size: a.size ?? 0, type: a.type ?? 'application/octet-stream' }));
  }
  function optionFor(m: Msg, kind: ComposeKind) {
    if (kind === 'forward') return { to: [], cc: [], subject: forwardSubject(m.subject), quoteHtml: buildForwardHtml(m), forwardOfEmailId: m.id, replyToEmailId: null, forwardAttachments: forwardAttachmentsOf(m) };
    const r = replyRecipients({ from: m.from_addr, replyTo: m.reply_to, to: m.to_addr, cc: m.cc_addr }, me, kind === 'reply_all');
    return { to: r.to, cc: r.cc, subject: replySubject(m.subject), quoteHtml: buildQuoteHtml(m), replyToEmailId: m.id, forwardOfEmailId: null, forwardAttachments: [] };
  }
  function kindOptionsFor(m: Msg): KindOptions {
    return { reply: optionFor(m, 'reply'), reply_all: optionFor(m, 'reply_all'), forward: optionFor(m, 'forward') };
  }
  function seedFor(m: Msg, kind: ComposeKind, extra: Partial<ComposeSeed> = {}): ComposeSeed {
    const o = optionFor(m, kind);
    return { accountId, kind, to: o.to, cc: o.cc, subject: o.subject, quoteHtml: o.quoteHtml, replyToEmailId: o.replyToEmailId, forwardOfEmailId: o.forwardOfEmailId, forwardAttachments: o.forwardAttachments, threadKey: `${accountId}:${threadId}`, contactId: data?.contact?.id ?? null, ...extra };
  }
  function openInline(m: Msg, kind: ComposeKind, extra: Partial<ComposeSeed> = {}) {
    setQuick(null);
    setInline({ key: inlineSeq++, seed: seedFor(m, kind, extra), kindOptions: kindOptionsFor(m) });
  }
  function resumeDraft(d: any) {
    const seed = seedFromDraft(d);
    const orig = messages.find((m) => m.id === (d.reply_to_email_id ?? d.forward_of_email_id));
    setInline({ key: inlineSeq++, seed: { ...seed, contactId: data?.contact?.id ?? null, threadKey: `${accountId}:${threadId}` }, kindOptions: orig ? kindOptionsFor(orig) : {} });
    compose.setInlineDraftId(d.id);
  }
  const reply = (m: Msg, all = false) => openInline(m, all ? 'reply_all' : 'reply');
  const forward = (m: Msg) => openInline(m, 'forward');
  const aiReply = () => last && openInline(lastInbound, prefs.defaultReplyAll ? 'reply_all' : 'reply', { autoAi: 'reply' });
  useEffect(() => {
    if (!last) return;
    if (params.get('reply') === '1') { reply(lastInbound); setParams((p) => { p.delete('reply'); return p; }, { replace: true }); }
    if (params.get('forward') === '1') { forward(last); setParams((p) => { p.delete('forward'); return p; }, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, params]);

  async function summarize() {
    setSummarizing(true); setSummary('');
    try {
      await apiStream('/api/ai/draft', { mode: 'summarize', threadKey: `${accountId}:${threadId}`, accountId }, { onEvent: (ev, d) => { if (ev === 'token') setSummary((s) => (s ?? '') + d.t); if (ev === 'error') toast.error(d.error); } });
    } catch (e) { toast.error(e); } finally { setSummarizing(false); }
  }
  async function quickReplies() {
    if (!lastInbound) return;
    setQuick({ items: [], loading: true });
    const target = replyRecipients({ from: lastInbound.from_addr, replyTo: lastInbound.reply_to, to: lastInbound.to_addr, cc: lastInbound.cc_addr }, me).to[0];
    let text = '';
    try {
      await apiStream('/api/ai/draft', { mode: 'quick_replies', threadKey: `${accountId}:${threadId}`, accountId, contactId: data?.contact?.id ?? null, recipientEmail: target?.email, recipientName: target?.name ?? undefined }, { onEvent: (ev, d) => { if (ev === 'done') text = d.text; if (ev === 'error') toast.error(d.error); } });
    } catch (e) { toast.error(e); }
    const items = text.split('\n').map((s) => s.trim()).filter(Boolean);
    setQuick({ items, loading: false });
    if (!items.length) toast.toast('No suggestions this time');
  }
  async function blockSender(email: string) {
    try {
      await api.post('/api/rules', { name: `Block ${email}`, conditions: [{ field: 'from', op: 'equals', value: email }], actions: [{ type: 'spam' }] });
      await act('spam', {}, { back: true, msg: `Blocked ${email}: future mail goes to Junk` });
      qc.invalidateQueries({ queryKey: ['rules'] });
    } catch (e) { toast.error(e); }
  }
  async function sendUnsubscribe() {
    if (!unsub) return;
    try {
      await api.post('/api/mail/send', { accountId, to: [{ email: unsub.mailto }], subject: unsub.subject ?? 'Unsubscribe', html: '<p>Unsubscribe</p>', includeSignature: false });
      setUnsubDone((s) => new Set([...s, unsub.m.id]));
      toast.success('Unsubscribe request sent');
    } catch (e) { toast.error(e); }
    setUnsub(null);
  }

  useHotkeys({
    r: () => last && reply(lastInbound), a: () => last && reply(lastInbound, true), f: () => last && forward(last),
    e: () => inInbox && void act('archive', {}, { back: true, msg: 'Archived' }), '#': () => void act('trash', {}, { back: true, msg: 'Moved to trash' }), '!': () => void act('spam', {}, { back: true, msg: 'Marked as junk' }),
    s: () => void act(starred ? 'unstar' : 'star'), u: onBack, Escape: () => { if (preview !== null) return; onBack(); }, 'U': () => void act('unread', {}, { back: true }), 'I': () => void act('read'),
    b: () => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeOpen(true); },
    ']': () => onNext?.(), '[': () => onPrev?.(), 'm': () => void act(data?.muted ? 'unmute' : 'mute', {}, { back: !data?.muted, msg: data?.muted ? 'Unmuted' : 'Muted: new replies skip the inbox' }),
  }, [last, lastInbound, starred, inInbox, threadId, onNext, onPrev, data?.muted, preview]);

  if (isLoading) return <div className="center" style={{ padding: 60 }}><Spinner size={24} /></div>;
  if (error || !messages.length) return <div className="empty"><h3>Thread not found</h3><Button onClick={onBack}>Back</Button></div>;
  const labels = [...new Set(messages.flatMap((m) => m.mailbox_ids))].map((id) => roleOf.get(id)).filter((m) => m && !m.role) as { name: string; jmap_id: string; color: string | null }[];
  const previewItems: PreviewItem[] = messages.flatMap((m) => { const k = pgpKindOf(m); return (m.attachments ?? []).filter((a: any) => a.blobId && isRealAttachment(a, k) && canPreview(a.type)).map((a: any) => ({ url: attachmentUrl(accountId, a), name: a.name ?? 'attachment', type: a.type ?? '', size: a.size })); });
  const allOpen = messages.every((m) => expanded.has(m.jmap_id));
  const drafts: any[] = data?.drafts ?? [];
  const userDrafts = drafts.filter((d) => d.source !== 'ai' && !compose.openDraftIds.has(d.id) && inline?.seed.draftId !== d.id);
  const aiDrafts = drafts.filter((d) => d.source === 'ai' && !compose.openDraftIds.has(d.id) && inline?.seed.draftId !== d.id);
  const other = lastInbound?.from_addr?.[0];

  return (
    <div className="thread-view">
      <div className="row mb-8 thread-toolbar" style={{ gap: 2 }}>
        <IconButton label="Back to list (u)" onClick={onBack}><ArrowLeft size={18} /></IconButton>
        {inInbox ? <IconButton label="Archive (e)" onClick={() => act('archive', {}, { back: true, msg: 'Archived' })}><Archive size={17} /></IconButton> : <IconButton label="Move to inbox" onClick={() => act('inbox', {}, { msg: 'Moved to inbox' })}><Inbox size={17} /></IconButton>}
        <IconButton label="Delete (#)" onClick={() => act('trash', {}, { back: true, msg: 'Moved to trash' })}><Trash2 size={17} /></IconButton>
        <IconButton label="Mark as junk (!)" onClick={() => act('spam', {}, { back: true, msg: 'Marked as junk' })}><ShieldAlert size={17} /></IconButton>
        <span className="sep" />
        <IconButton label="Mark unread (Shift+U)" onClick={() => act('unread', {}, { back: true })}><MailOpen size={17} /></IconButton>
        <IconButton label="Snooze (b)" onClick={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeOpen(true); }}><AlarmClock size={17} /></IconButton>
        <Menu width={240} trigger={(open) => <IconButton label="Label / move (l)" onClick={open}><Tag size={17} /></IconButton>}>
          {(c) => <>
            <div className="menu-label">Labels</div>
            {mailboxes.filter((m) => m.account_id === accountId && !m.role).map((m) => { const on = labels.some((l) => l.jmap_id === m.jmap_id); return <MenuItem key={m.jmap_id} active={on} onClick={() => { void act(on ? 'unlabel' : 'label', { mailboxId: m.jmap_id }, { msg: on ? `Removed ${m.name}` : `Labeled ${m.name}` }); c(); }} icon={<Tag size={14} style={{ color: m.color ?? undefined }} />}>{m.name}</MenuItem>; })}
            {!mailboxes.some((m) => m.account_id === accountId && !m.role) && <div className="menu-item faint">No labels yet</div>}
            <div className="menu-sep" /><div className="menu-label">Move to</div>
            {mailboxes.filter((m) => m.account_id === accountId && m.role && !['sent', 'drafts'].includes(m.role)).map((m) => <MenuItem key={m.jmap_id} onClick={() => { void act('move', { mailboxId: m.jmap_id }, { back: true, msg: `Moved to ${m.name}` }); c(); }}>{m.name}</MenuItem>)}
          </>}
        </Menu>
        <IconButton label={starred ? 'Unstar (s)' : 'Star (s)'} onClick={() => act(starred ? 'unstar' : 'star')} className={starred ? 'active' : ''}><Star size={17} fill={starred ? 'currentColor' : 'none'} /></IconButton>
        <Menu align="right" width={250} trigger={(open) => <IconButton label="More" onClick={open}><MoreHorizontal size={17} /></IconButton>}>
          {(c) => <>
            <MenuItem icon={allOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />} onClick={() => { setExpanded(allOpen ? new Set([last.jmap_id]) : new Set(messages.map((m) => m.jmap_id))); c(); }}>{allOpen ? 'Collapse all' : 'Expand all'}</MenuItem>
            <MenuItem icon={data?.muted ? <Bell size={15} /> : <BellOff size={15} />} shortcut="m" onClick={() => { void act(data?.muted ? 'unmute' : 'mute', {}, { back: !data?.muted, msg: data?.muted ? 'Unmuted' : 'Muted: new replies skip the inbox' }); c(); }}>{data?.muted ? 'Unmute' : 'Mute'}</MenuItem>
            <MenuItem icon={<Printer size={15} />} onClick={() => { window.print(); c(); }}>Print</MenuItem>
            {other?.email && other.email.toLowerCase() !== me && <>
              <div className="menu-sep" />
              <MenuItem icon={<ListFilter size={15} />} onClick={() => { nav(`/mail/all?q=${encodeURIComponent(`from:${other.email}`)}`); c(); }}>Find messages from {addrName(other)}</MenuItem>
              <MenuItem icon={<Ban size={15} />} danger onClick={() => { if (confirm(`Block ${other.email}? Future messages go to Junk.`)) void blockSender(other.email); c(); }}>Block {addrName(other)}</MenuItem>
            </>}
            <div className="menu-sep" />
            <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { if (confirm('Permanently delete this conversation?')) void act('delete', {}, { back: true, msg: 'Deleted' }); c(); }}>Delete permanently</MenuItem>
          </>}
        </Menu>
        <div className="ml-auto row gap-4">
          {(onPrev || onNext) && <span className="row" style={{ gap: 0 }}><IconButton label="Newer conversation ([)" disabled={!hasPrev} onClick={onPrev}><ChevronLeft size={17} /></IconButton><IconButton label="Older conversation (])" disabled={!hasNext} onClick={onNext}><ChevronRight size={17} /></IconButton></span>}
          <Button size="sm" variant="ai" icon={<Bot size={14} />} onClick={aiReply}>AI reply</Button>
          <Button size="sm" variant="ai" icon={<Sparkles size={14} />} onClick={summarize} loading={summarizing}>Summarize</Button>
        </div>
      </div>
      <div className="thread-head">
        <div className="flex-1">
          <h1>{last.subject || '(no subject)'}</h1>
          <div className="row wrap gap-4 mt-8">
            {box !== 'inbox' && !inInbox && <Badge>{[...new Set(messages.flatMap((m) => m.mailbox_ids.map((id) => roleOf.get(id)?.role).filter(Boolean)))].join(', ') || 'archive'}</Badge>}
            {labels.map((l) => <span key={l.jmap_id} className="tag" style={l.color ? { background: l.color + '22', color: l.color } : {}}>{l.name}</span>)}
            {data?.snoozedUntil && <Badge kind="warning"><AlarmClock size={12} /> snoozed until {fmtDateTime(data.snoozedUntil)}</Badge>}
            {data?.muted && <Badge><BellOff size={12} /> muted</Badge>}
            <span className="small faint">{messages.length} message{messages.length === 1 ? '' : 's'}</span>
            {messages.length > 1 && <button type="button" className="link-btn small" onClick={() => setExpanded(allOpen ? new Set([last.jmap_id]) : new Set(messages.map((m) => m.jmap_id)))}>{allOpen ? 'Collapse all' : 'Expand all'}</button>}
          </div>
        </div>
      </div>
      {summary !== null && <div className="card mb-16 ai-card"><div className="row mb-8"><Sparkles size={15} /><span className="strong small">Summary</span>{summarizing && <Spinner size={14} />}<IconButton label="Close" className="btn-sm ml-auto" onClick={() => setSummary(null)}><X size={14} /></IconButton></div><div className="pre" style={{ fontSize: 13.5 }}>{summary || '…'}</div></div>}
      <div className="thread-side">
        <div className="thread-main">
          {messages.map((m) => (
            <MessageCard key={m.jmap_id} m={m} accountId={accountId} me={me} isContact={Boolean(data?.contact) && m.from_email === String(data?.contact?.email ?? '').toLowerCase()} open={expanded.has(m.jmap_id)} single={messages.length === 1}
              onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(m.jmap_id)) n.delete(m.jmap_id); else n.add(m.jmap_id); return n; })}
              onReply={() => reply(m)} onReplyAll={() => reply(m, true)} onForward={() => forward(m)}
              onStar={() => act(m.is_flagged ? 'unstar' : 'star', {}, { jmapIds: [m.jmap_id] })}
              onUnreadFromHere={() => { const from = messages.slice(messages.indexOf(m)).map((x) => x.jmap_id); api.post('/api/mail/actions', { accountId, jmapIds: from, action: 'unread' }).then(() => { qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); onBack(); }); }}
              onDelete={() => act('trash', {}, { jmapIds: [m.jmap_id], msg: 'Message moved to trash' })}
              onBlock={() => { if (confirm(`Block ${m.from_email}? Future messages go to Junk.`)) void blockSender(m.from_email); }}
              onFilter={() => nav(`/mail/all?q=${encodeURIComponent(`from:${m.from_email}`)}`)}
              onUnsubscribe={(u) => { if (u.url && !u.mailto) window.open(u.url, '_blank', 'noopener'); else if (u.mailto) setUnsub({ m, mailto: u.mailto, subject: u.subject }); }}
              unsubscribed={unsubDone.has(m.id)}
              onPreview={(a) => { const i = previewItems.findIndex((p) => p.url === attachmentUrl(accountId, a)); if (i >= 0) setPreview(i); }} />
          ))}
          {aiDrafts.map((d) => <SuggestedReply key={d.id} draft={d} accountId={accountId} threadId={threadId} onEdit={() => resumeDraft(d)} />)}
          {userDrafts.map((d) => <DraftCard key={d.id} draft={d} onResume={() => resumeDraft(d)} onDiscard={() => api.del(`/api/mail/drafts/${d.id}`).then(() => { qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] }); qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); })} />)}
          {data?.aiPending > 0 && <div className="card mb-16 ai-card"><div className="row small"><Spinner size={14} /> An AI responder is writing a reply to this thread…</div></div>}
          {inline ? (
            <div ref={composerRef} className="inline-compose" key={inline.key}>
              <Composer seed={inline.seed} variant="inline" kindOptions={inline.kindOptions}
                onClose={() => { setInline(null); compose.setInlineDraftId(null); }}
                onDraftId={(id) => compose.setInlineDraftId(id)}
                onPopOut={(seed) => { setInline(null); compose.setInlineDraftId(null); compose.open(seed); }}
                onSent={() => qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] })} />
            </div>
          ) : (
            <div className="reply-bar">
              <Avatar name={account?.name} email={account?.email} className="reply-avatar" />
              <div className="flex-1 col" style={{ gap: 8 }}>
                <div className="row wrap gap-4">
                  <Button icon={<Reply size={15} />} onClick={() => reply(lastInbound)} title="Reply (r)">Reply</Button>
                  {(lastInbound.to_addr.length + (lastInbound.cc_addr?.length ?? 0) > 1 || lastInbound.from_email === me) && <Button icon={<ReplyAll size={15} />} onClick={() => reply(lastInbound, true)} title="Reply all (a)">Reply all</Button>}
                  <Button icon={<Forward size={15} />} onClick={() => forward(last)} title="Forward (f)">Forward</Button>
                  <Button variant="ghost" icon={<Zap size={15} />} onClick={quickReplies} loading={quick?.loading} title="Three short replies suggested by the AI">Quick replies</Button>
                </div>
                {quick && !quick.loading && quick.items.length > 0 && <div className="quick-replies">{quick.items.map((q) => <button key={q} type="button" onClick={() => openInline(lastInbound, 'reply', { initialText: q })}><Sparkles size={12} /> {q}</button>)}</div>}
              </div>
            </div>
          )}
        </div>
        <div className="context">
          <ContextCard data={data} accountId={accountId} onOpenContact={(id) => nav(`/contacts/${id}`)} />
        </div>
      </div>
      <Modal open={snoozeOpen} onClose={() => setSnoozeOpen(false)} title="Snooze until" footer={<><Button onClick={() => setSnoozeOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setSnoozeOpen(false); void act('snooze', { until: new Date(snoozeAt).toISOString() }, { back: true, msg: `Snoozed until ${fmtDateTime(snoozeAt)}` }); }}>Snooze</Button></>}>
        <Field label="Return to inbox at"><Input type="datetime-local" value={snoozeAt} onChange={(e) => setSnoozeAt(e.target.value)} /></Field>
        <div className="row wrap gap-4">{[['Later today', 3], ['Tomorrow', 24], ['In 3 days', 72], ['Next week', 168]].map(([l, h]) => <Button key={String(l)} size="sm" onClick={() => { const d = new Date(Date.now() + Number(h) * 3600_000); if (Number(h) >= 24) d.setHours(9, 0, 0, 0); setSnoozeAt(localDateTimeValue(d)); }}>{l}</Button>)}</div>
      </Modal>
      <Modal open={Boolean(unsub)} onClose={() => setUnsub(null)} title="Unsubscribe?" footer={<><Button onClick={() => setUnsub(null)}>Cancel</Button><Button variant="primary" onClick={sendUnsubscribe}>Send unsubscribe email</Button></>}>
        <div className="muted">An email will be sent to <b>{unsub?.mailto}</b> asking to be removed from this list, the way the list asked for it in its headers.</div>
      </Modal>
      <AttachmentPreview items={previewItems} index={preview} onClose={() => setPreview(null)} onIndex={setPreview} />
    </div>
  );
}

function attachmentUrl(accountId: number, a: any): string {
  return `/api/mail/blob/${accountId}/${encodeURIComponent(a.blobId)}?name=${encodeURIComponent(a.name ?? 'attachment')}&type=${encodeURIComponent(a.type ?? '')}`;
}

function MessageCard({ m, accountId, me, isContact, open, single, onToggle, onReply, onReplyAll, onForward, onStar, onUnreadFromHere, onDelete, onBlock, onFilter, onUnsubscribe, unsubscribed, onPreview }: {
  m: Msg; accountId: number; me: string; isContact: boolean; open: boolean; single: boolean; onToggle: () => void; onReply: () => void; onReplyAll: () => void; onForward: () => void; onStar: () => void; onUnreadFromHere: () => void; onDelete: () => void; onBlock: () => void; onFilter: () => void; onUnsubscribe: (u: { mailto: string | null; subject: string | null; url: string | null }) => void; unsubscribed: boolean; onPreview: (a: any) => void;
}) {
  const [prefs] = useMailPrefs();
  const from = m.from_addr?.[0];
  const pgpKind = pgpKindOf(m);
  const mine = m.from_email === me;
  const unsub = parseListUnsubscribe(m.list_unsubscribe);
  const isList = Boolean(m.list_unsubscribe || m.list_id);
  const atts = (m.attachments ?? []).filter((a: any) => isRealAttachment(a, pgpKind));
  const recipients = [...m.to_addr, ...(m.cc_addr ?? [])];
  const toLabel = recipients.map((a) => (a.email.toLowerCase() === me ? 'me' : addrName(a))).join(', ');
  return (
    <div className={cls('msg', !open && 'collapsed', m.is_unread && 'unread')}>
      <div className="msg-head" onClick={() => { if (!open || !single) onToggle(); }}>
        <Avatar name={from?.name} email={from?.email} src={m.avatar_url} />
        <div className="who">
          <div className="name">
            <span className="truncate">{mine ? 'me' : addrName(from)}</span>
            {open && from?.email && !mine && <span className="small faint truncate desktop-only">&lt;{from.email}&gt;</span>}
            {m.is_draft && <Badge kind="warning">Draft</Badge>}
            {!open && m.has_attachment && pgpKind !== 'pgp/mime' && <Paperclip size={13} className="faint" />}
            {pgpKind && pgpKind !== 'signed' && <Badge kind="accent">encrypted</Badge>}
            {isList && open && !mine && <Badge>list</Badge>}
          </div>
          {open ? <Menu width={380} trigger={(o) => <div className="to" onClick={(e) => { e.stopPropagation(); o(); }} style={{ cursor: 'pointer' }}>to {toLabel || '—'} <ChevronDown size={12} /></div>}>
            {() => <div style={{ padding: 8 }}><table className="details-table"><tbody>
              <tr><td>from</td><td>{addrFull(from)}</td></tr>
              {m.reply_to?.length > 0 && <tr><td>reply-to</td><td>{m.reply_to.map(addrFull).join(', ')}</td></tr>}
              <tr><td>to</td><td>{m.to_addr.map(addrFull).join(', ')}</td></tr>
              {m.cc_addr?.length > 0 && <tr><td>cc</td><td>{m.cc_addr.map(addrFull).join(', ')}</td></tr>}
              {m.bcc_addr?.length > 0 && <tr><td>bcc</td><td>{m.bcc_addr.map(addrFull).join(', ')}</td></tr>}
              <tr><td>date</td><td>{fmtDateTime(m.received_at)}</td></tr>
              {m.list_id && <tr><td>list</td><td className="mono small">{m.list_id}</td></tr>}
              {m.message_id?.[0] && <tr><td>message-id</td><td className="mono small">{m.message_id[0]}</td></tr>}
              <tr><td>size</td><td>{fmtBytes(m.size)}</td></tr>
              {m.blob_id && <tr><td>raw</td><td><a href={`/api/mail/blob/${accountId}/${m.blob_id}?name=message.eml&type=message/rfc822&download=1`}>Download .eml</a></td></tr>}
            </tbody></table></div>}
          </Menu> : <div className="snippet">{pgpKind && pgpKind !== 'signed' ? 'Encrypted message' : m.preview}</div>}
        </div>
        <div className="when" title={fmtDateTime(m.received_at)}>{fmtDate(m.received_at, { always: false })}<span className="desktop-only"> · {fmtRelative(m.received_at)}</span></div>
        <div className="row msg-actions" style={{ gap: 0 }} onClick={(e) => e.stopPropagation()}>
          <IconButton label={m.is_flagged ? 'Unstar message' : 'Star message'} className={cls('btn-sm', m.is_flagged && 'active')} onClick={onStar}><Star size={15} fill={m.is_flagged ? 'currentColor' : 'none'} /></IconButton>
          {open && <IconButton label="Reply" className="btn-sm" onClick={onReply}><Reply size={16} /></IconButton>}
          {open && <Menu align="right" width={230} trigger={(o) => <IconButton label="More" className="btn-sm" onClick={o}><MoreHorizontal size={16} /></IconButton>}>
            {(c) => <>
              <MenuItem icon={<ReplyAll size={15} />} onClick={() => { onReplyAll(); c(); }}>Reply all</MenuItem>
              <MenuItem icon={<Forward size={15} />} onClick={() => { onForward(); c(); }}>Forward</MenuItem>
              <MenuItem icon={<MailOpen size={15} />} onClick={() => { onUnreadFromHere(); c(); }}>Mark unread from here</MenuItem>
              {!mine && <MenuItem icon={<ListFilter size={15} />} onClick={() => { onFilter(); c(); }}>Find messages from this sender</MenuItem>}
              {!mine && <MenuItem icon={<Ban size={15} />} danger onClick={() => { onBlock(); c(); }}>Block sender</MenuItem>}
              <MenuItem icon={<FileText size={15} />} onClick={() => { window.open(`/api/mail/blob/${accountId}/${m.blob_id}?name=message.eml&type=message/rfc822&download=1`, '_blank'); c(); }}>Show original</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { onDelete(); c(); }}>Delete this message</MenuItem>
            </>}
          </Menu>}
        </div>
      </div>
      {open && (
        <>
          {isList && !mine && (unsub.mailto || unsub.url) && (
            <div className="msg-list-bar">
              <span className="small muted">This looks like a mailing list.</span>
              {unsubscribed ? <Badge kind="success">Unsubscribe request sent</Badge> : <button type="button" className="link-btn small" onClick={() => onUnsubscribe(unsub)}><MailX size={13} /> Unsubscribe</button>}
              {unsub.url && unsub.mailto && <a className="small" href={unsub.url} target="_blank" rel="noopener noreferrer">open list page</a>}
            </div>
          )}
          <div className="msg-body">{pgpKind ? <EncryptedMessage m={m} accountId={accountId} kind={pgpKind} /> : <MessageBody html={m.body_html} text={m.body_text} attachments={m.attachments} accountId={accountId} senderEmail={from?.email} autoAllow={prefs.showImagesFromContacts && isContact} />}</div>
          {pgpKind !== 'pgp/mime' && atts.length > 0 && (
            <div className="attachments">
              {atts.map((a: any, i: number) => {
                const url = attachmentUrl(accountId, a);
                const isImg = /^image\/(png|jpe?g|gif|webp)/.test(a.type ?? '');
                const previewable = canPreview(a.type);
                return <a key={i} className="attachment" href={`${url}&download=1`} title={previewable ? `Preview ${a.name}` : a.name} onClick={(e) => { if (previewable) { e.preventDefault(); onPreview(a); } }}>{isImg ? <img src={url} alt="" /> : <Paperclip size={15} className="faint" />}<span className="col" style={{ gap: 0, minWidth: 0 }}><span className="a-name">{a.name ?? 'attachment'}</span><span className="a-size">{fmtBytes(a.size)}</span></span><Download size={14} className="faint" /></a>;
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ContextCard({ data, accountId, onOpenContact }: { data: any; accountId: number; onOpenContact: (id: number) => void }) {
  const compose = useCompose();
  const c = data?.contact;
  const other: Addr | undefined = data?.messages?.flatMap((m: any) => [...(m.from_addr ?? []), ...(m.to_addr ?? [])]).find((a: Addr) => a.email?.toLowerCase() !== data?.account?.email?.toLowerCase());
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  async function addContact() {
    if (!other) return;
    setAdding(true);
    try {
      const parts = (other.name ?? '').split(' ');
      await api.post('/api/contacts', { email: other.email, first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') });
      qc.invalidateQueries({ queryKey: ['thread'] });
      toast.success('Contact added');
    } catch (e) { toast.error(e); } finally { setAdding(false); }
  }
  return (
    <div className="card context-card">
      {c ? (
        <>
          <div className="row mb-8"><Avatar name={[c.first_name, c.last_name].join(' ')} email={c.email} size="lg" src={c.avatar_version ? `/api/avatars/contact/${c.id}?v=${c.avatar_version}` : null} /><div className="flex-1 col" style={{ gap: 0 }}><div className="strong truncate">{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</div><div className="small muted truncate">{c.title}{c.title && c.company ? ' · ' : ''}{c.company}</div></div></div>
          <div className="small muted truncate mb-8">{c.email}</div>
          <div className="row wrap gap-4 mb-8"><Badge kind={c.status === 'active' ? 'success' : c.status === 'replied' ? 'accent' : 'danger'}>{c.status}</Badge>{(c.tags ?? []).map((t: string) => <span key={t} className="tag">{t}</span>)}</div>
          {data.enrollments?.length > 0 && <div className="mb-8"><h4 className="mb-8">Sequences</h4>{data.enrollments.map((e: any) => <div key={e.id} className="row small" style={{ justifyContent: 'space-between' }}><span className="truncate"><Workflow size={12} /> {e.sequence_name}</span><Badge kind={e.status === 'active' ? 'accent' : e.status === 'replied' ? 'success' : undefined}>{e.status}</Badge></div>)}</div>}
          {data.sends?.length > 0 && <div className="mb-8"><h4 className="mb-8">Sent from Tern</h4>{data.sends.slice(-3).map((s: any) => <div key={s.id} className="small muted truncate">{fmtDate(s.sent_at)} · {s.kind}{s.replied_at ? ' · replied' : ''}{s.bounced_at ? ' · bounced' : ''}</div>)}</div>}
          <div className="row gap-4 mt-8"><Button size="sm" icon={<Contact size={14} />} onClick={() => onOpenContact(c.id)}>Open contact</Button><Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => compose.open({ accountId, to: [{ name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email }], contactId: c.id })}>New email</Button></div>
        </>
      ) : other ? (
        <>
          <div className="row mb-8"><Avatar name={other.name} email={other.email} size="lg" /><div className="flex-1 col" style={{ gap: 0 }}><div className="strong truncate">{addrName(other)}</div><div className="small muted truncate">{other.email}</div></div></div>
          <div className="small muted mb-8">Not in your contacts yet.</div>
          <Button size="sm" icon={<Contact size={14} />} onClick={addContact} loading={adding}>Add to contacts</Button>
        </>
      ) : <div className="small muted">No external participants.</div>}
    </div>
  );
}

// A reply an AI responder prepared. Send it as it is, edit it inline, or discard it.
function SuggestedReply({ draft, accountId, threadId, onEdit }: { draft: any; accountId: number; threadId: string; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] }); qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); qc.invalidateQueries({ queryKey: ['threads'] }); };
  async function sendNow() {
    setBusy(true);
    try {
      await api.post('/api/mail/send', { accountId, to: draft.to_addr, cc: draft.cc_addr, bcc: draft.bcc_addr, subject: draft.subject, html: draft.body_html, replyToEmailId: draft.reply_to_email_id, draftId: draft.id });
      toast.success('Sent'); refresh();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function discard() { await api.del(`/api/mail/drafts/${draft.id}`); refresh(); }
  return (
    <div className="card mb-16 suggested-glow" style={{ borderColor: 'var(--accent)' }}>
      <div className="row mb-8"><Bot size={15} /><span className="strong small">Suggested reply{draft.responder_name ? ` · ${draft.responder_name}` : ''}</span><span className="small faint">{fmtRelative(draft.created_at)}</span><span className="ml-auto small muted truncate">to {(draft.to_addr ?? []).map((a: any) => a.name || a.email).join(', ')}</span></div>
      <div className="strong small mb-8">{draft.subject}</div>
      <div className="msg-text" style={{ fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: String(draft.body_html).split('<div class="tern-quote"')[0] }} />
      <div className="row mt-16 gap-4">
        <Button size="sm" variant="primary" icon={<Send size={13} />} loading={busy} onClick={sendNow}>Send</Button>
        <Button size="sm" icon={<Pencil size={13} />} onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={discard}>Discard</Button>
      </div>
    </div>
  );
}

function DraftCard({ draft, onResume, onDiscard }: { draft: any; onResume: () => void; onDiscard: () => void }) {
  const text = String(draft.body_html ?? '').split('<div class="tern-quote"')[0].replace(/<div class="tern-signature"[\s\S]*$/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return (
    <div className="card mb-16 draft-card" onClick={onResume} role="button">
      <div className="row"><Badge kind="danger">Draft</Badge><span className="small muted truncate">to {(draft.to_addr ?? []).map((a: any) => a.name || a.email).join(', ') || '(no recipients)'}</span><span className="small faint ml-auto">{fmtRelative(draft.updated_at)}</span></div>
      <div className="small mt-8 truncate">{text || <span className="faint">(empty)</span>}</div>
      <div className="row mt-8 gap-4" onClick={(e) => e.stopPropagation()}><Button size="sm" icon={<Pencil size={13} />} onClick={onResume}>Resume</Button><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onDiscard}>Discard</Button></div>
    </div>
  );
}
