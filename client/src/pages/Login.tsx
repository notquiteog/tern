import { useState, type FormEvent } from 'react';
import { BrandLogo, useAppName } from '../components/Brand';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, Copy } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { usePgp } from '../state/pgp';
import { Button, Field, Input, Textarea } from '../components/ui';
import { Background } from '../components/Background';
import { PowFootnote, PowStatus } from '../components/PowStatus';
import { withPow, type PowProgress } from '../lib/pow';
import { decryptArmored, loadDeviceKey } from '../lib/pgp';

interface Challenge { challengeId: string; challenge: string; fingerprint?: string | null }
interface LoginResponse { mfaRequired?: boolean; methods?: string[]; pgp?: Challenge | null; user?: any }

export default function LoginPage() {
  const appName = useAppName();
  const { setUser, refresh, registrationOpen } = useAuth();
  const { requestKey } = usePgp();
  const nav = useNavigate();
  const [mode, setMode] = useState<'password' | 'key'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'credentials' | 'second'>('credentials');
  const [methods, setMethods] = useState<string[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [manual, setManual] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pow, setPow] = useState<PowProgress | null>(null);
  const deviceKey = loadDeviceKey();

  function finish(user: any) { setUser(user); void refresh().then(() => nav('/mail/inbox', { replace: true })); }

  async function login(extra: Record<string, unknown> = {}) {
    const r = await withPow('login', username, (proof) => api.post<LoginResponse>('/api/auth/login', { username: username.trim(), password, pow: proof, ...extra }), setPow);
    if (r.mfaRequired) { setMethods(r.methods ?? []); setChallenge(r.pgp ?? null); setStep('second'); return null; }
    return r.user;
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { const u = await login(); if (u) finish(u); } catch (err: any) { setError(err.message ?? 'Sign-in failed'); } finally { setBusy(false); setPow(null); }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { const u = await login({ code: code.trim() }); if (u) finish(u); } catch (err: any) { setError(err.message ?? 'That code was not accepted'); } finally { setBusy(false); setPow(null); }
  }

  // Answer the key challenge: with the key on this device, or with a pasted
  // answer produced elsewhere (gpg --decrypt).
  async function answerWithKey() {
    if (!challenge) return;
    setBusy(true); setError('');
    try {
      const key = await requestKey('Answer the sign-in challenge');
      const plain = (await decryptArmored(challenge.challenge, key)).text;
      const u = await login({ pgpChallengeId: challenge.challengeId, pgpResponse: plain });
      if (u) finish(u);
    } catch (err: any) { setError(err.message ?? 'The challenge could not be answered'); } finally { setBusy(false); setPow(null); }
  }
  async function answerManually(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true); setError('');
    try { const u = await login({ pgpChallengeId: challenge.challengeId, pgpResponse: answer.trim() }); if (u) finish(u); } catch (err: any) { setError(err.message ?? 'That answer was not accepted'); } finally { setBusy(false); setPow(null); }
  }

  // Passwordless: the key and its passphrase are the whole proof.
  async function submitKeyOnly(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const c = await withPow('login', username, (proof) => api.post<Challenge>('/api/auth/pgp/start', { username: username.trim(), pow: proof }), setPow);
      setPow(null);
      if (manual) { setChallenge(c); setStep('second'); return; }
      const key = await requestKey('Sign in with your key');
      const plain = (await decryptArmored(c.challenge, key)).text;
      const r = await api.post<{ user: any }>('/api/auth/pgp/finish', { username: username.trim(), challengeId: c.challengeId, response: plain });
      finish(r.user);
    } catch (err: any) { setError(err.message === 'Key not unlocked' ? '' : err.message ?? 'Sign-in failed'); } finally { setBusy(false); setPow(null); }
  }
  async function finishManualKeyOnly(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true); setError('');
    try { const r = await api.post<{ user: any }>('/api/auth/pgp/finish', { username: username.trim(), challengeId: challenge.challengeId, response: answer.trim() }); finish(r.user); } catch (err: any) { setError(err.message ?? 'That answer was not accepted'); } finally { setBusy(false); }
  }

  const reset = () => { setStep('credentials'); setCode(''); setAnswer(''); setChallenge(null); setError(''); setManual(false); };
  const title = step === 'second' ? (mode === 'key' ? 'Answer the challenge' : 'One more step') : mode === 'key' ? 'Sign in with your key' : 'Sign in';

  return (
    <div className="auth-page">
      <Background />
      <div className="auth-card">
        <div className="brand"><BrandLogo />{appName}</div>
        <h1 style={{ marginBottom: 4 }}>{title}</h1>

        {step === 'credentials' && mode === 'password' && (
          <form onSubmit={submitPassword}>
            <p className="muted" style={{ marginBottom: 18 }}>Your inbox, sequences and drafts are one sign-in away.</p>
            <Field label="Username"><Input autoFocus autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            {error && <div className="login-error">{error}</div>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
            <PowStatus progress={pow} />
            <Button type="button" variant="ghost" className="w-full mt-8" icon={<KeyRound size={15} />} onClick={() => { setMode('key'); setError(''); }}>Sign in with your key instead</Button>
          </form>
        )}

        {step === 'credentials' && mode === 'key' && (
          <form onSubmit={submitKeyOnly}>
            <p className="muted" style={{ marginBottom: 18 }}>No password. The server encrypts a challenge to your OpenPGP key; your key answers it.{deviceKey ? '' : ' This browser does not hold your key, so you will paste one or answer with GnuPG.'}</p>
            <Field label="Username"><Input autoFocus autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
            <label className="row small mb-16" style={{ cursor: 'pointer' }}><input type="checkbox" className="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> Show the challenge so I can decrypt it with GnuPG</label>
            {error && <div className="login-error">{error}</div>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<KeyRound size={15} />}>Continue</Button>
            <PowStatus progress={pow} />
            <Button type="button" variant="ghost" className="w-full mt-8" onClick={() => { setMode('password'); setError(''); }}>Use a password instead</Button>
          </form>
        )}

        {step === 'second' && (
          <div>
            {methods.includes('totp') && mode === 'password' && (
              <form onSubmit={submitCode}>
                <p className="muted" style={{ marginBottom: 18 }}>Enter the 6-digit code from your authenticator app, or a recovery code.</p>
                <Field label="Code"><Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" /></Field>
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!code.trim()}>Verify</Button>
              </form>
            )}
            {challenge && (
              <div className={methods.includes('totp') && mode === 'password' ? 'mt-16' : ''}>
                {methods.includes('totp') && mode === 'password' && <div className="divider" />}
                <p className="muted" style={{ marginBottom: 12 }}>{mode === 'password' ? (methods.includes('totp') ? 'Or answer with your OpenPGP key.' : 'Answer the challenge with your OpenPGP key.') : 'Decrypt this challenge with your private key and enter the result.'}{challenge.fingerprint ? ` Key ${challenge.fingerprint.slice(-16).toUpperCase().replace(/(.{4})/g, '$1 ').trim()}.` : ''}</p>
                {!manual && <Button type="button" variant={methods.includes('totp') && mode === 'password' ? 'default' : 'primary'} size="lg" className="w-full" icon={<KeyRound size={15} />} loading={busy} onClick={answerWithKey}>{deviceKey ? 'Unlock my key and continue' : 'Use a key in this browser'}</Button>}
                <Button type="button" variant="ghost" size="sm" className="w-full mt-8" onClick={() => setManual((v) => !v)}>{manual ? 'Hide the challenge' : 'Answer with GnuPG instead'}</Button>
                {manual && (
                  <form onSubmit={mode === 'key' ? finishManualKeyOnly : answerManually} className="mt-8">
                    <div className="row small mb-8" style={{ justifyContent: 'space-between' }}><span className="muted">Run <code>gpg --decrypt</code> on this:</span><Button type="button" size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => navigator.clipboard?.writeText(challenge.challenge)}>Copy</Button></div>
                    <Textarea readOnly value={challenge.challenge} style={{ fontFamily: 'var(--mono)', fontSize: 11, minHeight: 110 }} />
                    <Field label="Decrypted answer" className="mt-8"><Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="tern-auth:…" autoComplete="off" /></Field>
                    <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!answer.trim()}>Continue</Button>
                  </form>
                )}
              </div>
            )}
            {error && <div className="login-error mt-8">{error}</div>}
            <PowStatus progress={pow} />
            <Button type="button" variant="ghost" className="w-full mt-8" onClick={reset}>Back</Button>
          </div>
        )}

        {registrationOpen && step === 'credentials' && <p className="help-text mt-16" style={{ textAlign: 'center' }}>New here? <Link to="/register">Create an account</Link></p>}
        {step === 'credentials' && <p className="help-text mt-16">No password reset by design. An admin can set a new password from Settings → Users, or with <code>tern set-password</code> on the server.</p>}
        <PowFootnote />
      </div>
    </div>
  );
}
