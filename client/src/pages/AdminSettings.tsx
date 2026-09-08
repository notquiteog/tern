import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, Download, KeyRound, Loader2, Plus, RefreshCw, Trash2, Users, Settings as SettingsIcon, ExternalLink, Server, Copy, KeySquare, Upload, Feather, ScrollText, Bot, Palette, ArrowLeft, Monitor, Sun, Moon, Paintbrush, ToggleRight, Timer, ShieldCheck } from 'lucide-react';
import { api, apiStream } from '../api';
import { useAuth } from '../state/auth';
import { useAppName } from '../components/Brand';
import { renderIcons } from '../lib/pwaIcons';
import { useToast } from '../state/toast';
import { useAiModels, useAiStatus, useVoiceModels } from '../lib/queries';
import { Badge, Button, Callout, ColorPicker, Confirm, Field, IconButton, Input, Modal, PageHeader, Progress, ResetButton, Select, Spinner, Textarea, Toggle, Tabs, Avatar } from '../components/ui';
import { fmtBytes, fmtDateTime, fmtRelative, cls } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { AiPlayground, AiStatusLine } from './Settings';
import { PALETTES, BACKGROUNDS } from '../lib/palettes';
import { getAppearance, houseAppearance, applyHouseAppearance, type Appearance, type Theme } from '../state/theme';
import { AdminFeatures, AdminRetention, AdminVault } from './AdminFeatures';
import AdminCalendar from './AdminCalendar';
import { SettingsLayout, type SettingsGroup, type SettingsSection } from '../components/SettingsLayout';

// Everything that changes the workspace for everyone: users and sign-up,
// the bundled mail server, the AI model, the app's name and logo, the
// compliance footer, the audit log. Admins only; the API enforces it too.
export default function AdminSettingsPage() {
  const { user, stalwartProvisioning } = useAuth();
  const admin = user!.role === 'admin';
  if (!admin) return <Navigate to="/settings/profile" replace />;
  const mail: SettingsSection[] = [];
  if (stalwartProvisioning) mail.push({ key: 'mailserver', label: 'Mail server', icon: <Server size={16} />, hint: 'Domains, DNS, queues, logs' });
  mail.push({ key: 'calendar', label: 'Calendar', icon: <CalendarDays size={16} />, hint: 'Scheduling for everyone' });
  const groups: SettingsGroup[] = [
    {
      title: 'Install',
      items: [
        { key: 'general', label: 'General', icon: <SettingsIcon size={16} />, hint: 'Compliance and defaults' },
        { key: 'branding', label: 'Branding', icon: <Palette size={16} />, hint: 'Name, logo, icons' },
        { key: 'appearance', label: 'Appearance', icon: <Paintbrush size={16} />, hint: 'The house theme' },
      ],
    },
    { title: 'People', items: [{ key: 'users', label: 'Users', icon: <Users size={16} />, hint: 'Accounts, roles, sign-up' }] },
    { title: 'Mail', items: mail },
    {
      title: 'Assistant',
      items: [
        { key: 'ai', label: 'AI model', icon: <Bot size={16} />, hint: 'Model, hardware, limits' },
        { key: 'features', label: 'Features', icon: <ToggleRight size={16} />, hint: 'What the install allows' },
      ],
    },
    {
      // How long it keeps things, what it is running, and what it did.
      // Together they are the panel an operator reaches for when the box is
      // under load or somebody asks what it does with mail.
      title: 'Operations',
      items: [
        { key: 'retention', label: 'Retention', icon: <Timer size={16} />, hint: 'How long data is kept' },
        { key: 'vault', label: 'Security', icon: <ShieldCheck size={16} />, hint: 'Keys and encryption at rest' },
        { key: 'audit', label: 'Audit log', icon: <ScrollText size={16} />, hint: 'Who did what, and when' },
      ],
    },
  ];
  return (
    <SettingsLayout
      title="Admin settings"
      badge={<Badge kind="accent">admins only</Badge>}
      sub="Applies to everyone on this install."
      base="/admin"
      groups={groups}
      action={<NavLink to="/settings/profile" className="btn"><ArrowLeft size={15} />My settings</NavLink>}
    >
      <Routes>
        <Route path="general" element={<GeneralSettings />} />
        <Route path="users" element={<UsersSettings />} />
        <Route path="mailserver" element={<MailServerSettings />} />
        <Route path="ai" element={<AiAdminSettings />} />
        <Route path="calendar" element={<AdminCalendar />} />
        <Route path="features" element={<AdminFeatures />} />
        <Route path="retention" element={<AdminRetention />} />
        <Route path="vault" element={<AdminVault />} />
        <Route path="branding" element={<BrandingSettings />} />
        <Route path="appearance" element={<AppearanceDefaults />} />
        <Route path="audit" element={<AuditSettings />} />
        <Route path="*" element={<Navigate to="/admin/general" replace />} />
      </Routes>
    </SettingsLayout>
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

// ---------------- Appearance defaults ----------------
// The look a person gets before they have chosen one: new accounts, new
// browsers, and the sign-in page, where there is no person yet. Saving the
// default leaves everyone's own choices alone; "apply to everyone" is the
// separate, louder button that overrules them.

function AppearanceDefaults() {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['appearance-defaults'], queryFn: () => api.get<{ appearance: { defaults: Appearance; version: number; updatedAt: string | null }; builtIn: Appearance }>('/api/settings/appearance') });
  const [f, setF] = useState<Appearance | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => { if (data && !f) setF(data.appearance.defaults); }, [data]);
  if (!f || !data) return <Spinner />;
  const set = (patch: Partial<Appearance>) => setF({ ...f, ...patch });
  const dirty = JSON.stringify(f) !== JSON.stringify(data.appearance.defaults);

  async function save(applyToEveryone: boolean) {
    setBusy(true);
    try {
      const r = await api.put<{ appearance: { defaults: Appearance; version: number } }>('/api/settings/appearance', { defaults: f, applyToEveryone });
      applyHouseAppearance(r.appearance);
      await refetch();
      setConfirmAll(false);
      toast.success(applyToEveryone ? 'Everyone is now on this style' : 'Default saved for anyone who has not chosen');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  const mine = getAppearance();
  const differsFromMine = JSON.stringify(mine) !== JSON.stringify(houseAppearance());
  // Each section can go back to what Tern ships with on its own, without
  // discarding the rest of the form. It lands on Save like any other edit.
  const resetFor = (...keys: (keyof Appearance)[]) => (
    <ResetButton
      show={keys.some((k) => f![k] !== data!.builtIn[k])}
      onClick={() => setF({ ...f!, ...Object.fromEntries(keys.map((k) => [k, data!.builtIn[k]])) })}
      title="Back to Tern's own default"
    />
  );

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Appearance" sub="The look everyone starts with on this install." />
      <Callout>
        This is the style a person sees before they pick their own: a new account, a browser that has never been used here, and the sign-in page. Anyone who has already chosen a theme or palette keeps it — the button at the bottom is what overrules that.
      </Callout>
      {differsFromMine && <div className="help-text mt-8">Your own appearance differs from this; what you see in the app is your choice, not the default below. Settings → Appearance has a link back.</div>}

      <div className="card mb-16 mt-16">
        <div className="card-title"><h2>Theme</h2>{resetFor('theme')}</div>
        <div className="segmented">{(['system', 'light', 'dark'] as Theme[]).map((t) => <button key={t} className={f.theme === t ? 'active' : ''} onClick={() => set({ theme: t })}>{t === 'system' ? <Monitor size={14} /> : t === 'light' ? <Sun size={14} /> : <Moon size={14} />} {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}</button>)}</div>
        <div className="help-text mt-8">Auto follows each person's operating system.</div>
      </div>

      <div className="card mb-16">
        <div className="card-title"><h2>Colour palette</h2>{resetFor('palette')}</div>
        <div className="swatches">{PALETTES.map((p) => <button key={p.key} type="button" className={cls('swatch-card', f.palette === p.key && 'active')} onClick={() => set({ palette: p.key })}><div className="bar" style={{ background: `linear-gradient(120deg, ${p.gradient.join(', ')})` }} /><div className="name">{p.name}</div><div className="hint">{f.palette === p.key ? 'the default' : p.hint}</div></button>)}</div>
      </div>

      <div className="card mb-16">
        <div className="card-title"><h2>Background</h2>{resetFor('background')}</div>
        <div className="swatches">{(['calm', 'lively', 'none'] as const).map((mood) => <Fragment key={mood}><div className="swatch-group">{mood === 'calm' ? 'Calm' : mood === 'lively' ? 'Lively' : 'Off'}</div>{BACKGROUNDS.filter((b) => b.mood === mood).map((b) => <button key={b.key} type="button" className={cls('swatch-card', f.background === b.key && 'active')} onClick={() => set({ background: b.key })}><div className={`bar bg-preview-${b.key}`} /><div className="name">{b.name}</div><div className="hint">{b.hint}</div></button>)}</Fragment>)}</div>
        <div className="help-text mt-8">Shaders run on the GPU. Choose Plain if the people here are on older machines.</div>
      </div>

      <div className="card mb-16">
        <div className="card-title"><h2>Glass, motion and layout</h2>{resetFor('glass', 'motion', 'density', 'split')}</div>
        <div className="form-row">
          <Field label="Glass"><div className="segmented">{(['subtle', 'balanced', 'strong'] as const).map((g) => <button key={g} className={f.glass === g ? 'active' : ''} onClick={() => set({ glass: g })}>{g[0].toUpperCase() + g.slice(1)}</button>)}</div></Field>
          <Field label="Motion"><div className="segmented">{(['full', 'reduced'] as const).map((m) => <button key={m} className={f.motion === m ? 'active' : ''} onClick={() => set({ motion: m })}>{m === 'full' ? 'Full' : 'Reduced'}</button>)}</div></Field>
        </div>
        <div className="form-row">
          <Field label="Density"><div className="segmented">{(['comfortable', 'compact'] as const).map((d) => <button key={d} className={f.density === d ? 'active' : ''} onClick={() => set({ density: d })}>{d === 'comfortable' ? 'Comfortable' : 'Compact'}</button>)}</div></Field>
          <Field label="Reading pane"><div className="segmented"><button className={f.split ? 'active' : ''} onClick={() => set({ split: true })}>On</button><button className={!f.split ? 'active' : ''} onClick={() => set({ split: false })}>Off</button></div></Field>
        </div>
      </div>

      <div className="card">
        <div className="card-title"><h2>Save</h2>{data.appearance.updatedAt && <span className="small muted">last changed {fmtRelative(data.appearance.updatedAt)}</span>}</div>
        <div className="row wrap gap-4">
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => save(false)}>Save default</Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setF(data.appearance.defaults)}>Discard changes</Button>
          <Button variant="ghost" onClick={() => setF(data.builtIn)}>Reset to Tern's own</Button>
        </div>
        <div className="help-text mt-8">Saving affects people who have never chosen an appearance. To change it for everyone, including people who have:</div>
        <Button className="mt-8" variant="danger" loading={busy} onClick={() => setConfirmAll(true)}>Apply to everyone</Button>
      </div>

      <Confirm
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => save(true)}
        title="Apply this style to everyone"
        confirmLabel="Apply to everyone"
        danger
        message="Every person on this install loses the theme, palette and background they picked and gets this one instead, the next time their browser loads the app. They can change it again afterwards."
      />
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
                    // Two lines, wrapped, rather than one line cut off at a fixed 420px.
          // The fixed width was wider than the card it sat in on a phone, so
          // the end of every settings blob hung over the edge — and one line
          // of a JSON object rarely reaches anything worth reading anyway.
          { key: 'details', header: 'Details', secondary: true, className: 'small muted', cell: (e) => { const d = `${e.target ?? ''} ${Object.keys(e.details ?? {}).length ? JSON.stringify(e.details) : ''}`.trim(); return d ? <span className="clamp-2" title={d}>{d}</span> : null; } },
        ]} />
      </div>
    </div>
  );
}

