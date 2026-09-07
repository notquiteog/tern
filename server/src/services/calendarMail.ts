// F10, the database half: invitations found in mail.
//
// This is not a calendar. It recognises the `text/calendar` part of a
// message, stores what it says, and lets somebody reply to it — which is the
// question actually in front of a person reading their inbox. Being a
// calendar (recurrence expansion, free/busy publishing, CalDAV sync) is a
// much larger piece of work, and shipping half of one is worse than shipping
// none: a calendar that silently drops the third Tuesday of a series is a
// missed meeting rather than a missing feature.
//
// What it does buy, today: an invitation shows as an invitation with the
// right time in the reader's own zone, a clash with something else in the
// mail is pointed out, and accepting or declining sends a proper REPLY.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { clientFor } from './accounts.js';
import { addressKey, addressTermsWith, dataKey, openWith, sealWith } from './vault.js';
import { openEmails } from './mailVault.js';
import { parseIcalendar, type IcalEvent } from './icalendar.js';
import { allowed } from './capabilities.js';
import type { AccountRow } from './accounts.js';

const log = logger('calendar');

export interface Invitation {
  id: number;
  uid: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; partstat: string | null }[];
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  method: string;
  sequence: number;
  reply: 'accepted' | 'declined' | 'tentative' | null;
  recurrence: string | null;
  approximate: boolean;
  accountId: number;
  emailId: number | null;
  /** Other invitations that overlap this one. */
  clashes: { id: number; summary: string | null; startsAt: string | null }[];
}

const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics', 'text/x-vcalendar']);

// Messages per pass. An invitation is a small part to download and a cheap
// parse, so this can be more generous than the attachment reader.
export const SCAN_BATCH = 10;

export async function scanForInvitations(userId: number, acc: AccountRow, limit = SCAN_BATCH): Promise<number> {
  if (!(await allowed(userId, 'calendar'))) return 0;
  // Messages with an attachment that have not been looked at yet. The
  // marker is the same `attachments_extracted` flag F5 uses? No: they are
  // independent features, so this keeps its own record by asking whether a
  // row already exists for the message.
  const rows = await query<any>(
    `SELECT e.id, e.account_id, e.attachments
       FROM emails e
      WHERE e.account_id=$1 AND e.has_attachment
        AND e.received_at > now() - interval '180 days'
        AND NOT EXISTS (SELECT 1 FROM calendar_events c WHERE c.email_id = e.id)
      ORDER BY e.received_at DESC LIMIT $2`,
    [acc.id, limit],
  );
  if (!rows.length) return 0;

  const opened = await openEmails(userId, 'calendar', rows);
  const dek = await dataKey(userId);
  let found = 0;

  for (let i = 0; i < opened.length; i++) {
    const parts = (opened[i].attachments as any[] ?? []).filter((p) => CALENDAR_TYPES.has(String(p?.type ?? '').toLowerCase().split(';')[0]));
    if (!parts.length) continue;
    for (const part of parts.slice(0, 3)) {
      if (!part.blobId || (part.size ?? 0) > 512 * 1024) continue;
      let text: string;
      try {
        const res = await clientFor(acc).download(part.blobId, part.name ?? 'invite.ics', 'text/calendar');
        if (!res.ok) { log.warn('could not fetch an invitation', { account: acc.id, status: res.status }); continue; }
        text = await res.text();
      } catch (e) {
        // Swallowing this silently makes a mailbox that can never download —
        // a stale credential, a moved server — look like a mailbox with no
        // invitations in it, for ever, with nothing anywhere to say why.
        log.warn('could not fetch an invitation', { account: acc.id, err: (e as Error).message });
        continue;
      }
      const doc = parseIcalendar(text);
      for (const ev of doc.events.slice(0, 5)) {
        await store(userId, acc, rows[i].id, doc.method, ev, dek);
        found++;
      }
    }
  }
  if (found) log.info(`found ${found} invitations`, { account: acc.id });
  return found;
}

// An iCalendar UID is usually random, but plenty of systems build one out of
// the event's title, so it is content and travels sealed. A sealed value
// cannot carry a unique index — the IV is random, so the same UID seals
// differently every time — so it gains a deterministic blind companion, the
// same trick emails.from_blind uses, and the index is on that.
function uidBlind(dek: Buffer, uid: string | null): Buffer | null {
  if (!uid) return null;
  return addressTermsWith(addressKey(dek), [`ical:${uid}`])[0] ?? null;
}

