// One runner per connected calendar source, built the same way the mail sync
// manager is: a timer, a debounced trigger everything else routes through,
// and a push channel where the provider offers one.
//
// The pacing is the interesting part. Polling a calendar is not like polling
// a mailbox: an incremental request (a CalDAV sync-collection REPORT with a
// token, a Google syncToken, a Graph deltaLink) returns an empty list almost
// every time and costs about as much as a heartbeat. So the default poll is
// minutes rather than the mail's ninety seconds, and Google and Microsoft
// sources drop to a slow safety poll once a webhook is established, because
// then the poll exists only to catch a notification that never arrived.
import { config } from '../config.js';
import { logger } from '../log.js';
import { dueReminders, ensureChannels, extendExpansions, listSources, markNotified, onSyncRequested, pruneInstances, syncSource } from '../services/calendar/index.js';
import { getCalendarSettings } from '../services/calendar/oauth.js';
import { notifyUser } from '../services/push.js';
import { allowed } from '../services/capabilities.js';

const log = logger('calsync');

// How long a source that is failing waits before trying again, and the
// ceiling that stops a broken connection from hammering somebody's server.
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
// With a live webhook the poll is only a safety net.
const PUSH_POLL_SECONDS = 900;

class SourceRunner {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private backoffMs = 0;
  private hasPush = false;
  lastError: string | null = null;
  lastSyncAt: Date | null = null;

  constructor(readonly sourceId: number, private pollSeconds: number) {}

  start(): void {
    this.stopped = false;
    this.request(2000);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null; this.debounce = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    const seconds = this.hasPush ? PUSH_POLL_SECONDS : this.pollSeconds;
    const wait = this.backoffMs || seconds * 1000;
    this.timer = setTimeout(() => this.request(0), wait);
  }

  request(delayMs: number): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.run(); }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const out = await syncSource(this.sourceId);
      this.backoffMs = 0;
      this.lastError = null;
      this.lastSyncAt = new Date();
      if (out.changed || out.removed || out.pushed) {
        log.debug('calendar synced', { source: this.sourceId, ...out });
      }
      // Establishing a channel is best-effort and must never fail a sync
      // that otherwise worked.
      try {
        const sources = await listSources();
        const mine = sources.find((s) => s.id === this.sourceId);
        if (mine) this.hasPush = (await ensureChannels(mine)) > 0 || this.hasPush;
      } catch (e) {
        log.debug('could not set up a push channel', { source: this.sourceId, err: (e as Error).message });
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      // An authentication failure is not a transient fault: backing off to
      // the ceiling stops a revoked token from being retried every minute
      // until somebody notices.
      const auth = /credential|expired|reconnect|refused the sign-in/i.test(this.lastError);
      this.backoffMs = auth ? BACKOFF_MAX_MS : Math.min(this.backoffMs ? this.backoffMs * 2 : BACKOFF_START_MS, BACKOFF_MAX_MS);
    } finally {
      this.running = false;
      this.schedule();
      if (this.again) { this.again = false; this.request(1000); }
    }
  }

  setPoll(seconds: number): void {
    this.pollSeconds = Math.min(3600, Math.max(60, seconds));
  }

  status() {
    return { sourceId: this.sourceId, push: this.hasPush, lastSyncAt: this.lastSyncAt, error: this.lastError, backoffMs: this.backoffMs };
  }
}

const runners = new Map<number, SourceRunner>();
let sweep: NodeJS.Timeout | null = null;
let reminders: NodeJS.Timeout | null = null;

