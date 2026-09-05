import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Workflow, Play, Pause, Archive, Copy } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useSequences } from '../lib/queries';
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, Select, Textarea } from '../components/ui';

const STATUS_KIND: Record<string, any> = { active: 'success', paused: 'warning', draft: undefined, archived: undefined };

export default function SequencesPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sequences = [], isLoading } = useSequences();
  const { data: accounts = [] } = useAccounts();
  const [create, setCreate] = useState(params.get('new') === '1');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [acc, setAcc] = useState<number | ''>('');
  useEffect(() => { if (accounts.length && acc === '') setAcc(accounts[0].id); }, [accounts, acc]);
  async function doCreate() {
    try {
      const r = await api.post<any>('/api/sequences', { name, description: desc, account_id: acc || null, steps: [{ kind: 'email', subject: '', body_html: '' }, { kind: 'wait', wait_days: 3 }, { kind: 'email', subject: '', body_html: '', reply_in_thread: true }] });
      qc.invalidateQueries({ queryKey: ['sequences'] });
      nav(`/sequences/${r.sequence.id}`);
    } catch (e) { toast.error(e); }
  }
  async function setStatus(id: number, status: string) {
    try { await api.post(`/api/sequences/${id}/status`, { status }); qc.invalidateQueries({ queryKey: ['sequences'] }); } catch (e) { toast.error(e); }
  }
  const visible = sequences.filter((s) => s.status !== 'archived');
  const archived = sequences.filter((s) => s.status === 'archived');
  return (
    <div className="page">
      <PageHeader title="Sequences" sub="Multi-step outreach that stops itself when someone replies." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>New sequence</Button>} />
      {!isLoading && !sequences.length && <Empty icon={<Workflow size={24} />} title="No sequences yet" action={<Button variant="primary" onClick={() => setCreate(true)}>Create one</Button>}>A sequence is a few emails with waits in between. Enroll contacts, activate it, and Tern sends within the account's window with natural gaps.</Empty>}
      <div className="grid-cards">
        {visible.map((s) => <SequenceCard key={s.id} s={s} onOpen={() => nav(`/sequences/${s.id}`)} onStatus={(st) => setStatus(s.id, st)} />)}
      </div>
      {archived.length > 0 && <><h4 className="mt-24 mb-8">Archived</h4><div className="grid-cards">{archived.map((s) => <SequenceCard key={s.id} s={s} onOpen={() => nav(`/sequences/${s.id}`)} onStatus={(st) => setStatus(s.id, st)} />)}</div></>}
      <Modal open={create} onClose={() => { setCreate(false); setParams((p) => { p.delete('new'); return p; }); }} title="New sequence" footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={doCreate}>Create</Button></>}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Warm intro · Q4 customers" /></Field>
        <Field label="Sending account" hint="Every email in this sequence goes out from this mailbox and counts against its daily cap."><Select value={acc} onChange={(e) => setAcc(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt;</option>)}{!accounts.length && <option value="">Connect an account first</option>}</Select></Field>
        <Field label="Description (optional)"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ minHeight: 60 }} /></Field>
        <div className="help-text">Starts as a draft with a three-step skeleton: email, wait 3 days, follow-up in the same thread.</div>
      </Modal>
    </div>
  );
}

function SequenceCard({ s, onOpen, onStatus }: { s: any; onOpen: () => void; onStatus: (st: string) => void }) {
  const st = s.stats ?? {};
  const replyRate = s.sent_count ? Math.round((100 * (s.reply_count ?? 0)) / s.sent_count) : 0;
  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="card-title"><h2 className="truncate">{s.name}</h2><Badge kind={STATUS_KIND[s.status]} dot>{s.status}</Badge></div>
      <div className="small muted mb-8 truncate">{s.step_count} step{s.step_count === 1 ? '' : 's'} · {s.account_email ?? <span style={{ color: 'var(--warning)' }}>no sending account</span>}{s.ai_mode !== 'off' ? ` · AI ${s.ai_mode}` : ''}</div>
      <div className="sequence-status mb-8">
        <span className="s"><b>{Number(st.active ?? 0) + Number(st.waiting_review ?? 0)}</b> in progress</span>
        <span className="s"><b>{st.replied ?? 0}</b> replied</span>
        <span className="s"><b>{st.finished ?? 0}</b> finished</span>
        {Number(st.bounced ?? 0) + Number(st.unsubscribed ?? 0) > 0 && <span className="s"><b>{Number(st.bounced ?? 0) + Number(st.unsubscribed ?? 0)}</b> dropped</span>}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small faint">{s.sent_count ?? 0} sent · {replyRate}% reply rate</span>
        <div className="row gap-4" onClick={(e) => e.stopPropagation()}>
          {s.status === 'active' ? <Button size="sm" icon={<Pause size={13} />} onClick={() => onStatus('paused')}>Pause</Button> : s.status !== 'archived' ? <Button size="sm" icon={<Play size={13} />} onClick={() => onStatus('active')}>Activate</Button> : <Button size="sm" onClick={() => onStatus('draft')}>Restore</Button>}
          {s.status !== 'archived' && <Button size="sm" variant="ghost" icon={<Archive size={13} />} onClick={() => onStatus('archived')}>Archive</Button>}
        </div>
      </div>
    </div>
  );
}
