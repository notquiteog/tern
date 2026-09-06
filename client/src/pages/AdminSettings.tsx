import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, KeyRound, Loader2, Plus, RefreshCw, Trash2, Users, Settings as SettingsIcon, ExternalLink, Server, Copy, KeySquare, Upload, Feather, ScrollText, Bot, Palette, ArrowLeft } from 'lucide-react';
import { api, apiStream } from '../api';
import { useAuth } from '../state/auth';
import { useAppName } from '../components/Brand';
import { renderIcons } from '../lib/pwaIcons';
import { useToast } from '../state/toast';
import { useAiStatus } from '../lib/queries';
import { Badge, Button, Callout, ColorPicker, Confirm, Field, IconButton, Input, Modal, PageHeader, Progress, Select, Spinner, Textarea, Toggle, Tabs, Avatar } from '../components/ui';
import { fmtBytes, fmtDateTime, fmtRelative, cls } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { AiPlayground, AiStatusLine } from './Settings';

// Everything that changes the workspace for everyone: users and sign-up,
// the bundled mail server, the AI model, the app's name and logo, the
// compliance footer, the audit log. Admins only; the API enforces it too.
export default function AdminSettingsPage() {
  const { user, stalwartProvisioning } = useAuth();
  const admin = user!.role === 'admin';
  if (!admin) return <Navigate to="/settings/profile" replace />;
  const tabs: [string, string, ReactNode][] = [
    ['general', 'General', <SettingsIcon size={15} />], ['users', 'Users', <Users size={15} />],
  ];
  if (stalwartProvisioning) tabs.push(['mailserver', 'Mail server', <Server size={15} />]);
  tabs.push(['ai', 'AI model', <Bot size={15} />], ['branding', 'Branding', <Palette size={15} />], ['audit', 'Audit log', <ScrollText size={15} />]);
  return (
    <div className="page">
      <div className="settings-head row wrap mb-8">
        <div className="flex-1"><h1 className="row gap-8">Admin settings <Badge kind="accent">admins only</Badge></h1><div className="small muted">Applies to everyone on this install.</div></div>
        <NavLink to="/settings/profile" className="btn"><ArrowLeft size={15} />My settings</NavLink>
      </div>
      <div className="tabs settings-tabs">
        {tabs.map(([k, l, i]) => <NavLink key={k} to={`/admin/${k}`} className={({ isActive }) => cls(isActive && 'active')}>{i}{l}</NavLink>)}
      </div>
      <Routes>
        <Route path="general" element={<GeneralSettings />} />
        <Route path="users" element={<UsersSettings />} />
        <Route path="mailserver" element={<MailServerSettings />} />
        <Route path="ai" element={<AiAdminSettings />} />
        <Route path="branding" element={<BrandingSettings />} />
        <Route path="audit" element={<AuditSettings />} />
        <Route path="*" element={<Navigate to="/admin/general" replace />} />
      </Routes>
    </div>
  );
}

// ---------------- General ----------------

function GeneralSettings() {
  const { user, version } = useAuth();
  const appName = useAppName();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['app-settings'], queryFn: () => api.get<any>('/api/settings') });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF(data.app); }, [data, f]);
  if (!data || !f) return <Spinner />;
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="General" sub={`${appName} ${version || data.version} · ${data.appUrl}`} />
      <div className="card mb-16">
        <h2 className="mb-8">Compliance footer</h2>
        <p className="muted small">Added below sequence emails when the sequence's unsubscribe footer is on. CAN-SPAM requires a valid physical postal address in commercial email.</p>
        <Field label="Unsubscribe sentence"><Input value={f.unsubscribeText} onChange={(e) => setF({ ...f, unsubscribeText: e.target.value })} disabled={user!.role !== 'admin'} /></Field>
        <Field label="Physical address"><Textarea value={f.physicalAddress} onChange={(e) => setF({ ...f, physicalAddress: e.target.value })} placeholder="Acme LLC, 100 Main St, Springfield" style={{ minHeight: 60 }} disabled={user!.role !== 'admin'} /></Field>
        <Button variant="primary" onClick={() => api.put('/api/settings', f).then(() => { toast.success('Saved'); refetch(); }).catch((e) => toast.error(e))}>Save</Button>
      </div>
      {data.stalwart && <div className="card mb-16"><h2 className="mb-8">Bundled mail server</h2><p className="small muted">Stalwart is running beside {appName}. Mailboxes, DNS and the brand logo are under <NavLink to="/admin/mailserver">Mail server</NavLink>; domains, aliases, relay hosts, spam rules, queues and logs are in its own panel.</p><a className="btn" href={data.stalwart.adminUrl ?? '#'} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open Stalwart admin</a></div>}
      <div className="card">
        <h2 className="mb-8">Where things are</h2>
        <dl className="kv">
          <dt>People and sign-up</dt><dd><NavLink to="/admin/users">Users</NavLink>: add people, invite links, open registration, whether new logins get a mailbox.</dd>
          <dt>The model</dt><dd><NavLink to="/admin/ai">AI model</NavLink>: provider, model, system prompt and tuning. Everyone's own assistant page is under Settings.</dd>
          <dt>Name and logo</dt><dd><NavLink to="/admin/branding">Branding</NavLink>: what the app is called and its icon.</dd>
          <dt>Who did what</dt><dd><NavLink to="/admin/audit">Audit log</NavLink>.</dd>
        </dl>
      </div>
    </div>
  );
}

function BrandingSettings() {
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="Branding" sub="The app's own name and logo, for everyone who signs in here." />
      <BrandingCard />
    </div>
  );
}

function AuditSettings() {
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: any[] }>('/api/settings/audit') });
  return (
    <div style={{ maxWidth: 900 }}>
      <PageHeader title="Audit log" sub="Sign-ins, settings changes, mailbox provisioning, passwords viewed or reset, keys changed. Kept for a year." />
      <div className="card">
        <DataTable rows={(audit?.entries ?? []).slice(0, 200)} rowKey={(e) => e.id} cardSize="sm" dense columns={[
          { key: 'when', header: 'When', className: 'small muted', nowrap: true, cell: (e) => fmtDateTime(e.created_at) },
          { key: 'who', header: 'Who', className: 'small', cell: (e) => e.username ?? 'system' },
          { key: 'action', header: 'Action', primary: true, className: 'small strong', cell: (e) => e.action },
          { key: 'details', header: 'Details', secondary: true, className: 'small muted', cell: (e) => { const d = `${e.target ?? ''} ${Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}`.trim(); return d ? <span className="truncate" style={{ display: 'inline-block', maxWidth: 420, verticalAlign: 'bottom' }} title={d}>{d}</span> : null; } },
        ]} />
      </div>
    </div>
  );
}

// ---------------- AI model (admin) ----------------

function AiAdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, refetch } = useAiStatus();
  const [f, setF] = useState<any>(null);
  const [pull, setPull] = useState<{ name: string; status: string; pct: number } | null>(null);
  const [customModel, setCustomModel] = useState('');
  useEffect(() => { if (data && !f) setF({ ...data.settings }); }, [data, f]);
  async function save(patch: any) {
    try { await api.put('/api/ai/settings', patch); qc.invalidateQueries({ queryKey: ['ai-status'] }); toast.success('Saved'); } catch (e) { toast.error(e); }
  }
  async function doPull(name: string) {
    setPull({ name, status: 'starting', pct: 0 });
    try {
      await apiStream('/api/ai/models/pull', { name }, { onEvent: (ev, d) => { if (ev === 'progress') setPull({ name, status: d.status, pct: d.total ? Math.round((100 * (d.completed ?? 0)) / d.total) : 0 }); if (ev === 'error') toast.error(d.error); } });
      toast.success(`${name} is ready`); refetch();
    } catch (e) { toast.error(e); } finally { setPull(null); }
  }
  if (isLoading || !data || !f) return <Spinner />;
  const findInstalled = (n: string) => data.models.find((x: any) => x.name === n || x.name === `${n}:latest`);
  const modelRows: { name: string; inst: any; active: boolean; note: string; sizeGB?: number }[] = [
    ...data.curated.map((m: any) => ({ name: m.name, inst: findInstalled(m.name), active: data.settings.model === m.name, note: m.note, sizeGB: m.sizeGB })),
    ...data.models.filter((x: any) => !data.curated.some((c: any) => c.name === x.name || `${c.name}:latest` === x.name)).map((x: any) => ({ name: x.name, inst: x, active: data.settings.model === x.name, note: `${x.parameterSize ?? ''} ${x.quantization ?? ''}`.trim() })),
  ];
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="AI model" sub="The provider and model behind everyone's assistant, its standing instructions and its tuning." />
      <div className="card mb-16"><AiStatusLine data={data} admin /></div>
      <div className="card mb-16">
        <div className="card-title"><h2>Provider and model</h2><div className="row"><Toggle checked={f.enabled} onChange={(v) => { setF({ ...f, enabled: v }); void save({ enabled: v }); }} /><span className="small">Enabled</span></div></div>
        <div className="form-row">
          <Field label="Provider"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="ollama">Ollama (local, default)</option><option value="openai">OpenAI-compatible API</option></Select></Field>
          <Field label="Base URL"><Input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder={f.provider === 'ollama' ? 'http://ollama:11434' : 'https://api.example.com'} /></Field>
          {f.provider === 'openai' && <Field label="API key" hint={data.settings.hasApiKey ? 'A key is stored; leave blank to keep it.' : ''}><Input type="password" value={f.apiKey ?? ''} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></Field>}
          <Field label="Model name"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          <Field label="Temperature" hint="Lower is more literal; 0.7 is a good default for email."><Input type="number" step={0.1} min={0} max={2} value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} /></Field>
          <Field label="Context window (tokens)" hint="4096 keeps memory low. Long threads get truncated to the newest messages."><Input type="number" min={512} max={32768} value={f.numCtx} onChange={(e) => setF({ ...f, numCtx: Number(e.target.value) })} /></Field>
        </div>
        <Button variant="primary" onClick={() => save({ provider: f.provider, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, model: f.model, temperature: f.temperature, numCtx: f.numCtx })}>Save settings</Button>
      </div>
      <div className="card mb-16">
        <div className="card-title"><h2>System prompt</h2><Button size="sm" variant="ghost" onClick={() => setF({ ...f, systemPrompt: '' })}>Reset to default</Button></div>
        <p className="muted small">The standing instructions every generation starts with: who the assistant is, house rules, things it must never say. Leave empty to use the built-in default shown as the placeholder. Per-account voice notes (Settings → Accounts → Identity) are added on top.</p>
        <Textarea value={f.systemPrompt ?? ''} onChange={(e) => setF({ ...f, systemPrompt: e.target.value })} placeholder={data.defaultSystemPrompt} style={{ minHeight: 180, fontFamily: 'var(--mono)', fontSize: 12.5 }} />
        <Button variant="primary" className="mt-8" onClick={() => save({ systemPrompt: f.systemPrompt ?? '' })}>Save system prompt</Button>
      </div>
      <div className="card mb-16">
        <div className="card-title"><h2>Tuning</h2><Button size="sm" variant="ghost" onClick={() => setF({ ...f, temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1, maxTokens: 700, numCtx: 4096 })}>Defaults</Button></div>
        <div className="form-grid-3">
          <Field label={`Temperature: ${f.temperature}`} hint="Creativity. 0.3 literal, 0.7 natural, 1.0+ loose."><input className="range" type="range" min={0} max={1.5} step={0.05} value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} /></Field>
          <Field label={`Top-p: ${f.topP}`} hint="Nucleus sampling. Lower is safer."><input className="range" type="range" min={0.1} max={1} step={0.05} value={f.topP} onChange={(e) => setF({ ...f, topP: Number(e.target.value) })} /></Field>
          <Field label={`Top-k: ${f.topK}`} hint="Candidates per token."><input className="range" type="range" min={1} max={100} step={1} value={f.topK} onChange={(e) => setF({ ...f, topK: Number(e.target.value) })} /></Field>
          <Field label={`Repeat penalty: ${f.repeatPenalty}`} hint="Above 1 discourages repetition."><input className="range" type="range" min={0.8} max={1.6} step={0.05} value={f.repeatPenalty} onChange={(e) => setF({ ...f, repeatPenalty: Number(e.target.value) })} /></Field>
          <Field label="Max tokens per reply" hint="Caps the length of a generation."><Input type="number" min={64} max={4096} value={f.maxTokens} onChange={(e) => setF({ ...f, maxTokens: Number(e.target.value) })} /></Field>
          <Field label="Keep model loaded" hint="e.g. 10m, 1h, -1 for always"><Input value={f.keepAlive} onChange={(e) => setF({ ...f, keepAlive: e.target.value })} /></Field>
        </div>
        <Button variant="primary" onClick={() => save({ temperature: f.temperature, topP: f.topP, topK: f.topK, repeatPenalty: f.repeatPenalty, maxTokens: f.maxTokens, numCtx: f.numCtx, keepAlive: f.keepAlive })}>Save tuning</Button>
      </div>
      {f.provider === 'ollama' && (
        <div className="card mb-16">
          <div className="card-title"><h2>Models</h2><span className="small muted">Recommended for {data.totalMemGiB} GB: <b>{data.recommended.model}</b></span></div>
          <Callout>{data.recommended.note} Pulling downloads from the Ollama registry once; models live in the <code>ollama</code> volume.</Callout>
          {pull && <div className="mt-16"><div className="row small mb-8"><Loader2 size={14} className="spin" /> Pulling {pull.name}: {pull.status} {pull.pct ? `${pull.pct}%` : ''}</div><Progress value={pull.pct} max={100} /></div>}
          <div className="mt-16"><DataTable rows={modelRows} rowKey={(m) => m.name} columns={[
            { key: 'model', header: 'Model', primary: true, cell: (m) => <span className="row gap-4 wrap"><span className="strong">{m.name}</span>{m.active && <Badge kind="accent">in use</Badge>}{m.name === data.recommended.model && <Badge kind="success">recommended</Badge>}</span> },
            { key: 'size', header: 'Size', className: 'muted', nowrap: true, cell: (m) => m.inst ? fmtBytes(m.inst.size) : `~${m.sizeGB} GB` },
            { key: 'note', header: 'Note', secondary: true, className: 'muted small', cell: (m) => m.note },
            { key: 'act', actions: true, cell: (m) => m.inst ? <><Button size="sm" disabled={m.active} onClick={() => save({ model: m.name })}>{m.active ? 'Selected' : 'Use'}</Button><IconButton label="Delete" className="btn-sm" onClick={() => api.del(`/api/ai/models/${encodeURIComponent(m.name)}`).then(() => refetch())}><Trash2 size={14} /></IconButton></> : <Button size="sm" icon={<Download size={13} />} disabled={Boolean(pull)} onClick={() => doPull(m.name)}>Pull</Button> },
          ]} /></div>
          <div className="row mt-16"><Input className="input-sm" placeholder="any model from ollama.com/library, e.g. mistral:7b" value={customModel} onChange={(e) => setCustomModel(e.target.value)} style={{ maxWidth: 360 }} /><Button size="sm" disabled={!customModel || Boolean(pull)} onClick={() => { doPull(customModel); setCustomModel(''); }}>Pull</Button></div>
        </div>
      )}
      <AiPlayground enabled={Boolean(data.settings.enabled)} />
    </div>
  );
}

