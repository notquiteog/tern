// Sending policy per account: daily cap, send window in the account's
// timezone, and the randomized gap between consecutive sends. The scheduler
// and "send later" both reserve a slot here so a person composing by hand
// and a sequence firing in the background never exceed the cap together.
import { one, query } from '../db.js';
import type { AccountRow, SendWindow } from './accounts.js';

function partsInTz(date: Date, tz: string): { weekday: number; hour: number; minute: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false });
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { weekday: days.indexOf(parts.weekday), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export function isWindowOpen(w: SendWindow, at: Date = new Date()): boolean {
  if (!w || w.start === undefined || w.end === undefined) return true;
  const p = partsInTz(at, w.tz || 'UTC');
  const days = w.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(p.weekday)) return false;
  const minutes = p.hour * 60 + p.minute;
  const start = w.start * 60, end = w.end * 60;
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// First instant at or after `from` when the window is open. Steps in
// 5-minute increments for up to 8 days; coarse, but a window is defined in
// whole hours so nothing is lost.
export function nextWindowOpen(w: SendWindow, from: Date = new Date()): Date {
  if (isWindowOpen(w, from)) return from;
  const step = 5 * 60_000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < (8 * 24 * 60) / 5; i++) {
    if (isWindowOpen(w, t)) return t;
    t = new Date(t.getTime() + step);
  }
  return t;
}

/**
 * The cap that actually applies today.
 *
 * A new mailbox sending forty cold emails on its first morning is the single
 * most reliable way to get a domain filtered, which is why the README tells
 * people to start at twenty and build up. This turns that paragraph into
 * arithmetic: `start + step × whole days since the ramp began`, never above
 * the cap that was configured.
 *
 * Whole days, counted in the window's own timezone, so the cap changes
 * overnight rather than at whatever hour the ramp happened to be switched on
 * — a cap that went up mid-morning would be indistinguishable from a bug.
 */
export function effectiveCap(acc: Pick<AccountRow, 'daily_cap' | 'send_window' | 'warmup_enabled' | 'warmup_started_at' | 'warmup_start_cap' | 'warmup_step'>, now: Date = new Date()): number {
  if (!acc.warmup_enabled || !acc.warmup_started_at) return acc.daily_cap;
  const tz = acc.send_window?.tz || 'UTC';
  const days = wholeDaysBetween(new Date(acc.warmup_started_at), now, tz);
  const ramped = Math.max(1, acc.warmup_start_cap) + Math.max(0, acc.warmup_step) * Math.max(0, days);
  // The configured cap is the ceiling, not a suggestion: a ramp cannot raise
  // an account above the limit its owner set for it.
  return Math.max(1, Math.min(acc.daily_cap, ramped));
}

// Calendar days apart in a timezone, which is not the same as elapsed
// milliseconds divided by a day: a ramp started at 23:00 is on its second day
// an hour later, and that is the answer somebody reading "day 2 of 14" means.
function wholeDaysBetween(from: Date, to: Date, tz: string): number {
  const day = (d: Date) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
    catch { return d.toISOString().slice(0, 10); }
  };
  const a = Date.parse(`${day(from)}T00:00:00Z`);
  const b = Date.parse(`${day(to)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Where a ramp has got to, for the account card to draw. */
export function warmupProgress(acc: Pick<AccountRow, 'daily_cap' | 'send_window' | 'warmup_enabled' | 'warmup_started_at' | 'warmup_start_cap' | 'warmup_step'>, now: Date = new Date()): { day: number; cap: number; done: boolean } | null {
  if (!acc.warmup_enabled || !acc.warmup_started_at) return null;
  const cap = effectiveCap(acc, now);
  const day = wholeDaysBetween(new Date(acc.warmup_started_at), now, acc.send_window?.tz || 'UTC') + 1;
  return { day, cap, done: cap >= acc.daily_cap };
}

/**
 * Is it a reasonable hour where *they* are?
 *
 * The account's send window is the sender's working day. Applied to a list
 * that spans eight timezones it means a campaign run from London lands in
 * California at two in the morning: inside the window it was told about, and
 * nowhere near the window it was meant for.
 *
 * The hours are the account's own — somebody who chose 9 to 17 meant "office
 * hours", and that is as true in Los Angeles as in London — read against the
 * contact's clock instead of the sender's. The days are deliberately not
 * re-checked: a Friday send that is still Thursday evening for the recipient
 * is fine, and refusing it would strand contacts a day behind the rest of the
 * campaign for no benefit.
 */
export function contactWindowOpen(w: SendWindow, tz: string | null | undefined, at: Date = new Date()): boolean {
  if (!tz) return true; // Nothing known about them: the account's own window stands.
  return isWindowOpen({ ...w, tz, days: [0, 1, 2, 3, 4, 5, 6] }, at);
}

/** The next moment the contact's own local window opens. */
export function nextContactWindow(w: SendWindow, tz: string | null | undefined, from: Date = new Date()): Date {
  if (!tz) return from;
  return nextWindowOpen({ ...w, tz, days: [0, 1, 2, 3, 4, 5, 6] }, from);
}

export function jitterMs(acc: Pick<AccountRow, 'jitter_enabled' | 'jitter_min_s' | 'jitter_max_s'>): number {
  if (!acc.jitter_enabled) return 0;
  const min = Math.max(0, acc.jitter_min_s), max = Math.max(min, acc.jitter_max_s);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

function dayStartSql(tz: string): string {
  return `(date_trunc('day', now() AT TIME ZONE '${tz.replace(/[^A-Za-z0-9_+\-/]/g, '')}') AT TIME ZONE '${tz.replace(/[^A-Za-z0-9_+\-/]/g, '')}')`;
}

export async function sentToday(acc: AccountRow): Promise<number> {
  const tz = acc.send_window?.tz || 'UTC';
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM send_log WHERE account_id=$1 AND status='sent' AND sent_at >= ${dayStartSql(tz)}`, [acc.id]);
  return r?.n ?? 0;
}

