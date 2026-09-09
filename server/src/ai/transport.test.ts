// Every call to a model server carries that endpoint's connection.
//
// ── Why this checks the source rather than a response ─────────────────────
//
// Because the failure is a line of code, not a behaviour. A request written
// with plain `fetch`, or with `outboundFetch` and no transport, does not fail
// — it SUCCEEDS, and it succeeds by going direct, with the system certificate
// store and no proxy. The admin turned Tor on for that endpoint, the page
// shows it on, the draft comes back, and the model host learned this server's
// address anyway. No assertion about the response catches that, because the
// response is fine.
//
// It has happened here once already, and `ai/endpoint.ts` records it: the
// version of `transportFor` that returned only the certificate half shipped
// with one of fifteen call sites having forgotten it, so `openaiStream` went
// out bare — the connection test passed while every draft failed. Returning
// one value that carries everything fixed the HALF application. Nothing
// stopped the whole thing being omitted, and this does.
//
// ── Why the syntax tree and not a text scan ───────────────────────────────
//
// A text scan was tried first and had to guess where a call ended, which is
// wrong in both directions: these request bodies run to thirty lines, so a
// small window reports calls that are fine, and the large window that fixes
// that accepts the NEXT call's transport as this one's — the false negative
// that makes a guard worthless. Bracket matching fixed the span and left the
// other half of the problem, since a widened pattern then matched library
// names inside the comments explaining them.
//
// Walking the tree settles both at once. A call's arguments are exactly known,
// so nothing nearby can be mistaken for them; and a call named in a comment or
// quoted in a string is not a CallExpression, so no exclusion list is needed.
//
// ── A guard must not pass by finding nothing ──────────────────────────────
//
// Two ways that happens, and the second survives fixing the first. The scan
// can look in the wrong place — the sibling copy of this guard passed for a
// while scanning a compiled output directory containing no sources at all. And
// the match set can stop matching, after which the walk returns an empty list
// and every check below reports clean on it, in exactly the same silent
// direction.
//
// So this asserts three things about ITSELF first: that it found the sources,
// that it found a plausible number of calls, and that it found the ones that
// are certainly there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import ts from 'typescript';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** The source tree, found rather than assumed. */
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
 * Callees that open a socket.
 *
 * `outboundFetch` is here because it can be called bare — it takes the
 * transport as an optional third argument, so forgetting it compiles. The
 * libraries are here because a guard you can step around by changing library
 * is not a guard, and Tern having no HTTP dependency today is exactly why the
 * pattern should already know about one: the moment somebody adds it is the
 * moment they will not think to widen this.
 */
function isOutbound(callee: string): boolean {
  return /(?:^|\.)fetch$/.test(callee)
    || /(?:^|\.)outboundFetch$/.test(callee)
    || /(?:^|\.)request$/.test(callee)
    || /^(axios|undici|got)(\.|$)/.test(callee);
}