// The app's own name and logo (admins). Saving refreshes the auth context so
// the top bar, tab title and favicon change immediately.
const LOGO_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'];
function BrandingCard() {
  const toast = useToast();
  const { refresh } = useAuth();
  const { data, refetch } = useQuery({ queryKey: ['branding'], queryFn: () => api.get<{ branding: any }>('/api/settings/branding') });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (data) setName(data.branding.name); }, [data]);
  const done = async () => { await refetch(); await refresh(); };
  // Home-screen icons are rendered here in the browser from the logo, so the
  // server never needs an image library. Re-rendered when the logo or the
  // background colour changes.
  async function buildIcons(logoUrl: string, bg: string) {
    const icons = await renderIcons(logoUrl, bg);
    await api.post('/api/settings/branding/icons', { iconBg: bg, icons });
  }
  async function saveIconBg(bg: string) {
    if (!b?.logo) { toast.error('Upload a logo first'); return; }
    setBusy(true);
    try { await buildIcons(b.logo, bg); await done(); toast.success('Home-screen icons updated'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function saveName() {
    try { await api.put('/api/settings/branding', { name }); await done(); toast.success('Name saved'); } catch (e) { toast.error(e); }
  }
  async function onFile(f: File) {
    const type = f.type || (f.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '');
    if (!LOGO_TYPES.includes(type)) { toast.error('Choose an SVG, PNG, JPEG or WebP image'); return; }
    setBusy(true);
    try {
      const r = await api.upload<any>('/api/settings/branding/logo', f, type);
      await buildIcons(r.branding.logo, r.branding.iconBg);
      await done();
      toast.success(`Logo saved: ${fmtBytes(r.bytes)}${r.note ? ` (${r.note})` : ''}; home-screen icons rendered`);
    } catch (e) { toast.error(e); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove() {
    setBusy(true);
    try { await api.del('/api/settings/branding/logo'); await done(); toast.success('Logo removed'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  const b = data?.branding;
  if (!b) return null;
  return (
    <div className="card mb-16">
      <h2 className="mb-8">Name and logo</h2>
      <p className="muted small">Shown in the top bar, on the sign-in page and as the browser tab title for everyone here. SVGs are cleaned of scripts and metadata; PNG, JPEG and WebP have their metadata stripped. Up to {fmtBytes(b.maxBytes)}.</p>
      <div className="row gap-16 wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="App name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></Field>
        <Button variant="primary" onClick={saveName} disabled={!name.trim() || name.trim() === b.name}>Save name</Button>
      </div>
      <div className="row gap-16 mt-16" style={{ alignItems: 'center' }}>
        <span className={b.logo ? 'brand-logo custom' : 'brand-logo'} style={{ width: 56, height: 56, borderRadius: 14 }}>{b.logo ? <img src={b.logo} alt="" /> : <Feather size={26} />}</span>
        <div className="col gap-8">
          <div className="small muted">{b.logo ? `${String(b.logoType).replace('image/', '').replace('svg+xml', 'SVG').toUpperCase()} · ${fmtBytes(b.logoBytes)}` : 'Default logo'}</div>
          <div className="row gap-8">
            <input ref={input} type="file" accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
            <Button icon={<Upload size={15} />} onClick={() => input.current?.click()} disabled={busy}>Upload logo</Button>
            {b.logo && <Button variant="ghost" icon={<Trash2 size={15} />} onClick={remove} disabled={busy}>Remove</Button>}
          </div>
        </div>
      </div>
      <div className="row gap-16 mt-16 wrap" style={{ alignItems: 'center' }}>
        <img src={`/icons/icon-512-maskable.png?v=${b.version}`} alt="" width={56} height={56} style={{ borderRadius: 14, flex: 'none' }} />
        <div className="col gap-8">
          <div className="small muted">Home-screen icon{b.logo ? ' · background colour behind the logo when the app is installed' : ' · default until a logo is uploaded'}</div>
          <ColorPicker value={b.iconBg} onChange={(c) => { if (!busy && c !== b.iconBg) void saveIconBg(c); }} />
        </div>
      </div>
    </div>
  );
}

// ---------------- Users (admin) ----------------

function UsersSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: any[] }>('/api/users') });
  const [create, setCreate] = useState(false);
  const [f, setF] = useState({ username: '', displayName: '', password: '', role: 'member', provisionMailbox: true });
  const [reset, setReset] = useState<any>(null);
  const [newPw, setNewPw] = useState('');
  const [del, setDel] = useState<any>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const { data: authInfo } = useQuery({ queryKey: ['auth-settings'], queryFn: () => api.get<{ settings: { allowRegistration: boolean; defaultRole: string; provisionMailboxes: boolean }; mailServer: { domain: string } | null }>('/api/users/auth-settings') });
  const authSettings = authInfo?.settings;
  const mailDomain = authInfo?.mailServer?.domain ?? null;
  const { data: invites } = useQuery({ queryKey: ['invites'], queryFn: () => api.get<{ invites: any[] }>('/api/users/invites').then((r) => r.invites) });
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviteNote, setInviteNote] = useState('');
  const [inviteDays, setInviteDays] = useState(7);
  async function saveAuth(patch: any) { try { await api.put('/api/users/auth-settings', patch); qc.invalidateQueries({ queryKey: ['auth-settings'] }); toast.success('Saved'); } catch (e) { toast.error(e); } }
  async function makeInvite() { try { await api.post('/api/users/invites', { role: inviteRole, note: inviteNote, days: inviteDays }); qc.invalidateQueries({ queryKey: ['invites'] }); setInviteNote(''); } catch (e) { toast.error(e); } }
  async function add() {
    try {
      const r = await api.post<{ mailbox: { email: string; created: boolean; error: string | null } | null }>('/api/users', { ...f, provisionMailbox: mailDomain ? f.provisionMailbox : undefined });
      invalidate(); setCreate(false); setF({ username: '', displayName: '', password: '', role: 'member', provisionMailbox: true });
      if (r.mailbox?.created) toast.success(`User created with mailbox ${r.mailbox.email}`);
      else if (r.mailbox?.error) toast.toast(`User created, but the mailbox could not be made: ${r.mailbox.error}`, { kind: 'error', ttl: 9000 });
      else toast.success('User created');
    } catch (e) { toast.error(e); }
  }
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Users" sub="Everyone signs in with a username and password; there is no email-based reset by design. Passwords are reset here or with tern set-password on the server." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>Add user</Button>} />
      <DataTable rows={data?.users ?? []} rowKey={(u) => u.id} minWidth={720} columns={[
        { key: 'user', header: 'User', primary: true, cell: (u) => <div className="row"><Avatar name={u.display_name} email={u.username} size="sm" src={u.avatar_version ? `/api/avatars/user/${u.id}?v=${u.avatar_version}` : null} /><div><div className="strong">{u.display_name}</div><div className="small muted">@{u.username} {u.disabled && <Badge kind="danger">disabled</Badge>}</div></div></div> },
        { key: 'role', header: 'Role', cell: (u) => <Select className="input-sm" style={{ width: 110 }} value={u.role} disabled={u.id === me!.id} onChange={(e) => api.put(`/api/users/${u.id}`, { role: e.target.value }).then(invalidate).catch((err) => toast.error(err))}><option value="admin">admin</option><option value="member">member</option></Select> },
        { key: 'accounts', header: 'Mailboxes', cell: (u) => u.account_count },
        { key: 'totp', header: '2FA', cell: (u) => u.totp_enabled ? <Badge kind="success">on</Badge> : <Badge>off</Badge> },
        { key: 'last', header: 'Last sign-in', className: 'small muted', nowrap: true, cell: (u) => u.last_login_at ? fmtRelative(u.last_login_at) : 'never' },
        { key: 'act', actions: true, cell: (u) => <>
          <Button size="sm" onClick={() => { setReset(u); setNewPw(''); }}>Set password</Button>
          {u.id !== me!.id && <Button size="sm" variant="ghost" onClick={() => api.put(`/api/users/${u.id}`, { disabled: !u.disabled }).then(invalidate)}>{u.disabled ? 'Enable' : 'Disable'}</Button>}
          {u.id !== me!.id && <IconButton label="Delete" className="btn-sm" onClick={() => setDel(u)}><Trash2 size={14} /></IconButton>}
        </> },
      ]} />
      <div className="card mt-24">
        <div className="card-title"><h2>Registration</h2></div>
        <div className="row mb-8"><Toggle checked={Boolean(authSettings?.allowRegistration)} onChange={(v) => saveAuth({ allowRegistration: v })} /><div><div className="strong small">Allow anyone who reaches the sign-in page to create an account</div><div className="help-text">Off by default. Invite links below work either way.</div></div></div>
        {authSettings?.allowRegistration && <Field label="Role for self-registered users"><Select value={authSettings.defaultRole} onChange={(e) => saveAuth({ defaultRole: e.target.value })} style={{ maxWidth: 200 }}><option value="member">Member</option><option value="admin">Admin</option></Select></Field>}
        {mailDomain && <div className="row mt-8"><Toggle checked={Boolean(authSettings?.provisionMailboxes)} onChange={(v) => saveAuth({ provisionMailboxes: v })} /><div><div className="strong small">Give every new login a mailbox on the mail server</div><div className="help-text">Creates <code>username@{mailDomain}</code> when someone registers, accepts an invite or is added here, and connects it as their first account. A username whose address already exists on the server cannot register; an admin connects that mailbox by hand under Mail server.</div></div></div>}
      </div>
      <div className="card mt-16">
        <div className="card-title"><h2>Invite links</h2></div>
        <div className="row wrap mb-16"><Select className="input-sm" style={{ width: 130 }} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as any)}><option value="member">Member</option><option value="admin">Admin</option></Select><Input className="input-sm" style={{ maxWidth: 260 }} value={inviteNote} onChange={(e) => setInviteNote(e.target.value)} placeholder="Note, e.g. for Sam" /><Input className="input-sm" type="number" min={1} max={365} style={{ width: 90 }} value={inviteDays} onChange={(e) => setInviteDays(Number(e.target.value))} /><span className="small muted">days valid</span><Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={makeInvite}>Create link</Button></div>
        {invites?.length ? <DataTable rows={invites} rowKey={(i) => i.id} cardSize="sm" columns={[
          { key: 'note', header: 'For', primary: true, cell: (i) => <span className="row gap-4 wrap"><Badge>{i.role}</Badge><span className="small">{i.note || <span className="faint">no note</span>}</span></span> },
          { key: 'state', header: 'Status', secondary: true, className: 'small muted', cell: (i) => i.used_at ? `used by @${i.used_by_username}` : new Date(i.expires_at) < new Date() ? 'expired' : `expires ${fmtRelative(i.expires_at)}` },
          { key: 'url', header: 'Link', hideOnMobile: true, className: 'small mono', cell: (i) => i.used_at ? '' : <span className="truncate" style={{ display: 'inline-block', maxWidth: 320, verticalAlign: 'bottom' }}>{i.url}</span> },
          { key: 'act', actions: true, cell: (i) => <>{!i.used_at && <Button size="sm" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(i.url); toast.success('Link copied'); }}>Copy link</Button>}<IconButton label="Delete" className="btn-sm" onClick={() => api.del(`/api/users/invites/${i.id}`).then(() => qc.invalidateQueries({ queryKey: ['invites'] }))}><Trash2 size={14} /></IconButton></> },
        ]} /> : <div className="small muted">No invite links yet.</div>}
      </div>
      <Modal open={create} onClose={() => setCreate(false)} title="Add user" footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" disabled={!f.username || !f.displayName || f.password.length < 10} onClick={add}>Create</Button></>}>
        <div className="form-row"><Field label="Name"><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field><Field label="Username"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field><Field label="Temporary password" hint="At least 10 characters; they can change it later."><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field><Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="member">Member</option><option value="admin">Admin</option></Select></Field></div>
        {mailDomain && authSettings?.provisionMailboxes && <div className="row"><Toggle checked={f.provisionMailbox} onChange={(v) => setF({ ...f, provisionMailbox: v })} /><span className="small">Create and connect <code>{(f.username || 'username').toLowerCase()}@{mailDomain}</code> on the mail server</span></div>}
      </Modal>
      <Modal open={Boolean(reset)} onClose={() => setReset(null)} title={`Set password for @${reset?.username}`} footer={<><Button onClick={() => setReset(null)}>Cancel</Button><Button variant="primary" disabled={newPw.length < 10} onClick={() => api.post(`/api/users/${reset.id}/password`, { password: newPw }).then(() => { setReset(null); toast.success('Password set; their sessions were signed out'); }).catch((e) => toast.error(e))}>Set password</Button></>}>
        <Field label="New password"><Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" /></Field>
      </Modal>
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete @${del?.username}?`} message="Their connected accounts, contacts, sequences and drafts are deleted with them." confirmLabel="Delete user" onConfirm={async () => { await api.del(`/api/users/${del.id}`); invalidate(); }} />
    </div>
  );
}


// ---------------- Mail server (bundled Stalwart) ----------------

const STATUS_KIND: Record<string, any> = { ok: 'success', missing: 'danger', mismatch: 'warning', error: 'danger', skipped: undefined };
const STATUS_LABEL: Record<string, string> = { ok: 'found', missing: 'missing', mismatch: 'differs', error: 'error', skipped: 'skipped' };
const GROUP_TITLES: Record<string, [string, string]> = {
  required: ['Required', 'Without these, mail is rejected or lands in spam.'],
  recommended: ['Encryption in transit', 'MTA-STS and TLS-RPT: other servers refuse to deliver to you over plain text, and tell you when they could not connect securely.'],
  brand: ['Brand logo', 'BIMI shows your logo beside your messages in clients that support it.'],
  clients: ['Mail apps', 'Lets Thunderbird, Apple Mail, Outlook and phones configure themselves from just the address.'],
};

function MailServerSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['stalwart'], queryFn: () => api.get<any>('/api/stalwart') });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: any[] }>('/api/users').then((r) => r.users) });
  const [tab, setTab] = useState<'setup' | 'mailboxes' | 'brand' | 'admin'>('setup');
  const [create, setCreate] = useState(false);
  const [f, setF] = useState({ localPart: '', domainId: '', displayName: '', password: '', connect: 'me' as 'none' | 'me' | 'user' | 'new', userId: '' as number | '', newUser: { username: '', password: '', displayName: '', role: 'member' as 'member' | 'admin' } });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [del, setDel] = useState<any>(null);
  const [reset, setReset] = useState<any>(null);
  useEffect(() => { if (data?.domains?.length && !f.domainId) setF((x) => ({ ...x, domainId: (data.domains.find((d: any) => d.name === data.domain) ?? data.domains[0]).id })); }, [data, f.domainId]);
  const refresh = () => { refetch(); qc.invalidateQueries({ queryKey: ['accounts'] }); qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['dns'] }); };
  async function createMailbox() {
    setBusy(true);
    try {
      const body: any = { localPart: f.localPart, domainId: f.domainId, displayName: f.displayName, password: f.password || undefined, connect: f.connect };
      if (f.connect === 'user') body.userId = Number(f.userId);
      if (f.connect === 'new') body.newUser = { ...f.newUser, displayName: f.newUser.displayName || f.displayName || f.newUser.username };
      const r = await api.post<any>('/api/stalwart/mailboxes', body);
      setResult(r); setCreate(false); refresh();
      setF({ localPart: '', domainId: f.domainId, displayName: '', password: '', connect: 'me', userId: '', newUser: { username: '', password: '', displayName: '', role: 'member' } });
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  if (isLoading || !data) return <Spinner />;
  if (!data.enabled) return <Callout>The bundled mail server is not enabled on this install. Re-run <code>sudo ./install.sh</code> and answer yes to "Run a Stalwart mail server here?".</Callout>;
  return (
    <div style={{ maxWidth: 980 }}>
      <PageHeader title="Mail server" sub={`Stalwart at ${data.host}${data.domain ? ` · ${data.domain}` : ''}`} actions={<><a className="btn" href={data.adminUrl ?? '#'} target="_blank" rel="noreferrer"><ExternalLink size={15} />Stalwart admin</a><Button variant="primary" icon={<Plus size={15} />} onClick={() => { setTab('mailboxes'); setCreate(true); }} disabled={!data.reachable}>Create mailbox</Button></>} />
      {!data.reachable && <Callout kind="danger">The mail server is not answering: {data.error}. Check <code>./bin/tern logs stalwart</code>.</Callout>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'setup', label: 'DNS setup' }, { value: 'mailboxes', label: <>Mailboxes <Badge>{data.mailboxes.length}</Badge></> }, { value: 'brand', label: 'Brand logo' }, { value: 'admin', label: 'Admin access' }]} />
      {result && (
        <Callout kind="success">
          <div className="strong">Mailbox {result.mailbox.email} created</div>
          {result.password && <div className="mt-8">Password: <code>{result.password}</code> <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(result.password); toast.success('Copied'); }}>Copy</Button><div className="small muted">Shown once. Tern keeps it encrypted for the connected account; give it to the person for their mail app.</div></div>}
          {result.user && <div className="mt-8">Tern login created: <b>@{result.user.username}</b></div>}
          {result.account && <div className="mt-8 small">Connected as a Tern account; the first sync is running.</div>}
          {result.connectError && <div className="mt-8 small" style={{ color: 'var(--danger)' }}>Mailbox created but connecting it failed: {result.connectError}</div>}
          <Button size="sm" variant="ghost" className="mt-8" onClick={() => setResult(null)}>Dismiss</Button>
        </Callout>
      )}
      {tab === 'setup' && <DnsSetup data={data} />}
      {tab === 'brand' && <BrandLogo domain={data.domain} />}
      {tab === 'admin' && <AdminAccess />}
      {tab === 'mailboxes' && (
        <div className="card">
          <div className="card-title"><h2>Mailboxes</h2><span className="small muted">{data.mailboxes.length} on the server</span></div>
          {!data.mailboxes.length ? <div className="small muted">No mailboxes yet. Create one with the button above; it can also create the person's Tern login and connect the two.</div> : (
            <DataTable rows={data.mailboxes} rowKey={(m: any) => m.id} columns={[
              { key: 'email', header: 'Address', primary: true, className: 'strong', cell: (m: any) => <>{m.email}{m.aliases?.length ? <div className="small muted" style={{ fontWeight: 400 }}>aliases: {m.aliases.join(', ')}</div> : null}</> },
              { key: 'name', header: 'Name', secondary: true, className: 'muted', cell: (m: any) => m.description ?? '' },
              { key: 'conn', header: 'Connected in Tern', cell: (m: any) => m.connections.length ? <span className="row gap-4 wrap">{m.connections.map((c: any) => <Badge key={c.accountId} kind="success">@{c.username}</Badge>)}</span> : <span className="faint small">not connected</span> },
              { key: 'act', actions: true, cell: (m: any) => <><Button size="sm" icon={<KeySquare size={13} />} onClick={() => setReset(m)}>Reset password</Button><IconButton label="Delete mailbox" className="btn-sm" onClick={() => setDel(m)}><Trash2 size={14} /></IconButton></> },
            ]} />
          )}
        </div>
      )}

      <Modal open={create} onClose={() => setCreate(false)} title="Create mailbox" size="wide" footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.localPart || !f.domainId || (f.connect === 'new' && (!f.newUser.username || f.newUser.password.length < 10)) || (f.connect === 'user' && !f.userId)} onClick={createMailbox}>Create</Button></>}>
        <div className="form-row">
          <Field label="Address"><div className="row"><Input value={f.localPart} onChange={(e) => setF({ ...f, localPart: e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, '') })} placeholder="sam" style={{ maxWidth: 180 }} /><span className="muted">@</span><Select value={f.domainId} onChange={(e) => setF({ ...f, domainId: e.target.value })}>{data.domains.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></div></Field>
          <Field label="Display name"><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder="Sam Rivera" /></Field>
        </div>
        <Field label="Mailbox password" hint="Leave blank to generate a strong one; it is shown once after creation."><Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="generated" autoComplete="off" /></Field>
        <Field label="Connect it to Tern">
          <Select value={f.connect} onChange={(e) => setF({ ...f, connect: e.target.value as any })}>
            <option value="me">My own account (sign-in @{user!.username})</option>
            <option value="user">An existing user</option>
            <option value="new">A new person: create their Tern login too</option>
            <option value="none">Do not connect (mail app only)</option>
          </Select>
        </Field>
        {f.connect === 'user' && <Field label="User"><Select value={f.userId} onChange={(e) => setF({ ...f, userId: Number(e.target.value) })}><option value="">— choose —</option>{(users ?? []).map((u) => <option key={u.id} value={u.id}>{u.display_name} (@{u.username})</option>)}</Select></Field>}
        {f.connect === 'new' && (
          <div className="form-row">
            <Field label="Tern username"><Input value={f.newUser.username} onChange={(e) => setF({ ...f, newUser: { ...f.newUser, username: e.target.value } })} placeholder={f.localPart || 'sam'} /></Field>
            <Field label="Tern password" hint="At least 10 characters; they can change it later."><Input type="text" value={f.newUser.password} onChange={(e) => setF({ ...f, newUser: { ...f.newUser, password: e.target.value } })} autoComplete="off" /></Field>
            <Field label="Role"><Select value={f.newUser.role} onChange={(e) => setF({ ...f, newUser: { ...f.newUser, role: e.target.value as any } })}><option value="member">Member</option><option value="admin">Admin</option></Select></Field>
          </div>
        )}
      </Modal>
      <Modal open={Boolean(reset)} onClose={() => setReset(null)} title={`Reset password for ${reset?.email}`} footer={<><Button onClick={() => setReset(null)}>Cancel</Button><Button variant="primary" onClick={async () => { try { const r = await api.post<any>(`/api/stalwart/mailboxes/${reset.id}/password`, {}); setReset(null); setResult({ mailbox: reset, password: r.password, account: r.updatedAccounts ? { id: 0 } : null, user: null }); refresh(); } catch (e) { toast.error(e); } }}>Generate new password</Button></>}>
        <p className="muted">A new password is generated and shown once. Tern accounts using this mailbox are updated automatically; mail apps on phones and laptops need the new password.</p>
      </Modal>
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete mailbox ${del?.email}?`} message="All mail in it is destroyed on the server and any Tern account connected to it is removed. This cannot be undone." confirmLabel="Delete mailbox" onConfirm={async () => { await api.del(`/api/stalwart/mailboxes/${del.id}`); refresh(); toast.success('Mailbox deleted'); }} />
    </div>
  );
}

