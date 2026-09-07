// An invitation found in a message (F10).
//
// The card answers the three questions somebody reading an invitation in
// their inbox actually has: when is it in my own time, does it collide with
// something else, and can I answer it without leaving this page. It does not
// try to be a calendar — there is no month grid, no drag to reschedule, and
// recurrence is a sentence rather than a series.
//
// Accepting or declining records the answer and opens a reply with the
// proper `METHOD:REPLY` attached, so it goes out through the ordinary send
// path with the account's own pacing and signature rather than through some
// side channel that bypasses both.
import { useEffect, useState } from 'react';
import { CalendarClock, Check, HelpCircle, MapPin, Users, X } from 'lucide-react';
import { api } from '../api';
import { useCan } from '../state/features';
import { Badge, Button } from './ui';
import { useToast } from '../state/toast';

interface Invitation {
  id: number;
  summary: string | null;
  location: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; partstat: string | null }[];
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  method: string;
  reply: 'accepted' | 'declined' | 'tentative' | null;
  clashes: { id: number; summary: string | null; startsAt: string | null }[];
}

// Times are formatted in the reader's own zone, always, with the day named.
// An invitation showing a time that is not the reader's is the single most
// expensive mistake a calendar feature can make.
function when(inv: Invitation): string {
  if (!inv.startsAt) return 'No time given';
  const start = new Date(inv.startsAt);
  if (inv.allDay) return start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const end = inv.endsAt ? new Date(inv.endsAt) : null;
  const day = start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const from = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const to = end ? end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  return `${day}, ${from}${to ? `–${to}` : ''}`;
}

export function InvitationCard({ emailId, accountId }: { emailId: number; accountId: number }) {
  const can = useCan('calendar');
  const toast = useToast();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!can || !emailId) { setInvitations([]); return; }
    let live = true;
    api.get<{ invitations: Invitation[] }>(`/api/assist/invitations/message/${emailId}`)
      .then((r) => { if (live) setInvitations(r.invitations); })
      .catch(() => { if (live) setInvitations([]); });
    return () => { live = false; };
  }, [can, emailId]);

  if (!invitations.length) return null;

  const answer = async (inv: Invitation, reply: 'accepted' | 'declined' | 'tentative') => {
    setBusy(inv.id);
    try {
      const r = await api.post<{ invitation: Invitation }>(`/api/assist/invitations/${inv.id}/reply`, { reply });
      setInvitations((prev) => prev.map((i) => (i.id === inv.id ? r.invitation : i)));
      toast.success(reply === 'accepted' ? 'Accepted' : reply === 'declined' ? 'Declined' : 'Marked as maybe');
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  return (
    <>
      {invitations.map((inv) => (
        <div key={inv.id} className="invite-card">
          <div className="invite-head">
            <CalendarClock size={16} />
            <strong>{inv.summary ?? 'Invitation'}</strong>
            {inv.reply && (
              <Badge kind={inv.reply === 'accepted' ? 'success' : inv.reply === 'declined' ? 'danger' : undefined}>
                {inv.reply === 'accepted' ? 'You accepted' : inv.reply === 'declined' ? 'You declined' : 'You said maybe'}
              </Badge>
            )}
          </div>
          <div className="invite-when">{when(inv)}</div>
          <div className="invite-meta muted small">
            {inv.location && <span><MapPin size={12} /> {inv.location}</span>}
            {inv.organizer && <span>From {inv.organizer.name || inv.organizer.email}</span>}
            {inv.attendees.length > 0 && <span><Users size={12} /> {inv.attendees.length} invited</span>}
          </div>
          {inv.clashes.length > 0 && (
            // The one piece of real work the card does beyond displaying:
            // saying that this time is already taken, before it is accepted.
            <div className="invite-clash small">
              Clashes with {inv.clashes.map((c) => c.summary ?? 'another invitation').join(', ')}.
            </div>
          )}
          <div className="invite-actions">
            <Button size="sm" variant={inv.reply === 'accepted' ? 'primary' : 'default'} icon={<Check size={14} />} loading={busy === inv.id} onClick={() => answer(inv, 'accepted')}>Yes</Button>
            <Button size="sm" variant={inv.reply === 'tentative' ? 'primary' : 'default'} icon={<HelpCircle size={14} />} loading={busy === inv.id} onClick={() => answer(inv, 'tentative')}>Maybe</Button>
            <Button size="sm" variant={inv.reply === 'declined' ? 'primary' : 'default'} icon={<X size={14} />} loading={busy === inv.id} onClick={() => answer(inv, 'declined')}>No</Button>
          </div>
        </div>
      ))}
    </>
  );
}
