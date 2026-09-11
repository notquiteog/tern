// A sentence becomes an audience, shown as chips somebody can take apart.
//
// The same shape as `nlRules.ts`, and for the same reasons. The model runs
// once, at the moment somebody is describing who to write to, and what comes
// back is not an action — it is a *draft of a filter*, over a vocabulary the
// contact list already accepts, rendered as the chips that list already draws.
// Nothing is enrolled until a person looks at it. A filter that is wrong is
// visible and removable one chip at a time, rather than a mystery that mails
// the wrong two hundred people.
//
// ── What the model is and is not allowed to decide ──────────────────────────
//
// It picks from closed lists: the tags this person actually has, the custom
// field keys they actually have, the reply intents the classifier actually
// writes. Anything it returns that is not on those lists is dropped rather
// than passed through, so a hallucinated tag narrows nothing instead of
// silently matching nobody.
//
// It does not do date arithmetic. "Who went quiet in March" gets answered with
// the word `march`, and `resolvePeriod` below turns that into two dates — the
// same rule the tools follow, for the reason the tools follow it: a
// well-formed wrong date is indistinguishable from a well-formed right one,
// and here it decides who gets mail.
//
// Nothing from a mailbox is sent. The prompt is the person's own sentence and
// their own labels.
import { query } from '../db.js';
import { chat } from '../ai/llm.js';
import { assertFreshConversation } from '../ai/prompts.js';
import { badRequest } from '../errors.js';
import { REPLY_INTENTS, type ReplyIntent } from './replyIntent.js';

export const AUDIENCE_STATUSES = ['active', 'replied', 'unsubscribed', 'bounced', 'do_not_contact'] as const;

/** Every filter the contact list accepts, and nothing else. */
export interface AudienceFilter {
  tag?: string;
  status?: string;
  intent?: ReplyIntent;
  /** The period an intent was expressed in, as the model said it. */
  period?: string;
  intentFrom?: string;
  intentTo?: string;
  quietDays?: number;
  fields?: { key: string; value: string }[];
  /** Free text, searched over name, company, title, notes and custom fields. */
  q?: string;
}

// ---------- Periods, resolved here and never by the model ----------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Seasons are northern-hemisphere and that is a real limitation, written down
// rather than hidden: "spring" from an Australian sender means the opposite
// three months. It is a chip with two dates on it that they can see and
// change, which is the whole reason the filter is shown rather than applied.
const SEASONS: Record<string, [number, number]> = {
  spring: [2, 4], summer: [5, 7], autumn: [8, 10], fall: [8, 10], winter: [11, 1],
};

function utc(y: number, m: number, d: number): Date { return new Date(Date.UTC(y, m, d)); }

/**
 * A period in words, turned into the two dates that bound it.
 *
 * Returns `to` as the exclusive end, which is what the contact route's
 * `intentTo` means — so "March" is the whole of March and not March minus its
 * last day, which is the off-by-one this shape exists to avoid.
 */
export function resolvePeriod(raw: string, now = new Date()): { from: string; to: string } | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[.,]/g, '');
  if (!s) return null;
  const year = now.getUTCFullYear();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const span = (a: Date, b: Date) => ({ from: iso(a), to: iso(b) });

  // "last 30 days", "past 2 weeks", "last 6 months".
  const rel = s.match(/^(?:in the )?(?:last|past)\s+(\d+)\s+(day|week|month)s?$/);
  if (rel) {
    const n = Number(rel[1]);
    const days = rel[2] === 'day' ? n : rel[2] === 'week' ? n * 7 : n * 30;
    return span(new Date(now.getTime() - days * 86_400_000), new Date(now.getTime() + 86_400_000));
  }
  if (/^(this|the current) (month)$/.test(s)) return span(utc(year, now.getUTCMonth(), 1), utc(year, now.getUTCMonth() + 1, 1));
  if (/^last month$/.test(s)) return span(utc(year, now.getUTCMonth() - 1, 1), utc(year, now.getUTCMonth(), 1));
  if (/^(this|the current) year$/.test(s)) return span(utc(year, 0, 1), utc(year + 1, 0, 1));
  if (/^last year$/.test(s)) return span(utc(year - 1, 0, 1), utc(year, 0, 1));

  // "Q1", "q3 last year".
  const q = s.match(/^q([1-4])(?:\s+(?:of\s+)?(last year|\d{4}))?$/);
  if (q) {
    const qy = !q[2] ? year : q[2] === 'last year' ? year - 1 : Number(q[2]);
    const start = (Number(q[1]) - 1) * 3;
    return span(utc(qy, start, 1), utc(qy, start + 3, 1));
  }

  // A month, with an optional year, and "last March" meaning the one behind us.
  const mon = s.match(/^(?:(this|last)\s+)?([a-z]+)(?:\s+(\d{4}))?$/);
  if (mon) {
    const idx = MONTHS.indexOf(mon[2]);
    if (idx >= 0) {
      let my = mon[3] ? Number(mon[3]) : year;
      // "March" said in January means the March coming; said in June it means
      // the one behind. Without a year, the nearest past occurrence is what
      // somebody describing an audience means — they are talking about people
      // who already did something.
      if (!mon[3] && idx > now.getUTCMonth()) my -= 1;
      if (mon[1] === 'last' && !mon[3]) my = idx > now.getUTCMonth() ? year - 1 : (idx === now.getUTCMonth() ? year - 1 : my);
      return span(utc(my, idx, 1), utc(my, idx + 1, 1));
    }
    const season = SEASONS[mon[2]];
    if (season) {
      const [a, b] = season;
      let sy = mon[3] ? Number(mon[3]) : year;
      if (!mon[3] && a > now.getUTCMonth()) sy -= 1;
      if (mon[1] === 'last' && !mon[3]) sy -= 1;
      // Winter wraps the year end.
      return b < a ? span(utc(sy, a, 1), utc(sy + 1, b + 1, 1)) : span(utc(sy, a, 1), utc(sy, b + 1, 1));
    }
  }
  return null;
}

