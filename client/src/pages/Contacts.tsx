import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Filter, Mail, Plus, Search, Tag, Trash2, Upload, UserX, Workflow, X, Ban, ChevronLeft, ChevronRight, Pencil, ShieldOff, Lock, Reply, Clock, Sparkles, CalendarClock, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useCompose } from '../state/compose';
import { useCan } from '../state/features';
import { useFocusContext } from '../state/assistant';
import { AskAssistant } from '../components/AskAssistant';
import { useContactTags, useSequences } from '../lib/queries';
import { useDebounced } from '../lib/hooks';
import { postWithWork, streamWithWork } from '../lib/work';
import { Avatar, Badge, Button, Confirm, Drawer, Empty, Field, IconButton, Input, Menu, MenuItem, Modal, PageHeader, Select, Spinner, Textarea, Callout } from '../components/ui';
import { AvatarUploader } from './Settings';
import { DataTable } from '../components/DataTable';
import { cls, fmtDate, fmtDateTime, fmtNumber, plural, textToHtml } from '../lib/format';

const STATUS_KIND: Record<string, any> = { active: 'success', replied: 'accent', unsubscribed: 'danger', bounced: 'danger', do_not_contact: 'danger' };

// Where a contact stands, said in words.
//
// The list carried two raw dates — "last contacted" and "replied" — and left
// the reader to subtract one from the other twenty times down a page. The
// question anybody actually opens this list with is "who has gone quiet", and
// the answer was sitting in those two columns unsaid.
//
// Nothing new is read to work this out. Both dates were already on the row.
export type Standing =
  | { kind: 'new'; label: string }
  | { kind: 'replied'; label: string; at: string }
  | { kind: 'waiting'; label: string; days: number; at: string };

export function standingOf(c: { last_contacted_at?: string | null; last_replied_at?: string | null }): Standing {
  if (!c.last_contacted_at) return { kind: 'new', label: 'Not contacted' };
  const sent = new Date(c.last_contacted_at).getTime();
  const back = c.last_replied_at ? new Date(c.last_replied_at).getTime() : 0;
  // A reply older than the last thing we sent is not an answer to it: they
  // replied once, and have not replied to this.
  if (back >= sent) return { kind: 'replied', label: 'Replied', at: c.last_replied_at! };
  const days = Math.max(0, Math.floor((Date.now() - sent) / 86_400_000));
  return {
    kind: 'waiting',
    label: days === 0 ? 'Sent today' : `Quiet ${days}d`,
    days,
    at: c.last_contacted_at,
  };
}

// How long is long enough to mean something. Under a week, silence is just
// somebody who has not got to it yet, and colouring it amber would make amber
// mean nothing by the second screen — the same rule `dueIn` follows.
const QUIET_DAYS = 7;

