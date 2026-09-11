// Who decides whether the model thinks, and how hard.
//
// ── Why this is a file rather than two fields ───────────────────────────────
//
// Reasoning is the one model setting whose right answer differs per person
// rather than per install. It is a straight trade of latency for accuracy —
// measured on the hardest recall cases, thinking on is 15 clean runs of 15
// against 27 of 30 without, and it takes about 75 seconds a draft instead of
// under a second (see `AiSettings.allowThinking`). Somebody triaging fifty
// messages wants the fast answer; somebody composing one difficult reply wants
// the careful one. An install-wide switch cannot express that, and until now
// it was the only switch there was.
//
// ── The three-way resolution ────────────────────────────────────────────────
//
// Three parties have a say, and they compose in one direction:
//
//   1. The **admin** sets the install default — `allowThinking` and
//      `thinkEffort` — which is what everybody gets and what every install had
//      before this file existed.
//   2. The admin also decides, separately, whether anybody else may override
//      it: `userThinking`. Off by default. On a small box the reason is not
//      paternalism, it is arithmetic — reasoning multiplies the time a shared
//      model spends per request, and an admin who has sized a 4.5 GB VPS for
//      four people gets to decide whether any of them may quadruple that.
//   3. The **person** may then choose `off`, `on`, or a level — but only while
//      (2) is on. `default` means "whatever the install says", and is what
//      every account holds until somebody changes it.
//   4. And the admin decides WHERE a choice counts: `userThinkingExcept` lists
//      features that always run at the install's setting whoever they run
//      for — the automatic replies, say, which run unattended on a shared
//      model. (2) is WHO; this is WHERE; they compose as AND.
//
// The gate is re-read on every generation rather than only when a preference
// is saved, and that is the load-bearing part. An admin who turns `userThinking`
// back off must have everybody snap back to the install default immediately,
// including people who set a preference while it was on. Checking only at save
// time would leave those preferences quietly in force for ever, which is the
// opposite of what turning the switch off means.
//
// ── Where it is applied ─────────────────────────────────────────────────────
//
// Once, at the two entry points in `ai/llm.ts` — `chatStream` and
// `agentStream` — which resolve the settings before the provider branches see
// them. The six provider functions below those read `s.allowThinking` and
// `s.thinkEffort` exactly as they always did and needed no changes at all.
//
// That is deliberate and is the whole reason this shape was chosen. There are
// a dozen read sites across three wire formats and two entry points; applying
// a preference at each of them would be twelve chances to miss one, and a
// missed one is invisible — the generation succeeds, it just ignores what the
// person asked for. Resolving into the settings object means a provider
// function cannot fail to honour it, and a seventh provider added later
// inherits the behaviour without knowing this file exists.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { CAPABILITIES, CAPABILITY_META, type Capability } from '../services/capabilities.js';
import type { AiSettings } from './llm.js';
import { isEffort, type ThinkEffort } from './reasoning.js';

const log = logger('thinking');

/** What a person may choose. `default` defers to the install. */
export type ThinkingChoice = 'default' | 'off' | 'on';
export type EffortChoice = 'default' | ThinkEffort;

export interface ThinkingPrefs { thinking: ThinkingChoice; effort: EffortChoice }

export const THINKING_DEFAULTS: ThinkingPrefs = { thinking: 'default', effort: 'default' };

function readPrefs(raw: unknown): ThinkingPrefs {
  const v = (raw ?? {}) as Record<string, unknown>;
  const thinking = v.thinking === 'off' || v.thinking === 'on' ? v.thinking : 'default';
  const effort = isEffort(v.effort) ? v.effort : 'default';
  return { thinking, effort };
}

// A generation asks for this every time, and a page of summaries is a dozen
// generations, so it is worth not going to the database for each. Short enough
// that a preference change is felt almost at once, and cleared outright when
// one is saved so the person who changed it sees it immediately.
interface Cached { at: number; prefs: ThinkingPrefs; admin: boolean }
const cache = new Map<number, Cached>();
const TTL_MS = 15_000;

export function forgetThinkingPrefs(userId?: number): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

async function load(userId: number): Promise<Cached> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const row = await one<{ prefs: Record<string, unknown> | null; role: string }>(
    'SELECT prefs, role FROM users WHERE id=$1',
    [userId],
  );
  const value: Cached = {
    at: Date.now(),
    prefs: readPrefs(row?.prefs?.ai),
    admin: row?.role === 'admin',
  };
  cache.set(userId, value);
  return value;
}

export async function getThinkingPrefs(userId: number): Promise<ThinkingPrefs> {
  return (await load(userId)).prefs;
}

/**
 * Whether this person's own choice counts.
 *
 * An admin always counts, and not as a privilege: they can change the install
 * default from the next page along, so refusing them a personal preference
 * would only push them into changing it for everybody to change it for
 * themselves — which is strictly worse for everybody else.
 */
export async function mayChooseThinking(userId: number, s: Pick<AiSettings, 'userThinking'>): Promise<boolean> {
  if (s.userThinking) return true;
  return (await load(userId)).admin;
}

