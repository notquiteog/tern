import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlarmClock, Archive, ArrowLeft, ChevronDown, Download, Forward, MailOpen, MoreHorizontal, Paperclip, Reply, ReplyAll, ShieldAlert, Sparkles, Star, Tag, Trash2, Inbox, Printer, Contact, Workflow, ExternalLink, Bot, Send, Pencil, X } from 'lucide-react';
import { api, apiStream } from '../api';
import { useCompose } from '../state/compose';
import { useToast } from '../state/toast';
import { useHotkeys } from '../lib/hooks';
import { useMailboxes } from '../lib/queries';
import { Avatar, Badge, Button, IconButton, Menu, MenuItem, Modal, Spinner, Field, Input } from './ui';
import { MessageBody } from './MessageBody';
import { addrFull, addrName, cls, fmtBytes, fmtDateTime, fmtDate, fmtRelative, localDateTimeValue, escapeHtml, type Addr } from '../lib/format';

interface Msg { id: number; jmap_id: string; thread_id: string; mailbox_ids: string[]; keywords: string[]; received_at: string; sent_at: string | null; message_id: string[]; from_addr: Addr[]; to_addr: Addr[]; cc_addr: Addr[]; bcc_addr: Addr[]; reply_to: Addr[]; subject: string; preview: string; has_attachment: boolean; body_text: string | null; body_html: string | null; attachments: any[]; is_unread: boolean; is_flagged: boolean; is_draft: boolean; from_email: string; size: number; blob_id: string; avatar_url?: string | null }

