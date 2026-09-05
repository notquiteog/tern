import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Archive, ChevronLeft, ChevronRight, Inbox as InboxIcon, MailOpen, Mail, Paperclip, RefreshCw, ShieldAlert, Star, Tag, Trash2, Columns2, Rows3, Clock, Play, X, FileText, Pencil, Reply, Forward, ExternalLink, Lock } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useCompose } from '../state/compose';
import { useAccountFilter, useAccounts, useMailboxes } from '../lib/queries';
import { useHotkeys, useLocalStorage, useMediaQuery } from '../lib/hooks';
import { Avatar, Button, Empty, IconButton, Menu, MenuItem, Modal, Spinner, Field, Input, Segmented } from '../components/ui';
import { createPortal } from 'react-dom';
import { ThreadView } from '../components/ThreadView';
import { DataTable } from '../components/DataTable';
import { addrName, cls, fmtDate, fmtDateTime, localDateTimeValue, type Addr } from '../lib/format';

interface ThreadRow { key: string; account_id: number; thread_id: string; last_at: string; n: number; unread: boolean; starred: boolean; has_attachment: boolean; has_draft: boolean; latest: { id: number; jmap_id: string; subject: string; preview: string; from: Addr[]; to: Addr[]; received_at: string }; participants: Addr[] | null; mailbox_ids: string[]; snoozed_until: string | null; contact_id: number | null; avatar_url?: string | null }

const BOX_TITLES: Record<string, string> = { inbox: 'Inbox', starred: 'Starred', snoozed: 'Snoozed', sent: 'Sent', drafts: 'Drafts', scheduled: 'Scheduled', archive: 'Archive', junk: 'Junk', trash: 'Trash', all: 'All mail', unread: 'Unread', attachments: 'Attachments' };

