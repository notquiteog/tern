// F7: a sentence becomes a rule, or a search, that the person can then read.
//
// This is the shape of AI that belongs in a mail client. The model runs once,
// at the moment somebody is writing a rule, and what it produces is not an
// action — it is a *draft of a rule*, in the same JSON the rules engine has
// always run, shown in the same editor, saved only when approved. From then
// on the rule executes deterministically for ever and the model is not in the
// loop. A rule that is wrong is visible and editable, rather than a mystery
// that mislabels mail once a week.
//
// The same trick works on search: an English sentence becomes operator chips
// in the omnibox, which the person can take off one at a time. The chips are
// the existing UI; this only fills them in.
//
// Nothing from a mailbox is sent. The prompt is the person's own sentence,
// their mailbox names, and their labels — which is why the capability says
// "your mailbox does not go to the model" and means it.
import { query } from '../db.js';
import { chat } from '../ai/llm.js';
import { assertFreshConversation } from '../ai/prompts.js';
import { badRequest } from '../errors.js';

export const RULE_FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'any', 'has_attachment', 'list'] as const;
export const RULE_OPS = ['contains', 'not_contains', 'equals', 'starts_with', 'ends_with', 'matches', 'is_true', 'is_false'] as const;
export const RULE_ACTIONS = ['archive', 'trash', 'spam', 'mark_read', 'star', 'unstar', 'label'] as const;

export interface DraftRule {
  name: string;
  match: 'all' | 'any';
  conditions: { field: string; op: string; value?: string }[];
  actions: { type: string; mailboxId?: string }[];
}

const SYSTEM = [
  'You turn one sentence into a mail rule, expressed as JSON and nothing else.',
  '',
  'Shape:',
  '{"name":"<short name>","match":"all"|"any",',
  ' "conditions":[{"field":"from|to|cc|subject|body|any|has_attachment|list","op":"contains|not_contains|equals|starts_with|ends_with|matches|is_true|is_false","value":"<text>"}],',
  ' "actions":[{"type":"archive|trash|spam|mark_read|star|unstar|label","label":"<label name, only for type label>"}]}',
  '',
  'Rules:',
  '- has_attachment and list take is_true or is_false and no value.',
  '- Every other field needs a value.',
  '- Use only label names from the list you are given. If the sentence asks for a label that does not exist, use its closest match, or leave the action out.',
  '- Never invent an action that was not asked for. "Skip the inbox" is archive.',
  '- Answer with the JSON object alone.',
].join('\n');

// Turns whatever came back into a rule the editor can show, or throws
// something a person can act on. Every field is checked against the same
// vocabulary the rules route validates, so a rule that gets this far is one
// the engine can actually run.
export function parseRule(raw: string, labels: { id: string; name: string }[]): DraftRule {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw badRequest('The model did not answer with a rule. Try describing it differently.');
  let j: any;
  try { j = JSON.parse(text.slice(start, end + 1)); } catch { throw badRequest('The model’s answer was not a rule. Try describing it differently.'); }

  const conditions = (Array.isArray(j.conditions) ? j.conditions : [])
    .map((c: any) => {
      const field = String(c?.field ?? '').toLowerCase();
      let op = String(c?.op ?? '').toLowerCase();
      if (!(RULE_FIELDS as readonly string[]).includes(field)) return null;
      // The two boolean fields only take the boolean operators, whichever
      // the model reached for.
      if (field === 'has_attachment' || field === 'list') {
        if (!['is_true', 'is_false'].includes(op)) op = 'is_true';
        return { field, op };
      }
      if (!(RULE_OPS as readonly string[]).includes(op) || ['is_true', 'is_false'].includes(op)) op = 'contains';
      const value = String(c?.value ?? '').trim().slice(0, 500);
      if (!value) return null;
      // A regular expression that does not compile would throw inside the
      // engine on every message that arrives.
      if (op === 'matches') { try { new RegExp(value); } catch { return null; } }
      return { field, op, value };
    })
    .filter(Boolean)
    .slice(0, 20) as DraftRule['conditions'];

  const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  const actions = (Array.isArray(j.actions) ? j.actions : [])
    .map((a: any) => {
      const type = String(a?.type ?? '').toLowerCase();
      if (!(RULE_ACTIONS as readonly string[]).includes(type)) return null;
      if (type !== 'label') return { type };
      const wanted = String(a?.label ?? a?.mailboxId ?? '').trim().toLowerCase();
      const id = byName.get(wanted);
      // A label the person does not have is dropped rather than invented:
      // creating mailboxes is not something a sentence should be able to do.
      return id ? { type, mailboxId: id } : null;
    })
    .filter(Boolean)
    .slice(0, 10) as DraftRule['actions'];

  if (!conditions.length) throw badRequest('That did not describe anything to match on. Try naming a sender, a subject or a word.');
  if (!actions.length) throw badRequest('That did not describe anything to do. Try “archive it”, “star it” or “label it Finance”.');

  const name = String(j.name ?? '').trim().slice(0, 200) || 'New rule';
  return { name, match: j.match === 'any' ? 'any' : 'all', conditions, actions };
}

