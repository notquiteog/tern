// F6: what you promised, and what you are waiting on.
//
// Sequences already stop on reply, so the outreach half of the product
// understands obligations. Ordinary correspondence has no equivalent, and it
// is where things are actually dropped: "I'll send the deck Friday" is a
// commitment nobody records, and "can you confirm the address?" is a debt
// somebody else owes you that no mail client tracks.
//
// The division of labour matters. The model is used for one thing only —
// reading a conversation and saying which sentences were promises — and its
// answer is turned into rows that are then handled by ordinary code:
// editable, dismissible, closed automatically when a reply arrives. Nothing
// is inferred at read time and nothing changes under the person while they
// are looking at it.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { chat, getAiSettings } from '../ai/llm.js';
import { assertFreshConversation } from '../ai/prompts.js';
import { dataKey, openWith, sealWith } from './vault.js';
import { openEmails } from './mailVault.js';
import { htmlToText } from './merge.js';
import { allowed } from './capabilities.js';
import type { AccountRow } from './accounts.js';

const log = logger('commitments');

export type CommitmentKind = 'owed' | 'awaiting';

export interface Commitment {
  id: number;
  kind: CommitmentKind;
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  /** When this was last rescheduled, or null if it has never moved. */
  movedAt: string | null;
  status: 'open' | 'done' | 'dropped';
  threadId: string;
  accountId: number;
  emailId: number | null;
  source: 'ai' | 'manual';
  createdAt: string;
}

// Conversations looked at per pass. A scan is a whole thread through the
// model, which is the most expensive thing in this file.
export const SCAN_BATCH = 2;

// ---------- Prompting ----------

const SYSTEM = [
  'You read one email conversation and list the commitments in it.',
  'A commitment is a specific thing somebody said they would do, or a specific thing somebody was asked to do.',
  'Answer with a JSON array and nothing else. Each element is:',
  '{"kind":"owed"|"awaiting","what":"<short phrase>","who":"<name or address>","due":"<YYYY-MM-DD or null>"}',
  '"owed" means THE USER promised it. "awaiting" means the user is waiting for someone else.',
  'Only list things that are specific and actionable. Pleasantries, greetings and vague intentions are not commitments.',
  // A line asking the model to drop settled commitments was tried here and
  // reverted: qwen3.5:4b read "leave out anything already delivered" and
  // answered [] for every thread, three runs out of three. It cannot make
  // that judgement, and asking it to costs the whole feature. Superseding is
  // handled after the fact instead — an owed commitment settles itself when
  // something of the user's lands in the thread (see `settle_after`), which
  // is a rule rather than an opinion.
  'If there are none, answer exactly [].',
].join('\n');

export interface ParsedCommitment { kind: CommitmentKind; what: string; who: string | null; due: string | null }

// A small local model will wrap JSON in prose, in a code fence, or in an
// apology. This takes the first array that parses and ignores the rest,
// because an unusable answer must produce no commitments rather than an
// error the person has to care about.
export function parseCommitments(raw: string, today = new Date()): ParsedCommitment[] {
  const text = String(raw ?? '');
  const start = text.indexOf('[');
  if (start < 0) return [];
  // Scan for the matching bracket rather than the last one in the string: a
  // model that writes a second array afterwards should not merge them.
  let depth = 0, end = -1, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  let list: unknown;
  try { list = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(list)) return [];

  const out: ParsedCommitment[] = [];
  for (const item of list.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = o.kind === 'owed' || o.kind === 'awaiting' ? o.kind : null;
    const what = String(o.what ?? '').trim();
    if (!kind || what.length < 6 || what.length > 200) continue;
    // A model asked for a phrase sometimes returns the whole email.
    if (what.split(/\s+/).length > 30) continue;
    out.push({
      kind,
      what: what[0].toUpperCase() + what.slice(1),
      who: cleanWho(o.who),
      due: cleanDue(o.due, today),
    });
  }
  return out;
}

function cleanWho(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > 120 || /^(null|none|unknown|n\/a|the user|me|you)$/i.test(s)) return null;
  return s;
}

// A date the model invented has to be plausible before it becomes a
// reminder. Anything in the past by more than a day, or more than two years
// out, is dropped rather than shown as an overdue item that never existed.
export function cleanDue(v: unknown, today = new Date()): string | null {
  const s = String(v ?? '').trim();
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const at = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  const days = (at.getTime() - today.getTime()) / 86_400_000;
  if (days < -1 || days > 730) return null;
  return at.toISOString();
}

// ---------- Scanning ----------