export default function MailPage() {
  const { box = 'inbox', threadKey } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const filter = params.get('f') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const [ctx, setCtx] = useState<{ x: number; y: number; row: ThreadRow } | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const compose = useCompose();
  const [acctFilter] = useAccountFilter();
  const { data: accounts = [] } = useAccounts();
  const { data: mailboxes = [] } = useMailboxes();
  const wide = useMediaQuery('(min-width: 1180px)');
  const [splitPref] = useLocalStorage('tern.split', true);
  const split = wide && splitPref;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [snoozeFor, setSnoozeFor] = useState<ThreadRow[] | null>(null);
  const [snoozeAt, setSnoozeAt] = useState('');

  const accountsParam = acctFilter === 'all' ? 'all' : acctFilter;
  const enabled = box !== 'scheduled' && box !== 'drafts-local';
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['threads', box, accountsParam, q, page, filter],
    queryFn: () => api.get<{ threads: ThreadRow[]; total: number; pageSize: number }>(`/api/mail/threads?box=${encodeURIComponent(box)}&accounts=${accountsParam}&q=${encodeURIComponent(q)}&page=${page}&f=${filter}`),
    enabled,
    placeholderData: (prev) => prev,
  });
  const threads = data?.threads ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const mailboxName = box.startsWith('mailbox:') ? mailboxes.find((m) => `mailbox:${m.account_id}:${m.jmap_id}` === box)?.name ?? 'Label' : BOX_TITLES[box] ?? box;
  const roleOf = useMemo(() => new Map(mailboxes.map((m) => [`${m.account_id}:${m.jmap_id}`, m])), [mailboxes]);

  useEffect(() => { setSelected(new Set()); setFocus(0); }, [box, q, page, accountsParam, filter]);
  useEffect(() => { if (!ctx) return; const close = () => setCtx(null); window.addEventListener('click', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', close); return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', close); }; }, [ctx]);
  useEffect(() => { if (threadKey) { const i = threads.findIndex((t) => t.key === threadKey); if (i >= 0) setFocus(i); } }, [threadKey, threads]);

  const qs = () => { const p = new URLSearchParams(); if (q) p.set('q', q); if (filter) p.set('f', filter); const s = p.toString(); return s ? `?${s}` : ''; };
  function openThread(t: ThreadRow) { nav(`/mail/${box}/t/${encodeURIComponent(t.key)}${qs()}`); }
  function back() { nav(`/mail/${box}${qs()}`); }
  function setFilter(f: string) { setParams((p) => { if (f) p.set('f', f); else p.delete('f'); p.delete('page'); return p; }); }

  async function act(action: string, rows: ThreadRow[], extra: Record<string, unknown> = {}, msg?: string) {
    if (!rows.length) return;
    const byAccount = new Map<number, string[]>();
    for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.thread_id]);
    // Optimistic: drop rows that leave this view.
    const leaving = ['archive', 'trash', 'spam', 'delete', 'snooze', 'inbox', 'move'].includes(action) && !['all', 'starred'].includes(box);
    if (leaving) qc.setQueryData(['threads', box, accountsParam, q, page, filter], (old: any) => old ? { ...old, threads: old.threads.filter((t: ThreadRow) => !rows.some((r) => r.key === t.key)), total: Math.max(0, old.total - rows.length) } : old);
    try {
      for (const [accountId, threadIds] of byAccount) await api.post('/api/mail/actions', { accountId, threadIds, action, ...extra });
      if (msg) toast.success(msg);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['counts'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['threads'] }), 800);
    } catch (e) { toast.error(e); qc.invalidateQueries({ queryKey: ['threads'] }); }
  }
  const selectedRows = threads.filter((t) => selected.has(t.key));
  const focused = threads[focus];
  const targets = selectedRows.length ? selectedRows : focused ? [focused] : [];

  useHotkeys({
    j: () => setFocus((f) => Math.min(threads.length - 1, f + 1)), k: () => setFocus((f) => Math.max(0, f - 1)),
    o: () => focused && openThread(focused), Enter: () => focused && openThread(focused),
    x: () => focused && setSelected((s) => { const n = new Set(s); if (n.has(focused.key)) n.delete(focused.key); else n.add(focused.key); return n; }),
    e: () => !threadKey && void act('archive', targets, {}, 'Archived'), '#': () => !threadKey && void act('trash', targets, {}, 'Moved to trash'), '!': () => !threadKey && void act('spam', targets, {}, 'Marked as junk'),
    s: () => !threadKey && void act(targets.every((t) => t.starred) ? 'unstar' : 'star', targets),
    'I': () => !threadKey && void act('read', targets), 'U': () => !threadKey && void act('unread', targets),
    b: () => { if (!threadKey && targets.length) { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor(targets); } },
    'mod+a': () => setSelected(new Set(threads.map((t) => t.key))),
  }, [threads, focus, selected, threadKey, box]);

  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.thread-row.focused')?.scrollIntoView({ block: 'nearest' }); }, [focus]);

  if (box === 'scheduled') return <ScheduledPage />;
  if (box === 'drafts') return <DraftsPage box={box} listQuery={{ threads, total, isLoading }} />;

  const showList = !threadKey || split;
  const showThread = Boolean(threadKey);
  const [accIdStr, threadId] = threadKey ? decodeURIComponent(threadKey).split(':') : ['', ''];
  const allSelected = threads.length > 0 && selected.size === threads.length;
  const pageStart = (page - 1) * pageSize + 1;

  return (
    <div className="mail">
      <div className="mail-toolbar">
        {showList && <>
          <input type="checkbox" className="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(threads.map((t) => t.key)) : new Set())} aria-label="Select all" style={{ marginLeft: 6, marginRight: 8 }} />
          {selected.size > 0 ? (
            <>
              <span className="small muted" style={{ marginRight: 6 }}>{selected.size} selected</span>
              {box !== 'archive' && box !== 'trash' && <IconButton label="Archive" onClick={() => act('archive', selectedRows, {}, 'Archived')}><Archive size={17} /></IconButton>}
              {(box === 'archive' || box === 'trash' || box === 'junk') && <IconButton label="Move to inbox" onClick={() => act('inbox', selectedRows, {}, 'Moved to inbox')}><InboxIcon size={17} /></IconButton>}
              <IconButton label="Delete" onClick={() => act('trash', selectedRows, {}, 'Moved to trash')}><Trash2 size={17} /></IconButton>
              <IconButton label="Mark as junk" onClick={() => act('spam', selectedRows, {}, 'Marked as junk')}><ShieldAlert size={17} /></IconButton>
              <span className="sep" />
              <IconButton label="Mark read" onClick={() => act('read', selectedRows)}><MailOpen size={17} /></IconButton>
              <IconButton label="Mark unread" onClick={() => act('unread', selectedRows)}><Mail size={17} /></IconButton>
              <IconButton label="Snooze" onClick={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor(selectedRows); }}><AlarmClock size={17} /></IconButton>
              <Menu width={240} trigger={(open) => <IconButton label="Label" onClick={open}><Tag size={17} /></IconButton>}>
                {(c) => <>{[...new Set(selectedRows.map((r) => r.account_id))].map((accId) => <div key={accId}>{accounts.length > 1 && <div className="menu-label">{accounts.find((a) => a.id === accId)?.email}</div>}{mailboxes.filter((m) => m.account_id === accId && !m.role).map((m) => <MenuItem key={m.jmap_id} icon={<Tag size={14} />} onClick={() => { void act('label', selectedRows.filter((r) => r.account_id === accId), { mailboxId: m.jmap_id }, `Labeled ${m.name}`); c(); }}>{m.name}</MenuItem>)}</div>)}</>}
              </Menu>
            </>
          ) : (
            <>
              <IconButton label="Refresh" onClick={() => { refetch(); accounts.forEach((a) => api.post(`/api/accounts/${a.id}/resync`).catch(() => {})); }}><RefreshCw size={16} className={isFetching ? 'spin' : ''} /></IconButton>
              <span className="strong" style={{ marginLeft: 4 }}>{q ? `Search: ${q}` : mailboxName}</span>
              {q && <IconButton label="Clear search" onClick={() => setParams({})}><X size={14} /></IconButton>}
            </>
          )}
          <div className="pager">
            {total > 0 && <span className="desktop-only">{pageStart}–{Math.min(total, page * pageSize)} of {total}</span>}
            <IconButton label="Previous page" disabled={page <= 1} onClick={() => setParams((p) => { p.set('page', String(page - 1)); return p; })}><ChevronLeft size={16} /></IconButton>
            <IconButton label="Next page" disabled={page * pageSize >= total} onClick={() => setParams((p) => { p.set('page', String(page + 1)); return p; })}><ChevronRight size={16} /></IconButton>
            {wide && <SplitToggle />}
          </div>
        </>}
        {!showList && showThread && <span className="small muted">{mailboxName}</span>}
      </div>
      <div className={cls('mail-body', split && 'split')}>
        {showList && (
          <div className="thread-list" ref={listRef}>
            {accounts.length > 0 && !box.startsWith('mailbox:') && (
              <div className="list-filters">
                <Segmented value={filter || 'all'} onChange={(v) => setFilter(v === 'all' ? '' : v)} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'read', label: 'Read' }, { value: 'starred', label: 'Starred' }, { value: 'attachments', label: 'Files' }]} />
                {total > 0 && <span className="small faint ml-auto">{total} conversation{total === 1 ? '' : 's'}</span>}
              </div>
            )}
            {isLoading && <div className="center" style={{ padding: 40 }}><Spinner size={22} /></div>}
            {!isLoading && !threads.length && (
              accounts.length === 0
                ? <Empty title="Connect a mailbox to get started" action={<Button variant="primary" onClick={() => nav('/settings/accounts')}>Add account</Button>}>Tern works with Fastmail, Stalwart or any JMAP server. Add one in Settings and mail starts syncing right away.</Empty>
                : <Empty title={q ? 'No results' : box === 'inbox' ? 'Inbox zero' : 'Nothing here'}>{q ? 'Try fewer words, or operators like from:, subject:, is:unread, has:attachment, newer_than:7d.' : accounts.some((a) => !a.initial_sync_done) ? 'Your mailbox is still syncing for the first time. Messages appear as they arrive.' : 'Enjoy the quiet.'}</Empty>
            )}
            {threads.map((t, i) => (
              <ThreadRowView key={t.key} t={t} index={i} focused={i === focus} selected={selected.has(t.key)} active={t.key === threadKey} showAccount={accountsParam === 'all' && accounts.length > 1} accountColor={accounts.find((a) => a.id === t.account_id)?.color} myEmail={accounts.find((a) => a.id === t.account_id)?.email ?? ''}
                onContext={(x, y) => setCtx({ x, y, row: t })}
                labels={(t.mailbox_ids ?? []).map((id) => roleOf.get(`${t.account_id}:${id}`)).filter((m) => m && !m.role && box !== `mailbox:${t.account_id}:${m.jmap_id}`).map((m) => m!.name)}
                onOpen={() => openThread(t)} onSelect={() => setSelected((s) => { const n = new Set(s); if (n.has(t.key)) n.delete(t.key); else n.add(t.key); return n; })}
                onStar={() => act(t.starred ? 'unstar' : 'star', [t])} onArchive={() => act('archive', [t], {}, 'Archived')} onTrash={() => act('trash', [t], {}, 'Moved to trash')} onRead={() => act(t.unread ? 'read' : 'unread', [t])} onSnooze={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor([t]); }} box={box} />
            ))}
          </div>
        )}
        {showThread && <div className="thread-pane"><ThreadView key={threadKey} accountId={Number(accIdStr)} threadId={threadId} box={box} onBack={back} /></div>}
        {!showThread && split && <div className="thread-pane center" style={{ color: 'var(--text-3)' }}><div className="col center"><Mail size={28} /><span className="small">Select a conversation</span></div></div>}
      </div>
      <button className="fab" aria-label="Compose" onClick={() => compose.open({ accountId: acctFilter === 'all' ? null : Number(acctFilter) || null })}><Pencil size={22} /></button>
      {ctx && createPortal(
        <div className="menu ctx-menu" style={{ top: Math.min(ctx.y, window.innerHeight - 420), left: Math.min(ctx.x, window.innerWidth - 240) }} onClick={(e) => e.stopPropagation()}>
          <MenuItem icon={<ExternalLink size={15} />} onClick={() => { openThread(ctx.row); setCtx(null); }}>Open</MenuItem>
          <MenuItem icon={<Reply size={15} />} onClick={() => { nav(`/mail/${box}/t/${encodeURIComponent(ctx.row.key)}?reply=1`); setCtx(null); }}>Reply</MenuItem>
          <MenuItem icon={<Forward size={15} />} onClick={() => { nav(`/mail/${box}/t/${encodeURIComponent(ctx.row.key)}?forward=1`); setCtx(null); }}>Forward</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon={ctx.row.unread ? <MailOpen size={15} /> : <Mail size={15} />} onClick={() => { void act(ctx.row.unread ? 'read' : 'unread', [ctx.row]); setCtx(null); }}>{ctx.row.unread ? 'Mark as read' : 'Mark as unread'}</MenuItem>
          <MenuItem icon={<Star size={15} />} onClick={() => { void act(ctx.row.starred ? 'unstar' : 'star', [ctx.row]); setCtx(null); }}>{ctx.row.starred ? 'Unstar' : 'Star'}</MenuItem>
          <MenuItem icon={<AlarmClock size={15} />} onClick={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor([ctx.row]); setCtx(null); }}>Snooze…</MenuItem>
          <div className="menu-sep" />
          {box !== 'archive' && <MenuItem icon={<Archive size={15} />} onClick={() => { void act('archive', [ctx.row], {}, 'Archived'); setCtx(null); }}>Archive</MenuItem>}
          {(box === 'archive' || box === 'trash' || box === 'junk') && <MenuItem icon={<InboxIcon size={15} />} onClick={() => { void act('inbox', [ctx.row], {}, 'Moved to inbox'); setCtx(null); }}>Move to inbox</MenuItem>}
          <MenuItem icon={<ShieldAlert size={15} />} onClick={() => { void act('spam', [ctx.row], {}, 'Marked as junk'); setCtx(null); }}>Move to junk</MenuItem>
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { void act('trash', [ctx.row], {}, 'Moved to trash'); setCtx(null); }}>Delete</MenuItem>
          {mailboxes.some((m) => m.account_id === ctx.row.account_id && !m.role) && <><div className="menu-sep" /><div className="menu-label">Label</div>{mailboxes.filter((m) => m.account_id === ctx.row.account_id && !m.role).slice(0, 6).map((m) => <MenuItem key={m.jmap_id} icon={<Tag size={14} />} onClick={() => { void act('label', [ctx.row], { mailboxId: m.jmap_id }, `Labeled ${m.name}`); setCtx(null); }}>{m.name}</MenuItem>)}</>}
        </div>, document.body)}
      <Modal open={Boolean(snoozeFor)} onClose={() => setSnoozeFor(null)} title="Snooze until" footer={<><Button onClick={() => setSnoozeFor(null)}>Cancel</Button><Button variant="primary" onClick={() => { const rows = snoozeFor ?? []; setSnoozeFor(null); void act('snooze', rows, { until: new Date(snoozeAt).toISOString() }, 'Snoozed'); }}>Snooze</Button></>}>
        <Field label="Return to inbox at"><Input type="datetime-local" value={snoozeAt} onChange={(e) => setSnoozeAt(e.target.value)} /></Field>
        <div className="row wrap gap-4">{[['Later today', 3], ['Tomorrow', 24], ['In 3 days', 72], ['Next week', 168]].map(([l, h]) => <Button key={String(l)} size="sm" onClick={() => { const d = new Date(Date.now() + Number(h) * 3600_000); if (Number(h) >= 24) d.setHours(9, 0, 0, 0); setSnoozeAt(localDateTimeValue(d)); }}>{l}</Button>)}</div>
      </Modal>
    </div>
  );
}

