import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Check, Download, KeyRound, Plus, RefreshCw, Sparkles, Trash2, Wifi, WifiOff, Pencil, Shield, Palette, Mail, Server, Copy, UserCircle, Upload, Monitor, Sun, Moon, Smartphone, Lock, Inbox, Wrench } from 'lucide-react';
import { api, apiStream } from '../api';
import { useAuth } from '../state/auth';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { useToast } from '../state/toast';
import { useAccounts, useAiStatus, type Account } from '../lib/queries';
import { Badge, Button, Callout, ColorPicker, Confirm, Field, IconButton, Input, Modal, PageHeader, Progress, Segmented, Select, Spinner, Textarea, Toggle } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { getAppearance, setAppearance, onAppearance, type Theme, type Appearance } from '../state/theme';
import { PALETTES, BACKGROUNDS } from '../lib/palettes';
import { Avatar } from '../components/ui';
import { useMailPrefs } from '../state/mailPrefs';
import { fmtDateTime, fmtRelative, cls, describeUa } from '../lib/format';
import { DataTable } from '../components/DataTable';
import MailAppsSettings from './MailApps';
import EncryptionSettings from './Encryption';

// Settings is about you: your login, your mailboxes, how the app looks and
// behaves for you. Workspace-wide things (users, the mail server, the AI
// model, branding) live under Admin, in pages/AdminSettings.tsx, and the
// server refuses their endpoints to non-admins regardless of the UI.
export default function SettingsPage() {
  const { user } = useAuth();
  const admin = user!.role === 'admin';
  const tabs: [string, string, ReactNode][] = [
    ['profile', 'Profile', <UserCircle size={15} />], ['accounts', 'Accounts', <Mail size={15} />], ['mailapps', 'Mail apps', <Smartphone size={15} />],
    ['mail', 'Mail', <Inbox size={15} />], ['ai', 'AI assistant', <Sparkles size={15} />], ['appearance', 'Appearance', <Palette size={15} />], ['security', 'Security', <Shield size={15} />], ['encryption', 'Encryption', <Lock size={15} />],
  ];
  return (
    <div className="page">
      <div className="settings-head row wrap mb-8">
        <div className="flex-1"><h1>Settings</h1><div className="small muted">Your login, mailboxes and preferences.</div></div>
        {admin && <NavLink to="/admin/general" className="btn"><Wrench size={15} />Admin settings</NavLink>}
      </div>
      <div className="tabs settings-tabs">
        {tabs.map(([k, l, i]) => <NavLink key={k} to={`/settings/${k}`} className={({ isActive }) => cls(isActive && 'active')}>{i}{l}</NavLink>)}
      </div>
      <Routes>
        <Route path="profile" element={<ProfileSettings />} />
        <Route path="accounts" element={<AccountsSettings />} />
        <Route path="mailapps" element={<MailAppsSettings />} />
        <Route path="mail" element={<MailSettings />} />
        <Route path="ai" element={<AiSettings />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="encryption" element={<EncryptionSettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        {/* Old links to the admin pages keep working. */}
        <Route path="general" element={<Navigate to="/admin/general" replace />} />
        <Route path="users" element={<Navigate to="/admin/users" replace />} />
        <Route path="mailserver" element={<Navigate to="/admin/mailserver" replace />} />
        <Route path="*" element={<Navigate to="/settings/accounts" replace />} />
      </Routes>
    </div>
  );
}

// ---------------- Accounts ----------------

function AccountsSettings() {
  const { data: accounts = [], isLoading } = useAccounts();
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(params.get('welcome') === '1');
  const [editing, setEditing] = useState<Account | null>(null);
  return (
    <div>
      {params.get('welcome') === '1' && !accounts.length && <Callout kind="success">Welcome. Connect the first mailbox to start syncing; the sending policy for sequences lives on each account.</Callout>}
      {params.get('welcome') === '1' && accounts.length > 0 && <Callout kind="success">Welcome. Your mailbox <b>{accounts[0].email}</b> was created on the mail server and is syncing. To read it on a phone or in a desktop app, find its password and server details under <NavLink to="/settings/mailapps">Mail apps</NavLink>.</Callout>}
      <PageHeader title="Mail accounts" sub="Each account is a JMAP mailbox: Fastmail, Stalwart or any other server. Tern syncs a local copy, sends through the server, and keeps a sending policy per mailbox." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add account</Button>} />
      {isLoading && <Spinner />}
      <div className="col gap-12">{accounts.map((a) => <AccountCard key={a.id} a={a} onEdit={() => setEditing(a)} />)}</div>
      {adding && <AddAccount onClose={() => setAdding(false)} />}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountCard({ a, onEdit }: { a: Account; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: stats } = useQuery({ queryKey: ['account-stats', a.id], queryFn: () => api.get<any>(`/api/accounts/${a.id}/stats`), refetchInterval: 60_000 });
  const [del, setDel] = useState(false);
  return (
    <div className="card">
      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <span className="avatar" style={{ background: a.color }}>{a.name.slice(0, 1).toUpperCase()}</span>
        <div className="flex-1">
          <div className="row wrap gap-4"><span className="strong">{a.name}</span><span className="muted">{a.email}</span><Badge>{a.provider}</Badge>{!a.enabled && <Badge kind="warning">paused</Badge>}</div>
          <div className="row wrap gap-12 small muted mt-8">
            <span className="row gap-4"><span className={cls('sync-dot', a.sync_status)} />{a.sync_status === 'idle' ? `synced ${a.last_sync_at ? fmtRelative(a.last_sync_at) : 'never'}` : a.sync_status === 'syncing' ? 'syncing…' : a.sync_status === 'auth_error' ? 'credentials rejected' : `error: ${a.sync_error}`}</span>
            <span className="row gap-4">{a.push?.push === 'connected' ? <Wifi size={13} /> : <WifiOff size={13} />}{a.has_push ? `push ${a.push?.push ?? 'off'}` : 'polling only'}</span>
            <span>{a.has_submission ? 'sends via JMAP' : a.has_smtp ? 'sends via SMTP' : 'no send path'}</span>
            {!a.initial_sync_done && <span>initial sync in progress</span>}
          </div>
          {a.sync_error && a.sync_status !== 'idle' && <div className="small mt-8" style={{ color: 'var(--danger)' }}>{a.sync_error}</div>}
          {stats && (
            <div className="mt-16" style={{ maxWidth: 520 }}>
              <div className="row small mb-8"><span className="strong">Today</span><span className="muted">{stats.sentToday} of {stats.dailyCap} sends</span><span className="ml-auto muted">{stats.windowOpen ? 'window open' : `window opens ${fmtRelative(stats.nextWindowOpen)}`}</span></div>
              <Progress value={stats.sentToday} max={stats.dailyCap} />
              <div className="small faint mt-8">{stats.windowText} · delay {a.jitter_enabled ? `${a.jitter_min_s}–${a.jitter_max_s}s` : 'off'} · last 7 days: {stats.week.sent} sent, {stats.week.replied} replied{stats.week.bounced ? `, ${stats.week.bounced} bounced` : ''}{stats.week.failed ? `, ${stats.week.failed} failed` : ''}</div>
            </div>
          )}
        </div>
        <div className="row gap-4 card-actions">
          <IconButton label="Sync now" onClick={() => api.post(`/api/accounts/${a.id}/resync`).then(() => toast.toast('Sync started'))}><RefreshCw size={16} /></IconButton>
          <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>Edit</Button>
          <IconButton label="Remove" onClick={() => setDel(true)}><Trash2 size={16} /></IconButton>
        </div>
      </div>
      <Confirm open={del} onClose={() => setDel(false)} danger title={`Remove ${a.email}?`} message="The local copy of its mail and its send history are deleted. Nothing changes on the mail server." confirmLabel="Remove" onConfirm={async () => { await api.del(`/api/accounts/${a.id}`); qc.invalidateQueries({ queryKey: ['accounts'] }); qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['mailboxes'] }); }} />
    </div>
  );
}

function AddAccount({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: presets } = useQuery({ queryKey: ['presets'], queryFn: () => api.get<any>('/api/accounts/presets') });
  const [provider, setProvider] = useState<'fastmail' | 'stalwart' | 'jmap'>('fastmail');
  const [sessionUrl, setSessionUrl] = useState('');
  const [authType, setAuthType] = useState<'bearer' | 'basic'>('bearer');
  const [authUser, setAuthUser] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [color, setColor] = useState('#4f6df5');
  const [pinOrigin, setPinOrigin] = useState<boolean | undefined>(undefined);
  const [test, setTest] = useState<any>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [step, setStep] = useState(0);
  const local = presets?.localStalwart;
  useEffect(() => {
    setTest(null);
    if (provider === 'fastmail') { setAuthType('bearer'); setSessionUrl(''); }
    else { setAuthType('basic'); if (provider === 'stalwart' && local?.sessionUrl) setSessionUrl(local.sessionUrl); else setSessionUrl(''); }
  }, [provider, local]);
  async function doTest() {
    setBusy('test');
    try {
      const r = await api.post<any>('/api/accounts/test', { provider, sessionUrl: sessionUrl || undefined, authType, authUser: authUser || undefined, secret, pinOrigin });
      setTest(r);
      if (r.ok) { if (!email) setEmail(r.email || authUser); if (!name) setName((r.identities?.[0]?.name) || (r.email || authUser).split('@')[0]); setStep(1); }
    } catch (e: any) { setTest({ ok: false, error: e.message }); } finally { setBusy(null); }
  }
  async function save() {
    setBusy('save');
    try {
      await api.post('/api/accounts', { provider, sessionUrl: sessionUrl || undefined, authType, authUser: authUser || undefined, secret, pinOrigin, name, email, color });
      qc.invalidateQueries({ queryKey: ['accounts'] }); qc.invalidateQueries({ queryKey: ['mailboxes'] });
      toast.success('Account connected; first sync running');
      onClose();
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  }
  const help = presets?.presets?.[provider]?.help;
  return (
    <Modal open onClose={onClose} title="Connect a mailbox" size="wide" footer={step === 0 ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'test'} disabled={!secret || (authType === 'basic' && !authUser)} onClick={doTest}>Test connection</Button></> : <><Button onClick={() => setStep(0)}>Back</Button><Button variant="primary" loading={busy === 'save'} disabled={!name || !email} onClick={save}>Connect</Button></>}>
      {step === 0 ? (
        <>
          <Segmented value={provider} onChange={setProvider} options={[{ value: 'fastmail', label: 'Fastmail' }, { value: 'stalwart', label: local ? 'Stalwart (this server)' : 'Stalwart' }, { value: 'jmap', label: 'Other JMAP' }]} />
          <div className="mt-16">
            {help && <Callout>{help}{provider === 'stalwart' && local && <> Admins can create mailboxes on the bundled server under Admin → Mail server, which also connects them here in one step.</>}</Callout>}
            {provider !== 'fastmail' && <Field label="Session URL" hint="Usually https://your-mail-host/.well-known/jmap" className="mt-16"><Input value={sessionUrl} onChange={(e) => setSessionUrl(e.target.value)} placeholder="https://mail.example.com/.well-known/jmap" /></Field>}
            {provider === 'jmap' && <Field label="Authentication"><Select value={authType} onChange={(e) => setAuthType(e.target.value as any)}><option value="basic">Username and password (HTTP Basic)</option><option value="bearer">Bearer token</option></Select></Field>}
            <div className="form-row mt-16">
              {authType === 'basic' && <Field label="Mailbox address or username"><Input value={authUser} onChange={(e) => setAuthUser(e.target.value)} placeholder="alex@team.example.com" autoComplete="off" /></Field>}
              <Field label={authType === 'bearer' ? 'API token' : 'Password or app password'}><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" /></Field>
            </div>
            {provider === 'jmap' && <div className="row"><Toggle checked={pinOrigin ?? false} onChange={setPinOrigin} /><span className="small">Rewrite server URLs to the session URL's host (needed when the server advertises a hostname this app cannot reach)</span></div>}
            {test && !test.ok && <Callout kind="danger">{test.error}</Callout>}
          </div>
        </>
      ) : (
        <>
          <Callout kind="success"><Check size={14} /> Connected as <b>{test.username || authUser}</b>{test.hasSubmission ? ' · can send via JMAP' : ' · no JMAP submission (configure SMTP after adding)'}{test.hasPush ? ' · push updates available' : ' · polling only'}</Callout>
          <div className="form-row mt-16">
            <Field label="Display name" hint="Used as the From name on everything sent."><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Email address"><Input value={email} onChange={(e) => setEmail(e.target.value)} />{test.identities?.length > 1 && <Select className="mt-8" value={email} onChange={(e) => setEmail(e.target.value)}>{test.identities.map((i: any) => <option key={i.email} value={i.email}>{i.name} &lt;{i.email}&gt;</option>)}</Select>}</Field>
          </div>
          <Field label="Colour"><ColorPicker value={color} onChange={setColor} /></Field>
        </>
      )}
    </Modal>
  );
}

const TZS = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Lisbon', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Australia/Sydney', 'Pacific/Auckland', 'Africa/Johannesburg', 'Africa/Lagos'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function EditAccount({ account, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'sending' | 'identity' | 'connection'>('sending');
  const [f, setF] = useState({ name: account.name, color: account.color, voice: account.voice ?? '', dailyCap: account.daily_cap, jitterEnabled: account.jitter_enabled, jitterMinS: account.jitter_min_s, jitterMaxS: account.jitter_max_s, sendWindow: { ...account.send_window, days: [...(account.send_window.days ?? [])] }, syncLimit: account.sync_limit, enabled: account.enabled, sendVia: account.send_via, smtp: account.smtp ? { ...account.smtp, pass: '' } : { host: '', port: 465, secure: true, user: '', pass: '' }, useSmtp: Boolean(account.smtp), secret: '', authUser: account.auth_user ?? '', sessionUrl: account.session_url, pinOrigin: account.pin_origin });
  const sig = useRef(account.signature_html);
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  async function save() {
    setBusy(true);
    try {
      const body: any = { name: f.name, color: f.color, signatureHtml: sig.current, voice: f.voice, dailyCap: f.dailyCap, jitterEnabled: f.jitterEnabled, jitterMinS: f.jitterMinS, jitterMaxS: f.jitterMaxS, sendWindow: f.sendWindow, syncLimit: f.syncLimit, enabled: f.enabled, sendVia: f.sendVia, smtp: f.useSmtp ? { host: f.smtp.host, port: Number(f.smtp.port), secure: f.smtp.secure, user: f.smtp.user, pass: f.smtp.pass || undefined } : null };
      if (f.secret) body.secret = f.secret;
      if (f.authUser !== (account.auth_user ?? '')) body.authUser = f.authUser;
      if (f.sessionUrl !== account.session_url) body.sessionUrl = f.sessionUrl;
      if (f.pinOrigin !== account.pin_origin) body.pinOrigin = f.pinOrigin;
      await api.put(`/api/accounts/${account.id}`, body);
      qc.invalidateQueries({ queryKey: ['accounts'] }); qc.invalidateQueries({ queryKey: ['account-stats', account.id] });
      toast.success('Saved'); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  useEffect(() => { if (tab === 'identity') setTimeout(() => editor.current?.setHtml(sig.current), 0); }, [tab]);
  const perDayEstimate = f.jitterEnabled ? Math.round(((f.sendWindow.end - f.sendWindow.start) * 3600) / Math.max(1, (f.jitterMinS + f.jitterMaxS) / 2)) : null;
  return (
    <Modal open onClose={onClose} title={`${account.email}`} size="wide" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="tabs"><button className={tab === 'sending' ? 'active' : ''} onClick={() => setTab('sending')}>Sending policy</button><button className={tab === 'identity' ? 'active' : ''} onClick={() => setTab('identity')}>Identity & signature</button><button className={tab === 'connection' ? 'active' : ''} onClick={() => setTab('connection')}>Connection</button></div>
      {tab === 'sending' && (
        <>
          <Callout>These limits apply to sequences and to "send with a natural delay". Manual sends are never blocked. A new mailbox should start low, around 20 to 30 a day, and rise over a few weeks.</Callout>
          <div className="form-row mt-16">
            <Field label="Daily cap" hint="Automated sends per local day."><Input type="number" min={0} max={5000} value={f.dailyCap} onChange={(e) => set({ dailyCap: Number(e.target.value) })} /></Field>
            <Field label="Timezone for the window"><Select value={f.sendWindow.tz} onChange={(e) => set({ sendWindow: { ...f.sendWindow, tz: e.target.value } })}>{[...new Set([f.sendWindow.tz, ...TZS])].map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
            <Field label="Window starts"><Select value={f.sendWindow.start} onChange={(e) => set({ sendWindow: { ...f.sendWindow, start: Number(e.target.value) } })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select></Field>
            <Field label="Window ends"><Select value={f.sendWindow.end} onChange={(e) => set({ sendWindow: { ...f.sendWindow, end: Number(e.target.value) } })}>{Array.from({ length: 24 }, (_, h) => <option key={h + 1} value={h + 1}>{String(h + 1).padStart(2, '0')}:00</option>)}</Select></Field>
          </div>
          <Field label="Days"><div className="row gap-4">{DAYS.map((d, i) => <button key={d} type="button" className={cls('btn btn-sm', f.sendWindow.days.includes(i) && 'btn-primary')} onClick={() => set({ sendWindow: { ...f.sendWindow, days: f.sendWindow.days.includes(i) ? f.sendWindow.days.filter((x) => x !== i) : [...f.sendWindow.days, i].sort() } })}>{d}</button>)}</div></Field>
          <div className="row mb-8"><Toggle checked={f.jitterEnabled} onChange={(v) => set({ jitterEnabled: v })} /><div><div className="strong small">Randomised delay between automated sends</div><div className="help-text">Each send waits a random gap inside this range, so messages leave at irregular, human-looking intervals instead of exactly on the minute.</div></div></div>
          {f.jitterEnabled && (
            <div className="form-row">
              <Field label="Minimum gap (seconds)"><Input type="number" min={0} value={f.jitterMinS} onChange={(e) => set({ jitterMinS: Number(e.target.value) })} /></Field>
              <Field label="Maximum gap (seconds)"><Input type="number" min={0} value={f.jitterMaxS} onChange={(e) => set({ jitterMaxS: Number(e.target.value) })} /></Field>
            </div>
          )}
          {perDayEstimate !== null && <div className="small muted">At this gap the window fits roughly {perDayEstimate} sends; the daily cap of {f.dailyCap} {perDayEstimate < f.dailyCap ? 'will not be reached' : 'is the binding limit'}.</div>}
          <div className="row mt-16"><Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} /><span className="small">Account enabled (syncing and sending)</span></div>
        </>
      )}
      {tab === 'identity' && (
        <>
          <div className="form-row"><Field label="Display name"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field><Field label="Colour"><ColorPicker value={f.color} onChange={(c) => set({ color: c })} /></Field></div>
          <Field label="Signature" hint="Appended to every message sent from this account, including sequences."><div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}><Editor ref={editor} initialHtml={sig.current} minHeight={120} placeholder="Alex Rivera · Tern · +1 555 0100" onChange={(h) => { sig.current = h; }} /></div></Field>
          <Field label="Writing voice for the AI" hint="How this account writes. Given to the model for every draft, reply, responder and campaign sent from it."><Textarea value={f.voice} onChange={(e) => set({ voice: e.target.value })} placeholder="Plain and warm. Short sentences. First names. Never 'I hope this email finds you well'. Sign off with 'Best, Alex'." style={{ minHeight: 80 }} /></Field>
          <Field label="Messages to keep locally" hint="Newest N messages are synced on the first run; more can be loaded later."><Input type="number" min={100} max={50000} value={f.syncLimit} onChange={(e) => set({ syncLimit: Number(e.target.value) })} /></Field>
        </>
      )}
      {tab === 'connection' && (
        <>
          <div className="form-row">
            <Field label="Session URL"><Input value={f.sessionUrl} onChange={(e) => set({ sessionUrl: e.target.value })} /></Field>
            {account.auth_type === 'basic' && <Field label="Username"><Input value={f.authUser} onChange={(e) => set({ authUser: e.target.value })} /></Field>}
            <Field label={account.auth_type === 'bearer' ? 'New API token' : 'New password'} hint="Leave blank to keep the current one."><Input type="password" value={f.secret} onChange={(e) => set({ secret: e.target.value })} autoComplete="new-password" /></Field>
          </div>
          <div className="row mb-16"><Toggle checked={f.pinOrigin} onChange={(v) => set({ pinOrigin: v })} /><span className="small">Rewrite advertised server URLs to the session URL's host</span></div>
          <div className="divider" />
          <div className="row mb-8"><Toggle checked={f.useSmtp} onChange={(v) => set({ useSmtp: v })} /><div><div className="strong small">SMTP fallback</div><div className="help-text">Only needed if the server lacks JMAP submission{account.has_submission ? ' (yours has it)' : ''}. The sent copy is still filed via JMAP.</div></div></div>
          {f.useSmtp && <>
            <div className="form-grid-3">
              <Field label="Host"><Input value={f.smtp.host} onChange={(e) => set({ smtp: { ...f.smtp, host: e.target.value } })} placeholder="smtp.fastmail.com" /></Field>
              <Field label="Port"><Input type="number" value={f.smtp.port} onChange={(e) => set({ smtp: { ...f.smtp, port: Number(e.target.value) } })} /></Field>
              <Field label="TLS"><Select value={f.smtp.secure ? '1' : '0'} onChange={(e) => set({ smtp: { ...f.smtp, secure: e.target.value === '1' } })}><option value="1">Implicit TLS (465)</option><option value="0">STARTTLS (587)</option></Select></Field>
            </div>
            <div className="form-row">
              <Field label="Username"><Input value={f.smtp.user} onChange={(e) => set({ smtp: { ...f.smtp, user: e.target.value } })} /></Field>
              <Field label="Password" hint="Leave blank to keep."><Input type="password" value={f.smtp.pass} onChange={(e) => set({ smtp: { ...f.smtp, pass: e.target.value } })} autoComplete="new-password" /></Field>
            </div>
            <Field label="Send via"><Select value={f.sendVia} onChange={(e) => set({ sendVia: e.target.value as any })}><option value="jmap">JMAP submission (preferred)</option><option value="smtp">SMTP</option></Select></Field>
          </>}
        </>
      )}
    </Modal>
  );
}

// ---------------- AI (what everyone sees) ----------------

export function AiStatusLine({ data, admin }: { data: any; admin: boolean }) {
  if (admin) {
    return (
      <>
        <div className="row mb-8 wrap"><span className={cls('sync-dot', data.health.ok ? 'idle' : 'error')} /><span className="strong">{data.settings.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible endpoint'}</span><span className="muted small">{data.health.ok ? `reachable${data.health.version ? `, v${data.health.version}` : ''}` : `unreachable: ${data.health.error}`}</span><span className="ml-auto small muted">{data.totalMemGiB} GB RAM on this machine</span></div>
        <div className="row wrap gap-12 small">
          <span>Model in use: <b>{data.settings.model}</b> {data.settings.provider === 'ollama' && (data.modelInstalled ? <Badge kind="success">installed</Badge> : <Badge kind="danger">not downloaded</Badge>)}</span>
          {data.loaded?.length > 0 && <span className="muted">loaded in memory: {data.loaded.map((m: any) => m.name).join(', ')}</span>}
        </div>
      </>
    );
  }
  const ok = data.settings.enabled && data.health.ok && data.modelInstalled;
  return <div className="row wrap"><span className={cls('sync-dot', ok ? 'idle' : 'error')} /><span className="strong">{ok ? 'The assistant is available' : 'The assistant is unavailable right now'}</span><span className="muted small">{data.settings.enabled ? `model ${data.settings.model}` : 'turned off by an admin'}</span></div>;
}

export function AiPlayground({ enabled }: { enabled: boolean }) {
  const toast = useToast();
  const [testOut, setTestOut] = useState('');
  const [testing, setTesting] = useState(false);
  const [playInstruction, setPlayInstruction] = useState('Write two friendly sentences confirming the assistant works and mention that it runs locally.');
  const [playMode, setPlayMode] = useState<'compose' | 'reply' | 'subject' | 'rewrite'>('compose');
  const [playDraft, setPlayDraft] = useState('');
  async function test() {
    setTesting(true); setTestOut('');
    try { await apiStream('/api/ai/draft', { mode: playMode, instruction: playInstruction || undefined, draft: playDraft || undefined, length: 'short' }, { onEvent: (ev, d) => { if (ev === 'token') setTestOut((o) => o + d.t); if (ev === 'error') toast.error(d.error); } }); } catch (e) { toast.error(e); } finally { setTesting(false); }
  }
  return (
    <div className="card mb-16">
      <div className="card-title"><h2>Playground</h2><span className="small muted">Uses the saved system prompt and tuning</span></div>
      <div className="row mb-8"><Select className="input-sm" style={{ width: 150 }} value={playMode} onChange={(e) => setPlayMode(e.target.value as any)}><option value="compose">Draft</option><option value="reply">Reply</option><option value="rewrite">Rewrite</option><option value="subject">Subject line</option></Select><Input className="input-sm" value={playInstruction} onChange={(e) => setPlayInstruction(e.target.value)} placeholder="Instruction" /></div>
      {(playMode === 'rewrite' || playMode === 'subject' || playMode === 'reply') && <Textarea className="mb-8" value={playDraft} onChange={(e) => setPlayDraft(e.target.value)} placeholder={playMode === 'reply' ? 'Paste the message you are replying to' : 'Paste the draft to work on'} style={{ minHeight: 70 }} />}
      <div className="row"><Button size="sm" variant="ai" icon={<Sparkles size={14} />} loading={testing} onClick={test} disabled={!enabled}>Run</Button></div>
      {testOut && <div className="ai-preview mt-8">{testOut}</div>}
    </div>
  );
}

function AiSettings() {
  const { user } = useAuth();
  const { data, isLoading } = useAiStatus();
  const admin = user!.role === 'admin';
  if (isLoading || !data) return <Spinner />;
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="AI assistant" sub="Drafts, replies, rewrites, summaries and per-contact personalisation, generated on this server." actions={admin ? <NavLink className="btn" to="/admin/ai"><Server size={15} />Model and provider</NavLink> : undefined} />
      <div className="card mb-16"><AiStatusLine data={data} admin={admin} /></div>
      <AiPlayground enabled={Boolean(data.settings.enabled)} />
      <div className="card">
        <div className="card-title"><h2>What the assistant never does on its own</h2></div>
        <ul className="tips">
          <li><b>Automated mail is checked before it leaves.</b> A responder in send mode or a sequence step that still contains a merge field, a placeholder like "[Your Name]", echoed prompt text or an "as an AI" line is held in <NavLink to="/review">AI review</NavLink> instead of being sent.</li>
          <li><b>Every request is a fresh conversation.</b> Nothing from other people's mail or earlier requests is carried over.</li>
          <li><b>Encrypted mail stays closed.</b> The assistant does not see inside messages encrypted to your key.</li>
        </ul>
        {!admin && <div className="help-text mt-8">Only admins change the model and provider. Ask an admin if drafting is unavailable.</div>}
      </div>
    </div>
  );
}

// ---------------- Security ----------------

function SecuritySettings() {
  const { user, refresh, setUser } = useAuth();
  const toast = useToast();
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState(''); const [delCode, setDelCode] = useState(''); const [delConfirm, setDelConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  async function deleteAccount() {
    setDeleting(true);
    try { await api.post('/api/auth/delete-account', { password: delPw, code: delCode || undefined, confirm: delConfirm }); toast.success('Your account has been deleted'); setUser(null); } catch (e) { toast.error(e); } finally { setDeleting(false); }
  }
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [conf, setConf] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauth: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pw, setPw] = useState('');
  const { data: sessions, refetch } = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ sessions: any[] }>('/api/auth/sessions') });
  async function changePw() {
    if (next !== conf) { toast.error('Passwords do not match'); return; }
    try { await api.post('/api/auth/password', { current: cur, next }); toast.success('Password changed; other sessions signed out'); setCur(''); setNext(''); setConf(''); refetch(); } catch (e) { toast.error(e); }
  }
  async function startTotp() {
    try { const r = await api.post<any>('/api/auth/totp/setup'); const qr = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 180 }); setSetup({ ...r, qr }); } catch (e) { toast.error(e); }
  }
  async function enable() {
    try { const r = await api.post<any>('/api/auth/totp/enable', { code }); setCodes(r.recoveryCodes); setSetup(null); setCode(''); await refresh(); toast.success('Two-factor enabled'); } catch (e) { toast.error(e); }
  }
  async function disable() {
    try { await api.post('/api/auth/totp/disable', { password: pw }); setPw(''); await refresh(); toast.success('Two-factor disabled'); } catch (e) { toast.error(e); }
  }
  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title="Security" sub={`Signed in as ${user!.username}`} />
      <div className="card mb-16">
        <h2 className="mb-8">Change password</h2>
        <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <div className="form-row"><Field label="New password" hint="At least 10 characters."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field><Field label="Confirm"><Input type="password" value={conf} onChange={(e) => setConf(e.target.value)} autoComplete="new-password" /></Field></div>
        <Button variant="primary" disabled={!cur || next.length < 10} onClick={changePw}>Update password</Button>
      </div>
      <div className="card mb-16">
        <div className="card-title"><h2>Two-factor authentication</h2>{user!.totp_enabled ? <Badge kind="success">on</Badge> : <Badge>off</Badge>}</div>
        {!user!.totp_enabled && !setup && <><p className="muted small">Adds a 6-digit code from an authenticator app at sign-in. Recovery codes are shown once.</p><Button icon={<KeyRound size={15} />} onClick={startTotp}>Set up</Button></>}
        {setup && (
          <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
            <img src={setup.qr} alt="QR code" width={180} height={180} style={{ borderRadius: 8, background: '#fff' }} />
            <div className="flex-1">
              <p className="small">Scan with any authenticator app, or enter the key manually: <code>{setup.secret}</code></p>
              <Field label="Code from the app"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" /></Field>
              <div className="row"><Button variant="primary" onClick={enable} disabled={code.length < 6}>Turn on</Button><Button variant="ghost" onClick={() => setSetup(null)}>Cancel</Button></div>
            </div>
          </div>
        )}
        {codes && <Callout kind="warning"><div className="strong mb-8">Recovery codes. Save them now; they are not shown again.</div><div className="mono small" style={{ columns: 2 }}>{codes.map((c) => <div key={c}>{c}</div>)}</div></Callout>}
        {user!.totp_enabled && !codes && <div className="row mt-8"><Input type="password" placeholder="Password to confirm" value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 260 }} /><Button variant="danger" disabled={!pw} onClick={disable}>Turn off</Button><Button disabled={!pw} onClick={() => api.post<any>('/api/auth/totp/recovery', { password: pw }).then((r) => { setCodes(r.recoveryCodes); setPw(''); }).catch((e) => toast.error(e))}>New recovery codes</Button></div>}
      </div>
      <div className="card">
        <div className="card-title"><h2>Sessions</h2><Button size="sm" variant="ghost" onClick={() => api.post('/api/auth/sessions/revoke', { all: true }).then(() => { refetch(); toast.success('Other sessions signed out'); })}>Sign out everywhere else</Button></div>
        <DataTable rows={sessions?.sessions ?? []} rowKey={(s) => s.id} cardSize="sm" columns={[
          { key: 'client', header: 'Client', primary: true, cell: (s) => <span className="row gap-4 wrap"><span>{describeUa(s.user_agent)}</span>{s.current ? <Badge kind="success">this device</Badge> : null}</span> },
          { key: 'ua', secondary: true, className: 'small muted', cell: (s) => <span className="truncate" style={{ display: 'inline-block', maxWidth: 320, verticalAlign: 'bottom' }} title={s.user_agent}>{s.user_agent || 'unknown client'}</span> },
          { key: 'seen', header: 'Last active', className: 'small muted', nowrap: true, cell: (s) => fmtRelative(s.last_seen_at) },
          { key: 'started', header: 'Signed in', className: 'small muted', nowrap: true, cell: (s) => fmtDateTime(s.created_at) },
          { key: 'act', actions: true, cell: (s) => !s.current && <Button size="sm" variant="ghost" onClick={() => api.post('/api/auth/sessions/revoke', { id: s.fullId }).then(() => refetch())}>Sign out</Button> },
        ]} />
      </div>
      <div className="card mt-16">
        <div className="card-title"><h2>Your data</h2></div>
        <p className="muted small">Everything this server stores about you, as one JSON file: connected mailboxes and their local mail copy, contacts, templates, sequences, drafts, send history, settings and sessions. Passwords, two-factor secrets and mailbox credentials are never included. Deleting the account removes all of it from Tern; mail on the mail server itself is untouched.</p>
        <div className="row wrap">
          <a className="btn" href="/api/auth/export" download><Download size={15} />Export my data</a>
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { setDelPw(''); setDelCode(''); setDelConfirm(''); setDelOpen(true); }}>Delete my account</Button>
        </div>
      </div>
      <Modal open={delOpen} onClose={() => setDelOpen(false)} title="Delete your account" footer={<><Button onClick={() => setDelOpen(false)}>Cancel</Button><Button variant="danger" loading={deleting} disabled={!delPw || delConfirm.trim().toLowerCase() !== user!.username.toLowerCase() || (user!.totp_enabled && !delCode)} onClick={deleteAccount}>Delete everything</Button></>}>
        <Callout kind="danger">This removes your login and, with it, every mailbox connection, the local copy of that mail, your contacts, sequences, templates, drafts and history. It cannot be undone. Export first if you want a copy.</Callout>
        <Field label="Password" className="mt-16"><Input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} autoComplete="current-password" /></Field>
        {user!.totp_enabled && <Field label="Two-factor code"><Input inputMode="numeric" value={delCode} onChange={(e) => setDelCode(e.target.value)} placeholder="123456 or a recovery code" /></Field>}
        <Field label={`Type your username (${user!.username}) to confirm`}><Input value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} autoCapitalize="none" /></Field>
      </Modal>
    </div>
  );
}

