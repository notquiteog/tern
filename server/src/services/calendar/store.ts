// The database half of the calendar: sources, calendars, the objects inside
// them, and the expanded occurrences that make a range query cheap.
//
// The shape of the bargain here is the same one the mail cache makes.
// Everything a person would read — a title, a location, a guest list — is
// sealed with their own key and is unreadable in a `psql` session. Times are
// not: the grid is ordered by them, free/busy is computed from them, and an
// encrypted timestamp could do neither. What a row leaks to somebody holding
// the database and not the key is that a person was busy from two until
// three, which is the price of the feature working at all.
//
// Occurrences are materialised rather than expanded on read. A month view
// asking twelve recurrence expansions per row would be fine; "is anyone free
// on Thursday" over a year of series would not, and free/busy is on the path
// of the assistant, the brief and the invitation card.
import { one, query } from '../../db.js';
import { decrypt, encrypt } from '../../crypto.js';
import { addressKey, addressTermsWith, dataKey, openWith, sealWith } from '../vault.js';
import { logger } from '../../log.js';
import { expandEvent, parseCalendar, type VEvent } from './vevent.js';

const log = logger('calendar');

// How far the expansion reaches. Back far enough that "what did I do last
// quarter" works, forward far enough that a yearly event is already there,
// and re-extended by the sweep as time moves.
export const EXPAND_BACK_DAYS = 120;
export const EXPAND_FORWARD_DAYS = 550;
const DAY = 86_400_000;

export function expansionWindow(now = Date.now()): { from: Date; to: Date } {
  return { from: new Date(now - EXPAND_BACK_DAYS * DAY), to: new Date(now + EXPAND_FORWARD_DAYS * DAY) };
}

// ---------- Types ----------

export type SourceKind = 'caldav' | 'google' | 'microsoft' | 'ics';

export interface SourceRow {
  id: number; user_id: number; kind: SourceKind;
  label: string | null; base_url: string | null; username: string | null;
  secret_enc: string | null; token_enc: string | null;
  status: 'ok' | 'syncing' | 'auth_error' | 'error'; error: string | null;
  sync_token: string | null; enabled: boolean; poll_seconds: number;
  last_sync_at: Date | null; created_at: Date;
}

/** A source with its sealed fields opened and its secrets decrypted. */
export interface Source {
  id: number; userId: number; kind: SourceKind;
  label: string; baseUrl: string; username: string;
  secret: string; token: OAuthToken | null;
  status: SourceRow['status']; error: string | null;
  syncToken: string | null; enabled: boolean; pollSeconds: number;
  lastSyncAt: Date | null;
}

export interface OAuthToken { accessToken: string; refreshToken: string; expiresAt: number; scope?: string }

export interface Calendar {
  id: number; userId: number; sourceId: number;
  remoteId: string; name: string; color: string | null; timezone: string | null;
  readOnly: boolean; selected: boolean; isDefault: boolean;
  syncToken: string | null; ctag: string | null;
  channelId: string | null; channelSecret: string | null; channelResource: string | null; channelExpiresAt: Date | null;
  lastSyncAt: Date | null;
}

export interface StoredObject {
  id: number; calendarId: number; uid: string; remoteId: string | null; etag: string | null;
  ical: string; summary: string | null; location: string | null; description: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; partstat: string | null }[];
  startsAt: Date | null; endsAt: Date | null; allDay: boolean; recurring: boolean;
  transparent: boolean; status: string | null; sequence: number; myPartstat: string | null;
  alarmMinutes: number | null;
  dirty: boolean; deleted: boolean;
  /**
   * What happened when the guests were written to, where they were. Not
   * stored — it belongs to the request that caused it, so the page can say
   * "sent to three, one bounced" rather than claiming silence was success.
   */
  invitations?: { sent: string[]; failed: { email: string; error: string }[] };
}

// ---------- Sources ----------

function blindOf(dek: Buffer, value: string): Buffer {
  const b = addressTermsWith(addressKey(dek), [`cal:${value}`])[0];
  if (!b) throw new Error('could not build a blind index term');
  return b;
}

