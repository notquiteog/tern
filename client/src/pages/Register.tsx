import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Feather } from 'lucide-react';
import { Background } from '../components/Background';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { Button, Field, Input, Callout } from '../components/ui';
import { PowFootnote, PowStatus } from '../components/PowStatus';
import { withPow, type PowProgress } from '../lib/pow';

export default function RegisterPage() {
  const { refresh, registrationOpen } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const invite = params.get('invite') ?? '';
  const [inviteInfo, setInviteInfo] = useState<{ valid: boolean; role: string; note: string } | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pow, setPow] = useState<PowProgress | null>(null);
  useEffect(() => {
    if (!invite) return;
    api.get<any>(`/api/auth/invite/${encodeURIComponent(invite)}`).then(setInviteInfo).catch((e) => setInviteError(e.message));
  }, [invite]);
  const allowed = registrationOpen || (invite && inviteInfo?.valid);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setBusy(true); setError('');
    try {
      await withPow('register', username, (proof) => api.post('/api/auth/register', { username: username.trim(), password, displayName, invite: invite || undefined, pow: proof }), setPow);
      await refresh();
      nav('/settings/accounts?welcome=1', { replace: true });
    } catch (err: any) { setError(err.message); } finally { setBusy(false); setPow(null); }
  }
  return (
    <div className="auth-page">
      <Background />
      <form className="auth-card" onSubmit={submit} style={{ maxWidth: 440 }}>
        <div className="brand"><span className="brand-logo"><Feather size={16} /></span>Tern</div>
        <h1 style={{ marginBottom: 4 }}>Create your account</h1>
        {invite && inviteInfo?.valid && <p className="muted" style={{ marginBottom: 18 }}>You were invited{inviteInfo.note ? ` (${inviteInfo.note})` : ''} as a {inviteInfo.role}.</p>}
        {invite && inviteError && <Callout kind="danger">{inviteError}</Callout>}
        {!invite && !registrationOpen && <Callout kind="warning">Registration is by invitation only. Ask an admin for an invite link.</Callout>}
        {allowed && (
          <>
            <Field label="Your name"><Input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></Field>
            <Field label="Username" hint="Letters, numbers, dots and dashes."><Input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoCapitalize="none" /></Field>
            <Field label="Password" hint="At least 10 characters."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" /></Field>
            <Field label="Confirm password"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></Field>
            {error && <div className="login-error">{error}</div>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Create account</Button>
            <PowStatus progress={pow} />
          </>
        )}
        <p className="help-text mt-16">Already have an account? <Link to="/login">Sign in</Link></p>
        {allowed && <PowFootnote />}
      </form>
    </div>
  );
}
