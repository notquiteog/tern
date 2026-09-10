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
import {
  Bot, ChevronLeft, ImagePlus, Loader2, Mail, MessageSquare, Mic, Plus,
  Search, Square, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import { api } from '../api';
import { streamWithWork, withWork } from '../lib/work';
import { textToHtml } from '../lib/format';
import { useAssistant } from '../state/assistant';
import { useCompose } from '../state/compose';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';
import { useDictation } from './Dictate';
import { ThinkingButton } from './Thinking';
import { Button, Empty, IconButton, Spinner } from './ui';

// ---------- What the server sends ----------

interface Reference { accountId: number; threadId: string; subject: string; from: string; date: string }
type Proposal =
  | { kind: 'draft'; to: { name: string | null; email: string }[]; subject: string; body: string; accountId: number | null; threadId: string | null }
  | { kind: 'picture'; upload: { id: number; filename: string; contentType: string; size: number }; prompt: string; revisedPrompt?: string };

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
              <a href={`/mail/all/t/${r.accountId}:${encodeURIComponent(r.threadId)}`}>{r.subject}</a>
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
  const { open, hide, takePending, view } = useAssistant();
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

  const say = useCallback(async (what: string) => {
    if (!what.trim() || !status.data?.voice.speak) return;
    try {
      // Through the work guard like every other expensive call. `api` is not
      // used because the reply is audio rather than JSON, but the proof still
      // has to be solved and sent — the route carries `powGuard('voice')`, and
      // a plain fetch here is a 400 on every answer.
      const blob = await withWork('voice', async (work) => {
        const res = await fetch('/api/assistant/speak', {
          method: 'POST',
          headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/json', ...work },
          credentials: 'same-origin',
          body: JSON.stringify({ text: what.slice(0, status.data!.voice.maxChars) }),
        });
        if (!res.ok) throw new Error(`speech failed (${res.status})`);
        return res.blob();
      });
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

  const send = useCallback(async (asked: string) => {
    const question = asked.trim();
    if (!question || busy) return;
    setText('');
    setBusy(true);
    stick.current = true;
    // Shown immediately under a temporary id; the server's real id replaces it
    // on the `start` event. Waiting for the round trip would leave the person's
    // own words missing from the panel for as long as the model takes to begin.
    const tempId = -Date.now();
    setMessages((m) => [...m, { id: tempId, role: 'user', content: question }]);
    setLive('');
    abort.current?.abort();
    abort.current = new AbortController();
    let spoken = '';
    try {
      await streamWithWork('ai', '/api/assistant/chat', {
        conversationId,
        message: question,
        view: view(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, {
        signal: abort.current.signal,
        onEvent: (ev, data) => {
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
      if (handsFree && spoken) await say(spoken);
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error(e);
    } finally {
      setBusy(false);
      setRunning([]);
      setLive('');
    }
  }, [busy, conversationId, handsFree, say, toast, view]);

  // The microphone. A finished recording is sent straight away rather than
  // dropped into the box for editing: somebody who has just spoken a question
  // has asked it, and making them press a second button to send what they
  // said is the thing that makes voice control feel like a form.
  const dictation = useDictation(useCallback((said: string) => { void send(said); }, [send]));

  const startNew = () => {
    abort.current?.abort();
    setConversationId(null);
    setMessages([]);
    setLive('');
    setShowList(false);
    box.current?.focus();
  };

  const openConversation = async (id: number) => {
    abort.current?.abort();
    setShowList(false);
    setConversationId(id);
    const r = await api.get<{ messages: UiMessage[] }>(`/api/assistant/conversations/${id}`);
    setMessages(r.messages.filter((m) => (m.role === 'tool' ? m.proposal || m.references?.length : m.content?.trim())));
    stick.current = true;
  };

  const remove = async (id: number) => {
    await api.del(`/api/assistant/conversations/${id}`);
    void qc.invalidateQueries({ queryKey: ['assistant-conversations'] });
    if (id === conversationId) startNew();
  };

  // A question handed over by another part of the app — the thread view's
  // "Ask about this", the command palette — asked as soon as the panel opens.
  useEffect(() => {
    if (!open) return;
    const p = takePending();
    if (p) void send(p);
    else box.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const unavailable = status.data && (!status.data.enabled || !status.data.consented);

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
          <div className="assistant-scroll" ref={scroller} onScroll={onScroll}>
            {unavailable ? (
              <Empty
                title={status.data && !status.data.enabled ? 'The assistant is turned off' : 'Turn the assistant on'}
                action={status.data && status.data.consented ? undefined : <a className="btn btn-sm" href="/settings/features">Settings → Features</a>}
              >
                {status.data && !status.data.enabled
                  ? 'An administrator has not enabled a model for this server.'
                  : 'It can search your mail, read a conversation, check your calendar and put a draft in front of you. Nothing is sent without you.'}
              </Empty>
            ) : !messages.length && !live ? (
              <Empty icon={<Bot size={22} />} title="Ask about anything in here">
                Try “summarise this thread”, “what am I waiting on?”, or “draft a reply saying Thursday works”.
              </Empty>
            ) : null}

            {messages.map((m) => (
              <div key={m.id} className={`assistant-msg ${m.role}`}>
                {m.content ? <div className="assistant-bubble">{m.content}</div> : null}
                {m.proposal?.kind === 'draft' ? <DraftCard p={m.proposal} /> : null}
                {m.proposal?.kind === 'picture' ? <PictureCard p={m.proposal} /> : null}
                {m.references?.length ? <ReferenceList refs={m.references} /> : null}
              </div>
            ))}

            {live ? <div className="assistant-msg assistant"><div className="assistant-bubble">{live}</div></div> : null}
            {running.map((name, i) => (
              <div key={`${name}-${i}`} className="assistant-doing"><Loader2 size={13} className="spin" /> {doingLabel(name)}…</div>
            ))}
            {busy && !live && !running.length ? <div className="assistant-doing"><Loader2 size={13} className="spin" /> Thinking…</div> : null}
          </div>

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
              disabled={Boolean(unavailable)}
              onChange={(e) => setText(e.target.value)}
              // Enter sends, Shift+Enter is a new line. The same bargain the
              // composer makes, so the two do not disagree about a key.
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
            />
            {status.data?.voice.listen && (
              <IconButton
                label={dictation.state === 'recording' ? 'Stop and send' : 'Speak'}
                className={dictation.state === 'recording' ? 'recording' : undefined}
                onClick={dictation.toggle}
                type="button"
                disabled={busy || Boolean(unavailable)}
              >
                {dictation.state === 'working' ? <Loader2 size={16} className="spin" /> : dictation.state === 'recording' ? <Square size={16} /> : <Mic size={16} />}
              </IconButton>
            )}
            {busy
              ? <IconButton label="Stop" type="button" onClick={() => abort.current?.abort()}><Square size={16} /></IconButton>
              : <Button size="sm" type="submit" disabled={!text.trim() || Boolean(unavailable)}>Ask</Button>}
          </form>
          {speaking ? <div className="assistant-speaking"><Volume2 size={12} /> Speaking… <button onClick={() => { audio.current?.pause(); setSpeaking(false); }}>stop</button></div> : null}
        </>
      )}
    </aside>
  );
}