// ---------------- Appearance ----------------

function AppearanceSettings() {
  const [a, setA] = useState<Appearance>(getAppearance());
  useEffect(() => onAppearance(setA), []);
  const set = (patch: Partial<Appearance>) => setA(setAppearance(patch));
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Appearance" sub="Theme, colour palette and the living background. Saved to this browser and to your profile, so it follows you." />
      <div className="card mb-16">
        <h2 className="mb-8">Theme</h2>
        <div className="segmented">{(['system', 'light', 'dark'] as Theme[]).map((t) => <button key={t} className={a.theme === t ? 'active' : ''} onClick={() => set({ theme: t })}>{t === 'system' ? <Monitor size={14} /> : t === 'light' ? <Sun size={14} /> : <Moon size={14} />} {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}</button>)}</div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Colour palette</h2>
        <div className="swatches">{PALETTES.map((p) => <button key={p.key} type="button" className={cls('swatch-card', a.palette === p.key && 'active')} onClick={() => set({ palette: p.key })}><div className="bar" style={{ background: `linear-gradient(120deg, ${p.gradient.join(', ')})` }} /><div className="name">{p.name}</div><div className="hint">{a.palette === p.key ? 'in use' : p.hint}</div></button>)}</div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Background</h2>
        <p className="muted small">Fifteen WebGL2 shaders drawn at a low resolution on the GPU, capped at 30 frames per second, paused when the tab is hidden. Calm ones stay out of the way all day; lively ones are for showing off. Choose Plain for a flat colour.</p>
        <div className="swatches">{(['calm', 'lively', 'none'] as const).map((mood) => <Fragment key={mood}><div className="swatch-group">{mood === 'calm' ? 'Calm' : mood === 'lively' ? 'Lively' : 'Off'}</div>{BACKGROUNDS.filter((b) => b.mood === mood).map((b) => <button key={b.key} type="button" className={cls('swatch-card', a.background === b.key && 'active')} onClick={() => set({ background: b.key })}><div className={`bar bg-preview-${b.key}`} /><div className="name">{b.name}</div><div className="hint">{b.hint}</div></button>)}</Fragment>)}</div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Glass</h2>
        <p className="muted small">How translucent the panels are. Strong looks best over a lively background; Subtle keeps text crisp on slower machines.</p>
        <div className="segmented"><button className={a.glass === 'subtle' ? 'active' : ''} onClick={() => set({ glass: 'subtle' })}>Subtle</button><button className={a.glass === 'balanced' ? 'active' : ''} onClick={() => set({ glass: 'balanced' })}>Balanced</button><button className={a.glass === 'strong' ? 'active' : ''} onClick={() => set({ glass: 'strong' })}>Strong</button></div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Motion</h2>
        <div className="segmented"><button className={a.motion === 'full' ? 'active' : ''} onClick={() => set({ motion: 'full' })}>Full</button><button className={a.motion === 'reduced' ? 'active' : ''} onClick={() => set({ motion: 'reduced' })}>Reduced</button></div>
        <div className="help-text mt-8">Reduced freezes the background and shortens every transition. The system "reduce motion" preference is always honoured.</div>
      </div>
      <div className="card mb-16"><h2 className="mb-8">Density</h2><div className="segmented"><button className={a.density === 'comfortable' ? 'active' : ''} onClick={() => set({ density: 'comfortable' })}>Comfortable</button><button className={a.density === 'compact' ? 'active' : ''} onClick={() => set({ density: 'compact' })}>Compact</button></div></div>
      <div className="card"><h2 className="mb-8">Reading pane</h2><ReadingPaneToggle /></div>
    </div>
  );
}

