// What happens to a piece of mail after the model has finished with it.
//
// Every generation is a session: it starts when a prompt is built, and it is
// over the moment the last token arrives. Three things happen at the end,
// and they happen in a `finally` so an abort or a crash gets the same
// treatment as a success.
//
//   1. The prompt is dropped. `ChatOptions.messages` is emptied and each
//      message's content replaced, so nothing downstream — a closure, a
//      retry, an error object on its way to a log — is still holding the
//      text of somebody's email. JavaScript cannot zero a string in place,
//      and this file does not pretend otherwise: what it guarantees is that
//      no live reference remains, which is what makes the string collectable
//      instead of resident for the life of the process.
//
//   2. Nothing is written down. Prompts and completions are never logged,
//      never stored on the job row (services/aiJobs wipes the payload as the
//      job leaves 'running'), and never attached to an error. The only
//      things that survive a session are counters.
//
//   3. The model's own memory is cleared. Ollama holds the prompt in its KV
//      cache for as long as the model stays resident, which by default is
//      ten minutes after the last request — ten minutes in which the text of
//      a message sits in the RAM of a process that has no further use for
//      it. When the install has "wipe after use" on, an idle timer unloads
//      the model once nothing is generating, so the cache goes with it. The
//      grace period exists so that a person working through their inbox is
//      not paying a model load per message.
import { logger } from '../log.js';

const log = logger('ai-session');

export interface WipePolicy {
  /** Unload the model, and with it the KV cache holding the prompt, once idle. */
  wipeAfterUse: boolean;
  /** How long to wait for the next generation before doing it. */
  wipeIdleSeconds: number;
}

interface Session { id: number; startedAt: number }

let nextId = 1;
const active = new Map<number, Session>();
let idleTimer: NodeJS.Timeout | null = null;
let unload: (() => Promise<void>) | null = null;

// Set once at startup. Kept as a hook rather than an import so this file
// stays free of the HTTP client and can be tested on its own.
export function onWipe(fn: () => Promise<void>): void { unload = fn; }

export function activeSessions(): number { return active.size; }

export function beginSession(): Session {
  const s = { id: nextId++, startedAt: Date.now() };
  active.set(s.id, s);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  return s;
}

// Called in a `finally`. `messages` is emptied in place because the caller
// usually built it inline and the array is the last thing holding it.
export function endSession(s: Session, messages?: { role: string; content: string }[], policy?: WipePolicy): void {
  active.delete(s.id);
  if (messages) {
    for (const m of messages) m.content = '';
    messages.length = 0;
  }
  if (!policy?.wipeAfterUse || active.size > 0) return;
  armWipe(Math.max(5, policy.wipeIdleSeconds) * 1000);
}

function armWipe(ms: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active.size > 0) return;
    void unload?.().then(
      () => log.info('model unloaded after use; its copy of the prompt is gone with it'),
      (e) => log.warn('could not unload the model after use', { err: (e as Error).message }),
    );
  }, ms);
  idleTimer.unref();
}

// Test seam: forget any armed timer so a suite does not leave one running.
export function resetSessions(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  active.clear();
}
