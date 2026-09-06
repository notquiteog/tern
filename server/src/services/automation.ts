// What happens when new mail arrives: reply and bounce detection for
// sequences, contact linking, "stop" handling, and inbox rules. Runs from the
// sync worker after each batch of freshly inserted messages.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { publish } from '../events.js';
import type { AccountRow } from './accounts.js';
import * as actions from '../jmap/actions.js';
import { autocryptHeadersOf, updatePeerFromMessage } from './autocrypt.js';
import { maybeVacationReply, vacationActive } from './vacation.js';

const log = logger('automation');

interface SendLogRow { id: number; user_id: number; account_id: number; contact_id: number | null; sequence_id: number | null; enrollment_id: number | null; message_id: string | null; to_email: string; thread_id: string | null }

const STOP_RE = /^\s*(?:please\s+)?(?:stop|unsubscribe|remove me|opt[\s-]?out|no thanks|not interested|do not (?:contact|email) me)\b/i;
const BOUNCE_FROM_RE = /mailer-daemon|postmaster|mail delivery|delivery status|no-?reply@.*\b(bounce|mailer)/i;
const BOUNCE_SUBJECT_RE = /undeliver|delivery (?:status|failure|has failed)|returned mail|failure notice|mail delivery failed|could not be delivered|delivery notification/i;

// Newsletters, notifications and other machine mail: never auto-answer these.
export function isListMail(e: any): boolean {
  if (e['header:List-Unsubscribe:asText'] || e['header:List-Id:asText'] || String(e['header:List-Id:asRaw'] ?? e['header:List-Id'] ?? '').trim()) return true;
  const prec = String(e['header:Precedence:asText'] ?? '').toLowerCase();
  if (/bulk|list|junk/.test(prec)) return true;
  const from = String(e.from?.[0]?.email ?? '').toLowerCase();
  return /^(no-?reply|do-?not-?reply|notifications?|noreply|newsletter|mailer-daemon|postmaster|bounce)/.test(from.split('@')[0] ?? '');
}

function firstLines(text: string | null, n = 6): string {
  if (!text) return '';
  return text.split('\n').filter((l) => !l.trim().startsWith('>')).slice(0, n).join('\n');
}

