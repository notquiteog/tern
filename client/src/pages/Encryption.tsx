import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Atom, Copy, Download, KeyRound, Lock, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, Smartphone, Server, X, Radio, Check } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { usePgp } from '../state/pgp';
import { useAccounts } from '../lib/queries';
import { Badge, Button, Callout, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Textarea, Toggle } from '../components/ui';
import { DataTable } from '../components/DataTable';
import { changePassphrase, clearDeviceKey, decryptArmored, fmtFingerprint, generateKeyPair, inspectKey, loadDeviceKey, looksLikeKey, protectPrivateKey, saveDeviceKey, type KeyProfile } from '../lib/pgp';
import { fmtDate, fmtDateTime, fmtRelative } from '../lib/format';

interface MyKey { key: { fingerprint: string; keyId: string; userIds: string[]; emails: string[]; algorithm: string; created: string; expires: string | null; publicKey: string; version: number; algorithms: string[]; postQuantum: boolean; postQuantumAlgorithms: string[] } | null; hasPrivate: boolean; auth: 'off' | 'second_factor' | 'passwordless'; updatedAt: string | null; autocrypt: { enabled: boolean; prefer: 'mutual' | 'nopreference' } }
interface Peer { email: string; lastSeen: string | null; keySeen: string | null; fingerprint: string | null; preferEncrypt: 'mutual' | 'nopreference'; gossipFingerprint: string | null; gossipSeen: string | null; stale: boolean; recommendation: 'disable' | 'discourage' | 'available' | 'encrypt' }

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/pgp-keys' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function EncryptionSettings() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['pgp-me'], queryFn: () => api.get<MyKey>('/api/pgp/me') });
  const { data: recipients } = useQuery({ queryKey: ['pgp-recipients'], queryFn: () => api.get<{ contactsWithKeys: number; keys: any[] }>('/api/pgp/recipients/summary') });
  const [mode, setMode] = useState<'none' | 'generate' | 'import' | 'passphrase' | 'remove'>('none');
  const [device, setDevice] = useState(loadDeviceKey());
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['pgp-me'] }); qc.invalidateQueries({ queryKey: ['pgp-recipients'] }); setDevice(loadDeviceKey()); void refresh(); };
  if (isLoading || !data) return <Spinner />;
  const key = data.key;
  const deviceMatches = Boolean(device && key && device.fingerprint === key.fingerprint);
  return (
    <div style={{ maxWidth: 860 }}>
      <PageHeader title="Encryption" sub="OpenPGP for your mail and your sign-in. Encrypt to people whose keys you have, sign what you send, read encrypted mail in this browser, and use the key instead of a code or a password to sign in." />
      {!key ? (
        <div className="card">
          <div className="card-title"><h2>Your key</h2></div>
          <p className="muted small">No key yet. Generate one here (recommended) or import one you already use with GnuPG, Thunderbird or Proton. The private key never reaches this server in a usable form: it is protected by your passphrase, and only your browser unlocks it.</p>
          <div className="row wrap"><Button variant="primary" icon={<Plus size={15} />} onClick={() => setMode('generate')}>Generate a key pair</Button><Button icon={<Upload size={15} />} onClick={() => setMode('import')}>Import a key</Button></div>
        </div>
      ) : (
        <div className="card">
          <div className="card-title"><h2>Your key</h2><div className="row gap-4 wrap">{data.hasPrivate && <Badge kind="success"><Server size={12} /> private key on server</Badge>}{deviceMatches && <Badge kind="success"><Smartphone size={12} /> on this device</Badge>}{!data.hasPrivate && !deviceMatches && <Badge kind="warning">public key only</Badge>}</div></div>
          <dl className="kv kv-tight">
            <dt>Fingerprint</dt><dd><span className="mono small" style={{ overflowWrap: 'anywhere' }}>{fmtFingerprint(key.fingerprint)}</span> <IconButton label="Copy" className="btn-sm" onClick={() => { navigator.clipboard?.writeText(key.fingerprint.toUpperCase()); toast.success('Copied'); }}><Copy size={13} /></IconButton></dd>
            <dt>Identities</dt><dd>{key.userIds.join(', ')}</dd>
            <dt>Algorithm</dt><dd><span className="row gap-4 wrap">{key.algorithms.length ? key.algorithms.join(' · ') : key.algorithm}{key.version >= 6 && <Badge kind="accent" >v{key.version} · RFC 9580</Badge>}{key.postQuantum && <Badge kind="success"><Atom size={12} /> post-quantum</Badge>}</span></dd>
            <dt>Created</dt><dd>{fmtDateTime(key.created)}{key.expires ? ` · expires ${fmtDate(key.expires, { always: true })}` : ' · no expiry'}</dd>
          </dl>
          <div className="row wrap mt-16 gap-4">
            <Button size="sm" icon={<Download size={13} />} onClick={() => download(`tern-${key.keyId}-public.asc`, key.publicKey)}>Public key</Button>
            {(data.hasPrivate || deviceMatches) && <Button size="sm" icon={<Download size={13} />} onClick={async () => { const armored = deviceMatches ? device!.armored : (await api.get<{ privateKey: string }>('/api/pgp/me/private')).privateKey; download(`tern-${key.keyId}-private.asc`, armored); toast.toast('Keep this file safe; it is protected by your passphrase'); }}>Private key (backup)</Button>}
            {data.hasPrivate && !deviceMatches && <Button size="sm" icon={<Smartphone size={13} />} onClick={async () => { const r = await api.get<{ privateKey: string; fingerprint: string }>('/api/pgp/me/private'); saveDeviceKey(r.privateKey, r.fingerprint); setDevice(loadDeviceKey()); toast.success('Key remembered on this device'); }}>Remember on this device</Button>}
            {deviceMatches && !data.hasPrivate && <Button size="sm" icon={<Server size={13} />} onClick={async () => { await api.put('/api/pgp/me', { privateKey: device!.armored }); invalidate(); toast.success('Private key stored on the server, protected by your passphrase'); }}>Store on server too</Button>}
            {deviceMatches && <Button size="sm" variant="ghost" onClick={() => { clearDeviceKey(); setDevice(null); toast.success('Forgotten on this device'); }}>Forget on this device</Button>}
            {(data.hasPrivate || deviceMatches) && <Button size="sm" variant="ghost" icon={<KeyRound size={13} />} onClick={() => setMode('passphrase')}>Change passphrase</Button>}
            <Button size="sm" variant="ghost" icon={<Upload size={13} />} onClick={() => setMode('import')}>Replace</Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setMode('remove')}>Remove</Button>
          </div>
        </div>
      )}

      {key && <SignInWithKey data={data} onChanged={invalidate} />}

      <AutocryptCard data={data} onChanged={invalidate} />

      <PostQuantumCard data={data} recipients={recipients} />

      <div className="card mt-16">
        <div className="card-title"><h2>What is encrypted</h2></div>
        <ul className="tips">
          <li><b>Mail you write</b> is encrypted when every recipient has a key on file (below, or on their contact card). The composer shows a lock; you can turn it off per message. A copy is always encrypted to your own key so your Sent folder stays readable.</li>
          <li><b>Signing</b> happens in this browser with your unlocked key, per message, whenever you choose it.</li>
          <li><b>Sequences and AI responders</b> can encrypt to contacts with keys (a switch on each sequence; responders always do when they can). They cannot sign, because no browser is present when they run.</li>
          <li><b>Mail you receive</b> encrypted stays encrypted in Tern's cache and is decrypted here when you open it. Search, rules and the assistant do not see inside it; everything else about it (threading, labels, snooze, replies) works as usual.</li>
          <li><b>Your data export</b> can be downloaded encrypted to your key: <a href="/api/auth/export?pgp=1" download>tern-export.json.asc</a>.</li>
        </ul>
      </div>

      <RecipientKeys summary={recipients} onChanged={invalidate} />

      {mode === 'generate' && <GenerateModal onClose={() => setMode('none')} onDone={invalidate} defaultName={user!.display_name} />}
      {mode === 'import' && <ImportModal onClose={() => setMode('none')} onDone={invalidate} />}
      {mode === 'passphrase' && <PassphraseModal onClose={() => setMode('none')} onDone={invalidate} hasServer={data.hasPrivate} />}
      {mode === 'remove' && <RemoveModal onClose={() => setMode('none')} onDone={invalidate} />}
    </div>
  );
}

