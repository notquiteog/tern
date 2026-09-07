// The calendar, as the rest of the app sees it.
//
// Everything above this line is a provider talking its own protocol;
// everything below it is "a calendar". One sync entry point, one create, one
// update, one delete, and the two reads that other features actually want:
// what is on, and when somebody is free.
//
// Two-way, with the conflict rule stated once here so no adapter has to
// invent its own: a local change is written to the far side under the etag
// it was read at. If the server says that etag has moved on, the far side
// wins and the local edit is refused rather than clobbering somebody. A
// calendar is shared by definition, and silently overwriting a colleague's
// change to a meeting is worse than an error message.
import { config } from '../../config.js';
import { logger } from '../../log.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { randomBytes } from 'node:crypto';
import { allowed } from '../capabilities.js';
import { listAccounts } from '../accounts.js';
import * as caldav from './caldav.js';
import * as google from './google.js';
import * as graph from './microsoft.js';
import { fetchIcs } from './ics.js';
import { getCalendarSettings } from './oauth.js';
import { sendItip, type InviteResult } from './invite.js';
import { durationOf, expandEvent, newEvent, overrideFor, parseCalendar, ruleAfterSplit, ruleUntil, vtimeOf, writeCalendar, type VEvent } from './vevent.js';
import {
  busyBlocks, defaultCalendar, dropObjectsByRemoteIds, expansionWindow, extendExpansions, findObjectByUid, hasCalendars,
  forgetObject, getCalendar, getSource, instancesIn, listCalendars, listSources, markClean, pendingObjects,
  pruneCalendars, pruneInstances, putObject, readObject, setCalendarChannel, setCalendarSync, setSourceStatus,
  setSourceSyncToken, updateSourceToken, upsertCalendar, type BusyOptions, type Calendar, type Instance, type Source, type StoredObject,
} from './store.js';
import { query } from '../../db.js';
import { dataKey, openWith } from '../vault.js';

const log = logger('calendar');

export * from './store.js';
export { getCalendarSettings, saveCalendarSettings, authorizeUrl, exchangeCode, redirectUri, type OAuthProvider } from './oauth.js';

// ---------- Credentials ----------

function davAuthOf(s: Source): caldav.DavAuth {
  return { username: s.username, password: s.secret };
}

function oauthOf(s: Source): { token: NonNullable<Source['token']>; onRefresh: (t: NonNullable<Source['token']>) => Promise<void> } {
  if (!s.token) throw badRequest('That calendar connection has no credentials and needs to be reconnected');
  return { token: s.token, onRefresh: (t) => updateSourceToken(s.id, t) };
}

// The addresses that are "me", so a guest list can say which entry is the
// person reading it — which is what decides whether a declined meeting still
// blocks their time.
async function selfEmails(userId: number): Promise<string[]> {
  const accounts = await listAccounts(userId);
  return accounts.map((a) => String(a.email ?? '').toLowerCase()).filter(Boolean);
}

// ---------- Discovering what a source holds ----------

/** Refresh the list of collections in a source, adding and removing rows. */
export async function refreshCalendars(source: Source): Promise<Calendar[]> {
  const settings = await getCalendarSettings();
  const allowPrivate = settings.allowPrivateHosts || config.allowPrivateHosts;
  const seen: string[] = [];

  if (source.kind === 'caldav') {
    const home = source.baseUrl;
    const found = await caldav.listCalendars(home, davAuthOf(source), allowPrivate);
    for (const c of found) {
      seen.push(c.href);
      await upsertCalendar(source.userId, source.id, {
        remoteId: c.href, name: c.name, color: c.color, timezone: c.timezone, readOnly: c.readOnly,
      });
    }
  } else if (source.kind === 'google') {
    for (const c of await google.listCalendars(oauthOf(source))) {
      seen.push(c.id);
      await upsertCalendar(source.userId, source.id, {
        remoteId: c.id, name: c.name, color: c.color, timezone: c.timezone, readOnly: c.readOnly, isDefault: c.primary,
      });
    }
  } else if (source.kind === 'microsoft') {
    for (const c of await graph.listCalendars(oauthOf(source))) {
      seen.push(c.id);
      await upsertCalendar(source.userId, source.id, {
        remoteId: c.id, name: c.name, color: c.color, timezone: c.timezone, readOnly: c.readOnly, isDefault: c.primary,
      });
    }
  } else {
    // A subscription is one calendar, and the URL is its identity.
    seen.push(source.baseUrl);
    await upsertCalendar(source.userId, source.id, {
      remoteId: source.baseUrl, name: source.label || 'Subscribed calendar', readOnly: true,
    });
  }

  await pruneCalendars(source.userId, source.id, seen);
  return listCalendars(source.userId, { sourceId: source.id });
}

// ---------- Sync ----------

export interface SyncOutcome { calendars: number; changed: number; removed: number; pushed: number }

/**
 * Bring one source up to date, both ways.
 *
 * Local changes go out first. Doing it the other way round would mean a
 * pending local edit is overwritten by the server copy it was based on,
 * moments before it would have been sent.
 */