function recordValue(r: any): string {
  if (r.type === 'MX') return `${r.priority} ${r.value}`;
  if (r.type === 'SRV') return `${r.srv.priority} ${r.srv.weight} ${r.srv.port} ${r.value}`;
  return r.value;
}

function DnsSetup({ data }: { data: any }) {
  const toast = useToast();
  const { data: dns, isLoading, refetch } = useQuery({ queryKey: ['dns'], queryFn: () => api.get<any>('/api/stalwart/dns'), enabled: data.reachable });
  const { data: sts, refetch: refetchSts } = useQuery({ queryKey: ['mta-sts'], queryFn: () => api.get<{ mode: string }>('/api/stalwart/mta-sts'), enabled: data.reachable });
  const [checks, setChecks] = useState<Record<string, any>>({});
  const [outbound, setOutbound] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [showClients, setShowClients] = useState(false);
  async function check(port25 = true) {
    setChecking(true);
    try {
      const r = await api.post<any>('/api/stalwart/dns/check', { port25 });
      setChecks(Object.fromEntries(r.results.map((x: any) => [x.id, x]))); setOutbound(r.outbound); setSummary(r.summary);
    } catch (e) { toast.error(e); } finally { setChecking(false); }
  }
  if (!data.reachable) return null;
  if (isLoading || !dns) return <Spinner />;
  const groups = ['required', 'recommended', 'brand', 'clients'].filter((g) => dns.records.some((r: any) => r.group === g));
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success('Copied'); };
  return (
    <div className="col gap-16">
      <Callout>
        <div className="strong mb-8">Trusted mail in five steps</div>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>At your <b>hosting provider</b>, set the reverse DNS of <code>{dns.serverIp ?? 'the server IP'}</code> to <code>{dns.mailHost}</code>.</li>
          <li>At your <b>DNS host</b> (where {dns.domain} is managed), add the records below. Use the copy buttons; long values are fine to paste as one piece. If Cloudflare proxies your DNS, turn the proxy off for these names.</li>
          <li>Press <b>Check DNS</b>. Every record shows found, missing or differs, with what the resolver saw.</li>
          <li>Once the required rows are green, send a message to a Gmail address and open "Show original": SPF, DKIM and DMARC should say PASS.</li>
          <li>Add a brand logo (next tab) so your mail carries it, and switch MTA-STS to enforce once its two records are green.</li>
        </ol>
        <div className="small muted mt-8">Full explanations for every record: docs/DNS.md in the repository.</div>
      </Callout>
      <div className="row wrap">
        <Button variant="primary" icon={<RefreshCw size={15} className={checking ? 'spin' : ''} />} loading={checking} onClick={() => check(true)}>Check DNS</Button>
        <Button icon={<Copy size={15} />} onClick={() => copy(dns.zone)}>Copy all as zone file</Button>
        <Button icon={<RefreshCw size={15} />} variant="ghost" onClick={() => refetch()}>Reload from server</Button>
        {summary && <span className={cls('small', summary.requiredOk ? 'strong' : 'muted')} style={{ color: summary.requiredOk ? 'var(--success)' : undefined }}>{summary.requiredOk ? 'All required records are in place.' : `${summary.ok} of ${summary.checked} records found.`}</span>}
      </div>
      {outbound && <Callout kind={outbound.ok ? 'success' : 'warning'}>{outbound.note}{!outbound.ok && ' Ask the provider to open it, or configure a relay host in the Stalwart admin panel under Delivery → Routes.'}</Callout>}
      {groups.map((g) => (g !== 'clients' || showClients) && (
        <div key={g} className="card">
          <div className="card-title"><h2>{GROUP_TITLES[g][0]}</h2><span className="small muted">{GROUP_TITLES[g][1]}</span></div>
          <DataTable rows={dns.records.filter((r: any) => r.group === g)} rowKey={(r: any) => r.id} minWidth={720} columns={[
            { key: 'type', header: 'Type', width: 70, cell: (r: any) => <Badge>{r.type}</Badge> },
            { key: 'name', header: 'Name', primary: true, className: 'mono small', cell: (r: any) => <span style={{ display: 'block', maxWidth: 260, overflowWrap: 'anywhere' }}>{r.name}{r.purpose && <div className="small muted" style={{ fontFamily: 'var(--font)', fontWeight: 400 }}>{r.purpose}</div>}</span> },
            { key: 'value', header: 'Value', wide: true, className: 'mono small', cell: (r: any) => { const c = checks[r.id]; return <span style={{ display: 'block', maxWidth: 360, overflowWrap: 'anywhere' }}>{recordValue(r).length > 140 ? recordValue(r).slice(0, 137) + '…' : recordValue(r)}{c && c.status !== 'ok' && c.found?.length > 0 && <div className="small" style={{ color: 'var(--warning)', fontFamily: 'var(--font)' }}>found: {c.found.join(' | ').slice(0, 160)}</div>}{c?.note && <div className="small muted" style={{ fontFamily: 'var(--font)' }}>{c.note}</div>}</span>; } },
            { key: 'status', header: 'Status', width: 100, cell: (r: any) => { const c = checks[r.id]; return c ? <Badge kind={STATUS_KIND[c.status]} dot>{STATUS_LABEL[c.status]}</Badge> : <span className="faint small">not checked</span>; } },
            { key: 'act', actions: true, cell: (r: any) => <>{r.type !== 'PTR' && <Button size="sm" icon={<Copy size={13} />} onClick={() => copy(recordValue(r))}>Value</Button>}<Button size="sm" variant="ghost" onClick={() => copy(r.type === 'PTR' ? r.value : r.name)}>Name</Button></> },
          ]} />
          {g === 'recommended' && sts && (
            <div className="row mt-16 wrap">
              <span className="small strong">MTA-STS mode:</span>
              <div className="segmented">{['testing', 'enforce', 'disable'].map((m) => <button key={m} className={sts.mode === m ? 'active' : ''} onClick={() => api.post('/api/stalwart/mta-sts', { mode: m }).then(() => { refetchSts(); toast.success(`MTA-STS set to ${m}`); }).catch((e) => toast.error(e))}>{m}</button>)}</div>
              <span className="small muted">Keep testing until the two MTA-STS records are green, then enforce. The policy file is served at https://mta-sts.{dns.domain}/.well-known/mta-sts.txt through Caddy.</span>
            </div>
          )}
        </div>
      ))}
      <div className="row"><Button variant="ghost" size="sm" onClick={() => setShowClients((v) => !v)}>{showClients ? 'Hide' : 'Show'} the mail-app autoconfig records ({dns.records.filter((r: any) => r.group === 'clients').length})</Button></div>
    </div>
  );
}

