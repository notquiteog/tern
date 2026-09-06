import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useLocalStorage } from './hooks';

export interface Account {
  id: number; user_id: number; name: string; email: string; provider: 'fastmail' | 'stalwart' | 'jmap'; session_url: string; auth_type: 'bearer' | 'basic'; auth_user: string | null; pin_origin: boolean;
  send_via: 'jmap' | 'smtp'; signature_html: string; voice: string; color: string; sync_status: string; sync_error: string | null; last_sync_at: string | null; initial_sync_done: boolean; sync_limit: number;
  daily_cap: number; jitter_enabled: boolean; jitter_min_s: number; jitter_max_s: number; send_window: { start: number; end: number; days: number[]; tz: string }; next_send_at: string | null; enabled: boolean;
  has_smtp: boolean; smtp: { host: string; port: number; secure: boolean; user: string } | null; has_push: boolean; has_submission: boolean; push: { push: string; lastPushAt: string | null };
  vacation: Vacation;
}
export interface Vacation { enabled: boolean; subject: string; body: string; start: string | null; end: string | null; onlyContacts: boolean; intervalDays: number }
export interface Mailbox { id: number; account_id: number; jmap_id: string; name: string; parent_id: string | null; role: string | null; sort_order: number; total_emails: number; unread_emails: number; total_threads: number; unread_threads: number; color: string | null }
export interface Counts { inboxUnread: Record<string, number>; inboxUnreadTotal: number; drafts: number; snoozed: number; scheduled: number; review: number; labelUnread: Record<string, number> }

export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api.get<{ accounts: Account[] }>('/api/accounts').then((r) => r.accounts) });
export const useMailboxes = () => useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mail/mailboxes').then((r) => r.mailboxes) });
export const useCounts = () => useQuery({ queryKey: ['counts'], queryFn: () => api.get<Counts>('/api/mail/counts'), refetchInterval: 60_000 });
export const useContactTags = () => useQuery({ queryKey: ['contact-tags'], queryFn: () => api.get<{ tags: { tag: string; n: number }[] }>('/api/contacts/tags').then((r) => r.tags) });
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ templates: any[] }>('/api/templates').then((r) => r.templates) });
export const useSequences = () => useQuery({ queryKey: ['sequences'], queryFn: () => api.get<{ sequences: any[] }>('/api/sequences').then((r) => r.sequences) });
export const useAiStatus = () => useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<any>('/api/ai/status'), staleTime: 30_000 });

// Which accounts the mail views show: 'all' or one account id.
export function useAccountFilter(): [string, (v: string) => void] {
  return useLocalStorage<string>('tern.accountFilter', 'all');
}

export const ROLE_LABELS: Record<string, string> = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', junk: 'Junk', spam: 'Junk', trash: 'Trash', archive: 'Archive', all: 'All mail' };
