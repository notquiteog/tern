// Telling the guests (F13).
//
// Creating an event with people on it and never writing to them is the gap
// between "a calendar" and "a calendar that works": everywhere else, adding
// somebody to a meeting sends them an invitation they can accept. So this
// builds the three messages the iTIP scheduling model (RFC 5546) is made of
// and sends them down the ordinary path — which means they inherit the
// account's signature, its sending window, its pacing and its log, exactly
// like any other message.
//
// What it deliberately does not do is implement a scheduling server. Tern
// sends REQUEST, CANCEL and REPLY, and reads the REPLYs that come back
// through the mail (F10). It does not maintain anybody else's attendee list,
// and it does not speak CalDAV scheduling — a server that does its own
// scheduling will send its own invitations when the event is pushed to it,
// which is why sending from here is a choice the person makes per save
// rather than something that happens by itself.
import { logger } from '../../log.js';
import { listAccounts, getAccount, type AccountRow } from '../accounts.js';
import { composeAndSend } from '../compose.js';
import { writeCalendar, type VEvent } from './vevent.js';
import type { Calendar } from './store.js';

const log = logger('calendar-invite');

export type ItipMethod = 'REQUEST' | 'CANCEL' | 'REPLY';

// The account an invitation goes out from.
//
// The organiser's own address where one of the person's accounts matches it,
// because an invitation from a different address than the ORGANIZER line is
// rejected or quietly ignored by strict clients. Otherwise their first
// enabled account, which is the same rule the composer uses.
export async function organiserAccount(userId: number, organiserEmail?: string | null): Promise<AccountRow | null> {
  const accounts = await listAccounts(userId);
  const enabled = accounts.filter((a) => a.enabled);
  if (!enabled.length) return null;
  const wanted = String(organiserEmail ?? '').toLowerCase();
  const match = enabled.find((a) => String(a.email).toLowerCase() === wanted);
  return getAccount(match?.id ?? enabled[0].id);
}

function when(e: VEvent): string {
  if (!e.start) return '';
  const zone = e.start.tzid ?? 'UTC';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(e.start.at);
  if (e.start.allDay) return day;
  const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const tail = e.end ? `${hm(e.start.at)}–${hm(e.end.at)}` : hm(e.start.at);
  return `${day}, ${tail}${e.start.tzid ? ` (${e.start.tzid})` : ' UTC'}`;
}

const escapeHtml = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function body(e: VEvent, method: ItipMethod, organiserName: string): { subject: string; html: string; text: string } {
  const title = e.summary ?? 'Untitled event';
  const prefix = method === 'CANCEL' ? 'Cancelled: ' : method === 'REPLY' ? '' : '';
  const lines: [string, string][] = [['When', when(e)]];
  if (e.location) lines.push(['Where', e.location]);
  if (e.rrule) lines.push(['Repeats', 'yes — see the attached invitation for the full series']);
  if (e.attendees.length) lines.push(['Guests', e.attendees.map((a) => a.name || a.email).slice(0, 20).join(', ')]);

  const lead = method === 'CANCEL'
    ? `${organiserName} has cancelled this event.`
    : `${organiserName} has invited you to this event.`;

  const html = [
    `<p>${escapeHtml(lead)}</p>`,
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">',
    ...lines.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`),
    '</table>',
    e.description ? `<p>${escapeHtml(e.description).replace(/\n/g, '<br>')}</p>` : '',
    // Said plainly, because the buttons only appear in some clients and a
    // person whose client does not draw them needs to know what to do.
    method === 'REQUEST' ? '<p style="color:#666;font-size:13px">Your mail app may offer Accept and Decline buttons. If it does not, open the attached invitation.</p>' : '',
  ].filter(Boolean).join('\n');

  const text = [lead, '', title, ...lines.map(([k, v]) => `${k}: ${v}`), '', e.description ?? ''].join('\n').trim();
  return { subject: `${prefix}${title}`, html, text };
}

export interface InviteResult { sent: string[]; failed: { email: string; error: string }[] }

/**
 * Send one iTIP message to the guests.
 *
 * Failures are collected rather than thrown: an invitation that could not
 * reach one of six people must not undo the event that was just saved, and
 * the caller reports which ones did not go.
 */
export async function sendItip(userId: number, opts: {
  event: VEvent;
  method: ItipMethod;
  calendar?: Calendar | null;
  /** Overrides the guest list, for a REPLY that goes only to the organiser. */
  to?: { email: string; name?: string | null }[];
}): Promise<InviteResult> {
  const out: InviteResult = { sent: [], failed: [] };
  const acc = await organiserAccount(userId, opts.event.organizer?.email);
  if (!acc) {
    out.failed.push({ email: '', error: 'No mail account is connected to send from' });
    return out;
  }
  const me = String(acc.email).toLowerCase();
  const recipients = (opts.to ?? opts.event.attendees.map((a) => ({ email: a.email, name: a.name })))
    .filter((a) => a.email && a.email.toLowerCase() !== me)
    .slice(0, 100);
  if (!recipients.length) return out;

  // The ORGANIZER is stated on the outgoing copy whatever the stored event
  // says, because it has to match the address this is sent from.
  const outgoing: VEvent = {
    ...opts.event,
    organizer: { email: acc.email, name: acc.name ?? null },
    attendees: opts.event.attendees.map((a) => ({ ...a })),
    // A cancellation says so in the event as well as in the method; clients
    // that only read one of the two still get it right.
    status: opts.method === 'CANCEL' ? 'CANCELLED' : opts.event.status ?? 'CONFIRMED',
    // An alarm is the sender's own reminder and is nobody else's business.
    alarms: [],
  };
  const ical = writeCalendar([outgoing], { method: opts.method });
  const { subject, html, text } = body(outgoing, opts.method, acc.name || acc.email);

  for (const r of recipients) {
    try {
      await composeAndSend(acc, {
        to: [{ name: r.name ?? null, email: r.email }],
        subject,
        html,
        text,
        kind: 'compose',
        includeSignature: false,
        calendar: { method: opts.method, ical },
      });
      out.sent.push(r.email);
    } catch (e) {
      out.failed.push({ email: r.email, error: (e as Error).message });
      log.warn('could not send an invitation', { to: r.email.slice(0, 60), method: opts.method, err: (e as Error).message });
    }
  }
  if (out.sent.length) log.info(`sent ${out.sent.length} ${opts.method.toLowerCase()}(s)`, { user: userId, calendar: opts.calendar?.id });
  return out;
}