export async function syncSource(sourceId: number): Promise<SyncOutcome> {
  const source = await getSource(sourceId);
  if (!source) throw notFound('No such calendar connection');
  if (!source.enabled) return { calendars: 0, changed: 0, removed: 0, pushed: 0 };
  // A person who has withdrawn consent stops being synced, without the
  // connection being deleted: turning the switch back on resumes it.
  if (!(await allowed(source.userId, 'calendar'))) return { calendars: 0, changed: 0, removed: 0, pushed: 0 };

  const out: SyncOutcome = { calendars: 0, changed: 0, removed: 0, pushed: 0 };
  await setSourceStatus(sourceId, 'syncing');
  try {
    const calendars = await refreshCalendars(source);
    out.calendars = calendars.length;
    const mine = await selfEmails(source.userId);
    for (const cal of calendars) {
      out.pushed += await pushPending(source, cal);
      const one = await pullCalendar(source, cal, mine);
      out.changed += one.changed;
      out.removed += one.removed;
    }
    await extendExpansions(source.userId);
    await pruneInstances(source.userId);
    await setSourceStatus(sourceId, 'ok', null);
  } catch (e) {
    const err = e as Error;
    const isAuth = (err as any).auth === true || /credentials|expired|reconnect/i.test(err.message);
    await setSourceStatus(sourceId, isAuth ? 'auth_error' : 'error', err.message);
    log.warn('calendar sync failed', { source: sourceId, err: err.message });
    throw e;
  }
  return out;
}

async function pullCalendar(source: Source, cal: Calendar, mine: string[]): Promise<{ changed: number; removed: number }> {
  const settings = await getCalendarSettings();
  const allowPrivate = settings.allowPrivateHosts || config.allowPrivateHosts;
  const window = expansionWindow();
  let changed = 0;
  let removed = 0;

  if (source.kind === 'caldav') {
    // The fallback path needs to know what we already hold, so it can ask
    // only for the objects whose etag moved. Only built when there is no
    // sync token, because with one the server decides what to send.
    const known = cal.syncToken ? new Map<string, string>() : await knownEtags(source.userId, cal.id);
    const res = await caldav.syncCalendar(cal.remoteId, davAuthOf(source), {
      syncToken: cal.syncToken, knownEtags: known, allowPrivate, window,
    });
    for (const o of res.changed) {
      await putObject(source.userId, cal.id, { ical: o.ical, remoteId: o.href, etag: o.etag, selfEmails: mine });
      changed++;
    }
    if (res.removed.length) {
      await dropObjectsByRemoteIds(source.userId, cal.id, res.removed);
      removed += res.removed.length;
    }
    await setCalendarSync(cal.id, source.userId, { syncToken: res.syncToken, ctag: res.ctag });
  } else if (source.kind === 'google') {
    const auth = oauthOf(source);
    const res = await google.syncCalendar(auth, cal.remoteId, { syncToken: cal.syncToken, window });
    for (const o of res.changed) {
      await putObject(source.userId, cal.id, { ical: o.ical, remoteId: o.id, etag: o.etag, selfEmails: mine });
      changed++;
    }
    if (res.removed.length) {
      await dropObjectsByRemoteIds(source.userId, cal.id, res.removed);
      removed += res.removed.length;
    }
    await setCalendarSync(cal.id, source.userId, { syncToken: res.syncToken });
  } else if (source.kind === 'microsoft') {
    const auth = oauthOf(source);
    const res = await graph.syncCalendar(auth, cal.remoteId, { deltaLink: cal.syncToken, window });
    for (const o of res.changed) {
      await putObject(source.userId, cal.id, { ical: o.ical, remoteId: o.id, etag: o.etag, selfEmails: mine });
      changed++;
    }
    // Graph reports a removed *occurrence* by its own id without naming the
    // series it belonged to, so a deletion can arrive in terms this calendar
    // does not hold. When that happens the delta link is dropped rather than
    // kept: the next sync starts from scratch and the cancelled occurrence
    // goes with it. Keeping the link would leave a cancelled meeting on the
    // grid until something else about the series changed.
    let deltaLink = res.deltaLink;
    if (res.removed.length) {
      const unmatched = await dropObjectsByRemoteIds(source.userId, cal.id, res.removed);
      removed += res.removed.length - unmatched.length;
      if (unmatched.length) {
        log.info('graph reported a deletion this calendar does not hold; resyncing in full next time', { calendar: cal.id, unmatched: unmatched.length });
        deltaLink = null;
      }
    }
    await setCalendarSync(cal.id, source.userId, { syncToken: deltaLink });
  } else {
    const res = await fetchIcs(source.baseUrl, { etag: cal.syncToken, lastModified: cal.ctag, allowPrivate });
    if (res.objects === null) return { changed: 0, removed: 0 };
    const keep = new Set<string>();
    for (const o of res.objects) {
      keep.add(o.uid);
      await putObject(source.userId, cal.id, { ical: o.ical, remoteId: o.uid, etag: null, selfEmails: mine });
      changed++;
    }
    // A published file is the whole truth every time, so anything not in it
    // has been withdrawn.
    const dek = await dataKey(source.userId);
    for (const r of await query<{ id: number; uid: string | null }>('SELECT id, uid FROM calendar_objects WHERE calendar_id=$1', [cal.id])) {
      const uid = openWith(dek, r.uid);
      if (uid && !keep.has(uid)) { await forgetObject(r.id); removed++; }
    }
    await setCalendarSync(cal.id, source.userId, { syncToken: res.etag, ctag: res.lastModified });
  }
  return { changed, removed };
}

