// Prompt construction for the drafting assistant. Small models follow short,
// concrete instructions best, so every prompt states the format once and
// gives the model the facts it is allowed to use instead of letting it guess.
import type { ChatMessage } from './llm.js';
import { cleanRecipientName, firstNameOf } from './names.js';
import { extractSpecifics } from './guard.js';

export type DraftMode = 'compose' | 'reply' | 'rewrite' | 'shorten' | 'expand' | 'summarize' | 'subject' | 'personalize' | 'polish' | 'quick_replies' | 'gist' | 'reschedule' | 'nudge';

export interface DraftInput {
  mode: DraftMode;
  instruction?: string;
  tone?: string;
  length?: 'short' | 'medium' | 'long';
  senderName?: string;
  senderEmail?: string;
  senderCompany?: string;
  signatureHint?: string;
  recipient?: { name?: string; email?: string; company?: string; title?: string; notes?: string; fields?: Record<string, unknown> };
  thread?: { from: string; date: string; text: string }[];
  draft?: string;
  template?: string;
  subject?: string;
  systemPrompt?: string;
  voice?: string;
  // The ledger entry a reschedule or a nudge is about. Every field here comes
  // out of the database rather than off the wire: the promise the email
  // apologises for has to be the promise that was recorded, or the model is
  // being asked to apologise for whatever the browser last said.
  commitment?: {
    kind: 'owed' | 'awaiting';
    what: string;
    /** What the person typed into the "why" box. Their words, not the model's. */
    reason?: string;
    /** The date it was originally due, written out, or absent if it never had one. */
    was?: string;
    /** The new date, written out, or absent when there is not one yet. */
    now?: string;
  };
  // What the sender's calendar says about the days this email is about (F13).
  //
  // Times only, and never titles: the model is told "you are busy from two
  // until three on Thursday", not what the meeting is. The point is to stop
  // it proposing a time that is already taken — which it did constantly
  // before there was a calendar to check — without handing a language model
  // the contents of somebody's diary.
  availability?: {
    /** How the days read where the sender is, e.g. "Thursday 10 September". */
    days: { day: string; busy: string[]; free: string[] }[];
    tz?: string;
  };
  // How many characters of the conversation may be spent. Derived from the
  // model's context window by `threadBudgetChars`; the default suits the
  // 8192-token window Tern ships with.
  threadChars?: number;
}

// The default system prompt. Every line of it exists because of a failure
// that was measured rather than imagined, and the list is kept short because
// a 4B model drops instructions once there are too many of them to hold.
//
//   "write around it"          — the strongest result in the evaluation was
//                                that models do not leave a gap alone. Told
//                                only "never invent", they invent anyway;
//                                given something to do instead, they do it.
//   "cannot attach"            — "I have attached the plan" was the single
//                                most frequent hold reason in the guard.
//   "no notes about these"     — a campaign preview came back with the model
//                                arguing with its own instructions inside the
//                                email, at length.
//   "greeting on its own line" — several runs collapsed greeting, body and
//                                sign-off onto one line, which nobody sends.
export const DEFAULT_SYSTEM_PROMPT = `You are an email writing assistant inside a mail client. You write in the sender's voice: clear, warm, specific and brief. Rules:
- Output only the email itself. No preamble, no "Here is", no markdown, no bullet symbols unless asked, no quoted email, and no notes about these instructions.
- Use only the facts you have been given. If something you need is missing, write around it or say you will confirm it — never supply a figure, price, date, time or name yourself.
- You cannot attach or enclose anything. Never write that a document is attached.
- Do not add a subject line unless asked for one.
- Do not add a signature block; the client appends one.
- Plain paragraphs with a blank line between them. The greeting is a line of its own.`;

const LENGTH: Record<string, string> = {
  short: 'Keep it to 2-4 sentences.',
  medium: 'Keep it to one or two short paragraphs, under 120 words.',
  long: 'Up to three paragraphs, under 220 words.',
};

