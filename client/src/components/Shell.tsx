import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, ChevronDown, Clock, Contact, FileText, Feather, Home, Inbox, KeyRound, Layers, LogOut, Menu as MenuIcon, Moon, Pencil, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Star, Sun, Tag, Trash2, Users, Workflow, X, ListFilter, Mailbox as MailboxIcon, AlarmClock, Monitor, Keyboard, RefreshCw } from 'lucide-react';
import { useAuth } from '../state/auth';
import { useCompose } from '../state/compose';
import { useToast } from '../state/toast';
import { useHotkeys, useServerEvents } from '../lib/hooks';
import { useAccountFilter, useAccounts, useCounts, useMailboxes, type Mailbox } from '../lib/queries';
import { Avatar, IconButton, Menu, MenuItem, Modal, Kbd, Button, Input } from './ui';
import { ComposeDock } from './Compose';
import { api } from '../api';
import { applyTheme, getTheme, type Theme } from '../state/theme';
import { cls } from '../lib/format';

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const compose = useCompose();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useAccountFilter();
  const { data: accounts = [] } = useAccounts();
  const { data: mailboxes = [] } = useMailboxes();
  const { data: counts } = useCounts();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(new URLSearchParams(loc.search).get('q') ?? '');

  useServerEvents(Boolean(user), (type, data) => {
    if (type === 'account' && data?.status === 'auth_error') toast.error(`Mailbox credentials rejected: ${data.error ?? ''}`);
    if (type === 'review' && data?.count) toast.toast(`${data.count} AI draft${data.count === 1 ? '' : 's'} waiting for review`, { action: { label: 'Review', onClick: () => nav('/review') } });
  });

  useEffect(() => { setSidebarOpen(false); }, [loc.pathname]);
  useEffect(() => { setQ(new URLSearchParams(loc.search).get('q') ?? ''); }, [loc.search]);

  useHotkeys({
    c: () => compose.open({ accountId: filter === 'all' ? null : Number(filter) }),
    '/': () => searchRef.current?.focus(),
    '?': () => setHelp(true),
    'mod+k': () => setPalette(true),
    'g i': () => nav('/mail/inbox'), 'g s': () => nav('/mail/starred'), 'g t': () => nav('/mail/sent'), 'g d': () => nav('/mail/drafts'), 'g a': () => nav('/mail/all'),
    'g c': () => nav('/contacts'), 'g q': () => nav('/sequences'), 'g h': () => nav('/home'), 'g r': () => nav('/review'),
  }, [filter]);

  const visibleAccounts = filter === 'all' ? accounts : accounts.filter((a) => String(a.id) === filter);
  const labels = useMemo(() => mailboxes.filter((m) => !m.role && visibleAccounts.some((a) => a.id === m.account_id)).sort((a, b) => a.name.localeCompare(b.name)), [mailboxes, visibleAccounts]);
  const current = accounts.find((a) => String(a.id) === filter);
  const inboxCount = filter === 'all' ? counts?.inboxUnreadTotal ?? 0 : counts?.inboxUnread?.[filter] ?? 0;

  function cycleTheme() {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next); applyTheme(next);
  }
  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const box = loc.pathname.startsWith('/mail/') ? loc.pathname.split('/')[2] : 'all';
    nav(q.trim() ? `/mail/${box === 'inbox' ? 'all' : box}?q=${encodeURIComponent(q.trim())}` : `/mail/${box}`);
  }
  async function refreshAll() {
    for (const a of visibleAccounts) await api.post(`/api/accounts/${a.id}/resync`).catch(() => {});
    qc.invalidateQueries({ queryKey: ['threads'] });
    toast.toast('Checking for new mail…');
  }

  const box = (r: string) => `/mail/${r}`;
  const navItem = (to: string, icon: ReactNode, label: string, count?: number, hot?: boolean) => (
    <NavLink to={to} className={({ isActive }) => cls('nav-item', isActive && 'active')}>{icon}<span className="truncate">{label}</span>{count ? <span className={cls('count', hot && 'hot')}>{count}</span> : null}</NavLink>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <IconButton label="Menu" className="mobile-only" onClick={() => setSidebarOpen((o) => !o)}>{sidebarOpen ? <X size={20} /> : <MenuIcon size={20} />}</IconButton>
        <NavLink to="/mail/inbox" className="brand"><span className="brand-logo"><Feather size={16} /></span><span className="desktop-only">Tern</span></NavLink>
        <form className="search" onSubmit={submitSearch}>
          <Search size={16} className="faint" />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail" title="Operators: from: to: subject: is:unread is:starred has:attachment label: newer_than:7d older_than:30d before:2026-01-01" />
          {q ? <IconButton label="Clear" size={14} onClick={() => { setQ(''); nav(loc.pathname); }}><X size={14} /></IconButton> : <span className="kbd-hint desktop-only"><Kbd>/</Kbd></span>}
        </form>
        <div className="ml-auto row gap-4">
          {accounts.length > 1 && (
            <Menu align="right" trigger={(open) => <button className="account-pill desktop-only" onClick={open}><span className="swatch" style={{ background: current?.color ?? 'var(--text-3)' }} />{current ? current.email : 'All accounts'}<ChevronDown size={14} className="faint" /></button>}>
              {(close) => <>
                <MenuItem active={filter === 'all'} onClick={() => { setFilter('all'); close(); }} icon={<Layers size={15} />}>All accounts</MenuItem>
                <div className="menu-sep" />
                {accounts.map((a) => <MenuItem key={a.id} active={filter === String(a.id)} onClick={() => { setFilter(String(a.id)); close(); }} icon={<span className="swatch" style={{ width: 10, height: 10, borderRadius: 3, background: a.color, display: 'inline-block' }} />}><span className="truncate">{a.email}</span></MenuItem>)}
              </>}
            </Menu>
          )}
          <IconButton label="Check for new mail" onClick={refreshAll}><RefreshCw size={17} /></IconButton>
          <IconButton label={`Theme: ${theme}`} onClick={cycleTheme}>{theme === 'dark' ? <Moon size={17} /> : theme === 'light' ? <Sun size={17} /> : <Monitor size={17} />}</IconButton>
          <Menu align="right" width={230} trigger={(open) => <button className="btn btn-icon" onClick={open} aria-label="Account menu" style={{ width: 'auto', padding: '0 4px' }}><Avatar name={user!.display_name} email={user!.username} /></button>}>
            {(close) => <>
              <div style={{ padding: '8px 10px 6px' }}><div className="strong">{user!.display_name}</div><div className="small muted">@{user!.username} · {user!.role}</div></div>
              <div className="menu-sep" />
              <MenuItem icon={<Settings size={15} />} onClick={() => { nav('/settings/accounts'); close(); }}>Settings</MenuItem>
              <MenuItem icon={<KeyRound size={15} />} onClick={() => { nav('/settings/security'); close(); }}>Security</MenuItem>
              <MenuItem icon={<Keyboard size={15} />} onClick={() => { setHelp(true); close(); }} shortcut="?">Keyboard shortcuts</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon={<LogOut size={15} />} onClick={() => { void logout(); close(); }}>Sign out</MenuItem>
            </>}
          </Menu>
        </div>
      </header>

      {sidebarOpen && <div className="sidebar-backdrop mobile-only" onClick={() => setSidebarOpen(false)} />}
      <aside className={cls('sidebar', sidebarOpen && 'open')}>
        <div className="sidebar-top"><button className="btn-compose w-full" onClick={() => compose.open({ accountId: filter === 'all' ? null : Number(filter) })}><Pencil size={17} />Compose</button></div>
        <div className="sidebar-scroll">
          {navItem(box('inbox'), <Inbox size={17} />, 'Inbox', inboxCount, true)}
          {navItem(box('starred'), <Star size={17} />, 'Starred')}
          {navItem(box('snoozed'), <AlarmClock size={17} />, 'Snoozed', counts?.snoozed)}
          {navItem(box('sent'), <Send size={17} />, 'Sent')}
          {navItem(box('drafts'), <FileText size={17} />, 'Drafts', counts?.drafts)}
          {navItem(box('scheduled'), <Clock size={17} />, 'Scheduled', counts?.scheduled)}
          {navItem(box('archive'), <Archive size={17} />, 'Archive')}
          {navItem(box('junk'), <ShieldCheck size={17} />, 'Junk')}
          {navItem(box('trash'), <Trash2 size={17} />, 'Trash')}
          {navItem(box('all'), <MailboxIcon size={17} />, 'All mail')}
          <div className="nav-section">
            <div className="nav-section-title">Labels<NewLabel accounts={visibleAccounts} /></div>
            {labels.length === 0 && <div className="small faint" style={{ padding: '2px 10px 6px' }}>No labels yet</div>}
            {labels.map((m) => <LabelLink key={m.id} m={m} count={counts?.labelUnread?.[`${m.account_id}:${m.jmap_id}`]} showAccount={filter === 'all' && accounts.length > 1} accountColor={accounts.find((a) => a.id === m.account_id)?.color} />)}
          </div>
          <div className="nav-section">
            <div className="nav-section-title">Outreach</div>
            {navItem('/home', <Home size={17} />, 'Overview')}
            {navItem('/contacts', <Contact size={17} />, 'Contacts')}
            {navItem('/sequences', <Workflow size={17} />, 'Sequences')}
            {navItem('/templates', <BookOpen size={17} />, 'Templates')}
            {navItem('/review', <Sparkles size={17} />, 'AI review', counts?.review, true)}
            {navItem('/rules', <ListFilter size={17} />, 'Rules')}
          </div>
          <div className="nav-section">
            <div className="nav-section-title">Workspace</div>
            {navItem('/settings/accounts', <Settings size={17} />, 'Settings')}
            {user!.role === 'admin' && navItem('/settings/users', <Users size={17} />, 'Users')}
          </div>
          {accounts.length > 0 && (
            <div className="nav-section">
              <div className="nav-section-title">Accounts</div>
              {accounts.map((a) => (
                <button key={a.id} className={cls('nav-item', filter === String(a.id) && 'active')} onClick={() => setFilter(filter === String(a.id) ? 'all' : String(a.id))} title={a.sync_error ?? a.sync_status}>
                  <span className={cls('sync-dot', a.sync_status)} /><span className="truncate">{a.email}</span>{counts?.inboxUnread?.[a.id] ? <span className="count">{counts.inboxUnread[a.id]}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <main className="main">{children}</main>
      <ComposeDock />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

function LabelLink({ m, count, showAccount, accountColor }: { m: Mailbox; count?: number; showAccount: boolean; accountColor?: string }) {
  return (
    <NavLink to={`/mail/mailbox:${m.account_id}:${m.jmap_id}`} className={({ isActive }) => cls('nav-item', isActive && 'active')} title={m.name}>
      <Tag size={16} style={{ color: m.color ?? undefined }} /><span className="truncate">{m.name}</span>
      {showAccount && <span className="swatch" style={{ background: accountColor }} />}
      {count ? <span className="count">{count}</span> : null}
    </NavLink>
  );
}

function NewLabel({ accounts }: { accounts: { id: number; email: string }[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [acc, setAcc] = useState<number | ''>('');
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => { if (accounts.length && acc === '') setAcc(accounts[0].id); }, [accounts, acc]);
  if (!accounts.length) return null;
  async function create() {
    try {
      await api.post('/api/mail/mailboxes', { accountId: Number(acc), name: name.trim() });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
      setOpen(false); setName('');
      toast.success('Label created');
    } catch (e) { toast.error(e); }
  }
  return (
    <>
      <button className="btn btn-icon btn-sm" title="New label" onClick={() => setOpen(true)}><Plus size={14} /></button>
      <Modal open={open} onClose={() => setOpen(false)} title="New label" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={create}>Create</Button></>}>
        <div className="field"><label>Name</label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Leads, Invoices, Follow up…" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create(); }} /></div>
        {accounts.length > 1 && <div className="field"><label>Account</label><select className="select" value={acc} onChange={(e) => setAcc(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select></div>}
        <div className="help-text">Labels are mailboxes on the mail server, so they show up in every client connected to this account.</div>
      </Modal>
    </>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const compose = useCompose();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const items = useMemo(() => [
    { label: 'Compose new message', hint: 'c', run: () => compose.open() },
    { label: 'Go to Inbox', hint: 'g i', run: () => nav('/mail/inbox') },
    { label: 'Go to Starred', hint: 'g s', run: () => nav('/mail/starred') },
    { label: 'Go to Sent', hint: 'g t', run: () => nav('/mail/sent') },
    { label: 'Go to Drafts', hint: 'g d', run: () => nav('/mail/drafts') },
    { label: 'Go to Snoozed', run: () => nav('/mail/snoozed') },
    { label: 'Go to Scheduled sends', run: () => nav('/mail/scheduled') },
    { label: 'Go to All mail', hint: 'g a', run: () => nav('/mail/all') },
    { label: 'Overview', hint: 'g h', run: () => nav('/home') },
    { label: 'Contacts', hint: 'g c', run: () => nav('/contacts') },
    { label: 'Import contacts from CSV', run: () => nav('/contacts?import=1') },
    { label: 'Sequences', hint: 'g q', run: () => nav('/sequences') },
    { label: 'New sequence', run: () => nav('/sequences?new=1') },
    { label: 'Templates', run: () => nav('/templates') },
    { label: 'AI review queue', hint: 'g r', run: () => nav('/review') },
    { label: 'Inbox rules', run: () => nav('/rules') },
    { label: 'Settings: Accounts', run: () => nav('/settings/accounts') },
    { label: 'Settings: AI assistant', run: () => nav('/settings/ai') },
    { label: 'Settings: Sending policy', run: () => nav('/settings/accounts') },
    { label: 'Settings: Security', run: () => nav('/settings/security') },
    { label: 'Settings: Appearance', run: () => nav('/settings/appearance') },
    { label: 'Toggle dark mode', run: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
  ], [nav, compose]);
  const filtered = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => { setIdx(0); }, [q, open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  if (!open) return null;
  const run = (i: typeof items[number]) => { i.run(); onClose(); };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command or destination…" onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
          if (e.key === 'Enter' && filtered[idx]) run(filtered[idx]);
          if (e.key === 'Escape') onClose();
        }} />
        <div className="palette-list">
          {filtered.map((i, n) => <div key={i.label} className={cls('palette-item', n === idx && 'active')} onMouseEnter={() => setIdx(n)} onClick={() => run(i)}>{i.label}{i.hint && <span className="hint">{i.hint}</span>}</div>)}
          {!filtered.length && <div className="palette-item faint">No matches</div>}
        </div>
      </div>
    </div>
  );
}

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string, string][] = [['c', 'Compose'], ['/', 'Search'], ['⌘/Ctrl K', 'Command palette'], ['j / k', 'Next / previous thread'], ['o or Enter', 'Open thread'], ['u or Esc', 'Back to list'], ['x', 'Select thread'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Mark as junk'], ['s', 'Star'], ['r / a / f', 'Reply / reply all / forward'], ['Shift+I / Shift+U', 'Mark read / unread'], ['b', 'Snooze'], ['l', 'Label'], ['g i', 'Inbox'], ['g s', 'Starred'], ['g t', 'Sent'], ['g d', 'Drafts'], ['g a', 'All mail'], ['g c', 'Contacts'], ['g q', 'Sequences'], ['g h', 'Overview'], ['?', 'This help']];
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="wide">
      <div className="shortcut-grid">{rows.map(([k, v]) => <div key={k}><span>{v}</span><Kbd>{k}</Kbd></div>)}</div>
    </Modal>
  );
}

export function useBoxParam(): string {
  const { box } = useParams();
  return box ?? 'inbox';
}
