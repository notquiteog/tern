import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Sparkles, Workflow, Send, Reply, AlertTriangle, Contact } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../state/auth';
import { Badge, Button, Progress, Spinner, PageHeader } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNumber } from '../lib/format';

export default function HomePage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['stats'], queryFn: () => api.get<any>('/api/settings/stats'), refetchInterval: 60_000 });
  if (isLoading || !data) return <div className="center" style={{ padding: 60 }}><Spinner size={24} /></div>;
  const max = Math.max(1, ...data.daily.map((d: any) => Number(d.sent)));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const replyRate = data.week.sent ? Math.round((100 * data.week.replied) / data.week.sent) : 0;
  return (
    <div className="page">
      <PageHeader title={`${greeting}, ${user!.display_name.split(' ')[0]}`} sub="What Tern sent, who replied, and what needs a decision." />
      <div className="stats-row">
        <div className="card stat"><div className="stat-value">{fmtNumber(data.week.sent)}</div><div className="stat-label"><Send size={12} /> sent, last 7 days</div></div>
        <div className="card stat"><div className="stat-value">{fmtNumber(data.week.replied)} <span className="muted" style={{ fontSize: 14 }}>({replyRate}%)</span></div><div className="stat-label"><Reply size={12} /> replies</div></div>
        <div className="card stat"><div className="stat-value">{fmtNumber(data.enrollments?.active ?? 0)}</div><div className="stat-label"><Workflow size={12} /> contacts in sequences</div></div>
        <div className="card stat" style={data.reviewPending ? { borderColor: 'var(--accent)' } : {}}><div className="stat-value">{fmtNumber(data.reviewPending)}</div><div className="stat-label"><Sparkles size={12} /> drafts to review</div>{data.reviewPending > 0 && <Button size="sm" variant="soft" className="mt-8" onClick={() => nav('/review')}>Review now <ArrowRight size={13} /></Button>}</div>
        {(data.week.bounced > 0 || data.week.failed > 0) && <div className="card stat"><div className="stat-value" style={{ color: 'var(--danger)' }}>{fmtNumber(data.week.bounced + data.week.failed)}</div><div className="stat-label"><AlertTriangle size={12} /> bounced or failed</div></div>}
      </div>
      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="card">
          <div className="card-title"><h2>Sending today</h2><Button size="sm" variant="ghost" onClick={() => nav('/settings/accounts')}>Policy</Button></div>
          {!data.accounts.length && <div className="muted small">No accounts connected. <a onClick={() => nav('/settings/accounts')} style={{ cursor: 'pointer' }}>Add one</a>.</div>}
          {data.accounts.map((a: any) => (
            <div key={a.id} className="mb-16">
              <div className="row small mb-8"><span className="swatch" style={{ width: 10, height: 10, borderRadius: 3, background: a.color, display: 'inline-block' }} /><span className="strong truncate">{a.email}</span><span className="ml-auto muted">{a.sentToday} / {a.daily_cap}</span></div>
              <Progress value={a.sentToday} max={a.daily_cap} />
              <div className="small faint mt-8">window {String(a.send_window?.start).padStart(2, '0')}:00–{String(a.send_window?.end).padStart(2, '0')}:00 {a.send_window?.tz} · {a.sync_status === 'idle' ? `synced ${fmtDate(a.last_sync_at)}` : a.sync_status}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-title"><h2>Last 14 days</h2><span className="small muted">sent · replies</span></div>
          <div className="bar-chart">{data.daily.map((d: any) => <div key={d.day} className="bar" title={`${d.day}: ${d.sent} sent, ${d.replied} replied`}><div style={{ height: `${(100 * Number(d.sent)) / max}%` }} /><div className="reply" style={{ height: `${(100 * Number(d.replied)) / max}%` }} /><span>{d.day.slice(8)}</span></div>)}</div>
        </div>
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-title"><h2>Recent sends</h2><Button size="sm" variant="ghost" onClick={() => nav('/mail/sent')}>Sent folder</Button></div>
          {!data.recent.length ? <div className="muted small">Nothing sent yet. Compose a message or activate a sequence.</div> : (
            <div className="table-wrap"><table className="table"><tbody>{data.recent.map((r: any) => <tr key={r.id}><td style={{ width: 20 }}><span className="swatch" style={{ width: 10, height: 10, borderRadius: 3, background: r.color, display: 'inline-block' }} /></td><td className="truncate" style={{ maxWidth: 220 }}>{r.to_email}</td><td className="truncate">{r.subject || '(no subject)'}</td><td><Badge>{r.kind}</Badge></td><td>{r.status === 'failed' ? <Badge kind="danger">failed</Badge> : r.bounced_at ? <Badge kind="danger">bounced</Badge> : r.replied_at ? <Badge kind="success">replied</Badge> : <Badge kind="accent">sent</Badge>}</td><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.sent_at)}</td></tr>)}</tbody></table></div>
          )}
        </div>
      </div>
      <div className="row mt-24 wrap gap-12"><Button icon={<Contact size={15} />} onClick={() => nav('/contacts?import=1')}>Import contacts</Button><Button icon={<Workflow size={15} />} onClick={() => nav('/sequences?new=1')}>New sequence</Button><Button icon={<Sparkles size={15} />} onClick={() => nav('/settings/ai')}>AI settings</Button></div>
    </div>
  );
}
