// F2: priority ordering learned from what this person actually does.
//
// The trick is that the training data is already there and already
// encrypted. `emails.search_terms` is a bag of HMAC-SHA256 terms under the
// person's own key — which is to say, a feature-hashed document vector. A
// linear model over those hashes learns the same thing it would learn from
// the words, and at no point does anything here see a word. There is no
// model to load, nothing leaves the process, and a training pass over a
// mailbox is milliseconds.
//
// The labels are free too, and they are honest: they are things the person
// did, not things they were asked. Archiving without opening is a strong
// negative. Replying is the strongest positive there is. Starring, junking
// and unsubscribing say what they say.
//
// What it produces is an ordering, never a filter. Nothing is hidden, moved
// or marked read on the strength of a guess; the list gets another way to
// sort itself and the person can ignore it. That distinction is the whole
// reason this is safe to ship: the failure mode of a wrong prediction is a
// message further down a list, not a message nobody ever saw.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { dataKey, openWith, sealWith } from './vault.js';
import { allowed } from './capabilities.js';

const log = logger('triage');

// Hashed terms are 12 bytes; they are folded into a fixed number of buckets
// so the weight vector has a fixed size whatever the vocabulary does.
// 2^14 buckets over a few hundred thousand distinct terms collides often
// enough to be a feature — it is what keeps the model small — and rarely
// enough to learn.
const BUCKETS = 1 << 14;

// Plain signals that are not words. They go in their own buckets at the top
// so they can never be shadowed by a collision.
const SIGNALS = [
  'has_attachment', 'is_list', 'auto_submitted', 'to_me_directly', 'many_recipients',
  'from_contact', 'thread_has_my_reply', 'first_time_sender', 'out_of_hours', 'is_flagged_domain',
] as const;
const SIGNAL_BASE = BUCKETS;
const WIDTH = BUCKETS + SIGNALS.length;

export interface Features { terms: number[]; signals: Partial<Record<(typeof SIGNALS)[number], boolean>> }

export function bucketOf(term: Buffer): number {
  // The first four bytes of an HMAC are as uniform as the whole of it.
  return term.readUInt32BE(0) % BUCKETS;
}

export function featuresOf(row: {
  search_terms?: Buffer[] | null; has_attachment?: boolean; auto_submitted?: string | null;
  list_id?: string | null; to_count?: number; from_contact?: boolean; my_reply?: boolean;
  first_time?: boolean; received_at?: Date | string;
}): Features {
  const terms = [...new Set((row.search_terms ?? []).map(bucketOf))];
  const hour = row.received_at ? new Date(row.received_at).getHours() : 12;
  return {
    terms,
    signals: {
      has_attachment: Boolean(row.has_attachment),
      is_list: Boolean(row.list_id),
      auto_submitted: Boolean(row.auto_submitted && row.auto_submitted !== 'no'),
      to_me_directly: (row.to_count ?? 1) <= 2,
      many_recipients: (row.to_count ?? 1) > 5,
      from_contact: Boolean(row.from_contact),
      thread_has_my_reply: Boolean(row.my_reply),
      first_time_sender: Boolean(row.first_time),
      out_of_hours: hour < 7 || hour >= 20,
    },
  };
}

// ---------- The model ----------

export interface TriageModel { w: Float32Array; bias: number; samples: number; accuracy: number | null }

function blank(): TriageModel { return { w: new Float32Array(WIDTH), bias: 0, samples: 0, accuracy: null }; }

export function score(model: TriageModel, f: Features): number {
  let z = model.bias;
  for (const b of f.terms) z += model.w[b];
  for (let i = 0; i < SIGNALS.length; i++) if (f.signals[SIGNALS[i]]) z += model.w[SIGNAL_BASE + i];
  // Logistic, then 0..100 so it can live in a smallint and sort in SQL.
  return Math.round(100 / (1 + Math.exp(-z)));
}

