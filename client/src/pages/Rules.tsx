import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListFilter, Pencil, Play, Plus, Trash2, ArrowUp, ArrowDown, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useMailboxes } from '../lib/queries';
import { Badge, Button, Confirm, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Toggle } from '../components/ui';

const FIELDS = [['from', 'From'], ['to', 'To'], ['cc', 'Cc'], ['subject', 'Subject'], ['body', 'Body'], ['any', 'Anywhere'], ['list', 'Mailing list header'], ['has_attachment', 'Has attachment']];
const OPS = [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'is exactly'], ['starts_with', 'starts with'], ['ends_with', 'ends with'], ['matches', 'matches regex']];
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
  const labels = mailboxes.filter((m) => !m.role && (accountId === '' || m.account_id === accountId));
  async function save() {
    setBusy(true);
    try {
      const body = { name, account_id: accountId === '' ? null : accountId, match, conditions: conds, actions: acts };
      if (isNew) await api.post('/api/rules', body); else await api.put(`/api/rules/${rule.id}`, body);
      onSaved(); onClose(); toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={isNew ? 'New rule' : 'Edit rule'} size="wide" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !conds.length || !acts.length} onClick={save}>Save</Button></>}>
      <div className="form-row">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Newsletters out of the inbox" /></Field>
        <Field label="Applies to"><Select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select></Field>
      </div>
      <Field label={<span>When <select className="select input-sm" style={{ width: 80, display: 'inline-block', margin: '0 4px' }} value={match} onChange={(e) => setMatch(e.target.value as any)}><option value="all">all</option><option value="any">any</option></select> of these match</span> as any}>
        {conds.map((c, i) => (
          <div key={i} className="row mb-8">
            <Select className="input-sm" style={{ width: 170 }} value={c.field} onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, field: e.target.value, op: e.target.value === 'has_attachment' ? 'is_true' : x.op === 'is_true' || x.op === 'is_false' ? 'contains' : x.op } : x)))}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            {c.field === 'has_attachment' ? <Select className="input-sm" style={{ width: 120 }} value={c.op} onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}><option value="is_true">yes</option><option value="is_false">no</option></Select> : <>
              <Select className="input-sm" style={{ width: 170 }} value={c.op} onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Input className="input-sm" value={c.value ?? ''} onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={c.field === 'from' ? 'newsletter@ or @example.com' : 'text'} />
            </>}
            <IconButton label="Remove" className="btn-sm" onClick={() => setConds((l) => l.filter((_, j) => j !== i))}><X size={14} /></IconButton>
          </div>
        ))}
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setConds((l) => [...l, { field: 'subject', op: 'contains', value: '' }])}>Add condition</Button>
      </Field>
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
      <div className="help-text">Rules only run on messages that arrive in the inbox. Use "Run on inbox" afterwards to apply a new rule to what is already there.</div>
    </Modal>
  );
}