// Both prompts, exported so an evaluation grades the shipped wording rather
// than a copy of it.
export function buildRuleMessages(labels: { id: string; name: string }[], sentence: string): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [`Labels that exist: ${labels.map((l) => l.name).join(', ') || '(none)'}`, '', `Rule to write: ${String(sentence).slice(0, 500)}`].join('\n') },
  ];
}

export function buildSearchMessages(sentence: string, today = new Date()): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: SEARCH_SYSTEM },
    { role: 'user', content: `Today is ${today.toISOString().slice(0, 10)}.\n\nSearch for: ${String(sentence).slice(0, 300)}` },
  ];
}

export async function draftRule(userId: number, sentence: string): Promise<DraftRule> {
  const labels = await query<{ id: string; name: string }>(
    `SELECT m.jmap_id AS id, m.name FROM mailboxes m JOIN accounts a ON a.id=m.account_id
      WHERE a.user_id=$1 ORDER BY m.name LIMIT 200`,
    [userId],
  );
  const messages = buildRuleMessages(labels, sentence);
  assertFreshConversation(messages);
  const raw = await chat({
    messages, maxTokens: 400, temperature: 0.1, noThink: true,
    owner: String(userId),
    consent: { userId, capability: 'nlrules' },
  });
  return parseRule(raw, labels);
}

// ---------- Search ----------

const SEARCH_SYSTEM = [
  'You turn one sentence into a mail search query, using only these operators:',
  'from: to: subject: label: has:attachment is:unread is:starred newer_than:Nd older_than:Nd larger:N',
  'Plain words search the message. A leading - excludes a word.',
  'Answer with the query alone, on one line, with no explanation and no quotes around the whole thing.',
].join('\n');

// The operators the omnibox understands. Anything else the model emits is
// dropped: an operator the search parser does not know would be searched for
// as literal text, which finds nothing and looks broken.
const KNOWN = /^(from|to|subject|label|has|is|newer_than|older_than|larger):/i;

export function cleanQuery(raw: string): string {
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  const tokens = unwrap(line).match(/(?:-?[a-z_]+:(?:"[^"]*"|\S+))|-?"[^"]*"|\S+/gi) ?? [];
  const kept = tokens.filter((t) => {
    const bare = t.startsWith('-') ? t.slice(1) : t;
    if (!bare.includes(':')) return true;
    return KNOWN.test(bare);
  });
  return kept.join(' ').slice(0, 300);
}

// A model asked for a query sometimes wraps the whole thing in quotes. Both
// ends have to be quotes, and the same one, and there must be no other quote
// between them — otherwise the trailing quote belongs to a phrase search
// (`invoice "exact phrase"`) and taking it off would break the phrase.
function unwrap(line: string): string {
  const first = line[0];
  if (line.length < 2 || !['"', "'", '`'].includes(first) || line[line.length - 1] !== first) return line;
  const inner = line.slice(1, -1);
  return inner.includes(first) ? line : inner;
}

export async function draftSearch(userId: number, sentence: string): Promise<string> {
  const messages = buildSearchMessages(sentence);
  assertFreshConversation(messages);
  const raw = await chat({
    messages, maxTokens: 120, temperature: 0.1, noThink: true,
    owner: String(userId),
    consent: { userId, capability: 'nlrules' },
  });
  const q = cleanQuery(raw);
  if (!q) throw badRequest('That did not turn into a search. Try naming a sender, a subject or a date.');
  return q;
}