// Remote id to etag, for every object already stored in one calendar. The
// remote id is sealed, so this opens the column rather than matching in SQL;
// a calendar holds hundreds of objects, not millions.
async function knownEtags(userId: number, calendarId: number): Promise<Map<string, string>> {
  const rows = await query<{ remote_id: string | null; etag: string | null }>(
    'SELECT remote_id, etag FROM calendar_objects WHERE calendar_id=$1', [calendarId],
  );
  const dek = await dataKey(userId);
  const out = new Map<string, string>();
  for (const r of rows) {
    const href = openWith(dek, r.remote_id);
    if (href) out.set(href, r.etag ?? '');
  }
  return out;
}

/** Local edits and deletions that have not reached the server yet. */
async function pushPending(source: Source, cal: Calendar): Promise<number> {
  if (cal.readOnly || source.kind === 'ics') return 0;
  const pending = await pendingObjects(source.userId, cal.id);
  let done = 0;
  for (const obj of pending) {
    try {
      if (obj.deleted) await pushDelete(source, cal, obj);
      else await pushUpsert(source, cal, obj);
      done++;
    } catch (e) {
      log.warn('could not push a calendar change', { object: obj.id, err: (e as Error).message });
    }
  }
  return done;
}

async function pushUpsert(source: Source, cal: Calendar, obj: StoredObject): Promise<void> {
  const settings = await getCalendarSettings();
  const allowPrivate = settings.allowPrivateHosts || config.allowPrivateHosts;
  const parsed = parseCalendar(obj.ical);
  const master = parsed.events.find((e) => !e.recurrenceId) ?? parsed.events[0];
  if (!master) return;

  if (source.kind === 'caldav') {
    const url = obj.remoteId || caldav.objectUrlFor(cal.remoteId, obj.uid);
    const res = await caldav.putObject(url, davAuthOf(source), obj.ical, {
      etag: obj.remoteId ? obj.etag : null, create: !obj.remoteId, allowPrivate,
    });
    if (res.conflict) {
      // The far side moved. Drop the local copy's dirty flag and let the
      // pull that follows bring back what is actually there.
      await markClean(obj.id, null, url, source.userId);
      throw conflict('That event changed on the server; the version there was kept');
    }
    await markClean(obj.id, res.etag, url, source.userId);
  } else if (source.kind === 'google') {
    const auth = oauthOf(source);
    if (obj.remoteId) {
      const res = await google.updateEvent(auth, cal.remoteId, obj.remoteId, master, obj.etag);
      if (res.conflict) { await markClean(obj.id, null, null, source.userId); throw conflict('That event changed in Google Calendar; the version there was kept'); }
      await markClean(obj.id, res.etag, null, source.userId);
    } else {
      const res = await google.createEvent(auth, cal.remoteId, master);
      await markClean(obj.id, res.etag, res.id, source.userId);
    }
  } else if (source.kind === 'microsoft') {
    const auth = oauthOf(source);
    if (obj.remoteId) {
      const res = await graph.updateEvent(auth, obj.remoteId, master, obj.etag);
      if (res.conflict) { await markClean(obj.id, null, null, source.userId); throw conflict('That event changed in Outlook; the version there was kept'); }
      await markClean(obj.id, res.etag, null, source.userId);
    } else {
      const res = await graph.createEvent(auth, cal.remoteId, master);
      await markClean(obj.id, res.etag, res.id, source.userId);
    }
  }
}

async function pushDelete(source: Source, cal: Calendar, obj: StoredObject): Promise<void> {
  const settings = await getCalendarSettings();
  const allowPrivate = settings.allowPrivateHosts || config.allowPrivateHosts;
  if (obj.remoteId) {
    if (source.kind === 'caldav') await caldav.deleteObject(obj.remoteId, davAuthOf(source), { etag: obj.etag, allowPrivate });
    else if (source.kind === 'google') await google.deleteEvent(oauthOf(source), cal.remoteId, obj.remoteId);
    else if (source.kind === 'microsoft') await graph.deleteEvent(oauthOf(source), obj.remoteId);
  }
  await forgetObject(obj.id);
}

// ---------- Push channels ----------

/**
 * Ask a provider to tell us when something changes, so a poll is a fallback
 * rather than the mechanism.
 *
 * CalDAV has no push worth the name — the one extension is Apple's and is
 * APNs-only — so those sources keep polling, which is cheap because a
 * sync-collection REPORT with a token usually returns nothing.
 */
export async function ensureChannels(source: Source): Promise<number> {
  const settings = await getCalendarSettings();
  if (!settings.webhooks) return 0;
  // A provider has to be able to reach us over HTTPS to deliver anything.
  if (!config.appUrl.startsWith('https://')) return 0;
  if (source.kind !== 'google' && source.kind !== 'microsoft') return 0;

  const soon = Date.now() + 12 * 3600_000;
  let made = 0;
  for (const cal of await listCalendars(source.userId, { sourceId: source.id })) {
    if (cal.channelId && cal.channelExpiresAt && cal.channelExpiresAt.getTime() > soon) continue;
    const secret = randomBytes(24).toString('base64url');
    if (source.kind === 'google') {
      const channelId = randomBytes(16).toString('hex');
      const ch = await google.watch(oauthOf(source), cal.remoteId, {
        channelId, address: `${config.appUrl}/api/calendar/webhook/google`, token: secret,
      });
      if (!ch) continue;
      await setCalendarChannel(cal.id, { channelId: ch.id, secret, resource: ch.resourceId, expiresAt: ch.expiresAt });
      made++;
    } else {
      if (cal.channelId) {
        const until = await graph.renew(oauthOf(source), cal.channelId);
        if (until) { await setCalendarChannel(cal.id, { channelId: cal.channelId, secret: cal.channelSecret, resource: cal.channelResource, expiresAt: until }); made++; continue; }
      }
      const sub = await graph.subscribe(oauthOf(source), cal.remoteId, {
        address: `${config.appUrl}/api/calendar/webhook/microsoft`, clientState: secret,
      });
      if (!sub) continue;
      await setCalendarChannel(cal.id, { channelId: sub.id, secret, resource: cal.remoteId, expiresAt: sub.expiresAt });
      made++;
    }
  }
  return made;
}

