// The assistant, as a dock beside whatever you are doing.
//
// ── Why a dock and not a page ───────────────────────────────────────────────
//
// Because almost every useful question is about something already on screen.
// "Summarise this", "who is this from", "reply saying I can do Thursday" are
// all questions whose subject is the conversation behind the panel, and a
// full-page assistant would make the person leave the thing they are asking
// about in order to ask about it. The panel sits alongside; the thread stays
// visible; the draft it proposes opens in a composer over the top.
//
// ── Proposals, and why nothing here sends ───────────────────────────────────
//
// The model can write an email and draw a picture. It cannot send or attach
// either — see `ai/tools.ts`. What comes back is a card with the person's own
// button on it, and pressing that button is an ordinary compose action that
// goes through the ordinary send path with the ordinary rules, pacing and
// signature. That is the difference between an assistant and something that
// mails your contacts on a model's say-so.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Bot, CalendarPlus, Check, ChevronLeft, ClipboardCheck, ImagePlus, Layers,
  ListFilter, Loader2, Mail, MessageSquare, Mic, Plus, Search, Square, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import { api } from '../api';
import { streamWithWork, withWork } from '../lib/work';
import { textToHtml } from '../lib/format';
import { useAssistant, type ViewContext } from '../state/assistant';
import { assistantContextLabel, assistantSuggestions } from '../lib/assistant';
import { notifyWorkspaceChange } from '../lib/workspaceEvents';
import { useCompose } from '../state/compose';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';
import { useDictation } from './Dictate';
import { ThinkingButton } from './Thinking';
import { Button, Empty, IconButton, Spinner } from './ui';

// ---------- What the server sends ----------

interface Reference { accountId: number; threadId: string; subject: string; from: string; date: string }
interface TriageThread { accountId: number; threadId: string; subject: string; from: string; date: string }
interface DraftRule { name: string; match: 'all' | 'any'; conditions: { field: string; op: string; value?: string }[]; actions: { type: string; mailboxId?: string }[] }
type Proposal =
  | { kind: 'draft'; to: { name: string | null; email: string }[]; subject: string; body: string; accountId: number | null; threadId: string | null }
  | { kind: 'picture'; upload: { id: number; filename: string; contentType: string; size: number }; prompt: string; revisedPrompt?: string }
  | {
      kind: 'event'; summary: string; startsAt: string; endsAt: string; allDay: boolean;
      location: string | null; description: string | null; timezone: string | null;
      attendees: { name: string | null; email: string }[];
      clashes: { summary: string; startsAt: string; endsAt: string }[];
    }
  | {
      kind: 'commitment'; commitmentKind: 'owed' | 'awaiting'; text: string;
      counterparty: string | null; dueAt: string | null; accountId: number | null; threadId: string | null;
    }
  | { kind: 'rule'; rule: DraftRule; sentence: string }
  | {
      kind: 'triage'; action: 'archive' | 'label' | 'snooze' | 'mute';
      mailbox: { id: string; name: string } | null; until: string | null;
      reason: string; threads: TriageThread[];
    };

interface UiMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  proposal?: Proposal;
  references?: Reference[];
  toolName?: string;
}

interface AssistantStatus {
  enabled: boolean;
  consented: boolean;
  model: string;
  tools: { name: string; offBox: boolean }[];
  voice: { listen: boolean; speak: boolean; maxChars: number };
}

interface ConversationRow { id: number; title: string; createdAt: string; updatedAt: string; messages: number }

export const useAssistantStatus = (enabled = true) => useQuery({
  queryKey: ['assistant-status'],
  queryFn: () => api.get<AssistantStatus>('/api/assistant/status'),
  staleTime: 60_000,
  retry: false,
  enabled,
});