function ReadingPaneToggle() {
  const [p, set] = useMailPrefs();
  return <div className="segmented"><button className={p.layout === 'right' ? 'active' : ''} onClick={() => set({ layout: 'right' })}>Beside the list</button><button className={p.layout === 'bottom' ? 'active' : ''} onClick={() => set({ layout: 'bottom' })}>Below the list</button><button className={p.layout === 'off' ? 'active' : ''} onClick={() => set({ layout: 'off' })}>Off</button></div>;
}

// ---------------- Mail ----------------

function MailSettings() {
  const [p, set] = useMailPrefs();
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Mail" sub="How reading and writing mail behaves. Saved to this browser and to your profile." />
      <div className="card mb-16">
        <h2 className="mb-8">Undo send</h2>
        <p className="muted small">Messages are held for a moment after you press Send, with an Undo button in the corner. Zero sends at once.</p>
        <div className="segmented">{([0, 5, 10, 20, 30] as const).map((n) => <button key={n} className={p.undoSendSeconds === n ? 'active' : ''} onClick={() => set({ undoSendSeconds: n })}>{n === 0 ? 'Off' : `${n} s`}</button>)}</div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Reading pane</h2>
        <p className="muted small">Where an opened conversation appears on wide screens. Narrow screens always open it full width.</p>
        <ReadingPaneToggle />
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Replies</h2>
        <div className="row mb-8"><Toggle checked={p.defaultReplyAll} onChange={(v) => set({ defaultReplyAll: v })} /><span className="small">"AI reply" and the reply shortcut answer everyone on the message (reply all) by default</span></div>
        <div className="row"><Toggle checked={p.sendAndArchive} onChange={(v) => set({ sendAndArchive: v })} /><span className="small">Show "Send and archive" as the main button on replies</span></div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Images</h2>
        <div className="row"><Toggle checked={p.showImagesFromContacts} onChange={(v) => set({ showImagesFromContacts: v })} /><span className="small">Show remote images automatically in mail from people in your contacts. Everyone else needs a click, or "Always from this sender".</span></div>
      </div>
      <div className="card">
        <h2 className="mb-8">Mark as read</h2>
        <p className="muted small">How long an opened conversation waits before it counts as read.</p>
        <div className="segmented">{([0, 2, 5] as const).map((n) => <button key={n} className={p.markReadDelay === n ? 'active' : ''} onClick={() => set({ markReadDelay: n })}>{n === 0 ? 'Immediately' : `After ${n} s`}</button>)}</div>
      </div>
    </div>
  );
}

