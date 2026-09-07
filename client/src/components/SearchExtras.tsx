// The three things the omnibox gains: dictation, plain English, and meaning.
//
// All three sit behind the same rule as everything else — no control appears
// for a capability that is off — so a person who has turned none of them on
// sees exactly the search box they had before.
//
// Meaning search deliberately does not replace the ordinary search. Typing
// words still matches words, because that is what people expect and because
// the blind index is exact and instant. What this adds is a second answer
// underneath: "you might also mean these", from the sealed index. Making it
// the primary result would trade a precise answer for a plausible one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Sparkles, Telescope } from 'lucide-react';
import { postWithWork } from '../lib/work';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';
import { DictateButton } from './Dictate';
import { IconButton } from './ui';
import { fmtDate } from '../lib/format';

// A mic on the search box. Dictation replaces what is typed rather than
// appending, because saying a search out loud is saying the whole search.
export function SearchDictate({ onText }: { onText: (t: string) => void }) {
  return <DictateButton title="Dictate a search" onText={onText} />;
}

// "Everything from Ana about the invoice last month" becomes chips the
// person can then edit. The model sees the sentence and the operator list —
// never the mailbox — which is why this capability is marked as not reading
// mail.
export function NaturalSearchButton({ text, onQuery }: { text: string; onQuery: (q: string) => void }) {
  const can = useCan('nlrules');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can) return null;

  const run = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await postWithWork<{ query: string }>('ai', '/api/assist/search-query', { text: text.trim() });
      onQuery(r.query);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <IconButton
      label="Turn this sentence into a search"
      size={14}
      className="btn-sm"
      disabled={!text.trim() || busy}
      onClick={run}
    >
      {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
    </IconButton>
  );
}

// The second list of results, under the exact ones.
export interface SemanticHit {
  emailId: number; accountId: number; threadId: string; score: number;
  subject: string; preview: string;
  from: { name: string | null; email: string } | null;
  receivedAt: string | null;
  hasAttachment: boolean;
}

export function useSemanticSearch(query: string, enabled: boolean) {
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const seq = useRef(0);

  const run = useCallback(async (q: string) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await postWithWork<{ hits: SemanticHit[]; remaining: number }>('search', '/api/discover/search', { q, limit: 20 });
      // A slower earlier search must not overwrite a faster later one.
      if (seq.current !== mine) return;
      setHits(r.hits);
      setRemaining(r.remaining);
    } catch {
      if (seq.current === mine) setHits([]);
    } finally {
      if (seq.current === mine) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 3) { setHits([]); return; }
    // Long enough that typing does not queue a generation per keystroke; the
    // proof of work would price that anyway, but making the browser burn CPU
    // on abandoned queries is rude to the person holding the phone.
    const t = window.setTimeout(() => void run(q), 450);
    return () => window.clearTimeout(t);
  }, [query, enabled, run]);

  return { hits, loading, remaining };
}

export function SemanticResults({ query }: { query: string }) {
  const can = useCan('semantic');
  const nav = useNavigate();
  const { hits, loading, remaining } = useSemanticSearch(query, can);
  if (!can || (!hits.length && !loading)) return null;

  return (
    <div className="semantic-results">
      <div className="semantic-head">
        <Telescope size={14} />
        <span>You might also mean</span>
        {loading && <Loader2 size={13} className="spin" />}
        {remaining > 0 && (
          // Being honest about an index that is still filling is the
          // difference between "this feature is bad" and "this feature is
          // not finished reading yet".
          <span className="muted small">still reading {remaining.toLocaleString()} messages</span>
        )}
      </div>
      {hits.map((h) => (
        <button
          key={h.emailId}
          type="button"
          className="semantic-hit"
          onClick={() => nav(`/mail/all/t/${h.accountId}:${h.threadId}`)}
        >
          <span className="semantic-from">{h.from?.name || h.from?.email || 'Unknown sender'}</span>
          <span className="semantic-subject">{h.subject || '(no subject)'}</span>
          <span className="semantic-preview muted">{h.preview}</span>
          <span className="semantic-when muted">{h.receivedAt ? fmtDate(h.receivedAt) : ''}</span>
        </button>
      ))}
    </div>
  );
}