// A word ceiling for the editing modes, taken from the draft the person
// actually wrote rather than from a fixed number.
function draftLimit(draft: string | undefined, factor: number): string {
  const words = (draft ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return '';
  const cap = Math.max(20, Math.round(words * factor));
  return `The draft is ${words} words; your answer is at most ${cap} words.`;
}

// Temperature and token ceiling per mode, so the composer, the responders and
// the campaigns all treat the same job the same way. A transformation of
// text the person wrote wants to be literal; a first draft wants some room.
// Sequences that end a generation early. A small model that has finished the
// email sometimes keeps going and starts the next turn of a conversation it
// was never in — "User: thanks!" — or answers its own draft. Cutting that off
// at the model saves the tokens; `finalizeOutput` still tidies what arrives.
// These are not an admin setting: they are about the shape of the request,
// not about how the assistant writes.
const TURN_STOPS = ['\nUser:', '\nAssistant:', '\nHuman:', '\nSystem:'];

export function modeTuning(mode: DraftMode): { temperature?: number; maxTokens?: number; threadChars?: number; stop?: string[] } {
  switch (mode) {
    // One line, both of them: the first newline ends the answer, which is
    // what stops "Subject: Quick question" arriving with a whole email
    // attached underneath it.
    case 'subject': return { temperature: 0.3, maxTokens: 60, stop: [...TURN_STOPS, '\n'] };
    case 'polish': return { temperature: 0.2, stop: TURN_STOPS };
    case 'rewrite': case 'shorten': return { temperature: 0.4, stop: TURN_STOPS };
    case 'expand': return { temperature: 0.5, stop: TURN_STOPS };
    case 'summarize': return { temperature: 0.3, maxTokens: 400, stop: TURN_STOPS };
    // One line above a conversation in the list. It has to be cheap enough to
    // run over a page of mail on a CPU-only box, so it gets a small budget and
    // only the newest part of the thread.
    case 'gist': return { temperature: 0.2, maxTokens: 60, threadChars: 4_000, stop: [...TURN_STOPS, '\n'] };
    // Three one-liners answer the last thing that was said. Handed the whole
    // of a long thread the model starts summarising it instead, in one long
    // sentence, and there is nothing to pick from.
    case 'quick_replies': return { temperature: 0.8, maxTokens: 220, threadChars: 3_000, stop: TURN_STOPS };
    // Both are short emails about one specific thing, and both are the kind
    // of message people make worse by writing more of. A low temperature
    // because there is nothing here to be creative about: the facts are the
    // promise, the reason and the date, and all three were given.
    case 'reschedule': case 'nudge': return { temperature: 0.45, maxTokens: 320, stop: TURN_STOPS };
    default: return { stop: TURN_STOPS };
  }
}

function recipientBlock(r?: DraftInput['recipient']): string {
  if (!r) return '';
  const lines: string[] = [];
  const name = cleanRecipientName(r.name);
  if (name) lines.push(`Name: ${name}`);
  if (r.email) lines.push(`Email: ${r.email}`);
  if (r.company) lines.push(`Company: ${r.company}`);
  if (r.title) lines.push(`Title: ${r.title}`);
  for (const [k, v] of Object.entries(r.fields ?? {})) if (v !== null && v !== '' && v !== undefined) lines.push(`${k}: ${String(v)}`);
  if (r.notes) lines.push(`Notes: ${r.notes}`);
  return lines.length ? `Recipient facts (use only these):\n${lines.join('\n')}` : '';
}

// How much of a conversation the model is shown. The old rule — the last six
// messages — reads a long thread from the wrong end: in a real negotiation
// the dates, the numbers and the names are agreed early and then referred to
// as "what we said at the start", so a reply built from the tail alone
// invents them or leaves them out.
//
// Instead the thread is packed to a character budget from both ends: the
// newest messages, which are what is being answered, and the opening ones,
// where the terms were set. Only the middle is dropped, and the prompt says
// how many messages went, so the model knows the conversation is longer than
// what it can see rather than assuming it started late.
// An upper bound rather than the operative limit. It used to be 14,000,
// which is about 4,400 tokens — below that, `num_ctx` had no effect on how
// much conversation the model was shown at all, so raising the context
// window in Admin → AI model changed nothing a reader would notice. The
// window is the control; this is only here so that a mistaken num_ctx of a
// million does not try to build a megabyte prompt.
export const THREAD_CHARS_DEFAULT = 60_000;
const NEWEST_MSG_CHARS = 4_000; // the message being replied to, near enough in full
const OLDER_MSG_CHARS = 1_400;
// The share of the budget reserved for the start of the conversation, before
// the newest messages are allowed to spend the rest. Without a reservation
// the newest end takes everything — see `threadBlock` — and the terms that
// were agreed in the first few messages are the ones a long thread refers
// back to as "what we said at the start".
const OPENING_SHARE = 0.45;

// Characters of thread that fit alongside the instructions and the answer.
// Roughly 3.2 characters per token, minus room for the prompt scaffolding and
// whatever the model is about to write.
export function threadBudgetChars(numCtx: number, maxTokens: number): number {
  // How much of the window to keep back for the answer and the instructions.
  //
  // `maxTokens` of 0 means the generation is uncapped (see llm.ts DEFAULTS),
  // and there is then no number to reserve against — so this uses an estimate
  // of what a long reply costs. That estimate is NOT a ceiling and is never
  // sent anywhere: it only decides how much thread to include, and being
  // wrong about it makes the thread slightly longer or shorter rather than
  // truncating anything the model produces.
  const UNCAPPED_REPLY_ESTIMATE = 1_500;
  const generation = maxTokens > 0 ? Math.max(400, maxTokens) : UNCAPPED_REPLY_ESTIMATE;
  const reserve = generation + 600; // generation + instructions, in tokens
  return Math.max(2_400, Math.min(THREAD_CHARS_DEFAULT, Math.round((numCtx - reserve) * 3.2)));
}

function trimMessage(text: string, cap: number): string {
  const t = text.trim();
  return t.length <= cap ? t : `${t.slice(0, cap).replace(/\s+\S*$/, '')} […]`;
}

function threadBlock(t?: DraftInput['thread'], senderEmail?: string, budget = THREAD_CHARS_DEFAULT): string {
  if (!t?.length) return '';
  const mine = (from: string) => Boolean(senderEmail && from.toLowerCase().includes(senderEmail.toLowerCase()));
  const render = (i: number) =>
    `--- From ${t[i].from}${mine(t[i].from) ? ' (this is the sender, you)' : ''} on ${t[i].date}\n${trimMessage(t[i].text, i === t.length - 1 ? NEWEST_MSG_CHARS : OLDER_MSG_CHARS)}`;

  const keep = new Set<number>();
  let used = 0;
  const take = (i: number, len: number) => { keep.add(i); used += len; };

  // 1. The last three messages, whatever they cost. This is what is being
  //    answered, and a reply that cannot see it is not a reply.
  for (let i = t.length - 1; i >= 0 && keep.size < 3; i--) take(i, render(i).length);

  // 2. The opening, oldest first, out of its own reserved share of the
  //    budget.
  //
  //    The reservation is the whole point and it used to be missing: the
  //    newest-first pass ran to exhaustion first, so on any thread long
  //    enough to need trimming it took the entire budget and the opening
  //    loop below never added a single message. "Packed from both ends" was
  //    true of the code's intent and false of its behaviour, and the fixture
  //    it was tested against was too short to ever find out — every message
  //    fit, so nothing was ever dropped.
  //
  //    On a realistic 24-message thread the effect was total: only the last
  //    ten messages survived, and the year end, the blackout and the monthly
  //    figure — all agreed in the first half — were absent from the prompt
  //    the model was asked to recall them from.
  const openingCap = budget * OPENING_SHARE;
  let opening = 0;
  for (let i = 0; i < t.length; i++) {
    if (keep.has(i)) continue;
    const len = render(i).length;
    if (opening + len > openingCap || used + len > budget) break;
    take(i, len);
    opening += len;
  }

  // 3. Whatever is left goes to the most recent messages still missing, so a
  //    thread that fits entirely is shown entirely.
  for (let i = t.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const len = render(i).length;
    if (used + len > budget) break;
    take(i, len);
  }

  const shown = [...keep].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let n = 0; n < shown.length; n++) {
    const gap = n === 0 ? 0 : shown[n] - shown[n - 1] - 1;
    if (gap > 0) parts.push(`--- (${gap} message${gap === 1 ? '' : 's'} in the middle of the thread omitted)`);
    parts.push(render(shown[n]));
  }
  const header = shown.length < t.length
    ? `Conversation so far (oldest first; ${t.length} messages in total, some of the middle omitted):`
    : 'Conversation so far (oldest first):';
  return `${header}\n${parts.join('\n')}`;
}