// ---------------- Profile ----------------

async function downscale(file: File, size = 256): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = URL.createObjectURL(file); });
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  const s = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  URL.revokeObjectURL(img.src);
  return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/webp', 0.86));
}

export function AvatarUploader({ src, name, email, onUpload, onRemove }: { src: string | null; name: string; email?: string; onUpload: (blob: Blob) => Promise<void>; onRemove: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <div className="row gap-16" style={{ alignItems: 'center' }}>
      <div className="profile-avatar"><Avatar name={name} email={email} src={src} size="xl" /><Button size="sm" className="edit" iconOnly icon={<Pencil size={13} />} onClick={() => input.current?.click()} aria-label="Change picture" /></div>
      <div className="col gap-4">
        <div className="row gap-4"><Button size="sm" icon={<Upload size={13} />} loading={busy} onClick={() => input.current?.click()}>Upload picture</Button>{src && <Button size="sm" variant="ghost" onClick={async () => { setBusy(true); try { await onRemove(); } finally { setBusy(false); } }}>Remove</Button>}</div>
        <div className="help-text">PNG, JPEG or WebP. It is squared and shrunk to 256 pixels in your browser before upload.</div>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true); try { await onUpload(await downscale(f)); } catch (err) { toast.error(err); } finally { setBusy(false); } }} />
    </div>
  );
}

