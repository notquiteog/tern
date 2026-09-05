import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Filter, Mail, Plus, Search, Tag, Trash2, Upload, UserX, Workflow, X, Ban, ChevronLeft, ChevronRight, Pencil, ShieldOff } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useCompose } from '../state/compose';
import { useContactTags, useSequences } from '../lib/queries';
import { useDebounced } from '../lib/hooks';
import { Avatar, Badge, Button, Confirm, Drawer, Empty, Field, IconButton, Input, Menu, MenuItem, Modal, PageHeader, Select, Spinner, Textarea, Callout } from '../components/ui';
import { AvatarUploader } from './Settings';
import { DataTable } from '../components/DataTable';
import { fmtDate, fmtDateTime, fmtNumber, plural } from '../lib/format';

const STATUS_KIND: Record<string, any> = { active: 'success', replied: 'accent', unsubscribed: 'danger', bounced: 'danger', do_not_contact: 'danger' };

export default function ContactsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const compose = useCompose();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q, 250);
  const tag = params.get('tag') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [importOpen, setImportOpen] = useState(params.get('import') === '1');
  const [suppOpen, setSuppOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: tags = [] } = useContactTags();
  const { data, isLoading } = useQuery({ queryKey: ['contacts', dq, tag, status, page], queryFn: () => api.get<{ contacts: any[]; total: number; size: number }>(`/api/contacts?q=${encodeURIComponent(dq)}&tag=${encodeURIComponent(tag)}&status=${status}&page=${page}`), placeholderData: (p) => p });
  const { data: stats } = useQuery({ queryKey: ['contact-stats'], queryFn: () => api.get<any>('/api/contacts/stats') });
  const rows = data?.contacts ?? [];
  const total = data?.total ?? 0;
  const size = data?.size ?? 50;
  useEffect(() => { setSelected(new Set()); }, [dq, tag, status, page]);
  const setParam = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); p.delete('page'); return p; });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['contact-stats'] }); qc.invalidateQueries({ queryKey: ['contact-tags'] }); };

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    try { await api.post('/api/contacts/bulk', { ids: [...selected], action, ...extra }); invalidate(); setSelected(new Set()); toast.success('Done'); } catch (e) { toast.error(e); }
  }

  return (
    <div className="page">
      <PageHeader title="Contacts" sub={stats ? `${fmtNumber(stats.total)} contacts · ${fmtNumber(stats.active)} active · ${fmtNumber(stats.replied)} replied · ${fmtNumber(stats.unsubscribed + stats.bounced)} suppressed` : ''}
        actions={<>
          <Button icon={<ShieldOff size={15} />} onClick={() => setSuppOpen(true)}>Suppression list</Button>
          <a className="btn" href="/api/contacts/export.csv"><Download size={15} />Export</a>
          <Button icon={<Upload size={15} />} onClick={() => setImportOpen(true)}>Import CSV</Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New contact</Button>
        </>} />
      <div className="list-toolbar">
        <div className="search"><Search size={15} className="faint" /><input value={q} onChange={(e) => { setQ(e.target.value); setParam('q', e.target.value); }} placeholder="Search name, email, company" /></div>
        <Select value={tag} onChange={(e) => setParam('tag', e.target.value)} style={{ width: 180 }}><option value="">All tags</option>{tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}</Select>
        <Select value={status} onChange={(e) => setParam('status', e.target.value)} style={{ width: 170 }}><option value="">Any status</option><option value="active">Active</option><option value="replied">Replied</option><option value="unsubscribed">Unsubscribed</option><option value="bounced">Bounced</option><option value="do_not_contact">Do not contact</option></Select>
        {selected.size > 0 && (
          <div className="row gap-4 ml-auto">
            <span className="small muted">{selected.size} selected</span>
            <Button size="sm" icon={<Workflow size={14} />} onClick={() => setEnrollOpen(true)}>Enroll in sequence</Button>
            <TagMenu tags={tags} onPick={(t) => bulk('tag', { tag: t })} label="Add tag" />
            <TagMenu tags={tags} onPick={(t) => bulk('untag', { tag: t })} label="Remove tag" />
            <Menu trigger={(open) => <Button size="sm" icon={<Ban size={14} />} onClick={open}>Status</Button>}>{(c) => <><MenuItem onClick={() => { c(); void bulk('status', { status: 'active' }); }}>Active</MenuItem><MenuItem onClick={() => { c(); void bulk('status', { status: 'unsubscribed' }); }}>Unsubscribed</MenuItem><MenuItem onClick={() => { c(); void bulk('status', { status: 'do_not_contact' }); }}>Do not contact</MenuItem></>}</Menu>
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
          </div>
        )}
      </div>
      {isLoading ? <div className="center" style={{ padding: 40 }}><Spinner /></div> : !rows.length ? (
        <Empty icon={<Filter size={24} />} title={dq || tag || status ? 'No matching contacts' : 'No contacts yet'} action={!dq && !tag && !status ? <Button variant="primary" icon={<Upload size={15} />} onClick={() => setImportOpen(true)}>Import a CSV</Button> : undefined}>{dq || tag || status ? 'Adjust the filters.' : 'Import a customer list or add people one at a time. Every contact carries merge fields for personalised sequences.'}</Empty>
      ) : (
        <>
          <DataTable rows={rows} rowKey={(c) => c.id} onRowClick={(c) => nav(`/contacts/${c.id}`)} minWidth={820}
            selection={{ selected, id: (c) => c.id, onToggle: (c) => setSelected((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; }), onToggleAll: (all) => setSelected(all ? new Set(rows.map((r) => r.id)) : new Set()) }}
            columns={[
              { key: 'name', header: 'Name', primary: true, cell: (c) => <div className="row"><Avatar name={[c.first_name, c.last_name].join(' ')} email={c.email} size="sm" src={c.avatar_version ? `/api/avatars/contact/${c.id}?v=${c.avatar_version}` : null} /><span className="strong">{[c.first_name, c.last_name].filter(Boolean).join(' ') || <span className="faint">{c.email}</span>}</span></div> },
              { key: 'email', header: 'Email', secondary: true, className: 'muted', cell: (c) => c.email },
              { key: 'company', header: 'Company', className: 'muted', cell: (c) => c.company ? <>{c.company}{c.title ? <span className="faint"> · {c.title}</span> : ''}</> : null },
              { key: 'tags', header: 'Tags', cell: (c) => (c.tags ?? []).length ? <div className="row wrap gap-4">{(c.tags ?? []).slice(0, 3).map((t: string) => <span key={t} className="tag">{t}</span>)}{c.tags?.length > 3 && <span className="small faint">+{c.tags.length - 3}</span>}</div> : null },
              { key: 'status', header: 'Status', cell: (c) => <><Badge kind={STATUS_KIND[c.status]}>{c.status.replace('_', ' ')}</Badge>{c.active_enrollments > 0 && <span className="small faint"> · {c.active_enrollments} seq</span>}</> },
              { key: 'last', header: 'Last contact', className: 'small muted', nowrap: true, cell: (c) => fmtDate(c.last_contacted_at) },
              { key: 'replied', header: 'Replied', className: 'small muted', nowrap: true, cell: (c) => fmtDate(c.last_replied_at) },
              { key: 'act', actions: true, cell: (c) => <><IconButton label="Email" className="btn-sm" onClick={() => compose.open({ to: [{ name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email }], contactId: c.id })}><Mail size={14} /></IconButton><IconButton label="Edit" className="btn-sm" onClick={() => setEditing(c)}><Pencil size={14} /></IconButton></> },
            ]} />
          <div className="row mt-16" style={{ justifyContent: 'flex-end' }}><span className="small muted">{(page - 1) * size + 1}–{Math.min(total, page * size)} of {fmtNumber(total)}</span><IconButton label="Previous" disabled={page <= 1} onClick={() => setParams((p) => { p.set('page', String(page - 1)); return p; })}><ChevronLeft size={16} /></IconButton><IconButton label="Next" disabled={page * size >= total} onClick={() => setParams((p) => { p.set('page', String(page + 1)); return p; })}><ChevronRight size={16} /></IconButton></div>
        </>
      )}
      <ContactEditor contact={editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      <ImportWizard open={importOpen} onClose={() => { setImportOpen(false); setParams((p) => { p.delete('import'); return p; }); }} onDone={invalidate} />
      <SuppressionsModal open={suppOpen} onClose={() => setSuppOpen(false)} />
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} contactIds={[...selected]} onDone={() => { setSelected(new Set()); invalidate(); }} />
      <Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} danger title={`Delete ${plural(selected.size, 'contact')}?`} message="Their history in sequences and the send log is kept, but the contact records are removed." confirmLabel="Delete" onConfirm={() => bulk('delete')} />
      {id && <ContactDrawer id={Number(id)} onClose={() => nav('/contacts')} onEdit={(c) => setEditing(c)} />}
    </div>
  );
}

