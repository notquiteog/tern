import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Workflow, Play, Pause, Archive, Sparkles, Copy, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { postWithWork } from '../lib/work';
import { useToast } from '../state/toast';
import { useAccounts, useSequences, useContactTags } from '../lib/queries';
import { Badge, Button, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Textarea, Callout } from '../components/ui';
import { stripHtml, textToHtml } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { DictateBox, DictateButton, appendDictated } from '../components/Dictate';

const STATUS_KIND: Record<string, any> = { active: 'success', paused: 'warning', draft: undefined, archived: undefined };

// The audience filter as the query string the contact list takes. The server
// has the same function; this one exists so enrolling can re-run the filter
// and get ids without a second round trip to describe it again.
function audParams(f: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['tag', 'status', 'intent', 'intentFrom', 'intentTo', 'q']) if (f?.[k]) out[k] = String(f[k]);
  if (f?.quietDays) out.quietDays = String(f.quietDays);
  return out;
}

export default function SequencesPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sequences = [], isLoading } = useSequences();
  const { data: accounts = [] } = useAccounts();
  const [create, setCreate] = useState(params.get('new') === '1');
  const [campaign, setCampaign] = useState(params.get('campaign') === '1');
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
  // Templates have had this since they shipped and sequences never did, so
  // every campaign started from a blank page even when it was last month's
  // campaign with two sentences changed. The copy opens straight away: the
  // point of duplicating is to edit it.
  async function duplicate(id: number) {
    try {
      const r = await api.post<any>(`/api/sequences/${id}/duplicate`);
      qc.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Copied as a draft');
      nav(`/sequences/${r.sequence.id}`);
    } catch (e) { toast.error(e); }
  }
  const visible = sequences.filter((s) => s.status !== 'archived');
  const archived = sequences.filter((s) => s.status === 'archived');
  return (
    <div className="page">
      <PageHeader title="Sequences" sub="Multi-step outreach that stops itself when someone replies." actions={<><Button variant="ai" icon={<Sparkles size={15} />} onClick={() => setCampaign(true)}>AI campaign</Button><Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>New sequence</Button></>} />
      {!isLoading && !sequences.length && <Empty icon={<Workflow size={24} />} title="No sequences yet" action={<Button variant="primary" onClick={() => setCreate(true)}>Create one</Button>}>A sequence is a few emails with waits in between. Enroll contacts, activate it, and Tern sends within the account's window with natural gaps.</Empty>}
      {/* Shapes to start from.
          Templates have had a starter library since they shipped; sequences
          began from an empty editor and a decision about how many steps and
          how far apart — questions somebody writing their first campaign has
          no basis to answer and which have well-known answers. What these
          carry is the structure, not the copy: a library of ready-made sales
          prose would be somebody else's voice and the same email every
          install of Tern sends. */}
      {!isLoading && !sequences.length && <SequenceLibrary accounts={accounts} onMade={(id) => nav(`/sequences/${id}`)} />}
      <div className="grid-cards">
        {visible.map((s) => <SequenceCard key={s.id} s={s} onOpen={() => nav(`/sequences/${s.id}`)} onStatus={(st) => setStatus(s.id, st)} onDuplicate={() => duplicate(s.id)} />)}
      </div>
      {archived.length > 0 && <><h4 className="mt-24 mb-8">Archived</h4><div className="grid-cards">{archived.map((s) => <SequenceCard key={s.id} s={s} onOpen={() => nav(`/sequences/${s.id}`)} onStatus={(st) => setStatus(s.id, st)} onDuplicate={() => duplicate(s.id)} />)}</div></>}
      <CampaignModal open={campaign} onClose={() => { setCampaign(false); setParams((p) => { p.delete('campaign'); return p; }); }} accounts={accounts} />
      <Modal open={create} onClose={() => { setCreate(false); setParams((p) => { p.delete('new'); return p; }); }} title="New sequence" footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={doCreate}>Create</Button></>}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Warm intro · Q4 customers" /></Field>
        <Field label="Sending account" hint="Every email in this sequence goes out from this mailbox and counts against its daily cap."><Select value={acc} onChange={(e) => setAcc(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt;</option>)}{!accounts.length && <option value="">Connect an account first</option>}</Select></Field>
        <Field label="Description (optional)"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} style={{ minHeight: 60 }} /></Field>
        <div className="help-text">Starts as a draft with a three-step skeleton: email, wait 3 days, follow-up in the same thread.</div>
      </Modal>
    </div>
  );
}