function ProfileSettings() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(user!.display_name);
  const src = user!.avatar_version ? `/api/avatars/user/${user!.id}?v=${user!.avatar_version}` : null;
  return (
    <div style={{ maxWidth: 640 }}>
      <PageHeader title="Profile" sub={`@${user!.username} · ${user!.role}`} />
      <div className="card mb-16">
        <h2 className="mb-16">Picture</h2>
        <AvatarUploader src={src} name={user!.display_name} email={user!.username} onUpload={async (blob) => { await api.upload('/api/avatars/me', blob, blob.type || 'image/webp'); await refresh(); qc.invalidateQueries({ queryKey: ['threads'] }); toast.success('Picture updated'); }} onRemove={async () => { await api.del('/api/avatars/me'); await refresh(); toast.success('Picture removed'); }} />
        <div className="help-text mt-16">Shown in the top bar and beside messages you sent from any connected mailbox.</div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Name</h2>
        <Field label="Display name" hint="Used in the app; each mailbox has its own From name under Accounts."><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Button variant="primary" disabled={!name.trim() || name === user!.display_name} onClick={() => api.put('/api/auth/profile', { displayName: name.trim() }).then(() => { refresh(); toast.success('Saved'); }).catch((e) => toast.error(e))}>Save</Button>
      </div>
      <NotificationsCard />
      <BurnerCard />
    </div>
  );
}