export async function onNewEmails(acc: AccountRow, fresh: any[]): Promise<void> {
  const own = acc.email.toLowerCase();
  const mailboxes = await query<{ jmap_id: string; role: string | null }>('SELECT jmap_id, role FROM mailboxes WHERE account_id=$1', [acc.id]);
  const roleOf = new Map(mailboxes.map((m) => [m.jmap_id, m.role]));
  const inboxId = mailboxes.find((m) => m.role === 'inbox')?.jmap_id;
  const rules = await query<any>(`SELECT * FROM rules WHERE user_id=$1 AND enabled AND (account_id IS NULL OR account_id=$2) ORDER BY position, id`, [acc.user_id, acc.id]);
  const responders = await query<any>(`SELECT * FROM responders WHERE user_id=$1 AND enabled AND (account_id IS NULL OR account_id=$2) ORDER BY position, id`, [acc.user_id, acc.id]);
  const muted = new Set((await query<{ thread_id: string }>('SELECT thread_id FROM muted_threads WHERE account_id=$1', [acc.id])).map((r) => r.thread_id));
  const vacationOn = vacationActive(acc);

  for (const e of fresh) {
    const fromEmail: string = (e.from?.[0]?.email ?? '').toLowerCase();
    const mailboxIds: string[] = Object.keys(e.mailboxIds ?? {});
    const roles = mailboxIds.map((m) => roleOf.get(m));
    const outbound = fromEmail === own || roles.includes('sent') || roles.includes('drafts');
    if (outbound) continue;
    // Autocrypt: every inbound message updates what we know about the sender's key (or that they have none).
    try { await updatePeerFromMessage(acc.user_id, fromEmail, autocryptHeadersOf(e), new Date(e.sentAt ?? e.receivedAt ?? Date.now())); } catch (err) { log.debug('autocrypt update failed', { err: (err as Error).message }); }
    // A muted conversation skips the inbox: new messages are filed straight
    // into the archive, and nobody is asked to answer them.
    if (muted.has(e.threadId) && inboxId && mailboxIds.includes(inboxId)) {
      try { await actions.archive(acc, [e.id]); log.info('muted thread archived', { account: acc.id, thread: e.threadId }); } catch (err) { log.error('mute archive failed', { err: (err as Error).message }); }
      continue;
    }
    const refs: string[] = [...(e.inReplyTo ?? []), ...(e.references ?? [])].map((r: string) => r.replace(/^<|>$/g, ''));
    const autoSubmitted: string | null = e['header:Auto-Submitted:asText'] ?? null;
    const isAuto = Boolean(autoSubmitted && !/^\s*no\b/i.test(autoSubmitted));
    const subject: string = e.subject ?? '';
    const text: string = e._text ?? e.preview ?? '';
    const bounceLike = BOUNCE_FROM_RE.test(fromEmail) || BOUNCE_SUBJECT_RE.test(subject);

    try {
      // Our own sent messages that this one references.
      let logs = refs.length ? await query<SendLogRow>(`SELECT * FROM send_log WHERE account_id=$1 AND status='sent' AND message_id = ANY($2)`, [acc.id, refs]) : [];
      if (bounceLike && !logs.length) {
        // Bounce reports rarely thread; the failed address in the body is the next best key.
        logs = await query<SendLogRow>(
          `SELECT * FROM send_log WHERE account_id=$1 AND status='sent' AND sent_at > now() - interval '10 days' AND position(lower(to_email) in lower($2)) > 0 ORDER BY sent_at DESC LIMIT 3`,
          [acc.id, text.slice(0, 20000)],
        );
      }
      if (bounceLike) { await handleBounce(acc, e, logs); continue; }

      const contact = await one<any>(`SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=$2`, [acc.user_id, fromEmail]);
      if (contact) {
        await query(`INSERT INTO contact_threads (contact_id, account_id, thread_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [contact.id, acc.id, e.threadId]);
      }
      const enrollmentIds = new Set<number>(logs.map((l) => l.enrollment_id).filter((x): x is number => x !== null));
      if (contact && !enrollmentIds.size) {
        // Header-less reply (some clients strip References): a contact with an active enrollment on this account writing back is a reply.
        const active = await query<{ id: number }>(`SELECT id FROM enrollments WHERE contact_id=$1 AND account_id=$2 AND status IN ('active','waiting_review','paused')`, [contact.id, acc.id]);
        for (const a of active) enrollmentIds.add(a.id);
      }
      if (!isAuto && (logs.length || enrollmentIds.size)) {
        await handleReply(acc, e, logs, contact, [...enrollmentIds], text);
      } else if (isAuto && logs.length) {
        log.info(`auto-reply ignored for sequence purposes`, { account: acc.id, from: fromEmail });
      }
    } catch (err) {
      log.error('reply/bounce processing failed', { err: (err as Error).message, email: e.id });
    }

    if (rules.length && inboxId && mailboxIds.includes(inboxId)) {
      try { await applyRules(acc, e, rules, text); } catch (err) { log.error('rule application failed', { err: (err as Error).message }); }
    }
    let answered = false;
    if (responders.length && !isAuto && !bounceLike) {
      try { answered = await enqueueResponders(acc, e, responders, text, roles); } catch (err) { log.error('responder queueing failed', { err: (err as Error).message }); }
    }
    // The out-of-office reply, unless a responder is already answering.
    if (!answered && !isAuto && !bounceLike && vacationOn && !roles.some((r) => r === 'junk' || r === 'spam' || r === 'trash')) {
      try { await maybeVacationReply(acc, e); } catch (err) { log.error('vacation reply failed', { err: (err as Error).message }); }
    }
  }
}

// ---------- AI responders ----------
// Matching happens here, at sync time; the slow part (asking the model) is a
// job the scheduler works through so a mailbox sync is never blocked on a
// 30-second generation.
async function enqueueResponders(acc: AccountRow, e: any, responders: any[], text: string, roles: (string | null | undefined)[]): Promise<boolean> {
  if (roles.includes('junk') || roles.includes('spam') || roles.includes('trash')) return false;
  const fromEmail: string = (e.from?.[0]?.email ?? '').toLowerCase();
  if (!fromEmail) return false;
  for (const r of responders) {
    if (r.skip_lists && isListMail(e)) continue;
    const conds: RuleCondition[] = Array.isArray(r.conditions) ? r.conditions : [];
    if (conds.length && !ruleMatches(r, e, text)) continue;
    if (r.only_contacts) {
      const c = await one('SELECT 1 FROM contacts WHERE user_id=$1 AND lower(email)=$2', [acc.user_id, fromEmail]);
      if (!c) continue;
    }
    // Loop and flood protection: one answer per thread per cooldown, and a daily cap per responder.
    const recent = await one(
      `SELECT 1 FROM send_log WHERE responder_id=$1 AND thread_id=$2 AND sent_at > now() - ($3 || ' hours')::interval
       UNION ALL SELECT 1 FROM drafts WHERE responder_id=$1 AND thread_id=$2 AND created_at > now() - ($3 || ' hours')::interval
       UNION ALL SELECT 1 FROM review_queue WHERE responder_id=$1 AND thread_id=$2 AND created_at > now() - ($3 || ' hours')::interval
       UNION ALL SELECT 1 FROM ai_jobs WHERE kind='responder' AND (payload->>'responderId')::bigint=$1 AND payload->>'threadId'=$2 AND status IN ('pending','running') LIMIT 1`,
      [r.id, e.threadId, String(r.cooldown_hours ?? 24)],
    );
    if (recent) continue;
    const today = await one<{ n: number }>(`SELECT (SELECT count(*) FROM send_log WHERE responder_id=$1 AND sent_at > now() - interval '24 hours') + (SELECT count(*) FROM drafts WHERE responder_id=$1 AND created_at > now() - interval '24 hours') + (SELECT count(*) FROM review_queue WHERE responder_id=$1 AND created_at > now() - interval '24 hours') AS n`, [r.id]);
    if ((today?.n ?? 0) >= (r.daily_cap ?? 20)) { log.info('responder daily cap reached', { responder: r.id }); continue; }
    await query(`INSERT INTO ai_jobs (user_id, kind, payload) VALUES ($1, 'responder', $2)`, [acc.user_id, JSON.stringify({ responderId: r.id, accountId: acc.id, emailDbId: e._id, jmapId: e.id, threadId: e.threadId })]);
    log.info('responder queued', { responder: r.id, email: e.id });
    return true; // first matching responder wins
  }
  return false;
}

async function handleBounce(acc: AccountRow, e: any, logs: SendLogRow[]): Promise<void> {
  if (!logs.length) return;
  for (const l of logs) {
    await query(`UPDATE send_log SET bounced_at=now() WHERE id=$1 AND bounced_at IS NULL`, [l.id]);
    if (l.enrollment_id) {
      await query(`UPDATE enrollments SET status='bounced', error='Delivery failed', updated_at=now(), finished_at=now() WHERE id=$1 AND status IN ('active','waiting_review','paused')`, [l.enrollment_id]);
      publish({ type: 'enrollment', userId: acc.user_id, sequenceId: l.sequence_id ?? 0, enrollmentId: l.enrollment_id, status: 'bounced' });
    }
    if (l.contact_id) {
      await query(`UPDATE contacts SET status='bounced', updated_at=now() WHERE id=$1 AND status='active'`, [l.contact_id]);
      await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), 'bounce', $3) ON CONFLICT (user_id, email) DO NOTHING`, [acc.user_id, l.to_email, `bounce report ${e.id}`]);
    }
  }
  log.info('bounce recorded', { account: acc.id, matched: logs.length });
}

async function handleReply(acc: AccountRow, e: any, logs: SendLogRow[], contact: any, enrollmentIds: number[], text: string): Promise<void> {
  for (const l of logs) await query(`UPDATE send_log SET replied_at=now() WHERE id=$1 AND replied_at IS NULL`, [l.id]);
  const contactId: number | null = contact?.id ?? logs.find((l) => l.contact_id)?.contact_id ?? null;
  const wantsStop = STOP_RE.test(firstLines(text));
  if (contactId) {
    await query(`UPDATE contacts SET last_replied_at=now(), status = CASE WHEN status='active' THEN 'replied' ELSE status END, updated_at=now() WHERE id=$1`, [contactId]);
    await query(`INSERT INTO contact_threads (contact_id, account_id, thread_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [contactId, acc.id, e.threadId]);
    if (wantsStop) {
      const email: string = contact?.email ?? logs[0]?.to_email;
      await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), 'reply_stop', $3) ON CONFLICT (user_id, email) DO UPDATE SET reason='reply_stop'`, [acc.user_id, email, `reply ${e.id}`]);
      await query(`UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE id=$1`, [contactId]);
    }
  }
  for (const id of enrollmentIds) {
    const enr = await one<any>(`SELECT e.*, s.stop_on_reply FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE e.id=$1`, [id]);
    if (!enr) continue;
    if (wantsStop) {
      await query(`UPDATE enrollments SET status='unsubscribed', updated_at=now(), finished_at=now() WHERE id=$1 AND status IN ('active','waiting_review','paused')`, [id]);
      publish({ type: 'enrollment', userId: acc.user_id, sequenceId: enr.sequence_id, enrollmentId: id, status: 'unsubscribed' });
    } else if (enr.stop_on_reply) {
      await query(`UPDATE enrollments SET status='replied', updated_at=now(), finished_at=now() WHERE id=$1 AND status IN ('active','waiting_review','paused')`, [id]);
      await query(`UPDATE review_queue SET status='rejected', decided_at=now() WHERE enrollment_id=$1 AND status='pending'`, [id]);
      publish({ type: 'enrollment', userId: acc.user_id, sequenceId: enr.sequence_id, enrollmentId: id, status: 'replied' });
    }
  }
  log.info('reply recorded', { account: acc.id, contact: contactId, enrollments: enrollmentIds.length, stop: wantsStop });
}