// What each tool is doing, in words rather than in its function name. A person
// watching the assistant work is owed a readable account of what it is reading
// on their behalf — "search_mail" is the name of a thing in a codebase.
const DOING: Record<string, string> = {
  search_mail: 'Searching your mail',
  read_thread: 'Reading the conversation',
  find_contacts: 'Looking up a contact',
  list_templates: 'Checking your templates',
  my_commitments: 'Checking what you owe',
  my_day: 'Checking your calendar',
  draft_email: 'Writing a draft',
  make_picture: 'Drawing a picture',
  search_mail_exact: 'Searching your mail',
  read_attachment: 'Reading an attachment',
  propose_event: 'Working out a time',
  record_commitment: 'Noting that down',
  draft_rule: 'Writing a rule',
  propose_triage: 'Gathering those up',
};
const doingLabel = (name: string) => DOING[name] ?? `Running ${name}`;

// ---------- The cards ----------

function DraftCard({ p }: { p: Extract<Proposal, { kind: 'draft' }> }) {
  const compose = useCompose();
  const to = p.to.map((a) => ({ name: a.name, email: a.email }));
  return (
    <div className="assistant-card">
      <div className="assistant-card-head"><Mail size={14} /><span>Draft, not sent</span></div>
      {to.length ? <div className="assistant-card-row"><span className="faint">To</span> {to.map((a) => a.name || a.email).join(', ')}</div> : null}
      {p.subject ? <div className="assistant-card-row"><span className="faint">Subject</span> {p.subject}</div> : null}
      <div className="assistant-card-body">{p.body}</div>
      <div className="assistant-card-actions">
        <Button
          size="sm"
          onClick={() => compose.open({
            accountId: p.accountId,
            kind: p.threadId ? 'reply' : 'new',
            to,
            subject: p.subject,
            html: textToHtml(p.body),
            threadKey: p.threadId && p.accountId ? `${p.accountId}:${p.threadId}` : null,
          })}
        >
          Open in composer
        </Button>
        {/* No "send" here, and there will not be one. The composer is where a
            message gets read one more time before it goes. */}
      </div>
    </div>
  );
}

function PictureCard({ p }: { p: Extract<Proposal, { kind: 'picture' }> }) {
  const compose = useCompose();
  const upload = { id: p.upload.id, filename: p.upload.filename, size: p.upload.size, content_type: p.upload.contentType };
  return (
    <div className="assistant-card">
      <div className="assistant-card-head"><ImagePlus size={14} /><span>Picture, not attached</span></div>
      <img className="assistant-card-image" src={`/api/mail/uploads/${p.upload.id}`} alt={p.prompt} loading="lazy" />
      <div className="assistant-card-actions">
        <Button size="sm" onClick={() => compose.open({ attachments: [upload] })}>Attach to a new message</Button>
      </div>
    </div>
  );
}

// ---------- The cards that change something here ----------
//
// Four proposals that write to the person's own things rather than to somebody
// else's inbox. They share a shape deliberately: a heading that names what has
// NOT happened yet, the whole of what is proposed rendered plainly, one button,
// and — once pressed — the card saying so rather than sitting there looking
// pressable. Every one of them is reversible by the ordinary means, which is
// the reason they are allowed a button at all.

/** A button that runs once and then says what it did. */
function useOnce(run: () => Promise<string>) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [said, setSaid] = useState('');
  const go = async () => {
    if (state !== 'idle') return;
    setState('busy');
    try {
      setSaid(await run());
      setState('done');
    } catch (e) {
      toast.error(e);
      setState('idle');
    }
  };
  return { state, said, go };
}