function StorageChoices({ server, device, setServer, setDevice }: { server: boolean; device: boolean; setServer: (v: boolean) => void; setDevice: (v: boolean) => void }) {
  return (
    <div className="col gap-8 mt-8">
      <div className="row"><Toggle checked={server} onChange={setServer} /><div><div className="strong small">Keep the private key on this server</div><div className="help-text">Stored only in its passphrase-protected form, so it can be fetched into any browser you sign in from. The server cannot use it.</div></div></div>
      <div className="row"><Toggle checked={device} onChange={setDevice} /><div><div className="strong small">Remember it on this device</div><div className="help-text">Needed for signing in with the key on this browser. Still passphrase-protected.</div></div></div>
    </div>
  );
}

function GenerateModal({ onClose, onDone, defaultName }: { onClose: () => void; onDone: () => void; defaultName: string }) {
  const toast = useToast();
  const { data: accounts = [] } = useAccounts();
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState(''); const [confirm, setConfirm] = useState('');
  const [server, setServer] = useState(true); const [device, setDevice] = useState(true);
  const [profile, setProfile] = useState<KeyProfile>('compatible');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!email && accounts.length) setEmail(accounts[0].email); }, [accounts, email]);
  async function go() {
    if (pass.length < 12) { toast.error('Use a passphrase of at least 12 characters'); return; }
    if (pass !== confirm) { toast.error('Passphrases do not match'); return; }
    setBusy(true);
    try {
      const k = await generateKeyPair({ name, email, passphrase: pass, profile });
      await api.put('/api/pgp/me', { publicKey: k.publicKey, privateKey: server ? k.privateKey : null });
      if (device) saveDeviceKey(k.privateKey, k.fingerprint);
      if (!server && !device) download(`tern-${k.fingerprint.slice(-16)}-private.asc`, k.privateKey);
      toast.success('Key pair created'); onDone(); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Generate a key pair" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name || !email || !pass} onClick={go}>Generate</Button></>}>
      <p className="muted small">A modern Curve25519 key is created in this browser. The passphrase protects the private key everywhere it is stored; nobody can reset it, so keep it somewhere safe.</p>
      <div className="form-row">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Address on the key"><Input list="pgp-emails" value={email} onChange={(e) => setEmail(e.target.value)} /><datalist id="pgp-emails">{accounts.map((a) => <option key={a.id} value={a.email} />)}</datalist></Field>
        <Field label="Passphrase" hint="At least 12 characters."><Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Confirm passphrase"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      <Field label="Key format" className="mt-8">
        <div className="segmented"><button type="button" className={profile === 'compatible' ? 'active' : ''} onClick={() => setProfile('compatible')}>Compatible (v4)</button><button type="button" className={profile === 'modern' ? 'active' : ''} onClick={() => setProfile('modern')}>Modern (v6, RFC 9580)</button></div>
        <div className="hint">{profile === 'compatible' ? 'Curve25519, readable by every OpenPGP client made this decade.' : 'The new key format, the base for post-quantum subkeys. GnuPG 2.4+, Thunderbird 2025+ and Proton read it; older clients cannot.'}</div>
      </Field>
      <StorageChoices server={server} device={device} setServer={setServer} setDevice={setDevice} />
      {!server && !device && <Callout kind="warning">The private key will only be downloaded as a file. Lose it and encrypted mail is unreadable.</Callout>}
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [info, setInfo] = useState<any>(null);
  const [pass, setPass] = useState(''); const [confirm, setConfirm] = useState('');
  const [server, setServer] = useState(true); const [device, setDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => { if (looksLikeKey(text)) inspectKey(text).then(setInfo).catch((e) => { setInfo({ error: e.message }); }); else setInfo(null); }, 200);
    return () => clearTimeout(t);
  }, [text]);
  async function go() {
    setBusy(true);
    try {
      if (!info || info.error) throw new Error('Paste a valid OpenPGP key');
      if (!info.isPrivate) { await api.put('/api/pgp/me', { publicKey: text }); toast.success('Public key saved'); onDone(); onClose(); return; }
      let armored = text;
      if (!info.protectedByPassphrase) {
        if (pass.length < 12) throw new Error('Protect the key with a passphrase of at least 12 characters');
        if (pass !== confirm) throw new Error('Passphrases do not match');
        armored = await protectPrivateKey(text, pass);
      }
      await api.put('/api/pgp/me', { privateKey: server ? armored : null, publicKey: info.publicKey });
      if (device) saveDeviceKey(armored, info.fingerprint);
      toast.success('Key imported'); onDone(); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Import a key" size="wide" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!info || info.error} onClick={go}>Import</Button></>}>
      <p className="muted small">Paste an armored key or choose a file. A private key brings its public half with it. From GnuPG: <code>gpg --armor --export-secret-keys you@example.com</code> (or <code>--export</code> for the public key only).</p>
      <div className="row mb-8"><Button size="sm" icon={<Upload size={13} />} onClick={() => file.current?.click()}>Choose file</Button><input ref={file} type="file" accept=".asc,.gpg,.pgp,.key,.txt,application/pgp-keys" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ''; }} /></div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="-----BEGIN PGP PRIVATE KEY BLOCK----- or -----BEGIN PGP PUBLIC KEY BLOCK-----" style={{ fontFamily: 'var(--mono)', fontSize: 12, minHeight: 140 }} />
      {info && !info.error && (
        <div className="callout mt-16 note"><div>
          <div className="strong">{info.isPrivate ? 'Private key' : 'Public key'} · {info.userIds.join(', ')}</div>
          <div className="small mono">{fmtFingerprint(info.fingerprint)}</div>
          <div className="small muted">{info.algorithm} · created {fmtDate(info.created, { always: true })}{info.isPrivate ? (info.protectedByPassphrase ? ' · passphrase-protected' : ' · not protected by a passphrase') : ''}</div>
          <div className="small muted">A key with post-quantum subkeys is recognised after import; mail to it is encrypted to its classical subkey until the browser library supports ML-KEM.</div>
        </div></div>
      )}
      {info?.error && <Callout kind="danger">{info.error}</Callout>}
      {info?.isPrivate && !info.protectedByPassphrase && <div className="form-row mt-16"><Field label="Set a passphrase" hint="This key has none. It is protected before it is stored anywhere."><Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field><Field label="Confirm"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field></div>}
      {info?.isPrivate && <StorageChoices server={server} device={device} setServer={setServer} setDevice={setDevice} />}
    </Modal>
  );
}

