// Thin fetch wrapper. Every mutating call carries X-Requested-With, which the
// server requires as its CSRF check; a 401 anywhere sends the app to login.
export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; contentType?: string; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'tern', Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (opts.raw) { payload = body as BodyInit; headers['Content-Type'] = opts.contentType ?? 'application/octet-stream'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/setup')) onUnauthorized?.();
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code, data?.details);
  return data as T;
}

export const api = {
  get: <T,>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, { signal }),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T,>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T,>(path: string) => request<T>('DELETE', path),
  upload: <T,>(path: string, blob: Blob | ArrayBuffer | string, contentType: string) => request<T>('POST', path, blob, { raw: true, contentType }),
};

// POST + server-sent events. EventSource cannot POST, so read the stream by hand.
export async function apiStream(path: string, body: unknown, handlers: { onEvent: (event: string, data: any) => void; signal?: AbortSignal }): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), credentials: 'same-origin', signal: handlers.signal });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  const flush = () => {
    if (data.length) {
      const raw = data.join('\n');
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch { /* raw */ }
      handlers.onEvent(event, parsed);
    }
    event = 'message'; data = [];
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
      if (field === 'event') event = val; else if (field === 'data') data.push(val);
    }
  }
  flush();
}
