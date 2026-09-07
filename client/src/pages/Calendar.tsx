// The calendar (F13).
//
// Three views, and they exist for three different questions. Month answers
// "what does the shape of this look like"; week answers "where does this
// fit"; agenda answers "what is next", and is the one a phone gets, because
// a month grid on a 375-pixel screen is twenty-eight unreadable boxes.
//
// Everything here is drawn from occurrences the server has already expanded,
// so a recurring meeting costs the same as a one-off and the browser never
// has to know what an RRULE is.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, ExternalLink, Loader2, MapPin, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { api, ApiError } from '../api';
import { useFeatures } from '../state/features';
import { FeatureOffNotice } from './Features';
import { Badge, Button, Callout, Empty, Field, Input, Modal, PageHeader, Segmented, Select, Spinner, Textarea, Toggle } from '../components/ui';
import { useToast } from '../state/toast';
import { cls } from '../lib/format';

export interface CalEvent {
  id: number;
  objectId: number;
  calendarId: number;
  calendarName: string;
  color: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  busy: boolean;
  summary: string | null;
  location: string | null;
  recurrenceId: string | null;
  readOnly: boolean;
}

interface CalendarRow { id: number; name: string; color: string | null; readOnly: boolean; selected: boolean; isDefault: boolean; push: boolean }
interface SourceRow { id: number; kind: string; label: string; status: string; error: string | null; lastSyncAt: string | null; calendars: CalendarRow[] }

type View = 'month' | 'week' | 'agenda';

const DAY = 86_400_000;
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

// Midnight local, as an instant. Everything in the grid is laid out from
// these, so a month never gains or loses a day at a clock change.
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d: Date): Date { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); } // Monday
function sameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

const hhmm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

// Which day a row belongs on.
//
// An all-day event has no time zone by definition: Christmas is the 25th
// everywhere, and the server stores it as midnight UTC to have somewhere to
// put it. Converting that into the viewer's zone is how a holiday lands on
// the 24th for everyone west of London — so the date is read straight off the
// UTC fields and rebuilt as a local midnight, which is the day to draw it on.
// A timed event is the opposite: it is an instant, and belongs on whichever
// local day that instant falls in.
function dayOf(iso: string, allDay: boolean): Date {
  const d = new Date(iso);
  return allDay ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : startOfDay(d);
}

// The same rule for reading one back out: an all-day event is formatted from
// its UTC fields, everything else from the viewer's clock.
function formatDay(iso: string, allDay: boolean): string {
  return allDay
    ? new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(iso))
    : longDay.format(new Date(iso));
}

// The window a view needs, padded so a drag backwards does not refetch.
function rangeFor(view: View, anchor: Date): { from: Date; to: Date } {
  if (view === 'week') { const s = startOfWeek(anchor); return { from: addDays(s, -1), to: addDays(s, 8) }; }
  if (view === 'agenda') { const s = startOfDay(anchor); return { from: s, to: addDays(s, 60) }; }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  return { from: addDays(startOfWeek(first), -7), to: addDays(startOfWeek(first), 49) };
}