// Web Push for new mail on this device. The subscription lives in the
// browser's service worker, so it is per device and per browser profile.
function NotificationsCard() {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: status, refetch } = useQuery({ queryKey: ['push-status'], queryFn: () => api.get<{ subscriptions: number }>('/api/push/status') });
  const load = () => pushState().then(setState);
  useEffect(() => { void load(); }, []);
  async function toggle(on: boolean) {
    setBusy(true);
    try {
      if (on) { await enablePush(); toast.success('Notifications on for this device'); } else { await disablePush(); toast.success('Notifications off for this device'); }
      await load(); await refetch();
    } catch (e) { toast.error(e); await load(); } finally { setBusy(false); }
  }
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const hint = state === 'unsupported' ? (ios && !standalone ? 'On iPhone and iPad, add the app to the Home Screen first (Share → Add to Home Screen), then turn this on from the installed app.' : 'This browser does not support push notifications.')
    : state === 'no-worker' ? 'Available in the installed app or the production build.'
    : state === 'denied' ? 'Notifications are blocked for this site in the browser settings. Allow them there, then reload.'
    : 'You get a notification for each new message in your inbox, or one summary when many arrive at once. Mail content stays on the server; only sender and subject are sent.';
  return (
    <div className="card mb-16">
      <h2 className="mb-8">Notifications</h2>
      <div className="row gap-16" style={{ alignItems: 'center' }}>
        <Toggle checked={state === 'on'} disabled={busy || state === null || ['unsupported', 'no-worker', 'denied'].includes(state ?? '')} onChange={toggle} label="New mail notifications on this device" />
        <div className="col gap-4">
          <div className="strong">New mail on this device</div>
          <div className="small muted">{hint}</div>
        </div>
      </div>
      {(status?.subscriptions ?? 0) > 0 && <div className="row gap-8 mt-12 small muted" style={{ alignItems: 'center' }}>
        <span>{status!.subscriptions} device{status!.subscriptions === 1 ? '' : 's'} subscribed.</span>
        <Button size="sm" variant="ghost" onClick={() => api.post<{ sent: number }>('/api/push/test').then((r) => toast.success(`Test sent to ${r.sent} device${r.sent === 1 ? '' : 's'}`)).catch((e) => toast.error(e))}>Send a test</Button>
      </div>}
    </div>
  );
}

