// The consent gate, and an audit that it is still the only way in.
//
// Two of these tests read the source of the server rather than calling it.
// That is deliberate. The gate is enforced by the type system — a call that
// does not name a reader or a consent will not compile — but the type system
// cannot stop somebody reaching past it: `dataKey` plus `openEmailWith` will
// open a mailbox with no questions asked, because the backfill and the list
// renderer legitimately need exactly that. So those two are allow-listed by
// file here. Adding a new file to the list is a deliberate act with a
// reviewer attached, which is the property that was wanted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, CAPABILITY_META, type Capability } from './capabilities.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      out.push({ file: path.relative(SRC, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

// ---------- The registry ----------

test('every capability has a description a person could act on', () => {
  for (const id of CAPABILITIES) {
    const m = CAPABILITY_META[id];
    assert.ok(m, `${id} has no metadata`);
    assert.equal(m.id, id);
    assert.ok(m.label.length > 2, `${id} needs a label`);
    assert.ok(m.what.length > 40, `${id} needs to say what it reads and what it keeps`);
  }
});

test('the registry and the metadata cannot drift apart', () => {
  assert.deepEqual(Object.keys(CAPABILITY_META).sort(), [...CAPABILITIES].sort());
});

test('anything that reads mail or reaches a model says so', () => {
  // Used by the settings page to group the switches and to warn before the
  // first one is turned on. A capability that quietly claims neither would
  // appear in the list without the sentence that matters.
  const readsOrUses = CAPABILITIES.filter((c) => CAPABILITY_META[c].readsMail || CAPABILITY_META[c].usesAi);
  assert.ok(readsOrUses.length >= 10);
  for (const c of readsOrUses) {
    assert.ok(CAPABILITY_META[c].what.length > 0);
  }
});

// ---------- The audit ----------