/** Which source a webhook belongs to, verified by the secret it echoes back. */
export async function sourceForChannel(channelId: string, secret: string | null): Promise<{ sourceId: number; calendarId: number } | null> {
  const rows = await query<{ id: number; source_id: number; channel_secret: string | null }>(
    'SELECT id, source_id, channel_secret FROM calendars WHERE channel_id=$1 LIMIT 2', [channelId],
  );
  const row = rows[0];
  if (!row) return null;
  // A notification whose state does not match is not from the provider.
  if (row.channel_secret && secret !== row.channel_secret) return null;
  return { sourceId: row.source_id, calendarId: row.id };
}

// ---------- Reading ----------

export async function eventsIn(userId: number, from: Date, to: Date, opts: { calendarIds?: number[] } = {}): Promise<Instance[]> {
  return instancesIn(userId, from, to, opts);
}

export async function getEvent(userId: number, objectId: number): Promise<(StoredObject & { calendar: Calendar | null }) | null> {
  const obj = await readObject(userId, objectId);
  if (!obj) return null;
  return { ...obj, calendar: await getCalendar(userId, obj.calendarId) };
}

// ---------- Writing ----------

export interface EventInput {
  calendarId?: number;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  rrule?: string | null;
  transparent?: boolean;
  attendees?: { email: string; name?: string | null }[];
  /** Reminders, as minutes before the start. */
  alarms?: number[];
  /**
   * Write to the guests. Off by default and asked per save rather than
   * assumed, because a CalDAV server that does its own scheduling will send
   * its own invitations when this is pushed to it, and two invitations for
   * one meeting is worse than none.
   */
  notify?: boolean;
}

function applyInput(e: VEvent, v: EventInput): VEvent {
  const start = new Date(v.startsAt);
  if (Number.isNaN(start.getTime())) throw badRequest('That start time is not a date');
  const end = v.endsAt ? new Date(v.endsAt) : new Date(start.getTime() + (v.allDay ? 86_400_000 : 3_600_000));
  if (Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) throw badRequest('That event ends before it starts');
  if (v.summary !== undefined) e.summary = v.summary;
  if (v.description !== undefined) e.description = v.description;
  if (v.location !== undefined) e.location = v.location;
  if (v.transparent !== undefined) e.transparent = v.transparent;
  e.start = vtimeOf(start, { allDay: v.allDay, tzid: v.timezone });
  e.end = vtimeOf(end, { allDay: v.allDay, tzid: v.timezone });
  e.duration = null;
  if (v.rrule !== undefined) e.rrule = v.rrule || null;
  if (v.alarms !== undefined) e.alarms = (v.alarms ?? []).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 5);
  if (v.attendees) {
    e.attendees = v.attendees.slice(0, 100).map((a) => ({
      email: String(a.email).toLowerCase(), name: a.name ?? null,
      role: 'REQ-PARTICIPANT', partstat: 'NEEDS-ACTION', rsvp: true, cutype: null,
    }));
  }
  e.status = e.status ?? 'CONFIRMED';
  return e;
}

/**
 * Create an event.
 *
 * It is written locally first and marked as needing to go out, then pushed.
 * That order is what makes the app usable when the network is not: the event
 * appears at once, and reaches the server when it can.
 */
export async function createEvent(userId: number, v: EventInput): Promise<StoredObject> {
  const cal = v.calendarId ? await getCalendar(userId, v.calendarId) : await defaultCalendar(userId);
  if (!cal) throw badRequest('There is no calendar to put this in. Connect one under Settings → Calendars first.');
  if (cal.readOnly) throw badRequest(`"${cal.name}" is read-only`);
  const uid = `${randomBytes(16).toString('hex')}@${new URL(config.appUrl).hostname}`;
  const event = applyInput(newEvent(uid), v);
  const stored = await putObject(userId, cal.id, { ical: writeCalendar([event]), dirty: true, selfEmails: await selfEmails(userId) });
  if (!stored) throw badRequest('That event could not be saved');
  void syncSoon(cal.sourceId);
  if (v.notify && event.attendees.length) stored.invitations = await sendItip(userId, { event, method: 'REQUEST', calendar: cal });
  return stored;
}

/**
 * Which occurrences of a series an edit or a deletion applies to.
 *
 * Every calendar asks this, and it is not a nicety: "cancel the stand-up"
 * meaning one Tuesday and "cancel the stand-up" meaning for ever are the
 * same sentence and different actions, and guessing wrong deletes a year of
 * meetings. A non-recurring event has only one answer, so it is never asked.
 */
export type EditScope = 'all' | 'this' | 'future';

export interface ScopeOptions {
  scope?: EditScope;
  /** Which occurrence, as its original start. Required for 'this' and 'future'. */
  occurrence?: string;
}