// ---------- The prompt ----------

const SYSTEM = [
  'You turn one sentence into an audience filter for a contact list, expressed as JSON and nothing else.',
  '',
  'Shape:',
  '{"tag":"<one tag from the list>","status":"active|replied|unsubscribed|bounced|do_not_contact",',
  ' "intent":"interested|question|not_now|not_interested|wrong_person",',
  ' "period":"<when they replied, in words: march, last month, q1, last 30 days>",',
  ' "quietDays":<number>,',
  ' "fields":[{"key":"<one key from the list>","value":"<the value>"}],',
  ' "q":"<any words left over>"}',
  '',
  'Rules:',
  '- Leave out every key you have no reason to set. An empty filter is better than a guessed one.',
  '- Use only tags and field keys from the lists you are given. If the sentence names one that is not there, put the words in "q" instead.',
  '- "intent" is what they last replied. Only set it if the sentence is about a reply.',
  '- "period" only ever describes when they replied, and only alongside "intent".',
  '- "quietDays" is for "gone quiet", "not heard from", "no reply in N days".',
  '- Never work out a date. Write the period in words and it will be worked out for you.',
  '- Answer with the JSON object alone.',
].join('\n');

export function buildAudienceMessages(
  vocab: { tags: string[]; fieldKeys: string[] },
  sentence: string,
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `Tags that exist: ${vocab.tags.join(', ') || '(none)'}`,
        `Custom fields that exist: ${vocab.fieldKeys.join(', ') || '(none)'}`,
        '',
        `Audience: ${String(sentence).slice(0, 400)}`,
      ].join('\n'),
    },
  ];
}

/**
 * Whatever came back, reduced to a filter the contact list can actually run.
 *
 * Every value is checked against the vocabulary the route validates, so a
 * filter that gets this far is one the list can execute — and anything the
 * model invented is dropped on the floor rather than narrowing the audience to
 * nobody in a way that looks like "there is no one here".
 */