// The From name on a message is whatever the other person's client put
// there, and a responder answers real mail: it arrives as "Osei, Dana", as
// "DANA OSEI", as "Dana Osei | Northwind Supply", as "Dr Dana Osei, ACA",
// with an emoji in it, and often as the address itself. Deciding which of
// those is a name a greeting may use is not a writing problem, so it does not
// live in a prompt: see ai/names.ts, which is also what guard.ts checks the
// finished email against.
export { cleanRecipientName, firstNameOf } from './names.js';

// Who the email is to, stated once and plainly. Small models otherwise pick a
// name out of the thread, or invent one, and greet the wrong person.
function addressingBlock(input: DraftInput): string {
  if (!['compose', 'reply', 'personalize', 'reschedule', 'nudge'].includes(input.mode)) return '';
  const r = input.recipient;
  const name = cleanRecipientName(r?.name);
  const first = firstNameOf(r?.name);
  if (name && first) {
    return `Write to ${name}${r?.email ? ` <${r.email}>` : ''}. The first line of the email is exactly "Hi ${first}," and no other name is used for them. Speak to them as "you".`;
  }
  if (r?.email) return `Write to ${r.email}. Their name is not known: the first line is exactly "Hi there," and no name is guessed or invented.`;
  return `The recipient's name is not known: the first line is exactly "Hi there," and no name is guessed or invented.`;
}

// The figures and dates the conversation has already settled, listed.
//
// This exists because of a measurement rather than a theory. With the context
// window raised until a 50-message thread fitted whole — nothing truncated at
// all — the model still could not reliably answer "what was the monthly
// figure we agreed?" on a thread of 8,500 tokens. The fact was in front of it
// and it wrote a different number. Depth defeats retrieval well before it
// defeats the window.
//
// Extracting them is not a language problem. A money amount, a date, a clock
// time and a contractual term all have shapes, and guard.ts already has to
// recognise every one of them in order to tell an invented figure from a
// repeated one. So the same extractor is run over the *whole* conversation —
// including the middle that the character budget dropped — and what it finds
// is put in front of the model as facts rather than left to be found.
//
// The model still writes the email. It is simply no longer asked to also be a
// search index over twenty thousand characters of quoted mail.
const FACT_CONTEXT_CHARS = 90;
const MAX_FACTS = 14;

// The scaffolding a mail client adds, which is not part of what anybody said.
// Without this the extraction is swamped by the timestamps in quote
// attribution lines — "On Wed, 03 Jun 2026 11:12:00, Dana Osei wrote:" — and
// the figures that matter get pushed out by the dates of the emails
// themselves.
function saidAloud(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('>')) return false;                                  // quoted text
      if (/^On\b.{5,140}\bwrote:\s*$/i.test(t)) return false;              // attribution
      if (/^-{2,}\s*(?:forwarded|original) message/i.test(t)) return false; // forward header
      if (/^(?:from|to|cc|sent|date|subject):\s/i.test(t)) return false;    // pasted headers
      if (/^\+?[\d\s()+-]{9,}$/.test(t)) return false;                     // a phone number in a signature
      return true;
    })
    .join('\n');
}

// Money first, then a calendar date, then a contractual term, then a clock
// time. When there are more facts than room, the ones that cost money or
// commit to a day are the ones worth the space.
const FACT_RANK: Record<string, number> = { money: 0, pct: 1, recur: 2, day: 3, when: 4, term: 5, time: 6 };
const rankOf = (token: string) => FACT_RANK[token.split(':')[0]] ?? 9;

export function agreedFactsBlock(thread: DraftInput['thread']): string {
  if (!thread?.length) return '';
  const seen = new Set<string>();
  const found: { rank: number; line: string }[] = [];
  for (const m of thread) {
    const text = saidAloud(m.text);
    for (const spec of extractSpecifics(text)) {
      if (seen.has(spec.token)) continue;
      seen.add(spec.token);
      // The phrase around it, so a bare number is never offered without the
      // thing it is the number of.
      const at = text.indexOf(spec.sample);
      const from = Math.max(0, at - FACT_CONTEXT_CHARS / 2);
      const around = (at < 0 ? text.slice(0, FACT_CONTEXT_CHARS) : text.slice(from, at + spec.sample.length + FACT_CONTEXT_CHARS / 2))
        .replace(/\s+/g, ' ')
        .trim();
      found.push({ rank: rankOf(spec.token), line: `- ${spec.sample.trim()} — "…${around}…"` });
    }
  }
  if (!found.length) return '';
  const lines = found.sort((a, b) => a.rank - b.rank).slice(0, MAX_FACTS).map((f) => f.line);
  return `Figures, dates and terms already stated in this conversation, taken from it word for word. Use these exactly where the reply needs them, and state no others:\n${lines.join('\n')}`;
}

// What the sender's diary says, as a few lines the model can act on.
//
// Kept deliberately blunt. A model given a table of ISO timestamps reasons
// about time zones and gets it wrong; given "Thursday 10 September — busy
// 09:00-10:00, 14:00-15:30; free 10:00-12:00" it simply picks a free one.
export function availabilityBlock(a: DraftInput['availability']): string {
  if (!a?.days?.length) return '';
  const lines = a.days.slice(0, 7).map((d) => {
    const busy = d.busy.length ? `busy ${d.busy.slice(0, 6).join(', ')}` : 'nothing booked';
    const free = d.free.length ? `; free ${d.free.slice(0, 4).join(', ')}` : '';
    return `- ${d.day}: ${busy}${free}`;
  });
  return [
    `The sender's calendar${a.tz ? ` (times in ${a.tz})` : ''}:`,
    ...lines,
    // Without this the model treats the list as a suggestion and proposes a
    // time inside a busy block anyway, roughly one time in four.
    'Never propose or agree to a time that falls inside a busy period above. If none of the free periods suits what is being asked, say you will check your diary and come back rather than naming a time.',
  ].join('\n');
}

