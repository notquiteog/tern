// Moving a commitment, and the email that says so.
//
// The ledger could record two things about a promise: that it was kept, and
// that it was never a promise. It had no way to record the thing that
// actually happens, which is that it is going to be late — and no way to
// write the email that has to go with that, which is the reason people leave
// the promise sitting there instead.
//
// So one panel, two directions, chosen by which column the row is in:
//
//   owed → Reschedule. You say why in a line, name a new date, and the model
//   writes the email into the conversation the promise came from. It is given
//   the promise out of the ledger rather than off the wire, so it apologises
//   for the thing that was actually recorded.
//
//   awaiting → Nudge. The same panel, a different email: what you are waiting
//   for, asked for again without reciting how late it is.
//
// Two rules the whole thing turns on.
//
// It never sends. The draft is handed to the composer, exactly as an
// invitation reply is, so it leaves under the same signature, the same
// encryption, the same undo window and the same pacing as anything else you
// write. A page that could send mail on its own would be the only one in
// Tern that can.
//
// And it moves the goalposts before handing over, because an "owed" item
// settles itself the moment anything of yours lands in the thread. Without
// that, sending "the quote will be Thursday instead" would mark the quote as
// delivered — the ledger would record the opposite of what happened.
import { useState } from 'react';
import { CalendarClock, Loader2, PenLine, Send, Timer, X } from 'lucide-react';
import { api } from '../api';
import { streamWithWork } from '../lib/work';
import { useCompose } from '../state/compose';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';
import { replyRecipients, replySubject } from '../lib/reply';
import { Button, Field, Input, Textarea } from './ui';
import { AiThinking, useAiThinking } from './AiThinking';
import { DictateBox, appendDictated } from './Dictate';
import { useMailPrefs } from '../state/mailPrefs';
import { ProposeTimesButton, localZone } from './ProposeTimes';

export interface MovableCommitment {
  id: number;
  kind: 'owed' | 'awaiting';
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  threadId: string;
  accountId: number;
}

// The quick dates. Not a calendar widget: a reschedule is nearly always "a
// few days later", and making that three clicks in a date picker is how the
// panel ends up unused.
function quickDates(): { label: string; at: Date }[] {
  const at = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(12, 0, 0, 0);
    return d;
  };
  const monday = () => {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(12, 0, 0, 0);
    return d;
  };
  return [
    { label: 'Tomorrow', at: at(1) },
    { label: 'In 3 days', at: at(3) },
    { label: 'Next week', at: monday() },
  ];
}

