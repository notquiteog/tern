// Client side of the sign-in proof of work: fetch a challenge for this form
// and username, solve it (in a worker when possible), and retry a request
// once if the server says the solution was stale or spent.
import { api, ApiError } from '../api';
import { createSolver } from './powSolver';

export type PowPurpose = 'login' | 'register' | 'setup';
export interface PowSolution { challenge: string; nonce: string }
export interface PowProgress { hashes: number; expected: number; difficulty: number }

interface Challenge { challenge: string; difficulty: number; expiresAt: string }

function solveInWorker(c: Challenge, onProgress?: (p: PowProgress) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const expected = 2 ** c.difficulty;
    const stop = () => { try { worker.postMessage({ type: 'cancel' }); worker.terminate(); } catch { /* ignore */ } };
    worker.onmessage = (e: MessageEvent<any>) => {
      if (e.data.type === 'progress') onProgress?.({ hashes: e.data.hashes, expected, difficulty: c.difficulty });
      if (e.data.type === 'done') { onProgress?.({ hashes: e.data.hashes, expected, difficulty: c.difficulty }); stop(); resolve(e.data.nonce); }
    };
    worker.onerror = (e) => { stop(); reject(e.error ?? new Error('Worker failed')); };
    signal?.addEventListener('abort', () => { stop(); reject(new DOMException('Aborted', 'AbortError')); });
    // Spread the search space so two tabs solving the same challenge do not duplicate work.
    worker.postMessage({ type: 'solve', challenge: c.challenge, difficulty: c.difficulty, start: Math.floor(Math.random() * 1e9) });
  });
}

async function solveInline(c: Challenge, onProgress?: (p: PowProgress) => void, signal?: AbortSignal): Promise<string> {
  const solver = createSolver(c.challenge, c.difficulty, Math.floor(Math.random() * 1e9));
  const expected = 2 ** c.difficulty;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const nonce = solver.step(8_000);
    onProgress?.({ hashes: solver.hashes, expected, difficulty: c.difficulty });
    if (nonce !== null) return nonce;
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function solvePow(purpose: PowPurpose, username: string, onProgress?: (p: PowProgress) => void, signal?: AbortSignal): Promise<PowSolution> {
  const c = await api.get<Challenge>(`/api/auth/pow?purpose=${purpose}&username=${encodeURIComponent(username.trim().toLowerCase())}`, signal);
  onProgress?.({ hashes: 0, expected: 2 ** c.difficulty, difficulty: c.difficulty });
  let nonce: string;
  try { nonce = await solveInWorker(c, onProgress, signal); } catch (e) { if ((e as any)?.name === 'AbortError') throw e; nonce = await solveInline(c, onProgress, signal); }
  return { challenge: c.challenge, nonce };
}

// Solve, call, and if the server rejects the proof (expired, already used,
// difficulty raised between fetch and submit) solve once more and retry.
export async function withPow<T>(purpose: PowPurpose, username: string, run: (pow: PowSolution) => Promise<T>, onProgress?: (p: PowProgress | null) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const pow = await solvePow(purpose, username, onProgress);
    onProgress?.(null);
    try { return await run(pow); } catch (e) {
      if (attempt === 0 && e instanceof ApiError && (e.code === 'pow_invalid' || e.code === 'pow_required')) continue;
      throw e;
    }
  }
}

export function fmtHashes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
