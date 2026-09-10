// Who gets to decide whether the model thinks.
//
// Two halves. The resolution rule is checked exhaustively as a pure function;
// the WIRING is checked by reading the source, because the property that
// matters most here — that every generation honours the setting — lives in
// where the function is called rather than in what it returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { resolveThinking, THINKING_DEFAULTS, type ThinkingPrefs } from './thinking.js';
import { aiDefaults, type AiSettings } from './llm.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
function read(rel: string): string {
  const text = fs.readFileSync(path.join(here, rel), 'utf8');
  assert.ok(text.length > 200, `${rel} is too short to have been read properly`);
  return text;
}

const install = (patch: Partial<AiSettings> = {}): AiSettings =>
  ({ ...aiDefaults(), allowThinking: false, thinkEffort: 'low', userThinking: false, ...patch });
const prefs = (p: Partial<ThinkingPrefs> = {}): ThinkingPrefs => ({ ...THINKING_DEFAULTS, ...p });

// ---------- The rule ----------

test('an install that never turns this on is untouched by it', () => {
  // The same object, not merely an equal one. This runs on the hot path of
  // every generation, and "returns the settings unchanged" is what makes it
  // safe to have put it there.
  const s = install({ allowThinking: true, thinkEffort: 'high' });
  assert.equal(resolveThinking(s, prefs(), false), s);
  assert.equal(resolveThinking(s, prefs({ thinking: 'on' }), false), s);
  assert.equal(resolveThinking(s, prefs(), true), s);
});

test('a person may turn reasoning on when the install leaves it off', () => {
  const s = install({ allowThinking: false });
  assert.equal(resolveThinking(s, prefs({ thinking: 'on' }), true).allowThinking, true);
});

test('a person may turn reasoning off when the install has it on', () => {
  // The direction that matters most on a small box: somebody working through
  // fifty messages should be able to stop paying seventy seconds a draft
  // without an admin changing it for everybody.
  const s = install({ allowThinking: true });
  assert.equal(resolveThinking(s, prefs({ thinking: 'off' }), true).allowThinking, false);
});

test('"default" means the install decides, in both directions', () => {
  assert.equal(resolveThinking(install({ allowThinking: true }), prefs({ thinking: 'default' }), true).allowThinking, true);
  assert.equal(resolveThinking(install({ allowThinking: false }), prefs({ thinking: 'default' }), true).allowThinking, false);
  assert.equal(resolveThinking(install({ thinkEffort: 'high' }), prefs({ effort: 'default' }), true).thinkEffort, 'high');
});

test('the level can be chosen without touching whether it thinks at all', () => {
  const out = resolveThinking(install({ allowThinking: true, thinkEffort: 'low' }), prefs({ effort: 'high' }), true);
  assert.equal(out.thinkEffort, 'high');
  assert.equal(out.allowThinking, true, 'choosing a level should not change whether reasoning is on');
});

test('a stored preference stops applying the moment the admin withdraws the right', () => {
  // The reason the gate is re-read on every generation rather than only when a
  // preference is saved. An admin turning personal settings back off has to
  // mean everybody snaps to the install default at once — including people who
  // set a preference while it was allowed. A save-time-only check would leave
  // those in force for ever, which is the opposite of what the switch means.
  const s = install({ allowThinking: false });
  const chosen = prefs({ thinking: 'on', effort: 'high' });
  assert.equal(resolveThinking(s, chosen, true).allowThinking, true);
  assert.equal(resolveThinking(s, chosen, false).allowThinking, false);
  assert.equal(resolveThinking(s, chosen, false).thinkEffort, 'low');
});

test('nothing else about the settings is disturbed', () => {
  const s = install({ allowThinking: false, thinkingBudget: 4321, temperature: 0.42, model: 'x' });
  const out = resolveThinking(s, prefs({ thinking: 'on', effort: 'medium' }), true);
  assert.equal(out.thinkingBudget, 4321, 'the budget is an admin tuning knob, not a personal one');
  assert.equal(out.temperature, 0.42);
  assert.equal(out.model, 'x');
});

// ---------- The wiring ----------

test('every path to a model resolves the person’s setting first', () => {
  // This is the check the feature actually rests on.
  //
  // There are a dozen sites in llm.ts that read `allowThinking` or
  // `thinkEffort`, across six provider functions and three wire formats.
  // Applying a preference at each would be a dozen chances to miss one, and a
  // miss is invisible: the generation succeeds, it simply ignores what the
  // person asked for. So it is resolved ONCE at each entry point, into the
  // settings object the providers already read.
  //
  // Which makes the entry points the thing to guard. A third one added later
  // that calls `getAiSettings()` raw would silently opt every one of its
  // callers out of the feature.
  const llm = read('llm.ts');
  for (const entry of ['chatStream', 'agentStream']) {
    // Sliced rather than matched with a constructed regex: the body of an
    // async generator is not something a regex should be asked to delimit, and
    // the next `\nexport ` is an unambiguous end.
    const at = llm.indexOf(`function* ${entry}(`);
    assert.ok(at > 0, `${entry} is gone`);
    const rest = llm.slice(at);
    const end = rest.indexOf('\nexport ');
    const body = end > 0 ? rest.slice(0, end) : rest;
    assert.match(body, /effectiveSettings\(/,
      `${entry} does not resolve the person's reasoning setting, so every generation through it ignores it`);
  }

  // The invariant that catches a THIRD entry point added later.
  //
  // Counting raw `getAiSettings()` calls does not work — a dozen of them are
  // model management, health checks and the embedder, none of which reason.
  // What every generation path does have is a consent check on `opts.consent`,
  // because `capabilities.test.ts` requires one. So the two counts must match:
  // every place that checks somebody's consent to generate is a place that
  // must also resolve their reasoning setting.
  //
  // `embed()` is deliberately not counted. It asserts on a bare `consent`
  // rather than `opts.consent`, and an embedding model does not reason.
  const gates = [...llm.matchAll(/assertCapability\(opts\.consent\.userId/g)].length;
  const resolves = [...llm.matchAll(/effectiveSettings\(await getAiSettings\(\)/g)].length;
  assert.equal(gates, 2, `expected two generation entry points, found ${gates}`);
  assert.equal(resolves, gates,
    `${gates} paths generate on somebody's behalf but only ${resolves} resolve their reasoning setting`);
});

test('the admin gate is enforced where it is saved, not only where it is shown', () => {
  // Hiding the control in the browser is presentation. Refusing the write is
  // the rule — otherwise a preference set before an admin turned the feature
  // off would sit in the database doing nothing and saying nothing.
  const routes = fs.readFileSync(path.join(here, '..', 'routes', 'ai.ts'), 'utf8');
  const put = /aiRouter\.put\('\/thinking'[\s\S]*?\n}\);/.exec(routes);
  assert.ok(put, 'the thinking route is gone');
  assert.match(put[0], /mayChooseThinking\(/,
    'PUT /thinking saves without checking whether this person is allowed to choose');
});