function SequenceLibrary({ accounts, onMade }: { accounts: any[]; onMade: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['sequence-library'], queryFn: () => api.get<{ sequences: any[] }>('/api/sequences/library') });
  if (!data?.sequences?.length) return null;
  async function start(key: string) {
    setBusy(key);
    try {
      const r = await api.post<any>('/api/sequences/library', { key, account_id: accounts[0]?.id ?? null });
      qc.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Created as a draft — edit the briefs before activating it');
      onMade(r.sequence.id);
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  }
  return (
    <>
      <h4 className="mt-24 mb-8">Or start from a shape</h4>
      <div className="grid-cards">
        {data.sequences.map((l) => (
          <div key={l.key} className="card">
            <div className="card-title"><h2 className="clamp-2">{l.name}</h2></div>
            <div className="small muted mb-8">{l.when}</div>
            <div className="small mb-8">{l.description}</div>
            <div className="small faint mb-8">
              {l.steps.filter((st: any) => st.kind === 'email').length} emails over {l.steps.reduce((n: number, st: any) => n + (st.days ?? 0), 0)} days
            </div>
            <Button size="sm" loading={busy === l.key} onClick={() => void start(l.key)}>Use this shape</Button>
          </div>
        ))}
      </div>
    </>
  );
}

function SequenceCard({ s, onOpen, onStatus, onDuplicate }: { s: any; onOpen: () => void; onStatus: (st: string) => void; onDuplicate: () => void }) {
  const st = s.stats ?? {};
  const replyRate = s.sent_count ? Math.round((100 * (s.reply_count ?? 0)) / s.sent_count) : 0;
  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="card-title"><h2 className="clamp-2">{s.name}</h2><Badge kind={STATUS_KIND[s.status]} dot>{s.status}</Badge></div>
      <div className="small muted mb-8 clamp-2">{s.step_count} step{s.step_count === 1 ? '' : 's'} · {s.account_email ?? <span style={{ color: 'var(--warning-text)' }}>no sending account</span>}{s.ai_mode !== 'off' ? ` · AI ${s.ai_mode}` : ''}</div>
      {/* Why it stopped, not just that it did. A campaign paused for a hole in
          its brief used to say so only in the enrollment table, so the card
          said "paused" and left somebody to go and find out what for. */}
      {s.status === 'paused' && s.pause_reason && <div className="small mb-8" style={{ color: 'var(--warning-text)' }}>{s.pause_reason}</div>}
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
          <IconButton label="Duplicate" className="btn-sm" onClick={onDuplicate}><Copy size={13} /></IconButton>
          {s.status !== 'archived' && <Button size="sm" variant="ghost" icon={<Archive size={13} />} onClick={() => onStatus('archived')}>Archive</Button>}
        </div>
      </div>
    </div>
  );
}


