import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { Button, Field, Input } from '../components/ui';
import { Feather } from 'lucide-react';
import { Background } from '../components/Background';

export default function SetupPage() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/api/setup', { username, password, displayName });
      await refresh();
      nav('/settings/accounts?welcome=1', { replace: true });
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="auth-page">
      <Background />
      <form className="auth-card" onSubmit={submit} style={{ maxWidth: 440 }}>
        <div className="brand"><span className="brand-logo"><Feather size={16} /></span>Tern</div>
        <h1 style={{ marginBottom: 4 }}>Create the admin account</h1>
        <p className="muted" style={{ marginBottom: 18 }}>This is the first and only time this screen appears. Afterwards, admins add people from Settings → Users.</p>
        <Field label="Your name"><Input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} required placeholder="Alex Rivera" /></Field>
        <Field label="Username" hint="Letters, numbers, dots and dashes."><Input value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" /></Field>
        <Field label="Password" hint="At least 10 characters. A passphrase works well."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" /></Field>
        <Field label="Confirm password"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></Field>
        {error && <div className="login-error">{error}</div>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Create account</Button>
      </form>
    </div>
  );
}
