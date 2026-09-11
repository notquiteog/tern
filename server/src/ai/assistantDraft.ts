// A draft written by the assistant, held to the composer's standard.
//
// The assistant writes an email as the argument of `draft_email`, and until
// this existed none of the guarantees in prompts.ts or guard.ts applied to it:
// no clean-up, no greeting correction, no check on its figures, nothing to
// notice that it was not prose. The composer's draft path had every one of
// those, so the same model writing the same reply met two different standards
// depending on which button was pressed — and the assistant's was the one that
// let "the monthly fee is £4,250" through to a composer on a thread that said
// £950, and would have let word salad through just as readily.
//
// A draft that fails is not repaired and not shown. It goes back to the model
// as the tool's answer, saying what was wrong, and the model gets to write it
// again: an invented figure has no correct substitute that this code could
// choose, and garbled text has no edit that makes it an email.
import { cleanOutput, ensureGreeting, firstNameOf, stripModelSignature, type DraftMode } from './prompts.js';
import { describeHits, findGarbledText, findInventedSpecifics } from './guard.js';

export interface DraftVetting {
  raw: string;
  subject?: string;
  /** A reply in a thread, rather than a new message. */
  reply: boolean;
  recipient?: { name?: string; email?: string };
  senderName?: string;
  senderEmail?: string;
  /** Everything the draft may legitimately have taken a figure, a date or a writing system from. */
  facts: string;
}

export interface Vetted {
  /** The cleaned draft. Only meant to be shown when `refusal` is null. */
  body: string;
  /** What to tell the model instead of showing the draft, or null when it may be shown. */
  refusal: string | null;
  /** The guard's own reason, for the log. */
  why?: string;
}

export function vetDraft(v: DraftVetting): Vetted {
  const mode: DraftMode = v.reply ? 'reply' : 'compose';
  let body = stripModelSignature(cleanOutput(v.raw, mode), { recipient: v.recipient, senderName: v.senderName, senderEmail: v.senderEmail });
  // The salutation is corrected only when the recipient's name is known. The
  // composer's rule — greet nobody rather than guess — would otherwise turn
  // "Hi Bob," into "Hi there," when the person had simply told the assistant
  // who Bob is, in a message this function cannot see.
  if (firstNameOf(v.recipient?.name)) body = ensureGreeting(body, mode, v.recipient);
  body = body.trim();

  const garbled = findGarbledText(body, { context: v.facts });
  if (garbled.length) {
    const why = describeHits(garbled);
    return {
      body, why,
      refusal: `Nothing was put in front of the person: the draft came out garbled (${why}). Write it again as a short, plain email — ordinary sentences with full stops, no markup, in the language of the conversation — and call draft_email again.`,
    };
  }
  const invented = findInventedSpecifics(`${v.subject ?? ''}\n${body}`, { facts: v.facts });
  if (invented.length) {
    const why = describeHits(invented);
    return {
      body, why,
      refusal: v.reply
        ? `Nothing was put in front of the person: the draft states ${why}, which is not in the conversation being replied to and was not said by the person. Take figures and dates from that thread — read_thread lists every one it states — or say they will be confirmed, then call draft_email again.`
        : `Nothing was put in front of the person: the draft states ${why}, which nothing you were given says. Use only what you were given, or say it will be confirmed, then call draft_email again.`,
    };
  }
  return { body, refusal: null };
}

const MAIL_TOOLS = new Set(['search_mail', 'search_mail_exact', 'read_thread']);

/**
 * What a draft may legitimately have taken a figure from.
 *
 * For a reply: the thread, what the person said, and the system prompt (its
 * table of dates), plus anything this turn looked up EXCEPT other mail — a
 * search that wandered into somebody else's thread is precisely the source a
 * reply to this one must not borrow from. A new message has no thread, so
 * everything looked up counts.
 *
 * `draft_email`'s own answers never count. A refusal quotes the figure it
 * refused, and counting it made that same figure acceptable on the retry —
 * measured: "a date it was never given" was sent back, and then let through
 * the second time because the refusal had put it in the facts.
 */
export function draftFacts(v: { thread: string; reply: boolean; seen?: { said: string; system: string; results: { name: string; text: string }[] } }): string {
  return [
    v.thread,
    v.seen?.said ?? '',
    v.seen?.system ?? '',
    ...(v.seen?.results ?? [])
      .filter((r) => r.name !== 'draft_email' && (!v.reply || !MAIL_TOOLS.has(r.name)))
      .map((r) => r.text),
  ].join('\n\n');
}
