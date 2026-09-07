// Offering somebody times, from the calendar you already have.
//
// The slot finder was written, routed and then never called by anything: the
// one scheduling feature in Tern that needs no model at all — it reads the
// invitations you have accepted and subtracts them from working hours — had
// no button anywhere. This is that button.
//
// It appears in three places because "when are you free" arrives in three
// shapes: while writing a fresh email, while replying to one, and as one of
// the three quick replies offered under a message that asked. All three end
// in the same sentence going into the editor, so all three share this file.
//
// Nothing here guesses. The times are subtracted from real events, the zone
// is the browser's own, and what is inserted is exactly what was ticked.
import { useEffect, useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useCan } from '../state/features';
import { Button, IconButton, Menu, Segmented } from './ui';
import { localZone, writeSlots, type Slot } from '../lib/scheduling';

// Re-exported so the two callers that need the phrasing or the zone import
// them from the component they are using rather than from two places.
export { asksAboutTime, localZone, writeSlot, writeSlots, type Slot } from '../lib/scheduling';

const DURATIONS = [15, 30, 60] as const;
type Duration = (typeof DURATIONS)[number];

export function useFreeSlots(minutes: Duration, enabled: boolean, withEmails: string[] = []) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guests whose calendar nobody could answer for. Named rather than
  // silently treated as free: "everyone is free at three" and "you are free
  // at three and I could not check the others" are different claims.
  const [unknown, setUnknown] = useState<string[]>([]);
  // A stable key, so a caller passing a fresh array each render does not
  // re-fetch on every keystroke.
  const key = withEmails.map((e) => e.toLowerCase()).sort().join(',');

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ minutes: String(minutes), days: '14', count: '8', tz: localZone() });
    if (key) q.set('with', key);
    api.get<{ slots: Slot[]; unknown?: string[] }>(`/api/assist/invitations/slots?${q}`)
      .then((r) => { if (live) { setSlots(r.slots); setUnknown(r.unknown ?? []); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [minutes, enabled, key]);

  return { slots, loading, error, unknown };
}

// The chip that sits beside the model's three suggestions. It is the one
// suggestion in that row that is not a guess: the others are sentences the
// model thinks you might say, and this is a fact about your calendar.
export function ProposeTimesChip({ onInsert, withEmails }: { onInsert: (text: string) => void; withEmails?: string[] }) {
  const can = useCan('calendar');
  if (!can) return null;
  return (
    <Menu
      width={286}
      trigger={(open) => (
        <button type="button" className="quick-slot" onClick={open}>
          <CalendarClock size={12} /> Propose times
        </button>
      )}
    >
      {(close) => <SlotPicker onInsert={onInsert} close={close} />}
    </Menu>
  );
}

// The picker itself. Shared by the button and the quick-reply chip so the
// two never drift apart.
function SlotPicker({ onInsert, onPick, close, withEmails }: { onInsert: (text: string) => void; onPick?: (slots: Slot[]) => void; close: () => void; withEmails?: string[] }) {
  const [minutes, setMinutes] = useState<Duration>(30);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { slots, loading, error, unknown } = useFreeSlots(minutes, true, withEmails ?? []);

  // Changing the length changes the times, so a tick against the old ones
  // means nothing. Clearing is the honest response to that.
  useEffect(() => { setPicked(new Set()); }, [minutes]);

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const chosen = slots.filter((s) => picked.has(s.startsAt));

  return (
    <div className="slots">
      <div className="slots-head">
        <span className="slots-title">How long?</span>
        <Segmented
          value={String(minutes) as `${Duration}`}
          onChange={(v) => setMinutes(Number(v) as Duration)}
          options={DURATIONS.map((d) => ({ value: String(d) as `${Duration}`, label: d === 60 ? '1 hr' : `${d} min` }))}
        />
      </div>

      {loading && <div className="slots-note"><Loader2 size={13} className="spin" /> Reading {withEmails?.length ? 'the calendars' : 'your calendar'}</div>}
      {!loading && unknown.length > 0 && (
        // Said plainly rather than left to be assumed. A time that avoids
        // your diary and nobody else's is a proposal, not an agreement.
        <div className="slots-note">
          Checked your calendar only — nothing here could say when {unknown.length === 1 ? unknown[0] : `${unknown.length} of the guests`}{' '}
          {unknown.length === 1 ? 'is' : 'are'} busy.
        </div>
      )}
      {error && <div className="slots-note slots-error">{error}</div>}
      {!loading && !error && !slots.length && (
        // The two reasons this list is empty are opposite problems, and
        // saying "no free slots" for the first one would be a lie.
        <div className="slots-note">
          Nothing free in the next fortnight — or no invitations have been read yet, which is
          the more likely of the two if your calendar is not busy.
        </div>
      )}

      {slots.length > 0 && (
        <div className="slots-list">
          {slots.map((s) => {
            const on = picked.has(s.startsAt);
            return (
              <button
                key={s.startsAt}
                type="button"
                className={on ? 'slot on' : 'slot'}
                aria-pressed={on}
                onClick={() => toggle(s.startsAt)}
              >
                <span className="slot-day">{new Date(s.startsAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                <span className="slot-time">
                  {new Date(s.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="slots-foot">
        <Button
          size="sm"
          variant="primary"
          disabled={!chosen.length}
          onClick={() => { onInsert(writeSlots(chosen)); onPick?.(chosen); close(); }}
        >
          {chosen.length ? `Insert ${chosen.length === 1 ? 'this time' : `these ${chosen.length} times`}` : 'Pick some times'}
        </Button>
      </div>
    </div>
  );
}

// The composer and reply-bar button. Silent for anyone who has not turned
// invitations on, like everything else that reads mail for a purpose.
export function ProposeTimesButton({ onInsert, onPick, compact, label = 'Propose times', withEmails }: {
  onInsert: (text: string) => void;
  /** The slots themselves, for a caller that needs the instant and not the prose. */
  onPick?: (slots: Slot[]) => void;
  compact?: boolean;
  label?: string;
  /** Who the message is going to, so their diaries count as well. */
  withEmails?: string[];
}) {
  const can = useCan('calendar');
  if (!can) return null;
  return (
    <Menu
      width={286}
      trigger={(open) => compact
        ? <IconButton label={label} onClick={open}><CalendarClock size={17} /></IconButton>
        : <Button size="sm" icon={<CalendarClock size={14} />} onClick={open}>{label}</Button>}
    >
      {(close) => <SlotPicker onInsert={onInsert} onPick={onPick} close={close} withEmails={withEmails} />}
    </Menu>
  );
}
