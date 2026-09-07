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
  for (const { file, text } of sources()) {
    if (file === 'ai/llm.ts') continue; // the definition itself
    // Each call to chat/chatStream/embed, from the opening paren to the
    // matching one, must carry a consent. chat and chatStream take theirs as
    // a field of the options object; embed takes the texts first and the
    // consent second, so both spellings count.
    for (const m of text.matchAll(/\b(chat|chatStream|embed)\(/g)) {
      const start = m.index! + m[0].length;
      let depth = 1, i = start;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      const args = text.slice(start, i - 1);
      if (!/consent\s*:/.test(args) && !/capability\s*:/.test(args) && !/evalConsent\(/.test(args)) {
        offenders.push(`${file}: ${m[1]}(${args.slice(0, 70).replace(/\s+/g, ' ')}…)`);
      }
    }
  }
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
    'services/guard.ts',
    'services/mailImport.ts',
    'routes/mail.ts',
    'routes/review.ts',
    'routes/contacts.ts',
  ]);
  const offenders = sources()
    .filter(({ file, text }) => !allowList.has(file) && /\bdataKey\(/.test(text))
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
