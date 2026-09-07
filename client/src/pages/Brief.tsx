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
//
// Laid out as something you read rather than a list you process. The one
// paragraph the model wrote is the lede and is set like prose; under it the
// sections carry the weight, and each row is drawn by its tone — a warning
// does not look like a newsletter. Everything below the lede is deterministic
// and already ordered by the server, so the page's only job is to make the
// order visible.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronRight, ClipboardCheck, Clock, Inbox, Mail, RefreshCw, Timer } from 'lucide-react';
import { api, ApiError } from '../api';
import { postWithWork } from '../lib/work';
import { localZone } from '../lib/scheduling';
import { useFeatures } from '../state/features';
import { Button, Callout, Empty, PageHeader, Spinner } from '../components/ui';
import { FeatureOffNotice } from './Features';
import { useToast } from '../state/toast';
import { cls, fmtRelative } from '../lib/format';
import { useTrackCommitment } from '../components/ThreadAside';

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

// The four tones the server labels rows with, and the one icon each. The
// icon sits in a tinted tile rather than loose in the text: at 14px a glyph
// on its own is not enough to tell two kinds of line apart at a glance, and
// telling them apart at a glance is the entire point of the page.
const TONES = ['warning', 'needs-you', 'waiting', 'bulk'] as const;
type Tone = typeof TONES[number] | 'plain';

const TONE_ICON: Record<string, React.ReactNode> = {
  warning: <AlertTriangle size={14} />,
  'needs-you': <Mail size={14} />,
  waiting: <Timer size={14} />,
  bulk: <Inbox size={14} />,
  plain: <ChevronRight size={14} />,
};

function toneOf(item: BriefItem): Tone {
  const t = item.tone ?? 'plain';
  return (TONES as readonly string[]).includes(t) ? (t as Tone) : 'plain';
}

// A section is coloured by the tone most of its rows carry. Deriving it from
// the rows rather than from the title keeps the page honest when the server
// renames a section or adds one: the client never has to know the titles.
function sectionTone(section: BriefSection): Tone {
  const counts = new Map<Tone, number>();
  for (const i of section.items) counts.set(toneOf(i), (counts.get(toneOf(i)) ?? 0) + 1);
  let best: Tone = 'plain';
  let n = 0;
  for (const [tone, c] of counts) if (c > n) { best = tone; n = c; }
  return best;
}

// A line of the brief and the two things you can do with it: open the
// conversation, or write it down.
//
// The brief and the commitments list were built to answer the same question
// from two directions — one reads a week of mail and tells you what is
// waiting, the other keeps a ledger of specific promises — and there was no
// way to get from the observation to the ledger. Now the brief is the place
// obligations are noticed and the list is where they are kept, which is the
// division of labour they were always supposed to have.
function BriefRow({ item, canTrack }: { item: BriefItem; canTrack: boolean }) {
  const track = useTrackCommitment();
  const tone = toneOf(item);
  const to = item.accountId && item.threadId ? `/mail/inbox/t/${item.accountId}:${item.threadId}` : null;
  // "waiting" is somebody else's move; everything else the brief flags is
  // yours. A bulk line is neither and is not worth tracking.
  const trackable = canTrack && Boolean(item.accountId) && tone !== 'bulk';
  const kind = tone === 'waiting' ? 'awaiting' : 'owed';

  const body = (
    <>
      <span className={`brief-tone brief-tone-${tone}`}>{TONE_ICON[tone]}</span>
      <span className="brief-text">{item.text}</span>
      {to && <ChevronRight className="brief-go" size={15} />}
    </>
  );

  return (
    <div className={cls('brief-row', `brief-row-${tone}`)}>
      {to
        ? <Link className="brief-item brief-item-link" to={to}>{body}</Link>
        : <div className="brief-item">{body}</div>}
      {trackable && (
        <button
          type="button"
          className="brief-track"
          title={kind === 'owed' ? 'Add to what you owe' : 'Add to what you are waiting on'}
          disabled={track.isPending || track.isSuccess}
          onClick={() => track.mutate({ accountId: item.accountId!, threadId: item.threadId, kind, text: item.text.slice(0, 200) })}
        >
          {track.isSuccess ? <Check size={13} /> : <ClipboardCheck size={13} />}
          <span>{track.isSuccess ? 'Tracked' : 'Track'}</span>
        </button>
      )}
    </div>
  );
}

