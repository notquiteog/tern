import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Archive, ChevronDown, ChevronLeft, ChevronRight, Inbox as InboxIcon, MailOpen, Mail, Paperclip, RefreshCw, ShieldAlert, Star, Tag, Trash2, Columns2, Rows3, PanelBottom, Clock, Play, X, FileText, Pencil, Reply, Forward, ExternalLink, Lock, BellOff, Bell, Eraser, Sparkles, Receipt, BellRing, Tag as TagIcon, BadgeCheck, LayoutGrid, List as ListIcon, ShieldCheck, Layers } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useCompose, seedFromDraft } from '../state/compose';
import { useMailPrefs, type Layout } from '../state/mailPrefs';
import { useAccountFilter, useAccounts, useMailboxes } from '../lib/queries';
import { useHotkeys, useMediaQuery } from '../lib/hooks';
import { Avatar, Button, Empty, IconButton, Menu, MenuItem, Modal, Spinner, Field, Input, Segmented, Confirm } from '../components/ui';
import { createPortal } from 'react-dom';
import { ThreadView } from '../components/ThreadView';
import { DataTable } from '../components/DataTable';
import { addrName, cls, fmtDate, fmtDateTime, localDateTimeValue, type Addr } from '../lib/format';
import { setMood } from '../lib/ambient';

interface ThreadRow { key: string; account_id: number; thread_id: string; last_at: string; n: number; unread: boolean; starred: boolean; has_attachment: boolean; has_draft: boolean; muted?: boolean; attachments?: string[] | null; category?: Category; verified?: boolean; bulk?: boolean; latest: { id: number; jmap_id: string; subject: string; preview: string; from: Addr[]; to: Addr[]; received_at: string }; participants: Addr[] | null; mailbox_ids: string[]; snoozed_until: string | null; contact_id: number | null; avatar_url?: string | null }
interface Undo { accountId: number; items: { jmapId: string; mailboxIds: string[] }[] }

const BOX_TITLES: Record<string, string> = { inbox: 'Inbox', burner: 'Burner address', starred: 'Starred', snoozed: 'Snoozed', sent: 'Sent', drafts: 'Drafts', scheduled: 'Scheduled', archive: 'Archive', junk: 'Junk', trash: 'Trash', all: 'All mail', unread: 'Unread', attachments: 'Attachments' };

// The four smart categories, in the order they are shown. `primary` is the
// default view of the inbox; the other three are where automated mail goes.
export type Category = 'primary' | 'transactions' | 'updates' | 'promotions';
const CATEGORY_TABS: { key: Category; label: string; icon: ReactNode; hint: string }[] = [
  { key: 'primary', label: 'Primary', icon: <InboxIcon size={14} />, hint: 'People writing to you' },
  { key: 'transactions', label: 'Transactions', icon: <Receipt size={14} />, hint: 'Receipts, orders and invoices' },
  { key: 'updates', label: 'Updates', icon: <BellRing size={14} />, hint: 'Notifications, alerts and lists' },
  { key: 'promotions', label: 'Promotions', icon: <TagIcon size={14} />, hint: 'Offers and marketing' },
];

// "Today", "Yesterday", "This week", then months: the separators between rows.
export function dateGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  if (days <= dow) return 'This week';
  if (days <= dow + 7) return 'Last week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'This month';
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

// Who a conversation is "from", for stacking. Threads with no sender never
// stack: an empty key would fold unrelated rows together.
function senderKey(t: ThreadRow): string {
  return String(t.latest?.from?.[0]?.email ?? '').toLowerCase();
}

