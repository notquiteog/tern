// Every call to a model server carries that endpoint's connection.
//
// ── Why this is a grep and not a mock ─────────────────────────────────────
//
// Because the failure is a line of code rather than a behaviour. A request
// written with plain `fetch`, or with `outboundFetch` and no transport, does
// not fail — it SUCCEEDS, and it succeeds by going direct, with the system
// certificate store and no proxy. The admin turned Tor on for that endpoint,
// the page shows it on, the draft comes back, and the model host learned this
// server's address anyway. No assertion about the response catches it, because
// the response is fine.
//
// This has already happened here once, and `ai/endpoint.ts` records it: the
// version of `transportFor` that returned only the certificate half shipped
// with one of fifteen call sites having forgotten it, so `openaiStream` went
// out bare — the connection test passed while every draft failed. Returning
// one value that carries everything fixed the half-application. It does not
// fix the omission, and this does.
//
// The exemption is `// transport-exempt: <why>` on the call or in the comment
// block above it, which makes an unproxied call a deliberate, reviewable act
// rather than something nobody noticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));


/**
 * The source tree, found rather than assumed.
 *
 * A guard anchored on its own file's location scans the wrong directory the
 * moment the tests are compiled: `npm test` builds to `dist-test/`, which
 * contains no `.ts` files at all, so `readdirSync(here)` returned an empty
 * list and every check below passed by having nothing to look at. It was green
 * in the suite and red only when run against the sources directly.
 *
 * That is the worst failure mode a guard can have — not wrong, but vacuous —
 * so `sources()` asserts it found something, and this walks up to the real
 * `src` wherever the compiled copy happens to be run from.
 */
function srcRoot(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === 'src') return dir;
    const candidate = path.join(dir, 'src');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the source tree to scan, starting from ${here}`);
}

const root = srcRoot();

/**
 * Every file that reaches a model server, and therefore every file the
 * transport rule binds.
 *
 * `ai/` is most of it, but not all of it, and assuming otherwise was the first
 * version's mistake: `services/voice.ts` is where the TRANSCRIPTION endpoint
 * lives — a model server like any other, with its own address, key,
 * certificate rule and Tor switch — and it sat entirely outside a rule written
 * as "the ai directory". It happens to do everything right. Nothing was
 * checking that it did.
 */
function sources(): string[] {
  const ai = path.join(root, 'ai');
  const inAi = fs.readdirSync(ai)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.eval.ts'))
    .map((f) => path.join(ai, f));
  const found = [...inAi, path.join(root, 'services', 'voice.ts')];
  // A guard that scans nothing must fail, not pass.
  assert.ok(found.length > 5, `only ${found.length} sources found under ${ai} — the scan is looking in the wrong place`);
  for (const f of found) assert.ok(fs.existsSync(f), `${f} is on the bound list and does not exist`);
  return found;
}

/**
 * Anything that opens a socket, in any library.
 *
 * `outboundFetch` counts because it can be called bare. The rest are here
 * because a guard you can step around by changing library is not a guard: the
 * next person to add a model call may reach for `node:https` or install
 * something, and neither should quietly escape the rule. Tern has no HTTP
 * dependency today, which is exactly why the pattern should already know about
 * one — the check is worth nothing if it has to be remembered at the same
 * moment the mistake is made.
 */
const OUTBOUND = /(?:^|[^.\w])fetch\(|\boutboundFetch\(|https?\.request\(|\brequest\(\s*\{|\baxios\b|\bundici\b|\bgot\(/;

/** What makes it carry the endpoint's certificate rule and proxy. */
const CARRIES = /transportFor\(|endpointTransport\(|\btrust\b|TlsTrust/;

const EXEMPT = /\/\/\s*transport-exempt:/;

/**
 * The text of one call, from its opening bracket to the matching close.
 *
 * Brackets inside string literals are not excluded, which can only ever make
 * the span END LATE — the safe direction is the other one, so the walk is
 * capped at sixty lines and a call that never balances is reported rather than
 * silently passed.
 */
function callSpan(lines: string[], start: number): string {
  let depth = 0;
  let seen = false;
  const out: string[] = [];
  for (let i = start; i < Math.min(lines.length, start + 60); i++) {
    const line = lines[i] ?? '';
    out.push(line);
    for (const ch of line) {
      if (ch === '(') { depth++; seen = true; } else if (ch === ')') depth--;
    }
    if (seen && depth <= 0) break;
  }
  return out.join('\n');
}

function exempted(lines: string[], i: number): boolean {
  let context = lines[i] ?? '';
  // The whole comment block above, not just the line: the reason for an
  // exemption runs to several sentences, and a rule that forced it onto one
  // line would be a rule that produced worse reasons. The walk stops at the
  // first non-comment line, so a comment attached to something else cannot
  // exempt a call below it.
  for (let j = i - 1; j >= 0; j--) {
    const above = (lines[j] ?? '').trim();
    if (!above.startsWith('//') && !above.startsWith('*') && !above.startsWith('/*')) break;
    context += `\n${above}`;
  }
  return EXEMPT.test(context);
}

test('no call to a model server is written without its endpoint’s connection', () => {
  const offenders: string[] = [];
  for (const file of sources()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A comment is prose about a call, not a call. Several files explain at
      // length why `fetch` cannot take an agent, or which library does what,
      // and flagging those would make the check cry wolf — which is how a
      // check gets deleted rather than fixed.
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (!OUTBOUND.test(line)) return;
      if (exempted(lines, i)) return;
      // The span of the call itself, found by matching brackets rather than
      // guessed as "the next N lines". A fixed window is wrong in both
      // directions here: these request bodies run to thirty lines, so a small
      // window reports calls that are fine, and a large one would accept a
      // transport belonging to the NEXT call down as though it were this
      // one's — which is the false negative that makes a guard worthless.
      if (CARRIES.test(callSpan(lines, i))) return;
      offenders.push(`${path.basename(file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], [
    'a model-server call carries neither its endpoint’s transport nor an exemption.',
    'Written without one it does not fail — it goes direct, with the system',
    'certificate store and no proxy, and succeeds. That is the exact failure the',
    'per-endpoint Tor switch and certificate rule exist to prevent.',
    'Pass `transportFor(...)`, or add `// transport-exempt: <why>`:',
    ...offenders,
  ].join('\n'));
});