function TagMenu({ tags, onPick, label }: { tags: { tag: string }[]; onPick: (t: string) => void; label: string }) {
  const [custom, setCustom] = useState('');
  return (
    <Menu width={240} trigger={(open) => <Button size="sm" icon={<Tag size={14} />} onClick={open}>{label}</Button>}>
      {(c) => <>
        <div style={{ padding: 6 }}><Input className="input-sm" placeholder="New tag…" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) { onPick(custom.trim()); setCustom(''); c(); } }} /></div>
        {tags.map((t) => <MenuItem key={t.tag} onClick={() => { onPick(t.tag); c(); }}>{t.tag}</MenuItem>)}
      </>}
    </Menu>
  );
}

export function EnrollModal({ open, onClose, contactIds, onDone, tag, all }: { open: boolean; onClose: () => void; contactIds?: number[]; onDone?: () => void; tag?: string; all?: boolean }) {
  const { data: sequences = [] } = useSequences();
  const [seq, setSeq] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const usable = sequences.filter((s) => s.status !== 'archived');
  useEffect(() => { if (usable.length && seq === '') setSeq(usable[0].id); }, [usable, seq]);
  async function go() {
    if (!seq) return;
    setBusy(true);
    try {
      const r = await api.post<any>(`/api/sequences/${seq}/enroll`, { contactIds, tag, all });
      toast.success(`Enrolled ${r.enrolled}${r.skipped ? `, skipped ${r.skipped}` : ''}${r.suppressed ? `, suppressed ${r.suppressed}` : ''}`);
      qc.invalidateQueries({ queryKey: ['sequences'] });
      onDone?.(); onClose();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Enroll in a sequence" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!seq} onClick={go}>Enroll</Button></>}>
      {!usable.length ? <Callout kind="warning">No sequences yet. Create one under Sequences first.</Callout> : (
        <Field label="Sequence"><Select value={seq} onChange={(e) => setSeq(Number(e.target.value))}>{usable.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status}{s.account_email ? ` · ${s.account_email}` : ' · no account'})</option>)}</Select></Field>
      )}
      <div className="help-text">Contacts already in the sequence, unsubscribed, bounced, or on the suppression list are skipped. Sending starts when the sequence is active and the account's send window is open.</div>
    </Modal>
  );
}

