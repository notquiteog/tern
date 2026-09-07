// F14: showing the supply chain.
//
// Every claim the rest of this app makes — the vault, the blind index, the
// keyed projection, "nothing leaves your server" — is a claim about code
// that is running. None of it is worth anything if the operator cannot tell
// which code that is. A privacy product that will not show its own build is
// asking to be taken on faith, and this is a category of software where
// nobody should have to.
//
// So: one panel that reports, for each container in the deployment, the
// image it was started from, the digest that image actually resolved to, and
// whether that digest matches what the release published. It answers three
// questions an operator otherwise cannot: am I running what I think I am,
// has anything changed under me since I installed it, and is any of it
// coming from somewhere I did not choose.
//
// Reading the container runtime is done by shelling out to podman, which is
// the only way in from inside a container with the socket mounted, and is
// treated as untrusted output: it is parsed, bounded, and never interpolated
// into another command.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { one, query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../log.js';

const exec = promisify(execFile);
const log = logger('attestation');

export interface ContainerReport {
  name: string;
  image: string;
  /** The digest the image resolved to, if the runtime will say. */
  digest: string | null;
  /** Whether this is a registry image or one built on this box. */
  source: 'registry' | 'local' | 'unknown';
  registry: string | null;
  status: string;
  startedAt: string | null;
  /** Set when a pinned digest was recorded and no longer matches. */
  drifted: boolean;
  expected: string | null;
}

export interface Attestation {
  available: boolean;
  reason: string | null;
  version: string;
  /** Digest of the running server bundle, so the app can vouch for itself. */
  bundle: string | null;
  containers: ContainerReport[];
  pinnedAt: string | null;
  checkedAt: string;
}

// Podman's own JSON, asked for by name so a field it stops emitting turns
// into an empty string rather than a crash.
const PS_FORMAT = '{{.Names}}\t{{.Image}}\t{{.ImageID}}\t{{.Status}}\t{{.StartedAt}}';

async function podmanPs(): Promise<ContainerReport[]> {
  const { stdout } = await exec('podman', ['ps', '--all', '--format', PS_FORMAT], {
    timeout: 8000,
    maxBuffer: 512 * 1024,
  });
  const out: ContainerReport[] = [];
  for (const line of stdout.split('\n').slice(0, 100)) {
    const [name, image, imageId, status, startedAt] = line.split('\t');
    if (!name || !image) continue;
    out.push({
      name: name.trim().slice(0, 100),
      image: image.trim().slice(0, 300),
      digest: normaliseDigest(imageId),
      source: sourceOf(image),
      registry: registryOf(image),
      status: (status ?? '').trim().slice(0, 60),
      startedAt: startedAt?.trim() ? startedAt.trim().slice(0, 40) : null,
      drifted: false,
      expected: null,
    });
  }
  return out;
}

export function normaliseDigest(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /([a-f0-9]{12,64})$/i.exec(s.replace(/^sha256:/i, ''));
  return m ? `sha256:${m[1].toLowerCase()}` : null;
}

// Where an image came from, which is the question that matters most: an
// image with no registry prefix was built here, and one with a registry it
// was not installed with is worth an operator's attention.
export function sourceOf(image: string): 'registry' | 'local' | 'unknown' {
  const s = String(image ?? '').trim();
  if (!s) return 'unknown';
  if (s.startsWith('localhost/') || !s.includes('/')) return 'local';
  const first = s.split('/')[0];
  return first.includes('.') || first.includes(':') ? 'registry' : 'local';
}

export function registryOf(image: string): string | null {
  const s = String(image ?? '').trim();
  const first = s.split('/')[0];
  if (!first || (!first.includes('.') && !first.includes(':'))) return null;
  return first.slice(0, 200);
}

// The running server's own code. `import.meta.url` points at the bundle the
// container is executing, so hashing it says exactly what is running rather
// than what the repository contains.
async function bundleDigest(): Promise<string | null> {
  try {
    const path = new URL(import.meta.url).pathname;
    // In the container this file is bundled into dist/index.js; in
    // development it is one source file among many and hashing it would say
    // nothing useful.
    if (!path.includes('/dist/')) return null;
    const buf = await readFile(path);
    return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  } catch {
    return null;
  }
}

// What was recorded the last time an operator said "this is what I meant to
// install". Drift is measured against this rather than against a signature
// from us: the useful question on a self-hosted box is "has it changed since
// you looked", which does not need a trusted third party.
interface Pinned { at: string; digests: Record<string, string> }

async function pinned(): Promise<Pinned | null> {
  const row = await one<{ value: Pinned }>(`SELECT value FROM settings WHERE key='attestation'`);
  return row?.value ?? null;
}

export async function attestation(): Promise<Attestation> {
  const base: Attestation = {
    available: false, reason: null, version: config.version,
    bundle: await bundleDigest(), containers: [], pinnedAt: null,
    checkedAt: new Date().toISOString(),
  };
  let containers: ContainerReport[];
  try {
    containers = await podmanPs();
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'podman is not reachable from inside this container. Mount the podman socket to see the running images.'
      : `podman could not be asked: ${(e as Error).message.slice(0, 200)}`;
    log.warn('attestation unavailable', { err: msg });
    return { ...base, reason: msg };
  }

  const p = await pinned();
  for (const c of containers) {
    const want = p?.digests[c.name];
    if (!want || !c.digest) continue;
    c.expected = want;
    c.drifted = want !== c.digest;
  }
  return { ...base, available: true, containers, pinnedAt: p?.at ?? null };
}

// "This is what I meant to install." Records the digests as they are now, so
// anything that changes afterwards shows as drift.
export async function pinCurrent(userId: number): Promise<Pinned> {
  const now = await attestation();
  if (!now.available) throw new Error(now.reason ?? 'The container runtime is not reachable');
  const digests: Record<string, string> = {};
  for (const c of now.containers) if (c.digest) digests[c.name] = c.digest;
  const value: Pinned = { at: new Date().toISOString(), digests };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('attestation', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(value)],
  );
  await query(
    `INSERT INTO audit_log (user_id, action, details) VALUES ($1,'attestation.pinned',$2)`,
    [userId, JSON.stringify({ containers: Object.keys(digests).length })],
  );
  return value;
}
