// Account records: connected JMAP mailboxes and their sending policy. The
// credential is stored encrypted and only ever decrypted to build an
// Authorization header; it never leaves this module in plain form.
import { one, query } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { JmapClient, basicAuth, bearerAuth, type JmapSession } from '../jmap/client.js';
import { config } from '../config.js';
import { badRequest } from '../errors.js';
import { assertPublicUrl, isInternalOrigin } from '../util/netguard.js';

export interface SendWindow { start: number; end: number; days: number[]; tz: string }
// Out-of-office auto-reply. Dates are ISO days in the account's timezone;
// an empty end means "until turned off".
export interface VacationSettings { enabled: boolean; subject: string; body: string; start: string | null; end: string | null; onlyContacts: boolean; intervalDays: number }
export const VACATION_DEFAULTS: VacationSettings = { enabled: false, subject: '', body: '', start: null, end: null, onlyContacts: false, intervalDays: 4 };

export interface AccountRow {
  id: number; user_id: number; name: string; email: string;
  provider: 'fastmail' | 'stalwart' | 'jmap';
  session_url: string; auth_type: 'bearer' | 'basic'; auth_user: string | null; auth_secret_enc: string;
  pin_origin: boolean; smtp: SmtpConfig | null; send_via: 'jmap' | 'smtp';
  signature_html: string; voice: string; color: string;
  jmap_account_id: string | null; api_url: string | null; upload_url: string | null; download_url: string | null; event_source_url: string | null;
  capabilities: Record<string, unknown>; identity_id: string | null;
  mailbox_state: string | null; email_state: string | null;
  sync_status: string; sync_error: string | null; last_sync_at: Date | null; initial_sync_done: boolean; sync_limit: number;
  daily_cap: number; jitter_enabled: boolean; jitter_min_s: number; jitter_max_s: number; send_window: SendWindow;
  next_send_at: Date | null; enabled: boolean; created_at: Date;
  vacation?: Partial<VacationSettings> | null;
  trash_retention_days?: number; junk_retention_days?: number; retention_enabled?: boolean; last_retention_at?: Date | null;
  sync_drafts?: boolean;
}

export function vacationOf(acc: Pick<AccountRow, 'vacation'>): VacationSettings {
  return { ...VACATION_DEFAULTS, ...(acc.vacation ?? {}) };
}

export interface SmtpConfig { host: string; port: number; secure: boolean; user: string; pass_enc: string }

// Presets fill in the parts of the form a person should not have to know.
// "custom" exposes everything and is what makes any future JMAP host work.
export const PRESETS = {
  fastmail: {
    label: 'Fastmail',
    sessionUrl: 'https://api.fastmail.com/jmap/session',
    authType: 'bearer' as const,
    pinOrigin: false,
    help: 'Create an API token in Fastmail: Settings → Privacy & Security → Integrations → API tokens. Give it Mail read/write access.',
  },
  stalwart: {
    label: 'Stalwart',
    sessionUrl: '',
    authType: 'basic' as const,
    pinOrigin: true,
    help: 'Sign in with the mailbox address and its password, or an app password created in Stalwart. The session URL is https://<your mail host>/.well-known/jmap.',
  },
  jmap: {
    label: 'Other JMAP server',
    sessionUrl: '',
    authType: 'basic' as const,
    pinOrigin: false,
    help: 'Any RFC 8620 server. Enter the session URL (usually https://host/.well-known/jmap) and how it authenticates.',
  },
};

export function authHeaderFor(acc: Pick<AccountRow, 'auth_type' | 'auth_user' | 'auth_secret_enc'>): string {
  const secret = decrypt(acc.auth_secret_enc);
  return acc.auth_type === 'bearer' ? bearerAuth(secret) : basicAuth(acc.auth_user ?? '', secret);
}

export function clientFor(acc: AccountRow): JmapClient {
  const client = new JmapClient({ sessionUrl: acc.session_url, authHeader: authHeaderFor(acc), pinOrigin: acc.pin_origin, allowPrivate: isInternalOrigin(acc.session_url) });
  if (acc.api_url && acc.upload_url && acc.download_url && acc.jmap_account_id) {
    client.session = {
      apiUrl: acc.api_url,
      uploadUrl: acc.upload_url,
      downloadUrl: acc.download_url,
      eventSourceUrl: acc.event_source_url,
      accountId: acc.jmap_account_id,
      username: acc.email,
      capabilities: acc.capabilities ?? {},
      accountCapabilities: (acc.capabilities as any)?.__account ?? {},
      state: '',
      hasSubmission: Boolean((acc.capabilities as any)?.__hasSubmission),
    };
  }
  return client;
}

export async function getAccount(id: number): Promise<AccountRow | null> {
  return one<AccountRow>('SELECT * FROM accounts WHERE id = $1', [id]);
}

export async function getUserAccount(userId: number, id: number): Promise<AccountRow | null> {
  return one<AccountRow>('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [id, userId]);
}

export async function listAccounts(userId?: number): Promise<AccountRow[]> {
  return userId === undefined
    ? query<AccountRow>('SELECT * FROM accounts ORDER BY id')
    : query<AccountRow>('SELECT * FROM accounts WHERE user_id = $1 ORDER BY id', [userId]);
}

export async function validateSessionUrl(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { throw badRequest('Session URL is not a valid URL'); }
  const internal = isInternalOrigin(u.toString());
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (internal || config.allowInsecureJmap))) {
    throw badRequest('Session URL must use https (plain http is only allowed for a local Stalwart container)');
  }
  // Anything but the bundled mail server has to be a public host.
  await assertPublicUrl(u.toString(), { allowPrivate: internal, what: 'The session URL' });
  return u.toString();
}

// Fetch the session and persist the URLs so later syncs skip the round trip.
export async function connectAccount(acc: AccountRow): Promise<JmapSession> {
  const client = new JmapClient({ sessionUrl: acc.session_url, authHeader: authHeaderFor(acc), pinOrigin: acc.pin_origin, allowPrivate: isInternalOrigin(acc.session_url) });
  const s = await client.fetchSession();
  await query(
    `UPDATE accounts SET jmap_account_id=$2, api_url=$3, upload_url=$4, download_url=$5, event_source_url=$6, capabilities=$7, sync_error=NULL WHERE id=$1`,
    [acc.id, s.accountId, s.apiUrl, s.uploadUrl, s.downloadUrl, s.eventSourceUrl, JSON.stringify({ ...s.capabilities, __account: s.accountCapabilities, __hasSubmission: s.hasSubmission })],
  );
  return s;
}

export function encryptSecret(secret: string): string {
  return encrypt(secret);
}

// What the browser is allowed to see. No ciphertext, no header material.
export function publicAccount(acc: AccountRow) {
  const { auth_secret_enc, smtp, capabilities, ...rest } = acc;
  return {
    ...rest,
    vacation: vacationOf(acc),
    retention: { enabled: acc.retention_enabled !== false, trashDays: acc.trash_retention_days ?? 30, junkDays: acc.junk_retention_days ?? 30, lastRunAt: acc.last_retention_at ?? null },
    sync_drafts: acc.sync_drafts !== false,
    has_smtp: Boolean(smtp),
    smtp: smtp ? { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user } : null,
    has_push: Boolean(acc.event_source_url),
    has_submission: Boolean((capabilities as any)?.__hasSubmission),
  };
}
export type PublicAccount = ReturnType<typeof publicAccount>;