function ContactEditor({ contact, onClose, onSaved }: { contact: any | null | 'new'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (contact) setForm(contact === 'new' ? { email: '', first_name: '', last_name: '', company: '', title: '', phone: '', website: '', tags: [], notes: '', consent_source: '', fields: {} } : { ...contact, fields: contact.fields ?? {}, tags: contact.tags ?? [] }); }, [contact]);
  const [tagText, setTagText] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [fieldVal, setFieldVal] = useState('');
  if (!contact) return null;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function save() {
    setBusy(true);
    try {
      const tags = tagText.trim() ? [...form.tags, ...tagText.split(',').map((t) => t.trim()).filter(Boolean)] : form.tags;
      const body = { ...form, tags };
      if (contact === 'new') await api.post('/api/contacts', body); else await api.put(`/api/contacts/${contact.id}`, body);
      onSaved(); onClose(); toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={contact === 'new' ? 'New contact' : 'Edit contact'} size="wide" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-row">
        <Field label="Email"><Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} required /></Field>
        <Field label="Company"><Input value={form.company ?? ''} onChange={(e) => set('company', e.target.value)} /></Field>
        <Field label="First name"><Input value={form.first_name ?? ''} onChange={(e) => set('first_name', e.target.value)} /></Field>
        <Field label="Last name"><Input value={form.last_name ?? ''} onChange={(e) => set('last_name', e.target.value)} /></Field>
        <Field label="Title"><Input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} /></Field>
        <Field label="Phone"><Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Website"><Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} /></Field>
        <Field label="Consent source" hint="Where permission to email came from (customer, signup form, referral…)"><Input value={form.consent_source ?? ''} onChange={(e) => set('consent_source', e.target.value)} /></Field>
      </div>
      {contact !== 'new' && <Field label="Status"><Select value={form.status ?? 'active'} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="replied">Replied</option><option value="unsubscribed">Unsubscribed</option><option value="bounced">Bounced</option><option value="do_not_contact">Do not contact</option></Select></Field>}
      <Field label="Tags"><div className="row wrap gap-4 mb-8">{(form.tags ?? []).map((t: string) => <span key={t} className="chip">{t}<button type="button" className="chip-x" onClick={() => set('tags', form.tags.filter((x: string) => x !== t))}><X size={12} /></button></span>)}</div><Input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="Add tags, comma separated" onKeyDown={(e) => { if (e.key === 'Enter' && tagText.trim()) { e.preventDefault(); set('tags', [...form.tags, ...tagText.split(',').map((t) => t.trim()).filter(Boolean)]); setTagText(''); } }} /></Field>
      <Field label="Custom fields" hint="Usable as merge fields, e.g. {{city}}">
        {Object.entries(form.fields ?? {}).map(([k, v]) => <div key={k} className="row mb-8"><code style={{ width: 140 }}>{`{{${k}}}`}</code><Input className="input-sm" value={String(v)} onChange={(e) => set('fields', { ...form.fields, [k]: e.target.value })} /><IconButton label="Remove" className="btn-sm" onClick={() => { const f = { ...form.fields }; delete f[k]; set('fields', f); }}><X size={14} /></IconButton></div>)}
        <div className="row"><Input className="input-sm" placeholder="field_name" value={fieldKey} onChange={(e) => setFieldKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase())} style={{ width: 160 }} /><Input className="input-sm" placeholder="value" value={fieldVal} onChange={(e) => setFieldVal(e.target.value)} /><Button size="sm" disabled={!fieldKey} onClick={() => { set('fields', { ...form.fields, [fieldKey]: fieldVal }); setFieldKey(''); setFieldVal(''); }}>Add</Button></div>
      </Field>
      <Field label="Notes" hint="Notes are given to the AI when it personalises a message for this contact."><Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
    </Modal>
  );
}