export function buildMessages(input: DraftInput): ChatMessage[] {
  const tone = input.tone ? `Tone: ${input.tone}.` : 'Tone: friendly and professional.';
  const len = LENGTH[input.length ?? 'medium'];
  const senderFirst = input.senderName?.trim().split(/\s+/)[0];
  const sender = [input.senderName ? `You are writing as ${input.senderName}${input.senderEmail ? ` <${input.senderEmail}>` : ''}. If you sign off, use only "${senderFirst}".` : '', input.senderCompany ? `Sender's company: ${input.senderCompany}` : ''].filter(Boolean).join('\n');
  const parts: string[] = [];
  switch (input.mode) {
    case 'compose':
      parts.push(`Write a new email.`, `Goal: ${input.instruction || 'Introduce the sender and ask for a short call.'}`, tone, len);
      break;
    case 'reply':
      parts.push(
        `Write a reply to the latest message in the conversation.`,
        input.instruction ? `What the reply should do: ${input.instruction}` : 'Answer what was asked and move the conversation forward.',
        // A long thread refers back to what was agreed early on. The figures
        // and dates are in the conversation below; a small model that does
        // not go looking for them makes them up instead.
        `If the latest message asks you to confirm or repeat something agreed earlier, find it in the conversation below and repeat it exactly — the same dates, names and numbers. If it is not there, say you will check rather than guessing it.`,
        tone, len,
      );
      break;
    // The four editing modes work on text the person already wrote. Left
    // without a ceiling a small model treats them as an invitation to write
    // a fresh, longer email of its own, so each one is anchored to the
    // length of the draft it was given.
    case 'rewrite':
      parts.push(`Rewrite the draft below. Keep the meaning, every fact and the same ask; improve clarity and flow. Do not add a subject line and do not add anything that is not in the draft.`, input.instruction ? `Direction: ${input.instruction}` : '', draftLimit(input.draft, 1.1), tone);
      break;
    case 'polish':
      parts.push(`Fix grammar, spelling and awkward phrasing in the draft below. Change as little as possible: keep every word that is already correct, and never change a date, a time, a name or a number. Return the corrected draft only.`, draftLimit(input.draft, 1.1));
      break;
    case 'shorten':
      parts.push(`Shorten the draft below to about half its length without losing the ask.`, draftLimit(input.draft, 0.6), tone);
      break;
    case 'expand':
      parts.push(`Expand the draft below with one more concrete, useful sentence per paragraph. No filler.`, draftLimit(input.draft, 2), tone);
      break;
    case 'summarize':
      parts.push(`Summarize the conversation in 2-4 plain sentences: what was discussed, what was decided, what is still open. Keep any dates, amounts and names exactly as they appear. Then, on a new line starting with "Next:", state the single most useful next action for the sender.`);
      break;
    case 'gist':
      // The subject is already on the row above this line, so repeating it
      // wastes the only line there is. What the reader wants is the point:
      // what is being asked of them, or what changed.
      parts.push(`In one line of at most 14 words, say what this message is actually about — what it asks for, or what it says has happened. Do not repeat the subject line. Do not start with "This email" or the sender's name. No quotes, no full stop at the end. Output that one line and nothing else.`);
      break;
    case 'subject':
      parts.push(`Write one subject line for the email below. At most 7 words, no quotes, no trailing punctuation. Output the subject line only, nothing else.`);
      break;
    case 'personalize':
      parts.push(
        `Write the email the sender will send to the recipient below, in the first person ("I", "we") and speaking to the recipient as "you". The brief is the message to deliver; say it in the sender's words, do not describe or summarise it. Use at most two of the recipient facts, naturally, without saying you have facts about them.`,
        // A brief ends in the thing the email is for. Left to itself a small
        // model paraphrases the offer at length and drops the ask, which is
        // the only part that needed to survive.
        `Every specific in the brief — the offer, the price, the dates, and the question it ends with — appears in the email, in the brief's own words where it is a number or a date. The last paragraph is the ask. Write in ordinary sentences, not one long one.`,
        input.instruction ? `Extra direction: ${input.instruction}` : '', tone, len,
      );
      break;
    // ---------- Moving a commitment ----------
    //
    // Both of these are written from the ledger, and both fail in the same
    // way if the model is left to its own devices: it writes a paragraph of
    // apology or chasing that never names the thing. So the promise, the
    // reason and the date are stated as facts it must use, and the shape of
    // the email is prescribed sentence by sentence.
    case 'reschedule': {
      const c = input.commitment;
      parts.push(
        `Write a short email telling the recipient that something you promised them is going to be late.`,
        c?.what ? `What you promised: ${c.what}` : '',
        c?.was ? `You had said: ${c.was}.` : '',
        c?.reason ? `Why it has slipped, in the sender's own words: ${c.reason}` : '',
        c?.now
          ? `The new commitment is ${c.now}. State that date plainly and do not hedge it with "hopefully" or "I aim to".`
          : `There is no new date yet. Say when you will be able to give one, or ask what would work — do not invent a date.`,
        // The failure mode this exists to prevent: a small model handed
        // "sorry" writes four sentences of contrition and never says what
        // is late or when it will arrive.
        `Structure: acknowledge the specific thing you owe them, give the reason in one clause, state the new date, and offer nothing else. Three or four sentences in total.`,
        `Apologise exactly once and briefly. Do not grovel, do not say "I sincerely apologise for any inconvenience this may have caused", and do not thank them for their patience more than once.`,
        `Do not promise anything that was not stated above, and do not offer a discount, a call or a favour to make up for it.`,
        tone,
      );
      break;
    }
    case 'nudge': {
      const c = input.commitment;
      parts.push(
        `Write a short, friendly email following up on something the recipient said they would do and has not done yet.`,
        c?.what ? `What you are waiting for: ${c.what}` : '',
        c?.was ? `They had said: ${c.was}.` : '',
        c?.reason ? `Context the sender has added: ${c.reason}` : '',
        // A nudge that opens by reciting how late somebody is has already
        // lost. The useful version assumes it was missed, not withheld.
        `Assume it was simply missed rather than ignored: no reproach, no counting of days, no "as per my last email".`,
        `Structure: say what you are following up on, ask plainly whether it is still on track, and make it easy to answer. Two or three sentences in total.`,
        c?.now ? `Say that you need it by ${c.now}, once, without repeating it.` : '',
        `Do not state any date, figure or detail that is not given above.`,
        tone,
      );
      break;
    }
    case 'quick_replies':
      parts.push(
        `Suggest three different short replies the sender could send to the last message in the conversation. Answer only that message; do not summarise the thread. Output exactly three lines and then stop. One reply per line, each a complete sentence of at most 12 words, in the first person. Vary them: one agrees or confirms, one asks a question or proposes a time, one politely declines or defers. No numbering, no bullets, no quotes, no greeting, no sign-off, no explanation.`,
        // These are conversational moves, not answers. Only the newest part
        // of the thread is shown, so a suggestion that states a date or a
        // figure is stating one it cannot see — and it goes into the
        // composer the moment someone clicks it.
        // The rule used to be "never state a specific", which is safe and
        // needlessly unhelpful: when the other person has just proposed
        // Thursday, "Thursday morning works" is the reply somebody wants to
        // click. What must not happen is a suggestion inventing a specific
        // out of the part of the thread it cannot see — so the rule is about
        // provenance rather than about specifics, and `findInventedSpecifics`
        // checks it afterwards rather than trusting it.
        `Do not state any date, time or amount that is not already written in the conversation above. If it is not there, say "I will confirm the dates" rather than naming them.`,
        tone,
      );
      break;
  }
  const ab = addressingBlock(input); if (ab) parts.push(ab);
  if (sender) parts.push(sender);
  // A voice note is the sender's own instruction and usually wins, but it is
  // written for ordinary prose and often says something like "never use
  // greetings". Left ambiguous, a reasoning model spends its whole budget
  // arguing with itself about which rule to follow, and a small one drops
  // the salutation and greets nobody.
  if (input.voice?.trim()) parts.push(`Sender's voice and preferences (follow these${ab ? ', except where they contradict the first line stated above, which always wins' : ''}):\n${input.voice.trim()}`);
  const rb = recipientBlock(input.recipient); if (rb) parts.push(rb);
  const tb = threadBlock(input.thread, input.senderEmail, input.threadChars); if (tb) parts.push(tb);
  // Only where the job is to answer from the conversation. A quick reply is
  // forbidden from stating a figure at all, and an editing mode is working on
  // the person's own draft.
  if (['reply', 'summarize'].includes(input.mode)) {
    const fb = agreedFactsBlock(input.thread); if (fb) parts.push(fb);
  }
  // Only the modes that can commit the sender to a time. A summary or a
  // subject line has no business knowing the diary, and spending context on
  // it would cost the conversation room it needs.
  if (['reply', 'compose', 'reschedule', 'nudge', 'quick_replies'].includes(input.mode)) {
    const avb = availabilityBlock(input.availability); if (avb) parts.push(avb);
  }
  if (input.subject && input.mode !== 'subject') parts.push(`Subject of this email: ${input.subject}`);
  if (input.template) parts.push(`Brief / template:\n${input.template}`);
  if (input.draft) parts.push(input.mode === 'subject' ? `Email:\n${input.draft}` : `Draft:\n${input.draft}`);
  return [
    { role: 'system', content: input.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ];
}

// Every call to the model is a fresh, single-turn conversation: one system
// prompt and one user message built from this task's inputs alone. Nothing
// from earlier requests, other users or previous outputs is ever carried
// over. The transport refuses anything else so this cannot regress.
//
// This is still true of every task in the app — drafting, summaries,
// responders, campaigns, rules, the brief, reply intent. The assistant is the
// one deliberate exception, and it does not get here by relaxing this rule.
// It has a rule of its own, directly below, because "the guard did not apply"
// and "a different guard applied" are very different things to find in a
// codebase a year from now.
export function assertFreshConversation(messages: ChatMessage[]): void {
  const roles = messages.map((m) => m.role);
  if (roles.length !== 2 || roles[0] !== 'system' || roles[1] !== 'user') {
    throw new Error(`AI requests must be a fresh conversation (system + user), got: ${roles.join(', ') || 'nothing'}`);
  }
}

/**
 * The assistant's transcript rule — the second of the two, and the only place
 * in Tern where a conversation is allowed to have a past.
 *
 * ── Why there is an exception at all ────────────────────────────────────────
 *
 * Because a person asked for one. A conversation you can ask a follow-up
 * question in cannot be built out of single-turn requests: "now make it
 * shorter" means nothing without the thing it refers to, and a tool loop is
 * by construction system → user → assistant(asks for a tool) → tool(answers)
 * → assistant, which is four turns before anybody has said anything twice.
 *
 * ── Why it is a rule rather than an absence of one ──────────────────────────
 *
 * The easy version of this feature deletes the guard on the agent's path and
 * moves on. That version cannot tell a conversation from a pile of messages,
 * which matters because the pile is attacker-shaped: a tool result is text
 * that came from somewhere else — a mailbox, a contact, a web of quoted
 * replies — and the difference between "a tool answered the call the model
 * just made" and "something inserted a turn claiming a tool said so" is the
 * whole security boundary of a tool-calling agent.
 *
 * So the shape is checked, and checked strictly:
 *
 *   - Exactly one system message, first. Not several joined, not one in the
 *     middle: an instruction arriving mid-transcript is the classic way to
 *     talk a model out of the rules it opened with.
 *   - The first thing after it is the person. A transcript that opens with an
 *     assistant turn is one where somebody else has put words in its mouth.
 *   - A `tool` message answers a call made by the assistant message directly
 *     before it, matched on `toolCallId`. A tool result with no call, a
 *     result answering a call from an earlier turn, and two results for one
 *     call are all refused — those are the three shapes a smuggled result
 *     takes.
 *   - Every call the assistant made is answered before it speaks again, so a
 *     turn cannot be dropped to hide what the model asked for.
 *
 * What this deliberately does NOT check is content. Nothing here reads the
 * text; it reads the shape. Whether a tool should have been called at all is
 * the tool's own business — see `ai/tools.ts`, where each one carries the
 * capability it needs — and whether the answer is fit to send is the person's,
 * which is why nothing the assistant produces leaves the box without a click.
 */
export function assertAgentTranscript(messages: ChatMessage[]): void {
  const shape = (): string => messages.map((m) => m.role).join(', ') || 'nothing';
  if (messages.length < 2) throw new Error(`An assistant transcript needs a system prompt and a first message, got: ${shape()}`);
  if (messages[0]!.role !== 'system') throw new Error(`An assistant transcript must open with its system prompt, got: ${shape()}`);
  if (messages[1]!.role !== 'user') throw new Error(`An assistant transcript must open with the person's own message, got: ${shape()}`);

  // Calls the assistant has made and nobody has answered yet. It is emptied
  // as results arrive, so "did every call get an answer" is a size check at
  // the point the model is about to speak again.
  let awaiting = new Set<string>();
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'system') throw new Error('An assistant transcript carries one system prompt, at the front; a later one would be an instruction arriving mid-conversation.');
    if (m.role === 'tool') {
      const id = String(m.toolCallId ?? '');
      if (!id) throw new Error('A tool result must say which call it answers.');
      if (!awaiting.has(id)) throw new Error(`A tool result answers a call the assistant did not just make (${id}).`);
      awaiting.delete(id);
      continue;
    }
    // An assistant or user turn: everything the assistant asked for must
    // already have come back.
    if (awaiting.size) throw new Error(`The assistant asked for ${awaiting.size} tool result(s) that never arrived.`);
    if (m.role === 'assistant') {
      awaiting = new Set((m.toolCalls ?? []).map((c) => c.id));
      if (awaiting.size !== (m.toolCalls ?? []).length) throw new Error('Two tool calls in one turn share an id.');
    }
  }
}