/** What makes a call carry its endpoint's certificate rule and proxy. */
const CARRIES = /transportFor\(|endpointTransport\(|\btrust\b|TlsTrust/;

const EXEMPT = /transport-exempt:/;

interface Call {
  file: string;
  line: number;
  callee: string;
  /** The arguments, and only the arguments. */
  args: string;
  leading: string;
}

function callsIn(file: string): Call[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Call[] = [];

  const leadingOf = (node: ts.Node): string => {
    let n: ts.Node = node;
    while (n.parent && !ts.isSourceFile(n.parent) && !ts.isBlock(n.parent)) n = n.parent;
    const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
    return ranges.map((r) => text.slice(r.pos, r.end)).join('\n');
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (isOutbound(callee)) {
        found.push({
          file: path.relative(root, file),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          callee,
          args: node.arguments.map((a) => a.getText(sf)).join(', '),
          leading: leadingOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every file that reaches a model server, and therefore every file the rule
 * binds.
 *
 * `ai/` is most of it, but not all, and assuming otherwise was the first
 * version's mistake: `services/voice.ts` is where the TRANSCRIPTION endpoint
 * lives — a model server like any other, with its own address, key,
 * certificate rule and Tor switch — and it sat entirely outside a rule written
 * as "the ai directory". It happens to do everything right on all nine of its
 * calls. Nothing was checking that it did.
 */
function sources(): string[] {
  const ai = path.join(root, 'ai');
  const inAi = fs.readdirSync(ai)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.eval.ts'))
    .map((f) => path.join(ai, f));
  const found = [...inAi, path.join(root, 'services', 'voice.ts')];
  // The floor lives here rather than beside here. It used to be a test of its
  // own that every other check leaned on — and a watcher is something a later
  // edit can delete or weaken without the checks it was protecting saying
  // anything: they would go straight back to reporting clean on an empty list.
  // Inside the helper the property is structural, and no arrangement of the
  // tests gets a caller an unchecked empty list. Far under the real figure of
  // 17, so ordinary edits never approach it.
  assert.ok(found.length >= 10, `only ${found.length} bound sources under ${root} — the scan is looking in the wrong place, and every check that reads this would report clean on it`);
  for (const f of found) assert.ok(fs.existsSync(f), `${f} is on the bound list and does not exist`);
  return found;
}

/**
 * Every outbound call in the bound files, with the same floor for the same
 * reason.
 *
 * A correct scan root does not save a dead match set: if `isOutbound` stops
 * matching, this returns an empty list and every filter over it is empty too —
 * which is exactly what "no problems" looks like. Naming two files that
 * certainly contain a call catches the case where the walk is finding the
 * wrong kind of node rather than none at all.
 */
function everyCall(): Call[] {
  const calls = sources().flatMap(callsIn);
  assert.ok(calls.length >= 20, `only ${calls.length} outbound calls found — the match set has stopped matching, and every check that reads this would report clean on it`);
  const seen = new Set(calls.map((c) => path.basename(c.file)));
  for (const expected of ['llm.ts', 'voice.ts']) {
    assert.ok(seen.has(expected), `no outbound call found in ${expected}, which certainly has one — the walk is finding the wrong kind of node`);
  }
  return calls;
}

test('the scan can actually see the code it is checking', () => {
  // The floors themselves live in `sources` and `everyCall`, so every check in
  // this file inherits them and none can be left reading an empty list. This
  // states the property out loud and fails first when it breaks — it is the
  // sentence a reader needs, not the mechanism.
  assert.ok(everyCall().length > 0);
});

test('no call to a model server is written without its endpoint’s connection', () => {
  const offenders = everyCall()
    .filter((c) => !EXEMPT.test(c.leading))
    // The transport in the call's OWN arguments. Not a window of nearby lines:
    // a `transportFor` belonging to the next call down is not this one's.
    .filter((c) => !CARRIES.test(c.args))
    .map((c) => `${c.file}:${c.line}  ${c.callee}(…)`);

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
// a file that is not on it. Not hypothetical tidiness: a model call added to
// `routes/` or a worker would carry no endpoint, reach no `transportFor`, and
// pass the rule above by never being looked at.
//
// So the other half of the contract is that there is nothing to look at
// anywhere else. Everything outside the bound set reaches mail, calendars or
// key servers — different destinations on a different axis, with their own
// guard in `util/netguard.ts`. Applying a model endpoint's proxy to those
// would route somebody's mailbox through Tor because a GPU happened to need
// one.

/**
 * Paths that can only be a model call.
 *
 * The host name is deliberately NOT a signal here, unlike in cryptostore where
 * it is the only usable one — there `/api/chat` collides with a route the
 * store serves itself. Here nothing collides, the paths match directly, and
 * matching the word "ollama" would flag every admin hint string that mentions
 * it by name, which is most of `routes/ai.ts`.
 */
const MODEL_PATHS = ['/api/chat', '/api/embed', '/api/embeddings', '/api/generate', '/api/tags', '/api/ps', '/api/show', '/api/pull', '/v1/chat/completions', '/v1/embeddings', '/v1/messages', '/v1/models'];

/**
 * Files outside the bound set that may name one anyway.
 *
 * `config.ts` holds the setting's default, `util/outbound.ts` is the transport
 * every one of those calls goes through, and `util/netguard.ts` is the rule
 * about which hosts may be reached at all. Naming a model path inside the
 * thing that carries or governs it is the opposite of building a second route.
 */
const MAY_NAME = new Set(['config.ts', 'outbound.ts', 'netguard.ts']);

test('nothing outside the bound files builds a request to a model server', () => {
  const bound = new Set(sources().map((f) => path.resolve(f)));
  const offenders: string[] = [];
  let scanned = 0;
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
      scanned++;
      const src = fs.readFileSync(full, 'utf8');
      const rel = path.relative(root, full);
      for (const p of MODEL_PATHS) {
        // Quoted or interpolated, so prose about `/v1/models` does not trip
        // it — several files explain these endpoints at length, and a check
        // that cries wolf is one that gets deleted rather than fixed.
        if (src.includes(`'${p}'`) || src.includes(`"${p}"`) || src.includes(`\`${p}`)) offenders.push(`${rel} names ${p}`);
      }
    }
  };
  walk(root);
  // The same vacuity guard: this walk covering nothing would also report clean.
  assert.ok(scanned >= 20, `only ${scanned} unbound files scanned — the walk is looking in the wrong place`);
  assert.deepEqual(offenders, [], [
    'a model server is reached from a file the transport rule does not look at.',
    'Add it to `sources()` so the rule binds it, or route the call through a file that is bound:',
    ...offenders,
  ].join('\n'));
});

test('every exemption says why, in words', () => {
  // An exemption with no reason is one nobody can review, and the next person
  // to read it will assume it was load-bearing.
  const exempted = everyCall().filter((c) => EXEMPT.test(c.leading));
  // The positive control, and it is not decoration. Without it this passes
  // when `EXEMPT` stops matching, when `leading` stops finding the comment
  // block, and when nothing was scanned at all — in every one of those cases
  // the list below is empty, and an empty list is what "clean" looks like. Any
  // assertion whose expected result is absence is indistinguishable from not
  // running unless something in the same test proves it ran.
  assert.ok(exempted.length >= 1, 'no exemptions found at all — the exemption scan has stopped working, and this check would report clean on that');

  const thin = exempted
    .filter((c) => (/transport-exempt:([\s\S]*)/.exec(c.leading)?.[1] ?? '').replace(/\/\/|\s+/g, ' ').trim().length < 40)
    .map((c) => `${c.file}:${c.line}`);
  assert.deepEqual(thin, [], `an exemption has no usable reason on it: ${thin.join(', ')}`);
});

test('prose and strings are not calls, and real calls beside them still are', () => {
  // The false-positive class the text scan had, asserted rather than assumed.
  //
  // The decoys and the real calls share one fixture ON PURPOSE, and the
  // assertion names exactly which lines come back. Testing the decoys alone
  // would be an assertion that a list is empty — which is also what happens if
  // the file was never written, or if the walk stopped recognising calls
  // entirely. Absence cannot tell those apart from success. Together neither
  // half can pass by absence: if the scan never read the file the real calls
  // are missing, and if a decoy trips there is an extra one.
  //
  // The second decoy matters most here: it is a template literal containing a
  // correctly written call, so a scan that read strings would see a PASSING
  // call and stay quiet about it — a false negative rather than a false
  // positive, which is the worse direction.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-guard-'));
  const file = path.join(dir, 'sample.ts');
  try {
    fs.writeFileSync(file, [
      '// `fetch` cannot take an agent, so outboundFetch(url, init) exists.',        // 1
      'const doc = `call outboundFetch(u, i, transportFor(s)) to reach it`;',        // 2
      "const name = 'fetch(';",                                                       // 3
      'export async function real(u: string) { return fetch(u); }',                  // 4
      'export async function realToo(u: string) { return outboundFetch(u, {}); }',   // 5
    ].join('\n'));
    assert.deepEqual(
      callsIn(file).map((c) => `${c.line}:${c.callee}`),
      ['4:fetch', '5:outboundFetch'],
      'the decoys on lines 1-3 must not be read as calls, and the real ones on 4-5 must be',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