// Moving an event without saying how long it is now.
//
// "Shift the stand-up two hours later" gives a new start and no new end, and
// the only sane reading is that it is still fifteen minutes long. Leaving the
// old end in place makes the event end before it starts, which the validator
// then refuses — so the length is carried across explicitly.
function endFor(existing: VEvent, v: Partial<EventInput>): string | null {
  if (v.endsAt !== undefined) return v.endsAt ?? null;
  const length = durationOf(existing);
  if (v.startsAt) return new Date(new Date(v.startsAt).getTime() + length).toISOString();
  return existing.end?.at.toISOString() ?? null;
}

function occurrenceOf(opts: ScopeOptions, master: VEvent): Date {
  const at = opts.occurrence ? new Date(opts.occurrence) : null;
  if (!at || Number.isNaN(at.getTime())) throw badRequest('Which occurrence this applies to was not given');
  void master;
  return at;
}

export async function updateEvent(userId: number, objectId: number, v: Partial<EventInput>, opts: ScopeOptions = {}): Promise<StoredObject> {
  const existing = await readObject(userId, objectId);
  if (!existing) throw notFound('No such event');
  const cal = await getCalendar(userId, existing.calendarId);
  if (!cal) throw notFound('No such event');
  if (cal.readOnly) throw badRequest(`"${cal.name}" is read-only`);

  const parsed = parseCalendar(existing.ical);
  const master = parsed.events.find((e) => !e.recurrenceId) ?? parsed.events[0];
  if (!master) throw badRequest('That event cannot be edited');
  const overrides = parsed.events.filter((e) => e.recurrenceId);
  const mine = await selfEmails(userId);
  // A one-off has no scope to choose; asking about it would only be a way to
  // get it wrong.
  const scope: EditScope = master.rrule ? (opts.scope ?? 'all') : 'all';

  // ---- One occurrence: an override with the same UID ----
  if (scope === 'this') {
    const at = occurrenceOf(opts, master);
    const one = overrideFor(master, overrides, at);
    one.sequence = (one.sequence ?? 0) + 1;
    applyInput(one, {
      ...v,
      startsAt: v.startsAt ?? one.start!.at.toISOString(),
      endsAt: endFor(one, v),
      // An override never carries the rule; the master owns it.
      rrule: null,
    });
    one.rrule = null;
    const stored = await putObject(userId, cal.id, {
      ical: writeCalendar([master, ...overrides]), remoteId: existing.remoteId, etag: existing.etag, dirty: true, selfEmails: mine,
    });
    if (!stored) throw badRequest('That event could not be saved');
    void syncSoon(cal.sourceId);
    if (v.notify && one.attendees.length) stored.invitations = await sendItip(userId, { event: one, method: 'REQUEST', calendar: cal });
    return stored;
  }

  // ---- This one and every later one: split the series in two ----
  //
  // The original is truncated the moment before this occurrence, and a new
  // event with a new UID carries the change forward. Editing the master in
  // place would rewrite history — last month's stand-up would retroactively
  // have been at eleven.
  if (scope === 'future') {
    const at = occurrenceOf(opts, master);
    const startsBefore = master.start!.at.getTime() < at.getTime();
    if (startsBefore) {
      master.rrule = ruleUntil(master.rrule!, at);
      master.sequence = (master.sequence ?? 0) + 1;
      // Overrides that belonged to the part being split off go with it.
      const keptOverrides = overrides.filter((o) => o.recurrenceId!.at.getTime() < at.getTime());
      const moved = overrides.filter((o) => o.recurrenceId!.at.getTime() >= at.getTime());
      await putObject(userId, cal.id, {
        ical: writeCalendar([master, ...keptOverrides]), remoteId: existing.remoteId, etag: existing.etag, dirty: true, selfEmails: mine,
      });

      const tail = newEvent(`${randomBytes(16).toString('hex')}@${new URL(config.appUrl).hostname}`);
      const source = parseCalendar(existing.ical).events.find((e) => !e.recurrenceId)!;
      // How many occurrences stayed behind, so a counted series does not
      // gain the whole count again on this side of the split.
      const keptCount = expandEvent({ ...source, rrule: master.rrule }, [], source.start!.at, at, 400).length;
      Object.assign(tail, { ...source, uid: tail.uid, sequence: 0, exdates: [...source.exdates], rdates: [...source.rdates], attendees: source.attendees.map((a) => ({ ...a })), alarms: [...source.alarms] });
      tail.recurrenceId = null;
      applyInput(tail, {
        ...v,
        startsAt: v.startsAt ?? at.toISOString(),
        endsAt: v.endsAt ?? new Date((v.startsAt ? new Date(v.startsAt).getTime() : at.getTime()) + durationOf(source)).toISOString(),
        rrule: v.rrule !== undefined ? v.rrule : (source.rrule ? ruleAfterSplit(source.rrule, keptCount) : null),
      });
      // Exclusions and moved occurrences that fall in the tail travel with it.
      tail.exdates = source.exdates.filter((d) => d.getTime() >= at.getTime());
      const carried = moved.map((o) => { const c = { ...o, uid: tail.uid }; return c; });
      const stored = await putObject(userId, cal.id, {
        ical: writeCalendar([tail, ...carried]), dirty: true, selfEmails: mine,
      });
      if (!stored) throw badRequest('That event could not be saved');
      void syncSoon(cal.sourceId);
      if (v.notify && tail.attendees.length) stored.invitations = await sendItip(userId, { event: tail, method: 'REQUEST', calendar: cal });
      return stored;
    }
    // Splitting at the very first occurrence is the whole series.
  }

  // ---- The whole series ----
  master.sequence = (master.sequence ?? 0) + 1;
  applyInput(master, { ...v, startsAt: v.startsAt ?? master.start!.at.toISOString(), endsAt: endFor(master, v) });

  const stored = await putObject(userId, cal.id, {
    ical: writeCalendar([master, ...overrides]), remoteId: existing.remoteId, etag: existing.etag, dirty: true, selfEmails: mine,
  });
  if (!stored) throw badRequest('That event could not be saved');
  void syncSoon(cal.sourceId);
  if (v.notify && master.attendees.length) stored.invitations = await sendItip(userId, { event: master, method: 'REQUEST', calendar: cal });
  return stored;
}