// A receive-only alias on the user's mailbox on the bundled mail server.
function BurnerCard() {
  const toast = useToast();
  const [confirm, setConfirm] = useState<'rotate' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useQuery({ queryKey: ['burner'], queryFn: () => api.get<{ available: boolean; reason: string | null; domain: string | null; burner: { address: string; createdAt: string } | null; mailbox: string | null }>('/api/burner') });
  if (!data) return null;
  if (!data.available && !data.burner) {
    if (!data.domain) return null; // no bundled mail server on this install: nothing to offer
    return <div className="card"><h2 className="mb-8">Burner address</h2><p className="muted small">{data.reason}</p></div>;
  }
  async function rotate() {
    setBusy(true);
    try { const r = await api.post<{ burner: { address: string } }>('/api/burner/rotate'); await refetch(); toast.success(`Your burner address is ${r.burner.address}`); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api.del('/api/burner'); await refetch(); toast.success('Burner address removed'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  const b = data.burner;
  return (
    <div className="card">
      <h2 className="mb-8">Burner address</h2>
      <p className="muted small">A throwaway address at @{data.domain} that delivers to {data.mailbox ?? 'your mailbox'}. Give it out where you would rather not share your real address. It only receives: replies you write go out from your real address, so reply with care. One at a time; a new one replaces the old, which stops working.</p>
      {b ? (
        <div className="row gap-8 wrap mt-8" style={{ alignItems: 'center' }}>
          <code style={{ fontSize: 14 }}>{b.address}</code>
          <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(b.address); toast.success('Copied'); }}>Copy</Button>
          <span className="small muted">since {fmtRelative(b.createdAt)}</span>
          <span className="ml-auto row gap-8">
            <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => setConfirm('rotate')} disabled={busy}>New address</Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirm('remove')} disabled={busy}>Remove</Button>
          </span>
        </div>
      ) : (
        <Button variant="primary" icon={<Plus size={15} />} onClick={rotate} disabled={busy}>Create a burner address</Button>
      )}
      <Confirm open={confirm === 'rotate'} onClose={() => setConfirm(null)} title="Replace your burner address?" message="The current address stops receiving mail immediately. Anyone still writing to it gets a bounce." confirmLabel="New address" onConfirm={async () => { setConfirm(null); await rotate(); }} />
      <Confirm open={confirm === 'remove'} onClose={() => setConfirm(null)} danger title="Remove your burner address?" message="Mail sent to it will bounce from now on." confirmLabel="Remove" onConfirm={async () => { setConfirm(null); await remove(); }} />
    </div>
  );
}