// ---------------- AI model (admin) ----------------

// This button sits in the Tuning card, so it resets tuning: the provider,
// model and base URL above it are left alone.
const TUNING_FIELDS = ['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'repeatLastN', 'presencePenalty', 'frequencyPenalty', 'maxTokens', 'numCtx', 'keepAlive', 'allowThinking', 'thinkEffort', 'thinkingBudget'] as const;
// What a preset carries: how the model writes, and nothing about the machine.
// The context window and the keep-alive are deliberately not in here — they
// are memory decisions, and a preset that resized the context would resize
// every parallel slot with it. Kept in step with PRESET_FIELDS on the server.
const PRESET_FIELDS = ['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'repeatLastN', 'presencePenalty', 'frequencyPenalty', 'maxTokens', 'allowThinking', 'thinkEffort', 'thinkingBudget'] as const;
const pick = (o: any, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// Tuning under a name. A reasoning model wants different sampling with
// thinking on than the same model wants with it off, and remembering which
// numbers went together is not a thing to ask of anybody: the shipped presets
// carry Qwen3.5's own published recommendations for both, and an install can
// save its own beside them.
function AiPresets({ data, f, setF, save, onChanged }: { data: any; f: any; setF: (v: any) => void; save: (patch: any) => Promise<void> | void; onChanged: () => void }) {
  const toast = useToast();
  const [id, setId] = useState('');
  const [editing, setEditing] = useState<{ id?: string; name: string; note: string; forModel: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const presets: any[] = data.presets ?? [];
  const chosen = presets.find((p) => p.id === id);
  const current = () => Object.fromEntries(PRESET_FIELDS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));

  async function apply() {
    if (!chosen) return;
    setF({ ...f, ...chosen.values });
    await save(chosen.values);
    toast.success(`Applied "${chosen.name}"`);
  }
  async function submit() {
    if (!editing?.name.trim()) return;
    setBusy(true);
    try {
      const body = { name: editing.name.trim(), note: editing.note, forModel: editing.forModel, values: current() };
      const r = editing.id ? await api.put<any>(`/api/ai/presets/${encodeURIComponent(editing.id)}`, body) : await api.post<any>('/api/ai/presets', body);
      const made = r.presets[r.presets.length - 1];
      setId(editing.id ?? made.id);
      setEditing(null);
      onChanged();
      toast.success(editing.id ? 'Preset updated' : 'Preset saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function remove(p: any) {
    setBusy(true);
    try { await api.del(`/api/ai/presets/${encodeURIComponent(p.id)}`); if (id === p.id) setId(''); setConfirmDel(null); onChanged(); toast.success(`Deleted "${p.name}"`); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="row wrap gap-8 mb-8">
        <Select className="input-sm" value={id} onChange={(e) => setId(e.target.value)} style={{ maxWidth: 280 }}>
          <option value="">Presets…</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.builtIn ? '' : ' (yours)'}</option>)}
        </Select>
        <Button size="sm" disabled={!chosen} onClick={apply}>Apply</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing({ name: '', note: '', forModel: f.model ?? '' })}>Save current as…</Button>
        {chosen && !chosen.builtIn && <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing({ id: chosen.id, name: chosen.name, note: chosen.note ?? '', forModel: chosen.forModel ?? '' })}>Update from current</Button>
          <IconButton label="Delete preset" className="btn-sm" disabled={busy} onClick={() => setConfirmDel(chosen)}><Trash2 size={14} /></IconButton>
        </>}
      </div>
      {chosen && (
        <div className="help-text mb-8">
          {chosen.note}
          {chosen.forModel && <> {chosen.forModel === f.model ? <Badge kind="success">written for {chosen.forModel}</Badge> : <Badge kind="warning">written for {chosen.forModel}, you are running {f.model}</Badge>}</>}
          {chosen.values?.allowThinking !== undefined && <> Applying it turns reasoning {chosen.values.allowThinking ? 'on' : 'off'}.</>}
        </div>
      )}
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? 'Update preset' : 'Save this tuning as a preset'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!editing?.name.trim()} onClick={submit}>{editing?.id ? 'Update' : 'Save preset'}</Button></>}>
        <p className="small muted">The sliders as they stand now — sampling, reply length and the thinking settings. The context window, keep-alive and provider are not part of a preset: those are decisions about the machine, not about how the assistant writes.</p>
        <Field label="Name"><Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing!, name: e.target.value })} placeholder="Long replies, thinking on" /></Field>
        <Field label="What it is for" hint="Shown under the picker when it is chosen."><Textarea value={editing?.note ?? ''} onChange={(e) => setEditing({ ...editing!, note: e.target.value })} style={{ minHeight: 60 }} /></Field>
        <Field label="Model it was written for" hint="A label and a badge only; applying a preset never changes which model is in use."><Input value={editing?.forModel ?? ''} onChange={(e) => setEditing({ ...editing!, forModel: e.target.value })} placeholder={f.model} /></Field>
      </Modal>
      <Confirm open={Boolean(confirmDel)} onClose={() => setConfirmDel(null)} danger title={`Delete "${confirmDel?.name}"?`} confirmLabel="Delete preset"
        message="The tuning in use now is not changed; only the saved preset goes." onConfirm={() => remove(confirmDel)} />
    </>
  );
}

// One bar. `right` carries the numbers, because a bar on its own answers
// "how full" and never "how much".
function Meter({ label, value, max, right, warnAt }: { label: ReactNode; value: number; max: number; right: ReactNode; warnAt?: number }) {
  return (
    <div className="mb-8">
      <div className="row small mb-4"><span className="strong">{label}</span><span className="ml-auto muted">{right}</span></div>
      <Progress value={value} max={max} warnAt={warnAt} />
    </div>
  );
}

// What the box and the model are holding, now. Polled while the page is
// open: raising the context window or the slot count moves these bars, and
// the point of showing them is that the person changing the numbers can see
// what the change costs before their next draft is what tells them.
function AiMemoryMeter({ provider }: { provider: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ai-memory'],
    queryFn: () => api.get<any>('/api/ai/memory'),
    refetchInterval: 4000,
    staleTime: 0,
  });
  if (isLoading || !data) return <div className="small muted">Reading memory…</div>;
  const host = data.host as { total: number; available: number; used: number };
  const o = data.ollama as { limitBytes: number | null; resident: number; vram: number; models: any[] };
  const slots = data.slots as { slots: number; running: number; waiting: number; perSlotBytes: number | null; kvBytes: number | null; kvCacheType: string; numCtx: number };
  const gpu = o.vram > 0;
  return (
    <>
      <Meter label="This machine" value={host.used} max={host.total} right={`${fmtBytes(host.used)} of ${fmtBytes(host.total)} · ${fmtBytes(host.available)} free`} />
      {provider === 'ollama' && (
        o.limitBytes
          ? <Meter label="Ollama container" value={o.resident} max={o.limitBytes} right={`${fmtBytes(o.resident)} of ${fmtBytes(o.limitBytes)} allowed`} />
          : <Meter label="Ollama" value={o.resident} max={Math.max(o.resident, 1)} right={`${fmtBytes(o.resident)} resident · no container limit set`} />
      )}
      {provider === 'ollama' && (
        gpu
          // Ollama reports how much of a loaded model sits in VRAM, not how
          // much VRAM the card has, so this is the split between GPU and CPU
          // rather than a share of the card.
          ? <Meter label="On GPU" value={o.vram} max={Math.max(o.resident, o.vram)} right={`${fmtBytes(o.vram)} of ${fmtBytes(o.resident)} in VRAM`} />
          : <div className="small muted mb-8">No GPU: the model runs on the CPU, and everything above is system RAM.</div>
      )}
      {provider === 'ollama' && (
        <div className="small muted">
          {slots.running} of {slots.slots} slot{slots.slots === 1 ? '' : 's'} generating{slots.waiting > 0 && `, ${slots.waiting} waiting`}
          {slots.kvBytes !== null && <> · slots reserve about {fmtBytes(slots.kvBytes)} of context ({slots.numCtx} tokens each, {slots.kvCacheType} cache)</>}
          {o.models.length > 0 && <> · in memory: {o.models.map((m: any) => `${m.name} ${fmtBytes(m.size || m.sizeVram)}`).join(', ')}</>}
        </div>
      )}
    </>
  );
}