function EventCard({ p }: { p: Extract<Proposal, { kind: 'event' }> }) {
  const start = new Date(p.startsAt);
  const end = new Date(p.endsAt);
  const when = p.allDay
    ? `${start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · all day`
    : `${start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  // Guests are shown but not invited. Sending an invitation is mail going to
  // somebody else, which is the line this whole file is built around, so the
  // event is saved with the guests on it and `notify` off — Tern's own calendar
  // page is where somebody chooses to write to them.
  const once = useOnce(async () => {
    await api.post('/api/calendar/events', {
      summary: p.summary,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      allDay: p.allDay,
      location: p.location ?? undefined,
      description: p.description ?? undefined,
      timezone: p.timezone ?? undefined,
      attendees: p.attendees.map((a) => ({ email: a.email, name: a.name })),
      notify: false,
    });
    notifyWorkspaceChange('calendar');
    return 'In your calendar';
  });
  return (
    <div className="assistant-card">
      <div className="assistant-card-head"><CalendarPlus size={14} /><span>Not in your calendar yet</span></div>
      <div className="assistant-card-row"><span className="faint">What</span> {p.summary}</div>
      <div className="assistant-card-row"><span className="faint">When</span> {when}</div>
      {p.location ? <div className="assistant-card-row"><span className="faint">Where</span> {p.location}</div> : null}
      {p.attendees.length ? <div className="assistant-card-row"><span className="faint">Guests</span> {p.attendees.map((a) => a.name || a.email).join(', ')}</div> : null}
      {p.description ? <div className="assistant-card-body">{p.description}</div> : null}
      {p.clashes.length ? (
        <div className="assistant-card-warn">
          <AlertTriangle size={13} />
          <span>
            Clashes with {p.clashes.map((c) => c.summary).join(', ')}. Saving it anyway is fine — Tern is telling you, not stopping you.
          </span>
        </div>
      ) : null}
      <div className="assistant-card-actions">
        {once.state === 'done'
          ? <span className="assistant-card-done"><Check size={13} /> {once.said}</span>
          : <Button size="sm" loading={once.state === 'busy'} onClick={() => void once.go()}>Add to calendar</Button>}
        {p.attendees.length && once.state !== 'done'
          ? <span className="faint small">Guests are saved on it; nobody is invited until you send it from the calendar.</span>
          : null}
      </div>
    </div>
  );
}

function CommitmentCard({ p }: { p: Extract<Proposal, { kind: 'commitment' }> }) {
  const qc = useQueryClient();
  const once = useOnce(async () => {
    if (!p.accountId) throw new Error('No account to file this under');
    await api.post('/api/assist/commitments', {
      accountId: p.accountId,
      threadId: p.threadId ?? undefined,
      kind: p.commitmentKind,
      text: p.text,
      counterparty: p.counterparty,
      dueAt: p.dueAt,
    });
    void qc.invalidateQueries({ queryKey: ['commitments'] });
    notifyWorkspaceChange('commitments');
    return 'Added to your list';
  });
  return (
    <div className="assistant-card">
      <div className="assistant-card-head">
        <ClipboardCheck size={14} />
        <span>{p.commitmentKind === 'owed' ? 'Something you owe — not saved yet' : 'Something you are waiting for — not saved yet'}</span>
      </div>
      <div className="assistant-card-body">{p.text}</div>
      {p.counterparty ? <div className="assistant-card-row"><span className="faint">With</span> {p.counterparty}</div> : null}
      {p.dueAt ? <div className="assistant-card-row"><span className="faint">Due</span> {new Date(p.dueAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div> : null}
      <div className="assistant-card-actions">
        {once.state === 'done'
          ? <span className="assistant-card-done"><Check size={13} /> {once.said}</span>
          : <Button size="sm" loading={once.state === 'busy'} onClick={() => void once.go()}>Keep it</Button>}
      </div>
    </div>
  );
}

/**
 * A drafted rule, handed to the ordinary editor.
 *
 * It opens unsaved, on purpose and not as an oversight: the promise the plain
 * English rules feature makes is that the model writes a draft and then leaves,
 * and a card that saved the rule itself would quietly break that. So the button
 * carries the draft to `/rules`, the ordinary form fills in with it, and the
 * person saves it there having seen every condition.
 */
function RuleCard({ p }: { p: Extract<Proposal, { kind: 'rule' }> }) {
  const nav = useNavigate();
  const summary = p.rule.conditions
    .map((c) => `${c.field} ${c.op.replace(/_/g, ' ')}${c.value ? ` “${c.value}”` : ''}`)
    .join(p.rule.match === 'all' ? ' and ' : ' or ');
  return (
    <div className="assistant-card">
      <div className="assistant-card-head"><ListFilter size={14} /><span>Draft rule, not saved and not running</span></div>
      <div className="assistant-card-row"><span className="faint">Name</span> {p.rule.name}</div>
      <div className="assistant-card-row"><span className="faint">When</span> {summary || 'nothing yet'}</div>
      <div className="assistant-card-row"><span className="faint">Then</span> {p.rule.actions.map((a) => a.type.replace(/_/g, ' ')).join(', ') || 'nothing yet'}</div>
      <div className="assistant-card-actions">
        <Button
          size="sm"
          onClick={() => {
            // Carried in session storage rather than in the URL: a rule is an
            // object, and a query string big enough to hold one is a query
            // string that ends up in a history entry somebody can share.
            try { sessionStorage.setItem('tern.ruleDraft', JSON.stringify(p.rule)); } catch { /* private mode */ }
            nav('/rules?draft=1');
          }}
        >
          Open in the rules editor
        </Button>
      </div>
      <div className="assistant-card-note">Rules only run on mail that arrives after you save them.</div>
    </div>
  );
}

/**
 * A pile of conversations, with one button.
 *
 * The rules this card follows are the reason the tool behind it is allowed to
 * exist at all:
 *
 *   **Every row is shown.** There is no "and 9 more". Approving a set you
 *   cannot see is not approving anything.
 *
 *   **Every row can be taken out.** The model's selection is a suggestion, and
 *   the commonest correction is "yes, except that one".
 *
 *   **Undo, exactly as the mail list does it.** All four actions are reversible
 *   and the undo token the server hands back is passed to the same toast the
 *   list uses, so a wrong set costs one click.
 */
function TriageCard({ p }: { p: Extract<Proposal, { kind: 'triage' }> }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [count, setCount] = useState(0);
  const key = (t: TriageThread) => `${t.accountId}:${t.threadId}`;
  const kept = p.threads.filter((t) => !dropped.has(key(t)));

  const VERB: Record<typeof p.action, string> = {
    archive: 'Archive', label: `Label “${p.mailbox?.name ?? ''}”`, snooze: 'Snooze', mute: 'Mute',
  };

  async function run() {
    if (!kept.length || state !== 'idle') return;
    setState('busy');
    try {
      // Grouped by account because the action route takes one account at a
      // time — a person with a work and a personal mailbox can be handed one
      // set spanning both, and it should still be one button.
      const byAccount = new Map<number, string[]>();
      for (const t of kept) byAccount.set(t.accountId, [...(byAccount.get(t.accountId) ?? []), t.threadId]);
      const undos: { accountId: number; items: { jmapId: string; mailboxIds: string[] }[] }[] = [];
      for (const [accountId, threadIds] of byAccount) {
        const r = await api.post<{ undo: { accountId: number; items: { jmapId: string; mailboxIds: string[] }[] } | null }>('/api/mail/actions', {
          accountId,
          threadIds,
          action: p.action,
          ...(p.mailbox ? { mailboxId: p.mailbox.id } : {}),
          ...(p.until ? { until: p.until } : {}),
        });
        if (r.undo?.items.length) undos.push(r.undo);
      }
      setCount(kept.length);
      setState('done');
      const done = `${kept.length} conversation${kept.length === 1 ? '' : 's'} ${p.action === 'archive' ? 'archived' : p.action === 'label' ? 'labelled' : p.action === 'snooze' ? 'snoozed' : 'muted'}`;
      if (undos.length) {
        toast.toast(done, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                for (const u of undos) await api.post('/api/mail/actions', { accountId: u.accountId, action: 'restore', items: u.items });
                toast.success('Restored');
                setState('idle');
              } catch (e) { toast.error(e); }
              void qc.invalidateQueries({ queryKey: ['threads'] });
              void qc.invalidateQueries({ queryKey: ['counts'] });
            },
          },
        });
      } else toast.success(done);
      void qc.invalidateQueries({ queryKey: ['counts'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['threads'] }), 800);
    } catch (e) {
      toast.error(e);
      setState('idle');
    }
  }

  return (
    <div className="assistant-card">
      <div className="assistant-card-head">
        <Layers size={14} />
        <span>{state === 'done' ? `${count} done` : `${kept.length} conversation${kept.length === 1 ? '' : 's'}, nothing done yet`}</span>
      </div>
      {p.reason ? <div className="assistant-card-row"><span className="faint">Why</span> {p.reason}</div> : null}
      {p.until ? <div className="assistant-card-row"><span className="faint">Until</span> {new Date(p.until).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div> : null}
      {state !== 'done' && (
        <ul className="assistant-card-list">
          {p.threads.map((t) => {
            const gone = dropped.has(key(t));
            return (
              <li key={key(t)} className={gone ? 'dropped' : undefined}>
                <span className="truncate">
                  <span className="strong">{t.subject}</span>
                  <span className="faint"> — {t.from}, {t.date}</span>
                </span>
                <IconButton
                  label={gone ? 'Put it back' : 'Leave this one alone'}
                  className="btn-sm"
                  onClick={() => setDropped((d) => { const n = new Set(d); if (gone) n.delete(key(t)); else n.add(key(t)); return n; })}
                >
                  {gone ? <Plus size={13} /> : <X size={13} />}
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <div className="assistant-card-actions">
        {state === 'done'
          ? <span className="assistant-card-done"><Check size={13} /> Done — undo is in the toast</span>
          : <Button size="sm" loading={state === 'busy'} disabled={!kept.length} onClick={() => void run()}>{VERB[p.action]} {kept.length}</Button>}
      </div>
    </div>
  );
}

function ReferenceList({ refs }: { refs: Reference[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="assistant-refs">
      <button className="assistant-refs-toggle" onClick={() => setOpen((o) => !o)}>
        <Search size={12} /> {open ? 'Hide' : `What it read (${refs.length})`}
      </button>
      {open && (
        <ul>
          {refs.map((r, i) => (
            <li key={i}>
              <Link to={`/mail/all/t/${r.accountId}:${encodeURIComponent(r.threadId)}`}>{r.subject}</Link>
              <span className="faint"> — {r.from}, {r.date}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- The panel ----------

export function AssistantDock() {
  const { open, hide, pendingCount, takePending, clearPending, view } = useAssistant();
  const can = useCan('ai.assistant');
  const status = useAssistantStatus(open && can);
  const toast = useToast();
  const qc = useQueryClient();

  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [live, setLive] = useState('');
  const [running, setRunning] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [showList, setShowList] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const turn = useRef(0);
  const sending = useRef(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);

  // Read aloud, and keep listening after. Off by default: a panel that starts
  // talking because somebody opened it would be a surprise in an open-plan
  // office, and the microphone half needs a deliberate act anyway.
  const [handsFree, setHandsFree] = useState(false);

  const conversations = useQuery({
    queryKey: ['assistant-conversations'],
    queryFn: () => api.get<{ conversations: ConversationRow[] }>('/api/assistant/conversations'),
    enabled: open && can && showList,
  });

  useEffect(() => () => { abort.current?.abort(); audio.current?.pause(); }, []);

  // Follow the bottom while it types, which is what a person reading along
  // expects — and stop following the moment they scroll up to re-read
  // something, which is what they expect even more.
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, live, running]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const say = useCallback(async (what: string, signal: AbortSignal) => {
    if (!what.trim() || !status.data?.voice.speak) return;
    try {
      // Through the work guard like every other expensive call. `api` is not
      // used because the reply is audio rather than JSON, but the proof still
      // has to be solved and sent — the route carries `powGuard('voice')`, and
      // a plain fetch here is a 400 on every answer.
      const blob = await withWork('voice', async (work) => {
        const res = await fetch('/api/assistant/speak', {
          signal,
          method: 'POST',
          headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/json', ...work },
          credentials: 'same-origin',
          body: JSON.stringify({ text: what.slice(0, status.data!.voice.maxChars) }),
        });
        if (!res.ok) throw new Error(`speech failed (${res.status})`);
        return res.blob();
      });
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob);
      audio.current?.pause();
      const el = new Audio(url);
      audio.current = el;
      setSpeaking(true);
      // The object URL is revoked on the way out however the clip ends, so a
      // long conversation does not accumulate a blob per answer.
      const done = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      el.onended = done;
      el.onerror = done;
      await el.play().catch(done);
    } catch { /* a voice that will not speak is not worth an error toast */ }
  }, [status.data]);

  const ready = can && Boolean(status.data?.enabled && status.data?.consented) && !status.isError;

  const send = useCallback(async (asked: string, context?: ViewContext) => {
    const question = asked.trim();
    if (!question || sending.current || loadingConversation || !ready) return;
    const mine = ++turn.current;
    sending.current = true;
    setShowList(false);
    if (!context) setText('');
    setBusy(true);
    stick.current = true;
    // Shown immediately under a temporary id; the server's real id replaces it
    // on the `start` event. Waiting for the round trip would leave the person's
    // own words missing from the panel for as long as the model takes to begin.
    const tempId = -Date.now();
    setMessages((m) => [...m, { id: tempId, role: 'user', content: question }]);
    setLive('');
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    let spoken = '';
    try {
      await streamWithWork('ai', '/api/assistant/chat', {
        conversationId,
        message: question,
        view: context ?? view(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, {
        signal: controller.signal,
        onEvent: (ev, data) => {
          if (mine !== turn.current || controller.signal.aborted) return;
          if (ev === 'start') {
            setConversationId(data.conversationId);
            setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, id: data.userMessageId } : x)));
          } else if (ev === 'token') {
            setLive((t) => t + data.text);
          } else if (ev === 'tool') {
            // Removing by first occurrence rather than by name: a model may
            // call the same tool twice in one turn, and dropping both chips
            // when the first finishes would report it as done while it runs.
            setRunning((r) => {
              if (data.state === 'running') return [...r, data.name];
              const at = r.indexOf(data.name);
              return at < 0 ? r : [...r.slice(0, at), ...r.slice(at + 1)];
            });
          } else if (ev === 'saved') {
            setLive('');
            if (data.role === 'assistant' && data.content?.trim()) spoken = data.content;
            // A tool row with nothing to show the person — no picture, no
            // draft, no citations — is bookkeeping. It is in the transcript on
            // the server either way; it just has no card to be. Its `content`
            // is deliberately dropped rather than rendered: that text is raw
            // quoted mail written for the model, not for a chat bubble.
            const show = data.role === 'tool'
              ? Boolean(data.proposal || data.references?.length)
              : Boolean(data.content?.trim());
            if (show) {
              setMessages((m) => [...m, {
                id: data.id, role: data.role, content: data.role === 'tool' ? '' : data.content,
                proposal: data.proposal, references: data.references, toolName: data.toolName,
              }]);
            }
          } else if (ev === 'error') {
            toast.error(data.error);
          }
        },
      });
      if (mine === turn.current && !controller.signal.aborted && handsFree && spoken) await say(spoken, controller.signal);
    } catch (e: any) {
      if (mine === turn.current && e?.name !== 'AbortError') toast.error(e);
    } finally {
      void qc.invalidateQueries({ queryKey: ['assistant-conversations'] });
      if (mine === turn.current) {
        sending.current = false;
        setBusy(false);
        setRunning([]);
        setLive('');
      }
    }
  }, [conversationId, handsFree, say, toast, view, ready, loadingConversation, qc]);

  // The microphone. A finished recording is sent straight away rather than
  // dropped into the box for editing: somebody who has just spoken a question
  // has asked it, and making them press a second button to send what they
  // said is the thing that makes voice control feel like a form.
  const dictation = useDictation(useCallback((said: string) => { void send(said); }, [send]));

  const resetTurn = () => {
    ++turn.current;
    abort.current?.abort();
    audio.current?.pause();
    setSpeaking(false);
    sending.current = false;
    setBusy(false);
    setRunning([]);
    setLive('');
    setLoadingConversation(false);
    clearPending();
  };

  const startNew = () => {
    resetTurn();
    setConversationId(null);
    setMessages([]);
    setText('');
    setShowList(false);
    box.current?.focus();
  };

  const openConversation = async (id: number) => {
    resetTurn();
    const mine = turn.current;
    setLoadingConversation(true);
    try {
      const r = await api.get<{ messages: UiMessage[] }>(`/api/assistant/conversations/${id}`);
      if (mine !== turn.current) return;
      setConversationId(id);
      setMessages(r.messages.filter((m) => (m.role === 'tool' ? m.proposal || m.references?.length : m.content?.trim())));
      setText('');
      setShowList(false);
      stick.current = true;
    } catch (e) { if (mine === turn.current) toast.error(e); }
    finally { if (mine === turn.current) setLoadingConversation(false); }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`/api/assistant/conversations/${id}`);
      void qc.invalidateQueries({ queryKey: ['assistant-conversations'] });
      if (id === conversationId) startNew();
    } catch (e) { toast.error(e); }
  };

  // Consume only once the model is ready and the previous turn has finished.
  // Context was captured by the originating screen, not by this delayed effect.
  useEffect(() => {
    if (!open || !ready || busy || sending.current || loadingConversation || !pendingCount) return;
    const pending = takePending();
    if (pending) void send(pending.prompt, pending.view);
  }, [open, ready, busy, loadingConversation, pendingCount, takePending, send]);
  useEffect(() => { if (open) box.current?.focus(); }, [open]);

  if (!open) return null;

  const unavailable = !can || (status.data && (!status.data.enabled || !status.data.consented));
  const context = view();
  const suggestions = ready ? assistantSuggestions(context, status.data?.tools.map((t) => t.name) ?? []) : [];

  return (
    <aside className="assistant-dock" aria-label="Assistant">
      <header className="assistant-head">
        {showList
          ? <IconButton label="Back" onClick={() => setShowList(false)}><ChevronLeft size={16} /></IconButton>
          : <IconButton label="Conversations" onClick={() => setShowList(true)}><MessageSquare size={16} /></IconButton>}
        <span className="assistant-title"><Bot size={15} /> Assistant{status.data?.model ? <span className="faint"> · {status.data.model}</span> : null}</span>
        {status.data?.voice.speak && (
          <IconButton
            label={handsFree ? 'Stop reading answers aloud' : 'Read answers aloud'}
            className={handsFree ? 'active' : undefined}
            onClick={() => { setHandsFree((h) => !h); if (handsFree) { audio.current?.pause(); setSpeaking(false); } }}
          >
            {handsFree ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </IconButton>
        )}
        <ThinkingButton />
        <IconButton label="New conversation" onClick={startNew}><Plus size={16} /></IconButton>
        <IconButton label="Close" onClick={hide}><X size={16} /></IconButton>
      </header>

      {showList ? (
        <div className="assistant-list">
          {conversations.isLoading ? <div className="p-4"><Spinner /></div>
            : !conversations.data?.conversations.length ? <Empty title="No conversations yet" />
              : conversations.data.conversations.map((c) => (
                <div key={c.id} className="assistant-list-row">
                  <button className="assistant-list-open" onClick={() => void openConversation(c.id)}>
                    <span className="truncate">{c.title}</span>
                    <span className="faint">{new Date(c.updatedAt).toLocaleDateString()} · {c.messages}</span>
                  </button>
                  <IconButton label="Delete" onClick={() => void remove(c.id)}><Trash2 size={14} /></IconButton>
                </div>
              ))}
        </div>
      ) : (
        <>
          <div className="assistant-context" title={assistantContextLabel(context)}>About: {assistantContextLabel(context)}</div>
          <div className="assistant-scroll" ref={scroller} onScroll={onScroll}>
            {unavailable ? (
              <Empty
                title={status.data && !status.data.enabled ? 'The assistant is turned off' : 'Turn the assistant on'}
                action={status.data && status.data.consented ? undefined : <a className="btn btn-sm" href="/settings/features">Settings → Features</a>}
              >
                {status.data && !status.data.enabled
                  ? 'An administrator has not enabled a model for this server.'
                  : 'It can search your mail, read a conversation and its attachments, check your calendar, and put a draft, a meeting or a tidy-up in front of you. Nothing happens without your button.'}
              </Empty>
            ) : status.isError ? (
              <Empty title="Could not connect to the assistant" action={<Button size="sm" onClick={() => void status.refetch()}>Try again</Button>} />
            ) : !ready ? <div className="center p-4"><Spinner /></div> : !messages.length && !live ? (
              <Empty icon={<Bot size={22} />} title="Ask about anything in here">
                Ask a question, or choose a starting point below. I can use the context shown above.
              </Empty>
            ) : null}

            {messages.map((m) => (
              <div key={m.id} className={`assistant-msg ${m.role}`}>
                {m.content ? <div className="assistant-bubble">{m.content}</div> : null}
                {m.proposal?.kind === 'draft' ? <DraftCard p={m.proposal} /> : null}
                {m.proposal?.kind === 'picture' ? <PictureCard p={m.proposal} /> : null}
                {m.proposal?.kind === 'event' ? <EventCard p={m.proposal} /> : null}
                {m.proposal?.kind === 'commitment' ? <CommitmentCard p={m.proposal} /> : null}
                {m.proposal?.kind === 'rule' ? <RuleCard p={m.proposal} /> : null}
                {m.proposal?.kind === 'triage' ? <TriageCard p={m.proposal} /> : null}
                {m.references?.length ? <ReferenceList refs={m.references} /> : null}
              </div>
            ))}

            {live ? <div className="assistant-msg assistant"><div className="assistant-bubble">{live}</div></div> : null}
            {running.map((name, i) => (
              <div key={`${name}-${i}`} className="assistant-doing"><Loader2 size={13} className="spin" /> {doingLabel(name)}…</div>
            ))}
            {busy && !live && !running.length ? <div className="assistant-doing"><Loader2 size={13} className="spin" /> Thinking…</div> : null}
          </div>

          {!busy && !text && suggestions.length > 0 && (
            <div className="assistant-suggestions" aria-label="Suggested questions">
              {suggestions.map((s) => <button key={s.label} type="button" disabled={loadingConversation} onClick={() => void send(s.prompt)}>{s.label}</button>)}
            </div>
          )}
          {pendingCount > 0 && <div className="assistant-pending" role="status">{pendingCount} question{pendingCount === 1 ? '' : 's'} waiting <button type="button" onClick={clearPending}>Cancel</button></div>}
          <form
            className="assistant-compose"
            onSubmit={(e) => { e.preventDefault(); void send(text); }}
          >
            <textarea
              ref={box}
              className="assistant-input"
              rows={1}
              value={text}
              placeholder={dictation.state === 'recording' ? 'Listening…' : 'Ask the assistant'}
              aria-label="Ask the assistant"
              maxLength={8000}
              disabled={!ready || loadingConversation}
              onChange={(e) => setText(e.target.value)}
              // Enter sends, Shift+Enter is a new line. The same bargain the
              // composer makes, so the two do not disagree about a key.
              //
              // Up-arrow in an EMPTY box recalls what you last asked, the way
              // every shell does. It matters more here than in a shell: half
              // the questions in this box arrive by dictation, which produces
              // long sentences with one wrong word in them, and before this the
              // only way to fix that word was to say the whole thing again.
              // Guarded on the box being empty so it never steals the key from
              // somebody moving the caret through a message they are writing.
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); return; }
                if (e.key === 'ArrowUp' && !text) {
                  const last = [...messages].reverse().find((m) => m.role === 'user' && m.content.trim());
                  if (!last) return;
                  e.preventDefault();
                  setText(last.content);
                  // The caret goes to the end rather than the start, because
                  // the thing being fixed is nearly always the last few words.
                  requestAnimationFrame(() => {
                    const el = box.current;
                    if (el) el.setSelectionRange(el.value.length, el.value.length);
                  });
                }
              }}
            />
            {status.data?.voice.listen && (
              <IconButton
                label={dictation.state === 'recording' ? 'Stop and send' : 'Speak'}
                className={dictation.state === 'recording' ? 'recording' : undefined}
                onClick={dictation.toggle}
                type="button"
                disabled={busy || !ready || loadingConversation}
              >
                {dictation.state === 'working' ? <Loader2 size={16} className="spin" /> : dictation.state === 'recording' ? <Square size={16} /> : <Mic size={16} />}
              </IconButton>
            )}
            {busy
              ? <IconButton label="Stop" type="button" onClick={() => { clearPending(); abort.current?.abort(); }}><Square size={16} /></IconButton>
              : <Button size="sm" type="submit" disabled={!text.trim() || !ready || loadingConversation}>Ask</Button>}
          </form>
          {speaking ? <div className="assistant-speaking"><Volume2 size={12} /> Speaking… <button onClick={() => { audio.current?.pause(); setSpeaking(false); }}>stop</button></div> : null}
        </>
      )}
    </aside>
  );
}
