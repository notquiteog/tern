// Sharing one loaded model between everyone who is signed in.
//
// Ollama serves `OLLAMA_NUM_PARALLEL` requests per model at a time and queues
// whatever else arrives (512 deep by default), so with one slot the second
// person to ask for a draft waits for the first person's whole generation
// with nothing to look at. The number of slots is Ollama's to decide — it is
// fixed when the container starts, because every slot costs a context window
// of KV cache — so this file does the part the app can do:
//
//   - never hand Ollama more work at once than it has slots for, so requests
//     queue here, where we know who is waiting, rather than there, where we
//     do not;
//   - keep a slot back for a person who is waiting at a composer, so a
//     campaign run or a page of inbox summaries cannot take all of them;
//   - hold one interactive generation per person, so nobody's rapid clicking
//     starves everyone else.
//
// `slotAdvice` works out how many slots an install actually wants — one per
// registered user — and how many its memory can pay for; Admin → AI model
// shows both, and `./bin/tern ai-slots` applies the answer.
import { config } from '../config.js';

export type SlotKind = 'interactive' | 'background';

export interface SlotPlan {
  enabled: boolean;
  // Generations that may run at once. One when concurrency is off.
  slots: number;
  // Of those, how many may be background work (summaries, campaigns).
  background: number;
  // Interactive generations one person may hold at once.
  perUser: number;
}

export function slotPlan(enabled: boolean, configured: number = config.ollamaNumParallel): SlotPlan {
  const slots = enabled ? Math.max(1, Math.floor(configured) || 1) : 1;
  // With a single slot there is nothing to reserve: background work may have
  // it, and an interactive request waits for it like anything else.
  return { enabled, slots, background: Math.max(1, slots - 1), perUser: 1 };
}

// Past this many people waiting, a new request is told the assistant is busy
// instead of joining a queue it would sit in for minutes. Ollama's own queue
// defaults to 512, which is why a loaded install looks like a hung spinner
// rather than an error.
export const MAX_WAITING = 32;
// A generation on a CPU-only box can genuinely take minutes, so the wait is
// long; it exists to end a wait that is never going to be served, not to cut
// a queue short.
export const MAX_WAIT_MS = 5 * 60_000;

interface Held { kind: SlotKind; owner: string }
interface Waiter { held: Held; start: () => void; fail: (e: Error) => void; cleanup: () => void }

const running: Held[] = [];
const waiting: Waiter[] = [];

export function slotStats(): { running: number; waiting: number; interactive: number; background: number } {
  return {
    running: running.length,
    waiting: waiting.length,
    interactive: running.filter((r) => r.kind === 'interactive').length,
    background: running.filter((r) => r.kind === 'background').length,
  };
}

export function busyMessage(): string {
  return 'The assistant is busy answering other people right now. Try again in a moment.';
}

function admits(plan: SlotPlan, w: Held): boolean {
  if (running.length >= plan.slots) return false;
  if (w.kind === 'background') return running.filter((r) => r.kind === 'background').length < plan.background;
  return running.filter((r) => r.kind === 'interactive' && r.owner === w.owner).length < plan.perUser;
}

// Starts everyone who can start, in the order they arrived. A waiter that
// cannot go yet — its owner already has a generation running — is stepped
// over rather than blocking the queue behind it.
function pump(plan: SlotPlan): void {
  for (let i = 0; i < waiting.length && running.length < plan.slots; i++) {
    const w = waiting[i];
    if (!admits(plan, w.held)) continue;
    waiting.splice(i, 1);
    i--;
    // The slot is taken here, synchronously: `start` only wakes the waiter up
    // on the next tick, and a slot that is not held until then is a slot this
    // loop would hand out twice.
    running.push(w.held);
    w.cleanup();
    w.start();
  }
}

// Returns the release function. Always call it, in a `finally`: a slot that
// is never given back is one fewer for everyone, for the life of the process.
export async function acquireSlot(plan: SlotPlan, kind: SlotKind, owner: string, signal?: AbortSignal): Promise<() => void> {
  const held: Held = { kind, owner: owner || 'system' };
  if (signal?.aborted) throw new Error('Cancelled');
  if (!admits(plan, held)) {
    if (waiting.length >= MAX_WAITING) throw new Error(busyMessage());
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => { drop(); reject(new Error('Cancelled')); };
      const drop = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const i = waiting.findIndex((x) => x === waiter);
        if (i >= 0) waiting.splice(i, 1);
      };
      const waiter: Waiter = {
        held,
        start: resolve,
        fail: reject,
        // Called when the waiter is promoted: it is out of the queue already,
        // so only the listeners have to go.
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
      };
      timer = setTimeout(() => { drop(); reject(new Error(busyMessage())); }, MAX_WAIT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(waiter);
    });
  } else {
    running.push(held);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = running.indexOf(held);
    if (i >= 0) running.splice(i, 1);
    pump(plan);
  };
}

