// Owed and awaiting (F6).
//
// Two lists, because they are two different feelings: things you said you
// would do, and things you are waiting for somebody else to do. Both close
// themselves when the mail says so — a reply arriving closes an "awaiting",
// sending into the thread closes an "owed" — so this is a list that empties
// itself rather than another inbox to keep on top of.
//
// Every row is editable and dismissible. The model only ever proposed it;
// the person decides whether it was really a commitment.
//
// Drawn as two columns rather than two stacked lists. They are answers to
// different questions and you want both at once — "what is on me" beside
// "what is on somebody else" — and stacked, the second one is below the fold
// on every screen. Inside a column the order is urgency, not arrival: late
// first, then soonest, then the ones with no date at all.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Clock, PenLine, Plus, Timer, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { useFeatures } from '../state/features';
import { Avatar, Badge, Button, Empty, Field, Input, Modal, PageHeader, Select, Spinner } from '../components/ui';
import { FeatureOffNotice } from './Features';
import { useToast } from '../state/toast';
import { cls, dueIn } from '../lib/format';
import { CommitmentMove } from '../components/CommitmentMove';
import { AskAssistant } from '../components/AskAssistant';
import { useWorkspaceChange } from '../lib/workspaceEvents';

interface Commitment {
  id: number;
  kind: 'owed' | 'awaiting';
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  movedAt: string | null;
  status: 'open' | 'done' | 'dropped';
  threadId: string;
  accountId: number;
  source: 'ai' | 'manual';
  createdAt: string;
}

// Late first, then by how soon, then the undated. A commitment with no date
// is not urgent — it is unscheduled — so it belongs at the bottom rather
// than sorted as though it were due at the epoch.
function byUrgency(a: Commitment, b: Commitment): number {
  const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
  const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  return a.id - b.id;
}

export default function CommitmentsPage() {
  const { can, info, loading: featuresLoading } = useFeatures();
  const toast = useToast();
  const [items, setItems] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const allowed = can('commitments');

  const load = useCallback(async () => {
    if (!allowed) { setLoading(false); return; }
    try {
      const r = await api.get<{ commitments: Commitment[] }>('/api/assist/commitments');
      setItems(r.commitments);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) toast.error(e);
    } finally { setLoading(false); }
  }, [allowed, toast]);

  useEffect(() => { void load(); }, [load]);
  useWorkspaceChange('commitments', load);

  const close = async (id: number, status: 'done' | 'dropped') => {
    setItems((prev) => prev.filter((c) => c.id !== id));
    try { await api.post(`/api/assist/commitments/${id}/close`, { status }); }
    catch (e) { toast.error(e); void load(); }
  };

  const { owed, awaiting, overdue } = useMemo(() => {
    const now = Date.now();
    return {
      owed: items.filter((c) => c.kind === 'owed').sort(byUrgency),
      awaiting: items.filter((c) => c.kind === 'awaiting').sort(byUrgency),
      overdue: items.filter((c) => c.dueAt && new Date(c.dueAt).getTime() < now).length,
    };
  }, [items]);

  if (featuresLoading || loading) return <div className="page center pad-24"><Spinner /></div>;

  if (!allowed) {
    return (
      <div className="page page-read">
        <PageHeader title="Commitments" sub="What you promised, and what you are waiting on." />
        <FeatureOffNotice cap={info('commitments')}>
          This reads your conversations to find the specific things people said they would do — yours
          and theirs — and lists them. Everything it finds is editable, and it closes items by
          itself when the mail shows they are settled.
        </FeatureOffNotice>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Commitments"
        sub={items.length
          ? <>{owed.length} on you, {awaiting.length} on somebody else{overdue > 0 ? <> · <span className="commit-late-note">{overdue} past its date</span></> : null}</>
          : 'Nothing outstanding.'}
        actions={<><AskAssistant label="Help me prioritise" prompt="Review my open commitments and suggest what to tackle first based on due dates. Separate what I owe from what I am waiting on." /><Button icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add one</Button></>}
      />

      {!items.length ? (
        <Empty icon={<Check size={26} />} title="Nothing outstanding">
          Nothing in your recent conversations is waiting on you or on anyone else. New ones appear
          here as your mail is read.
        </Empty>
      ) : (
        <div className="commit-board">
          <Column
            title="You said you would"
            icon={<Clock size={14} />}
            kind="owed"
            empty="Nothing is on you right now."
            items={owed}
            onClose={close}
            onChanged={() => void load()}
          />
          <Column
            title="You are waiting on"
            icon={<Timer size={14} />}
            kind="awaiting"
            empty="You are not waiting on anybody."
            items={awaiting}
            onClose={close}
            onChanged={() => void load()}
          />
        </div>
      )}

      <AddModal open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />
    </div>
  );
}

// A column keeps its header and its frame even when it is empty, so the board
// does not reflow into one lopsided list the moment you clear one side.
function Column({ title, icon, kind, items, empty, onClose, onChanged }: {
  title: string; icon: React.ReactNode; kind: 'owed' | 'awaiting';
  items: Commitment[]; empty: string; onClose: (id: number, s: 'done' | 'dropped') => void; onChanged: () => void;
}) {
  return (
    <section className={cls('card commit-col', `commit-col-${kind}`)}>
      <h2 className="commit-col-head">
        <span className={`commit-col-icon commit-col-icon-${kind}`}>{icon}</span>
        <span className="commit-col-title">{title}</span>
        <span className="commit-col-count">{items.length}</span>
      </h2>
      {items.length
        ? <div className="commit-list">{items.map((c) => <Row key={c.id} c={c} onClose={onClose} onChanged={onChanged} />)}</div>
        : <p className="commit-col-empty">{empty}</p>}
    </section>
  );
}

