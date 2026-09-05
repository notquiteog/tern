// Prompt construction for the drafting assistant. Small models follow short,
// concrete instructions best, so every prompt states the format once and
// gives the model the facts it is allowed to use instead of letting it guess.
import type { ChatMessage } from './llm.js';

export type DraftMode = 'compose' | 'reply' | 'rewrite' | 'shorten' | 'expand' | 'summarize' | 'subject' | 'personalize' | 'polish';

export interface DraftInput {
  mode: DraftMode;
  instruction?: string;
  tone?: string;
  length?: 'short' | 'medium' | 'long';
  senderName?: string;
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

function threadBlock(t?: DraftInput['thread']): string {
  if (!t?.length) return '';
  const parts = t.slice(-6).map((m) => `--- From ${m.from} on ${m.date}\n${m.text.slice(0, 2500)}`);
  return `Conversation so far (oldest first):\n${parts.join('\n')}`;
}

export function buildMessages(input: DraftInput): ChatMessage[] {
  const tone = input.tone ? `Tone: ${input.tone}.` : 'Tone: friendly and professional.';
  const len = LENGTH[input.length ?? 'medium'];
  const sender = [input.senderName ? `Sender: ${input.senderName}` : '', input.senderCompany ? `Sender's company: ${input.senderCompany}` : ''].filter(Boolean).join('\n');
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
      parts.push(`Write this outreach email for the specific recipient. Use the brief as the message to deliver and the recipient facts to make it relevant. Do not mention that you have facts about them; use them naturally, at most twice.`, input.instruction ? `Extra direction: ${input.instruction}` : '', tone, len);
      break;
  }
  if (sender) parts.push(sender);
  if (input.voice?.trim()) parts.push(`Sender's voice and preferences (follow these):\n${input.voice.trim()}`);
  const rb = recipientBlock(input.recipient); if (rb) parts.push(rb);
  const tb = threadBlock(input.thread); if (tb) parts.push(tb);
  if (input.subject && input.mode !== 'subject') parts.push(`Subject of this email: ${input.subject}`);
  if (input.template) parts.push(`Brief / template:\n${input.template}`);
  if (input.draft) parts.push(input.mode === 'subject' ? `Email:\n${input.draft}` : `Draft:\n${input.draft}`);
  return [
    { role: 'system', content: input.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ];
}

// Small models sometimes wrap output in quotes or add a label anyway.
export function cleanOutput(text: string, mode: DraftMode): string {
  let t = text.trim();
  t = t.replace(/^(here(?:'s| is) (?:the|a|your) (?:email|draft|reply|subject line|summary)[^\n]*:?\s*)/i, '');
  t = t.replace(/^```[a-z]*\n?|\n?```$/g, '');
  // Small models like to add a speaker label or markdown emphasis; email is plain text.
  t = t.replace(/^\*{0,2}[A-Z][A-Za-z .'-]{0,40}:\*{0,2}\s*(?=\S)/, (m) => (/^\*{0,2}(subject|re|dear|hi|hello|hey)\b/i.test(m) ? m : ''));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
  t = t.replace(/^Subject:.*\n+/i, (m) => (mode === 'subject' ? m : ''));
  if (mode === 'subject') {
    t = t.split('\n')[0].replace(/^subject:\s*/i, '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!]+$/, '').trim();
  }
  return t.trim();
}
