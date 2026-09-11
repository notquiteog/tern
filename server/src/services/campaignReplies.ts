// The replies a campaign got, and what to do about each one.
//
// `reply_intent` has been written onto every answered send since the
// classifier shipped, and until now nothing read it. A label nobody can see is
// a column, not a feature: the work of deciding that "not the right person,
// try Priya" is a different thing from "yes, next Tuesday" was already being
// done and then thrown away, leaving both in the same undifferentiated pile
// the classifier exists to break up.
//
// ── Why the next action is decided here ─────────────────────────────────────
//
// Each intent has one obvious thing to do next, and it is the same thing
// whether the person is looking at the Replies tab, asking the assistant, or
// reading the morning brief. Deciding it in one place means those three can
// never disagree about what "interested" leads to, and means a new intent
// cannot be added without somebody having to say what it leads to.
//
// ── Why it is a queue and not a report ──────────────────────────────────────
//
// "Three interested" is three people to write to. A report would still say
// three tomorrow, after all three had been answered, so every row carries
// whether it has been dealt with and the counts are of what is left.
import { query } from '../db.js';
import { dataKey } from './vault.js';
import { openEmailWith } from './mailVault.js';
import { htmlToText } from './merge.js';
import { parseReferral, type Referral } from './referral.js';
import { isReplyIntent, ROUTE_OF, type ReplyIntent, type ReplyRoute } from './replyIntent.js';

/**
 * What the tab offers on a reply, and what the assistant would propose for it.
 *
 * `kind` is what the button does; everything else is the argument it needs.
 * Nothing here sends anything — every one of these opens something a person
 * then approves, which is the same rule the rest of the campaign path follows.
 */
export type ReplyActionKind = 'reply' | 'referral' | 'reenroll' | 'open' | 'none';

export interface ReplyAction {
  kind: ReplyActionKind;
  label: string;
  /** Open the composer on the thread with an AI reply already asked for. */
  aiReply?: boolean;
  /**
   * Offer the times chip. Deliberately keyed on the intent rather than on the
   * message mentioning a date: somebody who says "yes, let's talk" wants a
   * time whether or not they thought to ask for one, and offering slots in a
   * mass first send would hand the same three to two hundred people.
   */
  proposeTimes?: boolean;
  /** Answer from the campaign's own brief rather than from nothing. */
  fromBrief?: boolean;
  /** Who they pointed at, for `wrong_person`. Never acted on without a person. */
  referrals?: Referral[];
  /** How long "later" is, for `not_now`. */
  reenrollDays?: number;
}

// Six weeks. Long enough that "not now" has actually become "now", short
// enough that the campaign is still a thing the person remembers agreeing to
// hear about. A number rather than a setting because nobody has ever had an
// informed opinion about whether it should be five.
export const REENROLL_DAYS = 42;

export function actionFor(intent: ReplyIntent, referrals: Referral[] = []): ReplyAction {
  switch (intent) {
    case 'interested':
      return { kind: 'reply', label: 'Reply and offer times', aiReply: true, proposeTimes: true };
    case 'question':
      // The brief is the only place the answer to "does it do X" is written
      // down, and it is already on the sequence.
      return { kind: 'reply', label: 'Draft an answer from the brief', aiReply: true, fromBrief: true };
    case 'wrong_person':
      return referrals.length
        ? { kind: 'referral', label: referrals[0]!.email ? 'Add them and enroll' : 'Add the person they named', referrals }
        : { kind: 'open', label: 'Read it — they named nobody' };
    case 'not_now':
      return { kind: 'reenroll', label: `Re-enroll in ${Math.round(REENROLL_DAYS / 7)} weeks`, reenrollDays: REENROLL_DAYS };
    case 'not_interested':
      // The sequence has already stopped. Offering to write again to somebody
      // who just declined is how a sending domain gets itself blocked.
      return { kind: 'none', label: 'Stopped — nothing to do' };
    case 'stop':
      return { kind: 'none', label: 'Unsubscribed and suppressed' };
    case 'auto_reply':
      return { kind: 'none', label: 'Automatic reply' };
    default:
      return { kind: 'open', label: 'Read it' };
  }
}

