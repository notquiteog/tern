// One-line AI summaries above a conversation in the list — the "pre-header".
//
// Two things shape this. The model is local and often on a CPU, so a page of
// fifty conversations cannot be summarised on demand; and the summary is
// derived from mail content, so it is sealed with the owner's key like the
// mail itself.
//
// So: summaries are cached per conversation, written only when asked for, and
// a request generates at most a handful. The browser asks for the rows it can
// actually see, gets back whatever is already cached at once, and the few it
// generated this time round.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { chat, getAiSettings } from '../ai/llm.js';
import { buildMessages, cleanOutput, modeTuning, threadBudgetChars } from '../ai/prompts.js';
import { openEmails } from './mailVault.js';
import { dataKey, openWith, sealWith } from './vault.js';
import { htmlToText } from './merge.js';
import type { AccountRow } from './accounts.js';

const log = logger('summaries');

// How many a single request may generate. Everything else comes back cached
// or absent; the browser asks again as the reader scrolls.
export const MAX_PER_REQUEST = 4;

export interface Summary { threadId: string; accountId: number; text: string; stale: boolean }

function key(accountId: number, threadId: string): string { return `${accountId}:${threadId}`; }

// What is already written down, opened with the owner's key. A summary whose
// `latest_at` is behind the conversation is still shown — a slightly old line
// beats an empty one — but it is marked stale so it is regenerated first.
export async function cachedSummaries(userId: number, accountIds: number[], threadIds: string[]): Promise<Map<string, Summary>> {
  const out = new Map<string, Summary>();
  if (!accountIds.length || !threadIds.length) return out;
  const rows = await query<any>(
    `SELECT s.account_id, s.thread_id, s.summary, s.latest_at, s.model,
            (SELECT max(e.received_at) FROM emails e WHERE e.account_id=s.account_id AND e.thread_id=s.thread_id) AS newest
       FROM thread_summaries s
      WHERE s.account_id = ANY($1) AND s.thread_id = ANY($2)`,
    [accountIds, threadIds],
  );
  if (!rows.length) return out;
  const s = await getAiSettings();
  const dek = await dataKey(userId);
  for (const r of rows) {
    const text = openWith(dek, r.summary);
    // null means the ciphertext would not open, which is a real failure and
    // worth another go. An empty string is a decline that was written down on
    // purpose — the model had nothing to add — and asking again would only
    // get the same nothing, more slowly.
    if (text === null) continue;
    const newer = Boolean(r.newest && new Date(r.newest).getTime() > new Date(r.latest_at).getTime());
    // A different model deserves another attempt: an install that moves off a
    // model too small to summarise should not keep its declines for ever.
    const staleModel = Boolean(r.model && s.model && r.model !== s.model);
    out.set(key(r.account_id, r.thread_id), { threadId: r.thread_id, accountId: r.account_id, text, stale: newer || staleModel });
  }
  return out;
}

