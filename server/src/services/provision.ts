// A mailbox for every new person. When the bundled Stalwart is enabled, a
// new Tern login gets `<username>@<mail domain>` created on the mail server
// and connected as their first account, so they can read mail the moment
// they sign in. An address that already exists on the server belongs to
// someone else and blocks the sign-up: an admin has to connect it by hand.
import { one, query } from '../db.js';
import { config } from '../config.js';
import { conflict } from '../errors.js';
import { logger } from '../log.js';
import type { UserRow } from '../auth.js';
import * as sw from './stalwart.js';
import { connectAccount, encryptSecret, type AccountRow } from './accounts.js';
import { syncManager } from '../workers/syncManager.js';
import { authSettings } from '../routes/users.js';

const log = logger('provision');

export interface ProvisionResult { email: string; accountId: number | null; created: boolean; error: string | null }

export async function provisioningEnabled(): Promise<boolean> {
  if (!sw.stalwartEnabled() || !config.stalwartDomain) return false;
  return (await authSettings()).provisionMailboxes;
}

// The local part is the username; a username that is already an address on
// the mail domain keeps its local part, any other address form cannot be
// provisioned here.
export function localPartFor(username: string): string | null {
  const u = username.trim().toLowerCase();
  const at = u.indexOf('@');
  if (at >= 0) {
    const domain = u.slice(at + 1);
    if (domain !== config.stalwartDomain.toLowerCase()) return null;
    return validLocal(u.slice(0, at));
  }
  return validLocal(u);
}

function validLocal(s: string): string | null {
  return /^[a-z0-9._+-]{1,64}$/.test(s) && !s.startsWith('.') && !s.endsWith('.') ? s : null;
}

export function addressFor(username: string): string | null {
  const local = localPartFor(username);
  return local ? `${local}@${config.stalwartDomain.toLowerCase()}` : null;
}

// Exists on the mail server as a mailbox address or as an alias of one.
export async function mailboxExists(local: string): Promise<boolean> {
  const email = `${local}@${config.stalwartDomain.toLowerCase()}`;
  const boxes = await sw.listMailboxes();
  if (boxes.some((m) => m.email?.toLowerCase() === email || m.name.toLowerCase() === local || m.aliases.some((a) => a.toLowerCase() === email))) return true;
  return Boolean(await sw.findAccountByName(local));
}

// Refuses the sign-up when the address is taken. Called before the user row
// exists so nothing is left half-made.
export async function assertMailboxFree(username: string): Promise<void> {
  if (!(await provisioningEnabled())) return;
  const local = localPartFor(username);
  if (!local) return;
  if (await mailboxExists(local)) throw conflict(`${local}@${config.stalwartDomain} already exists on the mail server. Ask an admin to connect that mailbox to a login for you.`);
}

// Creates the mailbox and connects it. Never throws: the login already
// exists and is usable without a mailbox; the outcome is reported instead.
export async function provisionMailbox(user: UserRow, opts: { password?: string; displayName?: string } = {}): Promise<ProvisionResult | null> {
  if (!(await provisioningEnabled())) return null;
  const local = localPartFor(user.username);
  if (!local) return null;
  const domainName = config.stalwartDomain.toLowerCase();
  const email = `${local}@${domainName}`;
  try {
    const domains = await sw.listDomains();
    const domain = domains.find((d) => d.name.toLowerCase() === domainName) ?? domains[0];
    if (!domain) throw new Error('the mail server has no domain yet');
    const password = opts.password ?? sw.generateMailboxPassword();
    const mailbox = await sw.createMailbox({ localPart: local, domainId: domain.id, password, displayName: opts.displayName ?? user.display_name });
    const address = (mailbox.email || email).toLowerCase();
    const rows = await query<AccountRow>(
      `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_user, auth_secret_enc, pin_origin, color)
       VALUES ($1,$2,$3,'stalwart',$4,'basic',$3,$5,true,$6)
       ON CONFLICT (user_id, email) DO UPDATE SET auth_secret_enc=EXCLUDED.auth_secret_enc, api_url=NULL, sync_status='idle', sync_error=NULL RETURNING *`,
      [user.id, opts.displayName ?? user.display_name, address, `${config.stalwartUrl}/.well-known/jmap`, encryptSecret(password), '#2fa572'],
    );
    const acc = rows[0];
    try { await connectAccount(acc); syncManager.add(acc.id); } catch (e) { log.warn('mailbox created but the first connection failed', { email: address, err: (e as Error).message }); }
    await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'stalwart.mailbox_provisioned',$2,$3)`, [user.id, address, JSON.stringify({ accountId: acc.id })]);
    log.info('mailbox provisioned', { user: user.username, email: address });
    return { email: address, accountId: acc.id, created: true, error: null };
  } catch (e) {
    const msg = (e as Error).message;
    log.error('mailbox provisioning failed', { user: user.username, err: msg });
    await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'stalwart.mailbox_provision_failed',$2,$3)`, [user.id, email, JSON.stringify({ error: msg.slice(0, 300) })]);
    return { email, accountId: null, created: false, error: msg };
  }
}

// The user's mailbox on the bundled server (for password self-service).
export function isManagedAccount(acc: Pick<AccountRow, 'provider' | 'session_url' | 'auth_type'>): boolean {
  if (!sw.stalwartEnabled() || acc.provider !== 'stalwart' || acc.auth_type !== 'basic') return false;
  if (config.stalwartUrl && acc.session_url.startsWith(config.stalwartUrl)) return true;
  try { return Boolean(config.stalwartHost) && new URL(acc.session_url).hostname === config.stalwartHost; } catch { return false; }
}

export async function stalwartAccountFor(acc: AccountRow): Promise<{ id: string } | null> {
  const local = acc.email.split('@')[0]?.toLowerCase();
  if (!local) return null;
  const byName = await sw.findAccountByName(local);
  if (byName) return byName;
  const boxes = await sw.listMailboxes();
  const m = boxes.find((b) => b.email?.toLowerCase() === acc.email.toLowerCase());
  return m ? { id: m.id } : null;
}

export async function hasProvisionedMailbox(userId: number): Promise<boolean> {
  return Boolean(await one('SELECT 1 FROM accounts WHERE user_id=$1 AND provider=$2 LIMIT 1', [userId, 'stalwart']));
}