export async function openSource(row: SourceRow): Promise<Source> {
  const dek = await dataKey(row.user_id);
  let token: OAuthToken | null = null;
  if (row.token_enc) {
    try { token = JSON.parse(decrypt(row.token_enc)) as OAuthToken; } catch { token = null; }
  }
  return {
    id: row.id, userId: row.user_id, kind: row.kind,
    label: openWith(dek, row.label) ?? '',
    baseUrl: openWith(dek, row.base_url) ?? '',
    username: openWith(dek, row.username) ?? '',
    secret: row.secret_enc ? decrypt(row.secret_enc) : '',
    token,
    status: row.status, error: row.error,
    syncToken: openWith(dek, row.sync_token),
    enabled: row.enabled, pollSeconds: row.poll_seconds, lastSyncAt: row.last_sync_at,
  };
}

export async function listSources(userId?: number): Promise<Source[]> {
  const rows = userId === undefined
    ? await query<SourceRow>('SELECT * FROM calendar_sources WHERE enabled ORDER BY id')
    : await query<SourceRow>('SELECT * FROM calendar_sources WHERE user_id=$1 ORDER BY id', [userId]);
  return Promise.all(rows.map(openSource));
}

export async function getSource(id: number, userId?: number): Promise<Source | null> {
  const row = userId === undefined
    ? await one<SourceRow>('SELECT * FROM calendar_sources WHERE id=$1', [id])
    : await one<SourceRow>('SELECT * FROM calendar_sources WHERE id=$1 AND user_id=$2', [id, userId]);
  return row ? openSource(row) : null;
}

