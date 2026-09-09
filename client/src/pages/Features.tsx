// Settings → Features. The one page where somebody decides what may read
// their mail and what may reach the model.
//
// Three things this page has to do that an ordinary settings page does not.
//
// It has to be honest about what each switch does before it is flipped, not
// after — hence the sentence under every label saying what is read and what
// is kept, and the marks for "reads your mail" and "uses the model", which
// are the two facts most people are actually deciding about.
//
// It has to be honest about turning one off. Withdrawing consent destroys
// what the capability produced, so the confirmation says what will go and
// how much of it there is, and the result says how much went.
//
// And it has to distinguish "you have not turned this on" from "an
// administrator has turned it off here", because those look identical from
// the outside and have completely different fixes.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Brain, Eye, EyeOff, Gauge, Loader2, Lock, ShieldAlert } from 'lucide-react';
import { useFeatures, type CapabilityInfo } from '../state/features';
import { Badge, Button, Callout, Confirm, PageHeader, Spinner, Toggle } from '../components/ui';
import { useToast } from '../state/toast';

// The order the switches appear in: what most people want first, then the
// heavier ones, then the two that are only about the composer.
const ORDER: string[] = [
  'guard', 'links', 'triage', 'semantic', 'attachments',
  'brief', 'commitments', 'calendar', 'nlrules', 'voice', 'import',
  'ai.compose', 'ai.summaries', 'ai.media', 'ai.responders', 'ai.campaigns', 'ai.playground',
];

export default function FeaturesPage() {
  const { capabilities, loading, grant, revoke } = useFeatures();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CapabilityInfo | null>(null);

  if (loading) return <div className="center pad-24"><Spinner /></div>;

  const sorted = [...capabilities].sort((a, b) => {
    const ai = ORDER.indexOf(a.id), bi = ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const on = sorted.filter((c) => c.granted).length;

  const turnOn = async (c: CapabilityInfo) => {
    setBusy(c.id);
    try { await grant(c.id as any); toast.success(`${c.label} is on`); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };

  const turnOff = async (c: CapabilityInfo) => {
    setBusy(c.id);
    try {
      const { erased } = await revoke(c.id as any);
      toast.success(erased ? `${c.label} is off — ${erased.toLocaleString()} ${erased === 1 ? 'row' : 'rows'} erased` : `${c.label} is off`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); setConfirming(null); }
  };

  return (
    <div className="stack-20">
      <PageHeader
        title="Features"
        sub={`Nothing here is on until you turn it on. ${on} of ${sorted.length} are on.`}
      />

      <Callout kind="info">
        Everything in this list runs on this server. Nothing is sent anywhere else, and turning
        something off erases what it made — it is not a pause.
      </Callout>

      <div className="stack-12">
        {sorted.map((c) => (
          <FeatureRow
            key={c.id}
            cap={c}
            busy={busy === c.id}
            onToggle={(next) => {
              if (!next && c.erases && c.holds > 0) setConfirming(c);
              else if (next) void turnOn(c);
              else void turnOff(c);
            }}
          />
        ))}
      </div>

      <Confirm
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={async () => { if (confirming) await turnOff(confirming); }}
        title={`Turn off ${confirming?.label ?? ''}?`}
        danger
        confirmLabel="Turn off and erase"
        message={
          <>
            This erases {confirming?.erases}
            {confirming && confirming.holds > 0 ? ` — ${confirming.holds.toLocaleString()} ${confirming.holds === 1 ? 'row' : 'rows'} right now` : ''}.
            {' '}Turning it back on later starts again from nothing.
          </>
        }
      />
    </div>
  );
}

function FeatureRow({ cap, busy, onToggle }: { cap: CapabilityInfo; busy: boolean; onToggle: (next: boolean) => void }) {
  return (
    <div className={`card feature-row${cap.available ? '' : ' feature-row-blocked'}`}>
      <div className="feature-main">
        <div className="feature-head">
          <strong>{cap.label}</strong>
          {/* The reassuring half is worth saying out loud, and it is worth
              saying about the cheap deterministic features most of all —
              those are the ones somebody is most likely to want and least
              likely to know are safe. */}
          {cap.readsMail
            ? <Badge kind="warning"><Eye size={11} /> Reads your mail</Badge>
            : <Badge kind="info"><EyeOff size={11} /> Does not read your mail</Badge>}
          {cap.usesAi && <Badge kind="accent"><Brain size={11} /> Uses the model</Badge>}
          {cap.heavy && <Badge><Gauge size={11} /> Uses real CPU</Badge>}
          {cap.adminOnly && <Badge><Lock size={11} /> Admin</Badge>}
        </div>
        <p className="muted small feature-what">{cap.what}</p>
        {cap.granted && cap.holds > 0 && (
          <p className="muted small">
            Holding {cap.holds.toLocaleString()} {cap.holds === 1 ? 'row' : 'rows'}
            {cap.erases ? ` — turning this off erases ${cap.erases}` : ''}.
          </p>
        )}
        {!cap.available && (
          // Deliberately different wording from "you have not turned this on":
          // there is nothing this person can do about it, and saying so saves
          // them looking for the switch that would fix it.
          <p className="small feature-blocked">
            <ShieldAlert size={13} /> An administrator has turned this off for this server.
          </p>
        )}
      </div>
      <div className="feature-switch">
        {busy ? <Loader2 size={18} className="spin" /> : (
          <Toggle
            checked={cap.granted}
            disabled={!cap.available && !cap.granted}
            onChange={onToggle}
            label={cap.label}
          />
        )}
      </div>
    </div>
  );
}

// A small block any page can drop in where a feature would have been. It is
// the reason no control is ever shown for something that is off: instead of
// a button that fails, the space says what would go there and where to turn
// it on.
export function FeatureOffNotice({ cap, children }: { cap: CapabilityInfo | undefined; children?: React.ReactNode }) {
  if (!cap) return null;
  return (
    <div className="feature-off">
      <p className="muted small">{children ?? cap.what}</p>
      {cap.available ? (
        <Link className="btn btn-sm" to="/settings/features">Turn on {cap.label}</Link>
      ) : (
        <p className="small feature-blocked"><ShieldAlert size={13} /> An administrator has turned this off for this server.</p>
      )}
    </div>
  );
}
