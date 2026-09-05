import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Apple, Check, Copy, Laptop, Mail, MonitorSmartphone, Smartphone, Sparkles } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { Badge, Callout, Empty, PageHeader, Select, Spinner } from '../components/ui';
import { cls } from '../lib/format';

interface Server { host: string; port: number; security: 'SSL/TLS' | 'STARTTLS'; username: string; guessed: boolean; alt?: { port: number; security: string } }
interface ClientSettings { accountId: number; name: string; email: string; provider: string; color: string; imap: Server | null; smtp: Server | null; jmap: { sessionUrl: string; username: string } | null; password: 'mailbox' | 'app_password' | 'token'; autoconfig: boolean; notes: string[] }

const PASSWORD_LABEL: Record<ClientSettings['password'], string> = { mailbox: 'Your mailbox password', app_password: 'An app password (see note)', token: 'Password or app password from your provider (the API token Tern uses will not work)' };

type ClientKey = 'thunderbird' | 'apple' | 'ios' | 'outlook' | 'android' | 'windows' | 'jmap';
const CLIENTS: { key: ClientKey; label: string; icon: ReactNode }[] = [
  { key: 'thunderbird', label: 'Thunderbird', icon: <Mail size={14} /> },
  { key: 'apple', label: 'Apple Mail', icon: <Apple size={14} /> },
  { key: 'ios', label: 'iPhone & iPad', icon: <Smartphone size={14} /> },
  { key: 'outlook', label: 'Outlook', icon: <Laptop size={14} /> },
  { key: 'android', label: 'Android', icon: <Smartphone size={14} /> },
  { key: 'windows', label: 'Windows Mail', icon: <MonitorSmartphone size={14} /> },
  { key: 'jmap', label: 'JMAP apps', icon: <Sparkles size={14} /> },
];