// One pass of logistic regression by stochastic gradient descent. Sparse:
// only the buckets a message actually touches are updated, so the cost is
// proportional to the number of distinct words rather than to the width of
// the model.
export function train(rows: { features: Features; label: 0 | 1 }[], epochs = 8, lr = 0.12, l2 = 1e-5): TriageModel {
  const m = blank();
  if (!rows.length) return m;
  // Shuffle deterministically so a training pass is reproducible; the order
  // of a mailbox is not information the model should be picking up.
  const order = rows.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = (i * 2654435761) % (i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const idx of order) {
      const { features, label } = rows[idx];
      const p = 1 / (1 + Math.exp(-rawScore(m, features)));
      const g = (p - label) * lr;
      m.bias -= g;
      for (const b of features.terms) m.w[b] -= g + l2 * m.w[b];
      for (let i = 0; i < SIGNALS.length; i++) {
        if (features.signals[SIGNALS[i]]) m.w[SIGNAL_BASE + i] -= g + l2 * m.w[SIGNAL_BASE + i];
      }
    }
  }
  m.samples = rows.length;
  // Accuracy on the training set itself. It is not a held-out number and is
  // not presented as one: the settings page shows it as "fits N of your last
  // M decisions", which is what it is.
  let right = 0;
  for (const r of rows) if ((score(m, r.features) >= 50 ? 1 : 0) === r.label) right++;
  m.accuracy = right / rows.length;
  return m;
}

function rawScore(m: TriageModel, f: Features): number {
  let z = m.bias;
  for (const b of f.terms) z += m.w[b];
  for (let i = 0; i < SIGNALS.length; i++) if (f.signals[SIGNALS[i]]) z += m.w[SIGNAL_BASE + i];
  return z;
}

// ---------- Storage ----------
// The weights are learned from one person's mail, so they are sealed like
// everything else that is. Float32 little-endian, base64 in a sealed column.

export async function saveModel(userId: number, m: TriageModel): Promise<void> {
  const dek = await dataKey(userId);
  const payload = JSON.stringify({ bias: m.bias, w: Buffer.from(m.w.buffer, m.w.byteOffset, m.w.byteLength).toString('base64') });
  await query(
    `INSERT INTO triage_models (user_id, weights, samples, accuracy, trained_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id) DO UPDATE SET weights=EXCLUDED.weights, samples=EXCLUDED.samples, accuracy=EXCLUDED.accuracy, trained_at=now()`,
    [userId, sealWith(dek, payload), m.samples, m.accuracy],
  );
}

export async function loadModel(userId: number): Promise<TriageModel | null> {
  const row = await one<{ weights: string; samples: number; accuracy: number | null }>(
    'SELECT weights, samples, accuracy FROM triage_models WHERE user_id=$1',
    [userId],
  );
  if (!row) return null;
  const text = openWith(await dataKey(userId), row.weights);
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const buf = Buffer.from(j.w, 'base64');
    const w = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (w.length !== WIDTH) return null;
    return { w: Float32Array.from(w), bias: Number(j.bias) || 0, samples: row.samples, accuracy: row.accuracy };
  } catch { return null; }
}

// ---------- Labels from what happened ----------
// Everything below reads columns that are not secret — keywords, mailbox
// membership, timestamps — plus the sealed term list, which stays sealed.

// Everything the features are built from, in one pass. Three of the columns
// are hashes under the person's own key (`search_terms`, `from_blind`) and
// the rest are facts about a message rather than words from one, so the
// query never has to open anything.
//
// "How many did I have from this sender before" is a window count over
// `from_blind` rather than a correlated subquery: one sort instead of one
// scan per row, which is the difference between a second and a minute on a
// real mailbox.
const FEATURE_SQL = `
  SELECT e.id, e.account_id, e.search_terms, e.has_attachment, e.auto_submitted, e.received_at,
         e.keywords, e.mailbox_ids, e.list_id, e.from_blind, e.thread_id,
         coalesce(e.recipient_count, 1) AS to_count,
         count(*) OVER (PARTITION BY e.account_id, e.from_blind
                        ORDER BY e.received_at
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) = 0 AS first_time
    FROM emails e JOIN accounts a ON a.id=e.account_id
   WHERE a.user_id=$1 AND e.received_at > now() - ($3 || ' days')::interval
     AND ($4::boolean IS NOT TRUE OR e.priority IS NULL)
   ORDER BY e.received_at DESC LIMIT $2`;