function SplitToggle() {
  const [split, setSplit] = useLocalStorage('tern.split', true);
  return <IconButton label={split ? 'Switch to full-width list' : 'Switch to split view'} onClick={() => setSplit(!split)}>{split ? <Rows3 size={16} /> : <Columns2 size={16} />}</IconButton>;
}

function ThreadRowView({ t, index, focused, selected, active, showAccount, accountColor, myEmail, labels, onOpen, onSelect, onStar, onArchive, onTrash, onRead, onSnooze, onContext, box }: { t: ThreadRow; index: number; focused: boolean; selected: boolean; active: boolean; showAccount: boolean; accountColor?: string; myEmail: string; labels: string[]; onOpen: () => void; onSelect: () => void; onStar: () => void; onArchive: () => void; onTrash: () => void; onRead: () => void; onSnooze: () => void; onContext: (x: number, y: number) => void; box: string }) {
  const people = (t.participants ?? []).filter((p) => p && p.email);
  const names = people.length ? people.map((p) => (p.email.toLowerCase() === myEmail.toLowerCase() ? 'me' : addrName(p))) : t.latest?.to?.length ? ['To: ' + t.latest.to.map(addrName).join(', ')] : ['(unknown)'];
  const uniq = [...new Set(names)];
  const label = uniq.length > 3 ? `${uniq[0]}, ${uniq[1]} … ${uniq[uniq.length - 1]}` : uniq.join(', ');
  const from = t.latest?.from?.[0];
  return (
    <div className={cls('thread-row', t.unread && 'unread', focused && 'focused', selected && 'selected', active && 'active')} style={{ '--i': index } as any} onClick={onOpen} onContextMenu={(e) => { e.preventDefault(); onContext(e.clientX, e.clientY); }}>
      {showAccount && <span className="acct-stripe" style={{ background: accountColor }} />}
      <div className="t-check" onClick={(e) => { e.stopPropagation(); onSelect(); }}><input type="checkbox" className="checkbox" checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} aria-label="Select" /></div>
      <div className={cls('t-star', t.starred && 'on')} onClick={(e) => { e.stopPropagation(); onStar(); }} title={t.starred ? 'Unstar' : 'Star'}><Star size={16} fill={t.starred ? 'currentColor' : 'none'} /></div>
      <div className="t-avatar"><Avatar name={from?.name} email={from?.email} src={t.avatar_url} /></div>
      <div className="t-names" title={label}>{label}{t.n > 1 && <span className="t-count">{t.n}</span>}</div>
      <div className="t-main">
        {labels.length > 0 && <span className="t-labels">{labels.slice(0, 2).map((l) => <span key={l} className="t-label">{l}</span>)}</span>}
        {t.has_draft && <span className="t-label" style={{ color: 'var(--danger)' }}>Draft</span>}
        <span className="t-subject">{t.latest?.subject || '(no subject)'}</span>
        <span className="t-snippet">— {/-----BEGIN PGP MESSAGE-----/.test(t.latest?.preview ?? '') || (!t.latest?.preview && t.has_attachment) ? <span className="row gap-4" style={{ display: 'inline-flex' }}><Lock size={11} /> Encrypted message</span> : t.latest?.preview}</span>
      </div>
      <div className="t-meta">
        {t.has_attachment && <Paperclip size={14} />}
        {t.snoozed_until && box === 'snoozed' ? <span title={fmtDateTime(t.snoozed_until)}><AlarmClock size={13} /> {fmtDate(t.snoozed_until)}</span> : <span title={fmtDateTime(t.last_at)}>{fmtDate(t.last_at)}</span>}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {box !== 'archive' && box !== 'trash' && <IconButton label="Archive" className="btn-sm" onClick={onArchive}><Archive size={15} /></IconButton>}
        <IconButton label="Delete" className="btn-sm" onClick={onTrash}><Trash2 size={15} /></IconButton>
        <IconButton label={t.unread ? 'Mark read' : 'Mark unread'} className="btn-sm" onClick={onRead}>{t.unread ? <MailOpen size={15} /> : <Mail size={15} />}</IconButton>
        <IconButton label="Snooze" className="btn-sm" onClick={onSnooze}><AlarmClock size={15} /></IconButton>
      </div>
    </div>
  );
}

function ScheduledPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: accounts = [] } = useAccounts();
  const { data } = useQuery({ queryKey: ['outbox'], queryFn: () => api.get<{ outbox: any[] }>('/api/mail/outbox'), refetchInterval: 30_000 });
  const rows = data?.outbox ?? [];
  async function cancel(id: number) { await api.del(`/api/mail/outbox/${id}`); qc.invalidateQueries({ queryKey: ['outbox'] }); qc.invalidateQueries({ queryKey: ['counts'] }); toast.success('Cancelled'); }
  async function now(id: number) { await api.post(`/api/mail/outbox/${id}/now`); qc.invalidateQueries({ queryKey: ['outbox'] }); toast.success('Sending shortly'); }
  return (
    <div className="page">
      <h1 className="mb-16">Scheduled</h1>
      {!rows.length ? <Empty icon={<Clock size={24} />} title="Nothing scheduled">Use "Schedule send" or "Send with a natural delay" in the compose window.</Empty> : (
        <DataTable rows={rows} rowKey={(r) => r.id} minWidth={720} columns={[
          { key: 'to', header: 'To', primary: true, cell: (r) => (r.to_addr ?? []).map((a: any) => a.email ?? a).join(', ') },
          { key: 'subject', header: 'Subject', secondary: true, cell: (r) => r.subject || '(no subject)' },
          { key: 'account', header: 'Account', className: 'small muted', cell: (r) => accounts.find((a) => a.id === r.account_id)?.email },
          { key: 'at', header: 'Sends at', nowrap: true, cell: (r) => <>{fmtDateTime(r.send_at)}{r.humanize === 'true' && <span className="small faint"> + natural delay</span>}</> },
          { key: 'status', header: 'Status', cell: (r) => r.status === 'failed' ? <span className="badge badge-danger" title={r.error}>failed</span> : <span className="badge badge-accent">{r.status}</span> },
          { key: 'act', actions: true, cell: (r) => <><Button size="sm" icon={<Play size={13} />} onClick={() => now(r.id)}>Send now</Button><Button size="sm" variant="ghost" onClick={() => cancel(r.id)}>Cancel</Button></> },
        ]} />
      )}
    </div>
  );
}

