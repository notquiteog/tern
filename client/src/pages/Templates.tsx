import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Copy, Pencil, Plus, Sparkles, Trash2, Eye } from 'lucide-react';
import { api, apiStream } from '../api';
import { useToast } from '../state/toast';
import { useTemplates } from '../lib/queries';
import { Button, Confirm, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Textarea, Badge } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { fmtDate, textToHtml } from '../lib/format';

export const MERGE_FIELDS = ['first_name', 'last_name', 'full_name', 'company', 'title', 'email', 'domain', 'sender_name', 'sender_first_name', 'today', 'weekday', 'unsubscribe_url'];

export default function TemplatesPage() {
  const { data: templates = [], isLoading } = useTemplates();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['templates'] });
  return (
    <div className="page">
      <PageHeader title="Templates" sub="Reusable emails with merge fields. Sequences and the compose window both pull from here." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New template</Button>} />
      {!isLoading && !templates.length && <Empty icon={<BookOpen size={24} />} title="No templates yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Write the first one</Button>}>Write once, personalise with fields like {'{{first_name|there}}'}, and reuse in every sequence.</Empty>}
      <div className="grid-cards">
        {templates.map((t) => (
          <div key={t.id} className="card" style={{ cursor: 'pointer' }} onClick={() => setEditing(t)}>
            <div className="card-title"><h2 className="truncate">{t.name}</h2><Badge>{t.category}</Badge></div>
            <div className="strong small truncate mb-8">{t.subject || <span className="faint">(no subject)</span>}</div>
            <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 54 }}>{String(t.body_html).replace(/<[^>]+>/g, ' ').trim() || 'Empty body'}</div>
            <div className="row mt-16" style={{ justifyContent: 'space-between' }}>
              <span className="small faint">{t.fields?.length ? `${t.fields.length} merge field${t.fields.length === 1 ? '' : 's'}` : 'no merge fields'} · {t.used_in_steps ? `used in ${t.used_in_steps} step${t.used_in_steps === 1 ? '' : 's'}` : fmtDate(t.updated_at)}</span>
              <div className="row gap-4" onClick={(e) => e.stopPropagation()}>
                <IconButton label="Duplicate" className="btn-sm" onClick={() => api.post(`/api/templates/${t.id}/duplicate`).then(invalidate)}><Copy size={14} /></IconButton>
                <IconButton label="Edit" className="btn-sm" onClick={() => setEditing(t)}><Pencil size={14} /></IconButton>
                <IconButton label="Delete" className="btn-sm" onClick={() => setDel(t)}><Trash2 size={14} /></IconButton>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete "${del?.name}"?`} message={del?.used_in_steps ? `It is used by ${del.used_in_steps} sequence step(s); those steps keep their own copy of nothing, so re-check them.` : undefined} confirmLabel="Delete" onConfirm={async () => { await api.del(`/api/templates/${del.id}`); invalidate(); toast.success('Deleted'); }} />
    </div>
  );
}

export function TemplateEditor({ template, onClose, onSaved }: { template: any | 'new'; onClose: () => void; onSaved: (t: any) => void }) {
  const toast = useToast();
  const isNew = template === 'new';
  const [name, setName] = useState(isNew ? '' : template.name);
  const [subject, setSubject] = useState(isNew ? '' : template.subject);
  const [category, setCategory] = useState(isNew ? 'outreach' : template.category);
  const [brief, setBrief] = useState(isNew ? '' : template.ai_brief ?? '');
  const html = useRef(isNew ? '' : template.body_html);
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [gen, setGen] = useState(false);
  const [tab, setTab] = useState<'write' | 'preview'>('write');

  async function save() {
    if (!name.trim()) { toast.error('Give the template a name'); return; }
    setBusy(true);
    try {
      const body = { name, subject, body_html: html.current, category, ai_brief: brief };
      const r = isNew ? await api.post<any>('/api/templates', body) : await api.put<any>(`/api/templates/${template.id}`, body);
      onSaved(r.template); onClose(); toast.success('Saved');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  async function doPreview() {
    try { setPreview(await api.post('/api/templates/preview', { subject, body_html: html.current })); setTab('preview'); } catch (e) { toast.error(e); }
  }
  async function generate() {
    if (!brief.trim()) { toast.error('Write a short brief first: who this is for and what it should achieve'); return; }
    setGen(true);
    let out = '';
    try {
      await apiStream('/api/ai/draft', { mode: 'compose', instruction: `${brief}\n\nWrite it as a reusable template: use {{first_name|there}} for the greeting and {{company}} where the recipient's company belongs. Keep merge fields exactly in that double-brace form.`, length: 'medium' }, { onEvent: (ev, d) => { if (ev === 'token') { out += d.t; editor.current?.setHtml(textToHtml(out)); } if (ev === 'error') toast.error(d.error); if (ev === 'done') { editor.current?.setHtml(textToHtml(d.text)); html.current = editor.current?.getHtml() ?? ''; } } });
      if (!subject.trim()) {
        let s = '';
        await apiStream('/api/ai/draft', { mode: 'subject', draft: out }, { onEvent: (ev, d) => { if (ev === 'done') s = d.text; } });
        if (s) setSubject(s);
      }
    } catch (e) { toast.error(e); } finally { setGen(false); }
  }
  useEffect(() => { if (tab === 'write') setTimeout(() => editor.current?.setHtml(html.current), 0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);

  return (
    <Modal open onClose={onClose} title={isNew ? 'New template' : 'Edit template'} size="xl" footer={<><Button onClick={onClose}>Cancel</Button><Button icon={<Eye size={15} />} onClick={doPreview}>Preview</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-row">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro · warm lead" /></Field>
        <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}><option value="outreach">Outreach</option><option value="follow-up">Follow-up</option><option value="reply">Reply</option><option value="customer">Customer</option><option value="other">Other</option></Select></Field>
      </div>
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question about {{company}}" /></Field>
      <div className="row mb-8 wrap"><span className="small muted">Insert field:</span>{MERGE_FIELDS.map((f) => <button key={f} type="button" className="tag" style={{ cursor: 'pointer', border: 0 }} onClick={() => editor.current?.insertHtml(`{{${f}}}`)}>{`{{${f}}}`}</button>)}<span className="small faint">Fallbacks: {'{{first_name|there}}'}</span></div>
      <div className="tabs"><button className={tab === 'write' ? 'active' : ''} onClick={() => setTab('write')}>Write</button><button className={tab === 'preview' ? 'active' : ''} onClick={doPreview}>Preview with sample contact</button></div>
      {tab === 'write' ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}><Editor ref={editor} initialHtml={html.current} placeholder="Hi {{first_name|there}}," minHeight={220} onChange={(h) => { html.current = h; }} /></div>
      ) : preview ? (
        <div className="card"><div className="strong mb-8">{preview.subject || '(no subject)'}</div><div className="msg-text" dangerouslySetInnerHTML={{ __html: preview.html }} />{preview.missing?.length > 0 && <div className="small mt-8" style={{ color: 'var(--warning)' }}>Unknown fields (will render empty unless the contact has them): {preview.missing.join(', ')}</div>}</div>
      ) : null}
      <Field label="AI brief" hint="Optional. Describe the goal in a sentence or two. 'Generate' writes a draft from it, and sequences with 'AI personalise' use it as the message to deliver for each contact." className="mt-16">
        <div className="row" style={{ alignItems: 'flex-start' }}><Textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Introduce our bookkeeping service to small e-commerce shops; ask if they'd like a 15 minute call; mention we work with Shopify stores." style={{ minHeight: 70 }} /><Button variant="ai" icon={<Sparkles size={14} />} loading={gen} onClick={generate}>Generate</Button></div>
      </Field>
    </Modal>
  );
}