// Which of this person's contacts a sender hash belongs to. One query, held
// as a set of hex strings, because a `bytea` cannot be a Map key.
async function contactSenders(userId: number): Promise<Set<string>> {
  const rows = await query<{ email_blind: Buffer | null }>(
    'SELECT email_blind FROM contacts WHERE user_id=$1 AND email_blind IS NOT NULL',
    [userId],
  );
  return new Set(rows.map((r) => r.email_blind!.toString('hex')));
}

// Which threads this person has replied in, as a set of "account:thread".
// A reply is the strongest signal there is, and it is a property of the
// conversation rather than of one message in it.
async function repliedThreads(userId: number): Promise<Set<string>> {
  const rows = await query<{ account_id: number; thread_id: string }>(
    `SELECT DISTINCT e.account_id, e.thread_id
       FROM emails e
       JOIN mailboxes m ON m.account_id = e.account_id AND m.role = 'sent'
       JOIN accounts a ON a.id = e.account_id
      WHERE a.user_id = $1 AND e.mailbox_ids @> ARRAY[m.jmap_id]`,
    [userId],
  );
  return new Set(rows.map((r) => `${r.account_id}:${r.thread_id}`));
}

// A message is "wanted" when the person engaged with it, and "not wanted"
// when they got rid of it without engaging. Everything in between is left
// out of training rather than guessed at: an unread message sitting in the
// inbox is not evidence of anything yet.
export function labelOf(row: any, boxes: MailboxRoles, replied: Set<string>): 0 | 1 | null {
  const kw: string[] = row.keywords ?? [];
  const boxIds: string[] = row.mailbox_ids ?? [];
  if (boxIds.some((b) => boxes.sent.has(b))) return null; // our own mail
  if (kw.includes('$flagged')) return 1;
  if (replied.has(`${row.account_id}:${row.thread_id}`)) return 1;
  if (boxIds.some((b) => boxes.junk.has(b)) || boxIds.some((b) => boxes.trash.has(b))) return 0;
  const seen = kw.includes('$seen');
  const archived = boxIds.some((b) => boxes.archive.has(b));
  if (archived && !seen) return 0;   // filed away without ever being opened
  if (archived && seen) return 1;    // read, then kept
  return null;
}

export interface MailboxRoles { archive: Set<string>; trash: Set<string>; junk: Set<string>; sent: Set<string> }

async function mailboxRoles(userId: number): Promise<MailboxRoles> {
  const rows = await query<{ jmap_id: string; role: string }>(
    'SELECT m.jmap_id, m.role FROM mailboxes m JOIN accounts a ON a.id=m.account_id WHERE a.user_id=$1 AND m.role IS NOT NULL',
    [userId],
  );
  const out: MailboxRoles = { archive: new Set(), trash: new Set(), junk: new Set(), sent: new Set() };
  for (const r of rows) {
    if (r.role === 'archive') out.archive.add(r.jmap_id);
    else if (r.role === 'trash') out.trash.add(r.jmap_id);
    else if (r.role === 'junk' || r.role === 'spam') out.junk.add(r.jmap_id);
    else if (r.role === 'sent') out.sent.add(r.jmap_id);
  }
  return out;
}

function rowFeatures(row: any, contacts: Set<string>, replied: Set<string>): Features {
  return featuresOf({
    ...row,
    from_contact: Boolean(row.from_blind && contacts.has(row.from_blind.toString('hex'))),
    my_reply: replied.has(`${row.account_id}:${row.thread_id}`),
  });
}