// ---------- Rules ----------

export interface RuleCondition { field: 'from' | 'to' | 'cc' | 'subject' | 'body' | 'any' | 'has_attachment' | 'list'; op: 'contains' | 'not_contains' | 'equals' | 'starts_with' | 'ends_with' | 'matches' | 'is_true' | 'is_false'; value?: string }
export interface RuleAction { type: 'archive' | 'trash' | 'spam' | 'mark_read' | 'star' | 'label' | 'unstar'; mailboxId?: string }

function addrText(list: any[] | undefined): string {
  return (list ?? []).map((a) => `${a.name ?? ''} <${a.email ?? ''}>`).join(', ').toLowerCase();
}

export function evaluateCondition(c: RuleCondition, e: any, text: string): boolean {
  const v = (c.value ?? '').toLowerCase();
  let hay = '';
  switch (c.field) {
    case 'from': hay = addrText(e.from); break;
    case 'to': hay = addrText(e.to); break;
    case 'cc': hay = addrText(e.cc); break;
    case 'subject': hay = (e.subject ?? '').toLowerCase(); break;
    case 'body': hay = (text ?? '').toLowerCase(); break;
    case 'list': hay = String(e['header:List-Id:asText'] ?? e['header:List-Unsubscribe:asText'] ?? '').toLowerCase(); break;
    case 'any': hay = [addrText(e.from), addrText(e.to), (e.subject ?? '').toLowerCase(), (text ?? '').toLowerCase()].join('\n'); break;
    case 'has_attachment': return c.op === 'is_false' ? !e.hasAttachment : Boolean(e.hasAttachment);
  }
  switch (c.op) {
    case 'contains': return hay.includes(v);
    case 'not_contains': return !hay.includes(v);
    case 'equals': return hay.trim() === v.trim() || (c.field === 'from' && (e.from?.[0]?.email ?? '').toLowerCase() === v.trim());
    case 'starts_with': return hay.startsWith(v);
    case 'ends_with': return hay.endsWith(v) || (c.field === 'from' && (e.from?.[0]?.email ?? '').toLowerCase().endsWith(v));
    case 'matches': try { return new RegExp(c.value ?? '', 'i').test(hay); } catch { return false; }
    case 'is_true': return Boolean(hay);
    case 'is_false': return !hay;
  }
  return false;
}