export async function createSource(userId: number, v: {
  kind: SourceKind; label: string; baseUrl?: string; username?: string; secret?: string; token?: OAuthToken | null; pollSeconds?: number;
}): Promise<Source> {
  const dek = await dataKey(userId);
  const row = await one<SourceRow>(
    `INSERT INTO calendar_sources (user_id, kind, label, base_url, username, secret_enc, token_enc, poll_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      userId, v.kind, sealWith(dek, v.label), sealWith(dek, v.baseUrl ?? ''), sealWith(dek, v.username ?? ''),
      v.secret ? encrypt(v.secret) : null,
      v.token ? encrypt(JSON.stringify(v.token)) : null,
      Math.min(3600, Math.max(60, v.pollSeconds ?? 300)),
    ],
  );
  return openSource(row!);
}

export async function updateSourceToken(id: number, token: OAuthToken): Promise<void> {
  await query('UPDATE calendar_sources SET token_enc=$2 WHERE id=$1', [id, encrypt(JSON.stringify(token))]);
}

export async function setSourceStatus(id: number, status: SourceRow['status'], error?: string | null): Promise<void> {
  await query(
    `UPDATE calendar_sources SET status=$2, error=$3, last_sync_at=CASE WHEN $2='ok' THEN now() ELSE last_sync_at END WHERE id=$1`,
    [id, status, error ? String(error).slice(0, 500) : null],
  );
}

export async function setSourceSyncToken(id: number, userId: number, token: string | null): Promise<void> {
  await query('UPDATE calendar_sources SET sync_token=$2 WHERE id=$1', [id, sealWith(await dataKey(userId), token)]);
}

export async function deleteSource(userId: number, id: number): Promise<boolean> {
  const rows = await query('DELETE FROM calendar_sources WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId]);
  return rows.length > 0;
}

// ---------- Calendars ----------

async function openCalendar(dek: Buffer, r: any): Promise<Calendar> {
  return {
    id: r.id, userId: r.user_id, sourceId: r.source_id,
    remoteId: openWith(dek, r.remote_id) ?? '',
    name: openWith(dek, r.name) ?? '',
    color: r.color, timezone: r.timezone,
    readOnly: r.read_only, selected: r.selected, isDefault: r.is_default,
    syncToken: openWith(dek, r.sync_token), ctag: openWith(dek, r.ctag),
    channelId: r.channel_id, channelSecret: r.channel_secret, channelResource: r.channel_resource,
    channelExpiresAt: r.channel_expires_at, lastSyncAt: r.last_sync_at,
  };
}

export async function listCalendars(userId: number, opts: { sourceId?: number; selectedOnly?: boolean } = {}): Promise<Calendar[]> {
  const where = ['user_id=$1'];
  const params: unknown[] = [userId];
  if (opts.sourceId !== undefined) { params.push(opts.sourceId); where.push(`source_id=$${params.length}`); }
  if (opts.selectedOnly) where.push('selected');
  const rows = await query(`SELECT * FROM calendars WHERE ${where.join(' AND ')} ORDER BY is_default DESC, id`, params);
  const dek = await dataKey(userId);
  return Promise.all(rows.map((r) => openCalendar(dek, r)));
}

export async function getCalendar(userId: number, id: number): Promise<Calendar | null> {
  const r = await one('SELECT * FROM calendars WHERE id=$1 AND user_id=$2', [id, userId]);
  return r ? openCalendar(await dataKey(userId), r) : null;
}

/** Find or create the row for a remote collection, and refresh what it says about itself. */
export async function upsertCalendar(userId: number, sourceId: number, v: {
  remoteId: string; name: string; color?: string | null; timezone?: string | null; readOnly?: boolean; isDefault?: boolean;
}): Promise<Calendar> {
  const dek = await dataKey(userId);
  const r = await one(
    `INSERT INTO calendars (user_id, source_id, remote_id, remote_blind, name, color, timezone, read_only, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (source_id, remote_blind) DO UPDATE SET
       name=EXCLUDED.name, color=COALESCE(EXCLUDED.color, calendars.color),
       timezone=COALESCE(EXCLUDED.timezone, calendars.timezone), read_only=EXCLUDED.read_only
     RETURNING *`,
    [
      userId, sourceId, sealWith(dek, v.remoteId), blindOf(dek, v.remoteId), sealWith(dek, v.name),
      v.color ?? null, v.timezone ?? null, Boolean(v.readOnly), Boolean(v.isDefault),
    ],
  );
  return openCalendar(dek, r);
}

export async function setCalendarSync(id: number, userId: number, v: { syncToken?: string | null; ctag?: string | null }): Promise<void> {
  const dek = await dataKey(userId);
  const sets: string[] = ['last_sync_at=now()'];
  const params: unknown[] = [id];
  if (v.syncToken !== undefined) { params.push(sealWith(dek, v.syncToken)); sets.push(`sync_token=$${params.length}`); }
  if (v.ctag !== undefined) { params.push(sealWith(dek, v.ctag)); sets.push(`ctag=$${params.length}`); }
  await query(`UPDATE calendars SET ${sets.join(', ')} WHERE id=$1`, params);
}

export async function setCalendarChannel(id: number, v: { channelId: string | null; secret?: string | null; resource?: string | null; expiresAt?: Date | null }): Promise<void> {
  await query(
    'UPDATE calendars SET channel_id=$2, channel_secret=$3, channel_resource=$4, channel_expires_at=$5 WHERE id=$1',
    [id, v.channelId, v.secret ?? null, v.resource ?? null, v.expiresAt ?? null],
  );
}

export async function updateCalendar(userId: number, id: number, v: { selected?: boolean; color?: string | null; isDefault?: boolean }): Promise<Calendar | null> {
  if (v.isDefault) await query('UPDATE calendars SET is_default=false WHERE user_id=$1', [userId]);
  const r = await one(
    `UPDATE calendars SET selected=COALESCE($3, selected), color=COALESCE($4, color), is_default=COALESCE($5, is_default)
      WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, userId, v.selected ?? null, v.color ?? null, v.isDefault ?? null],
  );
  return r ? openCalendar(await dataKey(userId), r) : null;
}

/** The calendar a new event goes into when nobody said which. */
export async function defaultCalendar(userId: number): Promise<Calendar | null> {
  const r = await one(
    `SELECT * FROM calendars WHERE user_id=$1 AND NOT read_only ORDER BY is_default DESC, selected DESC, id LIMIT 1`,
    [userId],
  );
  return r ? openCalendar(await dataKey(userId), r) : null;
}

// Calendars that vanished from the far side. Removing the row takes the
// objects and instances with it through the cascade.
export async function pruneCalendars(userId: number, sourceId: number, keepRemoteIds: string[]): Promise<number> {
  const dek = await dataKey(userId);
  const keep = keepRemoteIds.map((r) => blindOf(dek, r));
  const rows = keep.length
    ? await query('DELETE FROM calendars WHERE source_id=$1 AND NOT (remote_blind = ANY($2::bytea[])) RETURNING id', [sourceId, keep])
    : await query('DELETE FROM calendars WHERE source_id=$1 RETURNING id', [sourceId]);
  return rows.length;
}

// ---------- Objects ----------

