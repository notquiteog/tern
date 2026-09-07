// Admin → Calendar (F13): the two app registrations this server needs before
// anyone can connect Google or Outlook.
//
// This page exists because of a deliberate decision, and it says so. Tern
// ships no OAuth credentials of its own: shipping them would make this
// project the party Google and Microsoft hold responsible for every install's
// calendar access, put everyone behind one verification review and one rate
// limit, and show your people a consent screen carrying a stranger's name.
// The cost of the alternative is this page, and ten minutes in two consoles.
//
// The redirect URIs are shown rather than described, because pasting one
// wrongly is far and away the most common way an OAuth app fails, and the
// error it produces names neither the cause nor the fix.
import { useEffect, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Callout, Field, Input, PageHeader, Spinner, Toggle } from '../components/ui';
import { useToast } from '../state/toast';

interface AdminCalendarData {
  settings: {
    google: { clientId: string; hasSecret: boolean };
    microsoft: { clientId: string; hasSecret: boolean; tenant?: string };
    pollSeconds: number;
    webhooks: boolean;
    allowPrivateHosts: boolean;
  };
  redirectUris: { google: string; microsoft: string };
  pushPossible: boolean;
  appUrl: string;
}

export default function AdminCalendar() {
  const toast = useToast();
  const [data, setData] = useState<AdminCalendarData | null>(null);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<AdminCalendarData>('/api/admin/calendar')
      .then((d) => { setData(d); setF({ googleId: d.settings.google.clientId, googleSecret: '', msId: d.settings.microsoft.clientId, msSecret: '', tenant: d.settings.microsoft.tenant ?? 'common', pollSeconds: d.settings.pollSeconds, webhooks: d.settings.webhooks, allowPrivateHosts: d.settings.allowPrivateHosts }); })
      .catch((e) => toast.error(e));
  }, [toast]);

  if (!data || !f) return <Spinner />;

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await api.put<{ settings: AdminCalendarData['settings'] }>('/api/admin/calendar', patch);
      setData((d) => (d ? { ...d, settings: r.settings } : d));
      setF((prev: any) => ({ ...prev, googleSecret: '', msSecret: '' }));
      toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  const copy = async (v: string) => {
    try { await navigator.clipboard.writeText(v); toast.success('Copied'); } catch { toast.error('Could not copy'); }
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Calendar" sub="What this server needs before people can connect Google or Outlook." />

      <Callout>
        CalDAV — iCloud, Fastmail, Nextcloud, Radicale and the rest — and subscribed <code>.ics</code>{' '}
        addresses need nothing here at all; people can connect those today under Settings → Calendars.
        This page is only for the two providers that require an app registration.
      </Callout>

      {!data.pushPossible && (
        <Callout kind="warning">
          <code>{data.appUrl}</code> is not an https address, so Google and Microsoft cannot deliver
          change notifications to it. Calendars still sync by polling, a few minutes behind. Put this
          server behind a public https address to get live updates.
        </Callout>
      )}

      <div className="card mb-16">
        <div className="card-title">
          <h2>Google Calendar</h2>
          {data.settings.google.clientId && data.settings.google.hasSecret ? <Badge kind="success">ready</Badge> : <Badge kind="warning">not set up</Badge>}
        </div>
        <ol className="small muted setup-steps">
          <li>In the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud console <ExternalLink size={11} /></a>, create a project and enable the <b>Google Calendar API</b>.</li>
          <li>Create an <b>OAuth client ID</b> of type <b>Web application</b>.</li>
          <li>Add the redirect URI below, exactly as it appears.</li>
          <li>On the consent screen, add the scopes <code>calendar.events</code> and <code>calendar.calendarlist.readonly</code>. While the app is in testing, add your people as test users; publishing it removes the seven-day token expiry.</li>
        </ol>
        <RedirectRow value={data.redirectUris.google} onCopy={copy} />
        <div className="form-row">
          <Field label="Client ID"><Input value={f.googleId} onChange={(e) => setF({ ...f, googleId: e.target.value })} placeholder="000000000000-xxxx.apps.googleusercontent.com" /></Field>
          <Field label="Client secret" hint={data.settings.google.hasSecret ? 'A secret is stored; leave blank to keep it.' : ''}>
            <Input type="password" value={f.googleSecret} onChange={(e) => setF({ ...f, googleSecret: e.target.value })} placeholder={data.settings.google.hasSecret ? '••••••••' : ''} />
          </Field>
        </div>
        <div className="row gap-8">
          <Button variant="primary" loading={busy} onClick={() => save({ google: { clientId: f.googleId.trim(), clientSecret: f.googleSecret || undefined } })}>Save Google</Button>
          {data.settings.google.hasSecret && <Button size="sm" variant="ghost" onClick={() => save({ google: { clientId: f.googleId.trim(), clientSecret: null } })}>Clear secret</Button>}
        </div>
      </div>

      <div className="card mb-16">
        <div className="card-title">
          <h2>Outlook / Microsoft 365</h2>
          {data.settings.microsoft.clientId && data.settings.microsoft.hasSecret ? <Badge kind="success">ready</Badge> : <Badge kind="warning">not set up</Badge>}
        </div>
        <ol className="small muted setup-steps">
          <li>In the <a href="https://entra.microsoft.com" target="_blank" rel="noreferrer">Microsoft Entra admin centre <ExternalLink size={11} /></a>, register an application.</li>
          <li>Add a <b>Web</b> redirect URI, exactly as below.</li>
          <li>Under API permissions, add the delegated Microsoft Graph permissions <code>Calendars.ReadWrite</code> and <code>offline_access</code>.</li>
          <li>Create a client secret under Certificates &amp; secrets, and copy its <b>value</b> — not its ID.</li>
        </ol>
        <RedirectRow value={data.redirectUris.microsoft} onCopy={copy} />
        <div className="form-row">
          <Field label="Application (client) ID"><Input value={f.msId} onChange={(e) => setF({ ...f, msId: e.target.value })} /></Field>
          <Field label="Client secret" hint={data.settings.microsoft.hasSecret ? 'A secret is stored; leave blank to keep it.' : ''}>
            <Input type="password" value={f.msSecret} onChange={(e) => setF({ ...f, msSecret: e.target.value })} placeholder={data.settings.microsoft.hasSecret ? '••••••••' : ''} />
          </Field>
          <Field label="Tenant" hint="`common` lets both work and personal accounts sign in. A directory ID here restricts it to one organisation.">
            <Input value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} placeholder="common" />
          </Field>
        </div>
        <div className="row gap-8">
          <Button variant="primary" loading={busy} onClick={() => save({ microsoft: { clientId: f.msId.trim(), clientSecret: f.msSecret || undefined, tenant: f.tenant.trim() || 'common' } })}>Save Microsoft</Button>
          {data.settings.microsoft.hasSecret && <Button size="sm" variant="ghost" onClick={() => save({ microsoft: { clientId: f.msId.trim(), clientSecret: null, tenant: f.tenant.trim() || 'common' } })}>Clear secret</Button>}
        </div>
      </div>

      <div className="card mb-16">
        <div className="card-title"><h2>Syncing</h2></div>
        <div className="form-row">
          <Field label="Poll every (seconds)" hint="How often a calendar with no push channel is checked. An incremental check is one small request that usually returns nothing, so this can be low; 300 is a sensible floor for a busy install.">
            <Input type="number" min={60} max={3600} value={f.pollSeconds} onChange={(e) => setF({ ...f, pollSeconds: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="row gap-8 mb-8">
          <Toggle checked={f.webhooks} onChange={(v) => setF({ ...f, webhooks: v })} />
          <div>
            <div className="strong small">Ask Google and Microsoft to push changes</div>
            <div className="help-text">A notification carries no event data, only that something moved, and each one is checked against the secret its channel was created with. Off means everything is polled.</div>
          </div>
        </div>
        <div className="row gap-8 mb-8">
          <Toggle checked={f.allowPrivateHosts} onChange={(v) => setF({ ...f, allowPrivateHosts: v })} />
          <div>
            <div className="strong small">Allow CalDAV servers on this network</div>
            <div className="help-text">Off by default. On, a member can point Tern at a private or loopback address — which is what somebody with a Nextcloud on the LAN needs, and also a way to make this server talk to services that trust its own network. Turn it on if you run a calendar server here, and not otherwise.</div>
          </div>
        </div>
        <Button variant="primary" loading={busy} onClick={() => save({ pollSeconds: f.pollSeconds, webhooks: f.webhooks, allowPrivateHosts: f.allowPrivateHosts })}>Save syncing</Button>
      </div>
    </div>
  );
}

function RedirectRow({ value, onCopy }: { value: string; onCopy: (v: string) => void }) {
  return (
    <Field label="Redirect URI" hint="Paste this exactly — a trailing slash or a different scheme is enough to break the sign-in, with an error that says neither.">
      <div className="row gap-8">
        <Input readOnly value={value} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }} />
        <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => onCopy(value)}>Copy</Button>
      </div>
    </Field>
  );
}