export function ruleMatches(rule: any, e: any, text: string): boolean {
  const conds: RuleCondition[] = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (!conds.length) return false;
  const results = conds.map((c) => evaluateCondition(c, e, text));
  return rule.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

async function applyRules(acc: AccountRow, e: any, rules: any[], text: string): Promise<void> {
  for (const rule of rules) {
    if (!ruleMatches(rule, e, text)) continue;
    await query('UPDATE rules SET hits = hits + 1 WHERE id=$1', [rule.id]);
    await runActions(acc, [e.id], rule.actions ?? []);
    log.info('rule applied', { rule: rule.id, email: e.id });
    if ((rule.actions ?? []).some((a: RuleAction) => a.type === 'trash' || a.type === 'spam')) break;
  }
}

export async function runActions(acc: AccountRow, jmapIds: string[], list: RuleAction[]): Promise<void> {
  for (const a of list) {
    switch (a.type) {
      case 'archive': await actions.archive(acc, jmapIds); break;
      case 'trash': await actions.trash(acc, jmapIds); break;
      case 'spam': await actions.spam(acc, jmapIds); break;
      case 'mark_read': await actions.setKeyword(acc, jmapIds, '$seen', true); break;
      case 'star': await actions.setKeyword(acc, jmapIds, '$flagged', true); break;
      case 'unstar': await actions.setKeyword(acc, jmapIds, '$flagged', false); break;
      case 'label': if (a.mailboxId) await actions.addToMailbox(acc, jmapIds, a.mailboxId); break;
    }
  }
}

// Apply a rule to mail that is already in the inbox (the "run now" button).
export async function runRuleOnExisting(acc: AccountRow, rule: any, limit = 500): Promise<number> {
  const inbox = await actions.mailboxByRole(acc.id, 'inbox');
  if (!inbox) return 0;
  const rows = await query<any>(
    `SELECT jmap_id, from_addr, to_addr, cc_addr, subject, has_attachment, body_text, preview FROM emails WHERE account_id=$1 AND $2 = ANY(mailbox_ids) ORDER BY received_at DESC LIMIT $3`,
    [acc.id, inbox.jmap_id, limit],
  );
  const matched: string[] = [];
  for (const r of rows) {
    const e = { id: r.jmap_id, from: r.from_addr, to: r.to_addr, cc: r.cc_addr, subject: r.subject, hasAttachment: r.has_attachment };
    if (ruleMatches(rule, e, r.body_text ?? r.preview ?? '')) matched.push(r.jmap_id);
  }
  if (matched.length) {
    await runActions(acc, matched, rule.actions ?? []);
    await query('UPDATE rules SET hits = hits + $2 WHERE id=$1', [rule.id, matched.length]);
  }
  return matched.length;
}