// One-shot list send with generated content: a brief, an audience, an
// account. Creates a one-step sequence with AI personalisation and enrolls
// the audience, so every safeguard a sequence has still applies.
function CampaignModal({ open, onClose, accounts }: { open: boolean; onClose: () => void; accounts: any[] }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: tags = [] } = useContactTags();
  const { data: sequences = [] } = useSequences();
  const [acc, setAcc] = useState<number | ''>('');
  const [brief, setBrief] = useState('');
  const [audience, setAudience] = useState<'tag' | 'sentence' | 'all' | 'none'>('tag');
  const [tag, setTag] = useState('');
  const [previews, setPreviews] = useState<any[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  // The one somebody edited until it was right, kept as the example the rest
  // are written from. See `DraftInput.exemplar`.
  const [exemplar, setExemplar] = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // The silent sample. Its own state because it is a measurement of the brief
  // rather than more drafts to read.
  const [rate, setRate] = useState<any | null>(null);
  const [rating, setRating] = useState(false);
  // An audience described in a sentence, as chips.
  const [sentence, setSentence] = useState('');
  const [aud, setAud] = useState<any | null>(null);
  const [auding, setAuding] = useState(false);
  // Everything below is a default nobody has to open. They live behind one
  // disclosure rather than on the form, because a first campaign should be a
  // sentence and a list, and every field in front of that is a decision the
  // person did not ask to make.
  const [more, setMore] = useState(false);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<'review' | 'auto'>('review');
  const [followUp, setFollowUp] = useState(true);
  useEffect(() => { if (accounts.length && acc === '') setAcc(accounts[0].id); }, [accounts, acc]);
  useEffect(() => { if (tags.length && !tag) setTag(tags[0].tag); }, [tags, tag]);
  // A new brief invalidates what was previewed from the old one.
  useEffect(() => { setPreviews(null); setRate(null); }, [brief, tag, audience, instructions, exemplar]);
  // Notes about the brief, in the guard's own vocabulary.
  //
  // Asked of the server rather than worked out here: these have to agree with
  // what the guard actually holds, and a second implementation in the browser
  // would drift the first time either was touched. No model is involved, so a
  // short debounce is all it costs.
  const debouncedBrief = useDebounced(brief, 400);
  const { data: noteData } = useQuery({
    queryKey: ['brief-notes', debouncedBrief],
    queryFn: () => api.post<{ notes: { kind: string; note: string }[] }>('/api/sequences/brief-notes', { brief: debouncedBrief }),
    enabled: debouncedBrief.trim().length >= 20,
  });
  const notes = noteData?.notes ?? [];

  // Nothing a 4B model wrote reaches a real inbox unseen. Sending
  // automatically is offered only once a campaign has actually been reviewed
  // through once, so the first one is always read by a person.
  const hasReviewedBefore = sequences.some((s: any) => s.ai_mode === 'review' && (s.sent_count ?? 0) > 0);
  const effectiveMode = hasReviewedBefore ? mode : 'review';
  // The name is derived from the brief rather than asked for.
  const derivedName = brief.replace(/^(?:we have|we|i want to|i'd like to|i)\s+/i, '').split(/[,.]/)[0].split(/\s+/).slice(0, 6).join(' ');
  const finalName = name.trim() || derivedName || 'New campaign';

  async function preview() {
    if (!brief.trim() || !acc) { toast.error('A sending account and a brief are needed first'); return; }
    setPreviewing(true);
    try {
      const r = await api.post<any>('/api/sequences/campaign-preview', {
        account_id: acc, brief, instructions: instructions || undefined,
        exemplar: exemplar || undefined,
        tag: audience === 'tag' ? tag : undefined,
        contactIds: aud?.sample?.length ? aud.sample.map((c: any) => c.id) : undefined,
        count: 3,
      });
      setPreviews(r.previews);
    } catch (e) { toast.error(e); } finally { setPreviewing(false); }
  }

  // The silent sample: ten drafts nobody sees, reported as arithmetic.
  async function checkRate() {
    if (!brief.trim() || !acc) { toast.error('A sending account and a brief are needed first'); return; }
    setRating(true);
    try {
      setRate(await api.post<any>('/api/sequences/campaign-held-rate', {
        account_id: acc, brief, instructions: instructions || undefined, exemplar: exemplar || undefined,
        tag: audience === 'tag' ? tag : undefined, count: 10,
      }));
    } catch (e) { toast.error(e); } finally { setRating(false); }
  }

  // A sentence becomes chips. The chips are the audience from then on — taking
  // one off re-counts without going near the model, so a removed chip cannot
  // come back.
  async function describeAudience() {
    if (!sentence.trim()) return;
    setAuding(true);
    try { setAud(await postWithWork<any>('ai', '/api/contacts/audience', { sentence })); }
    catch (e) { toast.error(e); } finally { setAuding(false); }
  }
  async function dropChip(key: string) {
    const next = { ...(aud?.filter ?? {}) };
    delete next[key];
    if (!Object.keys(next).length) { setAud(null); return; }
    try { setAud(await api.post<any>('/api/contacts/audience/count', next)); } catch (e) { toast.error(e); }
  }

  async function create() {
    if (!brief.trim() || !acc) { toast.error('A sending account and a brief are needed'); return; }
    setBusy(true);
    try {
      const steps: any[] = [{ kind: 'email', subject: '', body_html: textToHtml(brief), ai_personalize: true, ai_instructions: instructions, ai_exemplar: exemplar }];
      // The follow-up gets the exemplar too: it is the same voice writing to
      // the same list, and the whole point of an example is that it travels.
      if (followUp) steps.push({ kind: 'wait', wait_days: 4 }, { kind: 'email', subject: '', body_html: textToHtml('Short, friendly follow-up to the previous email. Ask if they had a chance to read it and restate the single most useful point in one sentence.'), ai_personalize: true, ai_instructions: instructions, ai_exemplar: exemplar, reply_in_thread: true });
      const r = await api.post<any>('/api/sequences', { name: finalName, account_id: acc, ai_mode: effectiveMode, stop_on_reply: true, unsubscribe_footer: true, description: `AI campaign. Brief: ${brief}`, steps });
      const id = r.sequence.id;
      let enrolled = 0;
      if (audience === 'sentence' && aud?.sample?.length) {
        // Enrolled by id, from the same filter the count came from, so what
        // goes out is exactly what the chips said it would be.
        const ids = await api.get<any>(`/api/contacts?${new URLSearchParams({ ...audParams(aud.filter), size: '200' })}`);
        const e = await api.post<any>(`/api/sequences/${id}/enroll`, { contactIds: ids.contacts.map((c: any) => c.id) });
        enrolled = e.enrolled;
      }
      if (audience === 'tag' && tag) { const e = await api.post<any>(`/api/sequences/${id}/enroll`, { tag }); enrolled = e.enrolled; }
      if (audience === 'all') { const e = await api.post<any>(`/api/sequences/${id}/enroll`, { all: true }); enrolled = e.enrolled; }
      if (enrolled > 0) await api.post(`/api/sequences/${id}/status`, { status: 'active' });
      qc.invalidateQueries({ queryKey: ['sequences'] });
      toast.success(enrolled > 0 ? `Campaign live: ${enrolled} contacts enrolled${effectiveMode === 'review' ? ', drafts will appear in AI review' : ''}` : 'Campaign created as a draft; enroll contacts to start');
      onClose(); nav(`/sequences/${id}`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI campaign"
      size="wide"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        {!previews
          ? <Button variant="ai" icon={<Sparkles size={14} />} loading={previewing} onClick={preview}>Preview 3 emails</Button>
          : <Button variant="ai" icon={<Sparkles size={14} />} loading={busy} onClick={create}>Approve and start</Button>}
      </>}
    >
      <Callout>Write one sentence about what the email should say. The model writes a different email for each contact from that and their own fields, and you see three of them before anything is created.{!hasReviewedBefore && ' Your first campaign always goes through review — nothing is sent until you approve it.'}</Callout>
      <Field label="What should the email say?" hint="Facts only; nothing that is not here will be invented.">
        <DictateBox title="Say what the email should say" onText={(t) => setBrief((v) => appendDictated(v, t))}>
          <Textarea autoFocus value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="We just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they'd like a 15 minute walkthrough next week." style={{ minHeight: 90 }} />
        </DictateBox>
      </Field>
      {/* What the guard will probably say, said now.
          The guard already knows every way a campaign draft goes wrong, and
          nearly all of them are decided by the brief. Running that vocabulary
          over the brief costs nothing and answers in a tenth of a second what
          would otherwise take forty seconds of generation and a held draft. */}
      {notes.length > 0 && (
        <div className="brief-notes mb-16">
          {notes.map((n, i) => <div key={i} className="small"><AlertTriangle size={12} /> {n.note}</div>)}
        </div>
      )}

      <div className="form-row">
        <Field label="Who to"><Select value={audience} onChange={(e) => setAudience(e.target.value as any)}><option value="tag">Contacts with a tag</option><option value="sentence">Describe them in a sentence</option><option value="all">All active contacts</option><option value="none">Nobody yet (enroll later)</option></Select></Field>
        {audience === 'tag' && <Field label="Tag"><Select value={tag} onChange={(e) => setTag(e.target.value)}>{tags.map((t: any) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}{!tags.length && <option value="">no tags yet</option>}</Select></Field>}
      </div>

      {/* An audience described in words, shown as chips that come off one at a
          time. The model drafts the filter once; from then on the chips are
          the audience, so correcting it never means arguing with the model
          about a word it would not let go of. */}
      {audience === 'sentence' && (
        <Field label="Describe who to write to" hint="Their tags, their custom fields, what they last replied, and how long they have been quiet.">
          <div className="row">
            <Input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="customers on Sage who went quiet in March" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void describeAudience(); } }} />
            <Button variant="ai" icon={<Sparkles size={14} />} loading={auding} disabled={!sentence.trim()} onClick={() => void describeAudience()}>Find them</Button>
          </div>
          {aud && (
            <div className="mt-8">
              <div className="row gap-4 wrap mb-8">
                {aud.chips.map((c: any) => (
                  <span key={`${c.key}-${c.label}`} className="chip">{c.label}<button type="button" className="chip-x" aria-label={`Remove ${c.label}`} onClick={() => void dropChip(c.key)}>×</button></span>
                ))}
              </div>
              <div className="small muted">
                <b>{aud.total}</b> contact{aud.total === 1 ? '' : 's'}{aud.sample.length > 0 && <> · {aud.sample.slice(0, 3).map((c: any) => c.name || c.email).join(', ')}{aud.total > 3 ? ' and others' : ''}</>}
              </div>
            </div>
          )}
        </Field>
      )}

      {previews && (
        <div className="mt-16">
          <div className="strong small mb-8">What it wrote for the first three</div>
          {previews.map((p: any, i: number) => (
            <div key={i} className="card mb-8">
              <div className="small muted">to {p.contact.name || p.contact.email}{p.contact.company ? ` · ${p.contact.company}` : ''}</div>
              <div className="strong small mt-4">{p.subject}</div>
              <div className="small mt-8" style={{ whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={{ __html: p.html }} />
              {p.heldFor && <div className="small mt-8" style={{ color: 'var(--warning-text)' }}>Held for review: {p.heldFor}</div>}
              {/* Edit one, and the rest are written like it.
                  "Try again" rolls the same dice at the same prompt. A
                  concrete example of the wanted output is the strongest
                  steering a small model responds to — far stronger than
                  another adjective in the instructions, because an example is
                  unambiguous where "warmer" is not. */}
              {editingIdx === i ? (
                <div className="mt-8">
                  <Textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} style={{ minHeight: 160 }} />
                  <div className="row gap-4 mt-8">
                    <Button size="sm" variant="primary" onClick={() => { setExemplar(editDraft); setEditingIdx(null); toast.success('The rest will be written like this one'); }}>Use as the example</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingIdx(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="row gap-4 mt-8">
                  <Button size="sm" variant="ghost" onClick={() => { setEditingIdx(i); setEditDraft(stripHtml(p.html)); }}>Edit this one</Button>
                </div>
              )}
            </div>
          ))}
          {exemplar && (
            <div className="small muted mb-8 row gap-4">
              <Sparkles size={12} /> The rest are being written to match your edited example.
              <button type="button" className="link" onClick={() => setExemplar('')}>Stop using it</button>
            </div>
          )}
          <div className="row gap-4 small muted wrap">
            <Button size="sm" loading={previewing} onClick={preview}>Try again</Button>
            {/* Three clean drafts from a brief that invents a date on one
                contact in five look exactly like three clean drafts from a
                brief that never will. This is the difference. */}
            <Button size="sm" loading={rating} onClick={() => void checkRate()}>Check ten more</Button>
            <span>Not right? Edit the sentence above and preview again.</span>
          </div>
          {rate && (
            <div className="small mt-8" style={{ color: rate.held ? 'var(--warning-text)' : 'var(--text-2)' }}>
              {rate.held === 0
                ? `None of ${rate.sampled} more would be held. The brief is in good shape.`
                : `${rate.held} of ${rate.sampled} would be held${rate.commonest ? `, usually for ${rate.commonest}` : ''}. Fixing the brief now is cheaper than fixing the queue later.`}
            </div>
          )}
        </div>
      )}

      <button type="button" className="link small mt-16" onClick={() => setMore(!more)}>{more ? 'Hide' : 'Show'} the settings you probably do not need</button>
      {more && (
        <div className="mt-8">
          <div className="form-row">
            <Field label="Campaign name" hint={`Defaults to "${derivedName || 'New campaign'}"`}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName} /></Field>
            <Field label="Sending account"><Select value={acc} onChange={(e) => setAcc(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt; · cap {a.daily_cap}/day</option>)}</Select></Field>
          </div>
          <Field label="Style instructions"><div className="row"><Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Under 100 words, no exclamation marks" /><DictateButton title="Say the style instructions" onText={(t) => setInstructions((v) => appendDictated(v, t))} /></div></Field>
          <Field label="Before sending" hint={hasReviewedBefore ? undefined : 'Available once you have reviewed and sent one campaign.'}>
            <Select value={effectiveMode} disabled={!hasReviewedBefore} onChange={(e) => setMode(e.target.value as any)}><option value="review">Review each draft</option><option value="auto">Send automatically</option></Select>
          </Field>
          <label className="row small"><input type="checkbox" className="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} /> Follow up in the same thread after 4 days if they have not replied</label>
        </div>
      )}
    </Modal>
  );
}
