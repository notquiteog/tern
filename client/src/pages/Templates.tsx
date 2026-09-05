import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Copy, Pencil, Plus, Sparkles, Trash2, Eye, Star, Library, Download, Upload, Shuffle, Send, AlertTriangle, Search } from 'lucide-react';
import { api, apiStream } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useTemplates } from '../lib/queries';
import { Badge, Button, Callout, Confirm, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Textarea, Toggle } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { cls, fmtDate, textToHtml } from '../lib/format';

export const MERGE_FIELDS = ['first_name', 'last_name', 'full_name', 'company', 'title', 'email', 'domain', 'greeting', 'sender_name', 'sender_first_name', 'today', 'weekday', 'month', 'year', 'unsubscribe_url'];

const CATEGORY_SUGGESTIONS = ['outreach', 'follow-up', 'customer', 'reply', 'scheduling', 'invite', 'announcement', 'payment', 'other'];

export default function TemplatesPage() {
  const { data: templates = [], isLoading } = useTemplates();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [del, setDel] = useState<any>(null);
  const [library, setLibrary] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['templates'] });
  const categories = useMemo(() => [...new Set(templates.map((t) => t.category))].sort(), [templates]);
  const visible = templates.filter((t) => (!cat || t.category === cat) && (!q || `${t.name} ${t.subject} ${t.description} ${t.body_html}`.toLowerCase().includes(q.toLowerCase())));
  async function importFile(f: File) {
    try {
      const j = JSON.parse(await f.text());
      const r = await api.post<any>('/api/templates/import', { templates: j.templates ?? j });
      invalidate(); toast.success(`Imported ${r.imported} templates`);
    } catch (e) { toast.error(e); }
  }
  return (
    <div className="page">
      <PageHeader title="Templates" sub="Reusable emails with merge fields, fallbacks, conditionals and variations. Sequences, campaigns and the composer all pull from here."
        actions={<>
          <input ref={fileInput} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
          <Button icon={<Upload size={15} />} onClick={() => fileInput.current?.click()}>Import</Button>
          <a className="btn" href="/api/templates/export"><Download size={15} />Export</a>
          <Button icon={<Library size={15} />} onClick={() => setLibrary(true)}>Library</Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New template</Button>
        </>} />
      {templates.length > 0 && (
        <div className="list-toolbar">
          <div className="search" style={{ maxWidth: 320, height: 36 }}><Search size={15} className="faint" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" /></div>
          <div className="segmented"><button className={!cat ? 'active' : ''} onClick={() => setCat('')}>All</button>{categories.map((c) => <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>)}</div>
        </div>
      )}
      {!isLoading && !templates.length && <Empty icon={<BookOpen size={24} />} title="No templates yet" action={<div className="row"><Button variant="primary" icon={<Library size={15} />} onClick={() => setLibrary(true)}>Browse the library</Button><Button onClick={() => setEditing('new')}>Write your own</Button></div>}>Start from 25 ready-made templates for outreach, follow-ups, customers, scheduling and replies, or write one with {'{{first_name|there}}'}-style fields.</Empty>}
      {templates.length > 0 && !visible.length && <Empty title="No matches">Try another search or category.</Empty>}
      <div className="grid-cards">
        {visible.map((t) => (
          <div key={t.id} className="card" style={{ cursor: 'pointer', borderColor: t.errors?.length ? 'var(--danger)' : undefined }} onClick={() => setEditing(t)}>
            <div className="card-title"><h2 className="truncate">{t.name}</h2><div className="row gap-4"><Badge>{t.category}</Badge><IconButton label={t.starred ? 'Unstar' : 'Star'} className={cls('btn-sm', t.starred && 'active')} onClick={(e) => { e.stopPropagation(); api.put(`/api/templates/${t.id}`, { starred: !t.starred }).then(invalidate); }}><Star size={14} fill={t.starred ? 'currentColor' : 'none'} /></IconButton></div></div>
            {t.description && <div className="small muted mb-8">{t.description}</div>}
            <div className="strong small truncate mb-8">{t.subject || <span className="faint">(subject from the thread)</span>}</div>
            <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 54 }}>{String(t.body_html).replace(/<[^>]+>/g, ' ').trim() || 'Empty body'}</div>
            {t.errors?.length > 0 && <div className="small mt-8" style={{ color: 'var(--danger)' }}><AlertTriangle size={12} /> {t.errors[0]}</div>}
            <div className="row mt-16" style={{ justifyContent: 'space-between' }}>
              <span className="small faint">{t.fields?.length ? `${t.fields.length} field${t.fields.length === 1 ? '' : 's'}` : 'no fields'} · {t.sent_count ? `${t.sent_count} sent` : t.used_in_steps ? `in ${t.used_in_steps} step${t.used_in_steps === 1 ? '' : 's'}` : fmtDate(t.updated_at)}</span>
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
      <LibraryModal open={library} onClose={() => setLibrary(false)} owned={new Set(templates.map((t) => t.library_key).filter(Boolean))} onAdded={invalidate} />
      <Confirm open={Boolean(del)} onClose={() => setDel(null)} danger title={`Delete "${del?.name}"?`} message={del?.used_in_steps ? `It is used by ${del.used_in_steps} sequence step(s); those steps will fall back to their own subject and body.` : undefined} confirmLabel="Delete" onConfirm={async () => { await api.del(`/api/templates/${del.id}`); invalidate(); toast.success('Deleted'); }} />
    </div>
  );
}