export default function MailPage() {
  const { box = 'inbox', threadKey } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const filter = params.get('f') ?? '';
  const cat = (params.get('cat') ?? 'primary') as Category;
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
  const tall = useMediaQuery('(min-width: 900px)');
  const [prefs, setPrefs] = useMailPrefs();
  const layout: Layout = prefs.layout === 'right' && !wide ? (tall ? 'bottom' : 'off') : prefs.layout === 'bottom' && !tall ? 'off' : prefs.layout;
  const split = layout !== 'off';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [snoozeFor, setSnoozeFor] = useState<ThreadRow[] | null>(null);
  const [snoozeAt, setSnoozeAt] = useState('');
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [openStacks, setOpenStacks] = useState<Set<string>>(new Set());

  const accountsParam = acctFilter === 'all' ? 'all' : acctFilter;
  const enabled = box !== 'scheduled' && box !== 'drafts-local';
  // Tabs only narrow the inbox, only when they have been turned on, and never
  // during a search — which looks across every category rather than inside
  // the tab you happen to be on. Off, this is one inbox and one list.
  const tabbed = prefs.categories && box === 'inbox' && !q;
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['threads', box, accountsParam, q, page, filter, tabbed ? cat : ''],
    queryFn: () => api.get<{ threads: ThreadRow[]; total: number; pageSize: number; counts: Record<string, { n: number; unread: number }> | null }>(`/api/mail/threads?box=${encodeURIComponent(box)}&accounts=${accountsParam}&q=${encodeURIComponent(q)}&page=${page}&f=${filter}${tabbed ? `&cat=${cat}` : ''}`),
    enabled,
    placeholderData: (prev) => prev,
  });
  const threads = data?.threads ?? [];
  const counts = data?.counts ?? null;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  // One-line summaries for the conversations on this page. Cached ones come
  // back at once; a few missing ones are written per request, so the list
  // fills in over a few passes rather than queueing fifty generations.
  const summaryKeys = prefs.summaries ? threads.map((t) => t.key) : [];
  // How many rows had an answer last time we looked. A round that settles
  // nothing new means the model is unreachable or refusing, and asking again
  // every four seconds would keep a local model busy for the rest of the
  // session; two such rounds and the polling stops.
  const summaryProgress = useRef({ settled: -1, idle: 0 });
  const { data: summaryData } = useQuery({
    queryKey: ['summaries', summaryKeys.join(',')],
    queryFn: () => api.post<{ summaries: Record<string, string>; enabled: boolean }>('/api/ai/summaries', { keys: summaryKeys, generate: true }),
    enabled: summaryKeys.length > 0,
    refetchInterval: (q) => {
      const got = q.state.data?.summaries;
      if (q.state.data && !q.state.data.enabled) return false;
      if (!got) return 4000;
      // A key present with an empty string is a conversation the model
      // declined to summarise. That is an answer, not a gap: asking again
      // would only get the same nothing.
      const settled = summaryKeys.filter((k) => got[k] !== undefined).length;
      const p = summaryProgress.current;
      p.idle = settled > p.settled ? 0 : p.idle + 1;
      p.settled = settled;
      if (settled >= summaryKeys.length) return false;
      return p.idle >= 2 ? false : 4000;
    },
    staleTime: 60_000,
  });
  const summaries = summaryData?.summaries ?? {};

  const mailboxName = box.startsWith('mailbox:') ? mailboxes.find((m) => `mailbox:${m.account_id}:${m.jmap_id}` === box)?.name ?? 'Label' : BOX_TITLES[box] ?? box;
  const roleOf = useMemo(() => new Map(mailboxes.map((m) => [`${m.account_id}:${m.jmap_id}`, m])), [mailboxes]);

  useEffect(() => { setSelected(new Set()); setFocus(0); setOpenStacks(new Set()); summaryProgress.current = { settled: -1, idle: 0 }; }, [box, q, page, accountsParam, filter, cat]);
  // The background picks up the mood of whatever is being read. Only while
  // the tabs are actually in use; otherwise the inbox is one thing and the
  // colour behind it should not keep changing.
  useEffect(() => { setMood(tabbed ? cat : 'neutral'); return () => setMood('neutral'); }, [tabbed, cat]);
  useEffect(() => { if (!ctx) return; const close = () => setCtx(null); window.addEventListener('click', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', close); return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', close); }; }, [ctx]);
  useEffect(() => { if (threadKey) { const i = threads.findIndex((t) => t.key === threadKey); if (i >= 0) setFocus(i); } }, [threadKey, threads]);

  const qs = () => { const p = new URLSearchParams(); if (q) p.set('q', q); if (filter) p.set('f', filter); const s = p.toString(); return s ? `?${s}` : ''; };
  function openThread(t: ThreadRow) { nav(`/mail/${box}/t/${encodeURIComponent(t.key)}${qs()}`); }
  function back() { nav(`/mail/${box}${qs()}`); }
  function setFilter(f: string) { setParams((p) => { if (f) p.set('f', f); else p.delete('f'); p.delete('page'); return p; }); }
  function setCat(c: Category) { setParams((p) => { if (c === 'primary') p.delete('cat'); else p.set('cat', c); p.delete('page'); return p; }); }

  async function act(action: string, rows: ThreadRow[], extra: Record<string, unknown> = {}, msg?: string) {
    if (!rows.length) return;
    const byAccount = new Map<number, string[]>();
    for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.thread_id]);
    // Optimistic: drop rows that leave this view.
    const leaving = ['archive', 'trash', 'spam', 'delete', 'snooze', 'inbox', 'move', 'mute'].includes(action) && !['all', 'starred'].includes(box) && !(action === 'inbox' && box === 'inbox');
    if (leaving) qc.setQueryData(['threads', box, accountsParam, q, page, filter], (old: any) => old ? { ...old, threads: old.threads.filter((t: ThreadRow) => !rows.some((r) => r.key === t.key)), total: Math.max(0, old.total - rows.length) } : old);
    try {
      const undos: Undo[] = [];
      for (const [accountId, threadIds] of byAccount) { const r = await api.post<{ undo: Undo | null }>('/api/mail/actions', { accountId, threadIds, action, ...extra }); if (r.undo?.items.length) undos.push(r.undo); }
      if (msg) {
        const label = rows.length > 1 ? `${rows.length} conversations ${msg}` : msg[0].toUpperCase() + msg.slice(1);
        if (undos.length) toast.toast(label, { action: { label: 'Undo', onClick: async () => { try { for (const u of undos) await api.post('/api/mail/actions', { accountId: u.accountId, action: 'restore', items: u.items }); toast.success('Restored'); } catch (e) { toast.error(e); } qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); } } });
        else toast.success(label);
      }
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['counts'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['threads'] }), 800);
    } catch (e) { toast.error(e); qc.invalidateQueries({ queryKey: ['threads'] }); }
  }
  async function emptyBox() {
    try {
      const r = await api.post<{ count: number }>('/api/mail/empty', { box: box === 'trash' ? 'trash' : 'junk', ...(acctFilter !== 'all' ? { accountId: Number(acctFilter) } : {}) });
      toast.success(`${r.count} message${r.count === 1 ? '' : 's'} deleted for good`);
      qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] });
    } catch (e) { toast.error(e); }
  }
  const selectedRows = threads.filter((t) => selected.has(t.key));
  const focused = threads[focus];
  const targets = selectedRows.length ? selectedRows : focused ? [focused] : [];
  const currentIndex = threadKey ? threads.findIndex((t) => t.key === threadKey) : -1;
  const goPrev = () => { if (currentIndex > 0) openThread(threads[currentIndex - 1]); };
  const goNext = () => { if (currentIndex >= 0 && currentIndex < threads.length - 1) openThread(threads[currentIndex + 1]); };

  useHotkeys({
    j: () => { if (threadKey) goNext(); else setFocus((f) => Math.min(threads.length - 1, f + 1)); }, k: () => { if (threadKey) goPrev(); else setFocus((f) => Math.max(0, f - 1)); },
    o: () => focused && openThread(focused), Enter: () => focused && openThread(focused),
    x: () => focused && setSelected((s) => { const n = new Set(s); if (n.has(focused.key)) n.delete(focused.key); else n.add(focused.key); return n; }),
    e: () => !threadKey && void act('archive', targets, {}, 'archived'), '#': () => !threadKey && void act('trash', targets, {}, 'moved to trash'), '!': () => !threadKey && void act('spam', targets, {}, 'marked as junk'),
    s: () => !threadKey && void act(targets.every((t) => t.starred) ? 'unstar' : 'star', targets),
    'I': () => !threadKey && void act('read', targets), 'U': () => !threadKey && void act('unread', targets),
    b: () => { if (!threadKey && targets.length) { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor(targets); } },
    'mod+a': () => setSelected(new Set(threads.map((t) => t.key))),
    'Escape': () => { if (!threadKey && selected.size) setSelected(new Set()); },
  }, [threads, focus, selected, threadKey, box, currentIndex]);

  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.thread-row.focused')?.scrollIntoView({ block: 'nearest' }); }, [focus]);

  if (box === 'scheduled') return <ScheduledPage />;
  if (box === 'drafts') return <DraftsPage box={box} listQuery={{ threads, total, isLoading }} />;

  const showList = !threadKey || split;
  const showThread = Boolean(threadKey);
  const [accIdStr, threadId] = threadKey ? decodeURIComponent(threadKey).split(':') : ['', ''];
  const allSelected = threads.length > 0 && selected.size === threads.length;
  const pageStart = (page - 1) * pageSize + 1;
  const canEmpty = (box === 'trash' || box === 'junk') && threads.length > 0;

  // Rows with a date separator whenever the group changes.
  const grouped: { sep?: string; row: ThreadRow; index: number }[] = [];
  let lastGroup = '';
  threads.forEach((t, i) => { const g = box === 'snoozed' ? '' : dateGroup(t.last_at); grouped.push({ sep: g && g !== lastGroup ? g : undefined, row: t, index: i }); if (g) lastGroup = g; });
  // A run of messages from one sender reads as one thing — six receipts from
  // the same shop, a week of alerts from one service — so consecutive rows
  // from the same address fold into a stack that opens. Only ever within one
  // date group, and never across the separator that starts a new one.
  const stacks: { sep?: string; rows: ThreadRow[]; indices: number[] }[] = [];
  for (const item of grouped) {
    const head = stacks[stacks.length - 1];
    const sender = senderKey(item.row);
    if (prefs.digest && head && !item.sep && sender && senderKey(head.rows[0]) === sender && head.rows.length < 12) {
      head.rows.push(item.row); head.indices.push(item.index);
    } else {
      stacks.push({ sep: item.sep, rows: [item.row], indices: [item.index] });
    }
  }

  return (
    <div className="mail">
      <div className="mail-toolbar">
        {showList && <>
          <span className="select-all">
            <input type="checkbox" className="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(threads.map((t) => t.key)) : new Set())} aria-label="Select all" />
            <Menu width={160} trigger={(open) => <button type="button" className="select-caret" aria-label="Select…" onClick={open}><ChevronDown size={13} /></button>}>
              {(c) => <>
                {([['All', () => threads], ['None', () => []], ['Read', () => threads.filter((t) => !t.unread)], ['Unread', () => threads.filter((t) => t.unread)], ['Starred', () => threads.filter((t) => t.starred)], ['Unstarred', () => threads.filter((t) => !t.starred)]] as [string, () => ThreadRow[]][]).map(([l, f]) => <MenuItem key={l} onClick={() => { setSelected(new Set(f().map((t) => t.key))); c(); }}>{l}</MenuItem>)}
              </>}
            </Menu>
          </span>
          {selected.size > 0 ? (
            <>
              <span className="small muted" style={{ marginRight: 6 }}>{selected.size} selected</span>
              {box !== 'archive' && box !== 'trash' && <IconButton label="Archive (e)" onClick={() => act('archive', selectedRows, {}, 'archived')}><Archive size={17} /></IconButton>}
              {(box === 'archive' || box === 'trash' || box === 'junk' || box === 'all') && <IconButton label="Move to inbox" onClick={() => act('inbox', selectedRows, {}, 'moved to inbox')}><InboxIcon size={17} /></IconButton>}
              <IconButton label="Delete (#)" onClick={() => act('trash', selectedRows, {}, 'moved to trash')}><Trash2 size={17} /></IconButton>
              <IconButton label="Mark as junk (!)" onClick={() => act('spam', selectedRows, {}, 'marked as junk')}><ShieldAlert size={17} /></IconButton>
              <span className="sep" />
              <IconButton label="Mark read (Shift+I)" onClick={() => act('read', selectedRows)}><MailOpen size={17} /></IconButton>
              <IconButton label="Mark unread (Shift+U)" onClick={() => act('unread', selectedRows)}><Mail size={17} /></IconButton>
              <IconButton label="Snooze (b)" onClick={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor(selectedRows); }}><AlarmClock size={17} /></IconButton>
              <IconButton label="Star (s)" onClick={() => act(selectedRows.every((t) => t.starred) ? 'unstar' : 'star', selectedRows)}><Star size={17} /></IconButton>
              <Menu width={240} trigger={(open) => <IconButton label="Label" onClick={open}><Tag size={17} /></IconButton>}>
                {(c) => <>{[...new Set(selectedRows.map((r) => r.account_id))].map((accId) => <div key={accId}>{accounts.length > 1 && <div className="menu-label">{accounts.find((a) => a.id === accId)?.email}</div>}{mailboxes.filter((m) => m.account_id === accId && !m.role).map((m) => <MenuItem key={m.jmap_id} icon={<Tag size={14} style={{ color: m.color ?? undefined }} />} onClick={() => { void act('label', selectedRows.filter((r) => r.account_id === accId), { mailboxId: m.jmap_id }, `labeled ${m.name}`); c(); }}>{m.name}</MenuItem>)}</div>)}</>}
              </Menu>
              <IconButton label="Mute" onClick={() => act('mute', selectedRows, {}, 'muted')}><BellOff size={17} /></IconButton>
            </>
          ) : (
            <>
              <IconButton label="Refresh" onClick={() => { refetch(); accounts.forEach((a) => api.post(`/api/accounts/${a.id}/resync`).catch(() => {})); }}><RefreshCw size={16} className={isFetching ? 'spin' : ''} /></IconButton>
              <span className="strong" style={{ marginLeft: 4 }}>{q ? `Search: ${q}` : mailboxName}</span>
              {q && <IconButton label="Clear search" onClick={() => setParams({})}><X size={14} /></IconButton>}
              {canEmpty && <Button size="sm" variant="ghost" icon={<Eraser size={14} />} onClick={() => setEmptyOpen(true)} className="desktop-only">Empty {box} now</Button>}
            </>
          )}
          <div className="pager">
            {total > 0 && <span className="desktop-only">{pageStart}–{Math.min(total, page * pageSize)} of {total}</span>}
            <IconButton label="Previous page" disabled={page <= 1} onClick={() => setParams((p) => { p.set('page', String(page - 1)); return p; })}><ChevronLeft size={16} /></IconButton>
            <IconButton label="Next page" disabled={page * pageSize >= total} onClick={() => setParams((p) => { p.set('page', String(page + 1)); return p; })}><ChevronRight size={16} /></IconButton>
            <Menu align="right" width={260} trigger={(open) => <IconButton label="View options" onClick={open}>{layout === 'right' ? <Columns2 size={16} /> : layout === 'bottom' ? <PanelBottom size={16} /> : <Rows3 size={16} />}</IconButton>}>
              {(c) => <>
                {tall && <>
                  <div className="menu-label">Reading pane</div>
                  <MenuItem active={prefs.layout === 'right'} icon={<Columns2 size={15} />} onClick={() => { setPrefs({ layout: 'right' }); c(); }}>Beside the list</MenuItem>
                  <MenuItem active={prefs.layout === 'bottom'} icon={<PanelBottom size={15} />} onClick={() => { setPrefs({ layout: 'bottom' }); c(); }}>Below the list</MenuItem>
                  <MenuItem active={prefs.layout === 'off'} icon={<Rows3 size={15} />} onClick={() => { setPrefs({ layout: 'off' }); c(); }}>Off (full width)</MenuItem>
                  <div className="menu-sep" />
                </>}
                <div className="menu-label">Conversations</div>
                <MenuItem active={prefs.view === 'list'} icon={<ListIcon size={15} />} onClick={() => { setPrefs({ view: 'list' }); c(); }}>List</MenuItem>
                <MenuItem active={prefs.view === 'card'} icon={<LayoutGrid size={15} />} onClick={() => { setPrefs({ view: 'card' }); c(); }}>Cards</MenuItem>
                <div className="menu-sep" />
                <div className="menu-label">Inbox</div>
                <MenuItem active={prefs.categories} icon={<Layers size={15} />} onClick={() => { setPrefs({ categories: !prefs.categories }); c(); }}>
                  Smart categories{prefs.categories ? '' : ' (off)'}
                </MenuItem>
                <MenuItem active={prefs.digest} icon={<Layers size={15} />} onClick={() => { setPrefs({ digest: !prefs.digest }); c(); }}>
                  Stack by sender{prefs.digest ? '' : ' (off)'}
                </MenuItem>
                <MenuItem active={prefs.summaries} icon={<Sparkles size={15} />} onClick={() => { setPrefs({ summaries: !prefs.summaries }); c(); }}>
                  AI summaries{prefs.summaries ? '' : ' (off)'}
                </MenuItem>
              </>}
            </Menu>
          </div>
        </>}
        {!showList && showThread && <span className="small muted">{mailboxName}</span>}
      </div>
      <div className={cls('mail-body', split && 'split', layout === 'bottom' && 'split-bottom')}>
        {showList && (
          <div className="thread-list" ref={listRef}>
            {tabbed && accounts.length > 0 && (
              <div className="cat-tabs" role="tablist" aria-label="Categories">
                {CATEGORY_TABS.map((t) => {
                  const c = counts?.[t.key];
                  return (
                    <button key={t.key} type="button" role="tab" aria-selected={cat === t.key} title={t.hint}
                      className={cls('cat-tab', cat === t.key && 'on', Boolean(c?.unread) && 'has-unread')} onClick={() => setCat(t.key)}>
                      <span className="cat-tab-icon">{t.icon}</span>
                      <span className="cat-tab-label">{t.label}</span>
                      {c && c.unread > 0 && <span className="cat-tab-count">{c.unread > 99 ? '99+' : c.unread}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {accounts.length > 0 && !box.startsWith('mailbox:') && (
              <div className="list-filters">
                <Segmented value={filter || 'all'} onChange={(v) => setFilter(v === 'all' ? '' : v)} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'read', label: 'Read' }, { value: 'starred', label: 'Starred' }, { value: 'attachments', label: 'Files' }]} />
                <span className="ml-auto row gap-4">
                  {total > 0 && <span className="small faint">{total} conversation{total === 1 ? '' : 's'}</span>}
                  <IconButton label={prefs.view === 'card' ? 'Switch to the list' : 'Switch to cards'} className="btn-sm"
                    onClick={() => setPrefs({ view: prefs.view === 'card' ? 'list' : 'card' })}>{prefs.view === 'card' ? <ListIcon size={15} /> : <LayoutGrid size={15} />}</IconButton>
                </span>
              </div>
            )}
            {isLoading && <div className="center" style={{ padding: 40 }}><Spinner size={22} /></div>}
            {!isLoading && !threads.length && (
              accounts.length === 0
                ? <Empty title="Connect a mailbox to get started" action={<Button variant="primary" onClick={() => nav('/settings/accounts')}>Add account</Button>}>Tern works with Fastmail, Stalwart or any JMAP server. Add one in Settings and mail starts syncing right away.</Empty>
                : <Empty title={q ? 'No results' : tabbed && cat !== 'primary' ? `Nothing in ${CATEGORY_TABS.find((t) => t.key === cat)?.label ?? cat}` : box === 'inbox' ? 'Inbox zero' : 'Nothing here'}>{q ? 'Try fewer words, or operators like from:, subject:, is:unread, has:attachment, newer_than:7d.' : accounts.some((a) => !a.initial_sync_done) ? 'Your mailbox is still syncing for the first time. Messages appear as they arrive.' : tabbed && cat !== 'primary' ? 'Mail of this kind lands here as it arrives. Everything else is in Primary.' : 'Enjoy the quiet.'}</Empty>
            )}
            {stacks.map(({ sep, rows, indices }) => {
              const headKey = rows[0].key;
              const stacked = rows.length > 1;
              const open = openStacks.has(headKey);
              const shown = stacked && !open ? rows.slice(0, 1) : rows;
              const View = prefs.view === 'card' ? ThreadCardView : ThreadRowView;
              return (
                <div key={headKey} className={cls(stacked && 'digest', stacked && open && 'digest-open')}>
                  {sep && <div className="date-sep">{sep}</div>}
                  {shown.map((t, n) => {
                    const i = indices[n];
                    return (
                      <View key={t.key} t={t} index={i} focused={i === focus} selected={selected.has(t.key)} active={t.key === threadKey} showAccount={accountsParam === 'all' && accounts.length > 1} accountColor={accounts.find((a) => a.id === t.account_id)?.color} myEmail={accounts.find((a) => a.id === t.account_id)?.email ?? ''}
                        onContext={(x, y) => setCtx({ x, y, row: t })}
                        labels={(t.mailbox_ids ?? []).map((id) => roleOf.get(`${t.account_id}:${id}`)).filter((m) => m && !m.role && box !== `mailbox:${t.account_id}:${m.jmap_id}`).map((m) => ({ name: m!.name, color: m!.color }))}
                        dragRows={() => (selected.has(t.key) ? selectedRows : [t])}
                        onOpen={() => openThread(t)} onSelect={() => setSelected((s) => { const n2 = new Set(s); if (n2.has(t.key)) n2.delete(t.key); else n2.add(t.key); return n2; })}
                        onStar={() => act(t.starred ? 'unstar' : 'star', [t])} onArchive={() => act('archive', [t], {}, 'archived')} onTrash={() => act('trash', [t], {}, 'moved to trash')} onRead={() => act(t.unread ? 'read' : 'unread', [t])} onSnooze={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor([t]); }} box={box}
                        onSwipeArchive={() => act('archive', [t], {}, 'archived')} onSwipeTrash={() => act('trash', [t], {}, 'moved to trash')} summary={summaries[t.key]} />
                    );
                  })}
                  {stacked && (
                    <button type="button" className="digest-toggle" onClick={() => setOpenStacks((s) => { const n = new Set(s); if (n.has(headKey)) n.delete(headKey); else n.add(headKey); return n; })}>
                      <Layers size={13} />
                      {open ? 'Show less' : `${rows.length - 1} more from ${addrName(rows[0].latest?.from?.[0]) || 'this sender'}`}
                      <ChevronDown size={13} className={cls('digest-caret', open && 'up')} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {showThread && <div className="thread-pane"><ThreadView key={threadKey} accountId={Number(accIdStr)} threadId={threadId} box={box} onBack={back} onPrev={goPrev} onNext={goNext} hasPrev={currentIndex > 0} hasNext={currentIndex >= 0 && currentIndex < threads.length - 1} /></div>}
        {!showThread && split && <div className="thread-pane center" style={{ color: 'var(--text-3)' }}><div className="col center"><Mail size={28} /><span className="small">Select a conversation</span><span className="tiny faint">j / k to move, Enter to open, c to compose, ? for every shortcut</span></div></div>}
      </div>
      <button className="fab" aria-label="Compose" onClick={() => compose.open({ accountId: acctFilter === 'all' ? null : Number(acctFilter) || null })}><Pencil size={22} /></button>
      {ctx && createPortal(
        <div className="menu ctx-menu" style={{ top: Math.min(ctx.y, window.innerHeight - 460), left: Math.min(ctx.x, window.innerWidth - 240) }} onClick={(e) => e.stopPropagation()}>
          <MenuItem icon={<ExternalLink size={15} />} onClick={() => { openThread(ctx.row); setCtx(null); }}>Open</MenuItem>
          <MenuItem icon={<Reply size={15} />} onClick={() => { nav(`/mail/${box}/t/${encodeURIComponent(ctx.row.key)}?reply=1`); setCtx(null); }}>Reply</MenuItem>
          <MenuItem icon={<Forward size={15} />} onClick={() => { nav(`/mail/${box}/t/${encodeURIComponent(ctx.row.key)}?forward=1`); setCtx(null); }}>Forward</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon={ctx.row.unread ? <MailOpen size={15} /> : <Mail size={15} />} onClick={() => { void act(ctx.row.unread ? 'read' : 'unread', [ctx.row]); setCtx(null); }}>{ctx.row.unread ? 'Mark as read' : 'Mark as unread'}</MenuItem>
          <MenuItem icon={<Star size={15} />} onClick={() => { void act(ctx.row.starred ? 'unstar' : 'star', [ctx.row]); setCtx(null); }}>{ctx.row.starred ? 'Unstar' : 'Star'}</MenuItem>
          <MenuItem icon={<AlarmClock size={15} />} onClick={() => { setSnoozeAt(localDateTimeValue(new Date(Date.now() + 3 * 3600_000))); setSnoozeFor([ctx.row]); setCtx(null); }}>Snooze…</MenuItem>
          <MenuItem icon={ctx.row.muted ? <Bell size={15} /> : <BellOff size={15} />} onClick={() => { void act(ctx.row.muted ? 'unmute' : 'mute', [ctx.row], {}, ctx.row.muted ? 'unmuted' : 'muted'); setCtx(null); }}>{ctx.row.muted ? 'Unmute' : 'Mute'}</MenuItem>
          <div className="menu-sep" />
          {box !== 'archive' && <MenuItem icon={<Archive size={15} />} onClick={() => { void act('archive', [ctx.row], {}, 'archived'); setCtx(null); }}>Archive</MenuItem>}
          {(box === 'archive' || box === 'trash' || box === 'junk' || box === 'all') && <MenuItem icon={<InboxIcon size={15} />} onClick={() => { void act('inbox', [ctx.row], {}, 'moved to inbox'); setCtx(null); }}>Move to inbox</MenuItem>}
          <MenuItem icon={<ShieldAlert size={15} />} onClick={() => { void act('spam', [ctx.row], {}, 'marked as junk'); setCtx(null); }}>Move to junk</MenuItem>
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { void act('trash', [ctx.row], {}, 'moved to trash'); setCtx(null); }}>Delete</MenuItem>
          {mailboxes.some((m) => m.account_id === ctx.row.account_id && !m.role) && <><div className="menu-sep" /><div className="menu-label">Label</div>{mailboxes.filter((m) => m.account_id === ctx.row.account_id && !m.role).slice(0, 6).map((m) => <MenuItem key={m.jmap_id} icon={<Tag size={14} style={{ color: m.color ?? undefined }} />} onClick={() => { void act('label', [ctx.row], { mailboxId: m.jmap_id }, `labeled ${m.name}`); setCtx(null); }}>{m.name}</MenuItem>)}</>}
        </div>, document.body)}
      <Modal open={Boolean(snoozeFor)} onClose={() => setSnoozeFor(null)} title="Snooze until" footer={<><Button onClick={() => setSnoozeFor(null)}>Cancel</Button><Button variant="primary" onClick={() => { const rows = snoozeFor ?? []; setSnoozeFor(null); void act('snooze', rows, { until: new Date(snoozeAt).toISOString() }, `snoozed until ${fmtDateTime(snoozeAt)}`); }}>Snooze</Button></>}>
        <Field label="Return to inbox at"><Input type="datetime-local" value={snoozeAt} onChange={(e) => setSnoozeAt(e.target.value)} /></Field>
        <div className="row wrap gap-4">{[['Later today', 3], ['Tomorrow', 24], ['In 3 days', 72], ['Next week', 168]].map(([l, h]) => <Button key={String(l)} size="sm" onClick={() => { const d = new Date(Date.now() + Number(h) * 3600_000); if (Number(h) >= 24) d.setHours(9, 0, 0, 0); setSnoozeAt(localDateTimeValue(d)); }}>{l}</Button>)}</div>
      </Modal>
      <Confirm open={emptyOpen} onClose={() => setEmptyOpen(false)} danger title={`Empty ${box}?`} message={`Every conversation in ${box} is deleted permanently. This cannot be undone.`} confirmLabel="Delete for good" onConfirm={emptyBox} />
    </div>
  );
}

// Everything both views of a conversation need. They differ in how it is
// drawn, not in what they can do.
interface RowViewProps {
  t: ThreadRow; index: number; focused: boolean; selected: boolean; active: boolean;
  showAccount: boolean; accountColor?: string; myEmail: string;
  labels: { name: string; color: string | null }[];
  dragRows: () => ThreadRow[];
  onOpen: () => void; onSelect: () => void; onStar: () => void; onArchive: () => void;
  onTrash: () => void; onRead: () => void; onSnooze: () => void;
  onContext: (x: number, y: number) => void; box: string;
  onSwipeArchive: () => void; onSwipeTrash: () => void;
  // The AI's one-line summary, when it has been written and the reader asked
  // for summaries at all.
  summary?: string;
}

// A conversation is encrypted when the newest message is a PGP envelope: the
// preview is the armour header, because there is nothing else to show.
function isEncrypted(t: ThreadRow): boolean {
  return /-----BEGIN PGP MESSAGE-----/.test(t.latest?.preview ?? '');
}

// The names on a conversation, "me" for your own addresses, shortened the
// way Gmail shortens a long list.
function threadPeople(t: ThreadRow, myEmail: string): string {
  const people = (t.participants ?? []).filter((p) => p && p.email);
  const names = people.length ? people.map((p) => (p.email.toLowerCase() === myEmail.toLowerCase() ? 'me' : addrName(p))) : t.latest?.to?.length ? ['To: ' + t.latest.to.map(addrName).join(', ')] : ['(unknown)'];
  const uniq = [...new Set(names)];
  return uniq.length > 3 ? `${uniq[0]}, ${uniq[1]} … ${uniq[uniq.length - 1]}` : uniq.join(', ');
}

// Marks about where a message came from rather than what it says: a logo the
// domain published and DMARC vouches for, mail that arrived sealed, and bulk
// mail whose remote images are held back until you ask for them.
function TrustMarks({ t }: { t: ThreadRow }) {
  return (
    <>
      {t.verified && <span className="mark verified" title="Verified brand — this domain publishes a BIMI logo and passes DMARC"><BadgeCheck size={13} /></span>}
      {isEncrypted(t) && <span className="mark encrypted" title="End-to-end encrypted — only your key opens this"><Lock size={11} /></span>}
      {t.bulk && <span className="mark shielded" title="Bulk mail — remote images and tracking pixels are blocked until you allow them"><ShieldCheck size={12} /></span>}
    </>
  );
}

// Swiping a conversation sideways on a touch screen: right archives, left
// deletes. Only touch — a mouse drag is the drag-onto-a-label gesture — and a
// mostly vertical move is the list scrolling, so it is handed back at once.
function useSwipe(onRight: () => void, onLeft: () => void) {
  const [dx, setDx] = useState(0);
  const from = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  // The offset is kept in a ref as well as state: state drives the transform,
  // the ref is what the release reads, so a fast swipe cannot be measured
  // against a value React has not caught up to yet.
  const offset = useRef(0);
  const THRESHOLD = 76;
  const move = (v: number) => { offset.current = v; setDx(v); };
  const end = () => {
    const d = offset.current;
    from.current = null;
    move(0);
    if (Math.abs(d) > THRESHOLD) { fired.current = true; if (d > 0) onRight(); else onLeft(); }
  };
  return {
    dx,
    // A completed swipe must not also count as a tap on the row.
    swallowClick: (e: React.MouseEvent) => { if (fired.current) { fired.current = false; e.preventDefault(); e.stopPropagation(); return true; } return false; },
    handlers: {
      onPointerDown: (e: React.PointerEvent) => { if (e.pointerType === 'touch') from.current = { x: e.clientX, y: e.clientY }; },
      onPointerMove: (e: React.PointerEvent) => {
        const f = from.current; if (!f) return;
        const mx = e.clientX - f.x, my = e.clientY - f.y;
        if (Math.abs(my) > Math.abs(mx)) { from.current = null; move(0); return; }
        move(Math.max(-170, Math.min(170, mx)));
      },
      onPointerUp: end,
      onPointerCancel: () => { from.current = null; move(0); },
    },
  };
}

function ThreadRowView({ t, index, focused, selected, active, showAccount, accountColor, myEmail, labels, dragRows, onOpen, onSelect, onStar, onArchive, onTrash, onRead, onSnooze, onContext, box, onSwipeArchive, onSwipeTrash, summary }: RowViewProps) {
  const swipe = useSwipe(onSwipeArchive, onSwipeTrash);
  const people = (t.participants ?? []).filter((p) => p && p.email);
  const names = people.length ? people.map((p) => (p.email.toLowerCase() === myEmail.toLowerCase() ? 'me' : addrName(p))) : t.latest?.to?.length ? ['To: ' + t.latest.to.map(addrName).join(', ')] : ['(unknown)'];
  const uniq = [...new Set(names)];
  const label = uniq.length > 3 ? `${uniq[0]}, ${uniq[1]} … ${uniq[uniq.length - 1]}` : uniq.join(', ');
  const from = t.latest?.from?.[0];
  const atts = (t.attachments ?? []).filter(Boolean);
  return (
    <div className={cls('swipe-wrap', swipe.dx > 0 && 'to-archive', swipe.dx < 0 && 'to-trash')} {...swipe.handlers}>
      <div className="swipe-behind">
        <span className="swipe-hint left"><Archive size={17} /> Archive</span>
        <span className="swipe-hint right"><Trash2 size={17} /> Delete</span>
      </div>
    <div className={cls('thread-row', t.unread && 'unread', focused && 'focused', selected && 'selected', active && 'active')} style={{ '--i': index, '--swipe-x': `${swipe.dx}px` } as any} onClick={(e) => { if (!swipe.swallowClick(e)) onOpen(); }} onContextMenu={(e) => { e.preventDefault(); onContext(e.clientX, e.clientY); }}
      draggable onDragStart={(e) => { const rows = dragRows(); e.dataTransfer.setData('application/x-tern-threads', JSON.stringify(rows.map((r) => ({ key: r.key, account_id: r.account_id, thread_id: r.thread_id })))); e.dataTransfer.effectAllowed = 'move'; }}>
      {showAccount && <span className="acct-stripe" style={{ background: accountColor }} />}
      <div className="t-check" onClick={(e) => { e.stopPropagation(); onSelect(); }}><input type="checkbox" className="checkbox" checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} aria-label="Select" /></div>
      <div className={cls('t-star', t.starred && 'on')} onClick={(e) => { e.stopPropagation(); onStar(); }} title={t.starred ? 'Unstar' : 'Star'}><Star size={16} fill={t.starred ? 'currentColor' : 'none'} /></div>
      <div className={cls('t-avatar', t.verified && 'is-verified')}>
        <Avatar name={from?.name} email={from?.email} src={t.avatar_url} />
        {t.verified && <span className="verified-tick" title="Verified brand — this domain publishes a BIMI logo and passes DMARC"><BadgeCheck size={12} /></span>}
      </div>
      <div className="t-names" title={label}>{label}{t.n > 1 && <span className="t-count">{t.n}</span>}</div>
      <div className="t-main">
        {labels.length > 0 && <span className="t-labels">{labels.slice(0, 2).map((l) => <span key={l.name} className="t-label" style={l.color ? { background: l.color + '22', color: l.color } : {}}>{l.name}</span>)}</span>}
        {t.has_draft && <span className="t-label" style={{ color: 'var(--danger)' }}>Draft</span>}
        <span className="t-subject">{t.latest?.subject || '(no subject)'}</span>
        <span className="t-marks"><TrustMarks t={t} /></span>
        {summary
          ? <span className="t-snippet gist" title={t.latest?.preview}><Sparkles size={11} /> {summary}</span>
          : <span className="t-snippet">— {isEncrypted(t) || (!t.latest?.preview && t.has_attachment) ? <span className="row gap-4" style={{ display: 'inline-flex' }}><Lock size={11} /> Encrypted message</span> : t.latest?.preview}</span>}
        {atts.length > 0 && <span className="t-atts">{atts.slice(0, 2).map((n) => <span key={n} className="t-att" title={n}><Paperclip size={10} />{n}</span>)}{atts.length > 2 && <span className="t-att">+{atts.length - 2}</span>}</span>}
      </div>
      <div className="t-meta">
        {t.muted && <BellOff size={13} className="faint" />}
        {t.has_attachment && atts.length === 0 && <Paperclip size={14} />}
        {t.snoozed_until && box === 'snoozed' ? <span title={fmtDateTime(t.snoozed_until)}><AlarmClock size={13} /> {fmtDate(t.snoozed_until)}</span> : <span title={fmtDateTime(t.last_at)}>{fmtDate(t.last_at)}</span>}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {box !== 'archive' && box !== 'trash' && <IconButton label="Archive" className="btn-sm" onClick={onArchive}><Archive size={15} /></IconButton>}
        <IconButton label="Delete" className="btn-sm" onClick={onTrash}><Trash2 size={15} /></IconButton>
        <IconButton label={t.unread ? 'Mark read' : 'Mark unread'} className="btn-sm" onClick={onRead}>{t.unread ? <MailOpen size={15} /> : <Mail size={15} />}</IconButton>
        <IconButton label="Snooze" className="btn-sm" onClick={onSnooze}><AlarmClock size={15} /></IconButton>
      </div>
    </div>
    </div>
  );
}

// The card view: the same conversation with room to breathe. Where the list
// is for scanning a hundred rows, this is for reading a dozen — the summary
// line, the people, the labels and the attachments all get their own space.
function ThreadCardView({ t, index, focused, selected, active, showAccount, accountColor, myEmail, labels, dragRows, onOpen, onSelect, onStar, onArchive, onTrash, onRead, onSnooze, onContext, box, onSwipeArchive, onSwipeTrash, summary }: RowViewProps) {
  const swipe = useSwipe(onSwipeArchive, onSwipeTrash);
  const label = threadPeople(t, myEmail);
  const from = t.latest?.from?.[0];
  const atts = (t.attachments ?? []).filter(Boolean);
  const encrypted = isEncrypted(t);
  return (
    <div className={cls('swipe-wrap', swipe.dx > 0 && 'to-archive', swipe.dx < 0 && 'to-trash')} {...swipe.handlers}>
      <div className="swipe-behind">
        <span className="swipe-hint left"><Archive size={17} /> Archive</span>
        <span className="swipe-hint right"><Trash2 size={17} /> Delete</span>
      </div>
      <div className={cls('thread-card', t.unread && 'unread', focused && 'focused', selected && 'selected', active && 'active')}
        style={{ '--i': index, '--swipe-x': `${swipe.dx}px` } as any}
        onClick={(e) => { if (!swipe.swallowClick(e)) onOpen(); }}
        onContextMenu={(e) => { e.preventDefault(); onContext(e.clientX, e.clientY); }}
        draggable onDragStart={(e) => { const rows = dragRows(); e.dataTransfer.setData('application/x-tern-threads', JSON.stringify(rows.map((r) => ({ key: r.key, account_id: r.account_id, thread_id: r.thread_id })))); e.dataTransfer.effectAllowed = 'move'; }}>
        {showAccount && <span className="acct-stripe" style={{ background: accountColor }} />}
        <div className="tc-head">
          <div className={cls('tc-avatar', t.verified && 'is-verified')}>
            <Avatar name={from?.name} email={from?.email} src={t.avatar_url} size="lg" />
            {t.verified && <span className="verified-tick" title="Verified brand — this domain publishes a BIMI logo and passes DMARC"><BadgeCheck size={13} /></span>}
          </div>
          <div className="tc-who">
            <div className="tc-names" title={label}>{label}{t.n > 1 && <span className="t-count">{t.n}</span>}</div>
            <div className="tc-when" title={fmtDateTime(t.last_at)}>{fmtDate(t.last_at)}</div>
          </div>
          <div className="tc-actions" onClick={(e) => e.stopPropagation()}>
            <div className={cls('t-star', t.starred && 'on')} onClick={onStar} title={t.starred ? 'Unstar' : 'Star'}><Star size={16} fill={t.starred ? 'currentColor' : 'none'} /></div>
            <input type="checkbox" className="checkbox" checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} aria-label="Select" />
          </div>
        </div>
        <div className="tc-subject">{t.latest?.subject || '(no subject)'}<span className="t-marks"><TrustMarks t={t} /></span></div>
        {summary && <div className="tc-gist"><Sparkles size={12} /> {summary}</div>}
        <div className="tc-preview">
          {encrypted || (!t.latest?.preview && t.has_attachment)
            ? <span className="row gap-4"><Lock size={12} /> Encrypted message</span>
            : t.latest?.preview}
        </div>
        {(labels.length > 0 || atts.length > 0 || t.has_draft || t.muted || t.snoozed_until) && (
          <div className="tc-foot">
            {t.has_draft && <span className="t-label" style={{ color: 'var(--danger)' }}>Draft</span>}
            {labels.slice(0, 3).map((l) => <span key={l.name} className="t-label" style={l.color ? { background: l.color + '22', color: l.color } : {}}>{l.name}</span>)}
            {atts.slice(0, 3).map((n) => <span key={n} className="t-att" title={n}><Paperclip size={10} />{n}</span>)}
            {atts.length > 3 && <span className="t-att">+{atts.length - 3}</span>}
            {t.muted && <span className="t-att"><BellOff size={11} /> Muted</span>}
            {t.snoozed_until && box === 'snoozed' && <span className="t-att"><AlarmClock size={11} /> {fmtDate(t.snoozed_until)}</span>}
          </div>
        )}
        <div className="tc-hover" onClick={(e) => e.stopPropagation()}>
          {box !== 'archive' && box !== 'trash' && <IconButton label="Archive" className="btn-sm" onClick={onArchive}><Archive size={15} /></IconButton>}
          <IconButton label="Delete" className="btn-sm" onClick={onTrash}><Trash2 size={15} /></IconButton>
          <IconButton label={t.unread ? 'Mark read' : 'Mark unread'} className="btn-sm" onClick={onRead}>{t.unread ? <MailOpen size={15} /> : <Mail size={15} />}</IconButton>
          <IconButton label="Snooze" className="btn-sm" onClick={onSnooze}><AlarmClock size={15} /></IconButton>
        </div>
      </div>
    </div>
  );
}

function ScheduledPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const compose = useCompose();
  const { data: accounts = [] } = useAccounts();
  const { data } = useQuery({ queryKey: ['outbox'], queryFn: () => api.get<{ outbox: any[] }>('/api/mail/outbox'), refetchInterval: 30_000 });
  const rows = data?.outbox ?? [];
  async function cancel(id: number) {
    const r = await api.del<{ cancelled: boolean; draft: any }>(`/api/mail/outbox/${id}`);
    qc.invalidateQueries({ queryKey: ['outbox'] }); qc.invalidateQueries({ queryKey: ['counts'] }); qc.invalidateQueries({ queryKey: ['drafts'] });
    if (r.cancelled && r.draft) toast.toast('Cancelled and kept as a draft', { action: { label: 'Open', onClick: () => compose.open(seedFromDraft(r.draft)) } });
    else toast.success(r.cancelled ? 'Cancelled' : 'Already sent');
  }
  async function now(id: number) { await api.post(`/api/mail/outbox/${id}/now`); qc.invalidateQueries({ queryKey: ['outbox'] }); toast.success('Sending shortly'); }
  return (
    <div className="page">
      <h1 className="mb-16">Scheduled</h1>
      {!rows.length ? <Empty icon={<Clock size={24} />} title="Nothing scheduled">Use "Schedule send" or "Send with a natural delay" in the compose window. Messages in their undo window show here too.</Empty> : (
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
        <div className="mb-24"><DataTable rows={drafts} rowKey={(d) => d.id} cardSize="sm" onRowClick={(d) => compose.open(seedFromDraft(d))} columns={[
          { key: 'to', primary: true, width: 240, cell: (d) => (d.to_addr ?? []).map((a: any) => a.name || a.email).join(', ') || <span className="faint">(no recipients)</span> },
          { key: 'subject', secondary: true, cell: (d) => <>{d.source === 'ai' && <span className="badge badge-accent" style={{ marginRight: 6 }}>AI</span>}{d.subject || <span className="faint">(no subject)</span>}<span className="faint"> — {String(d.body_html ?? '').split('<div class="tern-quote"')[0].replace(/<div class="tern-signature"[\s\S]*$/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}</span>{(d.attachments?.length ?? 0) > 0 && <Paperclip size={12} className="faint" style={{ marginLeft: 6 }} />}</> },
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
