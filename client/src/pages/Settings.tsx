import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Check, Download, KeyRound, Loader2, Plus, RefreshCw, Sparkles, Trash2, Wifi, WifiOff, Pencil, Shield, Users, Palette, Settings as SettingsIcon, Mail, ExternalLink, Server, Copy, KeySquare, UserCircle, Upload, Monitor, Sun, Moon, Smartphone, Lock, Feather } from 'lucide-react';
import { api, apiStream } from '../api';
import { useAuth } from '../state/auth';
import { useAppName } from '../components/Brand';
import { renderIcons } from '../lib/pwaIcons';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { useToast } from '../state/toast';
import { useAccounts, useAiStatus, type Account } from '../lib/queries';
import { Badge, Button, Callout, ColorPicker, Confirm, Field, IconButton, Input, Modal, PageHeader, Progress, Segmented, Select, Spinner, Textarea, Toggle, Tabs } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { getAppearance, setAppearance, onAppearance, type Theme, type Appearance } from '../state/theme';
import { PALETTES, BACKGROUNDS } from '../lib/palettes';
import { Avatar } from '../components/ui';
import { useLocalStorage } from '../lib/hooks';
import { fmtBytes, fmtDateTime, fmtRelative, cls, describeUa } from '../lib/format';
import { DataTable } from '../components/DataTable';
import MailAppsSettings from './MailApps';
import EncryptionSettings from './Encryption';

