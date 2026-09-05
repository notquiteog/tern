import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '../api';
import { Button, Callout, Field, Input, Modal, Textarea } from '../components/ui';
import { fmtFingerprint, loadDeviceKey, looksLikeKey, unlockPrivateKey, type PrivateKey } from '../lib/pgp';

// Holds the unlocked private key for the tab's lifetime and asks for the
// passphrase when something needs it (reading an encrypted message, signing,
// answering a sign-in challenge). Finds the locked key on this device first,
// then on the server for a signed-in session, and otherwise lets the person
// paste it.
interface Ctx { requestKey: (reason: string) => Promise<PrivateKey>; unlocked: boolean; lock: () => void; fingerprint: string | null }
const C = createContext<Ctx>(null as any);
export const usePgp = () => useContext(C);

export function PgpProvider({ children }: { children: ReactNode }) {
  const keyRef = useRef<PrivateKey | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ reason: string; armored: string | null; resolve: (k: PrivateKey) => void; reject: (e: Error) => void } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const requestKey = useCallback(async (reason: string) => {
    if (keyRef.current) return keyRef.current;
    let armored: string | null = loadDeviceKey()?.armored ?? null;
    if (!armored) { try { armored = (await api.get<{ privateKey: string }>('/api/pgp/me/private')).privateKey; } catch { armored = null; } }
    return new Promise<PrivateKey>((resolve, reject) => { setPassphrase(''); setPasted(''); setError(''); setPrompt({ reason, armored, resolve, reject }); });
  }, []);

  const lock = useCallback(() => { keyRef.current = null; setUnlocked(false); setFingerprint(null); }, []);

  async function submit() {
    if (!prompt) return;
    setBusy(true); setError('');
    try {
      const armored = prompt.armored ?? pasted;
      if (!armored || looksLikeKey(armored) !== 'private') throw new Error('Paste your private key (the block that starts with BEGIN PGP PRIVATE KEY BLOCK)');
      const key = await unlockPrivateKey(armored, passphrase);
      keyRef.current = key; setUnlocked(true); setFingerprint(key.getFingerprint());
      prompt.resolve(key); setPrompt(null);
    } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); }
  }
  function cancel() { prompt?.reject(new Error('Key not unlocked')); setPrompt(null); }

  const value = useMemo(() => ({ requestKey, unlocked, lock, fingerprint }), [requestKey, unlocked, lock, fingerprint]);
  return (
    <C.Provider value={value}>
      {children}
      <Modal open={Boolean(prompt)} onClose={cancel} title="Unlock your key" footer={<><Button onClick={cancel}>Cancel</Button><Button variant="primary" loading={busy} disabled={!passphrase && Boolean(prompt?.armored)} onClick={submit}>Unlock</Button></>}>
        {prompt && <>
          <p className="muted small">{prompt.reason}. The key is unlocked in this browser only and forgotten when the tab closes.</p>
          {!prompt.armored && <>
            <Callout kind="warning">No private key is stored on this device or on the server. Paste it below; it stays in this browser.</Callout>
            <Field label="Private key" className="mt-16"><Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----" style={{ fontFamily: 'var(--mono)', fontSize: 12, minHeight: 120 }} /></Field>
          </>}
          <Field label="Passphrase"><Input type="password" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} /></Field>
          {error && <div className="login-error">{error}</div>}
          {prompt.armored && <div className="help-text row gap-4"><KeyRound size={12} /> Key {fmtFingerprint(loadDeviceKey()?.fingerprint ?? '').slice(0, 24) || 'from this server'}</div>}
        </>}
      </Modal>
    </C.Provider>
  );
}
