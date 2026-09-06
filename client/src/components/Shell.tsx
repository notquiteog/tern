import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrandLogo, useAppName } from './Brand';
import { SW_UPDATED_EVENT } from '../pwa';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, Bot, UserCircle, ChevronDown, Clock, Contact, FileText, Home, Inbox, KeyRound, Layers, LogOut, Menu as MenuIcon, Moon, Pencil, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Star, Sun, Tag, Trash2, Users, Workflow, X, ListFilter, Mailbox as MailboxIcon, AlarmClock, Monitor, Keyboard, RefreshCw, SlidersHorizontal, Paperclip } from 'lucide-react';
import { createPortal } from 'react-dom';
import { adoptServerMailPrefs } from '../state/mailPrefs';
import { buildSearchQuery, EMPTY_SEARCH, parseSearchQuery, type SearchFields } from '../lib/search';
import { useAuth } from '../state/auth';
import { useCompose } from '../state/compose';
import { useToast } from '../state/toast';
import { useHotkeys, useServerEvents } from '../lib/hooks';
import { useAccountFilter, useAccounts, useCounts, useMailboxes, type Mailbox } from '../lib/queries';
import { Avatar, IconButton, Menu, MenuItem, Modal, Kbd, Button, Input, ColorPicker, Confirm } from './ui';
import { ComposeDock } from './Compose';
import { api } from '../api';
import { adoptServerAppearance, getAppearance, setAppearance, onAppearance, type Theme, type Appearance } from '../state/theme';
import { Background } from './Background';
import { PALETTES, BACKGROUNDS } from '../lib/palettes';
import { Palette as PaletteIcon, Check } from 'lucide-react';
import { cls } from '../lib/format';

