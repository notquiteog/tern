// The background passes that build what the new features read: the meaning
// index, the priority scores, the guard's flags, the text inside
// attachments, the commitments, the invitations.
//
// One file for all six because they share a shape and a set of rules, and
// the rules are the interesting part on a box this size:
//
//   - Every pass checks consent for the person it is about, on every tick.
//     An admin who turns a capability off, or a person who withdraws it,
//     stops the work inside twenty seconds rather than at the end of a
//     backlog.
//   - Only one pass runs per tick. A 4.5 GB box with a model resident cannot
//     embed a mailbox, transcribe a clip and answer somebody's composer at
//     the same time, and a scheduler that tries produces three slow things
//     instead of one fast one. They take turns, in the order below.
//   - Anything that reaches the model gives way to people. Embedding and
//     commitment scanning are marked background, so an interactive request
//     takes the slot first.
//   - Cheap before expensive. The guard and the triage scores cost no model
//     time at all, so they run to completion long before the index does.
import { query } from '../db.js';
import { logger } from '../log.js';
import { listAccounts, type AccountRow } from '../services/accounts.js';
import { allowed, type Capability } from '../services/capabilities.js';
import { indexBatch, indexContactsBatch, indexPending } from '../services/semantic.js';
import { retrain, scorePending } from '../services/triage.js';
import { guardBatch } from '../services/guard.js';
import { extractPending } from '../services/attachments.js';
import { scanThread, settleFromMail, threadsToScan } from '../services/commitments.js';
import { scanForInvitations } from '../services/calendarMail.js';
import { reblindAll } from '../routes/contacts.js';

const log = logger('enrichment');

// Which pass ran last, so they take turns rather than the first one always
// winning. Module state rather than a table: it is a fairness hint, and
// losing it on a restart costs nothing.
let cursor = 0;

type Pass = {
  name: string;
  capability: Capability;
  /** True when this pass needs the language model. */
  usesModel: boolean;
  run: (userId: number, accounts: AccountRow[]) => Promise<number>;
};

const PASSES: Pass[] = [
  {
    // Contacts and senders, joined on the blind hash.
    //
    // Two things were quietly not happening. `contacts.email_blind` — the
    // value a sender and a contact card meet on without either being readable
    // — had a column, an index and a helper, and nothing ever wrote to it, so
    // the priority model's `from_contact` signal was false for everybody. And
    // `contact_threads` was only ever filled by the live receive path, so mail
    // brought in from an archive was never linked to the people it was from —
    // on exactly the mail the README tells you to import first.
    //
    // Both are one indexed statement each and both no-op once an install is in
    // step, so this pass costs nothing on the tick after it finishes.
    name: 'contact-links',
    capability: 'triage',
    usesModel: false,
    run: async (userId, accounts) => {
      let n = await reblindAll(userId);
      for (const acc of accounts) {
        const rows = await query<{ n: number }>(
          `INSERT INTO contact_threads (contact_id, account_id, thread_id)
           SELECT DISTINCT c.id, e.account_id, e.thread_id
             FROM emails e
             JOIN contacts c ON c.email_blind = e.from_blind AND c.user_id = $2
            WHERE e.account_id = $1 AND e.from_blind IS NOT NULL
           ON CONFLICT DO NOTHING
           RETURNING 1 AS n`,
          [acc.id, userId],
        );
        n += rows.length;
      }
      return n;
    },
  },
  {
    name: 'guard',
    capability: 'guard',
    usesModel: false,
    run: async (userId, accounts) => {
      let n = 0;
      for (const acc of accounts) n += await guardBatch(userId, acc.id);
      return n;
    },
  },
  {
    name: 'triage',
    capability: 'triage',
    usesModel: false,
    run: async (userId) => {
      // Retraining is the expensive half and only worth doing when the
      // person has made more decisions; scoring is cheap and runs whenever
      // there is anything unscored.
      const scored = await scorePending(userId);
      if (await needsRetrain(userId)) await retrain(userId);
      return scored;
    },
  },
  {
    name: 'commitments-settle',
    capability: 'commitments',
    usesModel: false,
    run: (userId) => settleFromMail(userId),
  },
  {
    name: 'calendar',
    capability: 'calendar',
    usesModel: false,
    run: async (userId, accounts) => {
      let n = 0;
      for (const acc of accounts) n += await scanForInvitations(userId, acc);
      return n;
    },
  },
  {
    name: 'attachments',
    capability: 'attachments',
    usesModel: false,
    run: async (userId, accounts) => {
      let n = 0;
      for (const acc of accounts) n += await extractPending(userId, acc);
      return n;
    },
  },
  {
    name: 'semantic',
    capability: 'semantic',
    usesModel: true,
    run: (userId) => indexBatch(userId).then((r) => r.done),
  },
  {
    // Contact notes, so "people who mentioned month-end pain" is a real
    // query. Its own pass rather than part of the mail one: a mailbox has
    // tens of thousands of messages and an address book has hundreds, so
    // sharing a batch would mean contacts waiting behind the mail backlog
    // for days to index something that takes one pass.
    name: 'semantic-contacts',
    capability: 'semantic',
    usesModel: true,
    run: (userId) => indexContactsBatch(userId).then((r) => r.done),
  },
  {
    name: 'commitments-scan',
    capability: 'commitments',
    usesModel: true,
    run: async (userId, accounts) => {
      let n = 0;
      for (const acc of accounts) {
        for (const threadId of await threadsToScan(userId, acc.id)) n += await scanThread(userId, acc, threadId);
      }
      return n;
    },
  },
];