function DraftsPage({ box, listQuery }: { box: string; listQuery: { threads: ThreadRow[]; total: number; isLoading: boolean } }) {
  const compose = useCompose();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['drafts'], queryFn: () => api.get<{ drafts: any[] }>('/api/mail/drafts') });
  const drafts = data?.drafts ?? [];
  return (
    <div className="page">
      <h1 className="mb-16">Drafts</h1>
      {drafts.length === 0 && listQuery.threads.length === 0 && !listQuery.isLoading && <Empty icon={<FileText size={24} />} title="No drafts">Anything you start writing is saved here automatically.</Empty>}
      {drafts.length > 0 && <>
        <h4 className="mb-8">Saved in Tern</h4>
        <div className="mb-24"><DataTable rows={drafts} rowKey={(d) => d.id} cardSize="sm" onRowClick={(d) => compose.open({ draftId: d.id, accountId: d.account_id, kind: d.kind, to: d.to_addr, cc: d.cc_addr, bcc: d.bcc_addr, subject: d.subject, html: d.body_html, replyToEmailId: d.reply_to_email_id, threadKey: d.thread_id && d.account_id ? `${d.account_id}:${d.thread_id}` : null, attachments: [] })} columns={[
          { key: 'to', primary: true, width: 240, cell: (d) => (d.to_addr ?? []).map((a: any) => a.name || a.email).join(', ') || <span className="faint">(no recipients)</span> },
          { key: 'subject', secondary: true, cell: (d) => <>{d.subject || <span className="faint">(no subject)</span>}<span className="faint"> — {String(d.body_html ?? '').replace(/<[^>]+>/g, ' ').slice(0, 80)}</span></> },
          { key: 'when', width: 120, className: 'small muted', nowrap: true, cell: (d) => fmtDate(d.updated_at) },
          { key: 'act', actions: true, width: 60, cell: (d) => <IconButton label="Discard" className="btn-sm" onClick={() => api.del(`/api/mail/drafts/${d.id}`).then(() => { qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); })}><Trash2 size={14} /></IconButton> },
        ]} /></div>
      </>}
      {listQuery.threads.length > 0 && <>
        <h4 className="mb-8">On the mail server</h4>
        <DataTable rows={listQuery.threads} rowKey={(t) => t.key} cardSize="sm" onRowClick={(t) => nav(`/mail/${box}/t/${encodeURIComponent(t.key)}`)} columns={[
          { key: 'to', primary: true, width: 240, cell: (t) => t.latest?.to?.map(addrName).join(', ') || <span className="faint">(no recipients)</span> },
          { key: 'subject', secondary: true, cell: (t) => <>{t.latest?.subject || '(no subject)'}<span className="faint"> — {t.latest?.preview}</span></> },
          { key: 'when', width: 120, className: 'small muted', nowrap: true, cell: (t) => fmtDate(t.last_at) },
        ]} />
      </>}
    </div>
  );
}