const dateValue = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function CommitmentMove({ c, onClose, onMoved }: {
  c: MovableCommitment;
  onClose: () => void;
  /** The ledger changed: the page reloads its rows. */
  onMoved: () => void;
}) {
  const compose = useCompose();
  const toast = useToast();
  const canCalendar = useCan('calendar');
  const thinking = useAiThinking();
  const [prefs] = useMailPrefs();

  const reschedule = c.kind === 'owed';
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  // Times offered in the body, when this is a commitment about meeting.
  const [times, setTimes] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrote, setWrote] = useState(false);

  // Midday rather than midnight: a date with no time means "that day", and
  // midnight reads as the start of it in one direction and the end of it in
  // the other depending on the zone it is rendered in.
  const dueAt = date ? new Date(`${date}T12:00:00`).toISOString() : null;

  // Same reason as the AI panel: a dictation that fires this passes what it
  // heard, because the state it just set is a render away.
  async function write(saidReason?: string) {
    const said = saidReason ?? reason;
    setBusy(true);
    setDraft('');
    setWrote(false);
    thinking.reset();
    let full = '';
    try {
      await streamWithWork('ai', '/api/ai/draft', {
        mode: reschedule ? 'reschedule' : 'nudge',
        commitmentId: c.id,
        accountId: c.accountId,
        threadKey: c.threadId ? `${c.accountId}:${c.threadId}` : null,
        reason: [said.trim(), times && `Offer these times: ${times}`].filter(Boolean).join('\n') || undefined,
        dueAt,
        tz: localZone(),
      }, {
        onEvent: (ev, d) => {
          if (thinking.onEvent(ev, d)) return;
          if (ev === 'token') { full += d.t; setDraft(full); }
          if (ev === 'done') { setDraft(d.text); setWrote(true); }
          if (ev === 'error') toast.error(d.error);
        },
      });
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  // Into the composer, as a reply in the conversation it came from. The
  // ledger moves first: if the hand-off works the promise has been moved, and
  // if the composer is closed without sending, a date that has moved is still
  // truer than one that has not.
  async function handOff() {
    setBusy(true);
    try {
      if (dueAt !== null || reschedule) {
        await api.post(`/api/assist/commitments/${c.id}/move`, dueAt ? { dueAt } : {});
      }
      const seed = await replySeed(c);
      compose.open({ ...seed, initialText: draft });
      toast.success(reschedule
        ? (dueAt ? 'Moved, and the email is in the composer' : 'Marked as moved; the email is in the composer')
        : 'The nudge is in the composer');
      onMoved();
      onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <div className="commit-move">
      <div className="commit-move-head">
        {reschedule ? <PenLine size={13} /> : <Timer size={13} />}
        <span>{reschedule ? 'Tell them it has moved' : 'Ask again'}</span>
        <button type="button" className="commit-move-close" onClick={onClose} title="Cancel"><X size={14} /></button>
      </div>

      <Field label={reschedule ? 'Why has it slipped?' : 'Anything to add?'} hint={reschedule
        ? 'One line, in your words. It goes into the email as the reason, so say the true thing rather than the polite one.'
        : 'Optional. Context the model should use — a deadline it is holding up, say.'}>
        <DictateBox
          title={reschedule ? 'Say why it slipped' : 'Say what to add'}
          onText={(t) => {
            const said = appendDictated(reason, t);
            setReason(said);
            if (prefs.dictateAutoRun) void write(said);
          }}
        >
          <Textarea
            autoFocus
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reschedule ? 'The pricing review slipped to next week' : 'We need it before the board meeting'}
            style={{ minHeight: 56 }}
          />
        </DictateBox>
      </Field>

      <Field
        label={reschedule ? 'New date' : 'Needed by'}
        hint={reschedule ? 'Optional. Without one the email says you will come back with a date rather than inventing one.' : 'Optional.'}
      >
        <div className="commit-move-dates">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {quickDates().map((q) => (
            <button
              key={q.label}
              type="button"
              className={date === dateValue(q.at) ? 'commit-date on' : 'commit-date'}
              onClick={() => setDate(date === dateValue(q.at) ? '' : dateValue(q.at))}
            >
              {q.label}
            </button>
          ))}
          {/* A commitment about meeting somebody has a new date that is a
              slot in the calendar, not a day. Picking one sets both: the
              date the ledger records, and the times the email offers. */}
          {canCalendar && (
            <ProposeTimesButton
              label="Free times"
              onInsert={setTimes}
              onPick={(slots) => {
                // The earliest slot offered becomes the date the ledger
                // records: it is the soonest this could now happen, which is
                // the honest thing for the ledger to hold while the other
                // person decides between them.
                const first = slots.map((s) => new Date(s.startsAt)).sort((a, b) => a.getTime() - b.getTime())[0];
                if (first) setDate(dateValue(first));
              }}
            />
          )}
        </div>
      </Field>

      {times && (
        <div className="commit-move-times">
          <CalendarClock size={13} />
          <span className="small">These times go into the email.</span>
          <button type="button" className="link-btn small ml-auto" onClick={() => setTimes('')}>Remove</button>
        </div>
      )}

      <AiThinking trace={thinking} busy={busy && !draft} />

      {draft && (
        <div className="commit-move-draft">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} style={{ minHeight: 132 }} />
          <p className="help-text">
            Edit it here or in the composer. Nothing is sent from this page — it opens as a reply in the
            conversation, with your signature and encryption, and goes out the way anything you write does.
          </p>
        </div>
      )}

      <div className="commit-move-acts">
        {!wrote
          ? <Button size="sm" variant="ai" icon={busy ? <Loader2 size={14} className="spin" /> : <PenLine size={14} />} disabled={busy} onClick={() => void write()}>
              {draft ? 'Writing…' : reschedule ? 'Write the email' : 'Write the nudge'}
            </Button>
          : <>
              <Button size="sm" variant="primary" icon={<Send size={14} />} loading={busy} onClick={() => void handOff()}>Open in composer</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void write()}>Rewrite</Button>
            </>}
      </div>
    </div>
  );
}

// The conversation the promise came from, turned into a reply. Read at
// hand-off rather than when the panel opens: most panels are opened and
// closed again, and this is a whole thread's worth of decryption.
async function replySeed(c: MovableCommitment) {
  const base = {
    accountId: c.accountId,
    threadKey: c.threadId ? `${c.accountId}:${c.threadId}` : null,
    kind: 'reply' as const,
  };
  // No thread — a commitment somebody typed in by hand. The best that can be
  // done is address it, and only if the counterparty is an address.
  if (!c.threadId) {
    const email = c.counterparty && c.counterparty.includes('@') ? c.counterparty.trim() : null;
    return { ...base, kind: 'new' as const, threadKey: null, to: email ? [{ email }] : [] };
  }
  const data = await api.get<any>(`/api/mail/threads/${c.accountId}/${encodeURIComponent(c.threadId)}`);
  const me: string = data?.account?.email ?? '';
  const messages: any[] = data?.messages ?? [];
  // Reply to the last message that was not ours: that is the person owed an
  // explanation, and replying to our own last message addresses nobody.
  const target = [...messages].reverse().find((m) => m.from_email && m.from_email !== me) ?? messages[messages.length - 1];
  if (!target) return { ...base, to: [] };
  const { to } = replyRecipients(
    { from: target.from_addr, replyTo: target.reply_to, to: target.to_addr, cc: target.cc_addr },
    me,
  );
  return {
    ...base,
    to,
    subject: replySubject(target.subject),
    replyToEmailId: target.id ?? null,
    contactId: data?.contact?.id ?? null,
  };
}