// Writes one conversation's line. Returns null when there is nothing worth
// summarising or the model had nothing to say.
export async function generateSummary(userId: number, acc: AccountRow, threadId: string): Promise<Summary | null> {
  const s = await getAiSettings();
  if (!s.enabled) return null;
  const sealed = await query<any>(
    'SELECT from_addr, received_at, body_text, body_html, preview, subject FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC',
    [acc.id, threadId],
  );
  if (!sealed.length) return null;
  // Every path below that gives up writes an empty line against the
  // conversation rather than leaving the row absent. Without that the browser
  // sees a summary it never got, asks again, and a local model spends the
  // rest of the session rewriting nothing.
  const decline = async (at: Date | string): Promise<Summary> => {
    const dek = await dataKey(userId);
    await query(
      `INSERT INTO thread_summaries (account_id, thread_id, summary, latest_at, model, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (account_id, thread_id) DO UPDATE SET summary=EXCLUDED.summary, latest_at=EXCLUDED.latest_at, model=EXCLUDED.model, updated_at=now()`,
      [acc.id, threadId, sealWith(dek, ''), at, s.model],
    );
    return { threadId, accountId: acc.id, text: '', stale: false };
  };
  const msgs = await openEmails(userId, sealed);
  const newest = msgs.reduce((a: any, m: any) => (new Date(m.received_at) > new Date(a.received_at) ? m : a), msgs[0]);
  const thread = msgs.map((m: any) => ({
    from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(),
    date: new Date(m.received_at).toDateString(),
    text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').replace(/\n>.*$/gm, '').trim(),
  })).filter((m: any) => m.text);
  if (!thread.length) return await decline(newest.received_at);
  // A message the assistant cannot read is not summarised, and saying so is
  // more useful than a line invented from the armour header.
  if (thread.every((m: any) => /-----BEGIN PGP MESSAGE-----/.test(m.text))) return await decline(newest.received_at);

  const tuning = modeTuning('gist');
  const threadChars = Math.min(threadBudgetChars(s.numCtx, tuning.maxTokens ?? s.maxTokens), tuning.threadChars ?? Infinity);
  const text = cleanOutput(
    await chat({
      messages: buildMessages({ mode: 'gist', thread, subject: newest.subject ?? '', systemPrompt: s.systemPrompt, threadChars }),
      maxTokens: tuning.maxTokens,
      temperature: tuning.temperature,
      stop: tuning.stop,
      // Nobody is watching a summary arrive, so it waits behind anyone who is
      // at a composer rather than beside them; a page of fifty conversations
      // must not be able to take every slot the model has.
      background: true,
      owner: String(userId),
      // Never. A one-line summary is not worth a reasoning budget, and on a
      // CPU-only box a thinking model would take a minute per row of the
      // list — for a question the first sentence of the mail answers.
      noThink: true,
    }),
    'gist',
  );
  const line = tidyGist(text, newest.subject ?? '');
  // The model answered, but with a greeting, a fragment or the subject again.
  // That is a decline, and it is recorded as one.
  if (!line) return await decline(newest.received_at);
  const dek = await dataKey(userId);
  await query(
    `INSERT INTO thread_summaries (account_id, thread_id, summary, latest_at, model, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (account_id, thread_id) DO UPDATE SET summary=EXCLUDED.summary, latest_at=EXCLUDED.latest_at, model=EXCLUDED.model, updated_at=now()`,
    [acc.id, threadId, sealWith(dek, line), newest.received_at, s.model],
  );
  log.info('summary written', { account: acc.id, thread: threadId });
  return { threadId, accountId: acc.id, text: line, stale: false };
}

// Reduces a line to what it actually says, for comparing a summary against
// the subject it is meant to add to.
function bare(v: string): string {
  return String(v ?? '').toLowerCase().replace(/^\s*(?:re|fwd?|fw)\s*:\s*/i, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A small model given "one line" still sometimes writes three, opens with
// "This email", or wraps the lot in quotes. The row has space for one line.
// `subject` is what the row already shows: a summary that only repeats it
// costs a line and adds nothing, so it is dropped.
export function tidyGist(raw: string, subject?: string): string {
  let t = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  t = t.replace(/^["'“”«]+|["'“”»]+$/g, '').trim();
  t = t.replace(/^(?:this (?:e-?mail|message|thread|conversation)|the sender|they)\s+(?:is|are|says?|asks?|wants?|explains?)\s+(?:that\s+|about\s+)?/i, '');
  t = t.replace(/^(?:summary|gist|in short|tl;?dr)\s*[:\-–]\s*/i, '');
  t = t.replace(/[.\s]+$/, '');
  if (!t) return '';
  // A "line" that ran to a paragraph is not one, and truncating mid-sentence
  // reads worse than not showing it at all.
  if (t.length > 160) return '';
  // A small model handed a thread often starts writing the reply instead of
  // describing it, and the first line of a reply is the greeting. "Hi Bob,"
  // above a conversation is worse than no summary at all.
  if (/^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|thanks|thank you|best|regards|kind regards|cheers|sincerely)\b/i.test(t)) return '';
  if (/,$/.test(t.trim())) return '';
  // Two words is a fragment, not a summary of anything.
  if (t.split(/\s+/).filter(Boolean).length < 3) return '';
  // The subject is on the row above. A summary that restates it, or is
  // swallowed by it, is not worth the line it would take.
  const g = bare(t), subj = bare(subject ?? '');
  if (subj && g && (g === subj || subj.includes(g) || g.includes(subj))) return '';
  return t[0].toUpperCase() + t.slice(1);
}

// Drops a conversation's line when the mail it described is gone.
export async function forgetSummary(accountId: number, threadId: string): Promise<void> {
  await query('DELETE FROM thread_summaries WHERE account_id=$1 AND thread_id=$2', [accountId, threadId]);
}

export async function summaryCount(userId: number): Promise<number> {
  const r = await one<{ n: number }>(
    'SELECT count(*)::int AS n FROM thread_summaries s JOIN accounts a ON a.id=s.account_id WHERE a.user_id=$1',
    [userId],
  );
  return r?.n ?? 0;
}
