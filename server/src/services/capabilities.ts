// Consent and admin gating for everything that reads mail for a purpose
// other than showing it to its owner, and for everything that reaches the
// model.
//
// Two gates, both of which must be open:
//
//   1. The admin gate. Every capability can be switched off for the whole
//      install at any moment, from Admin → Features. Turning one off stops
//      the background work immediately and makes the routes 403; it does not
//      erase anyone's consent, so turning it back on restores what people had
//      already chosen. The heavy ones (embedding, transcription, extraction,
//      the brief) exist so an admin whose box is struggling has one place to
//      go, and one switch that definitely works.
//
//   2. The person's own consent. Nothing here is on for a new account.
//      Reading somebody's mail to build an index of it, or handing it to a
//      language model, is a thing to be asked for rather than defaulted into,
//      and "the admin turned it on for the install" is not the same as being
//      asked. Consent is per-capability, recorded with the moment it was
//      given, and withdrawing it deletes the data that capability produced.
//
// The gate is not a convention that call sites are trusted to follow. It is
// a required argument on the two functions that can read mail content
// (`openEmail`/`openEmails`) and on the two that can reach the model
// (`chat`/`chatStream`), so a call that does not name a capability does not
// compile. capabilities.test.ts additionally walks the source to catch a new
// path that finds some other way in.
import { one, query } from '../db.js';
import { forbidden } from '../errors.js';
import { logger } from '../log.js';

const log = logger('capabilities');

export const CAPABILITIES = [
  // Existing AI features, retro-fitted to the same gate as the new ones.
  'ai.compose',
  'ai.summaries',
  'ai.responders',
  'ai.campaigns',
  'ai.playground',
  // New.
  'semantic',
  'triage',
  'guard',
  'attachments',
  'commitments',
  'nlrules',
  'brief',
  'voice',
  'calendar',
  'links',
  'import',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityMeta {
  id: Capability;
  label: string;
  // Shown beside the switch. Written for the person deciding, not for the
  // person who wrote the code: it says what is read and what is kept.
  what: string;
  // Does turning this on mean something other than the browser reads the
  // content of messages?
  readsMail: boolean;
  // Does it reach a language model?
  usesAi: boolean;
  // Does it cost real CPU or memory on a small box? These are the ones an
  // admin is most likely to want off, so they are marked for the UI.
  heavy: boolean;
  // Admin-only capabilities are never offered to members.
  adminOnly?: boolean;
  // What withdrawing consent destroys, in one line, so the confirmation can
  // say it.
  erases?: string;
}

export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  'ai.compose': {
    id: 'ai.compose', label: 'Writing help',
    what: 'Drafting, replying, rewriting and quick replies send the conversation you have open to the model on this server.',
    readsMail: true, usesAi: true, heavy: false,
  },
  'ai.summaries': {
    id: 'ai.summaries', label: 'Conversation summaries',
    what: 'A one-line summary above each conversation. Reads the messages in it and keeps the line, encrypted, until the conversation changes.',
    readsMail: true, usesAi: true, heavy: true,
    erases: 'every summary written for you',
  },
  'ai.responders': {
    id: 'ai.responders', label: 'Automatic replies',
    what: 'Answers incoming mail on your behalf, as a draft, through the review queue, or sent. Reads every message a responder is pointed at.',
    readsMail: true, usesAi: true, heavy: true,
    erases: 'your responders and anything they have queued',
  },
  'ai.campaigns': {
    id: 'ai.campaigns', label: 'Personalised outreach',
    what: 'Writes a per-contact email from a brief, and personalises sequence steps. Reads your contacts, not your mailbox.',
    readsMail: false, usesAi: true, heavy: true,
  },
  'ai.playground': {
    id: 'ai.playground', label: 'Model playground',
    what: 'The admin prompt bench. Sends whatever is typed into it to the model; never reads a mailbox.',
    readsMail: false, usesAi: true, heavy: false, adminOnly: true,
  },
  semantic: {
    id: 'semantic', label: 'Meaning search',
    what: 'Reads each message once to build a search index of what it is about, so you can search for an idea rather than a word. The index is rotated with your own key before it is stored, and the words themselves are never in it.',
    readsMail: true, usesAi: true, heavy: true,
    erases: 'the whole meaning index',
  },
  triage: {
    id: 'triage', label: 'Priority ordering',
    what: 'Learns from what you archive, star, reply to and junk, using only the encrypted word hashes already in your search index. No message text is read and no model is involved.',
    readsMail: false, usesAi: false, heavy: false,
    erases: 'what it has learned about your mail',
  },
  guard: {
    id: 'guard', label: 'Impersonation guard',
    what: 'Compares the sender of each message against your contacts and the rest of the thread to catch lookalike addresses and hijacked conversations. Reads addresses and headers, never the body.',
    readsMail: false, usesAi: false, heavy: false,
    erases: 'the warnings recorded against your messages',
  },
  attachments: {
    id: 'attachments', label: 'Search inside attachments',
    what: 'Extracts the text of PDFs, Word and Excel files as they arrive so they can be searched and quoted. The extracted text is encrypted like the message body.',
    readsMail: true, usesAi: false, heavy: true,
    erases: 'the extracted text of every attachment',
  },
  commitments: {
    id: 'commitments', label: 'Commitments',
    what: 'Reads the mail you send and receive to find what you promised and what you are waiting on, and lists them.',
    readsMail: true, usesAi: true, heavy: true,
    erases: 'every commitment on your list',
  },
  nlrules: {
    id: 'nlrules', label: 'Rules and searches in plain English',
    what: 'Turns a sentence you type into a rule or a search you can then edit. Only your sentence goes to the model; your mailbox does not.',
    readsMail: false, usesAi: true, heavy: false,
  },
  brief: {
    id: 'brief', label: 'The brief',
    what: 'A page summarising what needs you. Reads recent conversations when you ask it to, and keeps the result, encrypted, until you regenerate it.',
    readsMail: true, usesAi: true, heavy: true,
    erases: 'your saved brief',
  },
  voice: {
    id: 'voice', label: 'Dictation',
    what: 'Speak into any text box. The recording is transcribed by a model on this server, is never written to disk, and is discarded the moment the text comes back.',
    readsMail: false, usesAi: true, heavy: true,
  },
  calendar: {
    id: 'calendar', label: 'Calendar',
    what: 'Recognises invitations in your mail, and syncs the calendars you connect (Google, Outlook, iCloud or any CalDAV server, or a subscribed address). Your events are stored encrypted on this server; connecting a calendar sends your availability to and from that provider, and nothing else leaves. Where a time matters — proposing one, answering an invitation, the daily brief — Tern reads which hours are taken, never what the meetings are.',
    readsMail: true, usesAi: false, heavy: false,
    erases: 'your connected calendars, the events synced from them, and the invitations found in your mail',
  },
  links: {
    id: 'links', label: 'Link cleaning',
    what: 'Strips tracking parameters from links you are shown and links you send, and unwraps redirect trackers so you can see where a link really goes.',
    readsMail: false, usesAi: false, heavy: false,
  },
  import: {
    id: 'import', label: 'Import an archive',
    what: 'Reads an mbox file you upload and files it into your encrypted cache. Nothing leaves this server.',
    readsMail: true, usesAi: false, heavy: true,
  },
};