export function parseAudience(
  raw: string,
  vocab: { tags: string[]; fieldKeys: string[] },
  now = new Date(),
): AudienceFilter {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw badRequest('The model did not answer with an audience. Try describing it differently.');
  let j: any;
  try { j = JSON.parse(text.slice(start, end + 1)); } catch { throw badRequest('The model’s answer was not an audience. Try describing it differently.'); }

  const out: AudienceFilter = {};
  const tagBy = new Map(vocab.tags.map((t) => [t.toLowerCase(), t]));
  const tag = tagBy.get(String(j.tag ?? '').trim().toLowerCase());
  if (tag) out.tag = tag;

  const status = String(j.status ?? '').trim().toLowerCase();
  if ((AUDIENCE_STATUSES as readonly string[]).includes(status)) out.status = status;

  const intent = String(j.intent ?? '').trim().toLowerCase();
  // `stop`, `auto_reply` and `unclear` are real labels and not audiences: one
  // is a suppression and the other two describe the message rather than the
  // person.
  if ((REPLY_INTENTS as readonly string[]).includes(intent) && !['stop', 'auto_reply', 'unclear'].includes(intent)) {
    out.intent = intent as ReplyIntent;
  }

  // A period without an intent narrows nothing — the columns it filters only
  // exist on a reply — so it is dropped rather than shown as a chip that does
  // not do anything.
  const period = String(j.period ?? '').trim();
  if (period && out.intent) {
    const range = resolvePeriod(period, now);
    if (range) { out.period = period; out.intentFrom = range.from; out.intentTo = range.to; }
  }

  const quiet = Number(j.quietDays);
  if (Number.isFinite(quiet) && quiet > 0) out.quietDays = Math.min(3650, Math.round(quiet));

  const keyBy = new Map(vocab.fieldKeys.map((k) => [k.toLowerCase(), k]));
  const fields = (Array.isArray(j.fields) ? j.fields : [])
    .map((f: any) => {
      const key = keyBy.get(String(f?.key ?? '').trim().toLowerCase());
      const value = String(f?.value ?? '').trim().slice(0, 200);
      return key && value ? { key, value } : null;
    })
    .filter(Boolean)
    .slice(0, 5) as { key: string; value: string }[];
  if (fields.length) out.fields = fields;

  const q = String(j.q ?? '').trim().slice(0, 200);
  if (q) out.q = q;

  // An empty filter is every active contact, which is never what a sentence
  // meant and is the most expensive thing to get wrong.
  if (!Object.keys(out).length) throw badRequest('That did not describe an audience. Try naming a tag, a company, or what they last replied.');
  return out;
}

/** The filter as the query string the contact list already understands. */
export function audienceQuery(f: AudienceFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (f.tag) p.set('tag', f.tag);
  if (f.status) p.set('status', f.status);
  if (f.intent) p.set('intent', f.intent);
  if (f.intentFrom) p.set('intentFrom', f.intentFrom);
  if (f.intentTo) p.set('intentTo', f.intentTo);
  if (f.quietDays) p.set('quietDays', String(f.quietDays));
  if (f.q) p.set('q', f.q);
  for (const kv of f.fields ?? []) p.append('field', `${kv.key}:${kv.value}`);
  return p;
}

/**
 * The filter as chips, each one removable on its own.
 *
 * `key` is what the page deletes to take the chip off, and it matches the
 * field name on `AudienceFilter` — so removing a chip is deleting a property
 * rather than re-running the sentence through the model with a word taken out.
 */
export function audienceChips(f: AudienceFilter): { key: keyof AudienceFilter; label: string }[] {
  const chips: { key: keyof AudienceFilter; label: string }[] = [];
  if (f.tag) chips.push({ key: 'tag', label: `tagged ${f.tag}` });
  if (f.status) chips.push({ key: 'status', label: f.status.replace(/_/g, ' ') });
  if (f.intent) {
    const said: Record<string, string> = {
      interested: 'said interested', question: 'asked a question', not_now: 'said not now',
      not_interested: 'declined', wrong_person: 'pointed elsewhere',
    };
    chips.push({ key: 'intent', label: f.period ? `${said[f.intent]} in ${f.period}` : said[f.intent] });
  }
  if (f.quietDays) chips.push({ key: 'quietDays', label: `quiet ${f.quietDays} days` });
  for (const kv of f.fields ?? []) chips.push({ key: 'fields', label: `${kv.key} is ${kv.value}` });
  if (f.q) chips.push({ key: 'q', label: `matching “${f.q}”` });
  return chips;
}

/** The tags and field keys this person actually has, for the prompt. */
export async function audienceVocabulary(userId: number): Promise<{ tags: string[]; fieldKeys: string[] }> {
  const tags = await query<{ tag: string }>(
    `SELECT DISTINCT t AS tag FROM contacts c, unnest(c.tags) t WHERE c.user_id=$1 ORDER BY t LIMIT 200`,
    [userId],
  );
  const keys = await query<{ key: string }>(
    `SELECT DISTINCT k AS key FROM contacts c, jsonb_object_keys(c.fields) k WHERE c.user_id=$1 ORDER BY k LIMIT 100`,
    [userId],
  );
  return { tags: tags.map((t) => t.tag), fieldKeys: keys.map((k) => k.key) };
}

export async function draftAudience(userId: number, sentence: string): Promise<AudienceFilter> {
  const vocab = await audienceVocabulary(userId);
  const messages = buildAudienceMessages(vocab, sentence);
  assertFreshConversation(messages);
  const raw = await chat({
    messages, maxTokens: 300, temperature: 0.1, noThink: true,
    owner: String(userId),
    consent: { userId, capability: 'ai.campaigns' },
  });
  return parseAudience(raw, vocab);
}
