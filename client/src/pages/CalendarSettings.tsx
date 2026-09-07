// Settings → Calendars (F13): connecting the accounts a calendar comes from.
//
// Four ways in, and the page is honest about what each one costs. CalDAV and
// a subscribed address work on any install with no setup at all. Google and
// Outlook need an app registered by whoever runs this server, so when that
// has not been done the buttons are not shown as broken — the page says what
// is missing and who can fix it.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, Cloud, Globe, Link2, Loader2, RefreshCw, Server, Trash2, Zap } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { useFeatures } from '../state/features';
import { FeatureOffNotice } from './Features';
import { Badge, Button, Callout, Confirm, Field, Input, Modal, PageHeader, Spinner, Toggle } from '../components/ui';
import { useToast } from '../state/toast';
import { fmtRelative } from '../lib/format';

interface CalendarRow { id: number; name: string; color: string | null; readOnly: boolean; selected: boolean; isDefault: boolean; lastSyncAt: string | null; push: boolean }
interface SourceRow {
  id: number; kind: 'caldav' | 'google' | 'microsoft' | 'ics'; label: string; baseUrl: string; username: string;
  status: 'ok' | 'syncing' | 'auth_error' | 'error'; error: string | null; lastSyncAt: string | null; enabled: boolean;
  calendars: CalendarRow[];
}
interface Overview { sources: SourceRow[]; providers: Record<string, boolean>; push: boolean }

// The presets that mean somebody does not have to know what a principal URL
// is. Everything else goes through "Other CalDAV server".
const DAV_PRESETS: { id: string; label: string; url: string; help: string }[] = [
  {
    id: 'icloud', label: 'Apple iCloud', url: 'https://caldav.icloud.com',
    help: 'Use your Apple ID and an app-specific password created at account.apple.com → Sign-In and Security → App-Specific Passwords. Your Apple ID password will not work.',
  },
  {
    id: 'fastmail', label: 'Fastmail', url: 'https://caldav.fastmail.com/dav/',
    help: 'Use your Fastmail address and an app password with Calendars access, created under Settings → Privacy & Security → Integrations.',
  },
  {
    id: 'nextcloud', label: 'Nextcloud', url: '', help: 'The address looks like https://your-server/remote.php/dav/. Use your Nextcloud username and an app password.',
  },
  {
    id: 'other', label: 'Other CalDAV server', url: '', help: 'Any RFC 4791 server — Radicale, SOGo, Baikal, Zimbra, Synology. Give the server address, or the calendar home if you know it.',
  },
];

const KIND_META: Record<string, { label: string; icon: typeof Cloud }> = {
  google: { label: 'Google Calendar', icon: Cloud },
  microsoft: { label: 'Outlook', icon: Cloud },
  caldav: { label: 'CalDAV', icon: Server },
  ics: { label: 'Subscribed', icon: Globe },
};