// Everyone shares one loaded model. This card is where an admin decides
// whether they share it at the same time, and finds out whether the number of
// slots Ollama was started with matches the number of people who have
// accounts — which only .env can change, so the command is spelled out.
function AiConcurrencyCard({ data, f, save }: { data: any; f: any; save: (patch: any) => void }) {
  const c = data.concurrency;
  if (!c) return null;
  // Somebody else's endpoint decides how much it will do at once, and it is
  // not sharing this machine's memory with anything: none of the slot
  // arithmetic below means anything there, so it is not shown.
  if (f.provider !== 'ollama') {
    return (
      <div className="card mb-16">
        <div className="card-title"><h2>Memory</h2><span className="small muted">{c.users} user{c.users === 1 ? '' : 's'}</span></div>
        <p className="small muted">Generations run on the endpoint you have configured, which decides for itself how many it takes at once, so Tern does not queue them here. This is the memory on this machine.</p>
        <AiMemoryMeter provider={f.provider} />
      </div>
    );
  }
  return (
    <div className="card mb-16">
      <div className="card-title"><h2>Memory and concurrency</h2><span className="small muted">{c.users} user{c.users === 1 ? '' : 's'} · {f.concurrency ? `${c.configured} slot${c.configured === 1 ? '' : 's'}` : `1 of ${c.configured} slots in use`}</span></div>
      <div className="row mb-8">
        <Toggle checked={Boolean(f.concurrency)} onChange={(v) => save({ concurrency: v })} />
        <div>
          <div className="strong small">Answer several people at once</div>
          <div className="help-text">
            On, the assistant runs up to {c.configured} generation{c.configured === 1 ? '' : 's'} at a time — as many as Ollama was started with. One slot is always kept for somebody waiting at a composer, so inbox summaries and sequence mail cannot take them all, and nobody can hold more than one at once. Off, every generation on this install waits for the one before it, which is the safer setting on a box with little memory to spare: each slot holds its own context window.
          </div>
        </div>
      </div>
      {f.provider === 'ollama' && (
        !f.concurrency
          ? <Callout>One generation at a time. Ollama's other {c.configured - 1} slot{c.configured - 1 === 1 ? ' sits' : 's sit'} idle, and everyone — {c.users} people can sign in — waits their turn.</Callout>
          : c.enough
            ? <Callout kind="success">Everyone who can sign in has a slot of their own: {c.configured} for {c.users} user{c.users === 1 ? '' : 's'}.</Callout>
            : <Callout kind="warning">
                {c.users} people can sign in and Ollama serves {c.configured} at a time, so the rest queue.
                {c.memoryBound
                  ? <> Its memory limit pays for about {c.affordable} slot{c.affordable === 1 ? '' : 's'} beside this model{c.perSlotBytes ? ` (${fmtBytes(c.perSlotBytes)} each at ${f.numCtx} tokens)` : ''}, so raise <code>OLLAMA_MEM_LIMIT</code>, lower the context window, or run a smaller model.</>
                  : <> Raise it to {c.recommended}{c.perSlotBytes ? `; each slot costs about ${fmtBytes(c.perSlotBytes)}` : ''}.</>}
                <br />Ollama reads its slot count when it starts, so this is set on the server, not here: <code>./bin/tern ai-slots</code> works out the number, writes it to <code>.env</code> and restarts.
              </Callout>
      )}
      <div className="mt-16"><AiMemoryMeter provider={f.provider} /></div>
    </div>
  );
}

// ---------- Downloads ----------
//
// A pull is a job on the server now, not the HTTP request that asked for it,
// which changes what this side has to do. Starting one opens an event stream
// for the fine-grained updates; losing that stream — switching page, reloading,
// a laptop closing — no longer stops anything, and the download is picked up
// again from the list the models query polls. So the bar can only be dismissed
// by the job ending or by pressing Cancel, and it tells the truth after a
// reload, which is when people used to assume the download had died.
interface PullView {
  id: string; kind: 'model' | 'voice'; name: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  status: string; completed: number; total: number;
  pct: number | null; bytesPerSec: number | null; etaSeconds: number | null;
  startedAt: number; endedAt: number | null; error?: string;
}

function useDownloads(kind: 'model' | 'voice', polled: PullView[] | undefined, onSettled: () => void) {
  const toast = useToast();
  const [live, setLive] = useState<Record<string, PullView>>({});
  // Dismissing is this page's opinion, not the server's: the record stays
  // there for a minute and a half so a browser that was closed during the
  // download can still be told how it went. Without remembering the dismissal
  // here, the next poll — three seconds later — would put the bar straight
  // back, which reads as a button that does not work.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const settle = useRef(onSettled);
  settle.current = onSettled;

  // Anything this tab started streams here; anything else — another admin,
  // another tab, this tab before it was reloaded — arrives on the poll. The
  // stream wins where both have an opinion, because it is newer.
  const merged: Record<string, PullView> = {};
  for (const p of polled ?? []) merged[p.name] = p;
  for (const [name, p] of Object.entries(live)) merged[name] = p;
  for (const name of dismissed) delete merged[name];
  const running = Object.values(merged).filter((p) => p.state === 'running');

  const start = async (name: string) => {
    if (merged[name]?.state === 'running') return;
    // Starting the same name again is asking to see it again.
    setDismissed((d) => { if (!d.has(name)) return d; const next = new Set(d); next.delete(name); return next; });
    setLive((m) => ({ ...m, [name]: { id: `${kind}:${name}`, kind, name, state: 'running', status: 'starting', completed: 0, total: 0, pct: null, bytesPerSec: null, etaSeconds: null, startedAt: Date.now(), endedAt: null } }));
    const path = kind === 'model' ? '/api/ai/models/pull' : '/api/ai/voice/models/pull';
    const body = kind === 'model' ? { name } : { id: name };
    try {
      await apiStream(path, body, {
        onEvent: (ev, d) => {
          if (ev === 'progress' || ev === 'done' || ev === 'detached') setLive((m) => ({ ...m, [name]: { ...m[name], ...d } }));
          if (ev === 'done') toast.success(`${name} is ready`);
          if (ev === 'error') {
            setLive((m) => ({ ...m, [name]: { ...m[name], ...d, state: 'error' } }));
            toast.error(d?.error ?? 'The download failed');
          }
        },
      });
    } catch (e) {
      setLive((m) => ({ ...m, [name]: { ...m[name], state: 'error', error: (e as any)?.message ?? String(e) } }));
      toast.error(e);
    } finally {
      settle.current();
    }
  };

  const cancel = async (name: string) => {
    const path = kind === 'model' ? '/api/ai/models/pull/cancel' : '/api/ai/voice/models/pull/cancel';
    try {
      await api.post(path, kind === 'model' ? { name } : { id: name });
      toast.success(`${name} download cancelled`);
    } catch (e) { toast.error(e); } finally { settle.current(); }
  };

  // A finished bar is worth reading for a moment and then gone.
  const dismiss = (name: string) => {
    setLive((m) => { const { [name]: _gone, ...rest } = m; return rest; });
    setDismissed((d) => new Set(d).add(name));
  };

  return { pulls: Object.values(merged).sort((a, b) => a.startedAt - b.startedAt), running, start, cancel, dismiss, isPulling: (n: string) => merged[n]?.state === 'running' };
}

// "This is the server's answer, and this is how old it is." A list that is
// polled needs to say so, because a stale one and a live one look identical.
function LiveDot({ at, fetching }: { at?: string; fetching?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(t); }, []);
  if (!at) return null;
  const age = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  const stale = age > 30;
  return (
    <span className="row gap-4 faint" title={`Read from the model server ${fmtDateTime(at)}`}>
      <span className={cls('live-dot', fetching && 'busy', stale && 'stale')} />
      {stale ? `${age}s ago` : 'live'}
    </span>
  );
}

function fmtRate(bytesPerSec: number | null): string {
  return bytesPerSec && bytesPerSec > 0 ? `${fmtBytes(bytesPerSec)}/s` : '';
}

function fmtEta(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m left`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m left`;
}

