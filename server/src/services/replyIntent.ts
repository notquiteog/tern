// What a reply to a campaign actually says, and what should happen next.
//
// A sequence stops when somebody answers, which is right and is not enough:
// "not the right person, try Priya", "yes please, next Tuesday" and "take me
// off this list" all stop the sequence and all want different things done
// about them. Without a label they land in one undifferentiated pile and the
// useful ones are found by luck.
//
// Two rules shape this.
//
// The first is the governing one for everything AI in Tern: what can be
// decided in code is decided in code. An unsubscribe request, an
// out-of-office and a bounce are all recognisable from the headers or from a
// fixed phrase, and none of them is given to a model — they are the cases
// where being wrong costs the most and where a regex is right essentially
// always.
//
// The second is that the label set has to be small enough for a 4B model to
// be reliable at it. Five labels, mutually exclusive, each describable in one
// short line, and the answer is validated against the list rather than
// trusted: anything else that comes back becomes `unclear`, which routes to a
// person. There is no free-text field for the model to be creative in.
import { chat } from '../ai/llm.js';
import { assertFreshConversation } from '../ai/prompts.js';
import { allowed } from './capabilities.js';
import { logger } from '../log.js';

const log = logger('reply-intent');

// The whole vocabulary. Adding to it is not free: every extra label is
// another distinction a small model has to hold, and the reliability of the
// ones that matter falls as the list grows.
export const REPLY_INTENTS = [
  // Decided in code, never by the model.
  'stop',           // asked not to be contacted again
  'auto_reply',     // out of office, autoresponder, ticket acknowledgement
  // Decided by the model, from a closed list.
  'interested',     // wants to talk, asks for a call or a demo
  'question',       // asks something specific that needs answering
  'not_now',        // interested but later
  'not_interested', // declines
  'wrong_person',   // not their area; often names somebody else
  // The fallback. Never a guess.
  'unclear',
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export function isReplyIntent(v: unknown): v is ReplyIntent {
  return typeof v === 'string' && (REPLY_INTENTS as readonly string[]).includes(v);
}

// Where a reply goes once it has a label.
//
// Nothing a 4B model wrote answers a campaign reply on its own: the two
// outcomes are "a person looks at it" and "the sequence stops and nobody is
// written to". An autoresponse remains something a responder does, under its
// own rules and its own guard, and a label only ever decides whether a reply
// is *eligible* for one.
export type ReplyRoute = 'suppress' | 'stop_quietly' | 'human_review' | 'ignore';

export const ROUTE_OF: Record<ReplyIntent, ReplyRoute> = {
  stop: 'suppress',
  auto_reply: 'ignore',
  interested: 'human_review',
  question: 'human_review',
  wrong_person: 'human_review',
  not_now: 'stop_quietly',
  not_interested: 'stop_quietly',
  unclear: 'human_review',
};

export interface ReplyInput {
  subject?: string | null;
  text?: string | null;
  /** The Auto-Submitted header, if the message carried one. */
  autoSubmitted?: string | null;
  /** Whether the message announced itself as list mail. */
  isList?: boolean;
}

// Only the part they wrote. Everything below a quote marker is our own
// message coming back, and classifying that would classify ourselves.
export function ownWords(text: string | null | undefined, maxLines = 12): string {
  const lines = String(text ?? '').split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('>')) break;
    if (/^-{2,}\s*original message|^On .{5,80}\bwrote:$|^From:\s|^_{5,}/i.test(l)) break;
    out.push(l);
    if (out.filter(Boolean).length >= maxLines) break;
  }
  return out.join('\n').trim();
}

const STOP_RE = /^\s*(?:please\s+)?(?:stop|unsubscribe|remove me|opt[\s-]?out|no thanks|not interested|do not (?:contact|email) me|take me off)\b/im;
const OOO_RE = /\b(?:out of (?:the )?office|on (?:annual |parental |maternity |paternity )?leave|on holiday|on vacation|away from (?:my|the) (?:desk|office)|automatic reply|auto[- ]?reply|autoreply|i am currently away|will be back on|thank you for (?:your (?:email|message)|contacting)[^.]{0,40}(?:we will|we'll) (?:respond|reply|get back))\b/i;

// The cases a regex gets right essentially always, and where being wrong is
// most expensive. Returns null when there is nothing certain to say.
export function deterministicIntent(input: ReplyInput): ReplyIntent | null {
  const body = ownWords(input.text);
  const auto = String(input.autoSubmitted ?? '');
  if (auto && !/^\s*no\b/i.test(auto)) return 'auto_reply';
  if (STOP_RE.test(body)) return 'stop';
  if (OOO_RE.test(`${input.subject ?? ''}\n${body}`)) return 'auto_reply';
  return null;
}

const SYSTEM = [
  'You label a reply to a sales email. Answer with one word from this list and nothing else:',
  '',
  'interested — they want to talk, or ask for a call, demo or more detail',
  'question — they ask something specific that needs an answer',
  'not_now — interested but say later, or ask to be contacted at another time',
  'not_interested — they decline',
  'wrong_person — it is not their area, or they point at somebody else',
  '',
  'If none of them clearly fits, answer: unclear',
  'Answer with the single word only. No punctuation, no explanation.',
].join('\n');

// The model's answer, or 'unclear'. Never anything else: whatever comes back
// is matched against the list, and a word that is not on it is not a label.
export function parseIntent(raw: string): ReplyIntent {
  const word = String(raw ?? '')
    .toLowerCase()
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, ' ')
    .replace(/[^a-z_\s]/g, ' ')
    .split(/\s+/)
    .find((w) => (REPLY_INTENTS as readonly string[]).includes(w) && w !== 'stop' && w !== 'auto_reply');
  return isReplyIntent(word) ? word : 'unclear';
}

export async function classifyReply(userId: number, input: ReplyInput): Promise<{ intent: ReplyIntent; route: ReplyRoute; byModel: boolean }> {
  const certain = deterministicIntent(input);
  if (certain) return { intent: certain, route: ROUTE_OF[certain], byModel: false };
  // A person who has not turned campaigns on has not agreed to their mail
  // being read for this, so an unlabelled reply simply goes to a person.
  if (!(await allowed(userId, 'ai.campaigns'))) return { intent: 'unclear', route: 'human_review', byModel: false };
  const body = ownWords(input.text);
  if (body.length < 3) return { intent: 'unclear', route: 'human_review', byModel: false };
  const messages = [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: `Subject: ${input.subject ?? ''}\n\n${body.slice(0, 2_000)}` },
  ];
  assertFreshConversation(messages);
  try {
    const raw = await chat({
      messages,
      // One word. A budget this small also means a model that starts
      // explaining itself runs out before it can say anything misleading.
      maxTokens: 8,
      temperature: 0,
      // Working out loud costs a whole reasoning budget to pick one of five
      // words that the first sentence of the reply already decides.
      noThink: true,
      background: true,
      owner: String(userId),
      consent: { userId, capability: 'ai.campaigns' },
    });
    const intent = parseIntent(raw);
    return { intent, route: ROUTE_OF[intent], byModel: true };
  } catch (e) {
    // A model that is down must not decide anybody's reply is uninteresting.
    log.warn('reply could not be classified; sending it to a person', { err: (e as Error).message });
    return { intent: 'unclear', route: 'human_review', byModel: false };
  }
}