export default function MailAppsSettings() {
  const { data, isLoading } = useQuery({ queryKey: ['client-settings'], queryFn: () => api.get<{ accounts: ClientSettings[] }>('/api/accounts/client-settings').then((r) => r.accounts) });
  const [client, setClient] = useState<ClientKey>(() => guessClient());
  const [accId, setAccId] = useState<number | ''>('');
  useEffect(() => { if (data?.length && accId === '') setAccId(data[0].accountId); }, [data, accId]);
  if (isLoading || !data) return <Spinner />;
  const acc = data.find((a) => a.accountId === accId) ?? data[0];
  return (
    <div style={{ maxWidth: 900 }}>
      <PageHeader title="Mail apps" sub="Read the same mailboxes in Thunderbird, Apple Mail, Outlook or on your phone. Everything lives on the mail server, so read state, labels and sent mail stay in step with Tern." />
      {!data.length && <Empty icon={<Mail size={24} />} title="No mailbox connected yet">Connect a mailbox under Accounts first; its app settings appear here.</Empty>}
      {data.length > 0 && (
        <>
          {data.length > 1 && <div className="row mb-16 wrap"><span className="small strong">Mailbox</span><Select value={acc.accountId} onChange={(e) => setAccId(Number(e.target.value))} style={{ maxWidth: 360 }}>{data.map((a) => <option key={a.accountId} value={a.accountId}>{a.name} &lt;{a.email}&gt;</option>)}</Select></div>}
          <AccountServers a={acc} />
          <div className="card mt-16">
            <div className="card-title"><h2>Step by step</h2><span className="small muted">Pick your app</span></div>
            <div className="client-tabs mb-16">{CLIENTS.map((c) => <button key={c.key} type="button" className={cls(client === c.key && 'active')} onClick={() => setClient(c.key)}>{c.icon}{c.label}</button>)}</div>
            <Steps client={client} a={acc} />
          </div>
          <div className="card mt-16">
            <div className="card-title"><h2>Good to know</h2></div>
            <ul className="tips">
              <li><b>Both at once is fine.</b> Tern and your mail app talk to the same server. Archive something on your phone and it leaves the inbox here; a label you add in Tern shows up as a folder there.</li>
              <li><b>Sequences and responders keep running</b> whether or not the app is open. They send from the server through Tern, and the sent copies land in the Sent folder your app sees.</li>
              <li><b>Sending from the app bypasses the sending policy.</b> Daily caps, the send window and the natural delay apply only to what Tern sends. Manual mail from an app is never throttled.</li>
              <li><b>Use the address as the user name</b> everywhere it asks, and choose "Normal password" for authentication. OAuth is not offered by these servers.</li>
              <li><b>Signatures are per app.</b> The signature under Accounts is added to what Tern sends; set one in the app too if you want it on mail sent from there.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function guessClient(): ClientKey {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'apple';
  if (/Windows/.test(ua)) return 'outlook';
  return 'thunderbird';
}

function CopyValue({ value, mono = true }: { value: string | number; mono?: boolean }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <span className="copyval">
      <span className={cls(mono && 'mono')}>{value}</span>
      <button type="button" className="btn btn-icon btn-sm" title="Copy" aria-label="Copy" onClick={() => { navigator.clipboard?.writeText(String(value)); setDone(true); toast.success('Copied'); setTimeout(() => setDone(false), 1200); }}>{done ? <Check size={13} /> : <Copy size={13} />}</button>
    </span>
  );
}

function ServerBlock({ title, s, kind }: { title: string; s: Server; kind: 'imap' | 'smtp' }) {
  return (
    <div className="server-block">
      <div className="row mb-8"><span className="strong">{title}</span>{s.guessed && <Badge kind="warning">best guess</Badge>}</div>
      <dl className="kv kv-tight">
        <dt>Server</dt><dd><CopyValue value={s.host} /></dd>
        <dt>Port</dt><dd><CopyValue value={s.port} /> <span className="small muted">{s.security}</span></dd>
        {s.alt && <><dt>Alternative</dt><dd><span className="mono">{s.alt.port}</span> <span className="small muted">{s.alt.security}{kind === 'smtp' ? ', if the first is blocked on your network' : ''}</span></dd></>}
        <dt>User name</dt><dd><CopyValue value={s.username} /></dd>
        <dt>Authentication</dt><dd>Normal password</dd>
      </dl>
    </div>
  );
}

function AccountServers({ a }: { a: ClientSettings }) {
  return (
    <div className="card">
      <div className="row mb-16 wrap">
        <span className="avatar" style={{ background: a.color }}>{a.name.slice(0, 1).toUpperCase()}</span>
        <div className="flex-1"><div className="strong">{a.name}</div><div className="small muted">{a.email}</div></div>
        <Badge>{a.provider}</Badge>
        {a.autoconfig && <Badge kind="success"><Check size={12} /> automatic setup</Badge>}
      </div>
      {a.autoconfig && <Callout kind="success">This mail server publishes autoconfig records, so Thunderbird, Apple Mail, Outlook and most phones fill in every server below from just the address and password. The details are here in case an app asks.</Callout>}
      {a.notes.map((n, i) => <Callout key={i}>{n}</Callout>)}
      <div className="server-grid mt-16">
        {a.imap && <ServerBlock title="Incoming mail (IMAP)" s={a.imap} kind="imap" />}
        {a.smtp && <ServerBlock title="Outgoing mail (SMTP)" s={a.smtp} kind="smtp" />}
      </div>
      <dl className="kv kv-tight mt-16">
        <dt>Password</dt><dd>{PASSWORD_LABEL[a.password]}</dd>
        {a.jmap && <><dt>JMAP session</dt><dd><CopyValue value={a.jmap.sessionUrl} /> <span className="small muted">for JMAP-native apps</span></dd></>}
      </dl>
    </div>
  );
}

function Steps({ client, a }: { client: ClientKey; a: ClientSettings }) {
  const imap = a.imap; const smtp = a.smtp;
  const pw = a.password === 'app_password' ? 'the app password' : 'the mailbox password';
  const manual = imap && smtp ? <>If it asks for servers: incoming <b>{imap.host}</b> port <b>{imap.port}</b> ({imap.security}), outgoing <b>{smtp.host}</b> port <b>{smtp.port}</b> ({smtp.security}), user name <b>{imap.username}</b>, normal password.</> : <>Enter the servers from the box above if it asks.</>;
  const steps: Record<ClientKey, ReactNode[]> = {
    thunderbird: [
      <>Open Thunderbird. Go to <b>≡ menu → Account Settings → Account Actions → Add Mail Account</b> (or File → New → Existing Mail Account).</>,
      <>Enter your name, <b>{a.email}</b> and {pw}. Press <b>Continue</b>.</>,
      a.autoconfig ? <>Thunderbird finds the settings on its own. Check it says <b>IMAP</b> (not POP3) and press <b>Done</b>.</> : <>Press <b>Configure manually</b>. {manual}</>,
      <>First sync can take a minute for a large mailbox. Labels from Tern appear as folders under the account.</>,
    ],
    apple: [
      <>Open <b>Mail</b>, then <b>Mail → Add Account…</b> (or System Settings → Internet Accounts → Add Account).</>,
      <>Choose <b>Other Mail Account…</b>, enter your name, <b>{a.email}</b> and {pw}, then <b>Sign In</b>.</>,
      a.autoconfig ? <>Mail looks the server up automatically. If it stops on "Unable to verify", enter the servers by hand: {manual}</> : <>Mail cannot guess these servers. When it asks, choose <b>IMAP</b> and enter: {manual}</>,
      <>Tick <b>Mail</b> (and Notes if you like) and press <b>Done</b>. Under Mail → Settings → Accounts → Mailbox Behaviours, make sure Sent, Drafts, Junk and Trash map to the server folders so Tern sees them.</>,
    ],
    ios: [
      <>Open <b>Settings → Mail → Accounts → Add Account → Other → Add Mail Account</b>.</>,
      <>Enter your name, <b>{a.email}</b>, {pw} and a description, then <b>Next</b>.</>,
      <>Make sure <b>IMAP</b> is selected at the top. {a.autoconfig ? 'The server fields fill themselves in; if they stay empty:' : 'Fill in the servers:'} incoming host <b>{imap?.host}</b>, outgoing host <b>{smtp?.host}</b>, user name <b>{imap?.username}</b>, password again in both sections.</>,
      <>Press <b>Next</b>, then <b>Save</b>. If verification fails, open the account → Advanced and set incoming port <b>{imap?.port}</b> with SSL on, and outgoing (SMTP → primary server) port <b>{smtp?.port}</b> with SSL on.</>,
    ],
    outlook: [
      <><b>New Outlook (Windows and Mac)</b>: Settings (gear) → Accounts → Email accounts → <b>Add account</b>. Enter <b>{a.email}</b>, press Continue, then choose <b>IMAP</b> under "advanced setup" if it does not detect the server.</>,
      <>Fill in {manual}</>,
      <><b>Classic Outlook</b>: File → Add Account → type <b>{a.email}</b> → Advanced options → tick "Let me set up my account manually" → Connect → <b>IMAP</b>. Enter the same servers, with encryption <b>SSL/TLS</b> for both.</>,
      <>Enter {pw} and press Connect. Outlook may create its own "Sent Items"; under the account's folder settings choose the server's <b>Sent</b> folder so sent mail shows up in Tern.</>,
    ],
    android: [
      <><b>Gmail app</b>: Settings → Add account → <b>Other</b>. Enter <b>{a.email}</b>, choose <b>Personal (IMAP)</b>, enter {pw}.</>,
      <>Incoming server: <b>{imap?.host}</b>, port <b>{imap?.port}</b>, security <b>{imap?.security}</b>. Outgoing: <b>{smtp?.host}</b>, port <b>{smtp?.port}</b>, <b>{smtp?.security}</b>, "Require sign-in" on with the same user name and password.</>,
      <><b>FairEmail or K-9 Mail</b>: add an account, then "Manual setup". {a.autoconfig ? 'Both apps also read the server\'s autoconfig, so the fields may already be filled.' : ''} Use the same values; choose SSL/TLS, not STARTTLS, for port {imap?.port}.</>,
      <>Samsung Email and Outlook for Android work the same way: pick IMAP, then the servers above.</>,
    ],
    windows: [
      <>Open <b>Mail</b> (or the new Outlook for Windows). Settings → Manage accounts → <b>Add account</b> → <b>Advanced setup</b> → <b>Internet email</b>.</>,
      <>Email address <b>{a.email}</b>, user name <b>{imap?.username}</b>, {pw}, account name anything you like, your name for sent mail.</>,
      <>Incoming server <b>{imap?.host}:{imap?.port}</b>, account type <b>IMAP4</b>. Outgoing server <b>{smtp?.host}:{smtp?.port}</b>. Leave all four SSL and authentication boxes ticked.</>,
      <>Press <b>Sign in</b>. The first sync downloads the recent messages; older mail loads as you scroll.</>,
    ],
    jmap: [
      <>Some apps speak JMAP, the same protocol Tern uses, and sync faster than IMAP. Examples: <b>Ltt.rs</b> (Android), <b>Mailtemi</b> (iPhone, iPad and Mac), <b>Twake Mail</b>, and <b>aerc</b> or <b>mujmap</b> on the command line.</>,
      <>When the app asks for a server or session URL, enter <b>{a.jmap?.sessionUrl}</b>.</>,
      <>Sign in with <b>{a.jmap?.username}</b> and {pw}. Apps that support app passwords or tokens may accept those too.</>,
      <>Everything Tern does in a thread (read state, stars, labels, snooze via archive) is visible instantly in a JMAP app, because both push changes to the same server state.</>,
    ],
  };
  return <ol className="steps">{steps[client].map((s, i) => <li key={i}><span>{s}</span></li>)}</ol>;
}