// Small models sometimes wrap output in quotes or add a label anyway.
// A subject line, out of whatever came back.
//
// The prompt asks for at most seven words. Asked for a subject for a campaign
// email, the model this ships with returned an entire email on one line —
// greeting, body, closing question, 40 words of it — and because it was one
// line, taking the first line kept all of it. It went into the preview as the
// subject, which is what a recipient would have seen in their inbox.
//
// Nothing about that is fixable by asking more firmly, so it is cut here: the
// first sentence, and failing that the first clause, and failing that a hard
// truncation on a word boundary. A greeting at the front is dropped, because
// a subject that opens "Hi Dana," is a subject that started life as an email.
const SUBJECT_MAX_CHARS = 90;
const SUBJECT_MAX_WORDS = 14;

export function trimToSubject(raw: string): string {
  let t = raw.trim().replace(/^(?:hi|hello|hey|dear)\b[^,!.]{0,40}[,!.]\s*/i, '').trim();
  if (!t) return '';
  const short = (v: string) => v.length <= SUBJECT_MAX_CHARS && v.split(/\s+/).length <= SUBJECT_MAX_WORDS;
  if (short(t)) return t;
  // The first sentence.
  const sentence = t.split(/(?<=[.!?])\s+/)[0]?.trim() ?? t;
  if (sentence && short(sentence)) return sentence.replace(/[.!]+$/, '');
  // The first clause.
  const clause = (sentence || t).split(/\s+[—–-]\s+|[;:,]\s+/)[0]?.trim() ?? t;
  if (clause && short(clause)) return clause.replace(/[.!]+$/, '');
  // Whatever is left, cut on a word boundary.
  return (clause || t).split(/\s+/).slice(0, SUBJECT_MAX_WORDS).join(' ').slice(0, SUBJECT_MAX_CHARS).replace(/\s+\S*$/, '').replace(/[.!,;:]+$/, '').trim();
}