// The two functions that hand back decrypted mail, and the three that reach
// the model, all take the gate as a required argument. This checks that the
// argument is a literal at every call site rather than something threaded
// through from a caller that might have guessed.
test('every mailbox read names its reader', () => {
  const allowed = new Set<string>(["'owner'", ...CAPABILITIES.map((c) => `'${c}'`)]);
  const offenders: string[] = [];
  for (const { file, text } of sources()) {
    if (file === 'services/mailVault.ts') continue; // the definitions themselves
    for (const m of text.matchAll(/\bopenEmails?\(\s*([^,]+),\s*([^,]+),/g)) {
      const reader = m[2].trim();
      if (!allowed.has(reader)) offenders.push(`${file}: openEmail(..., ${reader}, ...)`);
    }
  }
  assert.deepEqual(offenders, [], `a mailbox read must name 'owner' or a capability:\n${offenders.join('\n')}`);
});

test('every generation carries a consent', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const { file, text } of sources()) {
    if (file === 'ai/llm.ts' || file === 'ai/media.ts') continue; // the definitions themselves
    // Each call to chat/chatStream/embed/generateImage/startVideo, from the
    // opening paren to the matching one, must carry a consent. chat and
    // chatStream take theirs as a field of the options object; embed and the
    // two media calls take their subject first and the consent second, so both
    // spellings count.
    //
    // The two media names are here because a rule that lists the functions it
    // binds is a rule you leave by adding a function. Drawing a picture on
    // somebody's behalf reaches a model and costs their administrator money;
    // it is the same class of thing as a draft, and it should not have been
    // possible to add it outside the gate by writing a new verb.
    //
    // `agentStream` is the newest verb and proves the point: it is the
    // assistant's own entry into the model, it takes the same `consent`
    // argument for the same reason, and a version of this list written before
    // it existed would have let a whole conversation reach a model ungated
    // while still reporting clean.
    for (const m of text.matchAll(/\b(chat|chatStream|agentStream|embed|generateImage|startVideo)\(/g)) {
      const start = m.index! + m[0].length;
      let depth = 1, i = start;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      const args = text.slice(start, i - 1);
      seen++;
      if (!/consent\s*:/.test(args) && !/capability\s*:/.test(args) && !/evalConsent\(/.test(args)) {
        offenders.push(`${file}: ${m[1]}(${args.slice(0, 70).replace(/\s+/g, ' ')}…)`);
      }
    }
  }
  // A scan that matched nothing produces an empty offender list, which is
  // exactly what "clean" looks like. Far under the real figure, so ordinary
  // edits never approach it.
  assert.ok(seen >= 15, `only ${seen} model calls found at all — the scan has stopped matching, and this check would report clean on that`);
  assert.deepEqual(offenders, [], `every model call needs a consent:\n${offenders.join('\n')}`);
});

test('the raw key is only reachable from files that are meant to have it', () => {
  // `dataKey` returns the unwrapped key, which opens anything. These are the
  // places that legitimately need it: the vault, the sealing helpers, the
  // renderers that open one column of an owner's own row, and the backfill
  // that re-seals what an older build wrote in the clear. Anything else
  // reaching for it is going around the gate.
  const allowList = new Set([
    'services/vault.ts',
    'services/mailVault.ts',
    'services/backfill.ts',
    'services/summaries.ts',
    'services/semantic.ts',
    'services/triage.ts',
    'services/attachments.ts',
    'services/extract.ts',
    'services/commitments.ts',
    'services/brief.ts',
    'services/calendarMail.ts',
    // F13. The calendar store seals and opens a person's own calendar rows
    // the way mailVault does for their mail; the orchestrator opens the
    // remote ids it needs to match a server's listing against what is
    // already held. Neither reads anybody else's row.
    'services/calendar/store.ts',
    'services/calendar/index.ts',
    'services/guard.ts',
    'services/mailImport.ts',
    // The assistant's transcript store. It seals and opens one person's own
    // conversation rows the way summaries.ts does for their summaries, and it
    // is the only file outside `services/` on this list — it lives under `ai/`
    // because it is the assistant's own storage rather than a service anything
    // else calls, and it reads nobody's row but the owner's, scoped by user_id
    // in every statement.
    'ai/conversation.ts',
    // The contact digest opens the subject lines of the owner's own
    // conversations to give the model something to write a paragraph over,
    // and the calendar objects it scans for meetings with one person. Both
    // are the owner's rows, scoped by user_id in every statement, and both
    // are behind capabilities that were already open before it read anything.
    'services/contactDigest.ts',
    // The writing-voice pass seals and opens pairs of the owner's own
    // outgoing mail — what the model wrote, and what they sent instead. Same
    // shape as summaries.ts: one person's rows, their own key, nobody else's
    // anything.
    'services/voiceLearning.ts',
    // The Replies tab opens the subject, preview and body of replies to the
    // owner's own campaigns — their mail, in their app, because they asked
    // for it — to show the row and to read a handover out of a "wrong person"
    // answer. Every statement is scoped by user_id, and no model is involved:
    // the body is read by a regular expression and then dropped.
    'services/campaignReplies.ts',
    'routes/mail.ts',
    'routes/review.ts',
    'routes/contacts.ts',
    // The end-to-end suites open sealed columns on purpose: proving that
    // what lands in Postgres is unreadable means reading it back with the
    // key and checking it matches. That is the check, not a way around it.
    'e2e/features.e2e.ts',
    'e2e/calendar.e2e.ts',
  ]);
  // Importing it under another name was a way past this: `dataKey as
  // dataKeyFor` never produces the call shape below, so a file could take
  // the key and never be counted. The import is checked as well as the call.
  const reaches = (text: string) => /\bdataKey\(/.test(text) || /\bdataKey\s+as\s+\w+/.test(text);
  const offenders = sources()
    .filter(({ file, text }) => !allowList.has(file) && reaches(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], `these files reach the raw data key without being on the list:\n${offenders.join('\n')}`);
});

test('no capability is granted by being absent', () => {
  // The whole design rests on this: a user row with no capability rows has
  // consented to nothing. The check is that the code never reads a default
  // from the metadata — there is no `defaultOn` field to read.
  for (const id of CAPABILITIES) {
    assert.ok(!('defaultOn' in (CAPABILITY_META[id] as unknown as Record<string, unknown>)), `${id} must not carry a default`);
  }
});

test('admin-only capabilities are never offered to members', () => {
  const adminOnly = CAPABILITIES.filter((c) => CAPABILITY_META[c].adminOnly);
  assert.deepEqual(adminOnly, ['ai.playground' as Capability]);
});
