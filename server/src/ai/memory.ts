// What the box and the model are using right now, for the meter on
// Admin → AI model.
//
// Three numbers matter on a small install, and they are not the same number:
// what the whole machine has left, what Ollama's container is allowed, and
// what the loaded model plus its parallel slots are actually holding. A
// person who has just raised the context window wants to see all three move.
import { readFile } from 'node:fs/promises';
import os from 'node:os';

export interface HostMemory { total: number; available: number; used: number; source: 'meminfo' | 'os' }

// /proc/meminfo is read rather than os.freemem() because "free" on Linux is
// not "available": page cache is counted as used, so free memory on a busy
// mail server looks alarming and means nothing. MemAvailable is the kernel's
// own estimate of what a new process could actually get.
export async function hostMemory(): Promise<HostMemory> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kib = (key: string): number => {
      const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
      return m ? Number(m[1]) * 1024 : 0;
    };
    const total = kib('MemTotal');
    const available = kib('MemAvailable');
    if (total > 0 && available > 0) return { total, available, used: total - available, source: 'meminfo' };
  } catch { /* not Linux, or a container without /proc: fall through */ }
  const total = os.totalmem();
  const available = os.freemem();
  return { total, available, used: total - available, source: 'os' };
}