export function cleanOutput(text: string, mode: DraftMode): string {
  let t = text.trim();
  // Ollama hands reasoning back on its own field, but an OpenAI-compatible
  // endpoint (or a model answering through a plain completion template) puts
  // it inline in <think> tags. It is never part of the email. An unclosed
  // tag means the budget ran out mid-thought, and everything after it is
  // working-out too.
  t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/<think(?:ing)?>[\s\S]*$/i, '').replace(/^[\s\S]*?<\/think(?:ing)?>/i, '').trim();
  t = t.replace(/^(?:sure[,!.]?\s*)?(here(?:'s| is) (?:the|a|an|your|my) [^:\n]{0,80}:\s*)/i, '');
  t = t.replace(/^```[a-z]*\n?|\n?```$/g, '');
  // Small models like to add a speaker label or markdown emphasis; email is plain text.
  t = t.replace(/^\*{0,2}[A-Z][A-Za-z .'-]{0,40}:\*{0,2}\s*(?=\S)/, (m) => (/^\*{0,2}(subject|re|dear|hi|hello|hey)\b/i.test(m) ? m : ''));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
  t = t.replace(/^Subject:.*\n+/i, (m) => (mode === 'subject' ? m : ''));
  // A small model sometimes carries on past the reply and echoes the prompt:
  // a "--- From" thread line, the facts block, an imagined next message.
  // Everything from the first such line on is not the email.
  const echo = t.search(/\n\s*(?:-{3,}(?:\s*From\b.*)?\s*$|Subject of this email:|Recipient facts|Conversation so far|Sender's voice|Write to |Draft:\s*$)/im);
  if (echo > 0) t = t.slice(0, echo).trim();
  if (mode === 'subject') {
    t = t.split('\n')[0].replace(/^subject:\s*/i, '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!]+$/, '').trim();
    t = trimToSubject(t);
  }
  return t.trim();
}


// A date the model can put in a sentence.
//
// Everywhere else in this file a date is handed over as `toDateString()` —
// "Thu Sep 11 2026" — which is fine as a fact in a list the model reads, and
// wrong as something it must copy into prose: it either repeats the machine
// form verbatim or reformats it and gets the day of the week wrong. So the
// one place a date is meant to be written out gets it written out.
//
// The time only appears when there is one. A due date is midnight and saying
// "at 00:00" would be worse than saying nothing; a slot picked off the
// calendar is a real time and dropping it would lose the whole point.
export function writeDate(iso: string, tz?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const zone = (() => {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return undefined; }
  })();
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' }).format(at);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  return hm === '00:00' ? day : `${day} at ${hm}`;
}

// ---------- Guarantees the model cannot be trusted with ----------

// The salutation and whatever name it used. The name runs to the first
// comma, colon or exclamation mark — not to the first full stop, because a
// display name that is really an address ("Hi dana@northwind.example,") has
// full stops inside it and cutting there leaves half of it behind as text.
// The punctuation that ends a salutation. Written out rather than assumed to
// be ASCII, because it is not: a model writing to 田中優希 ends the greeting
// with a fullwidth comma (U+FF0C), and with only `[,:!]` in the terminator
// class the capture below ran to the end of the line and the rewrite then
// deleted the whole first paragraph. The model had written a perfectly good
// email; 185 characters of it were thrown away in the clean-up pass.
const SALUTATION_END = ',\uFF0C\u3001;\uFF1B:\uFF1A!\uFF01?\uFF1F\u2014';
const GREETING_RE = new RegExp(`^\\s*(hi|hello|hey|dear|good (?:morning|afternoon|evening))\\b[\\s,\uFF0C]*([^\\n${SALUTATION_END}]*)[${SALUTATION_END}]?`, 'i');
const NEUTRAL = new Set(['there', 'all', 'team', 'everyone', 'both', 'folks', 'friend', 'sir', 'madam', 'sir or madam', '']);

export interface FinalizeContext { recipient?: DraftInput['recipient']; senderName?: string; senderEmail?: string; commitment?: DraftInput['commitment'] }

// The salutation always names the actual recipient. A small model will
// sometimes skip the greeting, greet the sender, or borrow a name from the
// thread; this rewrites the first line so the person who receives the mail
// is the one addressed. Only for modes that produce a whole email.
export function ensureGreeting(text: string, mode: DraftMode, recipient?: DraftInput['recipient']): string {
  if (!['compose', 'reply', 'personalize', 'reschedule', 'nudge'].includes(mode)) return text;
  const first = firstNameOf(recipient?.name);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return first ? `Hi ${first},` : 'Hi there,';
  const line = lines[i];
  const m = line.match(GREETING_RE);
  const bareName = first && new RegExp(`^\\s*${escapeRe(first)}[,:]?\\s*$`, 'i').test(line);
  if (first) {
    if (bareName) return text;
    if (m) {
      const named = m[2].trim();
      // Already right: the exact first name, or the full name after it.
      // "Hi DANA," is the right person spelled wrong, and is corrected.
      if (named === first || named.toLowerCase().startsWith(first.toLowerCase() + ' ')) return text;
      const rest = line.slice(m[0].length).replace(/^[\s,!.:\uFF0C\u3001\uFF01\uFF1A\uFF1F]+/, '');
      lines[i] = `Hi ${first},${rest ? ' ' + rest : ''}`;
      return lines.join('\n');
    }
    return [...lines.slice(0, i), `Hi ${first},`, '', ...lines.slice(i)].join('\n');
  }
  // Unknown recipient: never a guessed name.
  if (m && !NEUTRAL.has(m[2].trim().toLowerCase())) {
    const rest = line.slice(m[0].length).replace(/^[\s,!.:\uFF0C\u3001\uFF01\uFF1A\uFF1F]+/, '');
    lines[i] = `Hi there,${rest ? ' ' + rest : ''}`;
    return lines.join('\n');
  }
  if (!m) return [...lines.slice(0, i), 'Hi there,', '', ...lines.slice(i)].join('\n');
  return text;
}

// The client appends the account's signature, so a sign-off block the model
// added (name plus address, title, company) is removed down to the plain
// closing line.
export function stripModelSignature(text: string, ctx: FinalizeContext): string {
  const lines = text.split('\n');
  const email = ctx.senderEmail?.toLowerCase();
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last) { lines.pop(); continue; }
    if (email && last.toLowerCase().includes(email)) { lines.pop(); continue; }
    if (/^(\[?(your|sender'?s?) (name|company|title|phone)\]?|\[.*\])$/i.test(last)) { lines.pop(); continue; }
    break;
  }
  // "Alex" followed by "Alex Rivera": keep one sign-off name.
  const name = ctx.senderName?.trim();
  if (name) {
    const first = name.split(/\s+/)[0];
    const isName = (l: string) => { const t = l.trim().replace(/^[-–—]\s*/, ''); return t === name || t === first || t === `${name},` || t === `${first},`; };
    const idx = lines.map((l) => l.trim()).reduce<number[]>((acc, l, i) => (l ? [...acc, i] : acc), []);
    if (idx.length >= 2 && isName(lines[idx[idx.length - 1]]) && isName(lines[idx[idx.length - 2]])) lines.splice(idx[idx.length - 1], 1);
  }
  return stripRecipientSignoff(lines.join('\n'), ctx.recipient);
}

// A sign-off in the recipient's name.
//
// Handed a conversation, a small model will sometimes end an email "Best
// regards, Bob" — where Bob is the person it is writing *to*. The existing
// stripper only knows the sender's name, so it leaves this alone, and the
// result reads as though the recipient wrote it themselves. Seen from the
// dev model on a real thread, which is the only reason it is worth code.
//
// Only a genuine sign-off is touched: a trailing line that is the name and
// nothing else, or a name after a valediction. Bob's name in the body of an
// email addressed to Bob is left alone, because that is just writing.
const VALEDICTION = /(?:best(?:\s+(?:regards|wishes))?|regards|kind regards|warm(?:ly|est)?|thanks(?:\s+again)?|many thanks|cheers|sincerely|yours(?:\s+(?:sincerely|faithfully|truly))?|speak soon|all the best)/i;

export function stripRecipientSignoff(text: string, recipient?: DraftInput['recipient']): string {
  const full = cleanRecipientName(recipient?.name);
  const first = firstNameOf(recipient?.name);
  if (!first) return text;
  const names = [...new Set([full, first].filter(Boolean))].map(escapeRe).join('|');
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i -= 1;
  if (i < 0) return text;
  const last = lines[i].trim();

  // "Best regards, Bob" — all on one line, which is how it arrives when the
  // model wrote the whole email as a single paragraph.
  const inline = new RegExp(`^(.*?)(?:^|[\\s,])(${VALEDICTION.source}),?\\s+(?:${names})[.!]?$`, 'i');
  const m = inline.exec(last);
  if (m) {
    const head = `${m[1]}${m[1] && !/\s$/.test(m[1]) ? ' ' : ''}${m[2]},`.trim();
    lines[i] = head;
    return lines.join('\n');
  }

  // The name on a line of its own, under a valediction or under a blank line.
  if (new RegExp(`^[-–—]?\\s*(?:${names})[,.!]?$`, 'i').test(last)) {
    lines.splice(i, 1);
    return lines.join('\n').replace(/\n+$/, '');
  }
  return text;
}

// Three one-line suggestions, whatever decoration the model added: numbers,
// bullets, quotes, labels, or a greeting it was told not to write.
// A bracketed placeholder, an unrendered merge field or a leftover prompt
// label in a one-line suggestion. The send guard would catch these later;
// here they are dropped before anyone can click one into the composer.
const QUICK_UNUSABLE_RE = /\[[^\]\n]{0,60}\]|<[a-z][^>\n]{0,40}>|\{\{|\{%|\$\{|^(?:option|reply|suggestion)\b\s*\d/i;

export function parseQuickReplies(raw: string, names: string[] = []): string[] {
  // Strict first. If the model answered in long sentences and that leaves
  // nothing to offer, a second pass keeps the wordier ones: two usable
  // suggestions beat the "no suggestions this time" the panel would
  // otherwise show. Nothing carrying a placeholder survives either pass.
  const strict = collectQuickReplies(raw, names, 18, 160);
  if (strict.length >= 2) return strict;
  const lenient = collectQuickReplies(raw, names, 32, 240);
  if (lenient.length >= 2) return lenient;
  // Asked for three lines, a model sometimes writes the three replies as one
  // paragraph. Splitting on sentence ends recovers them; it only runs when
  // reading the answer as written produced nothing to show.
  const sentences = collectQuickReplies(raw.replace(/([.!?])\s+(?=["'\u201c\u2018]?\p{Lu})/gu, '$1\n'), names, 18, 160);
  return sentences.length > lenient.length ? sentences : lenient;
}

function collectQuickReplies(raw: string, names: string[], maxWords: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const vocative = names.map(firstNameOf).filter(Boolean).map(escapeRe);
  for (const line of raw.split('\n')) {
    let t = line.trim().replace(/^```[a-z]*$/i, '');
    t = t.replace(/^(?:[-*•>]+|\(?\d+[.)]|[a-c][.)]|(?:option|reply)\s*\d*\s*:)\s*/i, '').trim();
    t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    t = t.replace(/^(?:hi|hello|hey|dear)\b[^,!.]*[,!.]\s*/i, '').trim();
    // "Alice, sure thing" -> "Sure thing": the recipient's or sender's name used as a greeting.
    if (vocative.length) t = t.replace(new RegExp(`^(?:${vocative.join('|')})[,!:]\\s*(?=\\S)`, 'i'), '').trim();
    if (!t || /^(here (are|is)|sure|okay|ok)\b/i.test(t) && t.endsWith(':')) continue;
    // A lone name ("Bob") is not a reply; a lone word with punctuation ("Yes.") is.
    const words = t.split(/\s+/).length;
    if (words < 2 && !/[.!?…]$/.test(t)) continue;
    // These go straight into the composer when they are clicked, so a
    // suggestion is dropped rather than patched up: one the model padded out
    // into a paragraph is not a quick reply, and one carrying a placeholder
    // ("[insert specific facts]") is not something anyone would send.
    if (words > maxWords || t.length > maxChars) continue;
    if (QUICK_UNUSABLE_RE.test(t)) continue;
    t = t[0].toUpperCase() + t.slice(1);
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

// The date a reschedule commits to, guaranteed the way the salutation is.
//
// This is not a hypothetical. Handed "Thursday 10 September at 12:00", the
// small model this ships with wrote "Thursday, October 9th at noon" — a
// confident, fluent, wrong date, in an email whose entire purpose is to name
// the right one. A greeting to the wrong person is embarrassing; a delivery
// date the recipient then plans around is worse, and unlike the greeting it
// is not obvious to whoever presses send.
//
// So the same treatment: the model's phrasing is kept and the fact is
// corrected afterwards, from the value the ledger is being moved to.
const DATE_EXPR = new RegExp(
  [
    // "Thursday, October 9th at noon", "Fri 11 Sept at 14:00"
    '(?:(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|mon|tue|wed|thu|fri|sat|sun)\\b[,]?(?:\\s+the)?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:\\s+(?:of\\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:\\s+at\\s+(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|noon|midday))?',
    // "October 9th at 12:00", "9 October"
    '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s+at\\s+(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|noon|midday))?',
    '\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*',
    // "next week", "tomorrow", "the end of the month"
    '(?:next|this)\\s+(?:week|month)',
    'tomorrow',
  ].join('|'),
  'gi',
);

// The part of the written date that must appear for it to count as stated:
// "Thursday 10 September at 12:00" is satisfied by "10 September", because a
// model that drops the weekday or the time has still named the right day.
function dayPart(written: string): string {
  return written.replace(/^[a-z]+\s+/i, '').replace(/\s+at\s+.*$/i, '').trim();
}

export function ensureCommitmentDate(text: string, mode: DraftMode, commitment?: DraftInput['commitment']): string {
  const want = commitment?.now;
  if (!want || (mode !== 'reschedule' && mode !== 'nudge')) return text;
  const day = dayPart(want);
  // Already there, however it was phrased around: nothing to do.
  if (day && text.toLowerCase().includes(day.toLowerCase())) return text;

  const found = text.match(DATE_EXPR) ?? [];
  // Exactly one date expression, and it is not the right one: it is the date
  // the model invented, and swapping it keeps the sentence the model built
  // around it.
  if (found.length === 1) return text.replace(DATE_EXPR, want);
  // None to replace, or several — where rewriting each one is more likely to
  // break a sentence ("I will call Monday about the Friday delivery") than to
  // fix it. Saying it plainly at the end is the honest repair.
  const sep = text.trim().endsWith('.') || text.trim().endsWith('?') ? ' ' : '. ';
  const paragraphs = text.trimEnd().split(/\n{2,}/);
  const last = paragraphs.length - 1;
  paragraphs[last] = `${paragraphs[last].trimEnd()}${sep}To be precise: ${want}.`;
  return paragraphs.join('\n\n');
}

export function finalizeOutput(raw: string, mode: DraftMode, ctx: FinalizeContext = {}): string {
  if (mode === 'quick_replies') return parseQuickReplies(raw, [ctx.recipient?.name ?? '', ctx.senderName ?? '']).join('\n');
  let t = cleanOutput(raw, mode);
  if (['compose', 'reply', 'personalize', 'rewrite', 'expand', 'shorten', 'polish', 'reschedule', 'nudge'].includes(mode)) t = stripModelSignature(t, ctx);
  t = ensureGreeting(t, mode, ctx.recipient);
  t = ensureCommitmentDate(t, mode, ctx.commitment);
  return t.trim();
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