function PassphraseModal({ onClose, onDone, hasServer }: { onClose: () => void; onDone: () => void; hasServer: boolean }) {
  const toast = useToast();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    if (next.length < 12) { toast.error('Use at least 12 characters'); return; }
    if (next !== confirm) { toast.error('Passphrases do not match'); return; }
    setBusy(true);
    try {
      const dev = loadDeviceKey();
      const armored = dev?.armored ?? (await api.get<{ privateKey: string }>('/api/pgp/me/private')).privateKey;
      const re = await changePassphrase(armored, cur, next);
      if (hasServer) await api.put('/api/pgp/me', { privateKey: re });
      if (dev) saveDeviceKey(re, dev.fingerprint);
      toast.success('Passphrase changed'); onDone(); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Change the key passphrase" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!cur || !next} onClick={go}>Change</Button></>}>
      <Field label="Current passphrase"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="off" /></Field>
      <div className="form-row"><Field label="New passphrase" hint="At least 12 characters."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field><Field label="Confirm"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field></div>
      <div className="help-text">Re-protects the same key; nothing changes for people who have your public key.</div>
    </Modal>
  );
}

function RemoveModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { lock } = usePgp();
  const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Remove your key" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!pw} onClick={async () => { setBusy(true); try { await api.del('/api/pgp/me' as any); } catch { /* DELETE with body below */ } finally { setBusy(false); } }} style={{ display: 'none' }}>x</Button><Button variant="danger" loading={busy} disabled={!pw} onClick={async () => { setBusy(true); try { await fetch('/api/pgp/me', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tern' }, credentials: 'same-origin', body: JSON.stringify({ password: pw }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); }); clearDeviceKey(); lock(); toast.success('Key removed'); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Remove key</Button></>}>
      <Callout kind="danger">Mail already encrypted to this key stays encrypted; without the private key it cannot be read. Sign-in with the key is turned off. Download a backup first if you may need it.</Callout>
      <Field label="Password to confirm" className="mt-16"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
    </Modal>
  );
}