// Retrain when the person has made a few hundred more decisions than the
// model was fitted on, or when a week has passed. Cheap to check and it
// stops a mailbox in constant use refitting on every tick.
async function needsRetrain(userId: number): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM emails e
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN triage_models t ON t.user_id = a.user_id
      WHERE a.user_id=$1 AND (t.trained_at IS NULL OR e.updated_at > t.trained_at)`,
    [userId],
  );
  if ((rows[0]?.n ?? 0) > 200) return true;
  const stale = await query<{ old: boolean }>(
    `SELECT trained_at < now() - interval '7 days' AS old FROM triage_models WHERE user_id=$1`,
    [userId],
  );
  return stale[0]?.old ?? true;
}

// One pass, for one person, per tick. Returns what it did so the caller can
// log something useful and so the tests can drive it.
export async function enrichmentTick(): Promise<{ pass: string; user: number; count: number } | null> {
  const users = await query<{ id: number }>(
    `SELECT DISTINCT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
      WHERE NOT u.disabled ORDER BY u.id`,
  );
  if (!users.length) return null;

  // Walk passes and people together, so neither a person with a huge backlog
  // nor a pass with nothing to do can starve the rest.
  const total = PASSES.length * users.length;
  for (let step = 0; step < total; step++) {
    const at = (cursor + step) % total;
    const pass = PASSES[at % PASSES.length];
    const user = users[Math.floor(at / PASSES.length) % users.length];
    if (!(await allowed(user.id, pass.capability))) continue;

    let accounts: AccountRow[];
    try { accounts = (await listAccounts(user.id)).filter((a) => a.enabled); } catch { continue; }
    if (!accounts.length) continue;

    try {
      const count = await pass.run(user.id, accounts);
      if (count > 0) {
        cursor = at + 1;
        return { pass: pass.name, user: user.id, count };
      }
    } catch (e) {
      // A pass that fails must not stop the others, and must not retry
      // immediately: moving the cursor past it is the whole recovery.
      log.warn(`${pass.name} failed`, { user: user.id, err: (e as Error).message });
      cursor = at + 1;
      return { pass: pass.name, user: user.id, count: 0 };
    }
  }
  // Nothing had anything to do. Start somewhere else next time so the same
  // pass is not always asked first.
  cursor = (cursor + 1) % Math.max(1, total);
  return null;
}

// How much is left, for the settings pages. Cheap counts only; nothing here
// opens a message.
export async function enrichmentStatus(userId: number): Promise<Record<string, number>> {
  const [semantic, attachments, guard] = await Promise.all([
    indexPending(userId),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id
        WHERE a.user_id=$1 AND e.has_attachment AND NOT e.attachments_extracted`, [userId]),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id
        WHERE a.user_id=$1 AND NOT e.guard_checked`, [userId]),
  ]);
  return {
    semantic,
    attachments: attachments[0]?.n ?? 0,
    guard: guard[0]?.n ?? 0,
  };
}