export default function CalendarPage() {
  const { can, info, loading: featuresLoading } = useFeatures();
  const toast = useToast();
  const [view, setView] = useState<View>(() => (window.matchMedia('(max-width: 720px)').matches ? 'agenda' : 'month'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<{ objectId?: number; startsAt: Date; allDay?: boolean; scope?: EditScope; occurrence?: string | null } | null>(null);
  const [open, setOpen] = useState<CalEvent | null>(null);
  const seq = useRef(0);

  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api.get<{ events: CalEvent[] }>(`/api/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
      // A slow request for a range the person has already navigated away
      // from must not repaint the grid they are looking at.
      if (mine === seq.current) setEvents(r.events);
    } catch (e) {
      if ((e as ApiError).status !== 403) toast.error(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [from, to, toast]);

  const loadSources = useCallback(async () => {
    try { setSources((await api.get<{ sources: SourceRow[] }>('/api/calendar')).sources); } catch { /* the page still works without the sidebar */ }
  }, []);

  useEffect(() => { if (can('calendar')) void load(); }, [can, load]);
  useEffect(() => { if (can('calendar')) void loadSources(); }, [can, loadSources]);

  // A calendar that is being synced in the background changes under the
  // person, so the window is refreshed while the tab is visible. Two minutes
  // rather than seconds: the server is already being told by a webhook or
  // polling, and this is only about the picture catching up.
  useEffect(() => {
    if (!can('calendar')) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 120_000);
    const onShow = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, [can, load]);

  async function syncAll() {
    setSyncing(true);
    try {
      await Promise.all(sources.map((s) => api.post(`/api/calendar/sources/${s.id}/sync`).catch(() => null)));
      await Promise.all([load(), loadSources()]);
      toast.success('Calendars up to date');
    } catch (e) { toast.error(e); } finally { setSyncing(false); }
  }

  async function toggleCalendar(cal: CalendarRow) {
    try {
      await api.patch(`/api/calendar/calendars/${cal.id}`, { selected: !cal.selected });
      await Promise.all([loadSources(), load()]);
    } catch (e) { toast.error(e); }
  }

  if (featuresLoading) return <div className="page center pad-24"><Spinner /></div>;
  if (!can('calendar')) {
    return (
      <div className="page page-read">
        <PageHeader title="Calendar" sub="Your days, from the calendars you connect." />
        <FeatureOffNotice cap={info('calendar')}>
          This syncs the calendars you connect — Google, Outlook, iCloud, any CalDAV server, or a
          published address you subscribe to — and keeps their events encrypted on this server. It is
          also what lets Tern avoid proposing a time you are already busy.
        </FeatureOffNotice>
      </div>
    );
  }

  const calendars = sources.flatMap((s) => s.calendars);
  const failing = sources.filter((s) => s.status === 'auth_error' || s.status === 'error');
  const title = view === 'month' ? monthLabel.format(anchor)
    : view === 'week' ? `${longDay.format(startOfWeek(anchor))} – ${longDay.format(addDays(startOfWeek(anchor), 6))}`
      : 'Next 60 days';

  const step = (n: number) => setAnchor((a) => (view === 'month' ? new Date(a.getFullYear(), a.getMonth() + n, 1) : addDays(a, n * (view === 'week' ? 7 : 30))));

  return (
    <div className="cal-page">
      <PageHeader
        title="Calendar"
        sub={title}
        actions={
          <div className="row gap-8 wrap">
            <Segmented value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'agenda', label: 'Agenda' }]} />
            <div className="row gap-4">
              <Button size="sm" variant="ghost" iconOnly aria-label="Previous" onClick={() => step(-1)}><ChevronLeft size={16} /></Button>
              <Button size="sm" variant="ghost" onClick={() => setAnchor(new Date())}>Today</Button>
              <Button size="sm" variant="ghost" iconOnly aria-label="Next" onClick={() => step(1)}><ChevronRight size={16} /></Button>
            </div>
            <Button size="sm" variant="ghost" loading={syncing} icon={<RefreshCw size={14} />} onClick={syncAll} disabled={!sources.length}>Sync</Button>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ startsAt: nextHour() })}>New event</Button>
          </div>
        }
      />

      {failing.map((s) => (
        <Callout key={s.id} kind="warning">
          <b>{s.label}</b> {s.status === 'auth_error' ? 'needs to be reconnected' : 'could not be synced'}
          {s.error ? `: ${s.error}` : '.'} <Link to="/settings/calendars">Open calendar settings</Link>
        </Callout>
      ))}

      {!sources.length && !loading && (
        <Empty
          icon={<CalendarDays size={22} />}
          title="No calendar connected yet"
          action={<Link className="btn btn-primary" to="/settings/calendars">Connect a calendar</Link>}
        >
          Connect Google, Outlook, iCloud, any CalDAV server, or subscribe to a published address. Events sync both
          ways and stay encrypted on this server.
        </Empty>
      )}

      <div className="cal-body">
        {calendars.length > 1 && (
          <aside className="cal-sidebar">
            <div className="nav-section-title">Calendars</div>
            {sources.map((s) => (
              <div key={s.id} className="cal-source">
                <div className="small muted truncate" title={s.label}>{s.label}</div>
                {s.calendars.map((c) => (
                  <label key={c.id} className="cal-pick">
                    <input type="checkbox" checked={c.selected} onChange={() => toggleCalendar(c)} />
                    <span className="cal-swatch" style={{ background: c.color ?? 'var(--accent)' }} />
                    <span className="truncate" title={c.name}>{c.name}</span>
                    {c.push && <span className="cal-live" title="Updated by push, not polling">live</span>}
                  </label>
                ))}
              </div>
            ))}
          </aside>
        )}

        <div className="cal-main">
          {loading ? <Spinner /> : view === 'month' ? (
            <MonthGrid anchor={anchor} events={events} onOpen={setOpen} onAdd={(d) => setEditing({ startsAt: d, allDay: false })} />
          ) : view === 'week' ? (
            <WeekGrid anchor={anchor} events={events} onOpen={setOpen} onAdd={(d) => setEditing({ startsAt: d })} />
          ) : (
            <AgendaList events={events} onOpen={setOpen} />
          )}
        </div>
      </div>

      {open && (
        <EventDetail
          event={open}
          onClose={() => setOpen(null)}
          onEdit={(scope) => { setEditing({ objectId: open.objectId, startsAt: new Date(open.startsAt), allDay: open.allDay, scope, occurrence: open.recurrenceId }); setOpen(null); }}
          onDeleted={() => { setOpen(null); void load(); }}
        />
      )}
      {editing && (
        <EventEditor
          initial={editing}
          calendars={calendars.filter((c) => !c.readOnly)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function nextHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

// Which days an occurrence touches, so a booking that runs over several
// appears on each of them.
function daysCovered(e: CalEvent, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const first = dayOf(e.startsAt, e.allDay);
  let cur = new Date(first);
  const endMs = new Date(e.endsAt).getTime();
  // Both kinds of end are exclusive: an all-day event that covers the 21st to
  // the 23rd ends at midnight on the 24th, and a meeting that ends at 10:00
  // does not occupy 10:00. Stepping back a millisecond gives the last day it
  // is really on, for both.
  const last = dayOf(new Date(Math.max(endMs - 1, new Date(e.startsAt).getTime())).toISOString(), e.allDay);
  for (let i = 0; i < 60 && cur <= last; i++) {
    if (cur >= from && cur < to) out.push(new Date(cur));
    cur = addDays(cur, 1);
  }
  return out.length ? out : [first];
}

function MonthGrid({ anchor, events, onOpen, onAdd }: { anchor: Date; events: CalEvent[]; onOpen: (e: CalEvent) => void; onAdd: (d: Date) => void }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const today = startOfDay(new Date());

  const byDay = new Map<number, CalEvent[]>();
  for (const e of events) {
    for (const d of daysCovered(e, start, addDays(start, 42))) {
      const key = d.getTime();
      const list = byDay.get(key) ?? [];
      list.push(e);
      byDay.set(key, list);
    }
  }

  return (
    <div className="cal-month" role="grid" aria-label="Month">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
      {cells.map((d) => {
        const list = (byDay.get(d.getTime()) ?? []).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt));
        const otherMonth = d.getMonth() !== anchor.getMonth();
        return (
          <div key={d.getTime()} className={cls('cal-cell', otherMonth && 'other-month', sameDay(d, today) && 'today')} onDoubleClick={() => onAdd(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9))}>
            <div className="cal-cell-head">
              <span className="cal-daynum">{d.getDate()}</span>
              <button className="cal-add" aria-label={`Add an event on ${longDay.format(d)}`} onClick={() => onAdd(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9))}><Plus size={12} /></button>
            </div>
            <div className="cal-cell-events">
              {list.slice(0, 4).map((e) => (
                <button key={`${e.id}-${d.getTime()}`} className={cls('cal-chip', !e.busy && 'free')} style={{ '--chip': e.color ?? 'var(--accent)' } as any} onClick={() => onOpen(e)} title={`${e.summary ?? 'Untitled'} · ${e.calendarName}`}>
                  {!e.allDay && <span className="cal-chip-time">{hhmm.format(new Date(e.startsAt))}</span>}
                  <span className="truncate">{e.summary ?? 'Untitled'}</span>
                </button>
              ))}
              {list.length > 4 && <span className="cal-more">+{list.length - 4} more</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const HOUR_PX = 44;

function WeekGrid({ anchor, events, onOpen, onAdd }: { anchor: Date; events: CalEvent[]; onOpen: (e: CalEvent) => void; onAdd: (d: Date) => void }) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = startOfDay(new Date());
  const now = new Date();
  const scroller = useRef<HTMLDivElement>(null);

  // Open on the working day rather than on midnight, which is eight hours of
  // empty grid nobody wants to scroll past.
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; }, []);

  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);

  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <div className="cal-gutter" />
        {days.map((d) => (
          <div key={d.getTime()} className={cls('cal-week-day', sameDay(d, today) && 'today')}>{dayLabel.format(d)}</div>
        ))}
      </div>
      {allDay.length > 0 && (
        <div className="cal-week-allday">
          <div className="cal-gutter small muted">All day</div>
          {days.map((d) => (
            <div key={d.getTime()} className="cal-allday-cell">
              {allDay.filter((e) => daysCovered(e, d, addDays(d, 1)).length).map((e) => (
                <button key={e.id} className="cal-chip" style={{ '--chip': e.color ?? 'var(--accent)' } as any} onClick={() => onOpen(e)}>
                  <span className="truncate">{e.summary ?? 'Untitled'}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="cal-week-body" ref={scroller}>
        <div className="cal-gutter">
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="cal-hour-label" style={{ height: HOUR_PX }}>{String(h).padStart(2, '0')}:00</div>)}
        </div>
        {days.map((d) => {
          const dayStart = d.getTime();
          const inDay = timed.filter((e) => new Date(e.endsAt).getTime() > dayStart && new Date(e.startsAt).getTime() < dayStart + DAY);
          const laid = layout(inDay, d);
          return (
            <div key={d.getTime()} className={cls('cal-day-col', sameDay(d, today) && 'today')} onDoubleClick={(ev) => {
              const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              const minutes = Math.max(0, Math.min(23 * 60, Math.round(((ev.clientY - box.top) / HOUR_PX) * 60 / 30) * 30));
              onAdd(new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutes / 60), minutes % 60));
            }}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="cal-hour-line" style={{ height: HOUR_PX }} />)}
              {sameDay(d, today) && <div className="cal-now" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} />}
              {laid.map(({ e, top, height, col, cols }) => (
                <button
                  key={`${e.id}`}
                  className={cls('cal-event', !e.busy && 'free')}
                  style={{ top, height, left: `${(col / cols) * 100}%`, width: `${100 / cols}%`, '--chip': e.color ?? 'var(--accent)' } as any}
                  onClick={() => onOpen(e)}
                  title={`${e.summary ?? 'Untitled'} · ${e.calendarName}`}
                >
                  <span className="cal-event-time">{hhmm.format(new Date(e.startsAt))}</span>
                  <span className="cal-event-title truncate">{e.summary ?? 'Untitled'}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Overlapping events share the width of the column rather than covering each
// other. A simple sweep: anything that overlaps the running group joins it,
// and the group's size decides how many ways the width is split.
function layout(events: CalEvent[], day: Date): { e: CalEvent; top: number; height: number; col: number; cols: number }[] {
  const dayStart = day.getTime();
  const items = events
    .map((e) => {
      const s = Math.max(new Date(e.startsAt).getTime(), dayStart);
      const en = Math.min(new Date(e.endsAt).getTime(), dayStart + DAY);
      return { e, s, en: Math.max(en, s + 15 * 60_000) };
    })
    .sort((a, b) => a.s - b.s || b.en - a.en);

  const out: { e: CalEvent; top: number; height: number; col: number; cols: number }[] = [];
  let group: typeof items = [];
  let groupEnd = 0;

  const flush = () => {
    if (!group.length) return;
    // Columns within the group: the first free one that this event does not
    // overlap in.
    const columns: number[] = [];
    const placed = group.map((it) => {
      let col = columns.findIndex((end) => end <= it.s);
      if (col < 0) { columns.push(it.en); col = columns.length - 1; } else columns[col] = it.en;
      return { it, col };
    });
    for (const { it, col } of placed) {
      out.push({
        e: it.e,
        top: ((it.s - dayStart) / 3_600_000) * HOUR_PX,
        height: Math.max(18, ((it.en - it.s) / 3_600_000) * HOUR_PX - 2),
        col,
        cols: columns.length,
      });
    }
    group = [];
  };

  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    group.push(it);
    groupEnd = Math.max(groupEnd, it.en);
  }
  flush();
  return out;
}

function AgendaList({ events, onOpen }: { events: CalEvent[]; onOpen: (e: CalEvent) => void }) {
  const groups = new Map<number, CalEvent[]>();
  for (const e of events) {
    const key = dayOf(e.startsAt, e.allDay).getTime();
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const days = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  if (!days.length) return <Empty icon={<CalendarDays size={20} />} title="Nothing in the next two months" />;
  const today = startOfDay(new Date()).getTime();

  return (
    <div className="cal-agenda">
      {days.map(([key, list]) => (
        <div key={key} className="cal-agenda-day">
          <div className={cls('cal-agenda-date', key === today && 'today')}>{longDay.format(new Date(key))}{key === today && <Badge kind="accent">Today</Badge>}</div>
          {list.sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((e) => (
            <button key={e.id} className="cal-agenda-row" onClick={() => onOpen(e)}>
              <span className="cal-swatch" style={{ background: e.color ?? 'var(--accent)' }} />
              <span className="cal-agenda-time">{e.allDay ? 'All day' : `${hhmm.format(new Date(e.startsAt))}–${hhmm.format(new Date(e.endsAt))}`}</span>
              <span className="cal-agenda-title truncate">{e.summary ?? 'Untitled'}</span>
              {e.location && <span className="small muted truncate row gap-4"><MapPin size={12} />{e.location}</span>}
              {!e.busy && <Badge>free</Badge>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

interface FullEvent extends CalEvent {
  description?: string | null;
  attendees?: { email: string; name: string | null; partstat: string | null }[];
  organizer?: { email: string; name: string | null } | null;
  uid?: string;
  myPartstat?: string | null;
  alarmMinutes?: number | null;
}

function EventDetail({ event, onClose, onEdit, onDeleted }: { event: CalEvent; onClose: () => void; onEdit: (scope: EditScope) => void; onDeleted: () => void }) {
  const toast = useToast();
  const [full, setFull] = useState<FullEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'change' | 'delete' | null>(null);

  useEffect(() => {
    void api.get<{ event: FullEvent }>(`/api/calendar/events/${event.objectId}`)
      .then((r) => setFull(r.event))
      .catch(() => setFull(null));
  }, [event.objectId]);

  // A series is only ever recognised from the occurrence being looked at:
  // `recurrenceId` is set on every occurrence the expansion produced, and
  // null on a one-off.
  const repeats = Boolean(event.recurrenceId);
  const hasGuests = Boolean(full?.attendees?.length);

  async function remove(scope: EditScope) {
    setBusy(true);
    setAsking(null);
    try {
      const q = new URLSearchParams({ scope });
      if (scope !== 'all' && event.recurrenceId) q.set('occurrence', event.recurrenceId);
      // Only offer to write to the guests when there are guests to write to,
      // and only on a cancellation they would care about.
      if (hasGuests) q.set('notify', '1');
      const r = await api.del<{ invitations: { sent: string[]; failed: { email: string }[] } | null }>(`/api/calendar/events/${event.objectId}?${q}`);
      const sent = r.invitations?.sent.length ?? 0;
      toast.success(sent ? `Deleted, and ${sent} guest${sent === 1 ? '' : 's'} told` : 'Event deleted');
      if (r.invitations?.failed.length) toast.error(`Could not reach ${r.invitations.failed.length} guest(s)`);
      onDeleted();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  const lastDay = formatDay(new Date(new Date(event.endsAt).getTime() - 1).toISOString(), event.allDay);
  const firstDay = formatDay(event.startsAt, event.allDay);
  const when = event.allDay
    ? (firstDay === lastDay ? firstDay : `${firstDay} – ${lastDay}`)
    : `${firstDay} · ${hhmm.format(new Date(event.startsAt))}–${hhmm.format(new Date(event.endsAt))}`;

  return (
    <Modal open onClose={onClose} title={event.summary ?? 'Untitled'} footer={
      <div className="row gap-8 between full">
        <span className="small muted row gap-4"><span className="cal-swatch" style={{ background: event.color ?? 'var(--accent)' }} />{event.calendarName}</span>
        <div className="row gap-8">
          {!event.readOnly && <Button variant="ghost" loading={busy} icon={<Trash2 size={14} />} onClick={() => (repeats ? setAsking('delete') : remove('all'))}>Delete</Button>}
          {!event.readOnly && <Button variant="primary" onClick={() => (repeats ? setAsking('change') : onEdit('all'))}>Edit</Button>}
        </div>
      </div>
    }>
      <div className="stack-12">
        <div className="row gap-8"><Clock size={15} className="muted" /><span>{when}</span>{!event.busy && <Badge>Free</Badge>}</div>
        {event.location && <div className="row gap-8"><MapPin size={15} className="muted" /><span>{event.location}</span></div>}
        {full?.organizer && <div className="small muted">Organised by {full.organizer.name || full.organizer.email}</div>}
        {full?.attendees?.length ? (
          <div>
            <div className="row gap-8 small strong"><Users size={14} />{full.attendees.length} {full.attendees.length === 1 ? 'guest' : 'guests'}</div>
            <ul className="cal-guests">
              {full.attendees.slice(0, 25).map((a) => (
                <li key={a.email} className="small">
                  <span className={cls('cal-partstat', String(a.partstat ?? '').toLowerCase())} />
                  {a.name || a.email}
                  {a.partstat && a.partstat !== 'NEEDS-ACTION' && <span className="muted"> · {a.partstat.toLowerCase()}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {full?.description && <p className="small pre-wrap">{full.description.slice(0, 2000)}</p>}
        {repeats && <div className="small muted row gap-4"><RefreshCw size={12} />Part of a repeating series</div>}
        {event.readOnly && <Callout>This calendar is read-only, so this event cannot be changed here.</Callout>}
      </div>
      {asking && (
        <ScopePrompt
          verb={asking}
          onClose={() => setAsking(null)}
          onPick={(scope) => (asking === 'delete' ? remove(scope) : (setAsking(null), onEdit(scope)))}
        />
      )}
    </Modal>
  );
}

// Which occurrences a change applies to.
//
// Every calendar asks this, and it is not a nicety: "cancel the stand-up"
// meaning this Tuesday and "cancel the stand-up" meaning for ever are the
// same sentence and different actions. Guessing wrong deletes a year of
// meetings, so a series is never changed without the question being answered
// — and a one-off never asks it.
type EditScope = 'all' | 'this' | 'future';

function ScopePrompt({ verb, onPick, onClose }: { verb: 'change' | 'delete'; onPick: (s: EditScope) => void; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={verb === 'delete' ? 'Delete repeating event' : 'Change repeating event'}>
      <div className="stack-12">
        <p className="muted small">This event repeats. Which ones should this {verb === 'delete' ? 'deletion' : 'change'} apply to?</p>
        <div className="stack-8">
          <Button onClick={() => onPick('this')}>This occurrence only</Button>
          <Button onClick={() => onPick('future')}>This and all later ones</Button>
          <Button variant={verb === 'delete' ? 'default' : 'primary'} onClick={() => onPick('all')}>Every occurrence, including past ones</Button>
        </div>
        {verb === 'delete' && <p className="small faint">Past occurrences are left alone unless you pick the last option.</p>}
      </div>
    </Modal>
  );
}

// Reminders offered in the editor. The list is short on purpose: a reminder
// people actually use is five minutes, ten, or the morning of.
const REMINDERS: { value: number; label: string }[] = [
  { value: -1, label: 'No reminder' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 1440, label: '1 day before' },
];

// The repeats offered. Anything more exotic than these is preserved when it
// arrives from a server but is not something to build a rule-builder for:
// the field below takes a raw RRULE for anyone who needs one.
const REPEATS: { value: string; label: string }[] = [
  { value: '', label: 'Does not repeat' },
  { value: 'FREQ=DAILY', label: 'Every day' },
  { value: 'FREQ=WEEKLY', label: 'Every week' },
  { value: 'FREQ=WEEKLY;INTERVAL=2', label: 'Every two weeks' },
  { value: 'FREQ=MONTHLY', label: 'Every month' },
  { value: 'FREQ=YEARLY', label: 'Every year' },
];

// <input type="datetime-local"> wants a local wall clock with no zone, and
// gives one back; both directions go through here so the conversion happens
// in exactly one place.
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function EventEditor({ initial, calendars, onClose, onSaved }: {
  initial: { objectId?: number; startsAt: Date; allDay?: boolean; scope?: EditScope; occurrence?: string | null };
  calendars: CalendarRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(Boolean(initial.objectId));
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    summary: '',
    location: '',
    description: '',
    allDay: Boolean(initial.allDay),
    start: toLocalInput(initial.startsAt),
    end: toLocalInput(new Date(initial.startsAt.getTime() + 3_600_000)),
    startDate: toDateInput(initial.startsAt),
    endDate: toDateInput(initial.startsAt),
    rrule: '',
    transparent: false,
    calendarId: calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id ?? 0,
    attendees: '',
    reminder: -1,
    // Off unless asked for: a CalDAV or Exchange server that does its own
    // scheduling sends its own invitations when this is pushed to it, and
    // two invitations for one meeting is worse than none.
    notify: false,
  });

  useEffect(() => {
    if (!initial.objectId) return;
    void api.get<{ event: FullEvent }>(`/api/calendar/events/${initial.objectId}`)
      .then((r) => {
        const e = r.event;
        const s = new Date(e.startsAt);
        const en = new Date(e.endsAt);
        setF((prev) => ({
          ...prev,
          summary: e.summary ?? '',
          location: e.location ?? '',
          description: e.description ?? '',
          allDay: e.allDay,
          start: toLocalInput(s), end: toLocalInput(en),
          startDate: e.allDay ? s.toISOString().slice(0, 10) : toDateInput(s),
          // The stored end is exclusive; the form shows the last day it covers.
          endDate: e.allDay ? new Date(en.getTime() - DAY).toISOString().slice(0, 10) : toDateInput(en),
          calendarId: e.calendarId,
          transparent: !e.busy,
          attendees: (e.attendees ?? []).map((a) => a.email).join(', '),
          reminder: e.alarmMinutes ?? -1,
        }));
      })
      .catch((e) => toast.error(e))
      .finally(() => setLoading(false));
  }, [initial.objectId, toast]);

  const guests = f.attendees.split(/[,\s]+/).filter((x) => x.includes('@'));

  async function save() {
    setBusy(true);
    try {
      const startsAt = f.allDay ? new Date(`${f.startDate}T00:00:00Z`) : new Date(f.start);
      // An all-day event's DTEND is exclusive: a one-day event ends on the
      // following midnight, which is why the form's end date has a day added.
      const endsAt = f.allDay ? new Date(new Date(`${f.endDate}T00:00:00Z`).getTime() + DAY) : new Date(f.end);
      if (!(startsAt.getTime() < endsAt.getTime())) { toast.error('That event ends before it starts'); setBusy(false); return; }
      const body: Record<string, unknown> = {
        summary: f.summary.trim() || null,
        location: f.location.trim() || null,
        description: f.description.trim() || null,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        allDay: f.allDay,
        timezone: f.allDay ? null : localTz(),
        rrule: f.rrule || null,
        transparent: f.transparent,
        attendees: f.attendees.split(/[,\s]+/).filter((x) => x.includes('@')).map((email) => ({ email })),
      };
      body.alarms = f.reminder >= 0 ? [f.reminder] : [];
      body.notify = f.notify && guests.length > 0;
      // Editing one occurrence of a series, or one and every later one,
      // needs to say which — the server will not guess.
      if (initial.scope && initial.scope !== 'all' && initial.occurrence) {
        body.scope = initial.scope;
        body.occurrence = initial.occurrence;
      }
      const r = initial.objectId
        ? await api.patch<{ event: FullEvent }>(`/api/calendar/events/${initial.objectId}`, body)
        : await api.post<{ event: FullEvent }>('/api/calendar/events', { ...body, calendarId: f.calendarId });
      const inv = (r.event as any)?.invitations as { sent: string[]; failed: { email: string }[] } | undefined;
      const sent = inv?.sent.length ?? 0;
      toast.success(sent
        ? `${initial.objectId ? 'Saved' : 'Created'}, and ${sent} guest${sent === 1 ? '' : 's'} invited`
        : initial.objectId ? 'Event saved' : 'Event created');
      if (inv?.failed.length) toast.error(`Could not reach ${inv.failed.length} guest(s)`);
      onSaved();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  }

  if (!calendars.length) {
    return (
      <Modal open onClose={onClose} title="No writable calendar">
        <Callout kind="warning">
          Every calendar you have connected is read-only. Connect one you can write to under{' '}
          <Link to="/settings/calendars">Settings → Calendars</Link>.
        </Callout>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={!initial.objectId ? 'New event'
        : initial.scope === 'this' ? 'Edit this occurrence'
          : initial.scope === 'future' ? 'Edit this and all later occurrences'
            : 'Edit event'}
      footer={
      <div className="row gap-8 end full">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={save}>{initial.objectId ? 'Save' : 'Create'}</Button>
      </div>
    }>
      {loading ? <Spinner /> : (
        <div className="stack-12">
          <Field label="Title"><Input autoFocus value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} placeholder="Call with Sam" /></Field>
          <div className="row gap-8">
            <Toggle checked={f.allDay} onChange={(v) => setF({ ...f, allDay: v })} />
            <span className="small">All day</span>
          </div>
          {f.allDay ? (
            <div className="form-row">
              <Field label="From"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate })} /></Field>
              <Field label="To"><Input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
            </div>
          ) : (
            <div className="form-row">
              <Field label="Starts"><Input type="datetime-local" value={f.start} onChange={(e) => {
                const s = new Date(e.target.value);
                const was = new Date(f.start).getTime();
                const gap = new Date(f.end).getTime() - was;
                // Moving the start drags the end with it, keeping the length.
                setF({ ...f, start: e.target.value, end: Number.isFinite(gap) && gap > 0 ? toLocalInput(new Date(s.getTime() + gap)) : f.end });
              }} /></Field>
              <Field label="Ends"><Input type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
            </div>
          )}
          <div className="form-row">
            <Field label="Repeats">
              <Select value={REPEATS.some((r) => r.value === f.rrule) ? f.rrule : 'custom'} onChange={(e) => setF({ ...f, rrule: e.target.value === 'custom' ? f.rrule : e.target.value })}>
                {REPEATS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                {!REPEATS.some((r) => r.value === f.rrule) && f.rrule && <option value="custom">Custom rule</option>}
              </Select>
            </Field>
            {!initial.objectId && (
              <Field label="Calendar">
                <Select value={String(f.calendarId)} onChange={(e) => setF({ ...f, calendarId: Number(e.target.value) })}>
                  {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Room 2, or a link" /></Field>
          <Field label="Guests" hint="Email addresses, separated by commas.">
            <Input value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value })} placeholder="sam@example.com, dana@example.com" />
          </Field>
          {guests.length > 0 && (
            <div className="row gap-8">
              <Toggle checked={f.notify} onChange={(v) => setF({ ...f, notify: v })} />
              <div>
                <div className="strong small">Email {guests.length === 1 ? 'the guest' : `all ${guests.length} guests`} an invitation</div>
                <div className="help-text">
                  Sends a proper invitation with Accept and Decline, from your own address and through
                  your normal sending rules. Leave it off if the calendar you are saving to already
                  sends its own — most Exchange and CalDAV servers do, and two invitations for one
                  meeting is worse than none.
                </div>
              </div>
            </div>
          )}
          <Field label="Reminder" hint="A notification before it starts, on any device where you have allowed them. Stored on the event, so other calendar apps see it too.">
            <Select value={String(f.reminder)} onChange={(e) => setF({ ...f, reminder: Number(e.target.value) })}>
              {REMINDERS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              {!REMINDERS.some((r) => r.value === f.reminder) && f.reminder >= 0 && <option value={f.reminder}>{f.reminder} minutes before</option>}
            </Select>
          </Field>
          <Field label="Notes"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ minHeight: 80 }} /></Field>
          <div className="row gap-8">
            <Toggle checked={f.transparent} onChange={(v) => setF({ ...f, transparent: v })} />
            <span className="small">Show as free — does not block this time when Tern proposes one</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