export async function deleteEvent(userId: number, objectId: number, opts: ScopeOptions & { notify?: boolean } = {}): Promise<InviteResult | null> {
  const existing = await readObject(userId, objectId);
  if (!existing) throw notFound('No such event');
  const cal = await getCalendar(userId, existing.calendarId);
  if (!cal) throw notFound('No such event');
  if (cal.readOnly) throw badRequest(`"${cal.name}" is read-only`);

  const parsed = parseCalendar(existing.ical);
  const master = parsed.events.find((e) => !e.recurrenceId) ?? parsed.events[0];
  const scope: EditScope = master?.rrule ? (opts.scope ?? 'all') : 'all';

  if (master && scope !== 'all') {
    const at = occurrenceOf(opts, master);
    const overrides = parsed.events.filter((e) => e.recurrenceId);
    if (scope === 'this') {
      // EXDATE rather than a cancelled override: it is the shorter statement
      // and every client understands it.
      if (!master.exdates.some((d) => d.getTime() === at.getTime())) master.exdates.push(at);
      const kept = overrides.filter((o) => o.recurrenceId!.at.getTime() !== at.getTime());
      master.sequence = (master.sequence ?? 0) + 1;
      await putObject(userId, cal.id, {
        ical: writeCalendar([master, ...kept]), remoteId: existing.remoteId, etag: existing.etag, dirty: true, selfEmails: await selfEmails(userId),
      });
      void syncSoon(cal.sourceId);
      // The cancellation names the occurrence, not the series: a guest whose
      // client is told the whole thing is off loses every other Tuesday too.
      return opts.notify && master.attendees.length
        ? sendItip(userId, { event: { ...master, recurrenceId: vtimeOf(at, { allDay: master.start!.allDay, tzid: master.start!.tzid }), rrule: null, exdates: [], start: vtimeOf(at, { allDay: master.start!.allDay, tzid: master.start!.tzid }), end: vtimeOf(new Date(at.getTime() + durationOf(master)), { allDay: master.start!.allDay, tzid: master.start!.tzid }) }, method: 'CANCEL', calendar: cal })
        : null;
    }
    // From here on: truncate rather than delete, unless that would leave
    // nothing at all.
    if (master.start!.at.getTime() < at.getTime()) {
      master.rrule = ruleUntil(master.rrule!, at);
      master.sequence = (master.sequence ?? 0) + 1;
      const kept = overrides.filter((o) => o.recurrenceId!.at.getTime() < at.getTime());
      master.exdates = master.exdates.filter((d) => d.getTime() < at.getTime());
      await putObject(userId, cal.id, {
        ical: writeCalendar([master, ...kept]), remoteId: existing.remoteId, etag: existing.etag, dirty: true, selfEmails: await selfEmails(userId),
      });
      void syncSoon(cal.sourceId);
      return null;
    }
  }

  // Marked rather than removed, so a deletion made offline still reaches the
  // server; the row goes when the push succeeds.
  await query('UPDATE calendar_objects SET deleted=true, dirty=false WHERE id=$1', [objectId]);
  await query('DELETE FROM calendar_instances WHERE object_id=$1', [objectId]);
  void syncSoon(cal.sourceId);
  // Sent before the push, so a guest is told even if the server the event
  // lived on is unreachable.
  return opts.notify && master?.attendees.length ? sendItip(userId, { event: master, method: 'CANCEL', calendar: cal }) : null;
}

// Set by the worker at start-up, so this module can ask for a sync without
// importing the worker and making a cycle of it.
let nudge: ((sourceId: number, delayMs?: number) => void) | null = null;
export function onSyncRequested(fn: typeof nudge): void { nudge = fn; }
function syncSoon(sourceId: number): void { nudge?.(sourceId, 500); }

// ---------- Free/busy, which is what everything else wants ----------

export interface FreeBusy { from: number; to: number }

/**
 * When somebody is busy, from every calendar they have selected.
 *
 * Deliberately not "what are they doing": no titles, no guests, no
 * locations. The assistant, the brief and the propose-times button all read
 * this, and none of them has any business knowing what the meeting is called.
 */
export async function busyIn(userId: number, from: Date, to: Date, opts: BusyOptions = {}): Promise<FreeBusy[]> {
  if (!(await allowed(userId, 'calendar'))) return [];
  const blocks = await busyBlocks(userId, from, to, opts);
  return mergeBlocks(blocks);
}