export default function CalendarSettings() {
  const { can, info, loading: featuresLoading } = useFeatures();
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<'caldav' | 'ics' | null>(null);
  const [removing, setRemoving] = useState<SourceRow | null>(null);
  const [busy, setBusy] = useState(0);
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    try { setData(await api.get<Overview>('/api/calendar')); } catch { /* the notice below covers it */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (can('calendar')) void load(); }, [can, load]);

  // The OAuth callback comes back to this page with its outcome in the URL.
  useEffect(() => {
    const ok = params.get('connected');
    const err = params.get('error');
    if (!ok && !err) return;
    if (ok) toast.success(`${ok} connected`);
    if (err) toast.error(err);
    setParams({}, { replace: true });
    void load();
  }, [params, setParams, toast, load]);

  async function connectOAuth(provider: 'google' | 'microsoft') {
    try {
      const r = await api.get<{ url: string }>(`/api/calendar/oauth/${provider}/start`);
      // A full navigation rather than a popup: the consent screens block
      // being framed, and a popup that a browser eats looks like a failure.
      window.location.href = r.url;
    } catch (e) { toast.error(e); }
  }

  async function syncNow(id: number) {
    setBusy(id);
    try {
      const r = await api.post<{ changed: number; sources: SourceRow[] }>(`/api/calendar/sources/${id}/sync`);
      setData((d) => (d ? { ...d, sources: r.sources } : d));
      toast.success(r.changed ? `${r.changed} event${r.changed === 1 ? '' : 's'} updated` : 'Already up to date');
    } catch (e) { toast.error(e); } finally { setBusy(0); }
  }

  async function disconnect(s: SourceRow) {
    setBusy(s.id);
    try {
      const r = await api.del<{ sources: SourceRow[] }>(`/api/calendar/sources/${s.id}`);
      setData((d) => (d ? { ...d, sources: r.sources } : d));
      toast.success(`${s.label} disconnected`);
    } catch (e) { toast.error(e); } finally { setBusy(0); setRemoving(null); }
  }

  async function patchCalendar(id: number, patch: Record<string, unknown>) {
    try {
      const r = await api.patch<{ sources: SourceRow[] }>(`/api/calendar/calendars/${id}`, patch);
      setData((d) => (d ? { ...d, sources: r.sources } : d));
    } catch (e) { toast.error(e); }
  }

  if (featuresLoading) return <Spinner />;
  if (!can('calendar')) {
    return (
      <div>
        <PageHeader title="Calendars" sub="Connect the calendars you already use." />
        <FeatureOffNotice cap={info('calendar')}>
          Connecting a calendar syncs its events to this server, encrypted with your own key, and sends
          your changes back. It is also what stops Tern proposing a time you are already busy.
        </FeatureOffNotice>
      </div>
    );
  }
  if (loading || !data) return <Spinner />;

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Calendars" sub="Connect the calendars you already use. Events sync both ways." />

      <div className="card mb-16">
        <div className="card-title"><h2>Connect</h2></div>
        <div className="cal-connect-grid">
          <ConnectTile
            label="Google Calendar" icon={<Cloud size={18} />} available={data.providers.google}
            note={data.providers.google ? 'Two-way, with live updates.' : 'Not set up on this server.'}
            onClick={() => connectOAuth('google')}
          />
          <ConnectTile
            label="Outlook / Microsoft 365" icon={<Cloud size={18} />} available={data.providers.microsoft}
            note={data.providers.microsoft ? 'Two-way, with live updates.' : 'Not set up on this server.'}
            onClick={() => connectOAuth('microsoft')}
          />
          <ConnectTile
            label="iCloud, Fastmail, Nextcloud…" icon={<Server size={18} />} available
            note="Any CalDAV server. Two-way." onClick={() => setAdding('caldav')}
          />
          <ConnectTile
            label="Subscribe to an address" icon={<Link2 size={18} />} available
            note="A published .ics URL. Read-only." onClick={() => setAdding('ics')}
          />
        </div>
        {(!data.providers.google || !data.providers.microsoft) && (
          <Callout>
            Google and Outlook need an app registered by whoever runs this server — Tern deliberately
            ships no credentials of its own, so your calendar access belongs to your install rather than
            to this project.{' '}
            {user!.role === 'admin'
              ? <><Link to="/admin/calendar">Set that up under Admin → Calendar</Link>.</>
              : 'Ask an administrator to set it up under Admin → Calendar.'}
          </Callout>
        )}
        {!data.push && (
          <p className="small muted">
            This server is not reachable at an https address, so Google and Outlook cannot push changes to
            it. Calendars still sync — they are polled instead, which is a few minutes behind rather than
            instant.
          </p>
        )}
      </div>

      {data.sources.map((s) => {
        const meta = KIND_META[s.kind] ?? KIND_META.caldav;
        const Icon = meta.icon;
        return (
          <div key={s.id} className="card mb-16">
            <div className="card-title">
              <h2 className="row gap-8"><Icon size={16} />{s.label}</h2>
              <div className="row gap-8">
                {s.status === 'auth_error' && <Badge kind="danger">needs reconnecting</Badge>}
                {s.status === 'error' && <Badge kind="warning">sync failed</Badge>}
                {s.status === 'ok' && <Badge kind="success">connected</Badge>}
                <Button size="sm" variant="ghost" loading={busy === s.id} icon={<RefreshCw size={13} />} onClick={() => syncNow(s.id)}>Sync now</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setRemoving(s)}>Disconnect</Button>
              </div>
            </div>
            <div className="small muted row gap-8 wrap">
              <span>{meta.label}</span>
              {s.username && <span>· {s.username}</span>}
              {s.baseUrl && <span className="truncate" style={{ maxWidth: 'min(100%, 320px)' }}>· {s.baseUrl}</span>}
              {s.lastSyncAt && <span>· synced {fmtRelative(s.lastSyncAt)}</span>}
            </div>
            {s.error && <Callout kind={s.status === 'auth_error' ? 'danger' : 'warning'}>{s.error}</Callout>}

            <table className="cal-cal-table mt-8">
              <tbody>
                {s.calendars.map((c) => (
                  <tr key={c.id}>
                    <td style={{ width: 34 }}><span className="cal-swatch" style={{ background: c.color ?? 'var(--accent)' }} /></td>
                    <td>
                      <span className="strong">{c.name}</span>
                      <div className="row gap-4 wrap small muted">
                        {c.readOnly && <span>read-only</span>}
                        {c.isDefault && <Badge kind="accent">default</Badge>}
                        {c.push && <span className="row gap-4"><Zap size={11} />live</span>}
                      </div>
                    </td>
                    <td style={{ width: 200 }}>
                      <div className="row gap-8 end">
                        {!c.readOnly && !c.isDefault && (
                          <Button size="sm" variant="ghost" onClick={() => patchCalendar(c.id, { isDefault: true })}>Make default</Button>
                        )}
                        <label className="row gap-4 small" title="Show this calendar, and count it as busy">
                          <Toggle checked={c.selected} onChange={(v) => patchCalendar(c.id, { selected: v })} />
                          Shown
                        </label>
                      </div>
                    </td>
                  </tr>
                ))}
                {!s.calendars.length && <tr><td colSpan={3} className="small muted">No calendars found in this account yet.</td></tr>}
              </tbody>
            </table>
          </div>
        );
      })}

      {!data.sources.length && (
        <div className="card">
          <p className="muted small row gap-8"><CalendarDays size={16} /> Nothing connected yet. Once a calendar is connected it appears under <Link to="/calendar">Calendar</Link>, and Tern stops proposing times you are already busy.</p>
        </div>
      )}

      {adding === 'caldav' && <DavForm onClose={() => setAdding(null)} onDone={() => { setAdding(null); void load(); }} />}
      {adding === 'ics' && <IcsForm onClose={() => setAdding(null)} onDone={() => { setAdding(null); void load(); }} />}
      <Confirm
        open={Boolean(removing)} onClose={() => setRemoving(null)} danger
        title={`Disconnect ${removing?.label ?? ''}?`}
        confirmLabel="Disconnect"
        message="The events synced from it are removed from this server. Nothing is deleted on the far side."
        onConfirm={() => { if (removing) return disconnect(removing); }}
      />
    </div>
  );
}