// Used by the tests, and by nothing else: the gate is process-wide state.
export function resetSlots(): void {
  running.length = 0;
  for (const w of waiting.splice(0)) { w.cleanup(); w.fail(new Error('Cancelled')); }
}

// ---------- How many slots this install wants ----------

// Bytes one token of KV cache costs, from the numbers Ollama reports in
// /api/show. Returns null when the model does not describe itself well enough
// to say, which is a fine answer: the advice below then talks about slots and
// users and leaves memory out of it rather than inventing a figure.
export function kvBytesPerToken(info: Record<string, unknown> | undefined, cacheType: string): number | null {
  if (!info) return null;
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : '';
  const num = (suffix: string): number | null => {
    let loose: number | null = null;
    for (const [k, v] of Object.entries(info)) {
      if (!k.endsWith(suffix)) continue;
      // A multimodal model describes its vision or audio tower in the same
      // map, with the same key endings. Those towers do not hold a KV cache
      // per slot, and reading one instead of the language model's own
      // numbers is how an estimate goes quietly wrong.
      if (/\.(vision|mm|audio|projector)\./.test(k)) continue;
      // Some architectures report one value per block; they are equal in
      // every model Ollama ships, and the largest is the safe read anyway.
      const n = Array.isArray(v) ? Math.max(...v.map(Number)) : Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (arch && k.startsWith(`${arch}.`)) return n;
      loose ??= n;
    }
    return loose;
  };
  const blocks = num('.block_count');
  // Not filled in with the head count when it is missing. Every recent model
  // shares its keys and values between several heads, so assuming otherwise
  // would price a slot at eight times what it costs; a model that does not
  // say gets no estimate at all, and Admin → AI model then talks about
  // people and slots without pretending to know the memory.
  const kvHeads = num('.attention.head_count_kv');
  if (!blocks || !kvHeads) return null;
  let keyLen = num('.attention.key_length');
  let valLen = num('.attention.value_length');
  if (!keyLen || !valLen) {
    const embed = num('.embedding_length');
    const heads = num('.attention.head_count');
    if (!embed || !heads) return null;
    keyLen = keyLen ?? embed / heads;
    valLen = valLen ?? embed / heads;
  }
  return Math.round(blocks * kvHeads * (keyLen + valLen) * bytesPerCacheElement(cacheType));
}

// f16 is two bytes; the quantised caches carry their scales, so q8_0 is 8.5
// bits per element and q4_0 is 4.5.
export function bytesPerCacheElement(cacheType: string): number {
  switch ((cacheType || 'f16').toLowerCase()) {
    case 'q8_0': return 8.5 / 8;
    case 'q4_0': return 4.5 / 8;
    default: return 2;
  }
}

export interface SlotAdvice {
  // People who could ask for a draft at the same time.
  users: number;
  // What Ollama was started with.
  configured: number;
  // One slot each.
  needed: number;
  // What the memory limit can pay for, or null when we cannot tell.
  affordable: number | null;
  // What to set OLLAMA_NUM_PARALLEL to: everyone served, within the memory.
  recommended: number;
  // Memory one slot costs, or null when the model did not say.
  perSlotBytes: number | null;
  // Whether everyone already has a slot of their own.
  enough: boolean;
  // Whether memory is what stops everyone having one.
  memoryBound: boolean;
}

export function slotAdvice(input: { users: number; configured: number; numCtx: number; kvPerToken: number | null; modelBytes: number; memBudgetBytes: number }): SlotAdvice {
  const users = Math.max(1, Math.floor(input.users) || 1);
  const configured = Math.max(1, Math.floor(input.configured) || 1);
  const perSlotBytes = input.kvPerToken ? Math.round(input.kvPerToken * Math.max(1, input.numCtx)) : null;
  let affordable: number | null = null;
  if (perSlotBytes && input.memBudgetBytes > 0 && input.modelBytes > 0) {
    // What is left after the weights and a little room for the runner itself.
    const spare = input.memBudgetBytes - input.modelBytes - 256 * 1024 * 1024;
    affordable = Math.max(1, Math.floor(spare / perSlotBytes));
  }
  const recommended = affordable === null ? users : Math.max(1, Math.min(users, affordable));
  return {
    users,
    configured,
    needed: users,
    affordable,
    recommended,
    perSlotBytes,
    enough: configured >= users,
    memoryBound: affordable !== null && affordable < users,
  };
}