/** Overlapping blocks become one, so a caller never has to think about it. */
export function mergeBlocks(blocks: FreeBusy[]): FreeBusy[] {
  const sorted = [...blocks].sort((a, b) => a.from - b.from);
  const out: FreeBusy[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.from <= last.to) last.to = Math.max(last.to, b.to);
    else out.push({ ...b });
  }
  return out;
}

/**
 * Midnight to midnight around an instant, in somebody's own zone.
 *
 * Which day "now" falls in is a question about where the person is, not
 * where the server is: at eight in the evening in Chicago it is already
 * tomorrow in UTC, so a day window built without a zone shows the wrong
 * day's meetings for most of the world's evening. Exported because it is the
 * whole of that decision and is worth pinning down in a test.
 */
export function dayWindow(day: Date, tz?: string): { from: Date; to: Date } {
  const zone = safeZone(tz);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(day);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const from = new Date(zonedInstant(zone, get('year'), get('month') - 1, get('day'), 0));
  // Tomorrow's midnight rather than "+24 hours": on the day the clocks
  // change a local day is 23 or 25 hours long, and a fixed span would either
  // drop the last meeting or borrow the next day's first one.
  const next = new Date(from.getTime() + 36 * 3600_000);
  const nextParts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(next);
  const nget = (t: string) => Number(nextParts.find((p) => p.type === t)!.value);
  const to = new Date(zonedInstant(zone, nget('year'), nget('month') - 1, nget('day'), 0));
  return { from, to };
}

/** Everything on one day, for the brief and for the assistant's context. */
export async function agendaFor(userId: number, day: Date, tz?: string): Promise<Instance[]> {
  const { from, to } = dayWindow(day, tz);
  return instancesIn(userId, from, to, { limit: 60 });
}

function safeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

function zonedInstant(tz: string, y: number, m: number, d: number, hour: number): number {
  const guess = Date.UTC(y, m, d, hour);
  const off = (at: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
    const f: Record<string, number> = {};
    for (const x of p) if (x.type !== 'literal') f[x.type] = Number(x.value);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second) - at;
  };
  const first = guess - off(guess);
  return guess - off(first);
}

/**
 * The next few working days as "busy from, free from" lines, for the
 * assistant.
 *
 * This is the only calendar-shaped thing a language model is ever given, and
 * it carries no titles, no guests and no locations — only which hours are
 * taken. A model that knows Thursday afternoon is booked stops proposing
 * Thursday afternoon; a model that knew what the Thursday meeting was would
 * be a diary handed to a language model for no additional benefit.
 */
export async function availabilityFor(userId: number, opts: { days?: number; tz?: string; startHour?: number; endHour?: number } = {}): Promise<{ days: { day: string; busy: string[]; free: string[] }[]; tz?: string } | undefined> {
  if (!(await allowed(userId, 'calendar'))) return undefined;
  const days = Math.min(10, Math.max(1, opts.days ?? 5));
  const zone = safeZone(opts.tz);
  const startHour = Math.min(23, Math.max(0, opts.startHour ?? 9));
  const endHour = Math.min(24, Math.max(startHour + 1, opts.endHour ?? 18));

  const from = new Date();
  const to = new Date(from.getTime() + days * 86_400_000);
  const busy = await busyIn(userId, from, to);
  if (!busy.length && !(await hasCalendars(userId))) return undefined;

  const hhmm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' });
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

  const out: { day: string; busy: string[]; free: string[] }[] = [];
  for (let d = 0; d < days && out.length < 7; d++) {
    const at = new Date(from.getTime() + d * 86_400_000);
    const f = parts.formatToParts(at);
    const get = (t: string) => f.find((x) => x.type === t)!.value;
    if (get('weekday') === 'Sat' || get('weekday') === 'Sun') continue;
    const dayStart = zonedInstant(zone, Number(get('year')), Number(get('month')) - 1, Number(get('day')), startHour);
    const dayEnd = zonedInstant(zone, Number(get('year')), Number(get('month')) - 1, Number(get('day')), endHour);

    const inDay = busy
      .map((b) => ({ from: Math.max(b.from, dayStart), to: Math.min(b.to, dayEnd) }))
      .filter((b) => b.to > b.from);
    // The gaps between them, which is what somebody proposing a time wants.
    const free: string[] = [];
    let cursor = Math.max(dayStart, Date.now());
    for (const b of inDay) {
      if (b.from - cursor >= 30 * 60_000) free.push(`${hhmm(cursor)}-${hhmm(b.from)}`);
      cursor = Math.max(cursor, b.to);
    }
    if (dayEnd - cursor >= 30 * 60_000) free.push(`${hhmm(cursor)}-${hhmm(dayEnd)}`);

    out.push({ day: label.format(at), busy: inDay.map((b) => `${hhmm(b.from)}-${hhmm(b.to)}`), free });
  }
  return out.length ? { days: out, tz: zone === 'UTC' ? undefined : zone } : undefined;
}

/**
 * When other people are busy, for proposing a time that suits everybody.
 *
 * Asked of whichever connected accounts can answer — Google and Microsoft
 * both offer a free/busy query, CalDAV's equivalent needs a scheduling
 * outbox that most self-hosted servers do not run — and the answer is
 * always opaque blocks of time, never what is in them. An address nobody
 * can answer for comes back as `unknown` rather than as free, because
 * proposing a time to somebody whose calendar could not be read is a guess
 * and should be labelled as one.
 */
export interface OthersBusy {
  busy: Record<string, FreeBusy[]>;
  /** Addresses no connected account could answer for. */
  unknown: string[];
}