function SignInWithKey({ data, onChanged }: { data: MyKey; onChanged: () => void }) {
  const toast = useToast();
  const { requestKey } = usePgp();
  const [mode, setMode] = useState(data.auth);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => setMode(data.auth), [data.auth]);
  const device = loadDeviceKey();
  async function save() {
    setBusy(true);
    try {
      let challengeId: string | undefined, response: string | undefined;
      if (mode !== 'off') {
        const c = await api.post<{ challengeId: string; challenge: string }>('/api/pgp/auth/challenge');
        const key = await requestKey('Answer a test challenge to prove this browser can sign you in');
        response = (await decryptArmored(c.challenge, key)).text; challengeId = c.challengeId;
        if (!device && data.hasPrivate) { const r = await api.get<{ privateKey: string; fingerprint: string }>('/api/pgp/me/private'); saveDeviceKey(r.privateKey, r.fingerprint); }
      }
      const r = await api.put<{ recoveryCodes: string[] | null }>('/api/pgp/auth', { mode, password: pw, challengeId, response });
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      toast.success(mode === 'off' ? 'Sign-in with key turned off' : 'Sign-in with key enabled'); setPw(''); onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <div className="card mt-16">
      <div className="card-title"><h2>Sign in with your key</h2>{data.auth !== 'off' ? <Badge kind="success"><ShieldCheck size={12} /> {data.auth === 'passwordless' ? 'second factor and passwordless' : 'second factor'}</Badge> : <Badge>off</Badge>}</div>
      <p className="muted small">At sign-in the server encrypts a one-time challenge to your public key; only the private key can answer it. It works on devices that remember your key, or by decrypting the challenge with GnuPG and pasting the answer. Recovery codes cover a lost key.</p>
      <div className="col gap-8 mb-16">
        {([['off', 'Off', 'Password only, plus an authenticator code if you set one up under Security.'], ['second_factor', 'Second factor', 'Password first, then the key challenge. A leaked password alone cannot sign in.'], ['passwordless', 'Second factor, and allow passwordless sign-in', 'Also offers "Sign in with your key" on the sign-in page: no password, the key and its passphrase are the whole proof.']] as const).map(([v, l, d]) => (
          <label key={v} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer' }}><input type="radio" name="pgp-auth" className="checkbox" checked={mode === v} onChange={() => setMode(v)} style={{ marginTop: 3 }} /><div><div className="strong small">{l}</div><div className="help-text">{d}</div></div></label>
        ))}
      </div>
      {!device && mode !== 'off' && <Callout kind="warning">This browser does not hold your key yet.{data.hasPrivate ? ' It will be remembered on this device when you save.' : ' Import or generate the private key here first, or be ready to answer challenges with GnuPG.'}</Callout>}
      <div className="row wrap mt-8"><Input type="password" placeholder="Password to confirm" value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 260 }} autoComplete="current-password" /><Button variant="primary" loading={busy} disabled={!pw || mode === data.auth} onClick={save}>{mode === 'off' ? 'Turn off' : 'Save and verify'}</Button></div>
      {codes && <Callout kind="warning"><div className="strong mb-8">Recovery codes. Save them now; they are not shown again.</div><div className="mono small" style={{ columns: 2 }}>{codes.map((c) => <div key={c}>{c}</div>)}</div></Callout>}
    </div>
  );
}