/**
 * Write one iCalendar file into a calendar and re-expand its occurrences.
 *
 * The raw text is the record. Everything indexed beside it is derived, so a
 * property this code does not model is still handed back to the server
 * untouched on the next write.
 */
export async function putObject(userId: number, calendarId: number, v: {
  ical: string; remoteId?: string | null; etag?: string | null; dirty?: boolean; selfEmails?: string[];
}): Promise<StoredObject | null> {
  const parsed = parseCalendar(v.ical);
  const master = parsed.events.find((e) => !e.recurrenceId) ?? parsed.events[0];
  if (!master?.start) return null;
  const overrides = parsed.events.filter((e) => e.recurrenceId && e.uid === master.uid);
  const dek = await dataKey(userId);

  // Where the series ends, for the sweep that extends expansions forward.
  const { from, to } = expansionWindow();
  const occurrences = expandEvent(master, overrides, from, to);
  const last = occurrences[occurrences.length - 1];
  const endless = Boolean(master.rrule) && !/COUNT=|UNTIL=/i.test(master.rrule ?? '');

  const mine = new Set((v.selfEmails ?? []).map((e) => e.toLowerCase()));
  const myPartstat = master.attendees.find((a) => mine.has(a.email.toLowerCase()))?.partstat ?? null;

  const row = await one<{ id: number }>(
    `INSERT INTO calendar_objects
       (user_id, calendar_id, uid, uid_blind, remote_id, etag, ical, summary, location, description, organizer, attendees,
        starts_at, ends_at, range_end, all_day, recurring, transparent, status, sequence, my_partstat, dirty, alarm_minutes, deleted, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,false,now())
     ON CONFLICT (calendar_id, uid_blind) DO UPDATE SET
       remote_id=COALESCE(EXCLUDED.remote_id, calendar_objects.remote_id), etag=EXCLUDED.etag, ical=EXCLUDED.ical,
       summary=EXCLUDED.summary, location=EXCLUDED.location, description=EXCLUDED.description,
       organizer=EXCLUDED.organizer, attendees=EXCLUDED.attendees,
       starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, range_end=EXCLUDED.range_end,
       all_day=EXCLUDED.all_day, recurring=EXCLUDED.recurring, transparent=EXCLUDED.transparent,
       status=EXCLUDED.status, sequence=EXCLUDED.sequence, my_partstat=EXCLUDED.my_partstat,
       dirty=EXCLUDED.dirty, alarm_minutes=EXCLUDED.alarm_minutes, deleted=false, updated_at=now()
     RETURNING id`,
    [
      userId, calendarId, sealWith(dek, master.uid), blindOf(dek, master.uid),
      v.remoteId ? sealWith(dek, v.remoteId) : null, v.etag ?? null, sealWith(dek, v.ical),
      sealWith(dek, master.summary), sealWith(dek, master.location), sealWith(dek, master.description?.slice(0, 8000) ?? null),
      master.organizer ? sealWith(dek, JSON.stringify(master.organizer)) : null,
      master.attendees.length ? sealWith(dek, JSON.stringify(master.attendees.map((a) => ({ email: a.email, name: a.name, partstat: a.partstat })))) : null,
      master.start.at, master.end?.at ?? null,
      endless ? null : last?.end ?? master.end?.at ?? master.start.at,
      master.start.allDay, Boolean(master.rrule || master.rdates.length), master.transparent,
      master.status ?? null, master.sequence, myPartstat, Boolean(v.dirty),
      // The earliest reminder the event carries. One notification per
      // occurrence is the useful number; a person who set two wants to be
      // told in good time, not told twice.
      master.alarms.length ? Math.max(...master.alarms) : null,
    ],
  );
  if (!row) return null;
  await writeInstances(userId, calendarId, row.id, dek, master, occurrences, myPartstat);
  await silenceOldInstances(row.id);
  return readObject(userId, row.id);
}

