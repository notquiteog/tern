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

function sources(): string[] {
  return fs.readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.eval.ts'))
    .map((f) => path.join(here, f));
}

/** Anything that opens a socket. `outboundFetch` counts: it can be called bare. */
const OUTBOUND = /(?:^|[^.\w])fetch\(|\boutboundFetch\(/;

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
