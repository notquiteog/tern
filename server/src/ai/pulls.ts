// Downloads that outlive the page that started them.
//
// A pull used to be the HTTP request itself: the browser opened an SSE
// stream, the route drove Ollama inside it, and `req.on('close')` aborted the
// generator. That is fine for a 1 GB model on a LAN and wrong for everything
// else — switching tabs, reloading the page, a laptop sleeping or a phone
// locking all killed a download that was minutes from finishing, and the only
// evidence was a model that never appeared. On a remote Ollama reached
// through perch over a tunnel it was worse again, because the same disconnect
// tore down the proxied request mid-blob.
//
// So a pull is now a job on the server. Starting one twice attaches to the
// one already running rather than starting a second; watching it is a
// subscription that can be dropped and remade; and nothing about who is
// watching decides whether it keeps going. Only an explicit cancel stops it.
//
// The other half of this file is arithmetic. Ollama reports progress per
// layer — `completed`/`total` for one digest at a time — and reporting that
// number directly is what made the bar jump back to zero four times during a
// download and finish at "100%" three times. Progress is summed across every
// layer the stream has mentioned, which is the number a person means by "how
// far through is it".
import { logger } from '../log.js';

const log = logger('pull');

/** What kind of server the download is happening on. Only used for labelling and keying. */
export type PullKind = 'model' | 'voice';

/** One line of Ollama's NDJSON pull stream. */
export interface PullLine { status?: string; digest?: string; total?: number; completed?: number; error?: string }

export interface PullView {
  id: string;
  kind: PullKind;
  name: string;
  /** 'running' until it stops; then how it stopped. */
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** The phase the far end last named: "pulling manifest", "verifying sha256 digest", "downloading". */
  status: string;
  /** Bytes across every layer seen so far. */
  completed: number;
  /** Bytes across every layer seen so far, or 0 while nothing has been sized. */
  total: number;
  /**
   * Whole percent, or null when the server gives no byte counts at all — a
   * transcriber that downloads in one blocking call has a real download and
   * no way to describe it, and a bar that invents a number for it is worse
   * than one that says it does not know.
   */
  pct: number | null;
  /** Recent rate, smoothed. Null until two measurements exist. */
  bytesPerSec: number | null;
  etaSeconds: number | null;
  startedAt: number;
  endedAt: number | null;
  error?: string;
}

interface Job {
  view: PullView;
  abort: AbortController;
  /** Per-layer totals, so progress is the sum rather than whichever layer is current. */
  layers: Map<string, { total: number; completed: number }>;
  watchers: Set<(v: PullView) => void>;
  /** For the rate estimate: the last sample, and the smoothed value. */
  lastSample: { at: number; completed: number } | null;
  sweep?: NodeJS.Timeout;
}

const jobs = new Map<string, Job>();

/** How long a finished job stays visible, so a page that reconnects learns the outcome. */
const KEEP_FINISHED_MS = 90_000;

const keyOf = (kind: PullKind, name: string) => `${kind}:${name}`;

function publish(job: Job): void {
  const snapshot = { ...job.view };
  for (const fn of job.watchers) {
    try { fn(snapshot); } catch { /* a dead socket is not this job's problem */ }
  }
}

/**
 * Fold one line of the upstream stream into the job.
 *
 * Layers are remembered by digest and summed. A line with no digest is a
 * phase announcement ("pulling manifest", "verifying sha256 digest") and only
 * moves the label.
 */
function absorb(job: Job, line: PullLine): void {
  if (line.status) job.view.status = line.status;
  if (line.digest && typeof line.total === 'number' && line.total > 0) {
    const prev = job.layers.get(line.digest);
    job.layers.set(line.digest, {
      total: Math.max(line.total, prev?.total ?? 0),
      // Ollama re-sends a layer's final size after it completes; never let a
      // late line move a layer backwards.
      completed: Math.max(line.completed ?? 0, prev?.completed ?? 0),
    });
  }
  let total = 0;
  let completed = 0;
  for (const l of job.layers.values()) { total += l.total; completed += Math.min(l.completed, l.total); }
  job.view.total = total;
  job.view.completed = completed;
  job.view.pct = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null;
  rate(job);
}