// The occurrences of one object, rewritten wholesale. Cheaper and far less
// error-prone than working out which ones changed, and an object is a
// handful of rows.
async function writeInstances(
  userId: number, calendarId: number, objectId: number, dek: Buffer,
  master: VEvent, occurrences: ReturnType<typeof expandEvent>, myPartstat: string | null,
): Promise<void> {
  await query('DELETE FROM calendar_instances WHERE object_id=$1', [objectId]);
  if (!occurrences.length) return;
  const declined = String(myPartstat ?? '').toUpperCase() === 'DECLINED';
  const cancelled = String(master.status ?? '').toUpperCase() === 'CANCELLED';

  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const o of occurrences.slice(0, 750)) {
    const ev = o.override ?? master;
    const busy = !ev.transparent && !cancelled && !declined && String(ev.status ?? '').toUpperCase() !== 'CANCELLED';
    const base = values.length;
    values.push(userId, calendarId, objectId, o.start, o.end, o.allDay, busy, o.recurrenceId,
      sealWith(dek, ev.summary ?? master.summary), sealWith(dek, ev.location ?? master.location));
    tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
  }
  await query(
    `INSERT INTO calendar_instances (user_id, calendar_id, object_id, starts_at, ends_at, all_day, busy, recurrence_id, summary, location)
     VALUES ${tuples.join(',')}`,
    values,
  );
}

export async function readObject(userId: number, id: number): Promise<StoredObject | null> {
  const r = await one('SELECT * FROM calendar_objects WHERE id=$1 AND user_id=$2', [id, userId]);
  return r ? openObject(await dataKey(userId), r) : null;
}

export async function findObjectByUid(userId: number, calendarId: number, uid: string): Promise<StoredObject | null> {
  const dek = await dataKey(userId);
  const r = await one('SELECT * FROM calendar_objects WHERE calendar_id=$1 AND uid_blind=$2', [calendarId, blindOf(dek, uid)]);
  return r ? openObject(dek, r) : null;
}

export function openObject(dek: Buffer, r: any): StoredObject {
  const parse = <T>(v: string | null, fallback: T): T => {
    if (!v) return fallback;
    try { return JSON.parse(openWith(dek, v) ?? '') as T; } catch { return fallback; }
  };
  return {
    id: r.id, calendarId: r.calendar_id,
    uid: openWith(dek, r.uid) ?? '',
    remoteId: openWith(dek, r.remote_id),
    etag: r.etag,
    ical: openWith(dek, r.ical) ?? '',
    summary: openWith(dek, r.summary), location: openWith(dek, r.location), description: openWith(dek, r.description),
    organizer: parse<{ email: string; name: string | null } | null>(r.organizer, null),
    attendees: parse<{ email: string; name: string | null; partstat: string | null }[]>(r.attendees, []),
    startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day, recurring: r.recurring,
    transparent: r.transparent, status: r.status, sequence: r.sequence, myPartstat: r.my_partstat,
    alarmMinutes: r.alarm_minutes ?? null,
    dirty: r.dirty, deleted: r.deleted,
  };
}

/** Remove an object the far side no longer has. */
export async function dropObject(userId: number, calendarId: number, uid: string): Promise<void> {
  const dek = await dataKey(userId);
  await query('DELETE FROM calendar_objects WHERE calendar_id=$1 AND uid_blind=$2', [calendarId, blindOf(dek, uid)]);
}

/**
 * Remove several objects the far side no longer has, in one pass.
 *
 * Remote ids are sealed, so they cannot be matched in SQL and the column has
 * to be opened. Doing that once for a whole sync rather than once per
 * deletion is the difference between one scan and one per removed event —
 * which, on the sync that follows somebody emptying a calendar, is the
 * difference between a scan and a few hundred of them.
 *
 * Returns the ids it could not find, which is how the caller knows a
 * provider reported a deletion in terms this calendar does not hold.
 */
export async function dropObjectsByRemoteIds(userId: number, calendarId: number, remoteIds: string[]): Promise<string[]> {
  const wanted = new Set(remoteIds.filter(Boolean));
  if (!wanted.size) return [];
  const dek = await dataKey(userId);
  const rows = await query<{ id: number; remote_id: string | null }>('SELECT id, remote_id FROM calendar_objects WHERE calendar_id=$1', [calendarId]);
  const hits: number[] = [];
  for (const r of rows) {
    const href = openWith(dek, r.remote_id);
    if (href && wanted.has(href)) { hits.push(r.id); wanted.delete(href); }
  }
  if (hits.length) await query('DELETE FROM calendar_objects WHERE id = ANY($1::bigint[])', [hits]);
  return [...wanted];
}

export async function dropObjectByRemoteId(userId: number, calendarId: number, remoteId: string): Promise<void> {
  await dropObjectsByRemoteIds(userId, calendarId, [remoteId]);
}

