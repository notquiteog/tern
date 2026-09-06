// Prompt construction for the drafting assistant. Small models follow short,
// concrete instructions best, so every prompt states the format once and
// gives the model the facts it is allowed to use instead of letting it guess.
import type { ChatMessage } from './llm.js';

export type DraftMode = 'compose' | 'reply' | 'rewrite' | 'shorten' | 'expand' | 'summarize' | 'subject' | 'personalize' | 'polish' | 'quick_replies' | 'gist';

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
  // How many characters of the conversation may be spent. Derived from the
  // model's context window by `threadBudgetChars`; the default suits the
  // 8192-token window Tern ships with.
  threadChars?: number;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an email writing assistant inside a mail client. You write in the sender's voice: clear, warm, specific and brief. Rules:
- Output only what was asked for. No preamble, no "Here is", no markdown, no bullet symbols unless asked, no quoted email.
- Never invent facts, offers, prices, dates or names that were not provided.
- Do not add a subject line unless asked for one.
- Do not add a signature block; the client appends one.
- Use plain paragraphs separated by blank lines.`;

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
export const THREAD_CHARS_DEFAULT = 14_000;
const NEWEST_MSG_CHARS = 4_000; // the message being replied to, near enough in full
const OLDER_MSG_CHARS = 1_400;

// Characters of thread that fit alongside the instructions and the answer.
// Roughly 3.2 characters per token, minus room for the prompt scaffolding and
// whatever the model is about to write.
export function threadBudgetChars(numCtx: number, maxTokens: number): number {
  const reserve = Math.max(400, maxTokens) + 600; // generation + instructions, in tokens
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
  // Newest first: at least the last three, whatever they cost.
  for (let i = t.length - 1; i >= 0; i--) {
    const piece = render(i);
    if (used + piece.length > budget && keep.size >= 3) break;
    keep.add(i);
    used += piece.length;
  }
  // Then the opening of the thread, oldest first, with whatever is left.
  for (let i = 0; i < t.length; i++) {
    if (keep.has(i)) continue;
    const piece = render(i);
    if (used + piece.length > budget) break;
    keep.add(i);
    used += piece.length;
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
// and often as the address itself. Taking the first word of that verbatim
// produces "Hi Osei,", "Hi DANA,", "Hi dana@northwind.example," — the kind
// of greeting that tells the reader at a glance that a robot wrote it.
const HONORIFIC_RE = /^(?:mr|mrs|ms|miss|mx|dr|prof|professor|sir|rev|fr|capt|sgt)\.?\s+/i;
const CREDENTIALS_RE = /[,(]\s*(?:ph\.?d|m\.?d|mba|cpa|aca|acca|cfa|esq|jr|sr|ii|iii|iv|bsc|msc|ma|ba)\b[^,]*$/i;

export function cleanRecipientName(raw?: string | null): string {
  let n = String(raw ?? '').trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '').trim();
  if (!n) return '';
  // A display name that is just the address tells us nothing a greeting can use.
  if (/@/.test(n)) return '';
  // "Dana Osei | Northwind Supply", "Dana Osei - Finance", "Dana Osei (Northwind)"
  n = n.split(/\s+[|\u2013\u2014]\s+|\s+-\s+/)[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
  n = n.replace(CREDENTIALS_RE, '').trim();
  n = n.replace(HONORIFIC_RE, '').trim();
  // "Osei, Dana": the surname-first form every directory export uses.
  const comma = n.match(/^([^,]+),\s*([^,]+)$/);
  if (comma) n = `${comma[2].trim()} ${comma[1].trim()}`;
  n = n.replace(/[,;:]+$/, '').trim();
  // A name with no letters in it is not a name.
  if (!/\p{L}/u.test(n)) return '';
  // SHOUTING or all lower case: written the way a person would write it.
  if (n === n.toUpperCase() || n === n.toLowerCase()) {
    n = n.toLowerCase().replace(/(^|[\s'\u2019-])(\p{L})/gu, (_m, sep, c) => sep + c.toUpperCase());
  }
  return n;
}

// The word to greet them by. Empty when there is nothing usable, which the
// callers turn into "Hi there," rather than a guess.
export function firstNameOf(raw?: string | null): string {
  const first = cleanRecipientName(raw).split(/\s+/)[0] ?? '';
  return /\p{L}/u.test(first) ? first : '';
}

// Who the email is to, stated once and plainly. Small models otherwise pick a
// name out of the thread, or invent one, and greet the wrong person.
function addressingBlock(input: DraftInput): string {
  if (!['compose', 'reply', 'personalize'].includes(input.mode)) return '';
  const r = input.recipient;
  const name = cleanRecipientName(r?.name);
  const first = firstNameOf(r?.name);
  if (name && first) {
    return `Write to ${name}${r?.email ? ` <${r.email}>` : ''}. The first line of the email is exactly "Hi ${first}," and no other name is used for them. Speak to them as "you".`;
  }
  if (r?.email) return `Write to ${r.email}. Their name is not known: the first line is exactly "Hi there," and no name is guessed or invented.`;
  return `The recipient's name is not known: the first line is exactly "Hi there," and no name is guessed or invented.`;
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
    case 'quick_replies':
      parts.push(
        `Suggest three different short replies the sender could send to the last message in the conversation. Answer only that message; do not summarise the thread. Output exactly three lines and then stop. One reply per line, each a complete sentence of at most 12 words, in the first person. Vary them: one agrees or confirms, one asks a question or proposes a time, one politely declines or defers. No numbering, no bullets, no quotes, no greeting, no sign-off, no explanation.`,
        // These are conversational moves, not answers. Only the newest part
        // of the thread is shown, so a suggestion that states a date or a
        // figure is stating one it cannot see — and it goes into the
        // composer the moment someone clicks it.
        `Do not state any date, time, amount or other specific fact in a suggestion, even if you think you know it. Say "I will confirm the dates" rather than naming them.`,
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
export function assertFreshConversation(messages: ChatMessage[]): void {
  const roles = messages.map((m) => m.role);
  if (roles.length !== 2 || roles[0] !== 'system' || roles[1] !== 'user') {
    throw new Error(`AI requests must be a fresh conversation (system + user), got: ${roles.join(', ') || 'nothing'}`);
  }
}

// Small models sometimes wrap output in quotes or add a label anyway.
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
  }
  return t.trim();
}


