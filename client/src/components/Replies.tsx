// The Replies tab: what came back from a campaign, grouped by what it said.
//
// The classifier has been labelling every answered send since it shipped and
// nothing has ever shown the label. This is the page somebody running a
// campaign actually opens — not "how many replied", which the card already
// says, but "which of them said yes", which nothing said at all.
//
// ── Why it is a queue ───────────────────────────────────────────────────────
//
// Every row ends in one button that does the obvious thing for its intent, and
// then the row leaves. Counts are of what is outstanding, so "3 interested"
// stops being true once the three have been answered. A list that only ever
// grew would be read once and never again.
//
// ── Why no row sends anything ───────────────────────────────────────────────
//
// The buttons open a composer, create a contact, or date an enrollment
// forward. None of them puts mail in the outbox. The address in a "wrong
// person" reply was read out of a sentence by a regular expression, and the
// difference between offering it on a card and acting on it is the difference
// between a useful guess and mail sent to somebody nobody chose.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, HelpCircle, Inbox, MailQuestion, ThumbsDown, ThumbsUp, UserPlus, Users } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { Avatar, Badge, Button, Empty, Input, Spinner } from '../components/ui';
import { fmtRelative, plural } from '../lib/format';

export type ReplyIntent = 'stop' | 'auto_reply' | 'interested' | 'question' | 'not_now' | 'not_interested' | 'wrong_person' | 'unclear';

interface Referral { email: string; name: string; first_name: string; last_name: string; quote: string }
interface ReplyAction {
  kind: 'reply' | 'referral' | 'reenroll' | 'open' | 'none';
  label: string; aiReply?: boolean; proposeTimes?: boolean; fromBrief?: boolean;
  referrals?: Referral[]; reenrollDays?: number;
}
export interface CampaignReply {
  logId: number; sequenceId: number | null; sequenceName: string; stepId: number | null; stepPosition: number | null;
  accountId: number;
  contact: { id: number; email: string; first_name: string; last_name: string; company: string; title: string } | null;
  intent: ReplyIntent; repliedAt: string; handledAt: string | null;
  threadKey: string | null; subject: string; preview: string; action: ReplyAction;
}
type Counts = Record<ReplyIntent, number> & { total: number };

// The order they are shown in, which is the order they are worth reading in.
// `interested` first is the whole argument for classifying replies at all.
const ORDER: ReplyIntent[] = ['interested', 'question', 'wrong_person', 'not_now', 'unclear', 'not_interested', 'stop', 'auto_reply'];

const LABEL: Record<ReplyIntent, string> = {
  interested: 'Interested', question: 'Questions', wrong_person: 'Wrong person', not_now: 'Not now',
  unclear: 'Unclear', not_interested: 'Not interested', stop: 'Unsubscribed', auto_reply: 'Auto-replies',
};
const ICON: Record<ReplyIntent, any> = {
  interested: ThumbsUp, question: HelpCircle, wrong_person: Users, not_now: Clock,
  unclear: MailQuestion, not_interested: ThumbsDown, stop: ThumbsDown, auto_reply: Inbox,
};
const TONE: Partial<Record<ReplyIntent, 'success' | 'info' | 'warning' | 'danger'>> = {
  interested: 'success', question: 'info', wrong_person: 'warning', not_now: 'info',
};

