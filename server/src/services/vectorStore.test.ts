// The vector index, and the four properties that are not visible in a response.
//
// Qdrant answers 200 to a great many requests that are wrong. A search against
// the wrong collection returns confident nonsense; a payload carrying content
// leaks it into a second store that no backup captures; a point written
// without its account filter surfaces another account's mail. None of those
// fail — they succeed and are wrong, which is why they are checked here rather
// than left to an integration test that would also pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import ts from 'typescript';

import { collectionFor } from './vectorStore.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'compose.yml')) && fs.existsSync(path.join(dir, 'install.sh'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the repository to scan, starting from ${here}`);
}

function readReal(rel: string): string {
  const text = fs.readFileSync(path.join(repoRoot(), rel), 'utf8');
  assert.ok(text.length > 200, `${rel} is too short to have been read properly`);
  return text;
}

test('a collection is per user AND per model, because both change the geometry', () => {
  // Per user: vectors are rotated with a per-user key, so one collection
  // holding several rotations gives HNSW a graph built from distances that
  // mean nothing across users — which costs recall *within* a user.
  assert.notEqual(collectionFor(1, 'qwen3-embedding:4b'), collectionFor(2, 'qwen3-embedding:4b'));
  // Per model: vectors from two embedders are not comparable at all.
  assert.notEqual(collectionFor(1, 'qwen3-embedding:4b'), collectionFor(1, 'all-minilm'));
  // Stable, or yesterday's index is unreachable after a restart.
  assert.equal(collectionFor(1, 'qwen3-embedding:4b'), collectionFor(1, 'qwen3-embedding:4b'));
  // A tag with a colon and a slash must not produce a name needing escaping.
  assert.match(collectionFor(7, 'huihui_ai/qwen3.5-abliterated:9b'), /^tern_u7_[a-z0-9_]+$/);
});

test('two users cannot collide by having a model name that spans the separator', () => {
  // `tern_u1_` + `1_x` and `tern_u11_` + `x` must not be the same string. A
  // collision here would put two people's mail in one collection, which is the
  // one failure in this file that is a privacy incident rather than a quality
  // one.
  assert.notEqual(collectionFor(1, '1_x'), collectionFor(11, 'x'));
});

/** String literals in a module that are not docstrings or comments. */
function payloadKeysWritten(rel: string): string[] {
  const file = path.join(repoRoot(), rel);
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    // `payload: { ... }` — collect the property names inside it.
    if (ts.isPropertyAssignment(node)
      && node.name.getText(sf) === 'payload'
      && ts.isObjectLiteralExpression(node.initializer)) {
      for (const prop of node.initializer.properties) {
        if (prop.name) keys.push(prop.name.getText(sf).replace(/['"]/g, ''));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

test('the index is told the account and nothing else', () => {
  // Everything shown comes from the join back to Postgres, and that is not
  // tidiness: a point that outlived its email joins to no row and disappears
  // before anything is rendered, so the ON DELETE CASCADE guarantee holds by
  // construction rather than by a sweep having run recently. A payload
  // carrying a subject or a body would break that — the content would survive
  // in a store the cascade cannot reach and no backup captures.
  //
  // `account_id` is the one exception, and it has to be inside the search
  // rather than applied after: filtering afterwards means the top-k comes back
  // full of another account's mail and the caller sees fewer results than it
  // asked for, or none.
  const keys = payloadKeysWritten('server/src/services/vectorStore.ts');
  assert.ok(keys.length > 0, 'no payload object found — the scan has stopped matching');
  assert.deepEqual([...new Set(keys)], ['account_id'],
    `the index is being told more than the account: ${keys.join(', ')}. Content in a `
    + 'payload outlives the email it came from and is not in any backup.');
});

test('every search is filtered by account', () => {
  // A search written without the filter does not fail. It returns another
  // account's messages, scored perfectly well, and the join back to Postgres
  // will happily hydrate them because they do belong to this user.
  const src = readReal('server/src/services/vectorStore.ts');
  const searches = [...src.matchAll(/points\/(search|recommend)`/g)];
  assert.ok(searches.length >= 2, 'fewer search endpoints found than exist — the scan has stopped matching');
  const filters = [...src.matchAll(/key: 'account_id'/g)];
  assert.equal(filters.length, searches.length,
    `${searches.length} search calls but ${filters.length} account filters`);
});

test('the compose service has no profile and refuses to start unauthenticated', () => {
  const compose = readReal('compose.yml');
  const block = /\n  qdrant:\n([\s\S]*?)\n  [a-z]/.exec(compose);
  assert.ok(block, 'compose.yml no longer defines a qdrant service');
  assert.ok(!/^\s*profiles:/m.test(block[1]!),
    'qdrant carries a profile, so a plain `compose up` will not start it and search goes quiet');
  assert.match(block[1]!, /Refusing to start an unauthenticated vector index/,
    'the entrypoint no longer refuses an empty key — an index open to the compose network');
});

test('the key is generated on every install, not only when AI is on', () => {
  // The entrypoint refuses to start without one. That is safe for an opt-in
  // service and fatal for an unconditional one: a missing key would take the
  // whole stack down on a deployment that never wanted AI.
  const sh = readReal('install.sh');
  assert.match(sh, /QDRANT_API_KEY="\$\{QDRANT_API_KEY:-\$\(gen_secret 32\)\}"/,
    'install.sh does not unconditionally generate QDRANT_API_KEY');
  assert.ok(!/AI_ENABLED[^\n]*QDRANT_API_KEY|if \[ "\$AI_ENABLED" = 1 \][\s\S]{0,200}QDRANT_API_KEY=/.test(sh),
    'QDRANT_API_KEY is generated only when AI is enabled, but qdrant runs on every install');
});

test('the embed default agrees between compose and the code', () => {
  // compose passes AI_EMBED_MODEL into the container whether .env names it or
  // not, so this line WINS over config.ts. They disagreed once — compose said
  // all-minilm while the code said qwen3-embedding:4b — which meant every
  // containerised install silently got the small model.
  const compose = readReal('compose.yml');
  const cfg = readReal('server/src/config.ts');
  const fromCompose = /AI_EMBED_MODEL: \$\{AI_EMBED_MODEL:-([^}]+)\}/.exec(compose);
  const fromCode = /aiEmbedModel: env\('AI_EMBED_MODEL', '([^']+)'\)/.exec(cfg);
  assert.ok(fromCompose, 'compose.yml no longer passes AI_EMBED_MODEL');
  assert.ok(fromCode, 'config.ts no longer defaults aiEmbedModel');
  assert.equal(fromCompose[1], fromCode[1],
    `compose says ${fromCompose[1]} and config.ts says ${fromCode[1]}; compose wins, so the code default is decorative`);
});

test('a restore queues the re-index, because vectors are not in the backup', () => {
  // The backup is pg_dump + .env by design — vectors are derived. That leaves
  // a restored database describing an index that does not exist, and the only
  // thing standing between that and "search is silently broken for ever" is
  // this one statement.
  const bin = readReal('bin/tern');
  assert.match(bin, /UPDATE emails SET embedded=false/,
    'bin/tern restore does not queue a re-index, so a restored install has a database '
    + 'that thinks it is indexed and an index that is empty');
  assert.match(bin, /Meaning search will be thin/,
    'the restore does not say that meaning search will be degraded while it rebuilds');
});