function Row({ c, onClose, onChanged }: { c: Commitment; onClose: (id: number, s: 'done' | 'dropped') => void; onChanged: () => void }) {
  const due = dueIn(c.dueAt);
  const [moving, setMoving] = useState(false);
  return (
    <div className={cls('commit-row', due?.late && 'commit-row-late', moving && 'commit-row-moving')}>
      {/* The other party is the fastest thing to recognise in a row of
          sentences, so it gets the colour and the left edge. Without one
          — a note you wrote yourself — the slot stays, dimmed, rather than
          collapsing and knocking every row out of alignment. */}
      {c.counterparty
        ? <Avatar name={c.counterparty} size="sm" className="commit-who" />
        : <span className="commit-who commit-who-none" aria-hidden="true" />}

      <div className="commit-body">
        {/* The promise itself is the way into the conversation it came from.
            A row that spelled out "open the conversation" said the same six
            words twenty times down a column and still left the sentence
            above it looking inert. */}
        {c.threadId
          ? <Link className="commit-text commit-text-link" to={`/mail/inbox/t/${c.accountId}:${c.threadId}`}>
              {c.text}<ChevronRight className="commit-go" size={14} />
            </Link>
          : <div className="commit-text">{c.text}</div>}
        {/* Who and when on the left, the ways out on the right, and they
            share a line whenever the column is wide enough to hold both. */}
        <div className="commit-foot">
          <div className="commit-meta">
            <AskAssistant label="Help with this" context={{
              page: 'Commitments',
              thread: c.threadId ? { accountId: c.accountId, threadId: c.threadId } : null,
            }} prompt={`Help me with this ${c.kind === 'owed' ? 'promise I made' : 'item I am waiting on'}: ${c.text}${c.counterparty ? ` (${c.counterparty})` : ''}${c.dueAt ? `, due ${c.dueAt}` : ''}. ${c.threadId ? 'Read the source conversation first. ' : ''}Suggest a next step; if a reply is needed, prepare a draft for me to review.`} />
            {c.counterparty && <span className="commit-party">{c.counterparty}</span>}
            {due && <Badge kind={due.late ? 'danger' : due.today ? 'warning' : undefined}>{due.label}</Badge>}
            {c.source === 'manual' && <Badge>Added by you</Badge>}
            {/* A promise that has already moved once says so. It is not a
                reproach — it is the thing you want to know before moving it
                again, and before writing the email that does. */}
            {c.movedAt && <Badge>Moved</Badge>}
          </div>

          {/* Both ways out sit in the row and hold their space: a commitment
              you cannot see how to close is one that stays open. They are
              quiet until the row is under the pointer, because on a list of
              twenty the buttons otherwise read louder than the promises. */}
          <div className="commit-acts">
            <button type="button" className="commit-act commit-act-done" onClick={() => onClose(c.id, 'done')} title="Mark this done">
              <Check size={14} /><span>Done</span>
            </button>
            {/* The third way out, and the one that was missing. "Done" and
                "not a commitment" are the two endings; this is what actually
                happens to most of them, which is that they move. */}
            <button
              type="button"
              className={cls('commit-act', moving && 'on')}
              onClick={() => setMoving((v) => !v)}
              title={c.kind === 'owed' ? 'Tell them it has moved' : 'Ask them again'}
            >
              {c.kind === 'owed' ? <PenLine size={14} /> : <Timer size={14} />}
              <span>{c.kind === 'owed' ? 'Reschedule' : 'Nudge'}</span>
            </button>
            {/* "Not a commitment" rather than "delete": the model proposed
                it, and saying so is how somebody learns what the list is. */}
            <button type="button" className="commit-act" onClick={() => onClose(c.id, 'dropped')} title="This was never a commitment">
              <X size={14} /><span>Not a commitment</span>
            </button>
          </div>
        </div>

        {/* In the row rather than in a modal. Rescheduling is a decision made
            against the other items in the column — what else is late, what
            else is on this person — and a dialogue over the top of them hides
            exactly the context the decision needs. */}
        {moving && <CommitmentMove c={c} onClose={() => setMoving(false)} onMoved={onChanged} />}
      </div>
    </div>
  );
}

function AddModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<{ id: number; email: string }[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [kind, setKind] = useState<'owed' | 'awaiting'>('owed');
  const [text, setText] = useState('');
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api.get<{ accounts: { id: number; email: string }[] }>('/api/accounts').then((r) => {
      setAccounts(r.accounts);
      setAccountId(r.accounts[0]?.id ?? null);
    }).catch(() => {});
  }, [open]);

  const save = async () => {
    if (!accountId || text.trim().length < 3) return;
    setSaving(true);
    try {
      await api.post('/api/assist/commitments', {
        accountId, kind, text: text.trim(),
        counterparty: who.trim() || null,
        dueAt: due ? new Date(`${due}T12:00:00`).toISOString() : null,
      });
      setText(''); setWho(''); setDue('');
      onAdded();
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a commitment"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Add</Button></>}
    >
      <div className="stack-12">
        <Field label="Which">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'owed' | 'awaiting')}>
            <option value="owed">I said I would…</option>
            <option value="awaiting">I am waiting for…</option>
          </Select>
        </Field>
        <Field label="What"><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Send the revised quote" maxLength={200} /></Field>
        <Field label="Who" hint="Optional"><Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Ana Duarte" maxLength={120} /></Field>
        <Field label="By when" hint="Optional"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        {accounts.length > 1 && (
          <Field label="Account">
            <Select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