function ContactDrawer({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (c: any) => void }) {
  const nav = useNavigate();
  const compose = useCompose();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['contact', id], queryFn: () => api.get<any>(`/api/contacts/${id}`) });
  const c = data?.contact;
  const refreshAll = () => { qc.invalidateQueries({ queryKey: ['contact', id] }); qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['thread'] }); };
  return (
    <Drawer open onClose={onClose} title={c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email : 'Contact'} actions={c && <><Button size="sm" icon={<Mail size={14} />} onClick={() => compose.open({ to: [{ name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email }], contactId: c.id })}>Email</Button><Button size="sm" icon={<Pencil size={14} />} onClick={() => onEdit(c)}>Edit</Button></>}>
      {isLoading || !c ? <div className="center" style={{ padding: 40 }}><Spinner /></div> : (
        <>
          <div className="mb-16"><AvatarUploader src={c.avatar_version ? `/api/avatars/contact/${c.id}?v=${c.avatar_version}` : null} name={[c.first_name, c.last_name].join(' ') || c.email} email={c.email} onUpload={async (blob) => { await api.upload(`/api/avatars/contact/${c.id}`, blob, blob.type || 'image/webp'); refreshAll(); toast.success('Photo saved'); }} onRemove={async () => { await api.del(`/api/avatars/contact/${c.id}`); refreshAll(); }} /></div>
          <div className="row mb-16"><div className="col" style={{ gap: 2 }}><div className="strong">{c.email}</div><div className="small muted">{c.title}{c.title && c.company ? ' at ' : ''}{c.company}</div><div className="row wrap gap-4"><Badge kind={STATUS_KIND[c.status]}>{c.status.replace('_', ' ')}</Badge>{data.suppression && <Badge kind="danger"><UserX size={12} /> suppressed: {data.suppression.reason}</Badge>}</div></div></div>
          <dl className="kv mb-16">
            {c.phone && <><dt>Phone</dt><dd>{c.phone}</dd></>}
            {c.website && <><dt>Website</dt><dd><a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer">{c.website}</a></dd></>}
            <dt>Tags</dt><dd><div className="row wrap gap-4">{(c.tags ?? []).length ? c.tags.map((t: string) => <span key={t} className="tag">{t}</span>) : <span className="faint">none</span>}</div></dd>
            <dt>Source</dt><dd>{c.source}{c.consent_source ? ` · ${c.consent_source}` : ''}</dd>
            <dt>Added</dt><dd>{fmtDateTime(c.created_at)}</dd>
            <dt>Last contacted</dt><dd>{c.last_contacted_at ? fmtDateTime(c.last_contacted_at) : <span className="faint">never</span>}</dd>
            <dt>Last reply</dt><dd>{c.last_replied_at ? fmtDateTime(c.last_replied_at) : <span className="faint">never</span>}</dd>
            {Object.entries(c.fields ?? {}).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt><code>{`{{${k}}}`}</code></dt><dd>{String(v)}</dd></div>)}
          </dl>
          {c.notes && <div className="card mb-16" style={{ padding: 12 }}><h4 className="mb-8">Notes</h4><div className="pre small">{c.notes}</div></div>}
          {data.enrollments?.length > 0 && <><h4 className="mb-8">Sequences</h4><ul className="timeline mb-16">{data.enrollments.map((e: any) => <li key={e.id}><span className={`tl-dot ${e.status === 'replied' ? 'reply' : e.status === 'bounced' ? 'bounce' : ''}`} /><div className="flex-1"><a onClick={() => nav(`/sequences/${e.sequence_id}`)} style={{ cursor: 'pointer' }}>{e.sequence_name}</a><div className="small muted">step {e.current_step + 1} · {e.status.replace('_', ' ')}{e.next_run_at && e.status === 'active' ? ` · next ${fmtDateTime(e.next_run_at)}` : ''}</div></div></li>)}</ul></>}
          {data.threads?.length > 0 && <><h4 className="mb-8">Conversations</h4><ul className="timeline mb-16">{data.threads.map((t: any) => <li key={`${t.account_id}:${t.thread_id}`} className="clickable" onClick={() => nav(`/mail/all/t/${encodeURIComponent(`${t.account_id}:${t.thread_id}`)}`)} style={{ cursor: 'pointer' }}><span className="tl-dot" /><div className="flex-1 truncate"><div className="truncate">{t.latest.subject || '(no subject)'}</div><div className="small muted truncate">{fmtDate(t.latest.received_at)} · {t.latest.preview}</div></div></li>)}</ul></>}
          {data.sends?.length > 0 && <><h4 className="mb-8">Send history</h4><ul className="timeline">{data.sends.map((s: any) => <li key={s.id}><span className={`tl-dot ${s.status === 'failed' ? 'fail' : s.bounced_at ? 'bounce' : s.replied_at ? 'reply' : ''}`} /><div className="flex-1"><div className="truncate">{s.subject || '(no subject)'}</div><div className="small muted">{fmtDateTime(s.sent_at)} · {s.kind}{s.sequence_name ? ` · ${s.sequence_name}` : ''}{s.status === 'failed' ? ` · failed: ${s.error}` : ''}{s.replied_at ? ' · replied' : ''}{s.bounced_at ? ' · bounced' : ''}</div></div></li>)}</ul></>}
        </>
      )}
    </Drawer>
  );
}

