// Web Push for new mail. Browsers subscribe through the service worker; the
// sync worker calls notifyNewMail after each batch of fresh inbound mail.
// VAPID keys are generated once and kept in the settings table. Payloads
// carry only sender, subject and a link: mail bodies never leave the server.
import webpush from 'web-push';
import { one, query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { mailboxByRole } from '../jmap/actions.js';
import type { AccountRow } from './accounts.js';
import { assertPublicUrl } from '../util/netguard.js';
import { badRequest } from '../errors.js';

const log = logger('push');

interface VapidKeys { publicKey: string; privateKey: string }
let cached: VapidKeys | null = null;

export async function vapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  const row = await one<{ value: VapidKeys }>(`SELECT value FROM settings WHERE key='push_vapid'`);
  if (row?.value?.publicKey && row.value.privateKey) { cached = row.value; return cached; }
  const fresh = webpush.generateVAPIDKeys();
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ('push_vapid', $1, now()) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(fresh)]);
  const saved = await one<{ value: VapidKeys }>(`SELECT value FROM settings WHERE key='push_vapid'`);
  cached = saved?.value ?? fresh;
  return cached;
}

// Push services want a contact for the sender: the app's https URL, or a mailto.
function subject(): string {
  return config.appUrl.startsWith('https://') ? config.appUrl : 'mailto:postmaster@localhost';
}

export interface SubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }

export async function subscribe(userId: number, sub: SubscriptionInput, userAgent: string | null): Promise<void> {
  // The endpoint is where this server will POST later; it has to be a
  // browser vendor's push service, never something on the local network.
  const u = await assertPublicUrl(sub.endpoint, { what: 'The push endpoint' });
  if (u.protocol !== 'https:') throw badRequest('Push endpoints must use https');
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, failures=0`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent],
  );
}

export async function unsubscribe(userId: number, endpoint: string): Promise<void> {
  await query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [userId, endpoint]);
}

export async function subscriptionCount(userId: number): Promise<number> {
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [userId]);
  return r?.n ?? 0;
}

export interface PushPayload { title: string; body: string; url: string; tag: string }

export async function notifyUser(userId: number, payload: PushPayload): Promise<number> {
  const subs = await query<{ id: number; endpoint: string; p256dh: string; auth: string; failures: number }>('SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id=$1', [userId]);
  if (!subs.length) return 0;
  const keys = await vapidKeys();
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600, urgency: 'normal' });
      sent++;
      await query('UPDATE push_subscriptions SET last_used_at=now(), failures=0 WHERE id=$1', [s.id]);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 0);
      if (status === 404 || status === 410 || s.failures >= 4) {
        await query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
        log.info('push subscription dropped', { status, endpoint: s.endpoint.slice(0, 60) });
      } else {
        await query('UPDATE push_subscriptions SET failures=failures+1 WHERE id=$1', [s.id]);
        log.warn('push failed', { status, err: e?.message });
      }
    }
  }
  return sent;
}

const display = (a: any) => (a?.name ? String(a.name) : String(a?.email ?? 'Unknown sender'));

// Called by the sync worker with the raw JMAP Email objects it just inserted.
// Only unread inbound mail in the Inbox counts: nothing sent by the account
// itself, nothing already read elsewhere, no drafts, and nothing during the
// initial sync (the caller skips that).
export async function notifyNewMail(acc: AccountRow, emails: any[]): Promise<void> {
  if (!emails.length) return;
  if ((await subscriptionCount(acc.user_id)) === 0) return;
  const inbox = await mailboxByRole(acc.id, 'inbox');
  const own = acc.email.toLowerCase();
  const fresh = emails.filter((e) => {
    const from = String(e.from?.[0]?.email ?? '').toLowerCase();
    if (!from || from === own) return false;
    if (e.keywords?.$seen || e.keywords?.$draft) return false;
    if (inbox && !e.mailboxIds?.[inbox.jmap_id]) return false;
    return true;
  });
  if (!fresh.length) return;
  if (fresh.length <= 3) {
    for (const e of fresh) {
      const threadKey = `${acc.id}:${e.threadId ?? e.id}`;
      await notifyUser(acc.user_id, { title: display(e.from?.[0]), body: String(e.subject || e.preview || '(no subject)').slice(0, 140), url: `/mail/inbox/t/${threadKey}`, tag: `mail-${threadKey}` });
    }
    return;
  }
  const senders = [...new Set(fresh.map((e) => display(e.from?.[0])))];
  await notifyUser(acc.user_id, { title: `${fresh.length} new messages`, body: senders.slice(0, 4).join(', ') + (senders.length > 4 ? ` and ${senders.length - 4} more` : ''), url: '/mail/inbox', tag: `mail-batch-${acc.id}` });
}

// ---------- Outreach ----------
//
// Push has only ever been for new mail, which is the event that matters least:
// mail arrives all day and the app is already showing it. These three are the
// ones worth a phone buzz because each of them is a thing that has stopped, or
// is about to stop, and none of them recovers on its own.
//
// Nothing here carries a message body. Same rule as new mail: a notification
// says what happened and where to look, and the content stays on the server.

/**
 * Somebody said yes.
 *
 * The single most time-sensitive event the app has. A reply saying "yes, can
 * we talk Tuesday" answered on Wednesday is a different outcome from the same
 * reply answered in ten minutes, and the whole point of classifying replies is
 * to be able to tell this one apart from the four that can wait.
 */
export async function notifyInterestedReply(userId: number, from: { name?: string | null; email: string }, campaign: string): Promise<void> {
  if ((await subscriptionCount(userId)) === 0) return;
  const who = from.name?.trim() || from.email;
  await notifyUser(userId, {
    title: `${who} is interested`,
    body: `Replied to ${campaign}`.slice(0, 140),
    url: '/sequences/replies',
    // Per person, so two replies from the same address collapse and two
    // different people do not.
    tag: `reply-interested-${userId}-${from.email.toLowerCase()}`,
  });
}

/**
 * A campaign stopped itself.
 *
 * Carries the reason rather than the fact, because "paused" is not actionable
 * and "there is no ask in the brief" is: the notification is the whole of the
 * message for somebody who is not at their desk.
 */
export async function notifyCampaignPaused(userId: number, sequenceId: number, name: string, reason: string): Promise<void> {
  if ((await subscriptionCount(userId)) === 0) return;
  await notifyUser(userId, {
    title: `${name} paused`,
    body: reason.slice(0, 140),
    url: `/sequences/${sequenceId}`,
    // One per campaign: a campaign cannot pause twice without being resumed
    // in between, and if it does the second notice replaces the first.
    tag: `campaign-paused-${sequenceId}`,
  });
}

// Who has already been told their queue is long. A queue that grows from 20 to
// 500 is one event, not 480 of them, so the notice fires on the way past the
// threshold and re-arms only once the queue has been brought back under it.
//
// In memory because the process is single by design — the event bus makes the
// same assumption — and because the worst case of losing it on restart is one
// extra notification.
const backlogNotified = new Set<number>();

/** How many drafts waiting is too many to still be a queue rather than a pile. */
export const QUEUE_BACKLOG = 20;

/**
 * The review queue got long.
 *
 * A queue is a promise to look at something. Past twenty it stops being one,
 * and the drafts at the bottom are being held for a campaign whose brief
 * probably has the same problem in it twenty times.
 */
export async function notifyQueueBacklog(userId: number, pending: number): Promise<void> {
  if (pending < QUEUE_BACKLOG) { backlogNotified.delete(userId); return; }
  if (backlogNotified.has(userId)) return;
  backlogNotified.add(userId);
  if ((await subscriptionCount(userId)) === 0) return;
  await notifyUser(userId, {
    title: `${pending} drafts waiting`,
    body: 'The review queue is getting long.',
    url: '/review',
    tag: `queue-backlog-${userId}`,
  });
}
