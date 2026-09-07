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
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clock, Plus, Timer, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { useFeatures } from '../state/features';
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, Select, Spinner } from '../components/ui';
import { FeatureOffNotice } from './Features';
import { useToast } from '../state/toast';
import { fmtDate } from '../lib/format';

interface Commitment {
  id: number;
  kind: 'owed' | 'awaiting';
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  status: 'open' | 'done' | 'dropped';
  threadId: string;
  accountId: number;
  source: 'ai' | 'manual';
  createdAt: string;
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

  const close = async (id: number, status: 'done' | 'dropped') => {
    setItems((prev) => prev.filter((c) => c.id !== id));
    try { await api.post(`/api/assist/commitments/${id}/close`, { status }); }
    catch (e) { toast.error(e); void load(); }
  };

  if (featuresLoading || loading) return <div className="center pad-24"><Spinner /></div>;

  if (!allowed) {
    return (
      <div className="stack-20">
        <PageHeader title="Commitments" sub="What you promised, and what you are waiting on." />
        <FeatureOffNotice cap={info('commitments')}>
          This reads your conversations to find the specific things people said they would do — yours
          and theirs — and lists them. Everything it finds is editable, and it closes items by
          itself when the mail shows they are settled.
        </FeatureOffNotice>
      </div>
    );
  }

  const owed = items.filter((c) => c.kind === 'owed');
  const awaiting = items.filter((c) => c.kind === 'awaiting');

  return (
    <div className="stack-20">
      <PageHeader
        title="Commitments"
        sub={items.length ? `${owed.length} owed, ${awaiting.length} awaiting` : 'Nothing outstanding.'}
        actions={<Button icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add one</Button>}
      />

      {!items.length && (
        <Empty icon={<Check size={26} />} title="Nothing outstanding">
          Nothing in your recent conversations is waiting on you or on anyone else. New ones appear
          here as your mail is read.
        </Empty>
      )}

      <List title="You said you would" icon={<Clock size={15} />} items={owed} onClose={close} />
      <List title="You are waiting on" icon={<Timer size={15} />} items={awaiting} onClose={close} />

      <AddModal open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />
    </div>
  );
}

function List({ title, icon, items, onClose }: { title: string; icon: React.ReactNode; items: Commitment[]; onClose: (id: number, s: 'done' | 'dropped') => void }) {
  if (!items.length) return null;
  const now = Date.now();
  return (
    <section className="stack-8">
      <h3 className="section-title">{icon} {title}</h3>
      <div className="card commitment-list">
        {items.map((c) => {
          const overdue = c.dueAt ? new Date(c.dueAt).getTime() < now : false;
          return (
            <div key={c.id} className="commitment-row">
              <div className="commitment-body">
                <div className="commitment-text">{c.text}</div>
                <div className="commitment-meta muted small">
                  {c.counterparty && <span>{c.counterparty}</span>}
                  {c.dueAt && (
                    <Badge kind={overdue ? 'danger' : undefined}>
                      {overdue ? 'Overdue' : 'By'} {fmtDate(c.dueAt, { always: true })}
                    </Badge>
                  )}
                  {c.source === 'manual' && <Badge>Added by you</Badge>}
                  {c.threadId && (
                    <Link to={`/mail/inbox/t/${c.accountId}:${c.threadId}`}>Open the conversation</Link>
                  )}
                </div>
              </div>
              <div className="commitment-actions">
                <Button size="sm" icon={<Check size={14} />} onClick={() => onClose(c.id, 'done')}>Done</Button>
                {/* "Not a commitment" rather than "delete": the model proposed
                    it, and saying so is how somebody learns what the list is. */}
                <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => onClose(c.id, 'dropped')}>
                  Not a commitment
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
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
