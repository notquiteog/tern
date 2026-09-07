import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Workflow, Play, Pause, Archive, Sparkles } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { useAccounts, useSequences, useContactTags } from '../lib/queries';
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, Select, Textarea, Callout } from '../components/ui';
import { textToHtml } from '../lib/format';

const STATUS_KIND: Record<string, any> = { active: 'success', paused: 'warning', draft: undefined, archived: undefined };

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
  const visible = sequences.filter((s) => s.status !== 'archived');
  const archived = sequences.filter((s) => s.status === 'archived');
  return (
    <div className="page">
      <PageHeader title="Sequences" sub="Multi-step outreach that stops itself when someone replies." actions={<><Button variant="ai" icon={<Sparkles size={15} />} onClick={() => setCampaign(true)}>AI campaign</Button><Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>New sequence</Button></>} />
      {!isLoading && !sequences.length && <Empty icon={<Workflow size={24} />} title="No sequences yet" action={<Button variant="primary" onClick={() => setCreate(true)}>Create one</Button>}>A sequence is a few emails with waits in between. Enroll contacts, activate it, and Tern sends within the account's window with natural gaps.</Empty>}
      <div className="grid-cards">
        {visible.map((s) => <SequenceCard key={s.id} s={s} onOpen={() => nav(`/sequences/${s.id}`)} onStatus={(st) => setStatus(s.id, st)} />)}
      </div>
      {archived.length > 0 && <><h4 className="mt-24 mb-8">Archived</h4><div className="grid-cards">{archived.map((s) => <SequenceCard key={s.id} s={s} onOpen={() => nav(`/sequences/${s.id}`)} onStatus={(st) => setStatus(s.id, st)} />)}</div></>}
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

function SequenceCard({ s, onOpen, onStatus }: { s: any; onOpen: () => void; onStatus: (st: string) => void }) {
  const st = s.stats ?? {};
  const replyRate = s.sent_count ? Math.round((100 * (s.reply_count ?? 0)) / s.sent_count) : 0;
  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="card-title"><h2 className="clamp-2">{s.name}</h2><Badge kind={STATUS_KIND[s.status]} dot>{s.status}</Badge></div>
      <div className="small muted mb-8 clamp-2">{s.step_count} step{s.step_count === 1 ? '' : 's'} · {s.account_email ?? <span style={{ color: 'var(--warning-text)' }}>no sending account</span>}{s.ai_mode !== 'off' ? ` · AI ${s.ai_mode}` : ''}</div>
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
  const [audience, setAudience] = useState<'tag' | 'all' | 'none'>('tag');
  const [tag, setTag] = useState('');
  const [previews, setPreviews] = useState<any[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
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
  useEffect(() => { setPreviews(null); }, [brief, tag, audience, instructions]);

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
        tag: audience === 'tag' ? tag : undefined, count: 3,
      });
      setPreviews(r.previews);
    } catch (e) { toast.error(e); } finally { setPreviewing(false); }
  }

  async function create() {
    if (!brief.trim() || !acc) { toast.error('A sending account and a brief are needed'); return; }
    setBusy(true);
    try {
      const steps: any[] = [{ kind: 'email', subject: '', body_html: textToHtml(brief), ai_personalize: true, ai_instructions: instructions }];
      if (followUp) steps.push({ kind: 'wait', wait_days: 4 }, { kind: 'email', subject: '', body_html: textToHtml('Short, friendly follow-up to the previous email. Ask if they had a chance to read it and restate the single most useful point in one sentence.'), ai_personalize: true, ai_instructions: instructions, reply_in_thread: true });
      const r = await api.post<any>('/api/sequences', { name: finalName, account_id: acc, ai_mode: effectiveMode, stop_on_reply: true, unsubscribe_footer: true, description: `AI campaign. Brief: ${brief}`, steps });
      const id = r.sequence.id;
      let enrolled = 0;
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
        <Textarea autoFocus value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="We just launched same-day bookkeeping reports for wholesale businesses. Existing customers get it free until January. Ask if they'd like a 15 minute walkthrough next week." style={{ minHeight: 90 }} />
      </Field>
      <div className="form-row">
        <Field label="Who to"><Select value={audience} onChange={(e) => setAudience(e.target.value as any)}><option value="tag">Contacts with a tag</option><option value="all">All active contacts</option><option value="none">Nobody yet (enroll later)</option></Select></Field>
        {audience === 'tag' && <Field label="Tag"><Select value={tag} onChange={(e) => setTag(e.target.value)}>{tags.map((t: any) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}{!tags.length && <option value="">no tags yet</option>}</Select></Field>}
      </div>

      {previews && (
        <div className="mt-16">
          <div className="strong small mb-8">What it wrote for the first three</div>
          {previews.map((p: any, i: number) => (
            <div key={i} className="card mb-8">
              <div className="small muted">to {p.contact.name || p.contact.email}{p.contact.company ? ` · ${p.contact.company}` : ''}</div>
              <div className="strong small mt-4">{p.subject}</div>
              <div className="small mt-8" style={{ whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={{ __html: p.html }} />
              {p.heldFor && <div className="small mt-8" style={{ color: 'var(--warning-text)' }}>Held for review: {p.heldFor}</div>}
            </div>
          ))}
          <div className="row gap-4 small muted">
            <Button size="sm" loading={previewing} onClick={preview}>Try again</Button>
            <span>Not right? Edit the sentence above and preview again.</span>
          </div>
        </div>
      )}

      <button type="button" className="link small mt-16" onClick={() => setMore(!more)}>{more ? 'Hide' : 'Show'} the settings you probably do not need</button>
      {more && (
        <div className="mt-8">
          <div className="form-row">
            <Field label="Campaign name" hint={`Defaults to "${derivedName || 'New campaign'}"`}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName} /></Field>
            <Field label="Sending account"><Select value={acc} onChange={(e) => setAcc(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt; · cap {a.daily_cap}/day</option>)}</Select></Field>
          </div>
          <Field label="Style instructions"><Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Under 100 words, no exclamation marks" /></Field>
          <Field label="Before sending" hint={hasReviewedBefore ? undefined : 'Available once you have reviewed and sent one campaign.'}>
            <Select value={effectiveMode} disabled={!hasReviewedBefore} onChange={(e) => setMode(e.target.value as any)}><option value="review">Review each draft</option><option value="auto">Send automatically</option></Select>
          </Field>
          <label className="row small"><input type="checkbox" className="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} /> Follow up in the same thread after 4 days if they have not replied</label>
        </div>
      )}
    </Modal>
  );
}
