// Prompt construction for the drafting assistant. Small models follow short,
// concrete instructions best, so every prompt states the format once and
// gives the model the facts it is allowed to use instead of letting it guess.
import type { ChatMessage } from './llm.js';

export type DraftMode = 'compose' | 'reply' | 'rewrite' | 'shorten' | 'expand' | 'summarize' | 'subject' | 'personalize' | 'polish' | 'quick_replies';

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

function recipientBlock(r?: DraftInput['recipient']): string {
  if (!r) return '';
  const lines: string[] = [];
  if (r.name) lines.push(`Name: ${r.name}`);
  if (r.email) lines.push(`Email: ${r.email}`);
  if (r.company) lines.push(`Company: ${r.company}`);
  if (r.title) lines.push(`Title: ${r.title}`);
  for (const [k, v] of Object.entries(r.fields ?? {})) if (v !== null && v !== '' && v !== undefined) lines.push(`${k}: ${String(v)}`);
  if (r.notes) lines.push(`Notes: ${r.notes}`);
  return lines.length ? `Recipient facts (use only these):\n${lines.join('\n')}` : '';
}

function threadBlock(t?: DraftInput['thread'], senderEmail?: string): string {
  if (!t?.length) return '';
  const mine = (from: string) => Boolean(senderEmail && from.toLowerCase().includes(senderEmail.toLowerCase()));
  const parts = t.slice(-6).map((m) => `--- From ${m.from}${mine(m.from) ? ' (this is the sender, you)' : ''} on ${m.date}\n${m.text.slice(0, 2500)}`);
  return `Conversation so far (oldest first):\n${parts.join('\n')}`;
}

// Who the email is to, stated once and plainly. Small models otherwise pick a
// name out of the thread, or invent one, and greet the wrong person.
function addressingBlock(input: DraftInput): string {
  if (!['compose', 'reply', 'personalize'].includes(input.mode)) return '';
  const r = input.recipient;
  const name = r?.name?.trim();
  if (name) {
    const first = name.split(/\s+/)[0];
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
      parts.push(`Write a reply to the latest message in the conversation.`, input.instruction ? `What the reply should do: ${input.instruction}` : 'Answer what was asked and move the conversation forward.', tone, len);
      break;
    case 'rewrite':
      parts.push(`Rewrite the draft below. Keep the meaning, improve clarity and flow.`, input.instruction ? `Direction: ${input.instruction}` : '', tone);
      break;
    case 'polish':
      parts.push(`Fix grammar, spelling and awkward phrasing in the draft below. Change as little as possible. Return the corrected draft only.`);
      break;
    case 'shorten':
      parts.push(`Shorten the draft below to about half its length without losing the ask.`, tone);
      break;
    case 'expand':
      parts.push(`Expand the draft below with one more concrete, useful sentence per paragraph. No filler.`, tone);
      break;
    case 'summarize':
      parts.push(`Summarize the conversation in 2-4 plain sentences: what was discussed, what was decided, what is still open. Then, on a new line starting with "Next:", state the single most useful next action for the sender.`);
      break;
    case 'subject':
      parts.push(`Write one subject line for the email below. Under 8 words, no quotes, no trailing punctuation. Output the subject line only.`);
      break;
    case 'personalize':
      parts.push(`Write the email the sender will send to the recipient below, in the first person ("I", "we") and speaking to the recipient as "you". The brief is the message to deliver; say it in the sender's words, do not describe or summarise it. Use at most two of the recipient facts, naturally, without saying you have facts about them.`, input.instruction ? `Extra direction: ${input.instruction}` : '', tone, len);
      break;
    case 'quick_replies':
      parts.push(`Suggest three different short replies the sender could send to the latest message in the conversation. One reply per line, each a complete sentence under 12 words, in the first person. Vary them: one agrees or confirms, one asks a question or proposes a time, one politely declines or defers. No numbering, no bullets, no quotes, no greeting, no sign-off. Output exactly three lines.`, tone);
      break;
  }
  const ab = addressingBlock(input); if (ab) parts.push(ab);
  if (sender) parts.push(sender);
  if (input.voice?.trim()) parts.push(`Sender's voice and preferences (follow these):\n${input.voice.trim()}`);
  const rb = recipientBlock(input.recipient); if (rb) parts.push(rb);
  const tb = threadBlock(input.thread, input.senderEmail); if (tb) parts.push(tb);
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

const GREETING_RE = /^\s*(hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[\s,]*([^\n,!.:]*)/i;
const NEUTRAL = new Set(['there', 'all', 'team', 'everyone', 'both', 'folks', 'friend', 'sir', 'madam', 'sir or madam', '']);

export interface FinalizeContext { recipient?: DraftInput['recipient']; senderName?: string; senderEmail?: string }

// The salutation always names the actual recipient. A small model will
// sometimes skip the greeting, greet the sender, or borrow a name from the
// thread; this rewrites the first line so the person who receives the mail
// is the one addressed. Only for modes that produce a whole email.
export function ensureGreeting(text: string, mode: DraftMode, recipient?: DraftInput['recipient']): string {
  if (!['compose', 'reply', 'personalize'].includes(mode)) return text;
  const first = recipient?.name?.trim().split(/\s+/)[0] ?? '';
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
      if (named.toLowerCase() === first.toLowerCase() || named.toLowerCase().startsWith(first.toLowerCase() + ' ')) return text;
      const rest = line.slice(m[0].length).replace(/^[,!.:]\s*/, '');
      lines[i] = `Hi ${first},${rest ? ' ' + rest : ''}`;
      return lines.join('\n');
    }
    return [...lines.slice(0, i), `Hi ${first},`, '', ...lines.slice(i)].join('\n');
  }
  // Unknown recipient: never a guessed name.
  if (m && !NEUTRAL.has(m[2].trim().toLowerCase())) {
    const rest = line.slice(m[0].length).replace(/^[,!.:]\s*/, '');
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
export function parseQuickReplies(raw: string, names: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const vocative = names.map((n) => n.trim().split(/\s+/)[0]).filter(Boolean).map(escapeRe);
  for (const line of raw.split('\n')) {
    let t = line.trim().replace(/^```[a-z]*$/i, '');
    t = t.replace(/^(?:[-*•>]+|\(?\d+[.)]|[a-c][.)]|(?:option|reply)\s*\d*\s*:)\s*/i, '').trim();
    t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    t = t.replace(/^(?:hi|hello|hey|dear)\b[^,!.]*[,!.]\s*/i, '').trim();
    // "Alice, sure thing" -> "Sure thing": the recipient's or sender's name used as a greeting.
    if (vocative.length) t = t.replace(new RegExp(`^(?:${vocative.join('|')})[,!:]\\s*(?=\\S)`, 'i'), '').trim();
    if (!t || /^(here (are|is)|sure|okay|ok)\b/i.test(t) && t.endsWith(':')) continue;
    // A lone name ("Bob") is not a reply; a lone word with punctuation ("Yes.") is.
    if (t.split(/\s+/).length < 2 && !/[.!?…]$/.test(t)) continue;
    if (t.length > 140) t = t.slice(0, 137).replace(/\s+\S*$/, '') + '…';
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
