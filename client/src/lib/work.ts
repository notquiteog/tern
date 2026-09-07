// The browser side of the work guard: the small amount of CPU a request has
// to spend before the server will do something expensive with it.
//
// It reuses the sign-in solver, because it is the same puzzle at a different
// price. The difference is where the answer goes: sign-in puts it in the
// form body, and this puts it in headers, so the same helper works for a
// JSON post, a raw audio upload and a two-gigabyte mbox alike.
//
// The cost is invisible at first — ten bits is a few hundred hashes, gone
// before a button finishes animating — and climbs with how much this session
// has already asked for and with how busy the model is. Somebody working
// through their inbox never notices; a script pays for its enthusiasm.
import { api, apiStream, ApiError } from '../api';
import { createSolver } from './powSolver';

export type WorkPurpose = 'ai' | 'brief' | 'search' | 'index' | 'voice' | 'import';

interface Challenge { challenge: string; difficulty: number; expiresAt: string }

export interface WorkHeaders extends Record<string, string> { 'X-Work-Challenge': string; 'X-Work-Nonce': string }

// Solving happens in a worker when there is one, and inline in small slices
// when there is not, so a low-powered phone still yields to the UI thread
// between batches.
function solveInWorker(c: Challenge, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const stop = () => { try { worker.postMessage({ type: 'cancel' }); worker.terminate(); } catch { /* ignore */ } };
    worker.onmessage = (e: MessageEvent<any>) => { if (e.data.type === 'done') { stop(); resolve(e.data.nonce); } };
    worker.onerror = (e) => { stop(); reject(e.error ?? new Error('Worker failed')); };
    signal?.addEventListener('abort', () => { stop(); reject(new DOMException('Aborted', 'AbortError')); });
    worker.postMessage({ type: 'solve', challenge: c.challenge, difficulty: c.difficulty, start: Math.floor(Math.random() * 1e9) });
  });
}

async function solveInline(c: Challenge, signal?: AbortSignal): Promise<string> {
  const solver = createSolver(c.challenge, c.difficulty, Math.floor(Math.random() * 1e9));
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const nonce = solver.step(8_000);
    if (nonce !== null) return nonce;
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function solveWork(purpose: WorkPurpose, signal?: AbortSignal): Promise<WorkHeaders> {
  const c = await api.get<Challenge>(`/api/features/work?purpose=${purpose}`, signal);
  let nonce: string;
  try { nonce = await solveInWorker(c, signal); } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    nonce = await solveInline(c, signal);
  }
  return { 'X-Work-Challenge': c.challenge, 'X-Work-Nonce': nonce };
}

// Solve, call, and solve once more if the server says the proof was stale,
// spent, or below a difficulty that rose between fetching and sending. One
// retry: a second rejection is a real problem rather than a race.
export async function withWork<T>(purpose: WorkPurpose, run: (headers: WorkHeaders) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const headers = await solveWork(purpose, signal);
    try {
      return await run(headers);
    } catch (e) {
      if (attempt === 0 && e instanceof ApiError && (e.code === 'work_invalid' || e.code === 'work_required')) continue;
      throw e;
    }
  }
}

// The two shapes every caller needs: a JSON post and a raw-body upload, both
// with the proof attached. They are here rather than in api.ts because the
// work headers are the only reason these differ from an ordinary call.
export async function postWithWork<T>(purpose: WorkPurpose, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return withWork(purpose, async (work) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/json', Accept: 'application/json', ...work },
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
      signal,
    });
    return unwrap<T>(res);
  }, signal);
}

export async function uploadWithWork<T>(purpose: WorkPurpose, path: string, blob: Blob | ArrayBuffer, contentType: string, signal?: AbortSignal): Promise<T> {
  return withWork(purpose, async (work) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Requested-With': 'tern', 'Content-Type': contentType, Accept: 'application/json', ...work },
      body: blob,
      credentials: 'same-origin',
      signal,
    });
    return unwrap<T>(res);
  }, signal);
}

// The streaming shape, which every AI button in the app needs and none of
// them had.
//
// `apiStream` was written before the work guard existed and never carried a
// proof. That is invisible at first — the guard is free for the opening
// requests of a window — and then the composer, the thread summary, the quick
// replies, the template writer and the admin playground all start failing at
// once with "This request needs browser verification", because the price rose
// and nothing was paying it. Every generation goes through here now, so they
// pay like every other expensive call.
export async function streamWithWork(
  purpose: WorkPurpose,
  path: string,
  body: unknown,
  handlers: { onEvent: (event: string, data: any) => void; signal?: AbortSignal },
): Promise<void> {
  return withWork(purpose, (work) => apiStream(path, body, { ...handlers, headers: work }), handlers.signal);
}

async function unwrap<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code, data?.details);
  return data as T;
}