export interface CampaignReply {
  logId: number;
  sequenceId: number | null;
  sequenceName: string;
  stepId: number | null;
  stepPosition: number | null;
  accountId: number;
  contact: { id: number; email: string; first_name: string; last_name: string; company: string; title: string } | null;
  intent: ReplyIntent;
  route: ReplyRoute;
  repliedAt: string;
  handledAt: string | null;
  /** How the mail app addresses a thread: account and thread together. */
  threadKey: string | null;
  threadId: string | null;
  subject: string;
  preview: string;
  action: ReplyAction;
}

export interface ReplyFilter {
  sequenceId?: number;
  intent?: ReplyIntent;
  /** One row, whatever state it is in. Set by `getReply`. */
  logId?: number;
  /** Default is the queue: what has not been dealt with. */
  handled?: boolean;
  limit?: number;
  offset?: number;
}

// The reply itself, not the send that provoked it.
//
// `replied_at` is stamped when the sync worker notices the answer, a moment
// after it arrived, so the newest message in the thread at or before that
// instant is the reply. Matching on the sender's address instead is not
// possible by design: addresses are sealed and there is no plaintext column
// left to join on.
const REPLY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT em.subject, em.preview, em.body_text, em.body_html, em.from_addr
      FROM emails em
     WHERE em.account_id = l.account_id AND em.thread_id = l.thread_id
       AND em.received_at <= l.replied_at
     ORDER BY em.received_at DESC
     LIMIT 1
  ) r ON true`;

export async function listReplies(userId: number, f: ReplyFilter = {}): Promise<CampaignReply[]> {
  const params: unknown[] = [userId];
  const where = ['l.user_id=$1', 'l.reply_intent IS NOT NULL', 'l.replied_at IS NOT NULL'];
  if (f.sequenceId) { params.push(f.sequenceId); where.push(`l.sequence_id=$${params.length}`); }
  if (f.intent) { params.push(f.intent); where.push(`l.reply_intent=$${params.length}`); }
  // Asking for one row by id means asking for that row, not for that row if
  // it happens still to be outstanding.
  if (f.logId) params.push(f.logId), where.push(`l.id=$${params.length}`);
  else where.push(f.handled ? 'l.reply_handled_at IS NOT NULL' : 'l.reply_handled_at IS NULL');
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);

  const rows = await query<any>(
    `SELECT l.id, l.sequence_id, l.step_id, l.account_id, l.thread_id, l.reply_intent, l.replied_at, l.reply_handled_at,
            l.subject AS sent_subject,
            s.name AS sequence_name, st.position AS step_position,
            c.id AS contact_id, c.email AS contact_email, c.first_name, c.last_name, c.company, c.title,
            r.subject AS reply_subject, r.preview AS reply_preview, r.body_text, r.body_html, r.from_addr
       FROM send_log l
       LEFT JOIN sequences s ON s.id=l.sequence_id
       LEFT JOIN sequence_steps st ON st.id=l.step_id
       LEFT JOIN contacts c ON c.id=l.contact_id
       ${REPLY_JOIN}
      WHERE ${where.join(' AND ')}
      ORDER BY l.replied_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  if (!rows.length) return [];

  // The owner reading their own campaign's replies. No capability is involved:
  // this is their mail, in their app, because they asked for it.
  const dek = await dataKey(userId);
  // Every address this install sends from, so a reply quoting our own footer
  // never offers to add us to our own address book.
  const ours = new Set(
    (await query<{ email: string }>('SELECT email FROM accounts WHERE user_id=$1', [userId]))
      .map((a) => a.email.toLowerCase()),
  );

  return rows.map((row) => {
    const opened = openEmailWith(dek, {
      subject: row.reply_subject, preview: row.reply_preview,
      body_text: row.body_text, body_html: row.body_html, from_addr: row.from_addr,
    });
    const intent: ReplyIntent = isReplyIntent(row.reply_intent) ? row.reply_intent : 'unclear';
    // Only `wrong_person` is parsed for a handover. Reading every reply for
    // addresses would find one in most signatures and turn a decline into an
    // invitation to write to somebody else at the same company.
    const referrals = intent === 'wrong_person'
      ? parseReferral(opened.body_text || htmlToText(opened.body_html ?? ''), {
        exclude: [...ours, row.contact_email, opened.from_addr?.[0]?.email],
      })
      : [];
    return {
      logId: Number(row.id),
      sequenceId: row.sequence_id === null ? null : Number(row.sequence_id),
      sequenceName: row.sequence_name ?? 'Deleted campaign',
      stepId: row.step_id === null ? null : Number(row.step_id),
      stepPosition: row.step_position === null || row.step_position === undefined ? null : Number(row.step_position),
      accountId: Number(row.account_id),
      contact: row.contact_id
        ? {
          id: Number(row.contact_id), email: row.contact_email, first_name: row.first_name ?? '',
          last_name: row.last_name ?? '', company: row.company ?? '', title: row.title ?? '',
        }
        : null,
      intent,
      route: ROUTE_OF[intent],
      repliedAt: new Date(row.replied_at).toISOString(),
      handledAt: row.reply_handled_at ? new Date(row.reply_handled_at).toISOString() : null,
      threadKey: row.thread_id ? `${row.account_id}:${row.thread_id}` : null,
      threadId: row.thread_id ?? null,
      // The reply's own subject where there is one; the send's otherwise, so a
      // row is never blank because the thread has been emptied since.
      subject: opened.subject || row.sent_subject || '(no subject)',
      preview: (opened.preview || '').slice(0, 240),
      action: actionFor(intent, referrals),
    };
  });
}