export async function othersBusyIn(userId: number, emails: string[], from: Date, to: Date): Promise<OthersBusy> {
  const wanted = [...new Set(emails.map((e) => String(e ?? '').trim().toLowerCase()).filter((e) => e.includes('@')))].slice(0, 50);
  const out: OthersBusy = { busy: {}, unknown: [] };
  if (!wanted.length || !(await allowed(userId, 'calendar'))) { out.unknown = wanted; return out; }

  const remaining = new Set(wanted);
  for (const source of await listSources(userId)) {
    if (!remaining.size) break;
    if (source.kind !== 'google' && source.kind !== 'microsoft') continue;
    try {
      const auth = oauthOf(source);
      const answered = source.kind === 'google'
        ? await google.freeBusy(auth, [...remaining], from, to)
        : await graph.freeBusy(auth, [...remaining], from, to);
      for (const [email, blocks] of answered) {
        if (!remaining.has(email)) continue;
        out.busy[email] = mergeBlocks(blocks);
        remaining.delete(email);
      }
    } catch (e) {
      // One provider refusing must not stop another from answering.
      log.info('a free/busy lookup failed', { source: source.id, err: (e as Error).message });
    }
  }
  out.unknown = [...remaining];
  return out;
}

/**
 * Times that suit everybody: the sender's own diary and the guests'.
 *
 * The guests' blocks are merged into the same list the sender's come from,
 * so one rule decides the answer and there is no second notion of "busy" to
 * keep in step.
 */
export async function mutualBusy(userId: number, emails: string[], from: Date, to: Date): Promise<{ blocks: FreeBusy[]; unknown: string[] }> {
  const mine = await busyIn(userId, from, to);
  if (!emails.length) return { blocks: mine, unknown: [] };
  const others = await othersBusyIn(userId, emails, from, to);
  return {
    blocks: mergeBlocks([...mine, ...Object.values(others.busy).flat()]),
    unknown: others.unknown,
  };
}

// ---------- Answering an invitation into the calendar ----------

/**
 * Put an invitation that arrived by mail into a real calendar.
 *
 * This is the join between F10 and F13, and it is the reason accepting an
 * invitation in Tern now does what accepting one anywhere else does: the
 * meeting appears in the calendar rather than only sending a REPLY into the
 * void.
 */
export async function acceptIntoCalendar(userId: number, v: {
  uid: string | null; summary: string | null; location: string | null; description: string | null;
  startsAt: string | null; endsAt: string | null; allDay: boolean;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; partstat: string | null }[];
  partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';
}): Promise<StoredObject | null> {
  if (!v.startsAt) return null;
  const cal = await defaultCalendar(userId);
  if (!cal) return null;
  const uid = v.uid || `${randomBytes(12).toString('hex')}@${new URL(config.appUrl).hostname}`;
  const mine = await selfEmails(userId);

  // Already there — because the calendar and the mailbox are the same
  // account, which is the common case — so the reply is recorded on it
  // rather than a duplicate being made.
  const existing = await findObjectByUid(userId, cal.id, uid);
  const event = existing ? (parseCalendar(existing.ical).events.find((e) => !e.recurrenceId) ?? newEvent(uid)) : newEvent(uid);
  event.uid = uid;
  event.summary = v.summary ?? event.summary;
  event.location = v.location ?? event.location;
  event.description = v.description ?? event.description;
  event.start = vtimeOf(new Date(v.startsAt), { allDay: v.allDay });
  event.end = vtimeOf(v.endsAt ? new Date(v.endsAt) : new Date(new Date(v.startsAt).getTime() + 3_600_000), { allDay: v.allDay });
  event.organizer = v.organizer ?? event.organizer;
  const known = new Map(event.attendees.map((a) => [a.email, a]));
  for (const a of v.attendees) {
    known.set(a.email.toLowerCase(), { email: a.email.toLowerCase(), name: a.name, role: 'REQ-PARTICIPANT', partstat: a.partstat, rsvp: false, cutype: null });
  }
  // The person's own line carries the answer they just gave, which is what
  // makes a declined meeting stop blocking their time.
  for (const email of mine) {
    const own = known.get(email);
    if (own) own.partstat = v.partstat;
  }
  event.attendees = [...known.values()];

  return putObject(userId, cal.id, {
    ical: writeCalendar([event]),
    remoteId: existing?.remoteId ?? null,
    etag: existing?.etag ?? null,
    dirty: !cal.readOnly,
    selfEmails: mine,
  });
}

// ---------- Status, for the settings page ----------

export async function sourceSummaries(userId: number): Promise<any[]> {
  const sources = await listSources(userId);
  const calendars = await listCalendars(userId);
  return sources.map((s) => ({
    id: s.id, kind: s.kind, label: s.label,
    // Never the password, never the token; the address is shown because the
    // person typed it and needs to recognise it.
    baseUrl: s.kind === 'caldav' || s.kind === 'ics' ? s.baseUrl : '',
    username: s.username,
    status: s.status, error: s.error, lastSyncAt: s.lastSyncAt, enabled: s.enabled,
    pollSeconds: s.pollSeconds,
    calendars: calendars.filter((c) => c.sourceId === s.id).map((c) => ({
      id: c.id, name: c.name, color: c.color, readOnly: c.readOnly, selected: c.selected,
      isDefault: c.isDefault, lastSyncAt: c.lastSyncAt, push: Boolean(c.channelId),
    })),
  }));
}
