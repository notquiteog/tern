import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Loader2, Check, RotateCcw } from 'lucide-react';
import { apiStream } from '../api';
import { Button, IconButton } from './ui';
import { useAiStatus } from '../lib/queries';
import { textToHtml } from '../lib/format';

export type AiMode = 'compose' | 'reply' | 'rewrite' | 'polish' | 'shorten' | 'expand' | 'subject' | 'summarize';
const MODES: { value: AiMode; label: string; needsDraft?: boolean }[] = [
  { value: 'compose', label: 'Draft' }, { value: 'reply', label: 'Reply' }, { value: 'rewrite', label: 'Rewrite', needsDraft: true }, { value: 'polish', label: 'Fix grammar', needsDraft: true },
  { value: 'shorten', label: 'Shorten', needsDraft: true }, { value: 'expand', label: 'Expand', needsDraft: true }, { value: 'subject', label: 'Subject line' },
];
const TONES = ['friendly', 'professional', 'casual', 'direct', 'warm', 'formal', 'enthusiastic'];

export function AiPanel({ context, onInsert, onSubject, onClose, defaultMode, getDraft, autoRun }: {
  context: { accountId?: number | null; contactId?: number | null; threadKey?: string | null; subject?: string; recipientEmail?: string; recipientName?: string };
  onInsert: (html: string, mode: AiMode) => void; onSubject: (s: string) => void; onClose: () => void; defaultMode?: AiMode; getDraft: () => string; autoRun?: boolean;
}) {
  const { data: ai } = useAiStatus();
  const [mode, setMode] = useState<AiMode>(defaultMode ?? (context.threadKey ? 'reply' : 'compose'));
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState('friendly');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [out, setOut] = useState('');
  const [final, setFinal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const unavailable = ai && (!ai.settings.enabled || !ai.health.ok || !ai.modelInstalled);
  useEffect(() => () => abort.current?.abort(), []);
  const ranOnce = useRef(false);
  useEffect(() => { if (autoRun && ai && !unavailable && !ranOnce.current) { ranOnce.current = true; void run(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [autoRun, ai]);

  async function run() {
    setBusy(true); setOut(''); setFinal(null); setError('');
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      await apiStream('/api/ai/draft', { mode, instruction: instruction || undefined, tone, length, accountId: context.accountId ?? null, contactId: context.contactId ?? null, threadKey: context.threadKey ?? null, draft: getDraft() || undefined, subject: context.subject, recipientEmail: context.recipientEmail, recipientName: context.recipientName }, {
        signal: abort.current.signal,
        onEvent: (ev, data) => {
          if (ev === 'token') setOut((o) => o + data.t);
          else if (ev === 'done') setFinal(data.text);
          else if (ev === 'error') setError(data.error);
        },
      });
    } catch (e: any) { if (e?.name !== 'AbortError') setError(e.message); } finally { setBusy(false); }
  }
  function accept() {
    const text = final ?? out;
    if (mode === 'subject') onSubject(text);
    else onInsert(textToHtml(text), mode);
    onClose();
  }
  return (
    <div className="ai-panel">
      <div className="row">
        <span className="ai-status"><Sparkles size={15} /> AI assistant {ai?.settings?.model ? <span className="faint">· {ai.settings.model}</span> : null}</span>
        <IconButton label="Close" className="btn-sm ml-auto" onClick={onClose}><X size={14} /></IconButton>
      </div>
      {unavailable ? (
        <div className="small">{!ai.settings.enabled ? 'AI drafting is turned off.' : !ai.health.ok ? `The model server is not reachable (${ai.health.error}).` : `Model "${ai.settings.model}" is not downloaded yet.`} An admin can fix this in Settings → AI.</div>
      ) : (
        <>
          <div className="ai-modes">{MODES.map((m) => <button key={m.value} type="button" className={mode === m.value ? 'active' : ''} onClick={() => setMode(m.value)}>{m.label}</button>)}</div>
          {mode !== 'subject' && mode !== 'polish' && (
            <div className="ai-input">
              <input className="input input-sm" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={mode === 'compose' ? 'What should this email say? e.g. "ask for a 15 minute intro call next week"' : mode === 'reply' ? 'Anything specific? e.g. "say yes, propose Tuesday"' : 'Direction, optional'} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
              <select className="select input-sm" style={{ width: 130 }} value={tone} onChange={(e) => setTone(e.target.value)}>{TONES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              <select className="select input-sm" style={{ width: 100 }} value={length} onChange={(e) => setLength(e.target.value as any)}><option value="short">short</option><option value="medium">medium</option><option value="long">long</option></select>
            </div>
          )}
          {(out || busy || error) && <div className="ai-preview">{error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : (final ?? out) || <span className="faint">Thinking…</span>}</div>}
          <div className="row">
            <Button size="sm" variant="ai" icon={busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} onClick={run} disabled={busy}>{out ? 'Regenerate' : 'Generate'}</Button>
            {busy && <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>Stop</Button>}
            {!busy && (final ?? out) && <><Button size="sm" variant="primary" icon={<Check size={14} />} onClick={accept}>{mode === 'subject' ? 'Use subject' : mode === 'compose' || mode === 'reply' ? 'Insert' : 'Replace draft'}</Button><Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => { setOut(''); setFinal(null); }}>Clear</Button></>}
            <span className="small faint ml-auto">Nothing leaves this server.</span>
          </div>
        </>
      )}
    </div>
  );
}