// Autocrypt (autocrypt.org, level 1): our key travels in a header on every
// message; keys that arrive in headers are remembered per sender. Nothing to
// exchange by hand.
function AutocryptCard({ data, onChanged }: { data: MyKey; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: ac } = useQuery({ queryKey: ['autocrypt'], queryFn: () => api.get<{ enabled: boolean; prefer: 'mutual' | 'nopreference'; hasKey: boolean; peers: Peer[] }>('/api/pgp/autocrypt') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['autocrypt'] }); onChanged(); };
  async function save(patch: { enabled?: boolean; prefer?: 'mutual' | 'nopreference' }) {
    try { await api.put('/api/pgp/autocrypt', patch); refresh(); } catch (e) { toast.error(e); }
  }
  const REC: Record<Peer['recommendation'], [string, 'success' | 'warning' | 'accent' | undefined]> = { encrypt: ['encrypts by default', 'success'], available: ['key available', 'accent'], discourage: ['key may be stale', 'warning'], disable: ['no key', undefined] };
  return (
    <div className="card mt-16">
      <div className="card-title"><h2><span className="row gap-4"><Radio size={15} /> Autocrypt</span></h2>{data.autocrypt.enabled && data.key ? <Badge kind="success">on</Badge> : <Badge>off</Badge>}</div>
      <p className="muted small">Your public key rides along in an <code>Autocrypt</code> header on everything you send, and keys that arrive in other people's headers are kept here. Delta Chat, Thunderbird, K-9 Mail and FairEmail do the same, so after one exchange of plain mail both sides can encrypt without swapping keys by hand. Group mail encrypted to several people carries <code>Autocrypt-Gossip</code> headers inside, so everyone learns everyone's key.</p>
      {!data.key && <Callout>Generate or import a key above to take part; there is nothing to announce yet.</Callout>}
      <div className="col gap-8 mt-8">
        <div className="row"><Toggle checked={data.autocrypt.enabled} disabled={!data.key} onChange={(v) => save({ enabled: v })} /><div><div className="strong small">Announce my key on outgoing mail</div><div className="help-text">Adds the header to every message from every connected account, including sequences and responders.</div></div></div>
        <div className="row"><Toggle checked={data.autocrypt.prefer === 'mutual'} disabled={!data.key} onChange={(v) => save({ prefer: v ? 'mutual' : 'nopreference' })} /><div><div className="strong small">Prefer encrypted mail (mutual)</div><div className="help-text">Tells peers you would rather receive encrypted mail. When they say the same, the composer encrypts to them by default; otherwise their key is one click away.</div></div></div>
      </div>
      {ac && ac.peers.length > 0 && (
        <div className="mt-16"><DataTable rows={ac.peers} rowKey={(p) => p.email} cardSize="sm" columns={[
          { key: 'email', header: 'Address', primary: true, cell: (p) => p.email },
          { key: 'state', header: 'State', cell: (p) => <Badge kind={REC[p.recommendation][1]}>{REC[p.recommendation][0]}</Badge> },
          { key: 'fp', header: 'Key', secondary: true, className: 'mono small', cell: (p) => p.fingerprint ? fmtFingerprint(p.fingerprint).slice(0, 24) + '…' : p.gossipFingerprint ? `gossip · ${fmtFingerprint(p.gossipFingerprint).slice(0, 19)}…` : '' },
          { key: 'prefer', header: 'Prefers', className: 'small muted', cell: (p) => p.preferEncrypt === 'mutual' ? 'encrypted' : 'no preference' },
          { key: 'seen', header: 'Last seen', className: 'small muted', nowrap: true, cell: (p) => p.lastSeen ? fmtRelative(p.lastSeen) : '' },
          { key: 'act', actions: true, cell: (p) => <>{(p.fingerprint || p.gossipFingerprint) && <Button size="sm" icon={<Check size={13} />} onClick={() => api.post(`/api/pgp/autocrypt/peers/${encodeURIComponent(p.email)}/trust`).then(() => { toast.success(`Mail to ${p.email} is now encrypted by default`); refresh(); }).catch((e) => toast.error(e))}>Use key</Button>}<IconButton label="Forget" className="btn-sm" onClick={() => api.del(`/api/pgp/autocrypt/peers/${encodeURIComponent(p.email)}`).then(refresh)}><X size={14} /></IconButton></> },
        ]} /></div>
      )}
      {ac && !ac.peers.length && <div className="small muted mt-8">No Autocrypt headers seen yet. They appear here as mail arrives.</div>}
    </div>
  );
}