export function ThreadView({ accountId, threadId, box, onBack }: { accountId: number; threadId: string; box: string; onBack: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const compose = useCompose();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: mailboxes = [] } = useMailboxes();
  const { data, isLoading, error } = useQuery({ queryKey: ['thread', accountId, threadId], queryFn: () => api.get<any>(`/api/mail/threads/${accountId}/${encodeURIComponent(threadId)}`) });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeAt, setSnoozeAt] = useState('');
  const messages: Msg[] = data?.messages ?? [];
  const account = data?.account;
  const roleOf = useMemo(() => new Map(mailboxes.filter((m) => m.account_id === accountId).map((m) => [m.jmap_id, m])), [mailboxes, accountId]);

  useEffect(() => {
    if (!messages.length) return;
    const unread = messages.filter((m) => m.is_unread).map((m) => m.jmap_id);
    setExpanded(new Set([...messages.filter((m) => m.is_unread).map((m) => m.jmap_id), messages[messages.length - 1].jmap_id]));
    if (unread.length) {
      api.post('/api/mail/actions', { accountId, jmapIds: unread, action: 'read' }).then(() => { qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); }).catch(() => {});
    }
    setSummary(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.messages?.length, threadId]);

  async function act(action: string, extra: Record<string, unknown> = {}, opts: { back?: boolean; msg?: string } = {}) {
    try {
      await api.post('/api/mail/actions', { accountId, threadIds: [threadId], action, ...extra });
      qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] });
      if (opts.msg) toast.success(opts.msg);
      if (opts.back) onBack();
    } catch (e) { toast.error(e); }
  }
  const last = messages[messages.length - 1];
  const starred = messages.some((m) => m.is_flagged);
  useEffect(() => {
    if (!last) return;
    if (params.get('reply') === '1') { reply(last); setParams((p) => { p.delete('reply'); return p; }, { replace: true }); }
    if (params.get('forward') === '1') { forward(last); setParams((p) => { p.delete('forward'); return p; }, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, params]);
  const inInbox = messages.some((m) => m.mailbox_ids.some((id) => roleOf.get(id)?.role === 'inbox'));

  function quoteOf(m: Msg): string {
    const header = `On ${fmtDateTime(m.received_at)}, ${escapeHtml(addrFull(m.from_addr?.[0]))} wrote:`;
    const body = m.body_html ?? (m.body_text ? `<div style="white-space:pre-wrap">${escapeHtml(m.body_text)}</div>` : '');
    return `<div class="tern-quote"><div style="color:#5b6274;font-size:12.5px;margin-bottom:6px">${header}</div><blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d0d4e0">${body}</blockquote></div>`;
  }
  function reply(m: Msg, all = false, autoAi: 'reply' | null = null) {
    const me = account?.email?.toLowerCase();
    const replyTo = m.reply_to?.length ? m.reply_to : m.from_addr;
    const to = replyTo.filter((a) => a.email.toLowerCase() !== me).length ? replyTo.filter((a) => a.email.toLowerCase() !== me) : m.to_addr.filter((a) => a.email.toLowerCase() !== me);
    const cc = all ? [...m.to_addr, ...m.cc_addr].filter((a) => a.email.toLowerCase() !== me && !to.some((t) => t.email.toLowerCase() === a.email.toLowerCase())) : [];
    compose.open({ accountId, kind: all ? 'reply_all' : 'reply', to, cc, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, quoteHtml: quoteOf(m), replyToEmailId: m.id, threadKey: `${accountId}:${threadId}`, contactId: data?.contact?.id ?? null, autoAi });
  }
  function forward(m: Msg) {
    const header = `<div style="color:#5b6274;font-size:12.5px">---------- Forwarded message ----------<br>From: ${escapeHtml(addrFull(m.from_addr?.[0]))}<br>Date: ${fmtDateTime(m.received_at)}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(m.to_addr.map(addrFull).join(', '))}</div><br>`;
    compose.open({ accountId, kind: 'forward', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, quoteHtml: header + (m.body_html ?? `<div style="white-space:pre-wrap">${escapeHtml(m.body_text ?? '')}</div>`), forwardOfEmailId: m.id, threadKey: `${accountId}:${threadId}` });
  }
  async function summarize() {
    setSummarizing(true); setSummary('');
    try {
      await apiStream('/api/ai/draft', { mode: 'summarize', threadKey: `${accountId}:${threadId}`, accountId }, { onEvent: (ev, d) => { if (ev === 'token') setSummary((s) => (s ?? '') + d.t); if (ev === 'error') toast.error(d.error); } });
    } catch (e) { toast.error(e); } finally { setSummarizing(false); }
  }

  useHotkeys({
    r: () => last && reply(last), a: () => last && reply(last, true), f: () => last && forward(last),
    e: () => inInbox && void act('archive', {}, { back: true, msg: 'Archived' }), '#': () => void act('trash', {}, { back: true, msg: 'Moved to trash' }), '!': () => void act('spam', {}, { back: true, msg: 'Marked as junk' }),
    s: () => void act(starred ? 'unstar' : 'star'), u: onBack, Escape: onBack, 'U': () => void act('unread', {}, { back: true }), 'I': () => void act('read'),
    b: () => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeOpen(true); },
  }, [last, starred, inInbox, threadId]);

  if (isLoading) return <div className="center" style={{ padding: 60 }}><Spinner size={24} /></div>;
  if (error || !messages.length) return <div className="empty"><h3>Thread not found</h3><Button onClick={onBack}>Back</Button></div>;
  const labels = [...new Set(messages.flatMap((m) => m.mailbox_ids))].map((id) => roleOf.get(id)).filter((m) => m && !m.role) as { name: string; jmap_id: string; color: string | null }[];

  return (
    <div className="thread-view">
      <div className="row mb-8 thread-toolbar" style={{ gap: 2 }}>
        <IconButton label="Back to list" onClick={onBack}><ArrowLeft size={18} /></IconButton>
        {inInbox ? <IconButton label="Archive (e)" onClick={() => act('archive', {}, { back: true, msg: 'Archived' })}><Archive size={17} /></IconButton> : <IconButton label="Move to inbox" onClick={() => act('inbox', {}, { msg: 'Moved to inbox' })}><Inbox size={17} /></IconButton>}
        <IconButton label="Delete (#)" onClick={() => act('trash', {}, { back: true, msg: 'Moved to trash' })}><Trash2 size={17} /></IconButton>
        <IconButton label="Mark as junk (!)" onClick={() => act('spam', {}, { back: true, msg: 'Marked as junk' })}><ShieldAlert size={17} /></IconButton>
        <span className="sep" style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
        <IconButton label="Mark unread (Shift+U)" onClick={() => act('unread', {}, { back: true })}><MailOpen size={17} /></IconButton>
        <IconButton label="Snooze (b)" onClick={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeOpen(true); }}><AlarmClock size={17} /></IconButton>
        <Menu width={240} trigger={(open) => <IconButton label="Label (l)" onClick={open}><Tag size={17} /></IconButton>}>
          {(c) => <>
            <div className="menu-label">Labels</div>
            {mailboxes.filter((m) => m.account_id === accountId && !m.role).map((m) => { const on = labels.some((l) => l.jmap_id === m.jmap_id); return <MenuItem key={m.jmap_id} active={on} onClick={() => { void act(on ? 'unlabel' : 'label', { mailboxId: m.jmap_id }); c(); }} icon={<Tag size={14} style={{ color: m.color ?? undefined }} />}>{m.name}</MenuItem>; })}
            {!mailboxes.some((m) => m.account_id === accountId && !m.role) && <div className="menu-item faint">No labels yet</div>}
            <div className="menu-sep" /><div className="menu-label">Move to</div>
            {mailboxes.filter((m) => m.account_id === accountId && m.role && !['sent', 'drafts'].includes(m.role)).map((m) => <MenuItem key={m.jmap_id} onClick={() => { void act('move', { mailboxId: m.jmap_id }, { back: true, msg: `Moved to ${m.name}` }); c(); }}>{m.name}</MenuItem>)}
          </>}
        </Menu>
        <IconButton label={starred ? 'Unstar (s)' : 'Star (s)'} onClick={() => act(starred ? 'unstar' : 'star')} className={starred ? 'active' : ''}><Star size={17} fill={starred ? 'currentColor' : 'none'} /></IconButton>
        <Menu align="right" trigger={(open) => <IconButton label="More" onClick={open}><MoreHorizontal size={17} /></IconButton>}>
          {(c) => <>
            <MenuItem icon={<Printer size={15} />} onClick={() => { window.print(); c(); }}>Print</MenuItem>
            <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { if (confirm('Permanently delete this conversation?')) void act('delete', {}, { back: true, msg: 'Deleted' }); c(); }}>Delete permanently</MenuItem>
          </>}
        </Menu>
        <div className="ml-auto row gap-4">
          <Button size="sm" variant="ai" icon={<Bot size={14} />} onClick={() => last && reply(last, false, 'reply')}>AI reply</Button>
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
            <span className="small faint">{messages.length} message{messages.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>
      {summary !== null && <div className="card mb-16" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}><div className="row mb-8"><Sparkles size={15} /><span className="strong small">Summary</span>{summarizing && <Spinner size={14} />}</div><div className="pre" style={{ fontSize: 13.5 }}>{summary || '…'}</div></div>}
      <div className="thread-side">
        <div>
          {messages.map((m) => {
            const open = expanded.has(m.jmap_id);
            const from = m.from_addr?.[0];
            const isDraft = m.is_draft;
            return (
              <div key={m.jmap_id} className={cls('msg', !open && 'collapsed')}>
                <div className="msg-head" onClick={() => { if (!open || messages.length > 1) setExpanded((s) => { const n = new Set(s); if (n.has(m.jmap_id)) n.delete(m.jmap_id); else n.add(m.jmap_id); return n; }); }}>
                  <Avatar name={from?.name} email={from?.email} src={m.avatar_url} />
                  <div className="who">
                    <div className="name"><span className="truncate">{addrName(from)}</span>{isDraft && <Badge kind="warning">Draft</Badge>}{m.from_email === account?.email?.toLowerCase() && <Badge>me</Badge>}{!open && m.has_attachment && <Paperclip size={13} className="faint" />}</div>
                    {open ? <Menu width={360} trigger={(o) => <div className="to" onClick={(e) => { e.stopPropagation(); o(); }} style={{ cursor: 'pointer' }}>to {m.to_addr.map(addrName).join(', ') || '—'}{m.cc_addr?.length ? `, cc ${m.cc_addr.map(addrName).join(', ')}` : ''} <ChevronDown size={12} /></div>}>
                      {() => <div style={{ padding: 8 }}><table className="details-table"><tbody>
                        <tr><td>from</td><td>{addrFull(from)}</td></tr>
                        <tr><td>to</td><td>{m.to_addr.map(addrFull).join(', ')}</td></tr>
                        {m.cc_addr?.length > 0 && <tr><td>cc</td><td>{m.cc_addr.map(addrFull).join(', ')}</td></tr>}
                        {m.bcc_addr?.length > 0 && <tr><td>bcc</td><td>{m.bcc_addr.map(addrFull).join(', ')}</td></tr>}
                        <tr><td>date</td><td>{fmtDateTime(m.received_at)}</td></tr>
                        {m.message_id?.[0] && <tr><td>message-id</td><td className="mono small">{m.message_id[0]}</td></tr>}
                        <tr><td>size</td><td>{fmtBytes(m.size)}</td></tr>
                        {m.blob_id && <tr><td>raw</td><td><a href={`/api/mail/blob/${accountId}/${m.blob_id}?name=message.eml&type=message/rfc822&download=1`}>Download .eml</a></td></tr>}
                      </tbody></table></div>}
                    </Menu> : <div className="snippet">{m.preview}</div>}
                  </div>
                  <div className="when" title={fmtDateTime(m.received_at)}>{fmtDate(m.received_at, { always: false })} · {fmtRelative(m.received_at)}</div>
                  {open && <div className="row" style={{ gap: 0 }} onClick={(e) => e.stopPropagation()}>
                    <IconButton label="Reply" onClick={() => reply(m)}><Reply size={16} /></IconButton>
                    <Menu align="right" trigger={(o) => <IconButton label="More" onClick={o}><MoreHorizontal size={16} /></IconButton>}>
                      {(c) => <>
                        <MenuItem icon={<ReplyAll size={15} />} onClick={() => { reply(m, true); c(); }}>Reply all</MenuItem>
                        <MenuItem icon={<Forward size={15} />} onClick={() => { forward(m); c(); }}>Forward</MenuItem>
                        <MenuItem icon={<MailOpen size={15} />} onClick={() => { api.post('/api/mail/actions', { accountId, jmapIds: [m.jmap_id], action: 'unread' }).then(() => { qc.invalidateQueries({ queryKey: ['threads'] }); onBack(); }); c(); }}>Mark unread from here</MenuItem>
                        <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { api.post('/api/mail/actions', { accountId, jmapIds: [m.jmap_id], action: 'trash' }).then(() => qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] })); c(); }}>Delete this message</MenuItem>
                      </>}
                    </Menu>
                  </div>}
                </div>
                {open && (
                  <>
                    <div className="msg-body"><MessageBody html={m.body_html} text={m.body_text} attachments={m.attachments} accountId={accountId} /></div>
                    {m.attachments?.filter((a: any) => !a.cid || a.disposition === 'attachment').length > 0 && (
                      <div className="attachments">
                        {m.attachments.filter((a: any) => !a.cid || a.disposition === 'attachment').map((a: any, i: number) => {
                          const url = `/api/mail/blob/${accountId}/${encodeURIComponent(a.blobId)}?name=${encodeURIComponent(a.name ?? 'attachment')}&type=${encodeURIComponent(a.type ?? '')}`;
                          const isImg = /^image\/(png|jpe?g|gif|webp)/.test(a.type ?? '');
                          return <a key={i} className="attachment" href={`${url}&download=1`} title={a.name}>{isImg ? <img src={url} alt="" /> : <Paperclip size={15} className="faint" />}<span className="col" style={{ gap: 0, minWidth: 0 }}><span className="a-name">{a.name ?? 'attachment'}</span><span className="a-size">{fmtBytes(a.size)}</span></span><Download size={14} className="faint" /></a>;
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {(data?.drafts ?? []).filter((d: any) => d.source === 'ai').map((d: any) => <SuggestedReply key={d.id} draft={d} accountId={accountId} threadId={threadId} />)}
          {data?.aiPending > 0 && <div className="card mb-16" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}><div className="row small"><Spinner size={14} /> An AI responder is writing a reply to this thread…</div></div>}
          <div className="reply-bar">
            <Button icon={<Reply size={15} />} onClick={() => reply(last)}>Reply</Button>
            <Button icon={<ReplyAll size={15} />} onClick={() => reply(last, true)}>Reply all</Button>
            <Button icon={<Forward size={15} />} onClick={() => forward(last)}>Forward</Button>
          </div>
        </div>
        <div className="context">
          <ContextCard data={data} accountId={accountId} onOpenContact={(id) => nav(`/contacts/${id}`)} />
        </div>
      </div>
      <Modal open={snoozeOpen} onClose={() => setSnoozeOpen(false)} title="Snooze until" footer={<><Button onClick={() => setSnoozeOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setSnoozeOpen(false); void act('snooze', { until: new Date(snoozeAt).toISOString() }, { back: true, msg: 'Snoozed' }); }}>Snooze</Button></>}>
        <Field label="Return to inbox at"><Input type="datetime-local" value={snoozeAt} onChange={(e) => setSnoozeAt(e.target.value)} /></Field>
        <div className="row wrap gap-4">{[['Later today', 3], ['Tomorrow', 24], ['In 3 days', 72], ['Next week', 168]].map(([l, h]) => <Button key={String(l)} size="sm" onClick={() => { const d = new Date(Date.now() + Number(h) * 3600_000); if (Number(h) >= 24) d.setHours(9, 0, 0, 0); setSnoozeAt(localDateTimeValue(d)); }}>{l}</Button>)}</div>
      </Modal>
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


// A reply an AI responder prepared. Open it in the composer to edit, send it
// as it is, or discard it.
function SuggestedReply({ draft, accountId, threadId }: { draft: any; accountId: number; threadId: string }) {
  const compose = useCompose();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['thread', accountId, threadId] }); qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); };
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
      <div className="row mb-8"><Bot size={15} /><span className="strong small">Suggested reply{draft.responder_name ? ` · ${draft.responder_name}` : ''}</span><span className="small faint">{fmtRelative(draft.created_at)}</span><span className="ml-auto small muted">to {(draft.to_addr ?? []).map((a: any) => a.email).join(', ')}</span></div>
      <div className="strong small mb-8">{draft.subject}</div>
      <div className="msg-text" style={{ fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: String(draft.body_html).split('<div class="tern-quote"')[0] }} />
      <div className="row mt-16 gap-4">
        <Button size="sm" variant="primary" icon={<Send size={13} />} loading={busy} onClick={sendNow}>Send</Button>
        <Button size="sm" icon={<Pencil size={13} />} onClick={() => compose.open({ draftId: draft.id, accountId, kind: 'reply', to: draft.to_addr, cc: draft.cc_addr, bcc: draft.bcc_addr, subject: draft.subject, html: draft.body_html, replyToEmailId: draft.reply_to_email_id, threadKey: `${accountId}:${threadId}` })}>Edit</Button>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={discard}>Discard</Button>
      </div>
    </div>
  );
}