const SORTS: { value: string; label: string; sort: string; dir: 'asc' | 'desc' }[] = [
  { value: 'added', label: 'Recently added', sort: 'created_at', dir: 'desc' },
  { value: 'quiet', label: 'Quiet longest', sort: 'last_contacted_at', dir: 'asc' },
  { value: 'replied', label: 'Recently replied', sort: 'last_replied_at', dir: 'desc' },
  { value: 'company', label: 'Company', sort: 'company', dir: 'asc' },
];

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
  const sortKey = params.get('sort') ?? 'added';
  const sorting = SORTS.find((x) => x.value === sortKey) ?? SORTS[0];
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [importOpen, setImportOpen] = useState(params.get('import') === '1');
  const [suppOpen, setSuppOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: tags = [] } = useContactTags();
  const canWrite = useCan('ai.compose');
  const { nudge, busy: nudging } = useNudge();
  const { data, isLoading } = useQuery({ queryKey: ['contacts', dq, tag, status, page, sortKey], queryFn: () => api.get<{ contacts: any[]; total: number; size: number }>(`/api/contacts?q=${encodeURIComponent(dq)}&tag=${encodeURIComponent(tag)}&status=${status}&page=${page}&sort=${sorting.sort}&dir=${sorting.dir}`), placeholderData: (p) => p });
  const { data: stats } = useQuery({ queryKey: ['contact-stats'], queryFn: () => api.get<any>('/api/contacts/stats') });
  const rows = data?.contacts ?? [];
  const total = data?.total ?? 0;
  const size = data?.size ?? 50;
  useEffect(() => { setSelected(new Set()); }, [dq, tag, status, page, sortKey]);
  const setParam = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); p.delete('page'); return p; });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['contact-stats'] }); qc.invalidateQueries({ queryKey: ['contact-tags'] }); };

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    const n = selected.size;
    try {
      const r = await api.post<{ undo: { action: string; rows: any[] } | null }>('/api/contacts/bulk', { ids: [...selected], action, ...extra });
      invalidate();
      setSelected(new Set());
      const what = action === 'delete' ? 'deleted' : action === 'tag' ? 'tagged' : action === 'untag' ? 'untagged' : 'updated';
      // The same undo the mail list has always offered, finally on the one
      // route in the app that could suppress four hundred people on a
      // mis-click. Delete comes back with no token and no offer, because a
      // deleted contact takes its enrollments and history with it and an
      // "Undo" that restored only the name would be a lie.
      if (r.undo) {
        toast.toast(`${plural(n, 'contact')} ${what}`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try { await api.post('/api/contacts/bulk/undo', r.undo); toast.success('Put back'); } catch (e) { toast.error(e); }
              invalidate();
            },
          },
        });
      } else toast.success(`${plural(n, 'contact')} ${what}`);
    } catch (e) { toast.error(e); }
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
        {/* The server has always accepted these orderings and the page never
            offered them. "Quiet longest" is the one worth having: it is the
            list of people an outreach inbox exists to notice. */}
        <Select value={sortKey} onChange={(e) => setParam('sort', e.target.value === 'added' ? '' : e.target.value)} style={{ width: 175 }}>
          {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
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
              { key: 'standing', header: 'Standing', className: 'small', nowrap: true, cell: (c) => {
                const st = standingOf(c);
                if (st.kind === 'new') return <span className="faint">{st.label}</span>;
                const quiet = st.kind === 'waiting' && st.days >= QUIET_DAYS;
                return (
                  <span className={cls('contact-standing', `contact-standing-${st.kind}`, quiet && 'quiet')} title={`${st.kind === 'replied' ? 'Last replied' : 'Last contacted'} ${fmtDate(st.at, { always: true })}`}>
                    {st.kind === 'replied' ? <Reply size={11} /> : <Clock size={11} />}
                    {st.label}
                  </span>
                );
              } },
              // "Draft a nudge" appears only on a row that has actually gone
              // quiet. The list has labelled those since the standing column
              // was added and nothing acted on the label; putting the button
              // on every row instead would make it furniture.
              { key: 'act', actions: true, cell: (c) => {
                const st = standingOf(c);
                const quiet = st.kind === 'waiting' && st.days >= QUIET_DAYS;
                return <>
                  {quiet && canWrite && <IconButton label={`Draft a nudge — quiet ${st.days} days`} className="btn-sm" disabled={nudging === c.id} onClick={() => void nudge(c, st.days)}>{nudging === c.id ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}</IconButton>}
                  <IconButton label="Email" className="btn-sm" onClick={() => compose.open({ to: [{ name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email }], contactId: c.id })}><Mail size={14} /></IconButton>
                  <IconButton label="Edit" className="btn-sm" onClick={() => setEditing(c)}><Pencil size={14} /></IconButton>
                </>;
              } },
            ]} />
          <div className="row mt-16" style={{ justifyContent: 'flex-end' }}><span className="small muted">{(page - 1) * size + 1}–{Math.min(total, page * size)} of {fmtNumber(total)}</span><IconButton label="Previous" disabled={page <= 1} onClick={() => setParams((p) => { p.set('page', String(page - 1)); return p; })}><ChevronLeft size={16} /></IconButton><IconButton label="Next" disabled={page * size >= total} onClick={() => setParams((p) => { p.set('page', String(page + 1)); return p; })}><ChevronRight size={16} /></IconButton></div>
        </>
      )}
      <ContactEditor contact={editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      <ImportWizard open={importOpen} onClose={() => { setImportOpen(false); setParams((p) => { p.delete('import'); return p; }); }} onDone={invalidate} />
      <SuppressionsModal open={suppOpen} onClose={() => setSuppOpen(false)} />
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} contactIds={[...selected]} onDone={() => { setSelected(new Set()); invalidate(); }} />
      {/* Says what actually goes. The old wording promised that sequence
          history survived; the foreign keys cascade, so it does not, and this
          is the one action on the page with no undo behind it. */}
      <Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} danger title={`Delete ${plural(selected.size, 'contact')}?`} message="This cannot be undone. Their enrollments and anything of theirs waiting in the review queue go with them. Entries already in the send log are kept but stop naming a contact. To stop mailing somebody without losing the record, set them to Do not contact instead." confirmLabel="Delete" onConfirm={() => bulk('delete')} />
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
  const [keyText, setKeyText] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  useEffect(() => { setKeyText(contact && contact !== 'new' ? contact.pgp_public_key ?? '' : ''); }, [contact]);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldVal, setFieldVal] = useState('');
  if (!contact) return null;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function save() {
    setBusy(true);
    try {
      const tags = tagText.trim() ? [...form.tags, ...tagText.split(',').map((t) => t.trim()).filter(Boolean)] : form.tags;
      const { pgp_public_key: _k, pgp_fingerprint: _f, ...body } = { ...form, tags };
      if (contact === 'new') await api.post('/api/contacts', body); else await api.put(`/api/contacts/${contact.id}`, body);
      const before = contact === 'new' ? '' : (contact.pgp_public_key ?? '');
      if (keyText.trim() !== before.trim() && form.email) {
        if (keyText.trim()) await api.put(`/api/pgp/recipients/${encodeURIComponent(form.email)}`, { publicKey: keyText });
        else await api.del(`/api/pgp/recipients/${encodeURIComponent(form.email)}`);
      }
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
      <Field label="OpenPGP public key" hint="With a key on file, mail to this person is encrypted. Paste the armored key, or look it up from their Web Key Directory and keys.openpgp.org.">
        <Textarea value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" style={{ fontFamily: 'var(--mono)', fontSize: 11.5, minHeight: 70 }} />
        <div className="row mt-8"><Button size="sm" icon={<Search size={13} />} loading={keyBusy} disabled={!form.email} onClick={async () => { setKeyBusy(true); try { const r = await api.post<any>('/api/pgp/lookup', { email: form.email }); setKeyText(r.key.publicKey); toast.success(`Found a key (${r.key.source})`); } catch (e) { toast.error(e); } finally { setKeyBusy(false); } }}>Look up</Button>{keyText && <Button size="sm" variant="ghost" onClick={() => setKeyText('')}>Remove</Button>}</div>
      </Field>
    </Modal>
  );
}

