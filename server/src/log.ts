// Tiny leveled logger. Structured enough to grep in `podman logs`, small
// enough not to be a dependency.
import { config } from './config.js';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const threshold = levels[(config.logLevel as Level) in levels ? (config.logLevel as Level) : 'info'];

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  if (levels[level] < threshold) return;
  const ts = new Date().toISOString();
  const rest = extra ? ' ' + JSON.stringify(extra, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)) : '';
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${rest}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit('error', scope, msg, extra),
  };
}
