import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { Button, Field, Input } from '../components/ui';
import { Feather } from 'lucide-react';

export default function LoginPage() {
  const { setUser, refresh, registrationOpen } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.post<{ mfaRequired?: boolean; user?: any }>('/api/auth/login', { username, password, code: mfa ? code : undefined });
      if (r.mfaRequired) { setMfa(true); return; }
      setUser(r.user);
      await refresh();
      nav('/mail/inbox', { replace: true });
    } catch (err: any) {
      setError(err.message ?? 'Sign-in failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand"><span className="brand-logo"><Feather size={16} /></span>Tern</div>
        <h1 style={{ marginBottom: 4 }}>{mfa ? 'Two-factor code' : 'Sign in'}</h1>
        <p className="muted" style={{ marginBottom: 18 }}>{mfa ? 'Enter the 6-digit code from your authenticator app, or a recovery code.' : 'Your inbox, sequences and drafts are one sign-in away.'}</p>
        {!mfa ? (
          <>
            <Field label="Username"><Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          </>
        ) : (
          <Field label="Code"><Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" required /></Field>
        )}
        {error && <div className="login-error">{error}</div>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{mfa ? 'Verify' : 'Sign in'}</Button>
        {mfa && <Button type="button" variant="ghost" className="w-full mt-8" onClick={() => { setMfa(false); setCode(''); }}>Back</Button>}
        {registrationOpen && <p className="help-text mt-16" style={{ textAlign: 'center' }}>New here? <Link to="/register">Create an account</Link></p>}
        <p className="help-text mt-16">No password reset by design. An admin can set a new password with <code>tern set-password</code> on the server.</p>
      </form>
    </div>
  );
}