// ---------- Where the relationship stands ----------
//
// Contacts was the page that knew the least about what the rest of the app had
// worked out. Everything in this card was already indexed — conversations,
// commitments, meetings, sequence state — and none of it had a way to appear
// beside the person it was about.
//
// The facts come first and stand on their own; the paragraph is a button. A
// digest that vanished when writing help was switched off would make this an AI
// feature, and it is not one: it is a query that should have been here all
// along, with an optional sentence on top.

interface Digest {
  standing: 'new' | 'replied' | 'waiting';
  quietDays: number | null;
  threads: number;
  lastMessageAt: string | null;
  commitments: { id: number; kind: 'owed' | 'awaiting'; text: string; dueAt: string | null; threadId: string; accountId: number }[];
  meetings: { summary: string; startsAt: string; past: boolean }[];
  sequences: { name: string; status: string; step: number }[];
  sends: { total: number; replied: number; bounced: number };
}

function RelationshipCard({ id, contact }: { id: number; contact: any }) {
  const nav = useNavigate();
  const toast = useToast();
  const canWrite = useCan('ai.compose');
  const { data } = useQuery({ queryKey: ['contact-digest', id], queryFn: () => api.get<{ digest: Digest }>(`/api/contacts/${id}/digest`) });
  const d = data?.digest;
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  if (!d) return null;
  // Nothing has ever happened with this person and nothing is outstanding.
  // A card that says "0 conversations, nothing outstanding, no meetings" is
  // three facts pretending to be an answer.
  const empty = !d.threads && !d.commitments.length && !d.meetings.length && !d.sequences.length && !d.sends.total;
  if (empty) return null;

  async function write() {
    setBusy(true);
    try {
      const r = await postWithWork<{ summary: string }>('ai', `/api/contacts/${id}/digest/summary`, {});
      setSummary(r.summary);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <div className="card mb-16" style={{ padding: 12 }}>
      <div className="card-title" style={{ marginBottom: 8 }}>
        <h4>Where this stands</h4>
        {canWrite && !summary && <Button size="sm" variant="ai" icon={<Sparkles size={13} />} loading={busy} onClick={() => void write()}>Sum it up</Button>}
      </div>
      {summary && <div className="small mb-12" style={{ lineHeight: 1.55 }}>{summary}</div>}
      <div className="row wrap gap-4 mb-8">
        {d.standing === 'new' && <Badge>never contacted</Badge>}
        {d.standing === 'replied' && <Badge kind="success"><Reply size={11} /> they replied last</Badge>}
        {d.standing === 'waiting' && <Badge kind={(d.quietDays ?? 0) >= QUIET_DAYS ? 'warning' : undefined}><Clock size={11} /> waiting {d.quietDays}d</Badge>}
        {d.threads > 0 && <Badge>{plural(d.threads, 'conversation')}</Badge>}
        {d.sends.total > 0 && <Badge>{d.sends.replied}/{d.sends.total} replied</Badge>}
        {d.sends.bounced > 0 && <Badge kind="danger">{d.sends.bounced} bounced</Badge>}
      </div>
      {d.commitments.length > 0 && (
        <ul className="timeline mb-8">
          {d.commitments.map((c) => (
            <li key={c.id} className="clickable" style={{ cursor: c.threadId ? 'pointer' : 'default' }} onClick={() => c.threadId && nav(`/mail/all/t/${encodeURIComponent(`${c.accountId}:${c.threadId}`)}`)}>
              <span className={cls('tl-dot', c.kind === 'awaiting' && 'reply')} />
              <div className="flex-1">
                <div className="small">{c.kind === 'owed' ? 'You owe them' : 'Waiting on them'}: {c.text}</div>
                {c.dueAt && <div className="small faint">due {fmtDate(c.dueAt, { always: true })}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {d.meetings.map((m) => (
        <div key={`${m.startsAt}${m.summary}`} className="small muted row gap-4"><CalendarClock size={12} />{m.past ? 'Last met' : 'Next'}: {m.summary} · {fmtDate(m.startsAt, { always: true })}</div>
      ))}
      {d.sequences.length > 0 && <div className="small muted mt-8">In {d.sequences.map((s) => `${s.name} (${s.status.replace('_', ' ')})`).join(', ')}</div>}
    </div>
  );
}

// ---------- Details read off their own sign-off ----------
//
// Suggestions, never writes. A signature is read with a pattern rather than a
// model, so this says the same thing every time it runs — but a line that
// pattern-matches as a job title is sometimes a department somebody was
// forwarding about, and the difference between "probably" and "certainly" is
// what the accept button is for.
function SuggestionsCard({ id, onAccepted }: { id: number; onAccepted: () => void }) {
  const can = useCan('enrich');
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const { data } = useQuery({
    queryKey: ['contact-suggestions', id],
    queryFn: () => api.get<{ suggestions: any[] }>(`/api/contacts/${id}/suggestions`),
    enabled: can,
  });
  const list = (data?.suggestions ?? []).filter((s) => !taken.has(s.field));
  if (!can || !list.length) return null;

  async function accept(s: any) {
    try {
      await api.post(`/api/contacts/${id}/suggestions/accept`, { field: s.field, value: s.value });
      setTaken((t) => new Set(t).add(s.field));
      void qc.invalidateQueries({ queryKey: ['contact', id] });
      onAccepted();
      toast.success(`${s.field[0].toUpperCase()}${s.field.slice(1)} saved`);
    } catch (e) { toast.error(e); }
  }

  return (
    <div className="card mb-16" style={{ padding: 12 }}>
      <div className="card-title" style={{ marginBottom: 8 }}><h4>From their sign-off</h4></div>
      {list.map((s) => (
        <div key={s.field} className="row mb-8" style={{ alignItems: 'flex-start' }}>
          <div className="flex-1">
            <div className="small"><span className="faint">{s.field}</span> <span className="strong">{s.value}</span></div>
            <div className="small faint">
              read from <a style={{ cursor: 'pointer' }} onClick={() => nav(`/mail/all/t/${encodeURIComponent(`${s.source.accountId}:${s.source.threadId}`)}`)}>{s.source.subject}</a>, {fmtDate(s.source.date, { always: true })}
            </div>
          </div>
          <Button size="sm" onClick={() => void accept(s)}>Use it</Button>
        </div>
      ))}
    </div>
  );
}

// ---------- A nudge for somebody who has gone quiet ----------
//
// The list has computed and labelled "Quiet 12d" since the standing column was
// added, and nothing acted on it. This is the button: it opens the composer on
// the conversation that went quiet, with a follow-up already written from what
// was actually said in it.
//
// It replies into the existing thread rather than starting a fresh one, which
// is the same bargain sequences strike with their follow-ups — a nudge under
// the original subject is a nudge, and a new email about the same thing is a
// second email about the same thing.
export function useNudge() {
  const compose = useCompose();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const nudge = async (contact: any, days: number | null) => {
    setBusy(contact.id);
    try {
      const r = await api.get<{ threads: any[] }>(`/api/contacts/${contact.id}`);
      const latest = r.threads?.[0];
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
      const instruction = [
        `Write a short, warm follow-up to ${name || contact.email}.`,
        latest
          ? 'Reply in the conversation below. Refer to what was actually said in it and ask again, lightly, about whatever was left open.'
          : 'There is no previous conversation to refer to, so keep it to two sentences and do not invent shared history.',
        days ? `They have not replied for ${days} days.` : '',
        'Do not apologise for following up, do not say "just checking in", and do not add a new ask. Three sentences at most.',
      ].filter(Boolean).join(' ');

      let out = '';
      await streamWithWork('ai', '/api/ai/draft', {
        mode: latest ? 'reply' : 'compose',
        instruction,
        length: 'short',
        contactId: contact.id,
        threadKey: latest ? `${latest.account_id}:${latest.thread_id}` : undefined,
        accountId: latest?.account_id ?? undefined,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, { onEvent: (ev, d) => { if (ev === 'done') out = d.text; if (ev === 'error') toast.error(d.error); } });
      if (!out.trim()) { toast.error('The model came back with nothing; try again'); return; }
      compose.open({
        accountId: latest?.account_id ?? null,
        kind: latest ? 'reply' : 'new',
        to: [{ name, email: contact.email }],
        contactId: contact.id,
        threadKey: latest ? `${latest.account_id}:${latest.thread_id}` : null,
        subject: latest ? '' : `Following up`,
        html: textToHtml(out),
      });
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  return { nudge, busy };
}

function ContactDrawer({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (c: any) => void }) {
  const nav = useNavigate();
  const compose = useCompose();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['contact', id], queryFn: () => api.get<any>(`/api/contacts/${id}`) });
  const c = data?.contact;
  const canWrite = useCan('ai.compose');
  const { nudge, busy: nudging } = useNudge();
  const standing = c ? standingOf(c) : null;
  const quiet = standing?.kind === 'waiting' && standing.days >= QUIET_DAYS;
  const refreshAll = () => { qc.invalidateQueries({ queryKey: ['contact', id] }); qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['thread'] }); };
  // So the assistant knows who is on screen. Without it, "what do I owe them?"
  // in the dock beside an open contact card has nothing to attach "them" to.
  useFocusContext(c ? {
    kind: 'contact',
    label: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
    ref: c.email,
    detail: [c.title, c.company].filter(Boolean).join(', ') || null,
  } : null);
  return (
    <Drawer open onClose={onClose} title={c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email : 'Contact'} actions={c && <><AskAssistant label="Catch me up" onAsk={onClose} prompt="Look up this contact and search our recent mail. Summarise where things stand, citing the conversations you read." />{quiet && canWrite && <Button size="sm" variant="ai" icon={<Sparkles size={14} />} loading={nudging === c.id} onClick={() => void nudge(c, standing.days)}>Draft a nudge</Button>}<Button size="sm" icon={<Mail size={14} />} onClick={() => compose.open({ to: [{ name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email }], contactId: c.id })}>Email</Button><Button size="sm" icon={<Pencil size={14} />} onClick={() => onEdit(c)}>Edit</Button></>}>
      {isLoading || !c ? <div className="center" style={{ padding: 40 }}><Spinner /></div> : (
        <>
          <div className="mb-16"><AvatarUploader src={c.avatar_version ? `/api/avatars/contact/${c.id}?v=${c.avatar_version}` : null} name={[c.first_name, c.last_name].join(' ') || c.email} email={c.email} onUpload={async (blob) => { await api.upload(`/api/avatars/contact/${c.id}`, blob, blob.type || 'image/webp'); refreshAll(); toast.success('Photo saved'); }} onRemove={async () => { await api.del(`/api/avatars/contact/${c.id}`); refreshAll(); }} /></div>
          <RelationshipCard id={id} contact={c} />
          <SuggestionsCard id={id} onAccepted={refreshAll} />
          <div className="row mb-16"><div className="col" style={{ gap: 2 }}><div className="strong">{c.email}</div><div className="small muted">{c.title}{c.title && c.company ? ' at ' : ''}{c.company}</div><div className="row wrap gap-4"><Badge kind={STATUS_KIND[c.status]}>{c.status.replace('_', ' ')}</Badge>{data.suppression && <Badge kind="danger"><UserX size={12} /> suppressed: {data.suppression.reason}</Badge>}</div></div></div>
          <dl className="kv mb-16">
            {c.phone && <><dt>Phone</dt><dd>{c.phone}</dd></>}
            {c.website && <><dt>Website</dt><dd><a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer">{c.website}</a></dd></>}
            <dt>Tags</dt><dd><div className="row wrap gap-4">{(c.tags ?? []).length ? c.tags.map((t: string) => <span key={t} className="tag">{t}</span>) : <span className="faint">none</span>}</div></dd>
            {c.pgp_fingerprint && <><dt>OpenPGP</dt><dd className="row gap-4"><Lock size={12} /><span className="mono small" style={{ overflowWrap: 'anywhere' }}>{String(c.pgp_fingerprint).toUpperCase().replace(/(.{4})/g, '$1 ').trim()}</span></dd></>}
            <dt>Source</dt><dd>{c.source}{c.consent_source ? ` · ${c.consent_source}` : ''}</dd>
            <dt>Added</dt><dd>{fmtDateTime(c.created_at)}</dd>
            <dt>Last contacted</dt><dd>{c.last_contacted_at ? fmtDateTime(c.last_contacted_at) : <span className="faint">never</span>}</dd>
            <dt>Last reply</dt><dd>{c.last_replied_at ? fmtDateTime(c.last_replied_at) : <span className="faint">never</span>}</dd>
            {Object.entries(c.fields ?? {}).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt><code>{`{{${k}}}`}</code></dt><dd>{String(v)}</dd></div>)}
          </dl>
          {c.notes && <div className="card mb-16" style={{ padding: 12 }}><h4 className="mb-8">Notes</h4><div className="pre small">{c.notes}</div></div>}
          {data.enrollments?.length > 0 && <><h4 className="mb-8">Sequences</h4><ul className="timeline mb-16">{data.enrollments.map((e: any) => <li key={e.id}><span className={`tl-dot ${e.status === 'replied' ? 'reply' : e.status === 'bounced' ? 'bounce' : ''}`} /><div className="flex-1"><a onClick={() => nav(`/sequences/${e.sequence_id}`)} style={{ cursor: 'pointer' }}>{e.sequence_name}</a><div className="small muted">step {e.current_step + 1} · {e.status.replace('_', ' ')}{e.next_run_at && e.status === 'active' ? ` · next ${fmtDateTime(e.next_run_at)}` : ''}</div></div></li>)}</ul></>}
          {data.threads?.length > 0 && <><h4 className="mb-8">Conversations</h4><ul className="timeline mb-16">{data.threads.map((t: any) => <li key={`${t.account_id}:${t.thread_id}`} className="clickable" onClick={() => nav(`/mail/all/t/${encodeURIComponent(`${t.account_id}:${t.thread_id}`)}`)} style={{ cursor: 'pointer' }}><span className="tl-dot" /><div className="flex-1 truncate"><div className="truncate">{t.latest.subject || '(no subject)'}</div><div className="small muted clamp-2">{fmtDate(t.latest.received_at)} · {t.latest.preview}</div></div></li>)}</ul></>}
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
          <div style={{ overflow: 'auto', maxHeight: 200 }}><table className="table small"><thead><tr>{preview.headers.map((h: string) => <th key={h}>{h}</th>)}</tr></thead><tbody>{preview.sample.map((r: string[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j} className="truncate" style={{ maxWidth: 'min(100%, 160px)' }}>{c}</td>)}</tr>)}</tbody></table></div>
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