export type ReplyCounts = Record<ReplyIntent, number> & { total: number };

/**
 * How many replies of each kind are still waiting.
 *
 * Of what is left, never of what arrived: a campaign whose replies have all
 * been answered says nothing rather than still claiming three interested.
 */
export async function replyCounts(userId: number, sequenceId?: number): Promise<ReplyCounts> {
  const params: unknown[] = [userId];
  let filter = '';
  if (sequenceId) { params.push(sequenceId); filter = ` AND sequence_id=$${params.length}`; }
  const rows = await query<{ reply_intent: string; n: number }>(
    `SELECT reply_intent, count(*)::int AS n FROM send_log
      WHERE user_id=$1 AND reply_intent IS NOT NULL AND reply_handled_at IS NULL${filter}
      GROUP BY reply_intent`,
    params,
  );
  const out = {
    stop: 0, auto_reply: 0, interested: 0, question: 0, not_now: 0,
    not_interested: 0, wrong_person: 0, unclear: 0, total: 0,
  } as ReplyCounts;
  for (const r of rows) {
    if (!isReplyIntent(r.reply_intent)) continue;
    out[r.reply_intent] = r.n;
    out.total += r.n;
  }
  return out;
}

/**
 * One reply, with the ownership check the routes would otherwise each repeat.
 *
 * The `user_id=$1` in the list's own WHERE clause is what makes this safe to
 * call with an id straight off a request.
 */
export async function getReply(userId: number, logId: number): Promise<CampaignReply | null> {
  const [row] = await listReplies(userId, { logId, limit: 1 });
  return row ?? null;
}

export async function markHandled(userId: number, logId: number, handled: boolean): Promise<void> {
  await query(
    `UPDATE send_log SET reply_handled_at=${handled ? 'now()' : 'NULL'} WHERE id=$1 AND user_id=$2 AND reply_intent IS NOT NULL`,
    [logId, userId],
  );
}