// The shape of the day in one line: how many rows of each tone there are,
// before you read any of them. It is the only thing on the page that is not
// a sentence, and it is what tells you whether this is a morning worth
// clearing an hour for.
function Shape({ sections }: { sections: BriefSection[] }) {
  const counts = new Map<Tone, number>();
  for (const s of sections) for (const i of s.items) counts.set(toneOf(i), (counts.get(toneOf(i)) ?? 0) + 1);
  // Tones cross sections — an owed commitment and an unanswered message are
  // both "needs-you" — so these read as totals for the day rather than as
  // names for the sections underneath.
  const labels: Record<string, string> = {
    warning: 'worth a second look',
    'needs-you': 'on you',
    waiting: 'on somebody else',
    bulk: 'can go in one action',
  };
  const shown = TONES.filter((t) => counts.get(t));
  if (shown.length < 2) return null;
  return (
    <div className="brief-shape">
      {shown.map((t) => {
        const n = counts.get(t)!;
        return (
          <span key={t} className={`brief-shape-item brief-tone-${t}`}>
            {TONE_ICON[t]}
            <strong>{n}</strong>
            <span className="muted">{labels[t]}</span>
          </span>
        );
      })}
    </div>
  );
}

export default function BriefPage() {
  const { can, info, loading: featuresLoading } = useFeatures();
  const toast = useToast();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const allowed = can('brief');
  const canTrack = can('commitments');

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
      const r = await postWithWork<{ brief: Brief }>('brief', '/api/assist/brief', { tz: localZone() });
      setBrief(r.brief);
      toast.success('Brief written');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (featuresLoading || loading) return <div className="page center pad-24"><Spinner /></div>;

  if (!allowed) {
    return (
      <div className="page page-read">
        <PageHeader title="Brief" sub="A page summarising what needs you." />
        <FeatureOffNotice cap={info('brief')}>
          The brief reads your recent conversations when you ask for one, and keeps the result —
          encrypted — until you ask again. It is not generated on a schedule and never sends a
          notification.
        </FeatureOffNotice>
      </div>
    );
  }

  const covers = brief?.coversFrom && brief.coversTo
    ? `${new Date(brief.coversFrom).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(brief.coversTo).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : null;

  return (
    <div className="page page-read">
      <PageHeader
        title="Brief"
        sub={brief
          ? <>Written {fmtRelative(brief.generatedAt)}{covers ? <> · covering {covers}</> : null}</>
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
        <div className="brief">
          {/* The one part a model wrote, set as prose and given the room prose
              needs. Everything under it is the server's own arithmetic. */}
          {brief.summary && <p className="brief-lede">{brief.summary}</p>}

          <Shape sections={brief.sections} />

          {brief.sections.length === 0 && (
            <Empty icon={<Inbox size={26} />} title="Nothing is waiting for you">
              Nothing in the last week needs a reply, and nothing is overdue.
            </Empty>
          )}

          {brief.sections.map((section) => (
            <section key={section.title} className={cls('brief-section', `brief-section-${sectionTone(section)}`)}>
              <h2 className="brief-section-head">
                <span className="brief-section-title">{section.title}</span>
                <span className="brief-section-count">{section.items.length}</span>
                <span className="brief-rule" />
              </h2>
              <div className="brief-list">
                {section.items.map((item, i) => <BriefRow key={i} item={item} canTrack={canTrack} />)}
              </div>
            </section>
          ))}

          <p className="brief-colophon">
            {brief.model ? <>Written by <strong>{brief.model}</strong></> : 'Written'}
            {brief.durationMs ? ` in ${Math.round(brief.durationMs / 1000)}s` : ''} on this server.
            Nothing left it.
          </p>
        </div>
      )}
    </div>
  );
}