export type SlotResult = { ok: true; waitMs: number } | { ok: false; reason: 'cap' | 'window' | 'gap' | 'disabled'; retryAt: Date };

// The same daily cap and send window `reserveSendSlot` enforces, asked
// without claiming anything. It is for work that is expensive to prepare —
// a personalised email a model has to write — so that work is not done for
// a message the account could not send today anyway. The per-send gap is
// deliberately not checked: it is seconds, and it will have passed by the
// time the message is ready.
export async function sendingBlocked(acc: AccountRow): Promise<{ reason: 'cap' | 'window' | 'disabled'; retryAt: Date } | null> {
  if (!acc.enabled) return { reason: 'disabled', retryAt: new Date(Date.now() + 3600_000) };
  const now = new Date();
  if (!isWindowOpen(acc.send_window, now)) return { reason: 'window', retryAt: nextWindowOpen(acc.send_window, now) };
  const used = await sentToday(acc);
  if (used >= effectiveCap(acc, now)) return { reason: 'cap', retryAt: nextDayWindow(acc, now) };
  return null;
}

// Decide whether an automated send may go out now, and if so claim the slot
// by pushing next_send_at forward with fresh jitter. Uses a row lock so two
// scheduler ticks cannot both claim the same gap.
// `jitter: false` asks for the limits without the delay. The daily cap and
// the send window are limits on automated mail and are not negotiable by the
// caller; the random gap is the part a responder may reasonably turn off,
// and turning it off must not also turn off the cap.
export async function reserveSendSlot(acc: AccountRow, opts: { jitter?: boolean } = {}): Promise<SlotResult> {
  if (!acc.enabled) return { ok: false, reason: 'disabled', retryAt: new Date(Date.now() + 3600_000) };
  const now = new Date();
  if (!isWindowOpen(acc.send_window, now)) return { ok: false, reason: 'window', retryAt: nextWindowOpen(acc.send_window, now) };
  const used = await sentToday(acc);
  if (used >= effectiveCap(acc, now)) return { ok: false, reason: 'cap', retryAt: nextDayWindow(acc, now) };
  const row = await one<{ next_send_at: Date | null }>(`SELECT next_send_at FROM accounts WHERE id=$1 FOR UPDATE`, [acc.id]);
  const gate = row?.next_send_at ? new Date(row.next_send_at) : null;
  if (gate && gate.getTime() > now.getTime()) return { ok: false, reason: 'gap', retryAt: gate };
  const wait = opts.jitter === false ? 0 : jitterMs(acc);
  await query(`UPDATE accounts SET next_send_at = now() + ($2 || ' milliseconds')::interval WHERE id=$1`, [acc.id, String(wait)]);
  return { ok: true, waitMs: wait };
}

// When the cap is spent: the next window start that is actually a later
// local day, not the same one an hour on.
function nextDayWindow(acc: AccountRow, now: Date): Date {
  let t = nextWindowOpen(acc.send_window, new Date(now.getTime() + 60 * 60_000));
  for (let i = 0; i < 48 && partsInTz(t, acc.send_window.tz).hour === partsInTz(now, acc.send_window.tz).hour && t.getTime() - now.getTime() < 3600_000; i++) {
    t = nextWindowOpen(acc.send_window, new Date(t.getTime() + 60 * 60_000));
  }
  return t;
}

export function describeWindow(w: SendWindow): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = (w.days ?? []).map((i) => days[i]).join(', ') || 'every day';
  return `${String(w.start).padStart(2, '0')}:00-${String(w.end).padStart(2, '0')}:00 ${w.tz} on ${d}`;
}