// Everyone gets the tabs about their own login, mailboxes and appearance.
// Workspace-wide pages (general, users, the mail server) are admin only,
// and the server refuses their endpoints regardless of what the UI shows.
export default function SettingsPage() {
  const { user, stalwartProvisioning } = useAuth();
  const admin = user!.role === 'admin';
  const tabs: [string, string, ReactNode][] = [
    ['profile', 'Profile', <UserCircle size={15} />], ['accounts', 'Accounts', <Mail size={15} />], ['mailapps', 'Mail apps', <Smartphone size={15} />],
    ['ai', 'AI assistant', <Sparkles size={15} />], ['appearance', 'Appearance', <Palette size={15} />], ['security', 'Security', <Shield size={15} />], ['encryption', 'Encryption', <Lock size={15} />],
  ];
  if (admin) tabs.push(['general', 'General', <SettingsIcon size={15} />], ['users', 'Users', <Users size={15} />]);
  if (admin && stalwartProvisioning) tabs.push(['mailserver', 'Mail server', <Server size={15} />]);
  const AdminOnly = ({ children }: { children: ReactNode }) => (admin ? <>{children}</> : <Navigate to="/settings/profile" replace />);
  return (
    <div className="page">
      <div className="tabs settings-tabs">
        {tabs.map(([k, l, i]) => <NavLink key={k} to={`/settings/${k}`} className={({ isActive }) => cls(isActive && 'active')}>{i}{l}</NavLink>)}
      </div>
      <Routes>
        <Route path="profile" element={<ProfileSettings />} />
        <Route path="accounts" element={<AccountsSettings />} />
        <Route path="mailapps" element={<MailAppsSettings />} />
        <Route path="ai" element={<AiSettings />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="encryption" element={<EncryptionSettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        <Route path="general" element={<AdminOnly><GeneralSettings /></AdminOnly>} />
        <Route path="users" element={<AdminOnly><UsersSettings /></AdminOnly>} />
        <Route path="mailserver" element={<AdminOnly><MailServerSettings /></AdminOnly>} />
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
            {help && <Callout>{help}{provider === 'stalwart' && local && <> Admins can create mailboxes on the bundled server under Settings → Mail server, which also connects them here in one step.</>}</Callout>}
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

// ---------------- AI ----------------

function AiSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, refetch } = useAiStatus();
  const [f, setF] = useState<any>(null);
  const [pull, setPull] = useState<{ name: string; status: string; pct: number } | null>(null);
  const [customModel, setCustomModel] = useState('');
  const [testOut, setTestOut] = useState('');
  const [testing, setTesting] = useState(false);
  const [playInstruction, setPlayInstruction] = useState('Write two friendly sentences confirming the assistant works and mention that it runs locally.');
  const [playMode, setPlayMode] = useState<'compose' | 'reply' | 'subject' | 'rewrite'>('compose');
  const [playDraft, setPlayDraft] = useState('');
  useEffect(() => { if (data && !f) setF({ ...data.settings }); }, [data, f]);
  const admin = user!.role === 'admin';
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
  async function test() {
    setTesting(true); setTestOut('');
    try { await apiStream('/api/ai/draft', { mode: playMode, instruction: playInstruction || undefined, draft: playDraft || undefined, length: 'short' }, { onEvent: (ev, d) => { if (ev === 'token') setTestOut((o) => o + d.t); if (ev === 'error') toast.error(d.error); } }); } catch (e) { toast.error(e); } finally { setTesting(false); }
  }
  if (isLoading || !data || !f) return <Spinner />;
  const findInstalled = (n: string) => data.models.find((x: any) => x.name === n || x.name === `${n}:latest`);
  const modelRows: { name: string; inst: any; active: boolean; note: string; sizeGB?: number }[] = [
    ...data.curated.map((m: any) => ({ name: m.name, inst: findInstalled(m.name), active: data.settings.model === m.name, note: m.note, sizeGB: m.sizeGB })),
    ...data.models.filter((x: any) => !data.curated.some((c: any) => c.name === x.name || `${c.name}:latest` === x.name)).map((x: any) => ({ name: x.name, inst: x, active: data.settings.model === x.name, note: `${x.parameterSize ?? ''} ${x.quantization ?? ''}`.trim() })),
  ];
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="AI assistant" sub="Drafts, replies, rewrites, summaries and per-contact personalisation, generated on this server." />
      <div className="card mb-16">
        {admin ? (
          <>
            <div className="row mb-8 wrap"><span className={cls('sync-dot', data.health.ok ? 'idle' : 'error')} /><span className="strong">{data.settings.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible endpoint'}</span><span className="muted small">{data.health.ok ? `reachable${data.health.version ? `, v${data.health.version}` : ''}` : `unreachable: ${data.health.error}`}</span><span className="ml-auto small muted">{data.totalMemGiB} GB RAM on this machine</span></div>
            <div className="row wrap gap-12 small">
              <span>Model in use: <b>{data.settings.model}</b> {data.settings.provider === 'ollama' && (data.modelInstalled ? <Badge kind="success">installed</Badge> : <Badge kind="danger">not downloaded</Badge>)}</span>
              {data.loaded?.length > 0 && <span className="muted">loaded in memory: {data.loaded.map((m: any) => m.name).join(', ')}</span>}
            </div>
          </>
        ) : (
          <div className="row wrap"><span className={cls('sync-dot', data.settings.enabled && data.health.ok && data.modelInstalled ? 'idle' : 'error')} /><span className="strong">{data.settings.enabled && data.health.ok && data.modelInstalled ? 'The assistant is available' : 'The assistant is unavailable right now'}</span><span className="muted small">{data.settings.enabled ? `model ${data.settings.model}` : 'turned off by an admin'}</span></div>
        )}
      </div>
      <div className="card mb-16">
        <div className="card-title"><h2>Playground</h2><span className="small muted">Uses the saved system prompt and tuning</span></div>
        <div className="row mb-8"><Select className="input-sm" style={{ width: 150 }} value={playMode} onChange={(e) => setPlayMode(e.target.value as any)}><option value="compose">Draft</option><option value="reply">Reply</option><option value="rewrite">Rewrite</option><option value="subject">Subject line</option></Select><Input className="input-sm" value={playInstruction} onChange={(e) => setPlayInstruction(e.target.value)} placeholder="Instruction" /></div>
        {(playMode === 'rewrite' || playMode === 'subject' || playMode === 'reply') && <Textarea className="mb-8" value={playDraft} onChange={(e) => setPlayDraft(e.target.value)} placeholder={playMode === 'reply' ? 'Paste the message you are replying to' : 'Paste the draft to work on'} style={{ minHeight: 70 }} />}
        <div className="row"><Button size="sm" variant="ai" icon={<Sparkles size={14} />} loading={testing} onClick={test} disabled={!data.settings.enabled}>Run</Button></div>
        {testOut && <div className="ai-preview mt-8">{testOut}</div>}
      </div>
      {admin ? (
        <>
          <div className="card mb-16">
            <div className="card-title"><h2>Settings</h2><div className="row"><Toggle checked={f.enabled} onChange={(v) => { setF({ ...f, enabled: v }); void save({ enabled: v }); }} /><span className="small">Enabled</span></div></div>
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
            <div className="card">
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
        </>
      ) : <Callout>Only admins change the model and provider. Ask an admin if drafting is unavailable.</Callout>}
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
        <div className="swatches">{PALETTES.map((p) => <button key={p.key} type="button" className={cls('swatch-card', a.palette === p.key && 'active')} onClick={() => set({ palette: p.key })}><div className="bar" style={{ background: `linear-gradient(120deg, ${p.gradient.join(', ')})` }} /><div className="name">{p.name}</div><div className="hint">{a.palette === p.key ? 'in use' : ' '}</div></button>)}</div>
      </div>
      <div className="card mb-16">
        <h2 className="mb-8">Background</h2>
        <p className="muted small">Rendered with WebGL on the GPU at a low resolution, capped at 30 frames per second, paused when the tab is hidden. Choose Plain for a flat colour.</p>
        <div className="swatches">{BACKGROUNDS.map((b) => <button key={b.key} type="button" className={cls('swatch-card', a.background === b.key && 'active')} onClick={() => set({ background: b.key })}><div className={`bar bg-preview-${b.key}`} /><div className="name">{b.name}</div><div className="hint">{b.hint}</div></button>)}</div>
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
  const [split, setSplit] = useLocalStorage('tern.split', true);
  return <div className="row"><Toggle checked={split} onChange={setSplit} /><span className="small">Show conversations beside the list on wide screens</span></div>;
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

// ---------------- General ----------------

function GeneralSettings() {
  const { user, version } = useAuth();
  const appName = useAppName();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['app-settings'], queryFn: () => api.get<any>('/api/settings') });
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: any[] }>('/api/settings/audit'), enabled: user!.role === 'admin' });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF(data.app); }, [data, f]);
  if (!data || !f) return <Spinner />;
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="General" sub={`${appName} ${version || data.version} · ${data.appUrl}`} />
      {user!.role === 'admin' && <BrandingCard />}
      <div className="card mb-16">
        <h2 className="mb-8">Compliance footer</h2>
        <p className="muted small">Added below sequence emails when the sequence's unsubscribe footer is on. CAN-SPAM requires a valid physical postal address in commercial email.</p>
        <Field label="Unsubscribe sentence"><Input value={f.unsubscribeText} onChange={(e) => setF({ ...f, unsubscribeText: e.target.value })} disabled={user!.role !== 'admin'} /></Field>
        <Field label="Physical address"><Textarea value={f.physicalAddress} onChange={(e) => setF({ ...f, physicalAddress: e.target.value })} placeholder="Acme LLC, 100 Main St, Springfield" style={{ minHeight: 60 }} disabled={user!.role !== 'admin'} /></Field>
        {user!.role === 'admin' && <Button variant="primary" onClick={() => api.put('/api/settings', f).then(() => { toast.success('Saved'); refetch(); }).catch((e) => toast.error(e))}>Save</Button>}
      </div>
      {data.stalwart && <div className="card mb-16"><h2 className="mb-8">Bundled mail server</h2><p className="small muted">Stalwart is running beside Tern. Manage domains, accounts, DKIM and DNS records in its admin panel.</p><a className="btn" href={data.stalwart.adminUrl ?? '#'} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open Stalwart admin</a></div>}
      {user!.role === 'admin' && (
        <div className="card">
          <h2 className="mb-8">Audit log</h2>
          <DataTable rows={(audit?.entries ?? []).slice(0, 60)} rowKey={(e) => e.id} cardSize="sm" dense columns={[
            { key: 'when', header: 'When', className: 'small muted', nowrap: true, cell: (e) => fmtDateTime(e.created_at) },
            { key: 'who', header: 'Who', className: 'small', cell: (e) => e.username ?? 'system' },
            { key: 'action', header: 'Action', primary: true, className: 'small strong', cell: (e) => e.action },
            { key: 'details', header: 'Details', secondary: true, className: 'small muted', cell: (e) => { const d = `${e.target ?? ''} ${Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}`.trim(); return d ? <span className="truncate" style={{ display: 'inline-block', maxWidth: 320, verticalAlign: 'bottom' }} title={d}>{d}</span> : null; } },
          ]} />
        </div>
      )}
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
  const [f, setF] = useState({ username: '', displayName: '', password: '', role: 'member' });
  const [reset, setReset] = useState<any>(null);
  const [newPw, setNewPw] = useState('');
  const [del, setDel] = useState<any>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const { data: authSettings } = useQuery({ queryKey: ['auth-settings'], queryFn: () => api.get<{ settings: { allowRegistration: boolean; defaultRole: string } }>('/api/users/auth-settings').then((r) => r.settings) });
  const { data: invites } = useQuery({ queryKey: ['invites'], queryFn: () => api.get<{ invites: any[] }>('/api/users/invites').then((r) => r.invites) });
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviteNote, setInviteNote] = useState('');
  const [inviteDays, setInviteDays] = useState(7);
  async function saveAuth(patch: any) { try { await api.put('/api/users/auth-settings', patch); qc.invalidateQueries({ queryKey: ['auth-settings'] }); toast.success('Saved'); } catch (e) { toast.error(e); } }
  async function makeInvite() { try { await api.post('/api/users/invites', { role: inviteRole, note: inviteNote, days: inviteDays }); qc.invalidateQueries({ queryKey: ['invites'] }); setInviteNote(''); } catch (e) { toast.error(e); } }
  async function add() {
    try { await api.post('/api/users', f); invalidate(); setCreate(false); setF({ username: '', displayName: '', password: '', role: 'member' }); toast.success('User created'); } catch (e) { toast.error(e); }
  }
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Users" sub="Everyone signs in with a username and password; there is no email-based reset by design." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>Add user</Button>} />
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
  async function reveal() { try { setCreds(await api.get('/api/stalwart/admin-access')); setShow(true); } catch (e) { toast.error(e); } }
  return (
    <div className="col gap-16" style={{ maxWidth: 700 }}>
      <Callout>Two logins run the mail system. <b>Tern admins</b> (this app) create mailboxes, set DNS and brand, and manage users. The <b>Stalwart admin</b> is the mail server's own panel for everything else: domains, aliases, relay hosts, spam rules, queues and logs. The installer created both; the Stalwart one is kept in <code>.env</code> and shown here on request.</Callout>
      <div className="card">
        <div className="card-title"><h2>Stalwart admin panel</h2></div>
        {!show ? <Button icon={<KeyRound size={15} />} onClick={reveal}>Show admin login</Button> : (
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
