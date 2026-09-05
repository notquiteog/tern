import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw === null ? initial : (JSON.parse(raw) as T); } catch { return initial; }
  });
  const set = useCallback((v: T | ((p: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [key]);
  return [value, set];
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// Live updates from the server. Each event maps to the react-query keys it
// invalidates, which is how the inbox refreshes without polling.
export function useServerEvents(enabled: boolean, onEvent?: (type: string, data: any) => void) {
  const qc = useQueryClient();
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry = 2000;
    let closed = false;
    const connect = () => {
      es = new EventSource('/api/events');
      const handle = (type: string) => (e: MessageEvent) => {
        let data: any = null;
        try { data = JSON.parse(e.data); } catch { /* ignore */ }
        cb.current?.(type, data);
        if (type === 'sync' || type === 'send') { qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['thread'] }); qc.invalidateQueries({ queryKey: ['counts'] }); }
        if (type === 'account' || type === 'sync') qc.invalidateQueries({ queryKey: ['accounts'] });
        if (type === 'enrollment') { qc.invalidateQueries({ queryKey: ['sequences'] }); qc.invalidateQueries({ queryKey: ['sequence'] }); qc.invalidateQueries({ queryKey: ['enrollments'] }); }
        if (type === 'review') { qc.invalidateQueries({ queryKey: ['review'] }); qc.invalidateQueries({ queryKey: ['counts'] }); }
        if (type === 'send') { qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['outbox'] }); }
      };
      for (const t of ['sync', 'account', 'send', 'enrollment', 'review', 'ai']) es.addEventListener(t, handle(t));
      es.onopen = () => { retry = 2000; };
      es.onerror = () => { es?.close(); if (!closed) setTimeout(connect, retry); retry = Math.min(retry * 2, 30_000); };
    };
    connect();
    return () => { closed = true; es?.close(); };
  }, [enabled, qc]);
}

export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []) {
  useEffect(() => {
    let pending = '';
    let timer: number | null = null;
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) {
        const combo = `${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.key.toLowerCase()}`;
        if (map[combo]) { e.preventDefault(); map[combo](e); }
        return;
      }
      const key = e.key;
      const seq = pending ? `${pending} ${key}` : key;
      if (map[seq]) { e.preventDefault(); map[seq](e); pending = ''; return; }
      if (Object.keys(map).some((k) => k.startsWith(seq + ' '))) {
        pending = seq;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => { pending = ''; }, 900);
        return;
      }
      pending = '';
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