function LibraryModal({ open, onClose, owned, onAdded }: { open: boolean; onClose: () => void; owned: Set<string>; onAdded: () => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['template-library'], queryFn: () => api.get<{ templates: any[]; categories: string[] }>('/api/templates/library'), enabled: open });
  const [cat, setCat] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const list = (data?.templates ?? []).filter((t) => !cat || t.category === cat);
  async function add(keys: string[]) {
    setBusy(true);
    try { const r = await api.post<any>('/api/templates/library', { keys }); onAdded(); toast.success(`Added ${r.added}${r.skipped ? `, ${r.skipped} already in your templates` : ''}`); } catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Template library" size="xl" footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" loading={busy} onClick={() => add((data?.templates ?? []).map((t) => t.key))}>Add all {data?.templates?.length ?? ''}</Button></>}>
      <div className="row mb-16 wrap"><div className="segmented"><button className={!cat ? 'active' : ''} onClick={() => setCat('')}>All</button>{(data?.categories ?? []).map((c) => <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>)}</div><span className="small muted ml-auto">Copies are yours to edit. Square brackets mark the sentences to fill in.</span></div>
      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {list.map((t) => (
          <div key={t.key} className="card" style={{ padding: 14 }}>
            <div className="card-title" style={{ marginBottom: 6 }}><h2 style={{ fontSize: 14 }} className="truncate">{t.name}</h2><Badge>{t.category}</Badge></div>
            <div className="small muted mb-8" style={{ minHeight: 34 }}>{t.description}</div>
            <div className="small truncate mb-8"><span className="faint">Subject:</span> {t.subject || <span className="faint">(thread subject)</span>}</div>
            <div className="row gap-4"><Button size="sm" icon={<Eye size={13} />} onClick={() => setPreview(t)}>Preview</Button>{owned.has(t.key) ? <Badge kind="success">added</Badge> : <Button size="sm" variant="primary" icon={<Plus size={13} />} loading={busy} onClick={() => add([t.key])}>Add</Button>}</div>
          </div>
        ))}
      </div>
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name} size="wide" footer={<><Button onClick={() => setPreview(null)}>Close</Button>{preview && !owned.has(preview.key) && <Button variant="primary" onClick={() => { add([preview.key]); setPreview(null); }}>Add to my templates</Button>}</>}>
        {preview && <><div className="strong mb-8">{preview.subject || '(thread subject)'}</div><div className="msg-text" style={{ fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: preview.body_html }} /><div className="small muted mt-16">Fields used: {preview.fields.join(', ') || 'none'}</div>{preview.ai_brief && <div className="small muted mt-8">AI brief: {preview.ai_brief}</div>}</>}
      </Modal>
    </Modal>
  );
}