// ---------- Guarantees the model cannot be trusted with ----------

// The salutation and whatever name it used. The name runs to the first
// comma, colon or exclamation mark — not to the first full stop, because a
// display name that is really an address ("Hi dana@northwind.example,") has
// full stops inside it and cutting there leaves half of it behind as text.
const GREETING_RE = /^\s*(hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[\s,]*([^\n,:!]*)[,:!]?/i;
const NEUTRAL = new Set(['there', 'all', 'team', 'everyone', 'both', 'folks', 'friend', 'sir', 'madam', 'sir or madam', '']);

export interface FinalizeContext { recipient?: DraftInput['recipient']; senderName?: string; senderEmail?: string }

// The salutation always names the actual recipient. A small model will
// sometimes skip the greeting, greet the sender, or borrow a name from the
// thread; this rewrites the first line so the person who receives the mail
// is the one addressed. Only for modes that produce a whole email.
export function ensureGreeting(text: string, mode: DraftMode, recipient?: DraftInput['recipient']): string {
  if (!['compose', 'reply', 'personalize'].includes(mode)) return text;
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
      const rest = line.slice(m[0].length).replace(/^[\s,!.:]+/, '');
      lines[i] = `Hi ${first},${rest ? ' ' + rest : ''}`;
      return lines.join('\n');
    }
    return [...lines.slice(0, i), `Hi ${first},`, '', ...lines.slice(i)].join('\n');
  }
  // Unknown recipient: never a guessed name.
  if (m && !NEUTRAL.has(m[2].trim().toLowerCase())) {
    const rest = line.slice(m[0].length).replace(/^[\s,!.:]+/, '');
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
  return lines.join('\n');
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

export function finalizeOutput(raw: string, mode: DraftMode, ctx: FinalizeContext = {}): string {
  if (mode === 'quick_replies') return parseQuickReplies(raw, [ctx.recipient?.name ?? '', ctx.senderName ?? '']).join('\n');
  let t = cleanOutput(raw, mode);
  if (['compose', 'reply', 'personalize', 'rewrite', 'expand', 'shorten', 'polish'].includes(mode)) t = stripModelSignature(t, ctx);
  t = ensureGreeting(t, mode, ctx.recipient);
  return t.trim();
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
