// The brief (F8). A page, not a notification.
//
// The whole design is in what happens when you open it: it shows what is
// already stored, says when that was, and does nothing else. Generating is
// a button. On the box this runs on a brief is close to a minute of a local
// model's time, so a page that regenerated on load would be a page nobody
// could open — and a page that regenerated on a timer would spend that
// minute every morning whether or not anybody was going to read it.
//
// When the mailbox has moved since the brief was written, the page says so
// rather than quietly refreshing. Being out of date is information; being
// silently rewritten while you read it is not.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, Inbox, Mail, RefreshCw, Timer } from 'lucide-react';
import { api, ApiError } from '../api';
import { postWithWork } from '../lib/work';
import { useFeatures } from '../state/features';
import { Button, Callout, Empty, PageHeader, Spinner } from '../components/ui';
import { FeatureOffNotice } from './Features';
import { useToast } from '../state/toast';
import { fmtRelative } from '../lib/format';

interface BriefItem { text: string; accountId?: number; threadId?: string; emailId?: number; tone?: string }
interface BriefSection { title: string; items: BriefItem[] }
interface Brief {
  summary: string;
  sections: BriefSection[];
  generatedAt: string;
  coversFrom: string | null;
  coversTo: string | null;
  model: string | null;
  durationMs: number | null;
  stale: boolean;
}

const TONE_ICON: Record<string, React.ReactNode> = {
  warning: <AlertTriangle size={14} />,
  'needs-you': <Mail size={14} />,
  waiting: <Timer size={14} />,
  bulk: <Inbox size={14} />,
};

export default function BriefPage() {
  const { can, info, loading: featuresLoading } = useFeatures();
  const toast = useToast();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const allowed = can('brief');

  const load = useCallback(async () => {
    if (!allowed) { setLoading(false); return; }
    try {
      const r = await api.get<{ brief: Brief | null }>('/api/assist/brief');
      setBrief(r.brief);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [allowed, toast]);

  useEffect(() => { void load(); }, [load]);

  const regenerate = async () => {
    setWorking(true);
    try {
      // Priced in work rather than refused by a counter: the model is shared,
      // so the cost of asking should rise with how much is already being
      // asked of it.
      const r = await postWithWork<{ brief: Brief }>('brief', '/api/assist/brief', {});
      setBrief(r.brief);
      toast.success('Brief written');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (featuresLoading || loading) return <div className="center pad-24"><Spinner /></div>;

  if (!allowed) {
    return (
      <div className="stack-20">
        <PageHeader title="Brief" sub="A page summarising what needs you." />
        <FeatureOffNotice cap={info('brief')}>
          The brief reads your recent conversations when you ask for one, and keeps the result —
          encrypted — until you ask again. It is not generated on a schedule and never sends a
          notification.
        </FeatureOffNotice>
      </div>
    );
  }

  return (
    <div className="stack-20">
      <PageHeader
        title="Brief"
        sub={brief
          ? <>Written {fmtRelative(brief.generatedAt)}{brief.model ? ` by ${brief.model}` : ''}{brief.durationMs ? `, in ${Math.round(brief.durationMs / 1000)}s` : ''}</>
          : 'Nothing written yet.'}
        actions={
          <Button variant="primary" icon={<RefreshCw size={15} className={working ? 'spin' : undefined} />} loading={working} onClick={regenerate}>
            {brief ? 'Write a new one' : 'Write one now'}
          </Button>
        }
      />

      {brief?.stale && (
        <Callout kind="info">
          <Clock size={14} /> Mail has arrived since this was written. It is still here as it was —
          press <strong>Write a new one</strong> when you want it brought up to date.
        </Callout>
      )}

      {!brief && (
        <Empty
          icon={<Mail size={26} />}
          title="No brief yet"
          action={<Button variant="primary" loading={working} onClick={regenerate}>Write one now</Button>}
        >
          It reads the last week of your mail on this server and lays out what is waiting, what you
          owe, and what can go in one action. Nothing happens until you press the button.
        </Empty>
      )}

      {brief && (
        <>
          {brief.summary && <div className="card brief-summary"><p>{brief.summary}</p></div>}
          {brief.sections.length === 0 && (
            <Empty icon={<Inbox size={26} />} title="Nothing is waiting for you">
              Nothing in the last week needs a reply, and nothing is overdue.
            </Empty>
          )}
          {brief.sections.map((section) => (
            <section key={section.title} className="stack-8">
              <h3 className="section-title">{section.title}</h3>
              <div className="card brief-list">
                {section.items.map((item, i) => {
                  const to = item.accountId && item.threadId
                    ? `/mail/inbox/t/${item.accountId}:${item.threadId}`
                    : null;
                  const body = (
                    <>
                      <span className={`brief-tone brief-tone-${item.tone ?? 'plain'}`}>{TONE_ICON[item.tone ?? ''] ?? null}</span>
                      <span className="brief-text">{item.text}</span>
                    </>
                  );
                  return to
                    ? <Link key={i} className="brief-item brief-item-link" to={to}>{body}</Link>
                    : <div key={i} className="brief-item">{body}</div>;
                })}
              </div>
            </section>
          ))}
          <p className="muted small">
            Covering {brief.coversFrom ? new Date(brief.coversFrom).toLocaleDateString() : '—'} to{' '}
            {brief.coversTo ? new Date(brief.coversTo).toLocaleDateString() : '—'}. Written on this
            server; nothing left it.
          </p>
        </>
      )}
    </div>
  );
}
