import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListFilter, Loader2, Pencil, Play, Plus, Sparkles, Trash2, ArrowUp, ArrowDown, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useMailboxes } from '../lib/queries';
import { Badge, Button, Confirm, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Toggle } from '../components/ui';
import { ConditionsEditor } from '../components/Conditions';
import { DictateButton } from '../components/Dictate';
import { useCan } from '../state/features';
import { postWithWork } from '../lib/work';
const ACTIONS = [['archive', 'Skip the inbox (archive)'], ['mark_read', 'Mark as read'], ['star', 'Star it'], ['label', 'Apply label'], ['trash', 'Delete it'], ['spam', 'Mark as junk']];

export default function RulesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ rules: any[] }>('/api/rules') });
  const rules = data?.rules ?? [];
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['rules'] });
  async function toggle(r: any) { await api.put(`/api/rules/${r.id}`, { enabled: !r.enabled }); invalidate(); }
  async function run(r: any) { try { const res = await api.post<any>(`/api/rules/${r.id}/run`); toast.success(`Applied to ${res.matched} message${res.matched === 1 ? '' : 's'} in the inbox`); invalidate(); } catch (e) { toast.error(e); } }
  async function reorder(i: number, d: number) { const ids = rules.map((r) => r.id); const [x] = ids.splice(i, 1); ids.splice(i + d, 0, x); await api.post('/api/rules/reorder', { ids }); invalidate(); }
  return (
    <div className="page page-narrow">
      <PageHeader title="Inbox rules" sub="Run on every new message as it arrives. Rules apply top to bottom; a rule that deletes or marks junk stops the chain." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New rule</Button>} />
      {!isLoading && !rules.length && <Empty icon={<ListFilter size={24} />} title="No rules yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Create a rule</Button>}>Archive newsletters, label anything from a domain, star messages that mention an invoice, and keep the inbox for people.</Empty>}
      <div className="col gap-12">
        {rules.map((r, i) => (
          <div key={r.id} className="card" style={{ padding: '12px 16px' }}>
            <div className="row">
              <Toggle checked={r.enabled} onChange={() => toggle(r)} />
              <div className="flex-1">
                <div className="strong">{r.name} {!r.enabled && <Badge>off</Badge>}{r.account_email && <Badge>{r.account_email}</Badge>}</div>
                <div className="small muted">If {r.match === 'any' ? 'any' : 'all'} of: {(r.conditions ?? []).map((c: any) => `${c.field} ${c.op.replace('_', ' ')} "${c.value ?? ''}"`).join(' · ')} → {(r.actions ?? []).map((a: any) => ACTIONS.find(([k]) => k === a.type)?.[1] ?? a.type).join(', ')} · matched {r.hits} time{r.hits === 1 ? '' : 's'}</div>
              </div>
              <div className="row gap-4">
                <IconButton label="Move up" className="btn-sm" disabled={i === 0} onClick={() => reorder(i, -1)}><ArrowUp size={14} /></IconButton>
                <IconButton label="Move down" className="btn-sm" disabled={i === rules.length - 1} onClick={() => reorder(i, 1)}><ArrowDown size={14} /></IconButton>
                <Button size="sm" icon={<Play size={13} />} onClick={() => run(r)}>Run on inbox</Button>
                <IconButton label="Edit" className="btn-sm" onClick={() => setEditing(r)}><Pencil size={14} /></IconButton>
                <IconButton label="Delete" className="btn-sm" onClick={() => setDel(r)}><Trash2 size={14} /></IconButton>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete rule "${del?.name}"?`} confirmLabel="Delete" onConfirm={async () => { await api.del(`/api/rules/${del.id}`); invalidate(); }} />
    </div>
  );
}

function RuleEditor({ rule, onClose, onSaved }: { rule: any | 'new'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data: accounts = [] } = useAccounts();
  const { data: mailboxes = [] } = useMailboxes();
  const isNew = rule === 'new';
  const [name, setName] = useState(isNew ? '' : rule.name);
  const [accountId, setAccountId] = useState<number | ''>(isNew ? '' : rule.account_id ?? '');
  const [match, setMatch] = useState<'all' | 'any'>(isNew ? 'all' : rule.match);
  const [conds, setConds] = useState<any[]>(isNew ? [{ field: 'from', op: 'contains', value: '' }] : rule.conditions);
  const [acts, setActs] = useState<any[]>(isNew ? [{ type: 'archive' }] : rule.actions);
  const [busy, setBusy] = useState(false);
  const [sentence, setSentence] = useState('');
  const [describing, setDescribing] = useState(false);
  const canDescribe = useCan('nlrules');
  const labels = mailboxes.filter((m) => !m.role && (accountId === '' || m.account_id === accountId));
  async function save() {
    setBusy(true);
    try {
      const body = { name, account_id: accountId === '' ? null : accountId, match, conditions: conds, actions: acts };
      if (isNew) await api.post('/api/rules', body); else await api.put(`/api/rules/${rule.id}`, body);
      onSaved(); onClose(); toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  // F7: a sentence becomes a draft of a rule, filled into this form. The
  // model runs once, here, and what it produces is editable before it is
  // saved — after that the rule executes deterministically for ever and no
  // model is in the loop.
  async function describe(text: string) {
    setDescribing(true);
    try {
      const r = await postWithWork<{ draft: { name: string; match: 'all' | 'any'; conditions: any[]; actions: any[] } }>('ai', '/api/assist/rule', { text });
      if (!name.trim()) setName(r.draft.name);
      setMatch(r.draft.match);
      setConds(r.draft.conditions);
      setActs(r.draft.actions);
      setSentence('');
      toast.success('Filled in below — check it before saving');
    } catch (e) { toast.error(e); } finally { setDescribing(false); }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'New rule' : 'Edit rule'} size="wide" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !conds.length || !acts.length} onClick={save}>Save</Button></>}>
      {canDescribe && (
        <div className="describe-row">
          <Input
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && sentence.trim().length > 3) { e.preventDefault(); void describe(sentence.trim()); } }}
            placeholder="Describe it: “when a receipt from Stripe arrives, label it Finance and skip the inbox”"
          />
          <DictateButton title="Describe the rule out loud" onText={(t) => setSentence((v) => (v ? `${v} ${t}` : t))} />
          <Button icon={describing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} loading={describing} disabled={sentence.trim().length < 4} onClick={() => void describe(sentence.trim())}>
            Fill in
          </Button>
        </div>
      )}
      <div className="form-row">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Newsletters out of the inbox" /></Field>
        <Field label="Applies to"><Select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select></Field>
      </div>
      <div className="field"><ConditionsEditor conditions={conds} onChange={setConds} match={match} onMatchChange={setMatch} /></div>
      <Field label="Then">
        {acts.map((a, i) => (
          <div key={i} className="row mb-8">
            <Select className="input-sm" style={{ width: 220 }} value={a.type} onChange={(e) => setActs((l) => l.map((x, j) => (j === i ? { type: e.target.value } : x)))}>{ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            {a.type === 'label' && <Select className="input-sm" style={{ width: 220 }} value={a.mailboxId ?? ''} onChange={(e) => setActs((l) => l.map((x, j) => (j === i ? { ...x, mailboxId: e.target.value } : x)))}><option value="">— choose label —</option>{labels.map((m) => <option key={m.jmap_id} value={m.jmap_id}>{m.name}{accounts.length > 1 ? ` (${accounts.find((x) => x.id === m.account_id)?.email})` : ''}</option>)}</Select>}
            <IconButton label="Remove" className="btn-sm" onClick={() => setActs((l) => l.filter((_, j) => j !== i))}><X size={14} /></IconButton>
          </div>
        ))}
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setActs((l) => [...l, { type: 'mark_read' }])}>Add action</Button>
      </Field>
      <div className="help-text">
        Rules only run on messages that arrive in the inbox. Use "Run on inbox" afterwards to apply a new rule to what is already there.
        {canDescribe && ' A rule written from a sentence is a draft: once you save it, it runs exactly as shown here and the model is not involved again.'}
      </div>
    </Modal>
  );
}