// ---------- The admin gate ----------
// Stored under settings key `features` as {capability: boolean}. Absent means
// on: an admin who has never opened the page has not decided anything, and
// the person's own consent is still required before any of it runs.

export type FeatureFlags = Partial<Record<Capability, boolean>>;

let flagCache: { at: number; value: FeatureFlags } | null = null;
const FLAG_TTL_MS = 5_000;

export async function featureFlags(): Promise<FeatureFlags> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) return flagCache.value;
  const row = await one<{ value: FeatureFlags }>(`SELECT value FROM settings WHERE key='features'`);
  const value = row?.value ?? {};
  flagCache = { at: Date.now(), value };
  return value;
}

export function forgetFeatureFlags(): void { flagCache = null; }

export async function setFeatureFlag(cap: Capability, on: boolean): Promise<FeatureFlags> {
  const next = { ...(await featureFlags()), [cap]: on };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('features', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(next)],
  );
  flagCache = null;
  log.info(`capability ${cap} ${on ? 'enabled' : 'disabled'} for the install`);
  return next;
}

export async function adminEnabled(cap: Capability): Promise<boolean> {
  return (await featureFlags())[cap] !== false;
}

// ---------- The person's consent ----------

export async function consented(userId: number, cap: Capability): Promise<boolean> {
  const row = await one<{ n: number }>(
    'SELECT 1 AS n FROM user_capabilities WHERE user_id=$1 AND capability=$2',
    [userId, cap],
  );
  return Boolean(row);
}

export async function consentedSet(userId: number): Promise<Set<Capability>> {
  const rows = await query<{ capability: Capability }>('SELECT capability FROM user_capabilities WHERE user_id=$1', [userId]);
  return new Set(rows.map((r) => r.capability));
}

export async function grant(userId: number, cap: Capability): Promise<void> {
  await query(
    `INSERT INTO user_capabilities (user_id, capability, granted_at) VALUES ($1,$2,now())
     ON CONFLICT (user_id, capability) DO NOTHING`,
    [userId, cap],
  );
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'capability.granted',$2)`, [userId, cap]);
}

export async function revoke(userId: number, cap: Capability): Promise<void> {
  await query('DELETE FROM user_capabilities WHERE user_id=$1 AND capability=$2', [userId, cap]);
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'capability.revoked',$2)`, [userId, cap]);
}

// ---------- Both gates ----------

export async function allowed(userId: number, cap: Capability): Promise<boolean> {
  if (!(await adminEnabled(cap))) return false;
  return consented(userId, cap);
}

// The two reasons a capability is shut, kept apart so the message can say
// which: "your administrator turned this off" and "you have not turned this
// on" are different problems with different fixes.
export async function assertCapability(userId: number, cap: Capability): Promise<void> {
  const meta = CAPABILITY_META[cap];
  if (!(await adminEnabled(cap))) {
    throw forbidden(`${meta.label} is turned off for this server by an administrator`, 'capability_disabled');
  }
  if (!(await consented(userId, cap))) {
    throw forbidden(`Turn on “${meta.label}” in Settings → Features first`, 'capability_not_granted');
  }
}

// Express middleware for a whole route group.
export function requireCapability(cap: Capability) {
  return async (req: any, _res: any, next: any): Promise<void> => {
    try {
      if (CAPABILITY_META[cap].adminOnly && req.user?.role !== 'admin') {
        next(forbidden('Administrators only'));
        return;
      }
      await assertCapability(req.user.id, cap);
      next();
    } catch (e) { next(e); }
  };
}
