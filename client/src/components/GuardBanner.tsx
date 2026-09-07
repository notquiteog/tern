// The impersonation guard's one line (F3).
//
// One banner, never stacked, and only for the flags that mean something.
// The temptation with a feature like this is to show every signal it has —
// a row of little badges, one per check — and the result is that people
// learn to scroll past all of them. So: the worst flag, phrased as a
// sentence about this specific sender, or nothing at all.
//
// "First contact" is deliberately not a warning. Meeting somebody new is
// what an inbox is for. It appears as a quiet label beside the sender, and
// only when nothing more serious is there to say.
import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldAlert, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useCan } from '../state/features';

interface GuardResult {
  flags: string[];
  detail: { expected?: string; actual?: string; name?: string; seen?: number };
  message: string | null;
  firstContact: boolean;
}

// The two that mean "somebody may be pretending to be someone you know" get
// the stronger treatment; the rest are a note.
const SERIOUS = new Set(['thread_sender_changed', 'lookalike_domain', 'display_name_mismatch']);

export function GuardBanner({ emailId }: { emailId: number | null | undefined }) {
  const can = useCan('guard');
  const [result, setResult] = useState<GuardResult | null>(null);

  useEffect(() => {
    if (!can || !emailId) { setResult(null); return; }
    let live = true;
    api.get<GuardResult>(`/api/discover/guard/${emailId}`)
      .then((r) => { if (live) setResult(r); })
      .catch(() => { if (live) setResult(null); });
    return () => { live = false; };
  }, [can, emailId]);

  if (!result) return null;

  if (result.message) {
    const serious = result.flags.some((f) => SERIOUS.has(f));
    return (
      <div className={`guard-banner${serious ? ' guard-banner-serious' : ''}`} role="note">
        {serious ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
        <div>
          <div className="guard-message">{result.message}</div>
          {serious && (
            <div className="guard-advice muted small">
              If this is about money or credentials, check with the sender some other way before you
              reply — a phone number you already had, not one in this message.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (result.firstContact) {
    return (
      <div className="guard-note muted small">
        <UserPlus size={13} /> First message from this address.
      </div>
    );
  }

  return null;
}
