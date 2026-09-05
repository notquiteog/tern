import { ShieldCheck } from 'lucide-react';
import { fmtHashes, type PowProgress } from '../lib/pow';

// Shown under the submit button while the browser solves the sign-in
// challenge. The bar is an estimate: the expected number of hashes for the
// difficulty, capped so it never reads as finished before it is.
export function PowStatus({ progress }: { progress: PowProgress | null }) {
  if (!progress) return null;
  const pct = Math.min(96, Math.round((100 * progress.hashes) / Math.max(1, progress.expected)));
  return (
    <div className="pow-status" role="status" aria-live="polite">
      <div className="row small"><ShieldCheck size={14} /><span>Checking your browser…</span><span className="ml-auto faint">{fmtHashes(progress.hashes)} hashes</span></div>
      <div className="progress mt-8"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function PowFootnote() {
  return <p className="help-text mt-8 pow-foot"><ShieldCheck size={12} /> Protected by a proof-of-work check instead of a CAPTCHA. Nothing is tracked.</p>;
}