// Exported so the plaintext sweep can write one without a mail server in the
// way; the scan path above is its only other caller.
export async function storeInvitation(userId: number, accountId: number, emailId: number, ev: IcalEvent, method = 'REQUEST'): Promise<void> {
  await store(userId, { id: accountId } as AccountRow, emailId, method, ev, await dataKey(userId));
}

async function store(userId: number, acc: AccountRow, emailId: number, method: string, ev: IcalEvent, dek: Buffer): Promise<void> {
  await query(
    `INSERT INTO calendar_events
       (user_id, account_id, email_id, uid, uid_blind, summary, location, organizer, attendees, description,
        starts_at, ends_at, all_day, method, sequence)
     VALUES ($1,$2,$3,$4,$15,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (email_id, uid_blind) DO UPDATE SET
       summary=EXCLUDED.summary, location=EXCLUDED.location, organizer=EXCLUDED.organizer,
       attendees=EXCLUDED.attendees, description=EXCLUDED.description,
       starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, all_day=EXCLUDED.all_day,
       method=EXCLUDED.method, sequence=EXCLUDED.sequence`,
    [
      userId, acc.id, emailId, ev.uid ? sealWith(dek, ev.uid) : null,
      // Everything a person would read is sealed; the times are not, because
      // the list is ordered by them and a clash is found with them.
      ev.summary ? sealWith(dek, ev.summary) : null,
      ev.location ? sealWith(dek, ev.location) : null,
      ev.organizer ? sealWith(dek, JSON.stringify(ev.organizer)) : null,
      ev.attendees.length ? sealWith(dek, JSON.stringify(ev.attendees)) : null,
      ev.description ? sealWith(dek, ev.description.slice(0, 4000)) : null,
      ev.start, ev.end, ev.allDay, method, ev.sequence,
      uidBlind(dek, ev.uid),
    ],
  );
}

// ---------- Reading ----------

export async function upcoming(userId: number, days = 30): Promise<Invitation[]> {
  const rows = await query<any>(
    `SELECT * FROM calendar_events
      WHERE user_id=$1 AND starts_at IS NOT NULL
        AND starts_at > now() - interval '1 day'
        AND starts_at < now() + ($2 || ' days')::interval
      ORDER BY starts_at ASC LIMIT 200`,
    [userId, days],
  );
  return openAll(userId, rows);
}

export async function invitationsFor(userId: number, emailId: number): Promise<Invitation[]> {
  const rows = await query<any>(
    'SELECT * FROM calendar_events WHERE user_id=$1 AND email_id=$2 ORDER BY starts_at',
    [userId, emailId],
  );
  return openAll(userId, rows);
}

async function openAll(userId: number, rows: any[]): Promise<Invitation[]> {
  if (!rows.length) return [];
  const dek = await dataKey(userId);
  const parse = <T>(v: string | null, fallback: T): T => {
    if (!v) return fallback;
    try { return JSON.parse(openWith(dek, v) ?? '') as T; } catch { return fallback; }
  };
  // Anything overlapping, so the card can say "this clashes with…". One
  // query over the same rows rather than one per invitation.
  const all = await query<any>(
    `SELECT id, summary, starts_at, ends_at FROM calendar_events
      WHERE user_id=$1 AND starts_at IS NOT NULL AND reply IS DISTINCT FROM 'declined'`,
    [userId],
  );

  return rows.map((r) => {
    const start = r.starts_at ? new Date(r.starts_at).getTime() : null;
    const end = r.ends_at ? new Date(r.ends_at).getTime() : (start ? start + 3600_000 : null);
    const clashes = start === null ? [] : all
      .filter((o: any) => {
        if (o.id === r.id || !o.starts_at) return false;
        const os = new Date(o.starts_at).getTime();
        const oe = o.ends_at ? new Date(o.ends_at).getTime() : os + 3600_000;
        return os < (end ?? start) && oe > start;
      })
      .slice(0, 3)
      .map((o: any) => ({ id: o.id, summary: o.summary ? openWith(dek, o.summary) : null, startsAt: new Date(o.starts_at).toISOString() }));

    return {
      id: r.id,
      uid: r.uid ? openWith(dek, r.uid) : null,
      summary: r.summary ? openWith(dek, r.summary) : null,
      location: r.location ? openWith(dek, r.location) : null,
      description: r.description ? openWith(dek, r.description) : null,
      organizer: parse<{ email: string; name: string | null } | null>(r.organizer, null),
      attendees: parse<{ email: string; name: string | null; partstat: string | null }[]>(r.attendees, []),
      startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
      endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
      allDay: r.all_day,
      method: r.method,
      sequence: r.sequence,
      reply: r.reply,
      recurrence: null,
      approximate: false,
      accountId: r.account_id,
      emailId: r.email_id,
      clashes,
    };
  });
}

