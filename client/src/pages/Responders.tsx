import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pencil, Plus, Trash2, FlaskConical, Sparkles, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useAiStatus } from '../lib/queries';
import { Badge, Button, Callout, Confirm, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Textarea, Toggle } from '../components/ui';
import { ConditionsEditor, type Condition } from '../components/Conditions';
import { fmtRelative } from '../lib/format';

const MODE_LABEL: Record<string, string> = { draft: 'Draft a reply', review: 'Queue for review', send: 'Send automatically' };
const MODE_KIND: Record<string, any> = { draft: undefined, review: 'warning', send: 'danger' };

export default function RespondersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['responders'], queryFn: () => api.get<{ responders: any[]; jobs: any[] }>('/api/responders'), refetchInterval: 30_000 });
  const { data: ai } = useAiStatus();
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any>(null);
  const [testing, setTesting] = useState<any>(null);
  const [testResult, setTestResult] = useState<any>(null);
  const responders = data?.responders ?? [];
  const jobs = data?.jobs ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['responders'] });
  const aiDown = ai && (!ai.settings.enabled || !ai.health.ok || !ai.modelInstalled);
  async function toggle(r: any) { await api.put(`/api/responders/${r.id}`, { enabled: !r.enabled }); invalidate(); }
  async function test(r: any) {
    setTesting(r); setTestResult(null);
    try { setTestResult(await api.post(`/api/responders/${r.id}/test`, {})); } catch (e) { toast.error(e); setTesting(null); }
  }
  return (
    <div className="page page-narrow">
      <PageHeader title="AI responders" sub="Answer incoming mail with the model: as a ready-to-send draft, through the review queue, or fully automatically." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New responder</Button>} />
      {aiDown && <Callout kind="warning">The assistant is not available right now ({!ai!.settings.enabled ? 'turned off' : !ai!.health.ok ? 'model server unreachable' : 'model not downloaded'}). Responders will queue and run once it is back. Fix it under Settings → AI.</Callout>}
      {!isLoading && !responders.length && <Empty icon={<Bot size={24} />} title="No responders yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Create one</Button>}>Start in draft mode: every matching message gets a suggested reply waiting in the thread and in Drafts. Move to automatic sending once you trust what it writes.</Empty>}
      <div className="col gap-12">
        {responders.map((r) => (
          <div key={r.id} className="card" style={{ padding: '12px 16px' }}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <Toggle checked={r.enabled} onChange={() => toggle(r)} />
              <div className="flex-1">
                <div className="row wrap gap-4"><span className="strong">{r.name}</span><Badge kind={MODE_KIND[r.mode]} dot>{MODE_LABEL[r.mode]}</Badge>{r.account_email ? <Badge>{r.account_email}</Badge> : <Badge>all accounts</Badge>}{!r.enabled && <Badge>off</Badge>}</div>
                <div className="small muted mt-8">{(r.conditions ?? []).length ? `If ${r.match} of: ${r.conditions.map((c: any) => `${c.field} ${c.op.replace('_', ' ')} "${c.value ?? ''}"`).join(' · ')}` : 'Every inbound message'}{r.only_contacts ? ' · contacts only' : ''}{r.skip_lists ? ' · skips lists and notifications' : ''} · {r.tone}, {r.length} · cap {r.daily_cap}/day · once per thread per {r.cooldown_hours}h{r.humanize && r.mode === 'send' ? ' · sends with natural delay' : ''}</div>
                {r.instructions && <div className="small mt-8" style={{ fontStyle: 'italic' }}>"{r.instructions}"</div>}
                <div className="small faint mt-8">{r.hits} matched · {r.draft_count} drafts · {r.sent_count} sent{r.pending_count ? ` · ${r.pending_count} awaiting review` : ''}</div>
              </div>
              <div className="row gap-4">
                <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => test(r)}>Try it</Button>
                <IconButton label="Edit" className="btn-sm" onClick={() => setEditing(r)}><Pencil size={14} /></IconButton>
                <IconButton label="Delete" className="btn-sm" onClick={() => setDel(r)}><Trash2 size={14} /></IconButton>
              </div>
            </div>
          </div>
        ))}
      </div>
      {jobs.length > 0 && (
        <div className="card mt-24">
          <div className="card-title"><h2>Recent activity</h2></div>
          <div className="table-wrap"><table className="table"><tbody>{jobs.map((j) => <tr key={j.id}><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtRelative(j.created_at)}</td><td className="small">{responders.find((r) => String(r.id) === String(j.responder_id))?.name ?? `responder ${j.responder_id}`}</td><td><Badge kind={j.status === 'failed' ? 'danger' : j.status === 'done' ? 'success' : 'accent'}>{j.status}</Badge></td><td className="small muted">{j.result ?? j.error ?? ''}</td></tr>)}</tbody></table></div>
        </div>
      )}
      {editing && <ResponderEditor responder={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete responder "${del?.name}"?`} confirmLabel="Delete" onConfirm={async () => { await api.del(`/api/responders/${del.id}`); invalidate(); }} />
      <Modal open={Boolean(testing)} onClose={() => { setTesting(null); setTestResult(null); }} title={`Dry run: ${testing?.name ?? ''}`} size="wide" footer={<Button onClick={() => { setTesting(null); setTestResult(null); }}>Close</Button>}>
        {!testResult ? <div className="row"><Sparkles size={15} /> Generating a reply to the latest inbound message… (nothing is sent)</div> : (
          <>
            <div className="card mb-16" style={{ padding: 12 }}><div className="small muted">Replying to</div><div className="strong">{testResult.email.subject || '(no subject)'}</div><div className="small muted">{testResult.email.from?.[0]?.email} · {testResult.email.preview}</div></div>
            {testResult.wouldSkipAsList && <Callout kind="warning"><AlertTriangle size={14} /> This message looks like a list or notification; the responder would skip it because "skip lists" is on.</Callout>}
            <div className="small muted mt-8">To: {testResult.to.map((t: any) => t.email).join(', ')} · Subject: {testResult.subject} · {testResult.model}</div>
            <div className="card mt-8 pre" style={{ fontSize: 13.5 }}>{testResult.text}</div>
          </>
        )}
      </Modal>
    </div>
  );
}

function ResponderEditor({ responder, onClose, onSaved }: { responder: any | 'new'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data: accounts = [] } = useAccounts();
  const isNew = responder === 'new';
  const [f, setF] = useState<any>(isNew ? { name: '', account_id: null, mode: 'draft', match: 'all', conditions: [] as Condition[], only_contacts: false, skip_lists: true, instructions: '', tone: 'friendly', length: 'medium', reply_all: false, humanize: true, daily_cap: 20, cooldown_hours: 24, enabled: true } : { ...responder });
  const [busy, setBusy] = useState(false);
  const set = (p: any) => setF((x: any) => ({ ...x, ...p }));
  async function save() {
    if (!f.name.trim()) { toast.error('Give it a name'); return; }
    if (f.mode === 'send' && !confirm('Send automatically means replies go out without anyone reading them first. Continue?')) return;
    setBusy(true);
    try {
      const body = { name: f.name, account_id: f.account_id || null, enabled: f.enabled, mode: f.mode, match: f.match, conditions: f.conditions, only_contacts: f.only_contacts, skip_lists: f.skip_lists, instructions: f.instructions, tone: f.tone, length: f.length, reply_all: f.reply_all, humanize: f.humanize, daily_cap: Number(f.daily_cap), cooldown_hours: Number(f.cooldown_hours) };
      if (isNew) await api.post('/api/responders', body); else await api.put(`/api/responders/${responder.id}`, body);
      onSaved(); onClose(); toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={isNew ? 'New responder' : 'Edit responder'} size="wide" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-row">
        <Field label="Name"><Input autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Answer customer questions" /></Field>
        <Field label="Account"><Select value={f.account_id ?? ''} onChange={(e) => set({ account_id: e.target.value ? Number(e.target.value) : null })}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select></Field>
      </div>
      <Field label="What happens with the reply">
        <Select value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
          <option value="draft">Draft: save a suggested reply in the thread and in Drafts, you send it</option>
          <option value="review">Review: queue it under AI review; approving sends it</option>
          <option value="send">Send automatically (no human in the loop)</option>
        </Select>
      </Field>
      {f.mode === 'send' && <Callout kind="danger">Automatic replies leave in your name. Keep "skip lists" on, keep the cap low, and consider "contacts only" so strangers and scanners never get an answer.</Callout>}
      <Field label="Instructions for the model" hint="What the reply should do, in plain words. The model also sees the whole thread, the contact's notes, the account's writing voice and the system prompt from Settings → AI." className="mt-16"><Textarea value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="Thank them, answer what you can from the thread, and offer a 20 minute call. If they ask about pricing, say a proposal will follow within a day. Never promise discounts." /></Field>
      <div className="form-grid-3">
        <Field label="Tone"><Select value={f.tone} onChange={(e) => set({ tone: e.target.value })}>{['friendly', 'professional', 'casual', 'direct', 'warm', 'formal', 'enthusiastic'].map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <Field label="Length"><Select value={f.length} onChange={(e) => set({ length: e.target.value })}><option value="short">short</option><option value="medium">medium</option><option value="long">long</option></Select></Field>
        <Field label="Recipients"><Select value={f.reply_all ? '1' : '0'} onChange={(e) => set({ reply_all: e.target.value === '1' })}><option value="0">Reply to sender</option><option value="1">Reply all</option></Select></Field>
      </div>
      <div className="field"><label>Which messages</label><ConditionsEditor conditions={f.conditions} onChange={(c) => set({ conditions: c })} match={f.match} onMatchChange={(m) => set({ match: m })} emptyHint="no conditions means every inbound message" /></div>
      <div className="row mb-8"><Toggle checked={f.skip_lists} onChange={(v) => set({ skip_lists: v })} /><span className="small">Skip newsletters, notifications, no-reply senders and anything with list headers</span></div>
      <div className="row mb-8"><Toggle checked={f.only_contacts} onChange={(v) => set({ only_contacts: v })} /><span className="small">Only answer people in Contacts</span></div>
      <div className="row mb-16"><Toggle checked={f.humanize} onChange={(v) => set({ humanize: v })} /><span className="small">When sending, respect the account's send window, daily cap and randomised delay</span></div>
      <div className="form-row">
        <Field label="Daily cap" hint="Replies this responder may produce per day."><Input type="number" min={1} max={500} value={f.daily_cap} onChange={(e) => set({ daily_cap: e.target.value })} /></Field>
        <Field label="Once per thread every (hours)" hint="Stops back-and-forth loops with other bots."><Input type="number" min={1} max={720} value={f.cooldown_hours} onChange={(e) => set({ cooldown_hours: e.target.value })} /></Field>
      </div>
      <div className="help-text">Auto-replies, out-of-office notices, bounces and messages already answered by you are always skipped.</div>
    </Modal>
  );
}