// Where things stand with post-quantum OpenPGP, honestly.
function PostQuantumCard({ data, recipients }: { data: MyKey; recipients?: { contactsWithKeys: number; keys: any[] } }) {
  const pqKeys = (recipients?.keys ?? []).filter((k) => k.postQuantum);
  return (
    <div className="card mt-16">
      <div className="card-title"><h2><span className="row gap-4"><Atom size={15} /> Post-quantum</span></h2>{data.key?.postQuantum ? <Badge kind="success">your key has PQ subkeys</Badge> : data.key?.version === 6 ? <Badge kind="accent">v6 key, PQ-ready</Badge> : <Badge>classical key</Badge>}</div>
      <p className="muted small">The OpenPGP post-quantum profile (draft-ietf-openpgp-pqc) pairs ML-KEM-768 with X25519 for encryption and ML-DSA-65 with Ed25519 for signing, on v6 keys. Tern recognises these keys today: a key with post-quantum subkeys is labelled when you import it or receive it, and mail to it is encrypted to its classical subkey, which every client can open. The browser library (OpenPGP.js 6.3) does not generate or use the post-quantum subkeys themselves yet; when it does, the switch is automatic and needs no new keys from you if yours is a v6 key.</p>
      <dl className="kv kv-tight">
        <dt>Your key</dt><dd>{data.key ? `${data.key.version >= 6 ? 'v6 (RFC 9580)' : `v${data.key.version || 4}`} · ${data.key.algorithms.join(' + ') || data.key.algorithm}${data.key.postQuantum ? ` · ${data.key.postQuantumAlgorithms.join(', ')}` : ''}` : 'none yet'}</dd>
        <dt>Recipients' keys</dt><dd>{pqKeys.length ? `${pqKeys.length} with post-quantum subkeys: ${pqKeys.map((k) => k.email).join(', ')}` : 'none with post-quantum subkeys so far'}</dd>
        <dt>Getting ready</dt><dd>Generate a <b>Modern (v6)</b> key when you next rotate; keep Autocrypt on so peers pick the new key up automatically.</dd>
      </dl>
    </div>
  );
}

