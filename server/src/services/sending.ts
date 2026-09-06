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
  if (used >= acc.daily_cap) return { reason: 'cap', retryAt: nextDayWindow(acc, now) };
  return null;
}

// Decide whether an automated send may go out now, and if so claim the slot
// by pushing next_send_at forward with fresh jitter. Uses a row lock so two
// scheduler ticks cannot both claim the same gap.
export async function reserveSendSlot(acc: AccountRow): Promise<SlotResult> {
  if (!acc.enabled) return { ok: false, reason: 'disabled', retryAt: new Date(Date.now() + 3600_000) };
  const now = new Date();
  if (!isWindowOpen(acc.send_window, now)) return { ok: false, reason: 'window', retryAt: nextWindowOpen(acc.send_window, now) };
  const used = await sentToday(acc);
  if (used >= acc.daily_cap) return { ok: false, reason: 'cap', retryAt: nextDayWindow(acc, now) };
  const row = await one<{ next_send_at: Date | null }>(`SELECT next_send_at FROM accounts WHERE id=$1 FOR UPDATE`, [acc.id]);
  const gate = row?.next_send_at ? new Date(row.next_send_at) : null;
  if (gate && gate.getTime() > now.getTime()) return { ok: false, reason: 'gap', retryAt: gate };
  const wait = jitterMs(acc);
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
