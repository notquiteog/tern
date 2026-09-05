import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, Clock, Eye, Mail, Pause, Play, Plus, Sparkles, Trash2, UserPlus, Users, Archive, Save, RotateCcw, SkipForward, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useContactTags, useTemplates } from '../lib/queries';
import { Badge, Button, Callout, Confirm, Field, IconButton, Input, Modal, Select, Spinner, Textarea, Toggle, Tabs } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { MERGE_FIELDS } from './Templates';
import { fmtDateTime, fmtDuration, plural } from '../lib/format';

interface Step { id?: number; kind: 'email' | 'wait'; template_id: number | null; subject: string; body_html: string; wait_days: number; wait_hours: number; ai_personalize: boolean; ai_instructions: string; reply_in_thread: boolean }

export default function SequenceEditorPage() {
  const { id } = useParams();
  const sid = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['sequence', sid], queryFn: () => api.get<any>(`/api/sequences/${sid}`) });
  const { data: accounts = [] } = useAccounts();
  const { data: templates = [] } = useTemplates();
  const [seq, setSeq] = useState<any>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'steps' | 'enrollments' | 'settings'>('steps');
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [del, setDel] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) { setSeq(data.sequence); setSteps(data.steps.map((s: any) => ({ id: s.id, kind: s.kind, template_id: s.template_id, subject: s.subject, body_html: s.body_html, wait_days: s.wait_days, wait_hours: s.wait_hours, ai_personalize: s.ai_personalize, ai_instructions: s.ai_instructions, reply_in_thread: s.reply_in_thread }))); setDirty(false); } }, [data]);
  const stepStats = useMemo(() => new Map((data?.stepStats ?? []).map((s: any) => [s.step_id, s])), [data]);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/api/sequences/${sid}`, { name: seq.name, description: seq.description, account_id: seq.account_id, stop_on_reply: seq.stop_on_reply, ai_mode: seq.ai_mode, unsubscribe_footer: seq.unsubscribe_footer, steps });
      qc.invalidateQueries({ queryKey: ['sequence', sid] }); qc.invalidateQueries({ queryKey: ['sequences'] });
      setDirty(false); toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  }
  async function setStatus(status: string) {
    if (dirty) await save();
    try { await api.post(`/api/sequences/${sid}/status`, { status }); qc.invalidateQueries({ queryKey: ['sequence', sid] }); qc.invalidateQueries({ queryKey: ['sequences'] }); toast.success(status === 'active' ? 'Sequence is live' : `Sequence ${status}`); } catch (e) { toast.error(e); }
  }
  async function doPreview() {
    if (dirty) await save();
    try { setPreview(await api.get(`/api/sequences/${sid}/preview`)); } catch (e) { toast.error(e); }
  }
  const updStep = (i: number, patch: Partial<Step>) => { setSteps((s) => s.map((st, j) => (j === i ? { ...st, ...patch } : st))); setDirty(true); };
  const move = (i: number, d: number) => { setSteps((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; }); setDirty(true); };
  const addStep = (kind: 'email' | 'wait') => { setSteps((s) => [...s, { kind, template_id: null, subject: '', body_html: '', wait_days: kind === 'wait' ? 3 : 0, wait_hours: 0, ai_personalize: false, ai_instructions: '', reply_in_thread: true }]); setDirty(true); };

  if (isLoading || !seq) return <div className="center" style={{ padding: 60 }}><Spinner size={24} /></div>;
  const st = seq.stats ?? {};
  const emailSteps = steps.filter((s) => s.kind === 'email').length;
  return (
    <div className="page">
      <div className="row mb-16" style={{ alignItems: 'flex-start' }}>
        <IconButton label="Back" onClick={() => nav('/sequences')}><ChevronLeft size={18} /></IconButton>
        <div className="flex-1">
          <input className="input" style={{ fontSize: 20, fontWeight: 600, height: 40, border: 0, background: 'transparent', padding: 0 }} value={seq.name} onChange={(e) => { setSeq({ ...seq, name: e.target.value }); setDirty(true); }} />
          <div className="row wrap gap-4 small muted">
            <Badge kind={seq.status === 'active' ? 'success' : seq.status === 'paused' ? 'warning' : undefined} dot>{seq.status}</Badge>
            <span>{emailSteps} email{emailSteps === 1 ? '' : 's'}</span>
            <span>· {seq.account_email ?? 'no sending account'}</span>
            <span>· {Number(st.active ?? 0) + Number(st.waiting_review ?? 0)} in progress, {st.replied ?? 0} replied, {st.finished ?? 0} finished</span>
          </div>
        </div>
        <div className="row gap-4 wrap">
          <Button icon={<Eye size={15} />} onClick={doPreview}>Preview</Button>
          <Button icon={<UserPlus size={15} />} onClick={() => setEnrollOpen(true)}>Enroll contacts</Button>
          {seq.status === 'active' ? <Button icon={<Pause size={15} />} onClick={() => setStatus('paused')}>Pause</Button> : <Button variant="primary" icon={<Play size={15} />} onClick={() => setStatus('active')} disabled={!seq.account_id || !emailSteps}>Activate</Button>}
          <Button variant={dirty ? 'primary' : 'default'} icon={<Save size={15} />} loading={saving} disabled={!dirty} onClick={save}>{dirty ? 'Save changes' : 'Saved'}</Button>
        </div>
      </div>
      {!seq.account_id && <Callout kind="warning">Choose a sending account in Settings before activating.</Callout>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'steps', label: 'Steps' }, { value: 'enrollments', label: <>Enrollments <Badge>{st.total ?? 0}</Badge></> }, { value: 'settings', label: 'Settings' }]} />
      {tab === 'steps' && (
        <div style={{ maxWidth: 820 }}>
          {steps.map((s, i) => (
            <div key={s.id ?? `new-${i}`}>
              {i > 0 && <div className="step-line" />}
              <StepCard step={s} index={i} stats={s.id ? stepStats.get(s.id) : undefined} templates={templates} onChange={(p) => updStep(i, p)} onMove={(d) => move(i, d)} onRemove={() => { setSteps((st) => st.filter((_, j) => j !== i)); setDirty(true); }} first={i === 0} last={i === steps.length - 1} aiMode={seq.ai_mode} />
            </div>
          ))}
          <div className="row mt-16"><Button icon={<Mail size={15} />} onClick={() => addStep('email')}>Add email</Button><Button icon={<Clock size={15} />} onClick={() => addStep('wait')}>Add wait</Button></div>
          <div className="help-text mt-16">Every email is sent from the account's mailbox, threads as a reply when "same thread" is on, and stops for a contact the moment they reply (see Settings). Sends follow the account's daily cap, send window and randomised delay.</div>
        </div>
      )}
      {tab === 'enrollments' && <Enrollments sid={sid} />}
      {tab === 'settings' && (
        <div style={{ maxWidth: 640 }}>
          <Field label="Sending account"><Select value={seq.account_id ?? ''} onChange={(e) => { setSeq({ ...seq, account_id: Number(e.target.value) || null }); setDirty(true); }}><option value="">— choose —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt; · cap {a.daily_cap}/day</option>)}</Select></Field>
          <Field label="Description"><Textarea value={seq.description ?? ''} onChange={(e) => { setSeq({ ...seq, description: e.target.value }); setDirty(true); }} style={{ minHeight: 60 }} /></Field>
          <div className="row mb-16"><Toggle checked={seq.stop_on_reply} onChange={(v) => { setSeq({ ...seq, stop_on_reply: v }); setDirty(true); }} /><div><div className="strong small">Stop when the contact replies</div><div className="help-text">Detected from reply headers and from the contact's address. Out-of-office auto-replies do not count.</div></div></div>
          <div className="row mb-16"><Toggle checked={seq.unsubscribe_footer} onChange={(v) => { setSeq({ ...seq, unsubscribe_footer: v }); setDirty(true); }} /><div><div className="strong small">Add an unsubscribe line and List-Unsubscribe headers</div><div className="help-text">One click removes the contact and adds them to the suppression list. Required by CAN-SPAM for commercial mail; the physical address is set in Settings → General.</div></div></div>
          <Field label="AI personalisation" hint="Applies to steps with 'AI personalise' turned on.">
            <Select value={seq.ai_mode} onChange={(e) => { setSeq({ ...seq, ai_mode: e.target.value }); setDirty(true); }}>
              <option value="review">Review: drafts wait for approval in AI review</option>
              <option value="auto">Auto: send the model's draft without review</option>
              <option value="off">Off: send the template as written</option>
            </Select>
          </Field>
          <div className="divider" />
          <div className="row"><Button variant="ghost" icon={<Archive size={15} />} onClick={() => setStatus('archived')}>Archive sequence</Button><Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setDel(true)} style={{ color: 'var(--danger)' }}>Delete</Button></div>
        </div>
      )}
      <EnrollDialog open={enrollOpen} onClose={() => setEnrollOpen(false)} sid={sid} onDone={() => { qc.invalidateQueries({ queryKey: ['sequence', sid] }); qc.invalidateQueries({ queryKey: ['enrollments', sid] }); setTab('enrollments'); }} />
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title="Preview for a sample contact" size="wide">
        {preview?.preview?.map((p: any, i: number) => p.kind === 'wait' ? <div key={i} className="row small muted mb-16"><Clock size={14} /> wait {fmtDuration(p.step.wait_days, p.step.wait_hours)}</div> : <div key={i} className="card mb-16"><div className="strong mb-8">{p.subject || '(no subject)'}{p.step.ai_personalize && <Badge kind="accent"><Sparkles size={12} /> AI rewrites this per contact</Badge>}</div><div className="msg-text" dangerouslySetInnerHTML={{ __html: p.html }} />{p.brief && <div className="small muted mt-8">Brief: {p.brief}</div>}</div>)}
      </Modal>
      <Confirm open={del} onClose={() => setDel(false)} danger title="Delete this sequence?" message="Enrollments are removed. Sent messages stay in the mailbox and the send log." confirmLabel="Delete" onConfirm={async () => { await api.del(`/api/sequences/${sid}`); qc.invalidateQueries({ queryKey: ['sequences'] }); nav('/sequences'); }} />
    </div>
  );
}

function StepCard({ step, index, stats, templates, onChange, onMove, onRemove, first, last, aiMode }: { step: Step; index: number; stats?: any; templates: any[]; onChange: (p: Partial<Step>) => void; onMove: (d: number) => void; onRemove: () => void; first: boolean; last: boolean; aiMode: string }) {
  const editor = useRef<EditorHandle>(null);
  const [open, setOpen] = useState(step.kind === 'email' && !step.subject && !step.body_html && !step.template_id);
  if (step.kind === 'wait') {
    return (
      <div className="step-card wait">
        <div className="step-num"><Clock size={14} /></div>
        <div className="flex-1 row wrap"><span className="strong small">Wait</span><Input type="number" min={0} max={365} className="input-sm" style={{ width: 80 }} value={step.wait_days} onChange={(e) => onChange({ wait_days: Number(e.target.value) })} /><span className="small">days</span><Input type="number" min={0} max={23} className="input-sm" style={{ width: 70 }} value={step.wait_hours} onChange={(e) => onChange({ wait_hours: Number(e.target.value) })} /><span className="small">hours</span></div>
        <div className="row gap-4"><IconButton label="Move up" className="btn-sm" disabled={first} onClick={() => onMove(-1)}><ArrowUp size={14} /></IconButton><IconButton label="Move down" className="btn-sm" disabled={last} onClick={() => onMove(1)}><ArrowDown size={14} /></IconButton><IconButton label="Remove" className="btn-sm" onClick={onRemove}><Trash2 size={14} /></IconButton></div>
      </div>
    );
  }
  const tpl = templates.find((t) => t.id === step.template_id);
  return (
    <div className="step-card" style={{ flexDirection: 'column', gap: 10 }}>
      <div className="row">
        <div className="step-num">{index + 1}</div>
        <div className="flex-1" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
          <div className="strong">{step.subject || tpl?.subject || <span className="faint">Email step</span>}</div>
          <div className="small muted">{tpl ? `Template: ${tpl.name}` : 'Custom content'}{step.reply_in_thread && index > 0 ? ' · same thread' : ''}{step.ai_personalize ? ` · AI personalise (${aiMode})` : ''}{stats ? ` · ${stats.sent} sent, ${stats.replied} replied${stats.bounced ? `, ${stats.bounced} bounced` : ''}` : ''}</div>
        </div>
        <div className="row gap-4"><IconButton label="Move up" className="btn-sm" disabled={first} onClick={() => onMove(-1)}><ArrowUp size={14} /></IconButton><IconButton label="Move down" className="btn-sm" disabled={last} onClick={() => onMove(1)}><ArrowDown size={14} /></IconButton><IconButton label="Remove" className="btn-sm" onClick={onRemove}><Trash2 size={14} /></IconButton></div>
      </div>
      {open && (
        <div>
          <div className="form-row">
            <Field label="Template" hint="Or write custom content below."><Select value={step.template_id ?? ''} onChange={(e) => { const t = templates.find((x) => x.id === Number(e.target.value)); onChange({ template_id: t ? t.id : null }); if (t) { onChange({ template_id: t.id, subject: '', body_html: '' }); editor.current?.setHtml(''); } }}><option value="">— custom —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            <Field label="Subject" hint={index > 0 ? 'Leave empty to reply in the same thread with "Re:"' : 'Merge fields work here too.'}><Input value={step.subject} onChange={(e) => onChange({ subject: e.target.value })} placeholder={tpl?.subject ?? 'Quick question about {{company}}'} /></Field>
          </div>
          {!step.template_id && <>
            <div className="row mb-8 wrap"><span className="small muted">Insert:</span>{MERGE_FIELDS.slice(0, 8).map((f) => <button key={f} type="button" className="tag" style={{ cursor: 'pointer', border: 0 }} onClick={() => editor.current?.insertHtml(`{{${f}}}`)}>{`{{${f}}}`}</button>)}</div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}><Editor ref={editor} initialHtml={step.body_html} minHeight={140} placeholder="Hi {{first_name|there}}," onChange={(h) => onChange({ body_html: h })} /></div>
          </>}
          {tpl && <div className="card small mt-8" style={{ padding: 12 }}><div className="strong mb-8">{tpl.subject}</div><div dangerouslySetInnerHTML={{ __html: tpl.body_html }} /></div>}
          <div className="row mt-16 wrap gap-16">
            {index > 0 && <div className="row"><Toggle checked={step.reply_in_thread} onChange={(v) => onChange({ reply_in_thread: v })} /><span className="small">Send as a reply in the same thread</span></div>}
            <div className="row"><Toggle checked={step.ai_personalize} onChange={(v) => onChange({ ai_personalize: v })} /><span className="small"><Sparkles size={13} /> AI personalise for each contact</span></div>
          </div>
          {step.ai_personalize && <Field label="Instructions for the model" hint={aiMode === 'off' ? 'AI mode is off in Settings; the template is sent as written.' : aiMode === 'review' ? 'Each draft waits in AI review before sending.' : 'Drafts send automatically; consider review mode first.'} className="mt-8"><Textarea value={step.ai_instructions} onChange={(e) => onChange({ ai_instructions: e.target.value })} placeholder="Mention something specific about their company from the notes. Keep it under 90 words. No exclamation marks." style={{ minHeight: 60 }} /></Field>}
        </div>
      )}
    </div>
  );
}

function EnrollDialog({ open, onClose, sid, onDone }: { open: boolean; onClose: () => void; sid: number; onDone: () => void }) {
  const toast = useToast();
  const { data: tags = [] } = useContactTags();
  const [mode, setMode] = useState<'tag' | 'search' | 'all'>('tag');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const { data: found } = useQuery({ queryKey: ['contacts-pick', q], queryFn: () => api.get<{ contacts: any[] }>(`/api/contacts?q=${encodeURIComponent(q)}&status=active&size=50`), enabled: open && mode === 'search' });
  useEffect(() => { if (tags.length && !tag) setTag(tags[0].tag); }, [tags, tag]);
  async function go() {
    setBusy(true);
    try {
      const body = mode === 'tag' ? { tag } : mode === 'all' ? { all: true } : { contactIds: [...picked] };
      const r = await api.post<any>(`/api/sequences/${sid}/enroll`, body);
      toast.success(`Enrolled ${r.enrolled}${r.skipped ? `, skipped ${r.skipped} already enrolled or inactive` : ''}${r.suppressed ? `, ${r.suppressed} suppressed` : ''}`);
      onDone(); onClose(); setPicked(new Set());
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Enroll contacts" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={mode === 'search' && !picked.size} onClick={go}>Enroll</Button></>}>
      <div className="tabs"><button className={mode === 'tag' ? 'active' : ''} onClick={() => setMode('tag')}>By tag</button><button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>Pick contacts</button><button className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>All active</button></div>
      {mode === 'tag' && (tags.length ? <Field label="Tag"><Select value={tag} onChange={(e) => setTag(e.target.value)}>{tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}</Select></Field> : <Callout>No tags yet. Tag contacts on import or in the contacts list.</Callout>)}
      {mode === 'search' && <>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search active contacts" className="mb-8" />
        <div style={{ maxHeight: 280, overflow: 'auto' }}>{(found?.contacts ?? []).map((c) => <label key={c.id} className="row" style={{ padding: '6px 4px', cursor: 'pointer' }}><input type="checkbox" className="checkbox" checked={picked.has(c.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} /><span className="flex-1 truncate">{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email} <span className="muted small">{c.email}</span></span></label>)}</div>
        <div className="small muted">{plural(picked.size, 'contact')} selected</div>
      </>}
      {mode === 'all' && <Callout kind="warning">Enrolls every active contact who is not already in this sequence. With the daily cap, a large list takes days to work through, which is the point.</Callout>}
    </Modal>
  );
}

function Enrollments({ sid }: { sid: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({ queryKey: ['enrollments', sid, status, page], queryFn: () => api.get<any>(`/api/sequences/${sid}/enrollments?status=${status}&page=${page}`), placeholderData: (p) => p });
  const rows = data?.enrollments ?? [];
  async function act(eid: number, action: string) {
    try { await api.post(`/api/sequences/${sid}/enrollments/${eid}`, { action }); qc.invalidateQueries({ queryKey: ['enrollments', sid] }); qc.invalidateQueries({ queryKey: ['sequence', sid] }); } catch (e) { toast.error(e); }
  }
  async function bulk(action: string) {
    try { await api.post(`/api/sequences/${sid}/enrollments-bulk`, { action, status: status || undefined }); qc.invalidateQueries({ queryKey: ['enrollments', sid] }); qc.invalidateQueries({ queryKey: ['sequence', sid] }); toast.success('Done'); } catch (e) { toast.error(e); }
  }
  const KIND: Record<string, any> = { active: 'accent', waiting_review: 'warning', paused: undefined, finished: 'success', replied: 'success', bounced: 'danger', unsubscribed: 'danger', error: 'danger' };
  return (
    <div>
      <div className="list-toolbar">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 200 }}><option value="">All statuses</option>{['active', 'waiting_review', 'paused', 'finished', 'replied', 'bounced', 'unsubscribed', 'error'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</Select>
        <div className="row gap-4 ml-auto"><Button size="sm" icon={<Pause size={13} />} onClick={() => bulk('pause')}>Pause all</Button><Button size="sm" icon={<Play size={13} />} onClick={() => bulk('resume')}>Resume paused</Button><Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => { if (confirm('Remove finished, replied, bounced and unsubscribed enrollments from the list?')) void bulk('remove'); }}>Clear finished</Button></div>
      </div>
      {isLoading ? <Spinner /> : !rows.length ? <div className="empty"><Users size={22} /><h3>No enrollments{status ? ' with this status' : ''}</h3></div> : (
        <table className="table"><thead><tr><th>Contact</th><th>Status</th><th>Step</th><th>Next send</th><th>Sent</th><th>Updated</th><th /></tr></thead><tbody>
          {rows.map((e: any) => <tr key={e.id}>
            <td><div className="strong">{[e.first_name, e.last_name].filter(Boolean).join(' ') || e.email}</div><div className="small muted">{e.email}{e.company ? ` · ${e.company}` : ''}</div></td>
            <td><Badge kind={KIND[e.status]}>{e.status.replace('_', ' ')}</Badge>{e.error && <div className="small" style={{ color: 'var(--danger)' }}>{e.error}</div>}</td>
            <td>{e.current_step + 1}</td>
            <td className="small muted">{e.status === 'active' && e.next_run_at ? fmtDateTime(e.next_run_at) : '—'}</td>
            <td>{e.sent_count}</td>
            <td className="small muted">{fmtDateTime(e.updated_at)}</td>
            <td><div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
              {e.status === 'active' && <IconButton label="Pause" className="btn-sm" onClick={() => act(e.id, 'pause')}><Pause size={14} /></IconButton>}
              {['paused', 'error'].includes(e.status) && <IconButton label="Resume" className="btn-sm" onClick={() => act(e.id, 'retry')}><RotateCcw size={14} /></IconButton>}
              {e.status === 'active' && <IconButton label="Skip this step" className="btn-sm" onClick={() => act(e.id, 'skip')}><SkipForward size={14} /></IconButton>}
              <IconButton label="Remove" className="btn-sm" onClick={() => act(e.id, 'remove')}><X size={14} /></IconButton>
            </div></td>
          </tr>)}
        </tbody></table>
      )}
      {data && data.total > data.size && <div className="row mt-8" style={{ justifyContent: 'flex-end' }}><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="small muted">page {page}</span><Button size="sm" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </div>
  );
}
