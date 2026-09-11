// The assistant's memory, which is a table rather than a promise.
//
// ── What is kept, and why that is a departure ───────────────────────────────
//
// Nothing else in Tern keeps what was said to a model. `ai/session.ts` exists
// to make sure of it: a prompt is built, an answer streams back, and the
// message array is emptied in a `finally` so no live reference survives the
// request. That is a real guarantee and it still holds everywhere it held
// before.
//
// It cannot hold here, and pretending otherwise would be the worse design. A
// conversation is a thing you come back to; "make that shorter" refers to a
// turn that has to still exist. So the transcript is written down — and since
// it is written down, it is written down the way mail is: sealed with the
// owner's own key, scoped to them by SQL on every read, listed where they can
// see it, and deleted when they say so or when they withdraw consent.
//
// The honest summary, which is the one in the capability's own description:
// every other feature forgets, this one remembers, and you can see and delete
// what it remembers.
//
// ── What is deliberately NOT kept ───────────────────────────────────────────
//
// The model's working-out. A reasoning model's `thinking` is streamed to the
// browser so a slow turn looks like something happening, and then it is gone —
// it is not part of the answer, it is the least considered thing the model
// produced, and storing it would double the size of a transcript with the part
// of it nobody wants to read back.
import { one, query } from '../db.js';
import { dataKey, openWith, sealWith } from '../services/vault.js';
import type { ChatMessage, ToolCall } from './llm.js';
import type { Proposal, Reference } from './tools.js';

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  proposal?: Proposal;
  references?: Reference[];
  createdAt: string;
}

export interface ConversationSummary { id: number; title: string; createdAt: string; updatedAt: string; messages: number }

/** How much of a transcript is replayed to the model. See `transcriptFor`. */
export const HISTORY_TURNS = 40;

export async function createConversation(userId: number, firstMessage: string): Promise<number> {
  const dek = await dataKey(userId);
  // The title is the person's own opening line, trimmed — not a generation.
  // A model call to name a conversation is a model call the person did not ask
  // for, and on the box this runs on it is a visible pause before the thing
  // they did ask for starts.
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation';
  const row = await one<{ id: number }>(
    'INSERT INTO ai_conversations (user_id, title) VALUES ($1,$2) RETURNING id',
    [userId, sealWith(dek, title)],
  );
  return row!.id;
}

export async function listConversations(userId: number, limit = 50): Promise<ConversationSummary[]> {
  const dek = await dataKey(userId);
  const rows = await query<any>(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT count(*)::int FROM ai_messages m WHERE m.conversation_id = c.id AND m.role <> 'tool') AS messages
       FROM ai_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: openWith(dek, r.title) || 'New conversation',
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    messages: r.messages,
  }));
}

export async function conversationExists(userId: number, id: number): Promise<boolean> {
  return Boolean(await one<{ n: number }>('SELECT 1 AS n FROM ai_conversations WHERE id=$1 AND user_id=$2', [id, userId]));
}

/**
 * A whole conversation, opened.
 *
 * `tool` rows are included: the browser hides them behind "what it looked at",
 * and a person auditing what the assistant read is entitled to the same rows
 * the model saw rather than a summary of them.
 */
export async function readConversation(userId: number, id: number): Promise<StoredMessage[]> {
  const dek = await dataKey(userId);
  const rows = await query<any>(
    `SELECT m.id, m.role, m.content, m.tool_calls, m.tool_call_id, m.tool_name, m.proposal, m.refs, m.created_at
       FROM ai_messages m WHERE m.conversation_id=$1 AND m.user_id=$2 ORDER BY m.id ASC`,
    [id, userId],
  );
  return rows.map((r) => {
    const json = <T>(sealed: unknown): T | undefined => {
      const raw = openWith(dek, sealed);
      if (!raw) return undefined;
      try { return JSON.parse(raw) as T; } catch { return undefined; }
    };
    return {
      id: r.id,
      role: r.role,
      content: openWith(dek, r.content) ?? '',
      ...(r.tool_calls ? { toolCalls: json<ToolCall[]>(r.tool_calls) } : {}),
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
      ...(r.tool_name ? { name: r.tool_name } : {}),
      ...(r.proposal ? { proposal: json<Proposal>(r.proposal) } : {}),
      ...(r.refs ? { references: json<Reference[]>(r.refs) } : {}),
      createdAt: new Date(r.created_at).toISOString(),
    } as StoredMessage;
  });
}

export interface AppendInput {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  proposal?: Proposal;
  references?: Reference[];
}