/** Objects with a local change the server has not been told about yet. */
export async function pendingObjects(userId: number, calendarId: number): Promise<StoredObject[]> {
  const rows = await query('SELECT * FROM calendar_objects WHERE calendar_id=$1 AND (dirty OR deleted) ORDER BY id', [calendarId]);
  const dek = await dataKey(userId);
  return rows.map((r) => openObject(dek, r));
}

export async function markClean(id: number, etag: string | null, remoteId: string | null, userId: number): Promise<void> {
  const dek = await dataKey(userId);
  await query(
    'UPDATE calendar_objects SET dirty=false, etag=COALESCE($2, etag), remote_id=COALESCE($3, remote_id) WHERE id=$1',
    [id, etag, remoteId ? sealWith(dek, remoteId) : null],
  );
}

export async function forgetObject(id: number): Promise<void> {
  await query('DELETE FROM calendar_objects WHERE id=$1', [id]);
}

// ---------- Reading occurrences ----------

export interface Instance {
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

/** Everything in a window, ordered, for the grid and the agenda. */
export async function instancesIn(userId: number, from: Date, to: Date, opts: { calendarIds?: number[]; selectedOnly?: boolean; limit?: number } = {}): Promise<Instance[]> {
  const params: unknown[] = [userId, from, to];
  const where = ['i.user_id=$1', 'i.ends_at > $2', 'i.starts_at < $3'];
  if (opts.selectedOnly !== false) where.push('c.selected');
  if (opts.calendarIds?.length) { params.push(opts.calendarIds); where.push(`i.calendar_id = ANY($${params.length}::bigint[])`); }
  params.push(Math.min(2000, opts.limit ?? 1000));
  const rows = await query(
    `SELECT i.*, c.name AS cal_name, c.color AS cal_color, c.read_only
       FROM calendar_instances i JOIN calendars c ON c.id = i.calendar_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.starts_at ASC LIMIT $${params.length}`,
    params,
  );
  const dek = await dataKey(userId);
  return rows.map((r) => ({
    id: r.id, objectId: r.object_id, calendarId: r.calendar_id,
    calendarName: openWith(dek, r.cal_name) ?? '', color: r.cal_color,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    allDay: r.all_day, busy: r.busy,
    summary: openWith(dek, r.summary), location: openWith(dek, r.location),
    recurrenceId: r.recurrence_id ? new Date(r.recurrence_id).toISOString() : null,
    readOnly: r.read_only,
  }));
}

/**
 * Busy blocks in a window: the times a person cannot be booked.
 *
 * Only times, never titles. This is what the assistant, the brief and the
 * "propose times" button consult, and none of them has any business knowing
 * what the meeting is called.
 */
export interface BusyOptions {
  /**
   * Events to leave out, by iCalendar UID.
   *
   * Needed because the same meeting can legitimately be in two places: an
   * invitation that arrived by mail, and the calendar it was accepted into.
   * Asked "does this invitation clash with anything", a query that counted
   * the invitation's own calendar copy would answer yes — the meeting
   * conflicting with itself.
   */
  excludeUids?: string[];
}

export async function busyBlocks(userId: number, from: Date, to: Date, opts: BusyOptions = {}): Promise<{ from: number; to: number }[]> {
  const params: unknown[] = [userId, from, to];
  let exclude = '';
  const uids = [...new Set((opts.excludeUids ?? []).filter(Boolean))];
  if (uids.length) {
    // UIDs are sealed, so the exclusion is matched on the same blind
    // companion the unique index uses rather than on the plaintext.
    const dek = await dataKey(userId);
    params.push(uids.map((u) => blindOf(dek, u)));
    exclude = ` AND NOT (o.uid_blind = ANY($${params.length}::bytea[]))`;
  }
  const rows = await query<{ starts_at: Date; ends_at: Date }>(
    `SELECT i.starts_at, i.ends_at FROM calendar_instances i
       JOIN calendars c ON c.id = i.calendar_id
       JOIN calendar_objects o ON o.id = i.object_id
      WHERE i.user_id=$1 AND i.busy AND c.selected AND i.ends_at > $2 AND i.starts_at < $3${exclude}
      ORDER BY i.starts_at LIMIT 5000`,
    params,
  );
  return rows.map((r) => ({ from: new Date(r.starts_at).getTime(), to: new Date(r.ends_at).getTime() }));
}

/**
 * Occurrences that are due to be announced.
 *
 * "Due" means the reminder time has arrived and the event has not started
 * long enough ago to be pointless. The upper bound matters: a server that
 * was off for a day must not wake up and fire two hundred notifications for
 * meetings that already happened.
 */
export interface DueReminder {
  instanceId: number;
  userId: number;
  startsAt: Date;
  summary: string | null;
  location: string | null;
  minutes: number;
}

export async function dueReminders(limit = 200): Promise<DueReminder[]> {
  const rows = await query<any>(
    `SELECT i.id, i.user_id, i.starts_at, i.summary, i.location, o.alarm_minutes
       FROM calendar_instances i
       JOIN calendar_objects o ON o.id = i.object_id
       JOIN calendars c ON c.id = i.calendar_id
      WHERE i.notified_at IS NULL AND i.busy AND c.selected
        AND o.alarm_minutes IS NOT NULL AND NOT o.deleted
        AND i.starts_at <= now() + (o.alarm_minutes || ' minutes')::interval
        AND i.starts_at > now() - interval '15 minutes'
      ORDER BY i.starts_at LIMIT $1`,
    [limit],
  );
  const byUser = new Map<number, Buffer>();
  const out: DueReminder[] = [];
  for (const r of rows) {
    let dek = byUser.get(r.user_id);
    if (!dek) { dek = await dataKey(r.user_id); byUser.set(r.user_id, dek); }
    out.push({
      instanceId: r.id, userId: r.user_id, startsAt: new Date(r.starts_at),
      summary: openWith(dek, r.summary), location: openWith(dek, r.location),
      minutes: r.alarm_minutes,
    });
  }
  return out;
}

/**
 * Mark occurrences as announced.
 *
 * Called whatever the notification did, including when it failed: a person
 * with no browser subscribed would otherwise have every reminder retried on
 * every sweep for the rest of the day.
 */
export async function markNotified(instanceIds: number[]): Promise<void> {
  if (!instanceIds.length) return;
  await query('UPDATE calendar_instances SET notified_at=now() WHERE id = ANY($1::bigint[])', [instanceIds]);
}

// Occurrences already in the past when their event was first stored are
// never announced: importing a year of history must not produce a year of
// notifications.
export async function silenceOldInstances(objectId: number): Promise<void> {
  await query('UPDATE calendar_instances SET notified_at=now() WHERE object_id=$1 AND starts_at < now()', [objectId]);
}

/** Whether this install has any calendar at all for a person. */
export async function hasCalendars(userId: number): Promise<boolean> {
  return Boolean(await one('SELECT 1 FROM calendars WHERE user_id=$1 LIMIT 1', [userId]));
}

// ---------- Housekeeping ----------

/**
 * Re-expand the series whose materialised occurrences no longer reach far
 * enough forward. Without this a weekly meeting would quietly stop appearing
 * about eighteen months after it was last synced.
 */
export async function extendExpansions(userId: number, limit = 50): Promise<number> {
  const { to } = expansionWindow();
  const rows = await query(
    `SELECT o.* FROM calendar_objects o
      WHERE o.user_id=$1 AND o.recurring AND NOT o.deleted
        AND (o.range_end IS NULL OR o.range_end > now())
        AND NOT EXISTS (
          SELECT 1 FROM calendar_instances i WHERE i.object_id = o.id AND i.starts_at > $2
        )
      ORDER BY o.updated_at ASC LIMIT $3`,
    [userId, new Date(to.getTime() - 30 * DAY), limit],
  );
  if (!rows.length) return 0;
  const dek = await dataKey(userId);
  let done = 0;
  for (const r of rows) {
    const ical = openWith(dek, r.ical);
    if (!ical) continue;
    try {
      await putObject(userId, r.calendar_id, { ical, remoteId: openWith(dek, r.remote_id), etag: r.etag });
      done++;
    } catch (e) {
      log.warn('could not extend a recurring event', { object: r.id, err: (e as Error).message });
    }
  }
  return done;
}

/** Occurrences that have fallen out of the back of the window. */
export async function pruneInstances(userId: number): Promise<number> {
  const { from } = expansionWindow();
  const rows = await query('DELETE FROM calendar_instances WHERE user_id=$1 AND ends_at < $2 RETURNING id', [userId, from]);
  return rows.length;
}
