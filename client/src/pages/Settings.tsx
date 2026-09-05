import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Check, Download, KeyRound, Loader2, Plus, RefreshCw, Sparkles, Trash2, Wifi, WifiOff, Pencil, Shield, Users, Palette, Settings as SettingsIcon, Mail, Info, ExternalLink } from 'lucide-react';
import { api, apiStream } from '../api';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useAccounts, useAiStatus, type Account } from '../lib/queries';
import { Badge, Button, Callout, ColorPicker, Confirm, Field, IconButton, Input, Modal, PageHeader, Progress, Segmented, Select, Spinner, Textarea, Toggle } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { applyDensity, applyTheme, getDensity, getTheme, type Theme } from '../state/theme';
import { useLocalStorage } from '../lib/hooks';
import { fmtBytes, fmtDateTime, fmtRelative, cls } from '../lib/format';

export default function SettingsPage() {
  const { user } = useAuth();
  const tabs = [['accounts', 'Accounts', <Mail size={15} />], ['ai', 'AI assistant', <Sparkles size={15} />], ['security', 'Security', <Shield size={15} />], ['appearance', 'Appearance', <Palette size={15} />], ['general', 'General', <SettingsIcon size={15} />]] as const;
  return (
    <div className="page">
      <div className="tabs">
        {tabs.map(([k, l, i]) => <NavLink key={k} to={`/settings/${k}`} className={({ isActive }) => cls(isActive && 'active')}>{i}{l}</NavLink>)}
        {user!.role === 'admin' && <NavLink to="/settings/users" className={({ isActive }) => cls(isActive && 'active')}><Users size={15} />Users</NavLink>}
      </div>
      <Routes>
        <Route path="accounts" element={<AccountsSettings />} />
        <Route path="ai" element={<AiSettings />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        <Route path="general" element={<GeneralSettings />} />
        <Route path="users" element={<UsersSettings />} />
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
      <div className="row" style={{ alignItems: 'flex-start' }}>
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
        <div className="row gap-4">
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
            {help && <Callout>{help}{provider === 'stalwart' && local && <> The bundled Stalwart's admin panel is at <a href={`https://${local.host}/admin`} target="_blank" rel="noreferrer">https://{local.host}/admin <ExternalLink size={11} /></a>; create a domain and an account there first.</>}</Callout>}
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
  const [f, setF] = useState({ name: account.name, color: account.color, dailyCap: account.daily_cap, jitterEnabled: account.jitter_enabled, jitterMinS: account.jitter_min_s, jitterMaxS: account.jitter_max_s, sendWindow: { ...account.send_window, days: [...(account.send_window.days ?? [])] }, syncLimit: account.sync_limit, enabled: account.enabled, sendVia: account.send_via, smtp: account.smtp ? { ...account.smtp, pass: '' } : { host: '', port: 465, secure: true, user: '', pass: '' }, useSmtp: Boolean(account.smtp), secret: '', authUser: account.auth_user ?? '', sessionUrl: account.session_url, pinOrigin: account.pin_origin });
  const sig = useRef(account.signature_html);
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  async function save() {
    setBusy(true);
    try {
      const body: any = { name: f.name, color: f.color, signatureHtml: sig.current, dailyCap: f.dailyCap, jitterEnabled: f.jitterEnabled, jitterMinS: f.jitterMinS, jitterMaxS: f.jitterMaxS, sendWindow: f.sendWindow, syncLimit: f.syncLimit, enabled: f.enabled, sendVia: f.sendVia, smtp: f.useSmtp ? { host: f.smtp.host, port: Number(f.smtp.port), secure: f.smtp.secure, user: f.smtp.user, pass: f.smtp.pass || undefined } : null };
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
    try { await apiStream('/api/ai/draft', { mode: 'compose', instruction: 'Write two friendly sentences confirming the assistant works.', length: 'short' }, { onEvent: (ev, d) => { if (ev === 'token') setTestOut((o) => o + d.t); if (ev === 'error') toast.error(d.error); } }); } catch (e) { toast.error(e); } finally { setTesting(false); }
  }
  if (isLoading || !data || !f) return <Spinner />;
  const installed = new Set(data.models.map((m: any) => m.name));
  const isInstalled = (n: string) => installed.has(n) || installed.has(`${n}:latest`);
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="AI assistant" sub="Drafts, replies, rewrites, summaries and per-contact personalisation, generated on this server." />
      <div className="card mb-16">
        <div className="row mb-8"><span className={cls('sync-dot', data.health.ok ? 'idle' : 'error')} /><span className="strong">{data.settings.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible endpoint'}</span><span className="muted small">{data.health.ok ? `reachable${data.health.version ? `, v${data.health.version}` : ''}` : `unreachable: ${data.health.error}`}</span><span className="ml-auto small muted">{data.totalMemGiB} GB RAM on this machine</span></div>
        <div className="row wrap gap-12 small">
          <span>Model in use: <b>{data.settings.model}</b> {data.settings.provider === 'ollama' && (data.modelInstalled ? <Badge kind="success">installed</Badge> : <Badge kind="danger">not downloaded</Badge>)}</span>
          {data.loaded?.length > 0 && <span className="muted">loaded in memory: {data.loaded.map((m: any) => m.name).join(', ')}</span>}
        </div>
        <div className="row mt-16"><Button size="sm" variant="ai" icon={<Sparkles size={14} />} loading={testing} onClick={test} disabled={!data.settings.enabled}>Test the assistant</Button>{testOut && <span className="small">{testOut}</span>}</div>
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
          {f.provider === 'ollama' && (
            <div className="card">
              <div className="card-title"><h2>Models</h2><span className="small muted">Recommended for {data.totalMemGiB} GB: <b>{data.recommended.model}</b></span></div>
              <Callout>{data.recommended.note} Pulling downloads from the Ollama registry once; models live in the <code>ollama</code> volume.</Callout>
              {pull && <div className="mt-16"><div className="row small mb-8"><Loader2 size={14} className="spin" /> Pulling {pull.name}: {pull.status} {pull.pct ? `${pull.pct}%` : ''}</div><Progress value={pull.pct} max={100} /></div>}
              <table className="table mt-16"><thead><tr><th>Model</th><th>Size</th><th>Note</th><th /></tr></thead><tbody>
                {data.curated.map((m: any) => {
                  const inst = data.models.find((x: any) => x.name === m.name || x.name === `${m.name}:latest`);
                  const active = data.settings.model === m.name;
                  return <tr key={m.name}><td className="strong">{m.name} {active && <Badge kind="accent">in use</Badge>}{m.name === data.recommended.model && <Badge kind="success">recommended</Badge>}</td><td className="muted">{inst ? fmtBytes(inst.size) : `~${m.sizeGB} GB`}</td><td className="muted small">{m.note}</td><td><div className="row gap-4" style={{ justifyContent: 'flex-end' }}>{inst ? <><Button size="sm" disabled={active} onClick={() => save({ model: m.name })}>{active ? 'Selected' : 'Use'}</Button><IconButton label="Delete" className="btn-sm" onClick={() => api.del(`/api/ai/models/${encodeURIComponent(m.name)}`).then(() => refetch())}><Trash2 size={14} /></IconButton></> : <Button size="sm" icon={<Download size={13} />} disabled={Boolean(pull)} onClick={() => doPull(m.name)}>Pull</Button>}</div></td></tr>;
                })}
                {data.models.filter((x: any) => !data.curated.some((c: any) => c.name === x.name || `${c.name}:latest` === x.name)).map((x: any) => <tr key={x.name}><td className="strong">{x.name} {data.settings.model === x.name && <Badge kind="accent">in use</Badge>}</td><td className="muted">{fmtBytes(x.size)}</td><td className="muted small">{x.parameterSize} {x.quantization}</td><td><div className="row gap-4" style={{ justifyContent: 'flex-end' }}><Button size="sm" disabled={data.settings.model === x.name} onClick={() => save({ model: x.name })}>Use</Button><IconButton label="Delete" className="btn-sm" onClick={() => api.del(`/api/ai/models/${encodeURIComponent(x.name)}`).then(() => refetch())}><Trash2 size={14} /></IconButton></div></td></tr>)}
              </tbody></table>
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
  const { user, refresh } = useAuth();
  const toast = useToast();
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
        <table className="table"><tbody>{(sessions?.sessions ?? []).map((s) => <tr key={s.id}><td>{s.current ? <Badge kind="success">this device</Badge> : <Badge>other</Badge>}</td><td className="small muted truncate" style={{ maxWidth: 320 }}>{s.user_agent || 'unknown client'}</td><td className="small muted">active {fmtRelative(s.last_seen_at)}</td><td>{!s.current && <Button size="sm" variant="ghost" onClick={() => api.post('/api/auth/sessions/revoke', { id: s.fullId }).then(() => refetch())}>Sign out</Button>}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

// ---------------- Appearance ----------------

function AppearanceSettings() {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [density, setDensity] = useState(getDensity());
  const [split, setSplit] = useLocalStorage('tern.split', true);
  return (
    <div style={{ maxWidth: 640 }}>
      <PageHeader title="Appearance" sub="Stored in this browser." />
      <div className="card mb-16"><h2 className="mb-8">Theme</h2><Segmented value={theme} onChange={(t) => { setTheme(t); applyTheme(t); }} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></div>
      <div className="card mb-16"><h2 className="mb-8">Density</h2><Segmented value={density} onChange={(d) => { setDensity(d); applyDensity(d); }} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></div>
      <div className="card"><h2 className="mb-8">Reading pane</h2><div className="row"><Toggle checked={split} onChange={setSplit} /><span className="small">Show conversations beside the list on wide screens</span></div></div>
    </div>
  );
}

// ---------------- General ----------------

function GeneralSettings() {
  const { user, version } = useAuth();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['app-settings'], queryFn: () => api.get<any>('/api/settings') });
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: any[] }>('/api/settings/audit'), enabled: user!.role === 'admin' });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF(data.app); }, [data, f]);
  if (!data || !f) return <Spinner />;
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="General" sub={`Tern ${version || data.version} · ${data.appUrl}`} />
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
          <table className="table"><tbody>{(audit?.entries ?? []).slice(0, 60).map((e) => <tr key={e.id}><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.created_at)}</td><td className="small">{e.username ?? 'system'}</td><td className="small strong">{e.action}</td><td className="small muted truncate" style={{ maxWidth: 300 }}>{e.target ?? ''} {Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}</td></tr>)}</tbody></table>
        </div>
      )}
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
  async function add() {
    try { await api.post('/api/users', f); invalidate(); setCreate(false); setF({ username: '', displayName: '', password: '', role: 'member' }); toast.success('User created'); } catch (e) { toast.error(e); }
  }
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Users" sub="Everyone signs in with a username and password; there is no email-based reset by design." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>Add user</Button>} />
      <table className="table"><thead><tr><th>User</th><th>Role</th><th>Accounts</th><th>2FA</th><th>Last sign-in</th><th /></tr></thead><tbody>
        {(data?.users ?? []).map((u) => <tr key={u.id}>
          <td><div className="strong">{u.display_name}</div><div className="small muted">@{u.username}{u.disabled && <Badge kind="danger">disabled</Badge>}</div></td>
          <td><Select className="input-sm" value={u.role} disabled={u.id === me!.id} onChange={(e) => api.put(`/api/users/${u.id}`, { role: e.target.value }).then(invalidate).catch((err) => toast.error(err))}><option value="admin">admin</option><option value="member">member</option></Select></td>
          <td>{u.account_count}</td>
          <td>{u.totp_enabled ? <Badge kind="success">on</Badge> : <Badge>off</Badge>}</td>
          <td className="small muted">{u.last_login_at ? fmtRelative(u.last_login_at) : 'never'}</td>
          <td><div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => { setReset(u); setNewPw(''); }}>Set password</Button>
            {u.id !== me!.id && <Button size="sm" variant="ghost" onClick={() => api.put(`/api/users/${u.id}`, { disabled: !u.disabled }).then(invalidate)}>{u.disabled ? 'Enable' : 'Disable'}</Button>}
            {u.id !== me!.id && <IconButton label="Delete" className="btn-sm" onClick={() => setDel(u)}><Trash2 size={14} /></IconButton>}
          </div></td>
        </tr>)}
      </tbody></table>
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