function BrandLogo({ domain }: { domain: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ['brand', domain], queryFn: () => api.get<{ brand: any; maxBytes?: number }>(`/api/brand/${domain}`), enabled: Boolean(domain) });
  const [initials, setInitials] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#ffffff');
  const [bg, setBg] = useState('#4f6df5');
  const [busy, setBusy] = useState(false);
  const [vmc, setVmc] = useState('');
  const [trace, setTrace] = useState<null | { svg: string; bytes: number; colors: number; paths: number; step: { size: number; colors: number; tolerance: number }; sourceUrl: string; kind: 'raster' | 'svg' }>(null);
  const [traceOpts, setTraceOpts] = useState({ colors: 8, size: 96, tolerance: 1.2, background: '' });
  const [tracing, setTracing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const brand = data?.brand;
  useEffect(() => { if (brand) { setInitials(brand.initials || ''); setName(brand.name || ''); setColor(brand.color); setBg(brand.bg); setVmc(brand.vmc_url || ''); } else if (domain) { setInitials(domain.slice(0, 2).toUpperCase()); setName(domain); } }, [brand, domain]);
  const done = () => { refetch(); qc.invalidateQueries({ queryKey: ['dns'] }); qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['thread'] }); };
  const maxBytes = data?.maxBytes ?? brand?.maxBytes ?? 32768;

  async function generate() {
    setBusy(true);
    try { await api.put(`/api/brand/${domain}`, { name, initials, color, bg }); done(); toast.success('Default logo generated'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function saveSvg(svg: string, source: string) {
    setBusy(true);
    try {
      const r = await api.upload<any>(`/api/brand/${domain}?source=${source}`, svg, 'image/svg+xml');
      const rep = r.brand.report ?? {};
      const removed = Object.values(rep.removedElements ?? {}).reduce((a: number, b: any) => a + Number(b), 0);
      done(); setTrace(null);
      toast.success(`Logo saved: ${Math.round(r.brand.size / 1024 * 10) / 10} KB${rep.originalBytes ? ` (from ${Math.round(rep.originalBytes / 1024 * 10) / 10} KB)` : ''}${removed || rep.removedAttributes ? `, stripped ${removed} element${removed === 1 ? '' : 's'} and ${rep.removedAttributes ?? 0} attributes of metadata` : ''}`);
    } catch (e: any) {
      if (e?.status === 413 && trace?.kind !== 'raster') {
        toast.toast(`${e.message}`, { kind: 'error', ttl: 9000 });
      } else toast.error(e);
    } finally { setBusy(false); }
  }
  // Raster (or heavy SVG) -> traced vector paths, fitted under the limit.
  async function runTrace(source: Blob | string, kind: 'raster' | 'svg', start?: { size: number; colors: number; tolerance: number }) {
    const { traceToFit } = await import('../lib/vectorize');
    setTracing('Tracing…');
    try {
      const r = await traceToFit(source, { title: name || domain, background: traceOpts.background || null, maxBytes: maxBytes - 2048, start }, (step, bytes) => setTracing(`Tracing at ${step.size}px, ${step.colors} colours: ${Math.round(bytes / 1024 * 10) / 10} KB`));
      const sourceUrl = typeof source === 'string' ? source : URL.createObjectURL(source);
      setTrace({ svg: r.svg, bytes: r.bytes, colors: r.colors, paths: r.paths, step: r.step, sourceUrl, kind });
      setTraceOpts((o) => ({ ...o, colors: r.step.colors, size: r.step.size, tolerance: r.step.tolerance }));
    } catch (e) { toast.error(e); } finally { setTracing(null); }
  }
  async function onFile(f: File) {
    if (f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg')) {
      const text = await f.text();
      setBusy(true);
      try {
        const r = await api.upload<any>(`/api/brand/${domain}?source=upload`, text, 'image/svg+xml');
        const rep = r.brand.report ?? {};
        const removed = Object.values(rep.removedElements ?? {}).reduce((a: number, b: any) => a + Number(b), 0);
        done();
        toast.success(`SVG cleaned and saved: ${Math.round(r.brand.size / 1024 * 10) / 10} KB (was ${Math.round((rep.originalBytes ?? 0) / 1024 * 10) / 10} KB); removed ${removed} metadata element${removed === 1 ? '' : 's'}, ${rep.removedAttributes ?? 0} attributes, converted ${rep.stylesConverted ?? 0} style rules`);
      } catch (e: any) {
        if (e?.status === 413) {
          toast.toast('Too large even after cleaning; tracing it into simpler shapes instead', { ttl: 6000 });
          await runTrace(f, 'svg');
        } else toast.error(e);
      } finally { setBusy(false); }
      return;
    }
    if (!/^image\//.test(f.type)) { toast.error('Choose an SVG, PNG, JPEG, WebP or GIF'); return; }
    await runTrace(f, 'raster');
  }
  if (!domain) return <Callout>No mail domain yet.</Callout>;
  const previewUrl = trace ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trace.svg)}` : null;
  return (
    <div className="col gap-16">
      <Callout>Your logo appears beside messages from <b>@{domain}</b> inside Tern right away, and in mail clients that support <b>BIMI</b> once the DNS record from the setup tab is published and DMARC is at quarantine or reject. Drop in any image: SVGs are stripped of every trace of metadata and shrunk to fit; PNG, JPEG, WebP and GIF are converted to real vector shapes. Yahoo, Fastmail and others show it as is; Gmail and Apple Mail also need a Verified Mark Certificate (below).</Callout>
      <div className="card" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}>
        <div className="card-title"><h2>Current logo</h2>{brand && <span className="small muted">{Math.round(brand.size / 1024 * 10) / 10} KB of {Math.round(maxBytes / 1024)} KB · {brand.source} · updated {fmtRelative(brand.updated_at)}</span>}</div>
        <div className="row gap-16 wrap" style={{ alignItems: 'center' }}>
          <div style={{ width: 112, height: 112, borderRadius: 24, overflow: 'hidden', background: 'var(--bg-sunken)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--glow-soft)' }}>{brand ? <img src={`/bimi/${domain}.svg?v=${new Date(brand.updated_at).getTime()}`} alt="Brand logo" style={{ width: '100%', height: '100%' }} /> : <span className="faint small">none</span>}</div>
          <div className="col gap-4 flex-1">
            {brand ? <div className="small">Hosted at <code>{brand.url}</code> <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(brand.url); toast.success('Copied'); }}>Copy</Button></div> : <div className="small muted">No logo yet. Drop an image here, upload one, or generate a default avatar below.</div>}
            {brand?.report?.removedAttributes !== undefined && <div className="small muted">Last import: {Object.values(brand.report.removedElements ?? {}).reduce((a: number, b: any) => a + Number(b), 0)} metadata elements and {brand.report.removedAttributes} attributes removed, {brand.report.stylesConverted ?? 0} style rules converted, coordinates rounded to {brand.report.precision ?? 3} decimals.</div>}
            <div className="row gap-4 wrap"><Button size="sm" icon={<Upload size={13} />} loading={busy || Boolean(tracing)} onClick={() => input.current?.click()}>Upload image or SVG</Button>{brand && <Button size="sm" variant="ghost" onClick={() => runTrace(`/bimi/${domain}.svg?v=${new Date(brand.updated_at).getTime()}`, 'svg')}>Simplify by tracing</Button>}{brand && <Button size="sm" variant="ghost" onClick={() => api.del(`/api/brand/${domain}`).then(done)}>Remove</Button>}</div>
            <div className="help-text">Square works best. The result is SVG Tiny PS: no scripts, no external references, no bitmaps, no metadata, under {Math.round(maxBytes / 1024)} KB.</div>
            <input ref={input} type="file" accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }} />
          </div>
        </div>
        {tracing && <div className="row small mt-16"><Spinner size={14} /> {tracing}</div>}
        {trace && (
          <div className="mt-16" style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 14 }}>
            <div className="row wrap gap-16" style={{ alignItems: 'flex-start' }}>
              <div className="col" style={{ alignItems: 'center' }}><div className="small muted mb-8">Original</div><img src={trace.sourceUrl} alt="" style={{ width: 128, height: 128, objectFit: 'contain', borderRadius: 16, background: 'var(--bg-sunken)' }} /></div>
              <div className="col" style={{ alignItems: 'center' }}><div className="small muted mb-8">Traced vector</div><img src={previewUrl!} alt="" style={{ width: 128, height: 128, borderRadius: 16, background: 'var(--bg-sunken)' }} /></div>
              <div className="flex-1 col gap-4" style={{ minWidth: 240 }}>
                <div className="small"><b>{Math.round(trace.bytes / 1024 * 10) / 10} KB</b> · {trace.colors} colours · {trace.paths} paths · traced at {trace.step.size}px{trace.bytes > maxBytes ? <span style={{ color: 'var(--danger)' }}> · still over the limit</span> : ''}</div>
                <div className="form-grid-3">
                  <Field label={`Colours: ${traceOpts.colors}`}><input className="range" type="range" min={2} max={16} value={traceOpts.colors} onChange={(e) => setTraceOpts({ ...traceOpts, colors: Number(e.target.value) })} /></Field>
                  <Field label={`Detail: ${traceOpts.size}px`}><input className="range" type="range" min={32} max={160} step={8} value={traceOpts.size} onChange={(e) => setTraceOpts({ ...traceOpts, size: Number(e.target.value) })} /></Field>
                  <Field label={`Smoothing: ${traceOpts.tolerance}`}><input className="range" type="range" min={0.3} max={3} step={0.1} value={traceOpts.tolerance} onChange={(e) => setTraceOpts({ ...traceOpts, tolerance: Number(e.target.value) })} /></Field>
                </div>
                <div className="row wrap gap-4"><span className="small muted">Background:</span><Button size="sm" variant={traceOpts.background ? 'default' : 'soft'} onClick={() => setTraceOpts({ ...traceOpts, background: '' })}>transparent</Button><input type="color" value={traceOpts.background || '#ffffff'} onChange={(e) => setTraceOpts({ ...traceOpts, background: e.target.value })} style={{ width: 36, height: 28, border: 0, background: 'none' }} /></div>
                <div className="row gap-4 wrap"><Button size="sm" onClick={() => runTrace(trace.sourceUrl, trace.kind, { size: traceOpts.size, colors: traceOpts.colors, tolerance: traceOpts.tolerance })} loading={Boolean(tracing)}>Re-trace with these settings</Button><Button size="sm" variant="primary" icon={<Check size={13} />} loading={busy} disabled={trace.bytes > maxBytes} onClick={() => saveSvg(trace.svg, 'traced')}>Use this logo</Button><Button size="sm" variant="ghost" onClick={() => setTrace(null)}>Discard</Button></div>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-title"><h2>BIMI record</h2></div>
        {brand ? (
          <>
            <div className="small mb-8">Publish this TXT record at <code>default._bimi.{domain}</code> (it is also listed under DNS setup):</div>
            <div className="row"><code className="small" style={{ overflowWrap: 'anywhere', flex: 1 }}>{brand.record}</code><Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(brand.record); toast.success('Copied'); }}>Copy</Button></div>
            <Field label="Verified Mark Certificate URL (optional)" hint="Gmail and Apple Mail only show the logo with a VMC or CMC from DigiCert or Entrust. Host the .pem at a public https address and paste it here; it fills the a= part of the record." className="mt-16"><div className="row"><Input value={vmc} onChange={(e) => setVmc(e.target.value)} placeholder="https://outreach.example.com/bimi/vmc.pem" /><Button onClick={() => api.put(`/api/brand/${domain}/options`, { vmcUrl: vmc.trim() }).then(() => { done(); toast.success('Record updated'); }).catch((e) => toast.error(e))}>Save</Button></div></Field>
          </>
        ) : <div className="small muted">The record appears once a logo exists.</div>}
      </div>
      <div className="card">
        <div className="card-title"><h2>Generate a default avatar</h2></div>
        <div className="row gap-16 wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Initials"><Input value={initials} maxLength={3} onChange={(e) => setInitials(e.target.value.toUpperCase())} style={{ width: 90 }} /></Field>
          <Field label="Company name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Background"><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} style={{ width: 48, height: 36, border: 0, background: 'none' }} /></Field>
          <Field label="Text"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 48, height: 36, border: 0, background: 'none' }} /></Field>
          <div style={{ width: 64, height: 64, borderRadius: 14, background: bg, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 22, marginBottom: 14 }}>{initials || '?'}</div>
          <Button variant="primary" loading={busy} disabled={!initials} onClick={generate} style={{ marginBottom: 14 }}>Generate and use</Button>
        </div>
      </div>
    </div>
  );
}

function AdminAccess() {
  const toast = useToast();
  const [creds, setCreds] = useState<any>(null);
  const [show, setShow] = useState(false);
  const [pw, setPw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The mail server's master login: shown only after the admin's own password
  // is entered again, and every view is written to the audit log.
  async function reveal() {
    if (pw === null) { setPw(''); return; }
    setBusy(true);
    try { setCreds(await api.post('/api/stalwart/admin-access', { password: pw })); setShow(true); setPw(null); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <div className="col gap-16" style={{ maxWidth: 700 }}>
      <Callout>Two logins run the mail system. <b>Tern admins</b> (this app) create mailboxes, set DNS and brand, and manage users. The <b>Stalwart admin</b> is the mail server's own panel for everything else: domains, aliases, relay hosts, spam rules, queues and logs. The installer created both; the Stalwart one is kept in <code>.env</code> and shown here on request.</Callout>
      <div className="card">
        <div className="card-title"><h2>Stalwart admin panel</h2></div>
        {!show ? (pw === null ? <Button icon={<KeyRound size={15} />} onClick={reveal}>Show admin login</Button> : <div className="row"><Input type="password" placeholder="Your Tern password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 260 }} autoFocus autoComplete="current-password" onKeyDown={(e) => { if (e.key === 'Enter' && pw) void reveal(); }} /><Button variant="primary" loading={busy} disabled={!pw} onClick={reveal}>Show</Button><Button variant="ghost" onClick={() => setPw(null)}>Cancel</Button></div>) : (
          <dl className="kv">
            <dt>Panel</dt><dd>{creds.url ? <a href={creds.url} target="_blank" rel="noreferrer">{creds.url} <ExternalLink size={11} /></a> : creds.localUrl}</dd>
            <dt>Username</dt><dd><code>{creds.username}</code></dd>
            <dt>Password</dt><dd><code>{creds.password}</code> <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(creds.password); toast.success('Copied'); }}>Copy</Button></dd>
          </dl>
        )}
        <div className="help-text mt-8">Viewing this is written to the audit log. Change the password in the Stalwart panel and update <code>STALWART_ADMIN_PASSWORD</code> in <code>.env</code> afterwards, then <code>./bin/tern up</code>.</div>
      </div>
      <div className="card">
        <div className="card-title"><h2>What to do where</h2></div>
        <dl className="kv">
          <dt>Mailboxes</dt><dd>Here, under Mailboxes (also creates the Tern login).</dd>
          <dt>DNS and logo</dt><dd>Here, under DNS setup and Brand logo.</dd>
          <dt>Aliases, extra domains</dt><dd>Stalwart panel → Directory.</dd>
          <dt>Relay through SES/Mailgun</dt><dd>Stalwart panel → Delivery → Routes → Relay host.</dd>
          <dt>Spam filter, quotas</dt><dd>Stalwart panel → Spam filter, Storage.</dd>
          <dt>Queue and logs</dt><dd>Stalwart panel → Queue, or <code>./bin/tern logs stalwart</code>.</dd>
        </dl>
      </div>
    </div>
  );
}