export async function saveThinkingPrefs(userId: number, patch: Partial<ThinkingPrefs>): Promise<ThinkingPrefs> {
  const current = await getThinkingPrefs(userId);
  const next: ThinkingPrefs = {
    thinking: patch.thinking ?? current.thinking,
    effort: patch.effort ?? current.effort,
  };
  await query(
    `UPDATE users SET prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{ai}', $2::jsonb, true) WHERE id=$1`,
    [userId, JSON.stringify(next)],
  );
  forgetThinkingPrefs(userId);
  return next;
}

/**
 * The settings this generation should actually run under.
 *
 * Returns the install's own settings unchanged whenever nothing overrides
 * them, so an install that never turns `userThinking` on behaves exactly as it
 * did before this existed — same object, same values, no new failure modes.
 *
 * A database that will not answer is not allowed to stop a generation: the
 * install default is a correct answer, just not a personalised one, and losing
 * somebody's drafting because a preference lookup failed would be a poor trade.
 */
/**
 * The resolution itself, with the database taken out of it.
 *
 * Split from `effectiveSettings` so the rule can be tested exhaustively
 * without a users table — this is the function that decides whether somebody's
 * reasoning setting is honoured, and "we think it composes correctly" is not
 * the standard that deserves.
 *
 * `allowed` folds together the two ways a choice can count: the admin has
 * enabled personal settings, or the person is an admin themselves.
 */
export function resolveThinking(s: AiSettings, prefs: ThinkingPrefs, allowed: boolean): AiSettings {
  // Returned unchanged, as the same object, whenever nothing overrides. An
  // install that never turns this on gets byte-identical behaviour to the one
  // it had before this file existed, which is the property that makes the
  // feature safe to add to the hot path of every generation.
  if (!allowed) return s;
  if (prefs.thinking === 'default' && prefs.effort === 'default') return s;
  return {
    ...s,
    allowThinking: prefs.thinking === 'default' ? s.allowThinking : prefs.thinking === 'on',
    thinkEffort: prefs.effort === 'default' ? s.thinkEffort : prefs.effort,
  };
}

/**
 * The features that write with the language model, and so have a reasoning
 * setting to honour — the list an admin picks exceptions from.
 *
 * Derived rather than listed. It was a list, and the first version named
 * triage, the impersonation guard, calendar and attachment search — all of
 * which `CAPABILITY_META` records as never reaching a model, so each would
 * have been a checkbox that did nothing. `usesAi` is where that fact already
 * lives. Of the features that do use a model, three do not WRITE with it —
 * meaning search embeds, pictures draw, dictation transcribes — and a
 * reasoning switch beside those would be the same empty control.
 */
const NOT_WRITING: readonly Capability[] = ['semantic', 'ai.media', 'voice'];
export const THINKING_SURFACES: readonly Capability[] = CAPABILITIES
  .filter((c) => CAPABILITY_META[c].usesAi && !NOT_WRITING.includes(c));

/** The same, with the names people see. */
export function thinkingSurfaces(): { id: Capability; label: string }[] {
  return THINKING_SURFACES.map((id) => ({ id, label: CAPABILITY_META[id].label }));
}

/**
 * Whether a personal choice may apply to this feature at all — the WHERE half
 * of the gate, beside `mayChooseThinking`'s WHO. A caller that names no
 * feature is treated as everywhere, which is what every install had before
 * this existed.
 */
export function appliesHere(s: Pick<AiSettings, 'userThinkingExcept'>, capability?: Capability): boolean {
  return !capability || !(s.userThinkingExcept ?? []).includes(capability);
}

export async function effectiveSettings(s: AiSettings, userId: number, capability?: Capability): Promise<AiSettings> {
  try {
    const { prefs, admin } = await load(userId);
    return resolveThinking(s, prefs, (s.userThinking || admin) && appliesHere(s, capability));
  } catch (err) {
    // A preference lookup that fails must not cost somebody their draft. The
    // install default is a correct answer, just not a personalised one.
    log.warn('could not read a thinking preference; using the install default', { user: userId, err: (err as Error).message });
    return s;
  }
}

/**
 * What the person is currently getting, and why — for the settings screen.
 *
 * The "why" matters more than it looks. Somebody who set thinking to `on` and
 * is not getting it needs to be told that an admin has since turned personal
 * choices off, rather than being shown their own setting sitting there
 * apparently in force.
 */
export interface ThinkingView {
  prefs: ThinkingPrefs;
  /** Whether this person's choice is being honoured at all. */
  allowed: boolean;
  /** What the install would give them on its own. */
  installDefault: { thinking: boolean; effort: ThinkEffort };
  /** What they are actually getting, once everything is resolved. */
  effective: { thinking: boolean; effort: ThinkEffort };
  /**
   * Features where the install's setting applies whatever they choose, named
   * — so the card can say so rather than showing a choice that is quietly not
   * in force there.
   */
  except: { id: Capability; label: string }[];
}

export async function thinkingView(s: AiSettings, userId: number): Promise<ThinkingView> {
  const prefs = await getThinkingPrefs(userId);
  const allowed = await mayChooseThinking(userId, s);
  const resolved = resolveThinking(s, prefs, allowed);
  return {
    prefs,
    allowed,
    installDefault: { thinking: s.allowThinking, effort: s.thinkEffort },
    effective: { thinking: resolved.allowThinking, effort: resolved.thinkEffort },
    except: (s.userThinkingExcept ?? []).map((id) => ({ id, label: CAPABILITY_META[id]?.label ?? id })),
  };
}
