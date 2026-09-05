import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Sparkles, X, Pencil } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../state/toast';
import { Avatar, Badge, Button, Empty, Input, PageHeader, Callout } from '../components/ui';
import { Editor, type EditorHandle } from '../components/Editor';
import { fmtRelative } from '../lib/format';

export default function ReviewPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['review'], queryFn: () => api.get<{ items: any[] }>('/api/review') });
  const items = data?.items ?? [];
  async function decide(id: number, action: 'approve' | 'reject', patch?: { subject?: string; body_html?: string }) {
    try { await api.post(`/api/review/${id}`, { action, ...patch }); qc.invalidateQueries({ queryKey: ['review'] }); qc.invalidateQueries({ queryKey: ['counts'] }); toast.success(action === 'approve' ? 'Approved, sending at the next open slot' : 'Rejected; enrollment paused'); } catch (e) { toast.error(e); }
  }
  return (
    <div className="page page-narrow">
      <PageHeader title="AI review" sub="Drafts the model wrote for sequence steps and for AI responders. Approve to send, edit first, or reject." />
      {!isLoading && !items.length && <Empty icon={<Sparkles size={24} />} title="Nothing waiting" action={<Button onClick={() => nav('/sequences')}>Go to sequences</Button>}>Sequence steps with "AI personalise" and responders in review mode land here before anything goes out.</Empty>}
      {items.length > 0 && <Callout>Approved messages still respect the account's daily cap, send window and randomised delay.</Callout>}
      <div className="col gap-16 mt-16">{items.map((it) => <ReviewCard key={it.id} item={it} onDecide={decide} />)}</div>
    </div>
  );
}

function ReviewCard({ item, onDecide }: { item: any; onDecide: (id: number, a: 'approve' | 'reject', patch?: any) => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [subject, setSubject] = useState(item.subject);
  const html = useRef(item.body_html);
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setSubject(item.subject); html.current = item.body_html; }, [item]);
  const isReply = item.kind === 'reply';
  const toEmail = isReply ? (item.to_addr ?? []).map((a: any) => a.email).join(', ') : item.email;
  const name = isReply ? ((item.to_addr ?? [])[0]?.name || toEmail) : ([item.first_name, item.last_name].filter(Boolean).join(' ') || item.email);
  return (
    <div className="card">
      <div className="row mb-8"><Avatar name={name} email={toEmail} /><div className="flex-1 col" style={{ gap: 0 }}><div className="strong">{name} <span className="muted small">· {toEmail}{item.company ? ` · ${item.company}` : ''}</span></div><div className="small muted">{isReply ? `AI responder: ${item.responder_name ?? ''} · reply` : `${item.sequence_name} · step ${(item.step_position ?? 0) + 1}`} · from {item.account_email} · {fmtRelative(item.created_at)}</div></div><Badge kind="accent"><Sparkles size={12} /> {item.ai_model}</Badge></div>
      {isReply && item.original && <div className="card mb-8" style={{ padding: 10, background: 'var(--bg)' }}><div className="small muted">In reply to <b>{item.original.subject || '(no subject)'}</b> from {item.original.from?.[0]?.email}</div><div className="small muted truncate">{item.original.preview}</div></div>}
      {edit ? <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="mb-8" /> : <div className="strong mb-8">{subject || <span className="faint">(no subject)</span>}</div>}
      {edit ? <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}><Editor ref={editor} initialHtml={html.current} minHeight={160} onChange={(h) => { html.current = h; }} /></div> : <div className="msg-text" dangerouslySetInnerHTML={{ __html: isReply ? String(item.body_html).split('<div class="tern-quote"')[0] : item.body_html }} />}
      <div className="row mt-16">
        <Button variant="primary" icon={<Check size={15} />} loading={busy === 'approve'} onClick={async () => { setBusy('approve'); await onDecide(item.id, 'approve', edit ? { subject, body_html: html.current } : undefined); setBusy(null); }}>{edit ? 'Approve edited' : 'Approve'}</Button>
        <Button icon={<Pencil size={15} />} onClick={() => setEdit((e) => !e)}>{edit ? 'Stop editing' : 'Edit'}</Button>
        <Button variant="ghost" icon={<X size={15} />} loading={busy === 'reject'} onClick={async () => { setBusy('reject'); await onDecide(item.id, 'reject'); setBusy(null); }}>Reject</Button>
      </div>
    </div>
  );
}