// One conversation. Returns what was written; the caller decides how many
// conversations a tick is worth.
// The prompt the scanner sends, built where an evaluation can reach it. The
// alternative is an eval that reimplements the prompt and then measures its
// own copy, which is how a harness comes to pass while the product fails.
export function buildCommitmentMessages(ownEmail: string, subject: string, lines: string[], today = new Date()): { role: 'system' | 'user'; content: string }[] {
  const user = [
    `Today is ${today.toISOString().slice(0, 10)}.`,
    `The user's own address is ${ownEmail}. Messages from them are marked THE USER.`,
    `Subject: ${subject}`,
    '',
    lines.join('\n\n').slice(0, 12_000),
  ].join('\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

export async function scanThread(userId: number, acc: AccountRow, threadId: string): Promise<number> {
  if (!(await allowed(userId, 'commitments'))) return 0;
  const s = await getAiSettings();
  const sealed = await query<any>(
    `SELECT id, subject, from_addr, to_addr, received_at, body_text, body_html, preview
       FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC LIMIT 40`,
    [acc.id, threadId],
  );
  if (!sealed.length) return 0;
  const msgs = await openEmails(userId, 'commitments', sealed);
  const newest = msgs[msgs.length - 1];

  const mine = String(acc.email ?? '').toLowerCase();
  const lines = msgs.map((m: any) => {
    const from = String(m.from_addr?.[0]?.email ?? '').toLowerCase();
    const who = from === mine ? 'THE USER' : `${m.from_addr?.[0]?.name ?? from}`;
    const body = (m.body_text || htmlToText(m.body_html || '') || m.preview || '')
      .replace(/^\s*>.*$/gm, '').trim().slice(0, 1500);
    return `--- ${who}, ${new Date(m.received_at).toDateString()}\n${body}`;
  }).filter((l: string) => l.trim());
  if (!lines.length) return await markScanned(acc.id, threadId, newest.received_at);

  const messages = buildCommitmentMessages(acc.email, newest.subject ?? '', lines);
  assertFreshConversation(messages);
  const raw = await chat({
    messages,
    maxTokens: 500,
    temperature: 0.1,
    background: true,
    owner: String(userId),
    // Working out loud costs a budget and adds nothing to a list of
    // sentences that are already in the text.
    noThink: true,
    consent: { userId, capability: 'commitments' },
  });

  const parsed = parseCommitments(raw);
  const dek = await dataKey(userId);
  // A rescan replaces what the model previously said about this thread and
  // leaves alone anything the person has touched: an item they closed stays
  // closed, and one they wrote by hand is theirs.
  await query(
    `DELETE FROM commitments WHERE account_id=$1 AND thread_id=$2 AND source='ai' AND status='open'`,
    [acc.id, threadId],
  );
  for (const c of parsed) {
    await query(
      `INSERT INTO commitments (user_id, account_id, email_id, thread_id, kind, text, counterparty, due_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ai')`,
      [userId, acc.id, newest.id ?? null, threadId, c.kind, sealWith(dek, c.what), c.who ? sealWith(dek, c.who) : null, c.due],
    );
  }
  await markScanned(acc.id, threadId, newest.received_at);
  if (parsed.length) log.info(`found ${parsed.length} commitments`, { account: acc.id, thread: threadId });
  return parsed.length;
}

async function markScanned(accountId: number, threadId: string, latestAt: Date | string): Promise<number> {
  await query(
    `INSERT INTO commitment_scans (account_id, thread_id, latest_at, scanned_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (account_id, thread_id) DO UPDATE SET latest_at=EXCLUDED.latest_at, scanned_at=now()`,
    [accountId, threadId, latestAt],
  );
  return 0;
}

// Conversations worth looking at: recent, with more than one message, and
// either never scanned or changed since. A one-message thread has nobody to
// have promised anything to.
export async function threadsToScan(userId: number, accountId: number, limit = SCAN_BATCH): Promise<string[]> {
  const rows = await query<{ thread_id: string }>(
    `SELECT e.thread_id
       FROM emails e
       LEFT JOIN commitment_scans s ON s.account_id=e.account_id AND s.thread_id=e.thread_id
      WHERE e.account_id=$1 AND e.received_at > now() - interval '45 days'
      GROUP BY e.thread_id, s.latest_at
     HAVING count(*) > 1 AND (s.latest_at IS NULL OR max(e.received_at) > s.latest_at)
      ORDER BY max(e.received_at) DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => r.thread_id);
}

// ---------- Reading and editing ----------

export async function listCommitments(userId: number, status: 'open' | 'all' = 'open'): Promise<Commitment[]> {
  const rows = await query<any>(
    `SELECT c.*, a.email AS account_email FROM commitments c JOIN accounts a ON a.id=c.account_id
      WHERE c.user_id=$1 AND ($2 = 'all' OR c.status='open')
      ORDER BY (c.due_at IS NULL), c.due_at ASC, c.created_at DESC LIMIT 300`,
    [userId, status],
  );
  return openRows(userId, rows);
}

// The open items belonging to one conversation.
//
// The thread view asks for this every time a conversation is opened, which
// is why it is a scoped query rather than a filter over listCommitments:
// that one decrypts up to three hundred rows to answer a question about two.
export async function commitmentsForThread(userId: number, accountId: number, threadId: string): Promise<Commitment[]> {
  if (!threadId) return [];
  const rows = await query<any>(
    `SELECT c.* FROM commitments c
      WHERE c.user_id=$1 AND c.account_id=$2 AND c.thread_id=$3 AND c.status='open'
      ORDER BY (c.due_at IS NULL), c.due_at ASC, c.created_at DESC LIMIT 20`,
    [userId, accountId, threadId],
  );
  return openRows(userId, rows);
}

async function openRows(userId: number, rows: any[]): Promise<Commitment[]> {
  if (!rows.length) return [];
  const dek = await dataKey(userId);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: openWith(dek, r.text) ?? '',
    counterparty: r.counterparty ? openWith(dek, r.counterparty) : null,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    movedAt: r.settle_after ? new Date(r.settle_after).toISOString() : null,
    status: r.status,
    threadId: r.thread_id,
    accountId: r.account_id,
    emailId: r.email_id,
    source: r.source,
    createdAt: new Date(r.created_at).toISOString(),
  })).filter((c) => c.text);
}

export async function closeCommitment(userId: number, id: number, status: 'done' | 'dropped'): Promise<boolean> {
  const rows = await query(
    `UPDATE commitments SET status=$3, closed_at=now() WHERE id=$1 AND user_id=$2 AND status='open' RETURNING id`,
    [id, userId, status],
  );
  return rows.length > 0;
}

export async function addCommitment(userId: number, input: { accountId: number; threadId?: string; kind: CommitmentKind; text: string; counterparty?: string | null; dueAt?: string | null }): Promise<number> {
  const dek = await dataKey(userId);
  const rows = await query<{ id: number }>(
    `INSERT INTO commitments (user_id, account_id, thread_id, kind, text, counterparty, due_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING id`,
    [userId, input.accountId, input.threadId ?? '', input.kind, sealWith(dek, input.text), input.counterparty ? sealWith(dek, input.counterparty) : null, input.dueAt ?? null],
  );
  return rows[0].id;
}

// One item, by id, so the drafting route can put the promise in front of the
// model without the browser being trusted to say what was promised. The text
// the model apologises for has to come out of the ledger, not off the wire.
export async function getCommitment(userId: number, id: number): Promise<Commitment | null> {
  const rows = await query<any>('SELECT c.* FROM commitments c WHERE c.id=$1 AND c.user_id=$2', [id, userId]);
  return (await openRows(userId, rows))[0] ?? null;
}

// Moving the goalposts. The item keeps its identity — it is the same promise,
// on a new date — and the watermark stops the mail that announces the move
// from being read as the move having happened.
//
// A due date is optional because plenty of reschedules genuinely have no new
// date ("as soon as the audit is back"). Passing null clears it; passing
// undefined leaves it alone.
export async function moveCommitment(userId: number, id: number, dueAt?: string | null): Promise<Commitment | null> {
  const rows = await query<{ id: number }>(
    `UPDATE commitments SET settle_after=now()${dueAt === undefined ? '' : ', due_at=$3'}
      WHERE id=$1 AND user_id=$2 AND status='open' RETURNING id`,
    dueAt === undefined ? [id, userId] : [id, userId, dueAt],
  );
  if (!rows.length) return null;
  return getCommitment(userId, id);
}

// An "awaiting" item closes itself when the other side writes back, and an
// "owed" one when the user sends into the thread. That is what stops the
// list becoming another inbox nobody empties.
//
// "Since when" is `settle_after` where the item has been moved and
// `created_at` where it has not. Rescheduling writes that watermark, because
// the reschedule is itself a message in the thread: without it, sending "the
// quote will be Thursday instead" would settle the very quote it postponed,
// and a nudge would settle the thing you are still waiting for.
export async function settleFromMail(userId: number): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE commitments c SET status='done', closed_at=now()
       FROM emails e
       JOIN mailboxes m ON m.account_id = e.account_id AND m.role = 'sent'
      WHERE c.user_id=$1 AND c.status='open' AND c.kind='owed'
        AND e.account_id = c.account_id AND e.thread_id = c.thread_id
        AND e.mailbox_ids @> ARRAY[m.jmap_id]
        AND e.received_at > coalesce(c.settle_after, c.created_at)
      RETURNING c.id`,
    [userId],
  );
  const replies = await query<{ id: number }>(
    `UPDATE commitments c SET status='done', closed_at=now()
       FROM emails e
      WHERE c.user_id=$1 AND c.status='open' AND c.kind='awaiting'
        AND e.account_id = c.account_id AND e.thread_id = c.thread_id
        AND e.received_at > coalesce(c.settle_after, c.created_at)
        AND NOT EXISTS (
          SELECT 1 FROM mailboxes m WHERE m.account_id = e.account_id AND m.role='sent' AND e.mailbox_ids @> ARRAY[m.jmap_id]
        )
      RETURNING c.id`,
    [userId],
  );
  return rows.length + replies.length;
}

export async function openCount(userId: number): Promise<{ owed: number; awaiting: number; overdue: number }> {
  const r = await one<{ owed: number; awaiting: number; overdue: number }>(
    `SELECT count(*) FILTER (WHERE kind='owed')::int AS owed,
            count(*) FILTER (WHERE kind='awaiting')::int AS awaiting,
            count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())::int AS overdue
       FROM commitments WHERE user_id=$1 AND status='open'`,
    [userId],
  );
  return r ?? { owed: 0, awaiting: 0, overdue: 0 };
}
