// Out-of-office auto-reply per mailbox. A fixed message a person wrote,
// sent once per sender per interval while the account's vacation window is
// on, to real correspondents only: never to lists, notifications, bounces,
// auto-submitted mail, or to the mailbox itself. Runs from the sync worker
// after each batch of new mail, after rules and responders.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { type AccountRow, vacationOf } from './accounts.js';
import { composeAndSend } from './compose.js';
import { textToHtml } from './merge.js';
import { replyRecipients, replySubject } from './reply.js';
import { isListMail } from './automation.js';

const log = logger('vacation');

// Today's date (YYYY-MM-DD) in the account's timezone, so a window that
// starts "Monday" starts on the person's Monday.
export function localDay(at: Date, tz: string): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  catch { return at.toISOString().slice(0, 10); }
}

export function vacationActive(acc: Pick<AccountRow, 'vacation' | 'send_window'>, at = new Date()): boolean {
  const v = vacationOf(acc);
  if (!v.enabled || !v.body.trim()) return false;
  const today = localDay(at, acc.send_window?.tz || 'UTC');
  if (v.start && today < v.start) return false;
  if (v.end && today > v.end) return false;
  return true;
}

const BOUNCE_RE = /mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce/i;

// Whether this inbound message deserves the auto-reply, and to whom.
export function vacationTarget(acc: AccountRow, e: any): { email: string; name: string | null } | null {
  const from = String(e.from?.[0]?.email ?? '').trim().toLowerCase();
  if (!from.includes('@') || from === acc.email.toLowerCase()) return null;
  if (BOUNCE_RE.test(from.split('@')[0] ?? '')) return null;
  if (isListMail(e)) return null;
  const auto = String(e['header:Auto-Submitted:asText'] ?? '').trim();
  if (auto && !/^no\b/i.test(auto)) return null;
  const r = replyRecipients({ from: e.from, replyTo: e.replyTo, to: e.to, cc: e.cc }, acc.email);
  const to = r.to[0];
  if (!to || to.email.toLowerCase() === acc.email.toLowerCase()) return null;
  return { email: to.email, name: to.name ?? null };
}

export async function maybeVacationReply(acc: AccountRow, e: any): Promise<boolean> {
  if (!vacationActive(acc)) return false;
  const v = vacationOf(acc);
  const target = vacationTarget(acc, e);
  if (!target) return false;
  if (v.onlyContacts) {
    const c = await one('SELECT 1 FROM contacts WHERE user_id=$1 AND lower(email)=$2', [acc.user_id, target.email.toLowerCase()]);
    if (!c) return false;
  }
  // Once per sender per interval; the claim is the insert itself, so two
  // syncs racing on the same sender still produce one reply.
  const claimed = await query(
    `INSERT INTO vacation_replies (account_id, email, sent_at) VALUES ($1, $2, now())
     ON CONFLICT (account_id, email) DO UPDATE SET sent_at = now() WHERE vacation_replies.sent_at < now() - ($3 || ' days')::interval
     RETURNING email`,
    [acc.id, target.email.toLowerCase(), String(v.intervalDays)],
  );
  if (!claimed.length) return false;
  try {
    await composeAndSend(acc, {
      to: [target],
      subject: v.subject.trim() || replySubject(e.subject),
      html: textToHtml(v.body),
      text: v.body,
      kind: 'auto_reply',
      replyToEmailId: e._id ?? null,
      includeSignature: true,
      reviewed: true,
      // Tells the other side's software this is automatic, so their own
      // auto-replies and list managers leave it alone.
      extraHeaders: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', Precedence: 'auto_reply' },
    });
    log.info('vacation reply sent', { account: acc.id });
    return true;
  } catch (err) {
    log.error('vacation reply failed', { account: acc.id, err: (err as Error).message });
    return false;
  }
}