// ── Scope ────────────────────────────────────────────────────────────────
//
// A rule that binds a list of files is a rule you leave by writing the call in
// a file that is not on it. That is not hypothetical tidiness: a model call
// added to `routes/` or a worker would carry no endpoint, reach no
// `transportFor`, and pass the rule above by never being looked at.
//
// So the second half of the contract is that there is nothing to look at
// anywhere else. Everything outside the bound set reaches mail, calendars or
// key servers — different destinations on a different axis, with their own
// guard in `util/netguard.ts`. Applying a model endpoint's proxy to those
// would route somebody's mailbox through Tor because a GPU happened to need
// one.
//
// Same shape as cryptostore's "only the provider builds model-server request
// paths", and for the same reason: a second route to a model is a route that
// skips the connection and the capability gate alike.

/**
 * Paths that can only be a model call.
 *
 * Matched as a quoted or interpolated literal rather than anywhere in the
 * text, so prose about `/v1/models` does not trip it — several files explain
 * these endpoints at length and a check that cried wolf would be deleted.
 *
 * The host name is deliberately NOT a signal here, unlike in cryptostore where
 * it is. There, `/api/chat` collides with a route the store serves itself, so
 * "ollama" is the only usable tell; here nothing collides, the paths match
 * directly, and matching the word would flag every admin hint string that
 * mentions Ollama by name — which is most of `routes/ai.ts`.
 */
const MODEL_PATHS = ['/api/chat', '/api/embed', '/api/embeddings', '/api/generate', '/api/tags', '/api/ps', '/api/show', '/api/pull', '/v1/chat/completions', '/v1/embeddings', '/v1/messages', '/v1/models'];

/**
 * Files outside the bound set that may name one anyway.
 *
 * `config.ts` holds the setting's default, `util/outbound.ts` is the transport
 * every one of those calls goes through, and `util/netguard.ts` is the rule
 * about which hosts may be reached. Naming a model path inside the thing that
 * carries or governs it is the opposite of building a second route to one.
 */
const MAY_NAME = new Set(['config.ts', 'outbound.ts', 'netguard.ts']);

test('nothing outside the bound files builds a request to a model server', () => {
  const bound = new Set(sources().map((f) => path.resolve(f)));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // e2e drives the whole app through its own HTTP surface.
        if (entry.name === 'e2e' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.eval.ts')) continue;
      if (bound.has(path.resolve(full)) || MAY_NAME.has(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      const rel = path.relative(root, full);
      for (const p of MODEL_PATHS) {
        if (src.includes(`'${p}'`) || src.includes(`"${p}"`) || src.includes(`\`${p}`)) offenders.push(`${rel} names ${p}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], [
    'a model server is reached from a file the transport rule does not look at.',
    'Add the file to `sources()` so the rule binds it, or route the call through one that is bound:',
    ...offenders,
  ].join('\n'));
});

test('every exemption says why, in words', () => {
  // An exemption with no reason is one nobody can review, and the next person
  // to read it will assume it was load-bearing.
  const thin: string[] = [];
  for (const file of sources()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /\/\/\s*transport-exempt:(.*)$/.exec(line);
      if (!m) return;
      if ((m[1] ?? '').trim().length < 25) thin.push(`${path.basename(file)}:${i + 1}`);
    });
  }
  assert.deepEqual(thin, [], `an exemption has no usable reason on it: ${thin.join(', ')}`);
});
