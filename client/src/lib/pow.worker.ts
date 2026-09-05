// Web Worker wrapper around the solver so the sign-in form stays responsive.
import { createSolver } from './powSolver';

let cancelled = false;

self.onmessage = (e: MessageEvent<{ type: 'solve'; challenge: string; difficulty: number; start: number } | { type: 'cancel' }>) => {
  const msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  cancelled = false;
  const solver = createSolver(msg.challenge, msg.difficulty, msg.start);
  const tick = () => {
    if (cancelled) return;
    const nonce = solver.step(20_000);
    if (nonce !== null) { self.postMessage({ type: 'done', nonce, hashes: solver.hashes }); return; }
    self.postMessage({ type: 'progress', hashes: solver.hashes });
    setTimeout(tick, 0);
  };
  tick();
};
