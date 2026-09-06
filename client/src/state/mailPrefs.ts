// Preferences for reading and writing mail. Kept in localStorage for an
// instant start and mirrored to the profile so they follow the person to
// another browser, the same way appearance does.
import { useEffect, useState } from 'react';

export type Layout = 'right' | 'bottom' | 'off';
export interface MailPrefs {
  undoSendSeconds: 0 | 5 | 10 | 20 | 30;
  layout: Layout;
  defaultReplyAll: boolean;
  sendAndArchive: boolean;
  showImagesFromContacts: boolean;
  markReadDelay: 0 | 2 | 5; // seconds a conversation stays unread after opening; 0 = at once
}

export const MAIL_PREF_DEFAULTS: MailPrefs = { undoSendSeconds: 10, layout: 'right', defaultReplyAll: false, sendAndArchive: false, showImagesFromContacts: true, markReadDelay: 0 };
const KEY = 'tern.mail';
const listeners = new Set<(p: MailPrefs) => void>();

function legacyLayout(): Layout | null {
  try { const raw = localStorage.getItem('tern.split'); if (raw === null) return null; return JSON.parse(raw) ? 'right' : 'off'; } catch { return null; }
}

export function getMailPrefs(): MailPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const legacy = legacyLayout();
    return { ...MAIL_PREF_DEFAULTS, ...(legacy && !parsed ? { layout: legacy } : {}), ...(parsed ?? {}) };
  } catch { return { ...MAIL_PREF_DEFAULTS }; }
}

export function setMailPrefs(patch: Partial<MailPrefs>, sync = true): MailPrefs {
  const next = { ...getMailPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  for (const l of listeners) l(next);
  if (sync) fetch('/api/auth/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tern' }, credentials: 'same-origin', body: JSON.stringify({ mail: next }) }).catch(() => {});
  return next;
}

export function adoptServerMailPrefs(serverPrefs: Record<string, unknown> | undefined): void {
  const server = serverPrefs?.mail as Partial<MailPrefs> | undefined;
  if (!server) return;
  let local: string | null = null;
  try { local = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (!local) setMailPrefs(server, false);
}

export function useMailPrefs(): [MailPrefs, (patch: Partial<MailPrefs>) => void] {
  const [p, setP] = useState<MailPrefs>(getMailPrefs);
  useEffect(() => { listeners.add(setP); return () => { listeners.delete(setP); }; }, []);
  return [p, (patch) => setMailPrefs(patch)];
}