// A smoothed rate rather than the instantaneous one: registry throughput
// swings enough that an unsmoothed ETA is unreadable.
function rate(job: Job): void {
  const now = Date.now();
  const sample = job.lastSample;
  if (!sample) { job.lastSample = { at: now, completed: job.view.completed }; return; }
  const dt = (now - sample.at) / 1000;
  if (dt < 1) return;
  const db = job.view.completed - sample.completed;
  job.lastSample = { at: now, completed: job.view.completed };
  if (db < 0) return;
  const instant = db / dt;
  job.view.bytesPerSec = job.view.bytesPerSec === null ? instant : job.view.bytesPerSec * 0.7 + instant * 0.3;
  const left = job.view.total - job.view.completed;
  job.view.etaSeconds = job.view.bytesPerSec > 1024 && left > 0 ? Math.round(left / job.view.bytesPerSec) : null;
}

function finish(job: Job, state: PullView['state'], error?: string): void {
  if (job.view.state !== 'running') return;
  job.view.state = state;
  job.view.endedAt = Date.now();
  job.view.bytesPerSec = null;
  job.view.etaSeconds = null;
  if (error) job.view.error = error;
  if (state === 'done') { job.view.status = 'ready'; if (job.view.total > 0) { job.view.completed = job.view.total; job.view.pct = 100; } }
  publish(job);
  log.info(`pull ${state}`, { name: job.view.name, kind: job.view.kind, error });
  // Kept a little while so a browser that was closed during the download can
  // come back and be told how it went, then dropped.
  job.sweep = setTimeout(() => { if (jobs.get(job.view.id) === job) jobs.delete(job.view.id); }, KEEP_FINISHED_MS);
  job.sweep.unref?.();
}

/**
 * Start a download, or hand back the one already running for this name.
 *
 * `run` is given an abort signal and a sink for progress lines. It is driven
 * to completion by this function and not by whoever happens to be watching:
 * the returned view is a handle, not the work.
 */
export function startPull(
  kind: PullKind,
  name: string,
  run: (emit: (line: PullLine) => void, signal: AbortSignal) => Promise<void>,
): PullView {
  const id = keyOf(kind, name);
  const existing = jobs.get(id);
  if (existing && existing.view.state === 'running') return { ...existing.view };
  // A finished job for the same name is replaced rather than resumed: asking
  // again means asking again.
  if (existing?.sweep) clearTimeout(existing.sweep);

  const abort = new AbortController();
  const job: Job = {
    view: {
      id, kind, name, state: 'running', status: 'starting',
      completed: 0, total: 0, pct: null, bytesPerSec: null, etaSeconds: null,
      startedAt: Date.now(), endedAt: null,
    },
    abort,
    layers: new Map(),
    watchers: new Set(),
    lastSample: null,
  };
  jobs.set(id, job);
  log.info('pull started', { name, kind });

  void (async () => {
    try {
      await run((line) => {
        if (job.view.state !== 'running') return;
        if (line.error) throw new Error(line.error);
        absorb(job, line);
        publish(job);
      }, abort.signal);
      if (abort.signal.aborted) finish(job, 'cancelled', 'cancelled');
      else finish(job, 'done');
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (abort.signal.aborted) finish(job, 'cancelled', 'cancelled');
      else finish(job, 'error', message);
    }
  })();

  return { ...job.view };
}

/** Every job this process knows about, running or recently finished. */
export function listPulls(kind?: PullKind): PullView[] {
  const all = [...jobs.values()].map((j) => ({ ...j.view }));
  return (kind ? all.filter((v) => v.kind === kind) : all).sort((a, b) => a.startedAt - b.startedAt);
}

export function getPull(kind: PullKind, name: string): PullView | null {
  const job = jobs.get(keyOf(kind, name));
  return job ? { ...job.view } : null;
}

/**
 * Watch a job. The current state arrives immediately — a page that reloads
 * mid-download sees where it is rather than waiting for the next line — and
 * the returned function detaches without touching the download.
 */
export function watchPull(kind: PullKind, name: string, onUpdate: (v: PullView) => void): (() => void) | null {
  const job = jobs.get(keyOf(kind, name));
  if (!job) return null;
  onUpdate({ ...job.view });
  if (job.view.state !== 'running') return () => {};
  job.watchers.add(onUpdate);
  return () => { job.watchers.delete(onUpdate); };
}

/** Stop a download on purpose. The only thing that does. */
export function cancelPull(kind: PullKind, name: string): boolean {
  const job = jobs.get(keyOf(kind, name));
  if (!job || job.view.state !== 'running') return false;
  job.abort.abort();
  // The runner notices the abort and settles the job, but a runner blocked in
  // a call that ignores the signal would leave it "running" for ever.
  finish(job, 'cancelled', 'cancelled');
  return true;
}

/** Tests only: drop everything without waiting for the sweep. */
export function resetPulls(): void {
  for (const job of jobs.values()) { if (job.sweep) clearTimeout(job.sweep); job.abort.abort(); }
  jobs.clear();
}