// The smallest number of decisions worth learning from. Below it the model
// would be describing an accident, and the settings page says "keep using
// Tern for a few days" rather than showing a number nobody should trust.
export const MIN_SAMPLES = 40;

export async function retrain(userId: number): Promise<{ trained: boolean; samples: number; accuracy: number | null }> {
  if (!(await allowed(userId, 'triage'))) return { trained: false, samples: 0, accuracy: null };
  const [boxes, contacts, replied] = await Promise.all([mailboxRoles(userId), contactSenders(userId), repliedThreads(userId)]);
  const rows = await query<any>(FEATURE_SQL, [userId, 4000, 180, false]);
  const set: { features: Features; label: 0 | 1 }[] = [];
  for (const r of rows) {
    const label = labelOf(r, boxes, replied);
    if (label === null) continue;
    set.push({ features: rowFeatures(r, contacts, replied), label });
  }
  if (set.length < MIN_SAMPLES) return { trained: false, samples: set.length, accuracy: null };
  // A mailbox that is 95% archive would otherwise teach the model to say
  // "no" to everything and be right. Both classes are capped at the size of
  // the smaller one.
  const pos = set.filter((s) => s.label === 1);
  const neg = set.filter((s) => s.label === 0);
  const cap = Math.max(Math.floor(MIN_SAMPLES / 2), Math.min(pos.length, neg.length));
  const balanced = [...pos.slice(0, cap), ...neg.slice(0, cap)];
  const model = train(balanced);
  await saveModel(userId, model);
  log.info('triage model trained', { user: userId, samples: model.samples, accuracy: model.accuracy });
  return { trained: true, samples: model.samples, accuracy: model.accuracy };
}

// Scores whatever has no score yet. Cheap enough to run on every tick.
export async function scorePending(userId: number, limit = 400): Promise<number> {
  if (!(await allowed(userId, 'triage'))) return 0;
  const model = await loadModel(userId);
  if (!model) return 0;
  const [contacts, replied] = await Promise.all([contactSenders(userId), repliedThreads(userId)]);
  const rows = await query<any>(FEATURE_SQL, [userId, limit, 365, true]);
  if (!rows.length) return 0;
  const ids: number[] = [];
  const scores: number[] = [];
  for (const r of rows) { ids.push(r.id); scores.push(score(model, rowFeatures(r, contacts, replied))); }
  // One statement for the batch: a per-row update over four hundred messages
  // is four hundred round trips the scheduler does not need to make.
  await query(
    `UPDATE emails e SET priority = v.p
       FROM (SELECT * FROM unnest($1::bigint[], $2::smallint[]) AS t(id, p)) v
      WHERE e.id = v.id`,
    [ids, scores],
  );
  return rows.length;
}

export function explain(model: TriageModel, f: Features): string[] {
  const out: string[] = [];
  const named: [string, string][] = [
    ['thread_has_my_reply', 'you have replied in this conversation'],
    ['from_contact', 'the sender is in your contacts'],
    ['to_me_directly', 'it was addressed to you directly'],
    ['is_list', 'it came from a mailing list'],
    ['auto_submitted', 'it was sent automatically'],
    ['many_recipients', 'it went to a lot of people'],
    ['first_time_sender', 'this sender is new to you'],
    ['has_attachment', 'it has an attachment'],
    ['out_of_hours', 'it arrived outside your usual hours'],
  ];
  for (const [key, phrase] of named) {
    if (!f.signals[key as (typeof SIGNALS)[number]]) continue;
    const w = model.w[SIGNAL_BASE + SIGNALS.indexOf(key as (typeof SIGNALS)[number])];
    if (Math.abs(w) < 0.05) continue;
    out.push(`${w > 0 ? 'higher' : 'lower'}: ${phrase}`);
  }
  return out.slice(0, 3);
}