export function Shell({ children }: { children: ReactNode }) {
  const appName = useAppName();
  const { user, logout } = useAuth();
  const compose = useCompose();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  useEffect(() => {
    const onUpdate = () => toast.toast('A new version is ready.', { action: { label: 'Reload', onClick: () => window.location.reload() }, ttl: 60000 });
    window.addEventListener(SW_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(SW_UPDATED_EVENT, onUpdate);
  }, [toast]);
  const qc = useQueryClient();
  const [filter, setFilter] = useAccountFilter();
  const { data: accounts = [] } = useAccounts();
  const { data: mailboxes = [] } = useMailboxes();
  const { data: counts } = useCounts();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [labelCtx, setLabelCtx] = useState<{ x: number; y: number; m: Mailbox } | null>(null);
  const [labelEdit, setLabelEdit] = useState<Mailbox | null>(null);
  const [labelDelete, setLabelDelete] = useState<Mailbox | null>(null);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { if (!labelCtx) return; const close = () => setLabelCtx(null); window.addEventListener('click', close); window.addEventListener('keydown', close); return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); }; }, [labelCtx]);
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance());
  useEffect(() => onAppearance(setAppearanceState), []);
  useEffect(() => { adoptServerAppearance(user?.prefs); adoptServerMailPrefs(user?.prefs); }, [user]);
  const theme = appearance.theme;
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
  // The tab title carries the unread count, like every mail client.
  useEffect(() => {
    const seg = loc.pathname.split('/').filter(Boolean);
    const boxTitles: Record<string, string> = { inbox: 'Inbox', starred: 'Starred', snoozed: 'Snoozed', sent: 'Sent', drafts: 'Drafts', scheduled: 'Scheduled', archive: 'Archive', junk: 'Junk', trash: 'Trash', all: 'All mail' };
    const sectionTitles: Record<string, string> = { home: 'Overview', contacts: 'Contacts', sequences: 'Sequences', templates: 'Templates', review: 'AI review', responders: 'AI responders', rules: 'Rules', settings: 'Settings' };
    let where = '';
    if (seg[0] === 'mail') { const b = seg[1] ?? 'inbox'; where = b.startsWith('mailbox:') ? (mailboxes.find((m) => `mailbox:${m.account_id}:${m.jmap_id}` === b)?.name ?? 'Label') : boxTitles[b] ?? 'Mail'; }
    else where = sectionTitles[seg[0] ?? ''] ?? '';
    document.title = `${inboxCount ? `(${inboxCount}) ` : ''}${where ? `${where} · ` : ''}${appName}`;
  }, [loc.pathname, inboxCount, appName, mailboxes]);

  // Threads dragged from the list onto a folder or label in the sidebar.
  async function dropThreads(e: React.DragEvent, target: { action: 'inbox' | 'archive' | 'trash' | 'spam' | 'label'; mailbox?: Mailbox }) {
    e.preventDefault();
    let rows: { key: string; account_id: number; thread_id: string }[] = [];
    try { rows = JSON.parse(e.dataTransfer.getData('application/x-tern-threads') || '[]'); } catch { return; }
    if (!rows.length) return;
    const byAccount = new Map<number, string[]>();
    for (const r of rows) { if (target.mailbox && r.account_id !== target.mailbox.account_id) continue; byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.thread_id]); }
    if (!byAccount.size) { toast.error('That label belongs to a different account'); return; }
    try {
      for (const [accountId, threadIds] of byAccount) await api.post('/api/mail/actions', { accountId, threadIds, action: target.action, ...(target.mailbox ? { mailboxId: target.mailbox.jmap_id } : {}) });
      const n = [...byAccount.values()].reduce((a, b) => a + b.length, 0);
      toast.success(`${n} conversation${n === 1 ? '' : 's'} ${target.action === 'label' ? `labeled ${target.mailbox!.name}` : target.action === 'inbox' ? 'moved to inbox' : target.action === 'archive' ? 'archived' : target.action === 'trash' ? 'moved to trash' : 'marked as junk'}`);
      qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] });
    } catch (err) { toast.error(err); }
  }
  const dropProps = (target: { action: 'inbox' | 'archive' | 'trash' | 'spam' | 'label'; mailbox?: Mailbox }) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/x-tern-threads')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; (e.currentTarget as HTMLElement).classList.add('drop-over'); } },
    onDragLeave: (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-over'),
    onDrop: (e: React.DragEvent) => { (e.currentTarget as HTMLElement).classList.remove('drop-over'); void dropThreads(e, target); },
  });

  function setTheme(next: Theme) { setAppearance({ theme: next }); }
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
  const navItem = (to: string, icon: ReactNode, label: string, count?: number, hot?: boolean, drop?: { action: 'inbox' | 'archive' | 'trash' | 'spam' }) => (
    <NavLink to={to} className={({ isActive }) => cls('nav-item', isActive && 'active')} {...(drop ? dropProps(drop) : {})}>{icon}<span className="truncate">{label}</span>{count ? <span className={cls('count', hot && 'hot')}>{count}</span> : null}</NavLink>
  );

  const section = '/' + (loc.pathname.split('/')[1] || '');
  return (
    <div className="shell">
      <Background />
      <header className="topbar">
        <IconButton label="Menu" className="mobile-only" onClick={() => setSidebarOpen((o) => !o)}>{sidebarOpen ? <X size={20} /> : <MenuIcon size={20} />}</IconButton>
        <NavLink to="/mail/inbox" className="brand"><BrandLogo /><span className="desktop-only">{appName}</span></NavLink>
        <form className="search" onSubmit={submitSearch}>
          <Search size={16} className="faint" />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail" title="Operators: from: to: subject: is:unread is:starred has:attachment label: newer_than:7d older_than:30d before:2026-01-01" />
          {q ? <IconButton label="Clear" size={14} onClick={() => { setQ(''); nav(loc.pathname); }}><X size={14} /></IconButton> : <span className="kbd-hint desktop-only"><Kbd>/</Kbd></span>}
          <IconButton label="Search options" size={14} className={cls('btn-sm', advanced && 'active')} onClick={(e) => { e.preventDefault(); setAdvanced((a) => !a); }}><SlidersHorizontal size={14} /></IconButton>
          {advanced && <AdvancedSearch initial={q} onClose={() => setAdvanced(false)} onSearch={(query) => { setAdvanced(false); setQ(query); nav(query ? `/mail/all?q=${encodeURIComponent(query)}` : '/mail/inbox'); }} />}
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
          <Menu align="right" width={300} trigger={(open) => <IconButton label="Appearance" onClick={open}>{theme === 'dark' ? <Moon size={17} /> : theme === 'light' ? <Sun size={17} /> : <Monitor size={17} />}</IconButton>}>
            {(close) => <div style={{ padding: 8 }}>
              <div className="menu-label">Theme</div>
              <div className="segmented w-full mb-8" style={{ display: 'flex' }}>{(['system', 'light', 'dark'] as Theme[]).map((t) => <button key={t} type="button" className={cls(theme === t && 'active')} style={{ flex: 1 }} onClick={() => setTheme(t)}>{t === 'system' ? <Monitor size={14} /> : t === 'light' ? <Sun size={14} /> : <Moon size={14} />} {t}</button>)}</div>
              <div className="menu-label">Palette</div>
              <div className="row wrap gap-4 mb-8" style={{ padding: '2px 4px' }}>{PALETTES.map((p) => <button key={p.key} type="button" title={p.name} className={cls('swatch-dot', appearance.palette === p.key && 'active')} style={{ width: 26, height: 26, borderRadius: '50%', border: appearance.palette === p.key ? '2px solid var(--text)' : '2px solid transparent', background: `linear-gradient(135deg, ${p.gradient[0]}, ${p.gradient[1]})`, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }} onClick={() => setAppearance({ palette: p.key })}>{appearance.palette === p.key && <Check size={13} />}</button>)}</div>
              <div className="menu-label">Background</div>
              <div className="row wrap gap-4 mb-8" style={{ padding: '2px 4px' }}>{BACKGROUNDS.map((b) => <button key={b.key} type="button" className={cls('btn btn-sm', appearance.background === b.key && 'btn-soft')} onClick={() => setAppearance({ background: b.key })}>{b.name}</button>)}</div>
              <div className="menu-sep" />
              <MenuItem icon={<PaletteIcon size={15} />} onClick={() => { nav('/settings/appearance'); close(); }}>All appearance settings</MenuItem>
            </div>}
          </Menu>
          <Menu align="right" width={230} trigger={(open) => <button className="btn btn-icon" onClick={open} aria-label="Account menu" style={{ width: 'auto', padding: '0 4px' }}><Avatar name={user!.display_name} email={user!.username} src={(user as any).avatar_version ? `/api/avatars/user/${user!.id}?v=${(user as any).avatar_version}` : null} /></button>}>
            {(close) => <>
              <div style={{ padding: '8px 10px 6px' }}><div className="strong">{user!.display_name}</div><div className="small muted">@{user!.username} · {user!.role}</div></div>
              <div className="menu-sep" />
              <MenuItem icon={<UserCircle size={15} />} onClick={() => { nav('/settings/profile'); close(); }}>Profile</MenuItem>
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
          {navItem(box('inbox'), <Inbox size={17} />, 'Inbox', inboxCount, true, { action: 'inbox' })}
          {navItem(box('starred'), <Star size={17} />, 'Starred')}
          {navItem(box('snoozed'), <AlarmClock size={17} />, 'Snoozed', counts?.snoozed)}
          {navItem(box('sent'), <Send size={17} />, 'Sent')}
          {navItem(box('drafts'), <FileText size={17} />, 'Drafts', counts?.drafts)}
          {navItem(box('scheduled'), <Clock size={17} />, 'Scheduled', counts?.scheduled)}
          {navItem(box('archive'), <Archive size={17} />, 'Archive', undefined, false, { action: 'archive' })}
          {navItem(box('junk'), <ShieldCheck size={17} />, 'Junk', undefined, false, { action: 'spam' })}
          {navItem(box('trash'), <Trash2 size={17} />, 'Trash', undefined, false, { action: 'trash' })}
          {navItem(box('attachments'), <Paperclip size={17} />, 'Attachments')}
          {navItem(box('all'), <MailboxIcon size={17} />, 'All mail')}
          <div className="nav-section">
            <div className="nav-section-title">Labels<NewLabel accounts={visibleAccounts} /></div>
            {labels.length === 0 && <div className="small faint" style={{ padding: '2px 10px 6px' }}>No labels yet</div>}
            {labels.map((m) => <LabelLink key={m.id} m={m} count={counts?.labelUnread?.[`${m.account_id}:${m.jmap_id}`]} showAccount={filter === 'all' && accounts.length > 1} accountColor={accounts.find((a) => a.id === m.account_id)?.color} onContext={(x, y) => setLabelCtx({ x, y, m })} dropProps={dropProps({ action: 'label', mailbox: m })} />)}
          </div>
          <div className="nav-section">
            <div className="nav-section-title">Outreach</div>
            {navItem('/home', <Home size={17} />, 'Overview')}
            {navItem('/contacts', <Contact size={17} />, 'Contacts')}
            {navItem('/sequences', <Workflow size={17} />, 'Sequences')}
            {navItem('/templates', <BookOpen size={17} />, 'Templates')}
            {navItem('/review', <Sparkles size={17} />, 'AI review', counts?.review, true)}
            {navItem('/responders', <Bot size={17} />, 'AI responders')}
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

      <main className="main" key={section}>{children}</main>
      <nav className="mobile-nav" aria-label="Primary">
        <NavLink to="/mail/inbox" className={({ isActive }) => cls(isActive || loc.pathname.startsWith('/mail/') ? 'active' : '')}><Inbox size={20} />Mail{inboxCount ? <span className="mn-count">{inboxCount > 99 ? '99+' : inboxCount}</span> : null}</NavLink>
        <NavLink to="/contacts"><Contact size={20} />Contacts</NavLink>
        <button type="button" className="mn-compose" aria-label="Compose" onClick={() => compose.open({ accountId: filter === 'all' ? null : Number(filter) })}><span className="pill"><Pencil size={18} /></span></button>
        <NavLink to="/review"><Sparkles size={20} />Review{counts?.review ? <span className="mn-count">{counts.review}</span> : null}</NavLink>
        <NavLink to="/settings"><Settings size={20} />Settings</NavLink>
      </nav>
      <ComposeDock />
      {labelCtx && createPortal(
        <div className="menu ctx-menu" style={{ top: Math.min(labelCtx.y, window.innerHeight - 160), left: Math.min(labelCtx.x, window.innerWidth - 230) }} onClick={(e) => e.stopPropagation()}>
          <div className="menu-label">{labelCtx.m.name}</div>
          <MenuItem icon={<Pencil size={15} />} onClick={() => { setLabelEdit(labelCtx.m); setLabelCtx(null); }}>Rename or recolour</MenuItem>
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { setLabelDelete(labelCtx.m); setLabelCtx(null); }}>Delete label</MenuItem>
        </div>, document.body)}
      {labelEdit && <LabelEdit m={labelEdit} onClose={() => setLabelEdit(null)} />}
      <Confirm open={Boolean(labelDelete)} onClose={() => setLabelDelete(null)} danger title={`Delete label "${labelDelete?.name}"?`} message="Messages keep their other labels and stay in their folders; only the label goes." confirmLabel="Delete" onConfirm={async () => { if (!labelDelete) return; await api.del(`/api/mail/mailboxes/${labelDelete.account_id}/${encodeURIComponent(labelDelete.jmap_id)}`); qc.invalidateQueries({ queryKey: ['mailboxes'] }); qc.invalidateQueries({ queryKey: ['threads'] }); toast.success('Label deleted'); if (loc.pathname.includes(`mailbox:${labelDelete.account_id}:${labelDelete.jmap_id}`)) nav('/mail/inbox'); }} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

function LabelLink({ m, count, showAccount, accountColor, onContext, dropProps }: { m: Mailbox; count?: number; showAccount: boolean; accountColor?: string; onContext: (x: number, y: number) => void; dropProps: Record<string, unknown> }) {
  return (
    <NavLink to={`/mail/mailbox:${m.account_id}:${m.jmap_id}`} className={({ isActive }) => cls('nav-item', isActive && 'active')} title={`${m.name} (right-click to rename, recolour or delete)`} onContextMenu={(e) => { e.preventDefault(); onContext(e.clientX, e.clientY); }} {...dropProps}>
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

function LabelEdit({ m, onClose }: { m: Mailbox; onClose: () => void }) {
  const [name, setName] = useState(m.name);
  const [color, setColor] = useState(m.color ?? '#4f6df5');
  const qc = useQueryClient();
  const toast = useToast();
  async function save() {
    try {
      await api.put(`/api/mail/mailboxes/${m.account_id}/${encodeURIComponent(m.jmap_id)}`, { name: name.trim() !== m.name ? name.trim() : undefined, color });
      qc.invalidateQueries({ queryKey: ['mailboxes'] }); qc.invalidateQueries({ queryKey: ['threads'] });
      toast.success('Label updated'); onClose();
    } catch (e) { toast.error(e); }
  }
  return (
    <Modal open onClose={onClose} title="Edit label" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={save}>Save</Button></>}>
      <div className="field"><label>Name</label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save(); }} /></div>
      <div className="field"><label>Colour</label><ColorPicker value={color} onChange={setColor} /></div>
    </Modal>
  );
}