// One download, as much of it as the far end is willing to describe.
//
// A server that reports byte counts gets a real bar, a size, a rate and an
// estimate. One that does not — speaches downloads in a single blocking call
// and says nothing until it is finished — gets a moving stripe, the elapsed
// time and a sentence saying why there is no percentage, rather than a bar
// that pretends to know.
function PullRow({ pull, onCancel, onDismiss }: { pull: PullView; onCancel: () => void; onDismiss: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (pull.state !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [pull.state]);
  const elapsed = Math.max(0, Math.round(((pull.endedAt ?? Date.now()) - pull.startedAt) / 1000));
  const kind = pull.state === 'done' ? 'success' : pull.state === 'running' ? 'info' : 'warning';
  return (
    <div className="mt-16">
      <div className="row small mb-8 gap-8 wrap">
        {pull.state === 'running' ? <Loader2 size={14} className="spin" /> : pull.state === 'done' ? <Check size={14} /> : null}
        <span className="strong">{pull.name}</span>
        <Badge kind={kind}>{pull.state === 'running' ? pull.status : pull.state === 'done' ? 'ready' : pull.state === 'cancelled' ? 'cancelled' : 'failed'}</Badge>
        {pull.total > 0 && <span className="muted">{fmtBytes(pull.completed)} of {fmtBytes(pull.total)}</span>}
        {pull.pct !== null && <span className="muted">{pull.pct}%</span>}
        {pull.state === 'running' && <span className="faint">{[fmtRate(pull.bytesPerSec), fmtEta(pull.etaSeconds)].filter(Boolean).join(' · ') || `${elapsed}s`}</span>}
        <span style={{ flex: 1 }} />
        {pull.state === 'running'
          ? <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          : <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
      </div>
      {pull.pct === null && pull.state === 'running'
        ? <div className="progress-indeterminate" aria-label={`Downloading ${pull.name}`} />
        : <Progress value={pull.state === 'done' ? 100 : (pull.pct ?? 0)} max={100} tone="fill" />}
      {pull.pct === null && pull.state === 'running' && (
        <p className="small faint mt-8">This server downloads in one call and reports nothing until it has finished, so there is no percentage to show. It is still running, and leaving this page will not stop it.</p>
      )}
      {pull.error && pull.state !== 'cancelled' && <p className="small mt-8" style={{ color: 'var(--danger)' }}>{pull.error}</p>}
    </div>
  );
}

// Where dictation is transcribed (F9).
//
// Its own card because it is its own server. The bundled overlay puts
// whisper.cpp on the compose network and fills this in; an install that
// cannot spare the memory — a 4.5 GB box already holding a chat model — puts
// it on another machine and types the address here instead of editing
// compose files and restarting.
function AiVoiceCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ['ai-voice'], queryFn: () => api.get<any>('/api/ai/voice') });
  const [f, setF] = useState<any>(null);
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; error?: string; models?: string[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [del, setDel] = useState<{ id: string; inUse: boolean } | null>(null);
  const [customVoice, setCustomVoice] = useState('');
  // The transcriber's own model list, asked of it rather than remembered.
  // Whether there is anything to show — and whether any of it can be
  // downloaded or deleted — is the transcriber's answer too: see
  // services/voice.ts for why that varies so much between two servers that
  // both speak the same transcription shape.
  const models = useVoiceModels(Boolean(data?.settings?.baseUrl));
  const caps = models.data?.capabilities;
  const downloads = useDownloads('voice', models.data?.pulls, () => { void models.refetch(); void refetch(); });
  useEffect(() => { if (data && !f) setF({ ...data.settings }); }, [data, f]);
  if (!data || !f) return null;

  async function save(patch: any) {
    try {
      const r = await api.put<any>('/api/ai/voice', patch);
      setF({ ...r.settings });
      setKey('');
      setTested(null);
      refetch();
      // A different address is a different server with a different model list.
      qc.invalidateQueries({ queryKey: ['voice-models'] });
      toast.success('Saved');
    } catch (e) { toast.error(e); }
  }

  // Same contract as deleting a writing model: the server only calls it done
  // once the transcriber's own list agrees, and the table is redrawn from
  // that list rather than from the assumption that the row is gone.
  async function doDeleteVoice(id: string) {
    setBusy(id);
    try {
      const r = await api.del<any>(`/api/ai/voice/models?id=${encodeURIComponent(id)}`);
      toast.success(r?.modelCleared ? `${id} deleted — the transcriber's own default is in use now` : `${id} deleted`);
      void models.refetch();
      void refetch();
    } catch (e) { toast.error(e); void models.refetch(); } finally { setBusy(''); }
  }
  async function test() {
    setTesting(true);
    try {
      const r = await api.post<any>('/api/ai/voice/test', { baseUrl: f.baseUrl, apiKey: key || undefined, model: f.model || undefined });
      setTested({ ...r.health });
    } catch (e) { toast.error(e); } finally { setTesting(false); }
  }

  const health = tested ?? data.health;
  return (
    <div className="card mb-16">
      <div className="card-title">
        <h2>Dictation</h2>
        <div className="row">
          <Toggle checked={Boolean(f.enabled)} disabled={!f.baseUrl} onChange={(v) => { setF({ ...f, enabled: v }); void save({ enabled: v }); }} />
          <span className="small">{f.baseUrl ? 'Enabled' : 'No transcriber'}</span>
        </div>
      </div>
      <p className="muted small">
        Speech to text for the microphone buttons, on a server that speaks OpenAI&rsquo;s{' '}
        <code>/v1/audio/transcriptions</code> — the bundled whisper.cpp container, or one of your own on
        another machine. The recording is never written to disk on this side and the transcript is never
        stored, whichever you choose.
      </p>
      <div className="form-row">
        <Field label="Transcriber URL" hint={data.envUrl ? `The bundled container is at ${data.envUrl}. Clearing this box turns dictation off.` : 'Empty means dictation is unavailable and says so, rather than failing at the microphone.'}>
          <Input value={f.baseUrl ?? ''} onChange={(e) => { setF({ ...f, baseUrl: e.target.value }); setTested(null); }} placeholder="http://whisper:8080" />
        </Field>
        <Field label="API key" hint={data.settings.hasApiKey ? 'A key is stored; leave blank to keep it.' : 'Only needed for a remote transcriber behind a proxy that wants one.'}>
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={data.settings.hasApiKey ? '••••••••' : ''} />
        </Field>
        {/* A list when the transcriber has one, a text box when it does not.
            The box on its own was the wrong control for both cases: against
            whisper.cpp it does nothing, and against speaches it invited a
            model name that had to match a list nobody could see. */}
        {caps?.lists && (models.data?.installed ?? []).length > 0 ? (
          <Field label="Model" hint="What this transcriber has now, read from it. Empty means whatever it defaults to.">
            <Select value={f.model ?? ''} onChange={(e) => { setF({ ...f, model: e.target.value }); void save({ model: e.target.value }); }}>
              <option value="">the transcriber&rsquo;s own default</option>
              {(models.data?.installed ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.id}</option>)}
              {/* A model named in the settings that the server no longer has
                  is still shown, so the mismatch is visible rather than
                  silently reset to the first entry in the list. */}
              {f.model && !(models.data?.installed ?? []).some((m: any) => m.id === f.model) && <option value={f.model}>{f.model} — not on this server</option>}
            </Select>
          </Field>
        ) : (
          <Field label="Model" hint="Leave empty for whatever the transcriber was started with, which is right for the bundled container. A server hosting several needs the name.">
            <Input value={f.model ?? ''} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="whisper-1" />
          </Field>
        )}
        <Field label="Language" hint="An ISO code (en, de, fr) to stop the model guessing, or empty to let it detect. What the browser sends for a particular clip still wins.">
          <Input value={f.language ?? ''} onChange={(e) => setF({ ...f, language: e.target.value })} placeholder="auto" />
        </Field>
      </div>
      {f.baseUrl && data.local === false && (
        <Callout kind="warning">
          That address is not on this box. Every dictated clip will be uploaded to it, so it should be a
          machine you run, reached over a private network or TLS — and if it is somebody else&rsquo;s
          service, your people&rsquo;s voices are going to it.
        </Callout>
      )}
      <div className="row mt-8 gap-8">
        <Button variant="primary" onClick={() => save({ baseUrl: f.baseUrl, apiKey: key || undefined, model: f.model, language: f.language })}>Save</Button>
        <Button variant="ghost" loading={testing} disabled={!f.baseUrl} onClick={test}>Test connection</Button>
        {data.settings.hasApiKey && <Button size="sm" variant="ghost" onClick={() => save({ apiKey: null })}>Clear key</Button>}
        {health && (
          health.ok
            ? <Badge kind="success">reachable{health.models?.length ? ` · ${health.models.slice(0, 3).join(', ')}` : ''}</Badge>
            : <Badge kind="warning">{health.error ?? 'not reachable'}</Badge>
        )}
      </div>
      {f.baseUrl && <VoiceModels data={models.data} loading={models.isLoading} at={models.data?.at} fetching={models.isFetching}
        current={data.settings.model} busy={busy} downloads={downloads}
        onUse={(id) => { setF({ ...f, model: id }); void save({ model: id }); }}
        onDelete={(id) => setDel({ id, inUse: data.settings.model === id })}
        custom={customVoice} setCustom={setCustomVoice} />}
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete ${del?.id}?`} confirmLabel="Delete model"
        message={<>The weights are removed from the transcriber and can only come back by downloading them again.{del?.inUse && <><br /><br /><b>This is the model dictation is set to use.</b> The setting is cleared with it, so the transcriber falls back to its own default.</>}</>}
        onConfirm={() => { const id = del!.id; setDel(null); return doDeleteVoice(id); }} />
    </div>
  );
}

// The transcriber's models, live.
//
// Three quite different servers end up here, and the card says which one it
// is talking to rather than drawing the same table for all of them:
//
//   whisper.cpp   one model, fixed when the container started, no model API.
//                 There is nothing to list and nothing to manage, and saying
//                 so is more use than an empty table.
//   speaches      many models, a registry it can download from, and delete.
//                 Full table.
//   anything else lists what it has, manages none of it. Table without the
//                 buttons that would fail.
function VoiceModels({ data, loading, at, fetching, current, busy, downloads, onUse, onDelete, custom, setCustom }: {
  data: any; loading: boolean; at?: string; fetching?: boolean; current: string; busy: string;
  downloads: ReturnType<typeof useDownloads>;
  onUse: (id: string) => void; onDelete: (id: string) => void;
  custom: string; setCustom: (v: string) => void;
}) {
  if (loading && !data) return <div className="mt-16"><Spinner /></div>;
  const caps = data?.capabilities;
  if (!caps) return null;
  const installed: any[] = data.installed ?? [];
  const available: any[] = data.available ?? [];

  if (!caps.lists) {
    return (
      <Callout kind={caps.ok ? 'info' : 'warning'}>
        {caps.ok
          ? <>This transcriber serves one model, chosen when it started, and has no model list to read — that is the bundled whisper.cpp. Change it with <code>WHISPER_MODEL</code> in <code>.env</code> and restart the container; <code>base</code> is 150&nbsp;MB and <code>small</code> is 500&nbsp;MB and better on accents and names. A transcriber that hosts several models, such as speaches, is listed and managed from here instead.</>
          : <>Its model list could not be read: {caps.error ?? 'no answer'}.</>}
      </Callout>
    );
  }

  const rows = [
    ...installed.map((m: any) => ({ ...m, installed: true, active: current === m.id })),
    ...available.map((m: any) => ({ ...m, installed: false, active: false })),
  ];
  return (
    <div className="mt-16">
      <div className="row gap-8 mb-8 small muted">
        <LiveDot at={at} fetching={fetching} />
        <span>{installed.length} on the transcriber{caps.manages ? `, ${available.length} more it can fetch` : ''}</span>
      </div>
      {data.error && <Callout kind="warning">The model list could not be read: {data.error}</Callout>}
      {downloads.pulls.map((p) => <PullRow key={p.name} pull={p} onCancel={() => downloads.cancel(p.name)} onDismiss={() => downloads.dismiss(p.name)} />)}
      <DataTable rows={rows} rowKey={(m: any) => m.id} columns={[
        { key: 'model', header: 'Model', primary: true, cell: (m: any) => <span className="row gap-4 wrap"><span className="strong">{m.id}</span>{m.active && <Badge kind="accent">in use</Badge>}{!m.installed && <Badge kind="info">not downloaded</Badge>}</span> },
        { key: 'lang', header: 'Languages', className: 'muted small', nowrap: true, cell: (m: any) => Array.isArray(m.language) ? (m.language.length > 3 ? `${m.language.slice(0, 3).join(', ')} +${m.language.length - 3}` : m.language.join(', ')) : (m.language ?? <span className="faint">—</span>) },
        { key: 'act', actions: true, cell: (m: any) => m.installed ? <>
          <Button size="sm" disabled={m.active} onClick={() => onUse(m.id)}>{m.active ? 'Selected' : 'Use'}</Button>
          {caps.manages && <IconButton label="Delete" className="btn-sm" disabled={busy === m.id} onClick={() => onDelete(m.id)}><Trash2 size={14} /></IconButton>}
        </> : <Button size="sm" icon={<Download size={13} />} loading={downloads.isPulling(m.id)} disabled={downloads.isPulling(m.id)} onClick={() => void downloads.start(m.id)}>Download</Button> },
      ]} />
      {caps.manages && (
        <div className="row mt-16">
          <Input className="input-sm" placeholder="any repository the transcriber can fetch, e.g. Systran/faster-whisper-medium" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ maxWidth: 420 }} />
          <Button size="sm" disabled={!custom.trim() || downloads.isPulling(custom.trim())} onClick={() => { void downloads.start(custom.trim()); setCustom(''); }}>Download</Button>
        </div>
      )}
      {!caps.manages && <p className="small faint mt-8">This transcriber lists its models but does not download or remove them from an API, so those are managed wherever it runs.</p>}
    </div>
  );
}

function AiAdminSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useAiStatus();
  const [f, setF] = useState<any>(null);
  const [customModel, setCustomModel] = useState('');
  const [customEmbed, setCustomEmbed] = useState('');
  const [del, setDel] = useState<{ name: string; inUse: boolean; loaded: boolean; kind: 'write' | 'embed' } | null>(null);
  const [busy, setBusy] = useState('');
  const [probe, setProbe] = useState<any>(null);
  const [probing, setProbing] = useState(false);
  // What the model server has, asked of it every few seconds rather than
  // taken from whatever /status happened to see when the page was opened.
  // Only for Ollama: an OpenAI-compatible endpoint has no models to manage.
  const isOllama = (f?.provider ?? data?.settings?.provider) === 'ollama';
  const live = useAiModels(isOllama);
  const refetch = () => { qc.invalidateQueries({ queryKey: ['ai-status'] }); return live.refetch(); };
  const downloads = useDownloads('model', live.data?.pulls, () => { void live.refetch(); qc.invalidateQueries({ queryKey: ['ai-status'] }); });
  useEffect(() => { if (data && !f) setF({ ...data.settings }); }, [data, f]);
  async function save(patch: any) {
    try {
      const r = await api.put<any>('/api/ai/settings', patch);
      qc.invalidateQueries({ queryKey: ['ai-status'] });
      // Changing the embedding model queues every message indexed by the old
      // one for rebuilding, which is worth saying out loud rather than
      // leaving as background work nobody asked for.
      toast.success(r?.reindex ? `Saved — ${r.reindex.toLocaleString()} message${r.reindex === 1 ? '' : 's'} queued for re-indexing` : 'Saved');
    } catch (e) { toast.error(e); }
  }
  // Ask whether the address in the form works before committing to it.
  // Saving unloads the model the install is using, so trying three spellings
  // of a remote URL by saving each one takes the assistant down three times.
  async function testProvider() {
    setProbing(true); setProbe(null);
    try {
      const r = await api.post<any>('/api/ai/test', { provider: f.provider, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, tlsInsecure: Boolean(f.tlsInsecure), model: f.model });
      setProbe(r);
    } catch (e: any) { setProbe({ result: { ok: false, error: e?.message ?? String(e) } }); } finally { setProbing(false); }
  }
  // Deleting a model removes gigabytes that can only come back over the
  // network, so it is confirmed, a refusal is reported, and the table is
  // redrawn from the list the server sends back rather than from the
  // assumption that the row is now gone. The server only calls it deleted
  // once the model server's own list agrees.
  async function doDelete(name: string) {
    setBusy(name);
    try {
      const r = await api.del<any>(`/api/ai/models?name=${encodeURIComponent(name)}`);
      toast.success(`${name} deleted`);
      // Straight from the answer: no window in which the page shows a model
      // that is not there any more, and none in which it shows one that is.
      if (Array.isArray(r?.models)) qc.setQueryData(['ai-models'], (prev: any) => ({ ...(prev ?? {}), ok: true, models: r.models, loaded: r.loaded ?? [], at: new Date().toISOString() }));
      void refetch();
    } catch (e) { toast.error(e); void refetch(); } finally { setBusy(''); }
  }
  async function doUnload(name: string) {
    setBusy(name);
    try {
      const r = await api.post<{ unloaded: boolean }>('/api/ai/models/unload', { name });
      toast.success(r.unloaded ? `${name} unloaded` : `${name} was not in memory`);
      void refetch();
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  }
  if (isLoading || !data || !f) return <Spinner />;
  // The tables are drawn from the live answer. /status is still where the
  // catalogue and the settings come from, but it is not asked what the model
  // server has — it saw that once, when the page opened.
  const installed: any[] = live.data?.models ?? data.models ?? [];
  const loadedList: any[] = live.data?.loaded ?? data.loaded ?? [];
  // Reachable at this instant, as opposed to when /status last ran. An
  // unreachable server and a server with no models used to draw the same
  // empty table.
  const liveError: string | null = live.data && !live.data.ok ? (live.data.error ?? 'The model server did not answer') : null;
  const findInstalled = (n: string) => installed.find((x: any) => x.name === n || x.name === `${n}:latest`);
  // What Ollama is holding in memory, matched the same way: the settings say
  // "qwen2.5", /api/ps says "qwen2.5:latest".
  const findLoaded = (n: string) => loadedList.find((x: any) => x.name === n || x.name === `${n}:latest`);
  // Ollama tags an untagged name with `:latest`, so "all-minilm" in the
  // settings and "all-minilm:latest" in the model list are the same thing.
  const sameName = (a: string, b: string) => { const n = (v: string) => (String(v ?? '').includes(':') ? String(v) : `${v}:latest`); return Boolean(a) && n(a) === n(b); };
  // A model that only embeds cannot draft. Listing one in the table below
  // offered a "Use" button that would set it as the writing model and break
  // every AI feature; they get their own card instead.
  const embeds = (x: any) => (x.capabilities ?? []).includes('embedding');
  const knownEmbed = (n: string) => (data.embedModels ?? []).some((c: any) => sameName(c.name, n));
  const modelRows: { name: string; inst: any; loaded: any; active: boolean; note: string; sizeGB?: number }[] = [
    ...data.curated.map((m: any) => ({ name: m.name, inst: findInstalled(m.name), loaded: findLoaded(m.name), active: data.settings.model === m.name, note: m.note, sizeGB: m.sizeGB })),
    ...installed.filter((x: any) => !data.curated.some((c: any) => c.name === x.name || `${c.name}:latest` === x.name) && !embeds(x) && !knownEmbed(x.name)).map((x: any) => ({ name: x.name, inst: x, loaded: findLoaded(x.name), active: data.settings.model === x.name, note: `${x.parameterSize ?? ''} ${x.quantization ?? ''}`.trim() })),
  ];
  const embedRows: any[] = [
    ...(data.embedModels ?? []).map((m: any) => ({ name: m.name, inst: findInstalled(m.name), loaded: findLoaded(m.name), active: sameName(data.settings.embedModel, m.name), note: m.note, params: m.params, contextTokens: m.contextTokens, sizeBytes: m.sizeBytes, needsBytes: m.needsBytes })),
    ...installed.filter((x: any) => embeds(x) && !knownEmbed(x.name)).map((x: any) => ({ name: x.name, inst: x, loaded: findLoaded(x.name), active: sameName(data.settings.embedModel, x.name), note: `${x.parameterSize ?? ''} ${x.quantization ?? ''}`.trim() })),
  ];
  // Which downloads belong to which card, so a bar appears under the table
  // that started it rather than under both.
  const embedNames = new Set<string>(embedRows.map((m: any) => m.name));
  const residentGB = loadedList.reduce((n: number, m: any) => n + (m.size ?? m.sizeVram ?? 0), 0) / 1024 ** 3;
  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="AI model" sub="The provider and model behind everyone's assistant, its standing instructions and its tuning." />
      <div className="card mb-16"><AiStatusLine data={data} admin /></div>
      <AiConcurrencyCard data={data} f={f} save={(patch) => { setF({ ...f, ...patch }); void save(patch); }} />
      <div className="card mb-16">
        <div className="card-title"><h2>Provider and model</h2><div className="row"><Toggle checked={f.enabled} onChange={(v) => { setF({ ...f, enabled: v }); void save({ enabled: v }); }} /><span className="small">Enabled</span></div></div>
        <div className="form-row">
          <Field label="Provider"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="ollama">Ollama (local, default)</option><option value="openai">OpenAI-compatible API</option></Select></Field>
          <Field label="Base URL" hint="The server's root — scheme, host and port, with no path and no trailing slash. A rented GPU box publishes something like https://203.0.113.10:40123."><Input value={f.baseUrl} onChange={(e) => { setF({ ...f, baseUrl: e.target.value }); setProbe(null); }} placeholder={f.provider === 'ollama' ? 'http://ollama:11434' : 'https://api.example.com'} /></Field>
          <Field label="API key" hint={data.settings.hasApiKey ? 'A key is stored; leave blank to keep it.' : f.provider === 'ollama' ? 'Only for an Ollama somewhere else: it has no authentication of its own, so a remote one belongs behind a proxy, and this is the bearer token sent to it — as Authorization: Bearer. A hosted box usually calls it an instance or open-button token. The bundled container needs nothing here.' : ''}><Input type="password" value={f.apiKey ?? ''} onChange={(e) => { setF({ ...f, apiKey: e.target.value }); setProbe(null); }} /></Field>
          <Field label="Model name"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          <Field label="Temperature" hint="Lower is more literal; 0.7 is a good default for email."><Input type="number" step={0.1} min={0} max={2} value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} /></Field>
          <Field label="Context window (tokens)" hint={`How much of a conversation the model can see. 8192 holds a long thread; lower it to save memory and a long thread loses its middle. Every parallel slot holds its own, so the memory cost is multiplied by ${data.concurrency?.plan?.slots ?? 1}.`}><Input type="number" min={512} max={131072} value={f.numCtx} onChange={(e) => setF({ ...f, numCtx: Number(e.target.value) })} /></Field>
        </div>
        {/* Only asked about for an https address, because it is only https
            that can fail this way. A hosted GPU box issues itself a
            certificate at boot and no public authority will vouch for it. */}
        {/^https:/i.test(f.baseUrl ?? '') && (
          <div className="mt-16">
            <div className="row"><Toggle checked={Boolean(f.tlsInsecure)} onChange={(v) => { setF({ ...f, tlsInsecure: v }); setProbe(null); }} /><span className="small">Trust this server's certificate even if it cannot be verified</span></div>
            <p className="small muted">
              Off, the certificate has to be one a public authority vouches for. Turn it on for a model server
              that issued its own — the usual case on a rented GPU host. The connection is still encrypted, but
              nothing proves the machine on the other end is the one you meant, so only turn it on for a server
              whose address you control.
            </p>
            {f.tlsInsecure && (data.cert ?? probe?.result?.cert) && (
              <p className="small muted">
                Currently presenting: <code>{(data.cert ?? probe.result.cert).subject}</code>, issued by{' '}
                <code>{(data.cert ?? probe.result.cert).issuer}</code>, fingerprint{' '}
                <code style={{ wordBreak: 'break-all' }}>{(data.cert ?? probe.result.cert).fingerprint}</code>.
              </p>
            )}
          </div>
        )}
        {data.local === false && (
          <Callout kind="warning">
            That address is not on this box. Everything the assistant is given — the text of the emails it
            drafts replies to, and whatever people type into it — will be sent there. That is a supported
            choice, and the right one when the model runs on your own hardware elsewhere; it is worth
            knowing that it is the setting where mail starts leaving your server.
          </Callout>
        )}
        {probe && (
          <Callout kind={probe.result?.ok ? (probe.result?.error || probe.result?.modelInstalled === false ? 'warning' : 'success') : 'danger'}>
            {probe.result?.ok
              ? <>Connected{probe.result.version ? <> to Ollama {probe.result.version}</> : null}.{' '}
                  {probe.result.modelInstalled === false
                    ? <>That server does not have <code>{f.model}</code>{probe.result.models?.length ? <> — it has {probe.result.models.slice(0, 6).map((m: string) => <code key={m}> {m}</code>)}{probe.result.models.length > 6 ? ` and ${probe.result.models.length - 6} more` : ''}</> : ''}.</>
                    : probe.result.modelInstalled ? <><code>{f.model}</code> is there.</> : null}
                  {probe.result.error ? <> {probe.result.error}</> : null}
                  {probe.local === false ? <><br />That address is not on this box: mail text will be sent there.</> : null}
                </>
              : probe.result?.error ?? 'That address could not be reached'}
          </Callout>
        )}
        <div className="row">
          <Button variant="primary" onClick={() => save({ provider: f.provider, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, tlsInsecure: Boolean(f.tlsInsecure), model: f.model, temperature: f.temperature, numCtx: f.numCtx })}>Save settings</Button>
          <Button variant="ghost" loading={probing} disabled={!f.baseUrl} onClick={testProvider}>Test connection</Button>
        </div>
      </div>
      <div className="card mb-16">
        <div className="card-title"><h2>System prompt</h2><Button size="sm" variant="ghost" onClick={() => setF({ ...f, systemPrompt: '' })}>Reset to default</Button></div>
        <p className="muted small">The standing instructions every generation starts with: who the assistant is, house rules, things it must never say. Leave empty to use the built-in default shown as the placeholder. Per-account voice notes (Settings → Accounts → Identity) are added on top.</p>
        <Textarea value={f.systemPrompt ?? ''} onChange={(e) => setF({ ...f, systemPrompt: e.target.value })} placeholder={data.defaultSystemPrompt} style={{ minHeight: 180, fontFamily: 'var(--mono)', fontSize: 12.5 }} />
        <Button variant="primary" className="mt-8" onClick={() => save({ systemPrompt: f.systemPrompt ?? '' })}>Save system prompt</Button>
      </div>
      <div className="card mb-16">
        <div className="card-title"><h2>Tuning</h2><Button size="sm" variant="ghost" onClick={() => setF({ ...f, ...pick(data.defaults, TUNING_FIELDS) })}>Defaults</Button></div>
        <AiPresets data={data} f={f} setF={setF} save={save} onChanged={() => qc.invalidateQueries({ queryKey: ['ai-status'] })} />
        <div className="form-grid-3">
          <Field label={`Temperature: ${f.temperature}`} hint="Creativity. 0.3 literal, 0.7 natural, 1.0+ loose."><input className="range" type="range" min={0} max={1.5} step={0.05} value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} /></Field>
          <Field label={`Top-p: ${f.topP}`} hint="Nucleus sampling. Lower is safer."><input className="range" type="range" min={0.1} max={1} step={0.05} value={f.topP} onChange={(e) => setF({ ...f, topP: Number(e.target.value) })} /></Field>
          <Field label={`Top-k: ${f.topK}`} hint="Candidates per token."><input className="range" type="range" min={1} max={100} step={1} value={f.topK} onChange={(e) => setF({ ...f, topK: Number(e.target.value) })} /></Field>
          <Field label={`Min-p: ${f.minP ?? 0}`} hint="Drops tokens far less likely than the best one. 0 is off; 0.05 is a good starting point, and pairs better with a higher temperature than top-p does."><input className="range" type="range" min={0} max={0.5} step={0.01} value={f.minP ?? 0} onChange={(e) => setF({ ...f, minP: Number(e.target.value) })} /></Field>
          <Field label={`Repeat penalty: ${f.repeatPenalty}`} hint="Above 1 discourages repetition."><input className="range" type="range" min={0.8} max={1.6} step={0.05} value={f.repeatPenalty} onChange={(e) => setF({ ...f, repeatPenalty: Number(e.target.value) })} /></Field>
          <Field label="Repeat window (tokens)" hint="How far back that penalty looks. Ollama's own default of 64 is less than a paragraph, so a model that opens every paragraph the same way is never caught; -1 is the whole context, 0 turns it off."><Input type="number" min={-1} max={8192} value={f.repeatLastN ?? 256} onChange={(e) => setF({ ...f, repeatLastN: Number(e.target.value) })} /></Field>
          <Field label={`Frequency penalty: ${f.frequencyPenalty ?? 0}`} hint="Charges a word for each time it has already been used. 0 is off."><input className="range" type="range" min={0} max={2} step={0.1} value={f.frequencyPenalty ?? 0} onChange={(e) => setF({ ...f, frequencyPenalty: Number(e.target.value) })} /></Field>
          <Field label={`Presence penalty: ${f.presencePenalty ?? 0}`} hint={f.provider === 'openai' ? 'Charges a word once for having appeared at all, which nudges the model onto new ground. With an OpenAI-compatible endpoint these two are the only repetition controls that cross over: repeat penalty and top-k are not sent, because real OpenAI refuses them.' : 'Charges a word once for having appeared at all, which nudges the model onto new ground. 0 is off.'}><input className="range" type="range" min={0} max={2} step={0.1} value={f.presencePenalty ?? 0} onChange={(e) => setF({ ...f, presencePenalty: Number(e.target.value) })} /></Field>
          <Field label="Max tokens per reply" hint="Caps the length of a generation."><Input type="number" min={64} max={4096} value={f.maxTokens} onChange={(e) => setF({ ...f, maxTokens: Number(e.target.value) })} /></Field>
          <Field label="Keep model loaded" hint="A duration with a unit (30s, 10m, 1h), or seconds as a number: -1 never unloads, 0 unloads at once."><Input value={f.keepAlive} onChange={(e) => setF({ ...f, keepAlive: e.target.value })} /></Field>
        </div>
        <div className="row mt-8 mb-8">
          <Toggle checked={Boolean(f.allowThinking)} onChange={(v) => setF({ ...f, allowThinking: v })} />
          <div>
            <div className="strong small row gap-8">Let reasoning models think
              {data.modelCanThink === false && <Badge kind="warning">{f.model} cannot think</Badge>}
              {data.modelCanThink === true && <Badge kind="success">{f.model} can think</Badge>}
            </div>
            <div className="help-text">Models like qwen3 and deepseek-r1 work an answer out before writing it. The reasoning is never put in a draft and is paid for out of its own budget below, so it cannot eat the email. It is much slower — on a CPU-only box expect a minute or two per email instead of a few seconds — and for writing email it rarely reads better, so off is the sensible setting unless you have a GPU. When it is on and the model can reason, the working-out streams into the page everywhere the assistant writes: the composer, a thread summary, quick replies, templates and the playground below. One-line inbox summaries never think — they are not worth a reasoning budget. A model that cannot reason ignores this setting, which is why the badge above says which you have.</div>
          </div>
        </div>
        {f.allowThinking && (
          <div className="form-row mb-8">
            <Field label="How hard to think" hint="Passed to the model as its reasoning effort."><Select value={f.thinkEffort ?? 'low'} onChange={(e) => setF({ ...f, thinkEffort: e.target.value })}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></Select></Field>
            <Field label="Thinking budget (tokens)" hint="Room for the working-out, on top of the reply length. If the model spends it all and writes nothing, Tern asks again with thinking off rather than showing an error, and the log says how much reasoning it wanted."><Input type="number" min={0} max={8192} value={f.thinkingBudget ?? 1500} onChange={(e) => setF({ ...f, thinkingBudget: Number(e.target.value) })} /></Field>
          </div>
        )}
        <Button variant="primary" onClick={() => save({ temperature: f.temperature, topP: f.topP, topK: f.topK, minP: f.minP, repeatPenalty: f.repeatPenalty, repeatLastN: f.repeatLastN, presencePenalty: f.presencePenalty, frequencyPenalty: f.frequencyPenalty, maxTokens: f.maxTokens, numCtx: f.numCtx, keepAlive: f.keepAlive, allowThinking: f.allowThinking, thinkEffort: f.thinkEffort, thinkingBudget: f.thinkingBudget })}>Save tuning</Button>
      </div>
      {f.provider === 'ollama' && (
        <div className="card mb-16">
          <div className="card-title"><h2>Models</h2><span className="small muted row gap-8">
            <LiveDot at={live.data?.at} fetching={live.isFetching} />
            Recommended for {data.totalMemGiB} GB: <b>{data.recommended.model}</b>{loadedList.length > 0 && <> · {loadedList.length} in memory, {residentGB.toFixed(1)} GB</>}
          </span></div>
          {/* An unreachable model server says so. Without this the table was
              empty and read as "you have no models", which about a remote box
              holding forty gigabytes of them is a lie the page told calmly. */}
          {liveError
            ? <Callout kind="danger">This list could not be read from <code>{data.settings.baseUrl}</code>: {liveError}. Nothing below is current until it answers again.</Callout>
            : <Callout>{data.recommended.note} Pulling downloads from the Ollama registry once; models live in the <code>ollama</code> volume{data.local === false ? ' on that machine' : ''}.</Callout>}
          {downloads.pulls.filter((p) => !embedNames.has(p.name)).map((p) => <PullRow key={p.name} pull={p} onCancel={() => downloads.cancel(p.name)} onDismiss={() => downloads.dismiss(p.name)} />)}
          <div className="mt-16"><DataTable rows={modelRows} rowKey={(m) => m.name} columns={[
            { key: 'model', header: 'Model', primary: true, cell: (m) => <span className="row gap-4 wrap"><span className="strong">{m.name}</span>{m.active && <Badge kind="accent">in use</Badge>}{m.loaded && <Badge kind="warning" dot>loaded</Badge>}{m.name === data.recommended.model && <Badge kind="success">recommended</Badge>}</span> },
            { key: 'size', header: 'Size', className: 'muted', nowrap: true, cell: (m) => m.inst ? fmtBytes(m.inst.size) : `~${m.sizeGB} GB` },
            // Only meaningful for a model that is resident: what it is holding
            // now, and when Ollama will let it go. A keep-alive of -1 puts that
            // date centuries out, which is worth being able to see.
            { key: 'mem', header: 'In memory', className: 'muted small', nowrap: true, cell: (m) => m.loaded ? <span title={`Expires ${fmtDateTime(m.loaded.expiresAt)}`}>{fmtBytes(m.loaded.size || m.loaded.sizeVram)}{m.loaded.sizeVram > 0 && ' on GPU'} · {new Date(m.loaded.expiresAt).getFullYear() > 2100 ? 'never unloads' : `until ${fmtRelative(m.loaded.expiresAt)}`}</span> : <span className="faint">—</span> },
            { key: 'note', header: 'Note', secondary: true, className: 'muted small', cell: (m) => m.note },
            { key: 'act', actions: true, cell: (m) => m.inst ? <>
              <Button size="sm" disabled={m.active} onClick={() => save({ model: m.name })}>{m.active ? 'Selected' : 'Use'}</Button>
              {m.loaded && <Button size="sm" variant="ghost" loading={busy === m.name} onClick={() => doUnload(m.name)}>Unload</Button>}
              <IconButton label="Delete" className="btn-sm" disabled={busy === m.name} onClick={() => setDel({ name: m.name, inUse: m.active, loaded: Boolean(m.loaded), kind: 'write' })}><Trash2 size={14} /></IconButton>
            </> : <Button size="sm" icon={<Download size={13} />} loading={downloads.isPulling(m.name)} disabled={downloads.isPulling(m.name) || Boolean(liveError)} onClick={() => downloads.start(m.name)}>Pull</Button> },
          ]} /></div>
          <div className="row mt-16"><Input className="input-sm" placeholder="any model from ollama.com/library, e.g. mistral:7b" value={customModel} onChange={(e) => setCustomModel(e.target.value)} style={{ maxWidth: 360 }} /><Button size="sm" disabled={!customModel.trim() || downloads.isPulling(customModel.trim())} onClick={() => { void downloads.start(customModel.trim()); setCustomModel(''); }}>Pull</Button></div>
          <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete ${del?.name}?`} confirmLabel="Delete model"
            message={<>The files are removed from the <code>ollama</code> volume and can only come back by downloading them again.{del?.loaded && ' It is in memory now and will be unloaded first.'}{del?.inUse && (del.kind === 'embed'
              ? <><br /><br /><b>This is the model meaning search is set to use.</b> Search falls back to matching words until you pick another one, and the vectors already stored stay unusable until something is indexed again.</>
              : <><br /><br /><b>This is the model the assistant is set to use.</b> Drafting will fail until you pick another one.</>)}</>}
            onConfirm={() => { const n = del!.name; setDel(null); return doDelete(n); }} />
        </div>
      )}
      {f.provider === 'ollama' && (
        <div className="card mb-16">
          <div className="card-title"><h2>Meaning search</h2><span className="small muted row gap-8"><LiveDot at={live.data?.at} fetching={live.isFetching} />In use: <b>{data.settings.embedModel}</b>{findInstalled(data.settings.embedModel) ? '' : ' · not downloaded'}</span></div>
          <Callout kind={findInstalled(data.settings.embedModel) ? 'info' : 'warning'}>
            {findInstalled(data.settings.embedModel)
              ? <>Search by meaning turns each message into a vector with a second, much smaller model — it loads beside the writing model rather than instead of it, so the memory it wants is on top. It never writes a word.</>
              : <><b>{data.settings.embedModel}</b> is not downloaded, so meaning search cannot index anything and falls back to matching words. Pull it below.</>}
            {' '}Vectors are only comparable with others from the same model, so changing it queues every indexed message to be embedded again.
          </Callout>
          {downloads.pulls.filter((p) => embedNames.has(p.name)).map((p) => <PullRow key={p.name} pull={p} onCancel={() => downloads.cancel(p.name)} onDismiss={() => downloads.dismiss(p.name)} />)}
          <div className="mt-16"><DataTable rows={embedRows} rowKey={(m: any) => m.name} columns={[
            { key: 'model', header: 'Model', primary: true, cell: (m: any) => <span className="row gap-4 wrap"><span className="strong">{m.name}</span>{m.active && <Badge kind="accent">in use</Badge>}{m.loaded && <Badge kind="warning" dot>loaded</Badge>}</span> },
            // The download and, separately, what it occupies once loaded —
            // which is the number that decides whether it fits beside the
            // writing model, and the one people actually need.
            { key: 'size', header: 'Size', className: 'muted', nowrap: true, cell: (m: any) => m.inst ? fmtBytes(m.inst.size) : m.sizeBytes ? <>{fmtBytes(m.sizeBytes)} <span className="faint">· wants {fmtBytes(m.needsBytes)}</span></> : '—' },
            { key: 'ctx', header: 'Per vector', className: 'muted small', nowrap: true, cell: (m: any) => m.contextTokens ? <span title="How much of a message goes into one vector before it is truncated">{m.params} · {m.contextTokens.toLocaleString()} tok</span> : <span className="faint">—</span> },
            { key: 'mem', header: 'In memory', className: 'muted small', nowrap: true, cell: (m: any) => m.loaded ? <span title={`Expires ${fmtDateTime(m.loaded.expiresAt)}`}>{fmtBytes(m.loaded.size || m.loaded.sizeVram)}{m.loaded.sizeVram > 0 && ' on GPU'}</span> : <span className="faint">—</span> },
            { key: 'note', header: 'Note', secondary: true, className: 'muted small', cell: (m: any) => m.note },
            { key: 'act', actions: true, cell: (m: any) => m.inst ? <>
              <Button size="sm" disabled={m.active} onClick={() => save({ embedModel: m.name })}>{m.active ? 'Selected' : 'Use'}</Button>
              {m.loaded && <Button size="sm" variant="ghost" loading={busy === m.name} onClick={() => doUnload(m.name)}>Unload</Button>}
              <IconButton label="Delete" className="btn-sm" disabled={busy === m.name} onClick={() => setDel({ name: m.name, inUse: m.active, loaded: Boolean(m.loaded), kind: 'embed' })}><Trash2 size={14} /></IconButton>
            </> : <Button size="sm" icon={<Download size={13} />} loading={downloads.isPulling(m.name)} disabled={downloads.isPulling(m.name) || Boolean(liveError)} onClick={() => downloads.start(m.name)}>Pull</Button> },
          ]} /></div>
          <div className="row mt-16"><Input className="input-sm" placeholder="any embedding model, e.g. mxbai-embed-large" value={customEmbed} onChange={(e) => setCustomEmbed(e.target.value)} style={{ maxWidth: 360 }} /><Button size="sm" disabled={!customEmbed.trim() || downloads.isPulling(customEmbed.trim())} onClick={() => { void downloads.start(customEmbed.trim()); setCustomEmbed(''); }}>Pull</Button></div>
        </div>
      )}
      <AiVoiceCard />
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
          {result.connectError && <div className="mt-8 small" style={{ color: 'var(--danger-text)' }}>Mailbox created but connecting it failed: {result.connectError}</div>}
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