// ---------- Replying ----------

// The REPLY body an organiser's client expects. Built here rather than in
// the composer because it has to echo the UID and SEQUENCE it is answering.
export function buildReply(inv: Invitation, me: { email: string; name: string | null }, partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (line: string) => (line.length <= 74 ? line : line.match(/.{1,74}/g)!.join('\r\n '));
  const esc = (v: string) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tern//EN',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${esc(inv.uid ?? '')}`,
    `DTSTAMP:${stamp}`,
    `SEQUENCE:${inv.sequence}`,
    inv.summary ? `SUMMARY:${esc(inv.summary)}` : null,
    inv.organizer ? `ORGANIZER:mailto:${inv.organizer.email}` : null,
    `ATTENDEE;PARTSTAT=${partstat}${me.name ? `;CN=${esc(me.name)}` : ''}:mailto:${me.email}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean) as string[];
  return lines.map(fold).join('\r\n');
}

export async function recordReply(userId: number, id: number, reply: 'accepted' | 'declined' | 'tentative'): Promise<Invitation | null> {
  const rows = await query<any>(
    'UPDATE calendar_events SET reply=$3 WHERE id=$1 AND user_id=$2 RETURNING *',
    [id, userId, reply],
  );
  if (!rows.length) return null;
  return (await openAll(userId, rows))[0] ?? null;
}

export async function getInvitation(userId: number, id: number): Promise<Invitation | null> {
  const rows = await query<any>('SELECT * FROM calendar_events WHERE id=$1 AND user_id=$2', [id, userId]);
  return (await openAll(userId, rows))[0] ?? null;
}

// ---------- Proposing times ----------

// Free slots in working hours over the next fortnight, worked out from what
// is already in the calendar table. Deterministic: no model is involved in
// deciding when somebody is free, because being wrong about that is a missed
// meeting rather than an awkward sentence.
export interface Slot { startsAt: string; endsAt: string }

export async function freeSlots(userId: number, opts: { minutes?: number; days?: number; count?: number; startHour?: number; endHour?: number } = {}): Promise<Slot[]> {
  const minutes = Math.min(480, Math.max(15, opts.minutes ?? 30));
  const days = Math.min(30, Math.max(1, opts.days ?? 10));
  const startHour = opts.startHour ?? 9;
  const endHour = opts.endHour ?? 17;
  const busy = await query<{ starts_at: Date; ends_at: Date | null }>(
    `SELECT starts_at, ends_at FROM calendar_events
      WHERE user_id=$1 AND starts_at IS NOT NULL AND reply IS DISTINCT FROM 'declined'
        AND starts_at < now() + ($2 || ' days')::interval AND starts_at > now() - interval '1 day'`,
    [userId, days],
  );
  const blocks = busy.map((b) => ({
    from: new Date(b.starts_at).getTime(),
    to: b.ends_at ? new Date(b.ends_at).getTime() : new Date(b.starts_at).getTime() + 3600_000,
  }));

  const out: Slot[] = [];
  const step = minutes * 60_000;
  const now = Date.now();
  for (let d = 0; d < days && out.length < (opts.count ?? 6); d++) {
    const day = new Date(now + d * 86_400_000);
    // Weekends are not offered by default. Somebody who wants them can pick
    // a time by hand; suggesting them is a different kind of rudeness.
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let hour = startHour; hour < endHour && out.length < (opts.count ?? 6); hour++) {
      const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0);
      if (start < now + 3600_000) continue; // never propose the next hour
      const end = start + step;
      if (blocks.some((b) => b.from < end && b.to > start)) continue;
      out.push({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
    }
  }
  return out;
}