function ConnectTile({ label, icon, note, available, onClick }: { label: string; icon: React.ReactNode; note: string; available: boolean; onClick: () => void }) {
  return (
    <button className="cal-connect-tile" disabled={!available} onClick={onClick} title={available ? undefined : 'Not set up on this server'}>
      <span className="cal-connect-icon">{icon}</span>
      <span className="strong">{label}</span>
      <span className="small muted">{note}</span>
    </button>
  );
}

function DavForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [preset, setPreset] = useState(DAV_PRESETS[0]);
  const [f, setF] = useState({ url: DAV_PRESETS[0].url, username: '', password: '', label: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/api/calendar/sources/caldav', {
        url: f.url.trim(), username: f.username.trim(), password: f.password, label: f.label.trim() || preset.label,
      });
      toast.success('Calendar connected');
      onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Connect a CalDAV calendar" footer={
      <div className="row gap-8 end full">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!f.url || !f.username || !f.password} onClick={submit}>Connect</Button>
      </div>
    }>
      <div className="stack-12">
        <Field label="Server">
          <div className="row gap-4 wrap">
            {DAV_PRESETS.map((p) => (
              <Button key={p.id} size="sm" variant={preset.id === p.id ? 'primary' : 'default'}
                onClick={() => { setPreset(p); setF({ ...f, url: p.url }); }}>{p.label}</Button>
            ))}
          </div>
        </Field>
        <Callout>{preset.help}</Callout>
        <Field label="Address"><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://caldav.example.com/dav/" /></Field>
        <div className="form-row">
          <Field label="Username"><Input value={f.username} autoComplete="off" onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="Password" hint="An app-specific password where the provider offers one.">
            <Input type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} />
          </Field>
        </div>
        <Field label="Name (optional)" hint="What to call this connection in Tern.">
          <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={preset.label} />
        </Field>
        <p className="small muted">
          The password is stored encrypted on this server and used only to reach that calendar. It is
          checked before anything is saved, so a wrong one is a message here rather than a connection
          that quietly fails later.
        </p>
      </div>
    </Modal>
  );
}

function IcsForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ url: '', label: '' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/api/calendar/sources/ics', { url: f.url.trim(), label: f.label.trim() || undefined });
      toast.success('Subscribed');
      onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Subscribe to a calendar address" footer={
      <div className="row gap-8 end full">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!f.url} onClick={submit}>Subscribe</Button>
      </div>
    }>
      <div className="stack-12">
        <Field label="Address" hint="An .ics or webcal:// address — a colleague's published calendar, a room, a fixture list, a country's public holidays.">
          <Input value={f.url} autoFocus onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://example.com/calendar.ics" />
        </Field>
        <Field label="Name (optional)"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Taken from the file where it says one" /></Field>
        <Callout>
          A subscription is read-only and only as fresh as the publisher makes it — a quarter of an hour
          to a day is normal, and nothing about that is under this server's control.
        </Callout>
      </div>
    </Modal>
  );
}