const FIELDS: [string, string][] = [['email', 'Email (required)'], ['first_name', 'First name'], ['last_name', 'Last name'], ['full_name', 'Full name (split)'], ['company', 'Company'], ['title', 'Title'], ['phone', 'Phone'], ['website', 'Website'], ['tags', 'Tags (; separated)'], ['notes', 'Notes']];

function ImportWizard({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [tags, setTags] = useState('');
  const [consent, setConsent] = useState('');
  const [existing, setExisting] = useState<'update' | 'skip'>('update');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  useEffect(() => { if (!open) { setStep(0); setPreview(null); setResult(null); setMapping({}); setCustom({}); } }, [open]);
  async function pick(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const r = await api.upload<any>(`/api/contacts/import/preview?filename=${encodeURIComponent(file.name)}`, text, 'text/csv');
      setPreview(r); setMapping(r.guess); setStep(1);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  const unmapped = useMemo(() => (preview?.headers ?? []).filter((h: string) => !Object.values(mapping).includes(h)), [preview, mapping]);
  async function run() {
    setBusy(true);
    try {
      const r = await api.post<any>('/api/contacts/import', { uploadId: preview.uploadId, mapping, customFields: custom, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), consentSource: consent, existing });
      setResult(r); setStep(2); onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={step === 0 ? 'Import contacts' : step === 1 ? 'Map columns' : 'Import complete'} size="wide" footer={step === 1 ? <><Button onClick={() => setStep(0)}>Back</Button><Button variant="primary" loading={busy} disabled={!mapping.email} onClick={run}>Import {fmtNumber(preview?.total ?? 0)} rows</Button></> : step === 2 ? <Button variant="primary" onClick={onClose}>Done</Button> : undefined}>
      {step === 0 && (
        <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void pick(f); }}>
          <label className="empty" style={{ border: '2px dashed var(--border-strong)', borderRadius: 14, cursor: 'pointer' }}>
            <div className="empty-icon"><Upload size={24} /></div>
            <h3>Drop a CSV here or click to choose</h3>
            <div className="muted">Any export works: HubSpot, Sheets, Shopify, Stripe. Columns are matched automatically and you confirm them next.</div>
            <input type="file" accept=".csv,text/csv,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); }} />
            {busy && <Spinner />}
          </label>
        </div>
      )}
      {step === 1 && preview && (
        <>
          <Callout>Found <b>{fmtNumber(preview.total)}</b> rows and {preview.headers.length} columns (delimiter "{preview.delimiter === '\t' ? 'tab' : preview.delimiter}"). Pick which column feeds each field; anything left unmapped can become a custom merge field.</Callout>
          <div className="form-row mt-16">
            {FIELDS.map(([key, label]) => <Field key={key} label={label}><Select value={mapping[key] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value || null }))}><option value="">— not imported —</option>{preview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}</Select></Field>)}
          </div>
          {unmapped.length > 0 && <Field label="Custom fields from unmapped columns" hint="Give a column a field name to use it as {{field_name}} in templates.">{unmapped.map((h: string) => <div key={h} className="row mb-8"><span style={{ width: 200 }} className="truncate small">{h}</span><Input className="input-sm" placeholder="merge field name (blank to skip)" value={custom[h] ?? ''} onChange={(e) => setCustom((c) => ({ ...c, [h]: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() }))} /></div>)}</Field>}
          <div className="form-row">
            <Field label="Tag everyone imported with" hint="Comma separated. Handy for enrolling this batch later."><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="customers-2026, newsletter" /></Field>
            <Field label="Consent source" hint="Recorded on each contact."><Input value={consent} onChange={(e) => setConsent(e.target.value)} placeholder="Existing customers" /></Field>
          </div>
          <Field label="If a contact already exists"><Select value={existing} onChange={(e) => setExisting(e.target.value as any)}><option value="update">Update empty fields and merge tags</option><option value="skip">Skip the row</option></Select></Field>
          <h4 className="mb-8">Preview</h4>
          <div style={{ overflow: 'auto', maxHeight: 200 }}><table className="table small"><thead><tr>{preview.headers.map((h: string) => <th key={h}>{h}</th>)}</tr></thead><tbody>{preview.sample.map((r: string[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j} className="truncate" style={{ maxWidth: 160 }}>{c}</td>)}</tr>)}</tbody></table></div>
        </>
      )}
      {step === 2 && result && (
        <div className="stats-row">
          <div className="stat"><div className="stat-value">{fmtNumber(result.created)}</div><div className="stat-label">created</div></div>
          <div className="stat"><div className="stat-value">{fmtNumber(result.updated)}</div><div className="stat-label">updated</div></div>
          <div className="stat"><div className="stat-value">{fmtNumber(result.skipped)}</div><div className="stat-label">skipped</div></div>
          <div className="stat"><div className="stat-value">{fmtNumber(result.invalid)}</div><div className="stat-label">invalid or duplicate</div></div>
          <div className="stat"><div className="stat-value">{fmtNumber(result.suppressed)}</div><div className="stat-label">on suppression list</div></div>
        </div>
      )}
    </Modal>
  );
}

function SuppressionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const { data } = useQuery({ queryKey: ['suppressions'], queryFn: () => api.get<{ suppressions: any[] }>('/api/contacts/suppressions/list'), enabled: open });
  async function add() {
    const emails = text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    if (!emails.length) return;
    try { await api.post('/api/contacts/suppressions', { emails }); setText(''); qc.invalidateQueries({ queryKey: ['suppressions'] }); qc.invalidateQueries({ queryKey: ['contacts'] }); toast.success(`Added ${emails.length}`); } catch (e) { toast.error(e); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Suppression list" size="wide">
      <Callout>Addresses here are never sent to by a sequence, even if they are re-imported. Unsubscribes, bounces and "stop" replies land here automatically.</Callout>
      <Field label="Add addresses" className="mt-16"><div className="row"><Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="one per line, or comma separated" style={{ minHeight: 60 }} /><Button onClick={add}>Add</Button></div></Field>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {!data?.suppressions?.length ? <div className="faint small">Empty</div> : <DataTable rows={data.suppressions} rowKey={(s) => s.id} minWidth={520} cardSize="sm" columns={[
          { key: 'email', header: 'Email', primary: true, cell: (s) => s.email },
          { key: 'reason', header: 'Reason', cell: (s) => <Badge>{s.reason.replace('_', ' ')}</Badge> },
          { key: 'source', header: 'Source', className: 'small muted', cell: (s) => s.source },
          { key: 'added', header: 'Added', className: 'small muted', nowrap: true, cell: (s) => fmtDate(s.created_at) },
          { key: 'act', actions: true, cell: (s) => <IconButton label="Remove" className="btn-sm" onClick={() => api.del(`/api/contacts/suppressions/${s.id}`).then(() => { qc.invalidateQueries({ queryKey: ['suppressions'] }); qc.invalidateQueries({ queryKey: ['contacts'] }); })}><X size={14} /></IconButton> },
        ]} />}
      </div>
    </Modal>
  );
}