export async function appendMessage(userId: number, conversationId: number, m: AppendInput): Promise<number> {
  const dek = await dataKey(userId);
  const sealedJson = (v: unknown) => (v === undefined ? null : sealWith(dek, JSON.stringify(v)));
  const row = await one<{ id: number }>(
    `INSERT INTO ai_messages (conversation_id, user_id, role, content, tool_calls, tool_call_id, tool_name, proposal, refs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      conversationId, userId, m.role,
      sealWith(dek, m.content ?? ''),
      m.toolCalls?.length ? sealedJson(m.toolCalls) : null,
      m.toolCallId ?? null,
      m.name ?? null,
      m.proposal ? sealedJson(m.proposal) : null,
      m.references?.length ? sealedJson(m.references) : null,
    ],
  );
  await query('UPDATE ai_conversations SET updated_at=now() WHERE id=$1 AND user_id=$2', [conversationId, userId]);
  return row!.id;
}

export async function deleteConversation(userId: number, id: number): Promise<boolean> {
  const rows = await query<{ id: number }>('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId]);
  return rows.length > 0;
}

export async function deleteAllConversations(userId: number): Promise<number> {
  const rows = await query<{ id: number }>('DELETE FROM ai_conversations WHERE user_id=$1 RETURNING id', [userId]);
  return rows.length;
}

/**
 * The stored conversation as a transcript the model can be given.
 *
 * Two things happen on the way, and both are about the shape the transcript
 * rule insists on rather than about size.
 *
 * **The window is taken from the end, and then repaired.** Keeping the last N
 * messages of a tool-calling conversation will routinely cut between an
 * assistant turn that asked for three tools and the results that answered it,
 * and `assertAgentTranscript` refuses exactly that — correctly, because a
 * result with no call is the shape a smuggled result takes. So the window is
 * walked forward from the cut until it reaches a `user` turn, which is the only
 * message that can legitimately start one.
 *
 * **A proposal is not replayed as content.** The draft the model wrote three
 * turns ago is in the browser as a card; putting the whole thing back into the
 * transcript on every subsequent turn would spend the context window
 * re-reading its own output, which is the fastest way to make a small model
 * repeat itself.
 */
export function transcriptFor(system: string, stored: StoredMessage[], turns = HISTORY_TURNS): ChatMessage[] {
  // The window is taken from the end and then made legal, in that order. Both
  // steps are needed and they fix different things.
  const window = stored.slice(-turns);
  let start = window.findIndex((m) => m.role === 'user');
  let body = start >= 0 ? window.slice(start) : [];
  if (!body.length) {
    // Nothing in the window could legally start a transcript, which happens
    // when the cut lands inside a long run of tool calls. Widening to the last
    // `user` turn in the WHOLE history is better than sending a bare system
    // prompt: it costs some context and keeps the conversation answerable,
    // where the empty version would drop the question being asked.
    start = stored.map((m) => m.role).lastIndexOf('user');
    body = start >= 0 ? stored.slice(start) : [];
  }

  const out: ChatMessage[] = [{ role: 'system', content: system }];
  // Everything before the question being answered now is an earlier question.
  const current = body.map((m) => m.role).lastIndexOf('user');
  for (let i = 0; i < body.length; i++) {
    const m = body[i];
    if (m.role === 'tool') { out.push({ role: 'tool', content: i < current ? earlierResult(m.name) : m.content, toolCallId: m.toolCallId, name: m.name }); continue; }
    if (m.role === 'assistant') { out.push({ role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}) }); continue; }
    out.push({ role: 'user', content: m.content });
  }
  return dropUnansweredTail(out);
}

/**
 * What an earlier question's tool result is replayed as: a stub, not the text.
 *
 * The whole text used to go back to the model on every turn, and that is how
 * one conversation leaked into another. Ask about a newsletter, open a
 * different thread, say "draft a reply to this" — and the model, with the
 * newsletter in front of it and only a line of system prompt about the thread
 * on screen, answered about the newsletter without reading the thread at all.
 * Measured, not supposed. Likewise a search from three questions ago is a pile
 * of other people's figures sitting in context, ready to be written into a
 * reply to somebody who never said them.
 *
 * The call stays, so the transcript still shows what was looked at and the
 * shape rule still holds; only the words go. What the model concluded from
 * them is in its own answer, which is replayed, and if it needs the source
 * again the tool is one call away — which is what the system prompt already
 * tells it to do before drafting anything.
 */
export function earlierResult(name?: string): string {
  const tool = name || 'the tool';
  return `[What ${tool} returned for an earlier question is not repeated here. If this question needs it, call ${tool} again.]`;
}

/**
 * Remove a trailing turn whose tool calls never came back.
 *
 * This is the crash case, and without it a conversation can be poisoned
 * permanently. `runAgent` writes an assistant turn down BEFORE running the
 * tools it asked for — deliberately, so a turn that dies halfway still shows
 * the person what was asked — which means a process that stops between the two
 * leaves an assistant turn with calls and no results. That transcript is
 * exactly what `assertAgentTranscript` refuses, so every future turn in that
 * conversation would throw on replay and the person would have no way back
 * except deleting it.
 *
 * Dropping the stump loses one abandoned tool call and keeps the conversation.
 * It is only ever the tail: an unanswered call in the MIDDLE cannot happen, and
 * if it somehow did, the assertion should still refuse it rather than have this
 * quietly rewrite history.
 */
function dropUnansweredTail(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages];
  for (;;) {
    const awaiting = new Set<string>();
    for (const m of out) {
      if (m.role === 'assistant') {
        awaiting.clear();
        for (const c of m.toolCalls ?? []) awaiting.add(c.id);
      } else if (m.role === 'tool' && m.toolCallId) {
        awaiting.delete(m.toolCallId);
      } else if (m.role === 'user') {
        awaiting.clear();
      }
    }
    if (!awaiting.size) return out;
    // Walk back to the assistant turn that asked, and drop it and everything
    // after it. One pass cannot be enough in principle, so this repeats.
    let cut = out.length;
    while (cut > 0 && out[cut - 1]!.role !== 'assistant') cut--;
    if (cut <= 1) return out.slice(0, 1);
    out.length = cut - 1;
  }
}