// Every name and value here is on its way to a form at a registrar, so the
// text itself is the copy button. `text` is what reaches the clipboard and
// the children are what is shown, which differ whenever a value is too long
// to print in full.
function CopyText({ text, children, className }: { text: string; children?: ReactNode; className?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={cls('copy-text', className)} title={`Copy ${text.length > 60 ? text.slice(0, 57) + '…' : text}`} onClick={() => { navigator.clipboard?.writeText(text); toast.success('Copied'); }}>
      {children ?? text}
    </button>
  );
}

// A registrar's SRV form, already filled in. Every DNS host asks for these
// seven boxes rather than one value, and the two numbers in the middle are
// the ones people transpose. The last line is the same record written the
// way the few hosts with a single value box want it.
function SrvFields({ r }: { r: any }) {
  const fields: [string, string][] = [['Service', r.srv.service], ['Protocol', r.srv.protocol], ['Name', r.srv.host], ['Priority', String(r.srv.priority)], ['Weight', String(r.srv.weight)], ['Port', String(r.srv.port)], ['Target', r.srv.target]];
  return (
    <dl className="srv-fields">
      {fields.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd><CopyText text={v} /></dd></Fragment>)}
      <div className="rule" />
      <dt>One value</dt><dd><CopyText text={recordValue(r)} /></dd>
    </dl>
  );
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
      const byId = Object.fromEntries(r.results.map((x: any) => [x.id, x]));
      setChecks(byId); setOutbound(r.outbound); setSummary(r.summary);
      // The mail-app records are collapsed by default, and the summary line
      // above only speaks for the required ones: without this, "all required
      // records are in place" is the last word on a mailbox that no client
      // can configure itself against. Open the section when any are missing.
      if (dns?.records?.some((x: any) => x.group === 'clients' && byId[x.id] && byId[x.id].status !== 'ok')) setShowClients(true);
    } catch (e) { toast.error(e); } finally { setChecking(false); }
  }
  if (!data.reachable) return null;
  if (isLoading || !dns) return <Spinner />;
  const groups = ['required', 'recommended', 'brand', 'clients'].filter((g) => dns.records.some((r: any) => r.group === g));
  const clientRecords = dns.records.filter((r: any) => r.group === 'clients');
  const clientsMissing = clientRecords.filter((r: any) => checks[r.id] && checks[r.id].status !== 'ok').length;
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success('Copied'); };
  return (
    <div className="col gap-16">
      <Callout>
        <div className="strong mb-8">Trusted mail in five steps</div>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>At your <b>hosting provider</b>, set the reverse DNS of <code>{dns.serverIp ?? 'the server IP'}</code> to <code>{dns.mailHost}</code>{dns.serverIpv6 && <> — and the same for <code>{dns.serverIpv6}</code>, since mail delivered over IPv6 is judged on that address</>}.</li>
          <li>At your <b>DNS host</b> (where {dns.domain} is managed), add the records below. Every name and value copies when you click it, whole even where it is shown cut short. If Cloudflare proxies your DNS, turn the proxy off for these names.</li>
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
        {summary && <span className={cls('small', summary.requiredOk ? 'strong' : 'muted')} style={{ color: summary.requiredOk ? 'var(--success-text)' : undefined }}>{summary.requiredOk ? 'All required records are in place.' : `${summary.ok} of ${summary.checked} records found.`}</span>}
      </div>
      {outbound && <Callout kind={outbound.ok ? 'success' : 'warning'}>{outbound.note}{!outbound.ok && ' Ask the provider to open it, or configure a relay host in the Stalwart admin panel under Delivery → Routes.'}</Callout>}
      {groups.map((g) => (g !== 'clients' || showClients) && (
        <div key={g} className="card">
          <div className="card-title"><h2>{GROUP_TITLES[g][0]}</h2><span className="small muted">{GROUP_TITLES[g][1]}</span></div>
          {g === 'clients' && dns.records.some((r: any) => r.group === 'clients' && r.type === 'SRV') && (
            <p className="small muted mb-8" style={{ marginTop: 0 }}>Nearly every DNS host splits an SRV record into its own boxes — Service, Protocol, Name, Priority, Weight, Port and Target — so each SRV row below says which piece goes in which box. If yours asks only for a name and a value instead, use the name on the left and the <b>one value</b> line under the rule.</p>
          )}
          <DataTable rows={dns.records.filter((r: any) => r.group === g)} rowKey={(r: any) => r.id} minWidth={720} columns={[
            { key: 'type', header: 'Type', width: 70, cell: (r: any) => <Badge>{r.type}</Badge> },
            { key: 'name', header: 'Name', primary: true, className: 'mono small', cell: (r: any) => <span style={{ display: 'block', maxWidth: 260, overflowWrap: 'anywhere' }}><CopyText text={r.type === 'PTR' ? (r.ip ?? r.name) : r.name}>{r.name}</CopyText>{r.purpose && <div className="small muted" style={{ fontFamily: 'var(--font)', fontWeight: 400 }}>{r.purpose}</div>}</span> },
            { key: 'value', header: 'Value', wide: true, className: 'mono small', cell: (r: any) => { const c = checks[r.id]; return <span style={{ display: 'block', maxWidth: 360, overflowWrap: 'anywhere' }}>{r.type === 'SRV' && r.srv ? <SrvFields r={r} /> : <CopyText text={recordValue(r)}>{recordValue(r).length > 140 ? recordValue(r).slice(0, 137) + '…' : recordValue(r)}</CopyText>}{c && c.status !== 'ok' && c.found?.length > 0 && <div className="small" style={{ color: 'var(--warning-text)', fontFamily: 'var(--font)' }}>found: {c.found.join(' | ').slice(0, 160)}</div>}{c?.note && <div className="small muted" style={{ fontFamily: 'var(--font)' }}>{c.note}</div>}</span>; } },
            { key: 'status', header: 'Status', width: 100, cell: (r: any) => { const c = checks[r.id]; return c ? <Badge kind={STATUS_KIND[c.status]} dot>{STATUS_LABEL[c.status]}</Badge> : <span className="faint small">not checked</span>; } },
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
      <div className="row wrap"><Button variant="ghost" size="sm" onClick={() => setShowClients((v) => !v)}>{showClients ? 'Hide' : 'Show'} the mail-app autoconfig records ({clientRecords.length})</Button>
        {clientsMissing > 0 && <span className="small" style={{ color: 'var(--warning-text)' }}>{clientsMissing} of them missing: Thunderbird, Apple Mail, Outlook and JMAP clients have no way to find this mailbox from the address alone.</span>}</div>
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
      const r = await api.upload<any>(`/api/brand/${domain}?source=${source}`, svg, 'image/svg+xml', 'PUT');
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
        const r = await api.upload<any>(`/api/brand/${domain}?source=upload`, text, 'image/svg+xml', 'PUT');
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
            {brand ? <div className="small">Hosted at <CopyText text={brand.url}><code>{brand.url}</code></CopyText></div> : <div className="small muted">No logo yet. Drop an image here, upload one, or generate a default avatar below.</div>}
            {brand?.report?.removedAttributes !== undefined && <div className="small muted">Last import: {Object.values(brand.report.removedElements ?? {}).reduce((a: number, b: any) => a + Number(b), 0)} metadata elements and {brand.report.removedAttributes} attributes removed, {brand.report.stylesConverted ?? 0} style rules converted, coordinates rounded to {brand.report.precision ?? 3} decimals.</div>}
            <div className="row gap-4 wrap"><Button size="sm" icon={<Upload size={13} />} loading={busy || Boolean(tracing)} onClick={() => input.current?.click()}>Upload image or SVG</Button>{brand && <a className="btn btn-sm" href={`/bimi/${domain}.svg?v=${new Date(brand.updated_at).getTime()}`} download={`${domain}.svg`}><Download size={13} />Download SVG</a>}{brand && <Button size="sm" variant="ghost" onClick={() => runTrace(`/bimi/${domain}.svg?v=${new Date(brand.updated_at).getTime()}`, 'svg')}>Simplify by tracing</Button>}{brand && <Button size="sm" variant="ghost" onClick={() => api.del(`/api/brand/${domain}`).then(done)}>Remove</Button>}</div>
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
                <div className="small"><b>{Math.round(trace.bytes / 1024 * 10) / 10} KB</b> · {trace.colors} colours · {trace.paths} paths · traced at {trace.step.size}px{trace.bytes > maxBytes ? <span style={{ color: 'var(--danger-text)' }}> · still over the limit</span> : ''}</div>
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
            <CopyText text={brand.record}><code className="small" style={{ overflowWrap: 'anywhere' }}>{brand.record}</code></CopyText>
          </>
        ) : <div className="small muted">The record appears once a logo exists.</div>}
      </div>
      <BimiChecklist domain={domain} brand={brand} vmc={vmc} setVmc={setVmc} onSaved={done} />
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

const BIMI_STATUS: Record<string, { kind?: 'success' | 'warning' | 'danger'; label: string }> = {
  ok: { kind: 'success', label: 'done' }, warn: { kind: 'warning', label: 'check' }, fail: { kind: 'danger', label: 'blocked' }, skipped: { label: 'not yet' },
};

function BimiStep({ n, title, checks, children }: { n: number; title: string; checks: any[]; children: ReactNode }) {
  return (
    <div className="bimi-step">
      <div className="n">{n}</div>
      <div>
        <h3>{title}</h3>
        <div className="small muted">{children}</div>
        {checks.map((c) => (
          <div className="bimi-check" key={c.id}>
            <Badge kind={BIMI_STATUS[c.status]?.kind} dot>{BIMI_STATUS[c.status]?.label ?? c.status}</Badge>
            <div className="small"><b>{c.label}:</b> {c.detail}</div>
            {c.fix && <div className="small muted bimi-fix">{c.fix}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Getting a logo into Gmail is five separate errands at four different
// companies, and every one of them fails silently: no bounce, no header, the
// logo simply does not appear. So the page states the errands in order and
// then goes and looks, rather than leaving someone to guess which of the five
// is the one that is wrong.
function BimiChecklist({ domain, brand, vmc, setVmc, onSaved }: { domain: string; brand: any; vmc: string; setVmc: (v: string) => void; onSaved: () => void }) {
  const toast = useToast();
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  async function run() {
    setBusy(true);
    try { setReport(await api.post<any>(`/api/brand/${domain}/bimi/check`, {})); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function saveVmc() {
    setSaving(true);
    try {
      await api.put(`/api/brand/${domain}/options`, { vmcUrl: vmc.trim() });
      onSaved(); toast.success('Record updated');
      if (vmc.trim()) await run();
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  }
  const at = (step: number) => (report?.checks ?? []).filter((c: any) => c.step === step);
  const cert = report?.vmc;
  return (
    <div className="card">
      <div className="card-title"><h2>Verify BIMI, with or without a certificate</h2><span className="small muted">Yahoo, Fastmail and La Poste need the first three steps. Gmail and Apple Mail need all five.</span></div>
      <div className="row wrap mb-16">
        <Button variant="primary" icon={<ShieldCheck size={15} />} loading={busy} onClick={run}>Check BIMI now</Button>
        {report && <span className="small" style={{ color: report.ready.gmail ? 'var(--success-text)' : report.ready.basic ? undefined : 'var(--warning-text)' }}>
          {report.ready.gmail ? 'Everything Gmail and Apple Mail ask for is in place.' : report.ready.basic ? 'Ready for the clients that do not require a certificate.' : 'Not showing anywhere yet — see the blocked steps below.'}
        </span>}
      </div>

      <BimiStep n={1} title="A logo the certificate authority will accept" checks={at(1)}>
        Square, under 32 KB, SVG Tiny Portable/Secure, no bitmaps and no metadata. Whatever you upload above is rebuilt into that form.
        {' '}<b>Download the result before you apply for a certificate</b> — that exact file is what goes inside the certificate and what mail clients compare against, and a re-export from Illustrator or Figma will not be the same bytes.
      </BimiStep>

      <BimiStep n={2} title="DMARC that enforces" checks={at(2)}>
        BIMI is ignored unless the domain already tells receivers to act on failures: <code>p=quarantine</code> or <code>p=reject</code>, applied to all mail. Raise it on the DNS setup tab, and give the reports a week at quarantine before moving to reject.
      </BimiStep>

      <BimiStep n={3} title="Publish the BIMI record" checks={at(3)}>
        The TXT record above, at <code>default._bimi.{domain}</code>. On its own this is enough for Yahoo, Fastmail and La Poste; the certificate below is what Gmail and Apple Mail add.
      </BimiStep>

      <BimiStep n={4} title="Buy a mark certificate, and host it" checks={at(4)}>
        <p style={{ marginTop: 0 }}>Only two authorities issue them: <a href="https://www.digicert.com/tls-ssl/verified-mark-certificates" target="_blank" rel="noreferrer">DigiCert</a> and <a href="https://www.entrust.com/products/digital-certificates/verified-mark-certificates" target="_blank" rel="noreferrer">Entrust</a>. A <b>VMC</b> needs the logo registered as a trademark at an office they recognise (USPTO, EUIPO, UKIPO, CIPO, IP Australia, JPO and a handful more); a <b>CMC</b> takes a logo you have used publicly for at least a year instead, and Gmail accepts it. Both are paid, renewed yearly, and take weeks rather than minutes: identity checks, a signed subscriber agreement and usually a video call.</p>
        <p>Give them the SVG downloaded in step 1. They return a <code>.pem</code> holding the certificate and its chain; host that at a public https address and paste the URL here. It fills the <code>a=</code> part of the record.</p>
        <Field label="Certificate URL" className="mt-8"><div className="row"><Input value={vmc} onChange={(e) => setVmc(e.target.value)} placeholder="https://outreach.example.com/bimi/vmc.pem" /><Button loading={saving} onClick={saveVmc}>Save</Button></div></Field>
      </BimiStep>

      <BimiStep n={5} title="Check that the certificate really describes this logo" checks={at(5)}>
        A mark certificate carries a copy of the logo sealed inside it, and mail clients compare that copy against the file your record points at, byte for byte. Re-uploading, re-tracing or even reformatting the logo afterwards breaks the match, and Gmail then drops the logo without an error anywhere. Checking here opens the certificate and holds the two files against each other.
      </BimiStep>

      {cert?.ok && (
        <div className="mt-16" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div className="small strong mb-8">Inside the certificate</div>
          <dl className="kv kv-tight small">
            <dt>Issued to</dt><dd>{cert.organization ?? '—'}{cert.subject?.L || cert.subject?.C ? <span className="muted"> · {[cert.subject.L, cert.subject.ST, cert.subject.C].filter(Boolean).join(', ')}</span> : null}</dd>
            <dt>Issued by</dt><dd>{cert.issuer ?? '—'}</dd>
            <dt>Names</dt><dd>{cert.altNames.length ? cert.altNames.join(', ') : '—'}</dd>
            <dt>Valid until</dt><dd>{cert.validTo ? `${cert.validTo.slice(0, 10)}${cert.daysLeft !== null ? ` (${cert.daysLeft} days)` : ''}` : '—'}</dd>
            <dt>Logo inside</dt><dd>{cert.logotype ? `${cert.logotype.mediaType ?? 'unknown type'}${cert.logoBytes ? `, ${Math.round(cert.logoBytes / 1024 * 10) / 10} KB` : ''}${cert.logotype.encoding && cert.logotype.encoding !== 'none' ? ` (${cert.logotype.encoding})` : ''}` : 'none — this is not a mark certificate'}</dd>
            <dt>Fetched from</dt><dd style={{ overflowWrap: 'anywhere' }}><code>{cert.url}</code></dd>
          </dl>
        </div>
      )}
      {report && !brand && <Callout kind="warning">There is no logo yet, so most of this cannot be checked. Upload one above first.</Callout>}
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