export function Replies({ sequenceId }: { sequenceId?: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [intent, setIntent] = useState<ReplyIntent | ''>('');
  const [handled, setHandled] = useState(false);
  const key = ['replies', sequenceId ?? 'all', intent, handled];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => {
      const p = new URLSearchParams();
      if (sequenceId) p.set('sequenceId', String(sequenceId));
      if (intent) p.set('intent', intent);
      if (handled) p.set('handled', '1');
      return api.get<{ replies: CampaignReply[]; counts: Counts }>(`/api/replies?${p}`);
    },
    // A reply arrives on the sync worker's clock, not on anything this page
    // does, so it is asked again rather than waited for.
    refetchInterval: 60_000,
  });
  const counts = data?.counts;
  const replies = data?.replies ?? [];

  // Everything that changes a row changes the counts too, and the counts are
  // in the shell's own badge as well as on this page.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['replies'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
    qc.invalidateQueries({ queryKey: ['sequences'] });
  };

  async function markHandled(r: CampaignReply, done: boolean) {
    try {
      await api.post(`/api/replies/${r.logId}/handled`, { handled: done });
      refresh();
    } catch (e) { toast.error(e); }
  }

  if (isLoading) return <div className="center" style={{ padding: 40 }}><Spinner /></div>;

  const shown = ORDER.filter((i) => (counts?.[i] ?? 0) > 0 || i === intent);
  return (
    <div>
      <div className="row gap-4 wrap mb-16">
        <button type="button" className={`chip${intent === '' ? ' active' : ''}`} onClick={() => setIntent('')}>
          All{counts?.total ? ` · ${counts.total}` : ''}
        </button>
        {shown.map((i) => {
          const I = ICON[i];
          return (
            <button key={i} type="button" className={`chip${intent === i ? ' active' : ''}`} onClick={() => setIntent(i)}>
              <I size={13} /> {LABEL[i]}{counts?.[i] ? ` · ${counts[i]}` : ''}
            </button>
          );
        })}
        <div style={{ marginLeft: 'auto' }}>
          <Button size="sm" variant={handled ? 'primary' : 'ghost'} onClick={() => setHandled((h) => !h)}>
            {handled ? 'Showing dealt with' : 'Show dealt with'}
          </Button>
        </div>
      </div>

      {!replies.length && (
        <Empty icon={<Inbox size={24} />} title={handled ? 'Nothing dealt with yet' : 'No replies waiting'}>
          {handled
            ? 'Replies you have acted on show up here.'
            : 'When somebody answers a campaign, Tern works out what they said — interested, a question, the wrong person, not now — and puts it here with the next thing to do about it.'}
        </Empty>
      )}

      <div className="reply-list">
        {replies.map((r) => (
          <ReplyRow key={r.logId} r={r} showCampaign={!sequenceId} onHandled={markHandled} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function ReplyRow({ r, showCampaign, onHandled, onChanged }: {
  r: CampaignReply; showCampaign: boolean;
  onHandled: (r: CampaignReply, done: boolean) => void; onChanged: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const name = [r.contact?.first_name, r.contact?.last_name].filter(Boolean).join(' ') || r.contact?.email || 'Someone';
  const I = ICON[r.intent];

  // Where a reply is answered: its own thread, in the mail app, with the
  // composer already open. `ai` asks for the draft and `times` forces the
  // slots chip — on the intent, not on the message happening to mention a
  // date, because somebody who says "yes, let's talk" wants a time whether or
  // not they thought to ask for one.
  function openThread(action?: ReplyAction) {
    if (!r.threadKey) { toast.error('That conversation is no longer in the mailbox'); return; }
    const p = new URLSearchParams({ reply: '1' });
    if (action?.aiReply) p.set('ai', '1');
    if (action?.proposeTimes) p.set('times', '1');
    // The reply is answering a campaign, so the draft should sound like it.
    if (r.sequenceId) p.set('campaign', String(r.sequenceId));
    onHandled(r, true);
    nav(`/mail/inbox/t/${encodeURIComponent(r.threadKey)}?${p}`);
  }

  async function reenroll() {
    setBusy(true);
    try {
      const out = await api.post<{ at: string }>(`/api/replies/${r.logId}/reenroll`, {});
      toast.success(`${name} goes back into ${r.sequenceName} on ${new Date(out.at).toLocaleDateString()}`);
      onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <div className={`reply-row${r.handledAt ? ' handled' : ''}`}>
      <Avatar name={name} email={r.contact?.email} size="md" />
      <div className="reply-main">
        <div className="row gap-4 wrap" style={{ alignItems: 'baseline' }}>
          <span className="strong">{name}</span>
          <Badge kind={TONE[r.intent]}><I size={11} /> {LABEL[r.intent]}</Badge>
          {showCampaign && <span className="small faint">{r.sequenceName}</span>}
          <span className="small faint" style={{ marginLeft: 'auto' }}>{fmtRelative(r.repliedAt)}</span>
        </div>
        <div className="small clamp-2">{r.subject}</div>
        {r.preview && <div className="small muted clamp-2">{r.preview}</div>}

        {referralOpen && r.action.referrals?.length
          ? <ReferralCard r={r} onDone={() => { setReferralOpen(false); onChanged(); }} onCancel={() => setReferralOpen(false)} />
          : (
            <div className="row gap-4 wrap mt-8">
              {r.action.kind === 'reply' && <Button size="sm" variant="primary" onClick={() => openThread(r.action)}>{r.action.label}</Button>}
              {r.action.kind === 'referral' && <Button size="sm" variant="primary" icon={<UserPlus size={13} />} onClick={() => setReferralOpen(true)}>{r.action.label}</Button>}
              {r.action.kind === 'reenroll' && <Button size="sm" variant="primary" loading={busy} onClick={reenroll}>{r.action.label}</Button>}
              {(r.action.kind === 'open' || r.action.kind === 'referral') && <Button size="sm" onClick={() => openThread()}>Open</Button>}
              {r.action.kind === 'none' && <span className="small faint">{r.action.label}</span>}
              {r.handledAt
                ? <Button size="sm" variant="ghost" onClick={() => onHandled(r, false)}>Put back</Button>
                : <Button size="sm" variant="ghost" icon={<Check size={13} />} onClick={() => onHandled(r, true)}>Done</Button>}
            </div>
          )}
      </div>
    </div>
  );
}

/**
 * The person a "wrong person" reply named, as a card that can be corrected.
 *
 * The fields are editable and start filled in from the parse, which is the
 * whole point: a regular expression read "try Priya, priya@westmere.example"
 * out of a sentence and is right often enough to save the typing and wrong
 * often enough that it must never be the last word.
 */
function ReferralCard({ r, onDone, onCancel }: { r: CampaignReply; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const first = r.action.referrals![0]!;
  const [email, setEmail] = useState(first.email);
  const [firstName, setFirstName] = useState(first.first_name);
  const [lastName, setLastName] = useState(first.last_name);
  const [busy, setBusy] = useState(false);

  async function save(enroll: boolean) {
    setBusy(true);
    try {
      const out = await api.post<{ created: boolean; enrolled: boolean }>(`/api/replies/${r.logId}/referral`, {
        email, first_name: firstName, last_name: lastName, enroll,
      });
      toast.success(out.enrolled ? `Added and enrolled in ${r.sequenceName}` : out.created ? 'Added to contacts' : 'Already a contact');
      onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <div className="referral-card mt-8">
      {/* The sentence it was read from. Somebody checking a guess should not
          have to open the message to see what it was guessing from. */}
      <div className="small muted mb-8">“{first.quote}”</div>
      <div className="row gap-4 wrap">
        <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" style={{ maxWidth: 140 }} />
        <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" style={{ maxWidth: 140 }} />
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.example" type="email" style={{ minWidth: 220, flex: 1 }} />
      </div>
      <div className="row gap-4 mt-8">
        <Button size="sm" variant="primary" loading={busy} disabled={!email.includes('@')} onClick={() => void save(true)}>Add and enroll</Button>
        <Button size="sm" loading={busy} disabled={!email.includes('@')} onClick={() => void save(false)}>Add only</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      {r.action.referrals!.length > 1 && (
        <div className="small faint mt-8">They named {plural(r.action.referrals!.length, 'person', 'people')}; this is the first.</div>
      )}
    </div>
  );
}
