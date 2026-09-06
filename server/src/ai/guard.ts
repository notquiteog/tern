// The last line of defence before automated mail leaves: nothing a model or
// a template engine left behind may reach a real inbox. Unrendered merge
// fields, bracketed placeholders, echoed prompt scaffolding and "as an AI"
// disclaimers are all things a person would catch at a glance and a
// responder in send mode never would. Anything flagged here is diverted to
// the review queue instead of being sent.
import { htmlToText } from '../services/merge.js';

export interface GuardHit { kind: 'merge_field' | 'placeholder' | 'prompt_leak' | 'ai_disclosure' | 'filler'; sample: string }

// {{first_name}}, {{ company | there }}, {% if %}, ${name}, {first_name}: a
// template that was never rendered, or was rendered by the wrong engine.
const MERGE_RE = /\{\{[^}\n]{0,80}\}\}|\{%[^%\n]{0,80}%\}|\$\{[a-zA-Z_][^}\n]{0,60}\}|\{(?:first|last|full)?_?name\}|\{company\}|\{email\}|\{title\}/g;
// {Hi|Hello|Hey}: spin syntax that was not resolved.
const SPIN_RE = /\{[^{}\n|]{1,40}(?:\|[^{}\n|]{0,40}){1,8}\}/g;
// [Your Name], [Company], [insert date], <Name>, <insert product>, __NAME__, [X]
const PLACEHOLDER_WORDS = 'your|name|first|last|company|insert|recipient|sender|date|time|day|link|url|product|service|title|role|job|email|address|phone|city|country|placeholder|details?|topic|subject|number|amount|price|offer|x{1,3}|tbd|todo|fill|here';
const BRACKET_RE = new RegExp(`\\[\\s*(?:${PLACEHOLDER_WORDS})(?:[\\s'’-][^\\]\\n]{0,40})?\\s*\\]|<\\s*(?:${PLACEHOLDER_WORDS})(?:[\\s'’-][^>\\n]{0,40})?\\s*>|__[A-Z][A-Z_]{1,30}__`, 'gi');
// Lines the prompt builder writes; if they show up in the output the model
// echoed its instructions instead of answering them.
const PROMPT_RE = /^(?:\s*(?:recipient facts|conversation so far|sender'?s voice|subject of this email|brief \/ template|extra direction|what the reply should do|write to |you are writing as|tone:|keep it to|goal:|direction:|draft:|email:|system prompt|user prompt|instruction(?:s)?:)|\s*-{3,}\s*from\b)/im;
const AI_RE = /\b(?:as an ai(?: language model| assistant)?|i am an ai\b|i'?m an ai\b|as a language model|i(?:'m| am) (?:just )?(?:a|an) (?:ai|artificial intelligence|language model|virtual assistant|chatbot)|this (?:message|email|reply) was (?:generated|written) by (?:an )?ai\b|\[assistant\]|\[end of (?:email|reply|message)\])/i;
const FILLER_RE = /\blorem ipsum\b|\bplaceholder text\b|\bsample text\b/i;

// Quoted replies carry the other side's text, which is theirs to have
// written however they like; only what we are about to say is inspected.
function withoutQuotes(text: string, html?: string | null): string {
  let t = text;
  if (html) {
    const cut = html.search(/<(?:div|blockquote)[^>]*class="[^"]*tern-quote/i);
    if (cut >= 0) t = htmlToText(html.slice(0, cut));
  }
  return t.split('\n').filter((l) => !l.trim().startsWith('>')).join('\n');
}

export function findTemplateArtifacts(input: { subject?: string | null; html?: string | null; text?: string | null }): GuardHit[] {
  const hits: GuardHit[] = [];
  const subject = input.subject ?? '';
  const bodyOnly = withoutQuotes(input.text ?? (input.html ? htmlToText(input.html) : ''), input.html);
  const text = `${subject}\n${bodyOnly}`;
  const seen = new Set<string>();
  const push = (kind: GuardHit['kind'], sample: string) => {
    const s = sample.trim().slice(0, 80);
    const key = `${kind}:${s.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, sample: s });
  };
  for (const m of text.matchAll(MERGE_RE)) push('merge_field', m[0]);
  for (const m of text.matchAll(SPIN_RE)) push('merge_field', m[0]);
  for (const m of text.matchAll(BRACKET_RE)) push('placeholder', m[0]);
  const prompt = text.match(PROMPT_RE);
  if (prompt) push('prompt_leak', prompt[0]);
  const ai = text.match(AI_RE);
  if (ai) push('ai_disclosure', ai[0]);
  const filler = text.match(FILLER_RE);
  if (filler) push('filler', filler[0]);
  return hits;
}

export function describeHits(hits: GuardHit[]): string {
  const label: Record<GuardHit['kind'], string> = { merge_field: 'unrendered merge field', placeholder: 'placeholder', prompt_leak: 'prompt text', ai_disclosure: 'AI self-reference', filler: 'filler text' };
  return hits.map((h) => `${label[h.kind]} "${h.sample}"`).join('; ');
}

export class TemplateGuardError extends Error {
  hits: GuardHit[];
  constructor(hits: GuardHit[]) {
    super(`Held back: the message still contains ${describeHits(hits)}`);
    this.name = 'TemplateGuardError';
    this.hits = hits;
  }
}

// Throws when an automated message is not fit to send. Mail a person wrote
// or approved is theirs to send as they like, placeholders and all.
export function assertSendable(input: { subject?: string | null; html?: string | null; text?: string | null }): void {
  const hits = findTemplateArtifacts(input);
  if (hits.length) throw new TemplateGuardError(hits);
}