export function TemplateEditor({ template, onClose, onSaved }: { template: any | 'new'; onClose: () => void; onSaved: (t: any) => void }) {
  const toast = useToast();
  const { data: accounts = [] } = useAccounts();
  const { data: help } = useQuery({ queryKey: ['template-help'], queryFn: () => api.get<any>('/api/templates/help') });
  const isNew = template === 'new';
  const [name, setName] = useState(isNew ? '' : template.name);
  const [subject, setSubject] = useState(isNew ? '' : template.subject);
  const [category, setCategory] = useState(isNew ? 'outreach' : template.category);
  const [description, setDescription] = useState(isNew ? '' : template.description ?? '');
  const [brief, setBrief] = useState(isNew ? '' : template.ai_brief ?? '');
  const [includeSignature, setIncludeSignature] = useState(isNew ? true : template.include_signature !== false);
  const [starred, setStarred] = useState(isNew ? false : Boolean(template.starred));
  const html = useRef(isNew ? '' : template.body_html);
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [previewEmail, setPreviewEmail] = useState('');
  const [seed, setSeed] = useState(1);
  const [gen, setGen] = useState(false);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [testAccount, setTestAccount] = useState<number | ''>('');
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => { if (accounts.length && testAccount === '') setTestAccount(accounts[0].id); }, [accounts, testAccount]);

  async function save(): Promise<any | null> {
    if (!name.trim()) { toast.error('Give the template a name'); return null; }
    setBusy(true);
    try {
      const body = { name, subject, body_html: html.current, category: category || 'other', ai_brief: brief, description, include_signature: includeSignature, starred };
      const r = isNew ? await api.post<any>('/api/templates', body) : await api.put<any>(`/api/templates/${template.id}`, body);
      onSaved(r.template); toast.success('Saved');
      return r.template;
    } catch (e) { toast.error(e); return null; } finally { setBusy(false); }
  }
  async function doPreview(nextSeed = seed) {
    try {
      const r = await api.post<any>('/api/templates/preview', { subject, body_html: html.current, contactEmail: previewEmail || null, accountId: testAccount || null, seed: nextSeed });
      setPreview(r); setErrors(r.errors ?? []); setTab('preview');
    } catch (e) { toast.error(e); }
  }
  async function testSend() {
    const saved = isNew ? await save() : template;
    if (!saved) return;
    try { await api.post(`/api/templates/${saved.id}/test-send`, { accountId: testAccount, contactId: preview?.contact?.id ?? null }); toast.success(`Test sent to ${accounts.find((a) => a.id === testAccount)?.email}`); } catch (e) { toast.error(e); }
  }
  async function generate() {
    if (!brief.trim()) { toast.error('Write a short brief first: who this is for and what it should achieve'); return; }
    setGen(true);
    let out = '';
    try {
      await apiStream('/api/ai/draft', { mode: 'compose', instruction: `${brief}\n\nWrite it as a reusable template: greet with {{first_name|there}}, use {{company}} where the recipient's company belongs, and keep merge fields exactly in that double-brace form. Put any sentence the sender must fill in themselves inside square brackets.`, length: 'medium' }, { onEvent: (ev, d) => { if (ev === 'token') { out += d.t; editor.current?.setHtml(textToHtml(out)); } if (ev === 'error') toast.error(d.error); if (ev === 'done') { editor.current?.setHtml(textToHtml(d.text)); html.current = editor.current?.getHtml() ?? ''; } } });
      if (!subject.trim()) {
        let s = '';
        await apiStream('/api/ai/draft', { mode: 'subject', draft: out }, { onEvent: (ev, d) => { if (ev === 'done') s = d.text; } });
        if (s) setSubject(s);
      }
    } catch (e) { toast.error(e); } finally { setGen(false); }
  }
  useEffect(() => { if (tab === 'write') setTimeout(() => editor.current?.setHtml(html.current), 0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);
  const insert = (text: string) => { if (tab !== 'write') setTab('write'); setTimeout(() => editor.current?.insertHtml(text), 0); };

  return (
    <Modal open onClose={onClose} title={isNew ? 'New template' : 'Edit template'} size="xl" footer={<><Button onClick={onClose}>Cancel</Button><Button icon={<Eye size={15} />} onClick={() => doPreview()}>Preview</Button><Button variant="primary" loading={busy} onClick={async () => { const t = await save(); if (t) onClose(); }}>Save</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 20 }}>
        <div>
          <div className="form-row">
            <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro · warm lead" /></Field>
            <Field label="Category"><Input list="tpl-cats" value={category} onChange={(e) => setCategory(e.target.value)} /><datalist id="tpl-cats">{CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}</datalist></Field>
          </div>
          <Field label="Description" hint="Shown on the card so you remember what it is for."><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="First touch for referrals from existing customers" /></Field>
          <Field label="Subject" hint="Leave empty for follow-ups that continue a thread."><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="{Quick question|A question} about {{company}}" /></Field>
          <div className="tabs" style={{ marginBottom: 10 }}><button className={tab === 'write' ? 'active' : ''} onClick={() => setTab('write')}>Write</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => doPreview()}>Preview</button></div>
          {tab === 'write' ? (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}><Editor ref={editor} initialHtml={html.current} placeholder="Hi {{first_name|there}}," minHeight={240} onChange={(h) => { html.current = h; }} /></div>
          ) : (
            <div>
              <div className="row mb-8 wrap"><Input className="input-sm" style={{ maxWidth: 260 }} placeholder="Preview as a contact (email)" value={previewEmail} onChange={(e) => setPreviewEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doPreview(); }} /><Button size="sm" onClick={() => doPreview()}>Render</Button><Button size="sm" icon={<Shuffle size={13} />} onClick={() => { const s = seed + 1; setSeed(s); void doPreview(s); }}>Shuffle variations</Button><span className="small muted">{preview?.contact ? `rendered for ${preview.contact.name || preview.contact.email}` : 'rendered with a sample contact'}</span></div>
              {preview && (
                <div className="card">
                  <div className="strong mb-8">{preview.subject || <span className="faint">(no subject)</span>}</div>
                  <div className="msg-text" dangerouslySetInnerHTML={{ __html: preview.html }} />
                  {preview.errors?.length > 0 && <Callout kind="danger">{preview.errors.join(' · ')}</Callout>}
                  {preview.missing?.length > 0 && <div className="small mt-8" style={{ color: 'var(--warning)' }}>Fields without a value for this contact (they render empty or use the fallback): {preview.missing.join(', ')}</div>}
                </div>
              )}
              <div className="row mt-8 wrap"><Select className="input-sm" style={{ width: 220 }} value={testAccount} onChange={(e) => setTestAccount(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select><Button size="sm" icon={<Send size={13} />} disabled={!testAccount} onClick={testSend}>Send a test to myself</Button></div>
            </div>
          )}
          {errors.length > 0 && tab === 'write' && <div className="small mt-8" style={{ color: 'var(--danger)' }}>{errors.join(' · ')}</div>}
          <div className="row mt-16 wrap gap-16">
            <div className="row"><Toggle checked={includeSignature} onChange={setIncludeSignature} /><span className="small">Append the account signature</span></div>
            <div className="row"><Toggle checked={starred} onChange={setStarred} /><span className="small">Star (shown first)</span></div>
          </div>
          <Field label="AI brief" hint="Optional. 'Generate' writes a draft from it, and sequences with 'AI personalise' use it as the message to deliver for each contact." className="mt-16">
            <div className="row" style={{ alignItems: 'flex-start' }}><Textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Introduce our bookkeeping service to small e-commerce shops; ask if they'd like a 15 minute call; mention we work with Shopify stores." style={{ minHeight: 60 }} /><Button variant="ai" icon={<Sparkles size={14} />} loading={gen} onClick={generate}>Generate</Button></div>
          </Field>
        </div>
        <aside className="col gap-12" style={{ fontSize: 12.5 }}>
          <div className="card" style={{ padding: 12 }}>
            <h4 className="mb-8">Fields</h4>
            <div className="row wrap gap-4">{(help?.fields ?? MERGE_FIELDS.map((k) => ({ key: k, label: k }))).map((f: any) => <button key={f.key} type="button" className="tag" title={f.label} style={{ cursor: 'pointer', border: 0 }} onClick={() => insert(`{{${f.key}}}`)}>{f.key}</button>)}</div>
            <div className="help-text mt-8">Custom contact fields work too: {'{{city}}'}, {'{{plan}}'}.</div>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <h4 className="mb-8">Fallbacks</h4>
            <code style={{ cursor: 'pointer' }} onClick={() => insert('{{first_name|there}}')}>{'{{first_name|there}}'}</code>
            <div className="help-text mt-8">Used when the field is empty.</div>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <h4 className="mb-8">Filters</h4>
            <code style={{ cursor: 'pointer' }} onClick={() => insert('{{company:possessive}}')}>{'{{company:possessive}}'}</code>
            <div className="help-text mt-8">{(help?.filters ?? ['upper', 'lower', 'capitalize', 'title', 'first', 'last', 'possessive', 'initials', 'domain', 'trim']).join(' · ')}. Chain them: {'{{name:first:capitalize}}'}.</div>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <h4 className="mb-8">Conditionals</h4>
            <code style={{ cursor: 'pointer', display: 'block' }} onClick={() => insert('{{#if company}} at {{company}}{{/if}}')}>{'{{#if company}}…{{/if}}'}</code>
            <code style={{ cursor: 'pointer', display: 'block', marginTop: 4 }} onClick={() => insert('{{#unless phone}}What number works best?{{/unless}}')}>{'{{#unless phone}}…{{/unless}}'}</code>
            <div className="help-text mt-8">Keeps the part only when the field has (or lacks) a value.</div>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <h4 className="mb-8">Variations</h4>
            <code style={{ cursor: 'pointer' }} onClick={() => insert('{Hi|Hello|Hey}')}>{'{Hi|Hello|Hey}'}</code>
            <div className="help-text mt-8">One option is chosen per email, so no two contacts get identical text. Works in subjects too.</div>
          </div>
        </aside>
      </div>
    </Modal>
  );
}