function RecipientKeys({ summary, onChanged }: { summary?: { contactsWithKeys: number; keys: any[] }; onChanged: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [paste, setPaste] = useState(false);
  const [armored, setArmored] = useState('');
  const [busy, setBusy] = useState(false);
  async function lookup() {
    setBusy(true);
    try { const r = await api.post<any>('/api/pgp/lookup', { email }); toast.success(`Found a key for ${email} (${r.key.source})`); setEmail(''); onChanged(); } catch (e) { toast.error(e instanceof ApiError ? e.message : e); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try { const r = await api.put<any>(`/api/pgp/recipients/${encodeURIComponent(email)}`, { publicKey: armored }); toast.success(r.key.matchesAddress ? 'Key saved' : 'Key saved. Note: it does not list this address among its identities.'); setEmail(''); setArmored(''); setPaste(false); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <div className="card mt-16">
      <div className="card-title"><h2>Other people's keys</h2><span className="small muted">{summary?.contactsWithKeys ?? 0} contact{summary?.contactsWithKeys === 1 ? '' : 's'} with a key</span></div>
      <p className="muted small">Mail to anyone here is encrypted automatically. Add a key on a contact's card, paste one below, or look it up: Tern checks the address's Web Key Directory and keys.openpgp.org.</p>
      <div className="row wrap"><Input className="input-sm" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 280 }} /><Button size="sm" icon={<Search size={13} />} loading={busy && !paste} disabled={!email} onClick={lookup}>Look up</Button><Button size="sm" variant="ghost" onClick={() => setPaste((p) => !p)}>{paste ? 'Cancel paste' : 'Paste a key instead'}</Button></div>
      {paste && <div className="mt-8"><Textarea value={armored} onChange={(e) => setArmored(e.target.value)} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" style={{ fontFamily: 'var(--mono)', fontSize: 12, minHeight: 100 }} /><Button size="sm" variant="primary" className="mt-8" loading={busy} disabled={!email || !armored} onClick={save}>Save key for {email || 'address'}</Button></div>}
      {summary?.keys?.length ? <div className="mt-16"><DataTable rows={summary.keys} rowKey={(k) => k.email} cardSize="sm" columns={[
        { key: 'email', header: 'Address', primary: true, cell: (k) => k.email },
        { key: 'fp', header: 'Fingerprint', secondary: true, className: 'mono small', cell: (k) => fmtFingerprint(k.fingerprint) },
        { key: 'src', header: 'Source', cell: (k) => <span className="row gap-4 wrap"><Badge>{k.source}</Badge>{k.postQuantum && <Badge kind="success"><Atom size={12} /> PQ</Badge>}{k.version >= 6 && <Badge kind="accent">v6</Badge>}</span> },
        { key: 'when', header: 'Added', className: 'small muted', nowrap: true, cell: (k) => fmtRelative(k.created_at) },
        { key: 'act', actions: true, cell: (k) => <IconButton label="Remove" className="btn-sm" onClick={() => api.del(`/api/pgp/recipients/${encodeURIComponent(k.email)}`).then(onChanged)}><X size={14} /></IconButton> },
      ]} /></div> : null}
    </div>
  );
}

export { Lock, RefreshCw, Select };