// Gmail's search options panel: every field maps to an operator the search box understands.
function AdvancedSearch({ initial, onSearch, onClose }: { initial: string; onSearch: (q: string) => void; onClose: () => void }) {
  const [f, setF] = useState<SearchFields>(() => parseSearchQuery(initial));
  const { data: mailboxes = [] } = useMailboxes();
  const set = (patch: Partial<SearchFields>) => setF((x) => ({ ...x, ...patch }));
  const folders = [...new Set(['inbox', 'sent', 'archive', 'junk', 'trash', ...mailboxes.filter((m) => !m.role).map((m) => m.name)])];
  return (
    <div className="adv-search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } if (e.key === 'Enter') { e.preventDefault(); onSearch(buildSearchQuery(f)); } }}>
      <div className="adv-grid">
        <label>From</label><input className="input input-sm" autoFocus value={f.from} onChange={(e) => set({ from: e.target.value })} placeholder="name or address" />
        <label>To</label><input className="input input-sm" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        <label>Subject</label><input className="input input-sm" value={f.subject} onChange={(e) => set({ subject: e.target.value })} />
        <label>Has the words</label><input className="input input-sm" value={f.words} onChange={(e) => set({ words: e.target.value })} />
        <label>Doesn't have</label><input className="input input-sm" value={f.not} onChange={(e) => set({ not: e.target.value })} />
        <label>Date within</label><select className="select input-sm" value={f.within} onChange={(e) => set({ within: e.target.value as SearchFields['within'] })}><option value="">Any time</option><option value="1d">1 day</option><option value="3d">3 days</option><option value="7d">1 week</option><option value="30d">1 month</option><option value="90d">3 months</option><option value="1y">1 year</option></select>
        <label>Search in</label><select className="select input-sm" value={f.box} onChange={(e) => set({ box: e.target.value })}><option value="">All mail</option>{folders.map((b) => <option key={b} value={b}>{b}</option>)}</select>
      </div>
      <div className="row wrap gap-12 mt-8">
        <label className="row gap-4 small"><input type="checkbox" className="checkbox" checked={f.has === 'attachment'} onChange={(e) => set({ has: e.target.checked ? 'attachment' : '' })} /> Has attachment</label>
        <label className="row gap-4 small"><input type="checkbox" className="checkbox" checked={f.unread} onChange={(e) => set({ unread: e.target.checked })} /> Unread</label>
        <label className="row gap-4 small"><input type="checkbox" className="checkbox" checked={f.starred} onChange={(e) => set({ starred: e.target.checked })} /> Starred</label>
        <span className="ml-auto row gap-4"><Button size="sm" variant="ghost" onClick={() => setF({ ...EMPTY_SEARCH })}>Reset</Button><Button size="sm" variant="primary" onClick={() => onSearch(buildSearchQuery(f))}>Search</Button></span>
      </div>
    </div>
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
    { label: 'AI responders', run: () => nav('/responders') },
    { label: 'New AI campaign', run: () => nav('/sequences?campaign=1') },
    { label: 'Settings: Accounts', run: () => nav('/settings/accounts') },
    { label: 'Settings: AI assistant', run: () => nav('/settings/ai') },
    { label: 'Settings: Sending policy', run: () => nav('/settings/accounts') },
    { label: 'Settings: Security', run: () => nav('/settings/security') },
    { label: 'Settings: Appearance', run: () => nav('/settings/appearance') },
    { label: 'Toggle dark mode', run: () => setAppearance({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }) },
    { label: 'Settings: Profile picture', run: () => nav('/settings/profile') },
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
  const rows: [string, string][] = [['c', 'Compose'], ['/', 'Search'], ['⌘/Ctrl K', 'Command palette'], ['j / k', 'Next / previous conversation'], ['o or Enter', 'Open conversation'], ['u or Esc', 'Back to list'], ['x', 'Select conversation'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Mark as junk'], ['s', 'Star'], ['r / a / f', 'Reply / reply all / forward (inline)'], ['⌘/Ctrl Enter', 'Send the message being written'], ['Shift+I / Shift+U', 'Mark read / unread'], ['b', 'Snooze'], ['m', 'Mute / unmute'], ['] / [', 'Older / newer conversation'], ['g i', 'Inbox'], ['g s', 'Starred'], ['g t', 'Sent'], ['g d', 'Drafts'], ['g a', 'All mail'], ['g c', 'Contacts'], ['g q', 'Sequences'], ['g h', 'Overview'], ['?', 'This help']];
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
