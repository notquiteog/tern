// The conversation a draft is written from, loaded one way.
//
// The composer's AI panel needs "the thread behind this threadKey, as text a
// prompt can use", and so does ai/reply.eval.ts — which is only worth running
// if it loads the thread exactly as the route does. The question it exists to
// answer is whether a reply can pick up words from some other conversation in
// the mailbox, and the first place that could happen is this query.
import { query } from '../db.js';
import { openEmails } from './mailVault.js';
import { htmlToText } from './merge.js';
import type { DraftInput } from '../ai/prompts.js';

export interface DraftThread {
  /** The messages as opened, for callers that need the addresses. */
  msgs: any[];
  /** The conversation in the shape `buildMessages` takes. */
  thread: NonNullable<DraftInput['thread']>;
}

export async function threadForDraft(userId: number, accountId: number, threadId: string): Promise<DraftThread> {
  // `to_addr` is here for the reschedule path, which falls back to whoever a
  // message was sent to. It used to read that field off rows that had never
  // selected it, so the fallback could not fire.
  const msgs = await openEmails(userId, 'ai.compose', await query<any>(
    'SELECT from_addr, to_addr, received_at, body_text, body_html, preview FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC',
    [accountId, threadId],
  )) as any[];
  const thread = msgs.map((m) => ({
    from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(),
    date: new Date(m.received_at).toDateString(),
    text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').replace(/\n>.*$/gm, '').trim(),
  }));
  return { msgs, thread };
}