export const calendarSync = {
  async start(): Promise<void> {
    // Anything that changes a calendar locally asks for a sync through here,
    // so there is one path out to the providers rather than one per route.
    onSyncRequested((sourceId, delayMs = 800) => this.request(sourceId, delayMs));
    await this.refreshAll();
    // Occurrences are materialised over a rolling window, so something has
    // to move the window: without this a weekly meeting stops appearing
    // about eighteen months out, which is the kind of bug nobody reports
    // until it has already cost them a meeting.
    sweep = setInterval(() => { void this.housekeeping(); }, 6 * 3600_000);
    // Reminders are checked on their own, much shorter, timer: the whole
    // point of a reminder is being on time, and a sweep every six hours
    // would deliver "your meeting starts in ten minutes" five hours late.
    // A minute is fine — the query is one indexed range scan that usually
    // returns nothing.
    reminders = setInterval(() => { void this.remind(); }, 60_000);
    log.info(`calendar sync started for ${runners.size} source(s)`);
  },

  async refreshAll(): Promise<void> {
    const settings = await getCalendarSettings();
    const sources = await listSources();
    const live = new Set<number>();
    for (const s of sources) {
      live.add(s.id);
      const existing = runners.get(s.id);
      if (existing) { existing.setPoll(s.pollSeconds || settings.pollSeconds); continue; }
      const r = new SourceRunner(s.id, s.pollSeconds || settings.pollSeconds);
      runners.set(s.id, r);
      r.start();
    }
    for (const [id, r] of runners) if (!live.has(id)) { r.stop(); runners.delete(id); }
  },

  add(sourceId: number, pollSeconds = 300): void {
    if (runners.has(sourceId)) return;
    const r = new SourceRunner(sourceId, pollSeconds);
    runners.set(sourceId, r);
    r.start();
  },

  remove(sourceId: number): void {
    runners.get(sourceId)?.stop();
    runners.delete(sourceId);
  },

  request(sourceId: number, delayMs = 800): void {
    runners.get(sourceId)?.request(delayMs);
  },

  status(sourceId: number) {
    return runners.get(sourceId)?.status() ?? null;
  },

  /**
   * Tell people about what is about to start.
   *
   * Every occurrence is marked as announced whatever the notification did,
   * including when it failed or when nobody had a browser subscribed.
   * Retrying would mean a person who never enabled notifications generates
   * the same work on every sweep for the rest of the day, and a person who
   * did would eventually get the same reminder twice.
   */
  async remind(): Promise<void> {
    try {
      const due = await dueReminders();
      if (!due.length) return;
      const marked: number[] = [];
      const consent = new Map<number, boolean>();
      for (const r of due) {
        marked.push(r.instanceId);
        // A reminder is the calendar reaching out unprompted, so it is
        // subject to the same switch as everything else the calendar does.
        let ok = consent.get(r.userId);
        if (ok === undefined) { ok = await allowed(r.userId, 'calendar'); consent.set(r.userId, ok); }
        if (!ok) continue;
        const mins = Math.max(0, Math.round((r.startsAt.getTime() - Date.now()) / 60_000));
        await notifyUser(r.userId, {
          title: r.summary ?? 'Upcoming event',
          body: mins <= 0 ? `Starting now${r.location ? ` · ${r.location}` : ''}` : `In ${mins} minute${mins === 1 ? '' : 's'}${r.location ? ` · ${r.location}` : ''}`,
          url: '/calendar',
          // One tag per occurrence, so a reminder replaces its own earlier
          // notification rather than stacking up on a locked phone.
          tag: `calendar-${r.instanceId}`,
        }).catch(() => 0);
      }
      await markNotified(marked);
      log.debug(`announced ${marked.length} upcoming event(s)`);
    } catch (e) {
      log.warn('reminder sweep failed', { err: (e as Error).message });
    }
  },

  // Extending expansions and dropping the ones that have aged out. Cheap,
  // and only touches the users who have a calendar at all.
  async housekeeping(): Promise<void> {
    try {
      const seen = new Set<number>();
      for (const s of await listSources()) {
        if (seen.has(s.userId)) continue;
        seen.add(s.userId);
        const extended = await extendExpansions(s.userId, 200);
        const pruned = await pruneInstances(s.userId);
        if (extended || pruned) log.debug('calendar housekeeping', { user: s.userId, extended, pruned });
      }
    } catch (e) {
      log.warn('calendar housekeeping failed', { err: (e as Error).message });
    }
  },

  stop(): void {
    for (const r of runners.values()) r.stop();
    runners.clear();
    if (sweep) clearInterval(sweep);
    if (reminders) clearInterval(reminders);
    sweep = null;
    reminders = null;
  },
};

// Whether this install can be told about changes rather than having to ask.
export function pushPossible(): boolean {
  return config.appUrl.startsWith('https://');
}
