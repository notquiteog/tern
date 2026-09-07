// "Nothing may reach a real inbox."
//
// The campaign evaluation used to rely on the dev account's JMAP URL not
// answering. That is not a safeguard, it is a coincidence: the moment the dev
// mail server is running — and in this environment it usually is — a mass-send
// run would hand real messages to a real transport. Whether anything then
// escapes depends on where the fixtures happen to point.
//
// So the guarantee is moved off the transport and onto the addresses, where it
// can actually be asserted. Every domain a run will write to has to be one the
// DNS system guarantees can never resolve:
//
//   .invalid            RFC 2606 — reserved, guaranteed not to resolve
//   .test               RFC 2606 — reserved for testing
//   .example, example.* RFC 2606 — reserved for documentation
//   .localhost          RFC 6761 — never leaves the machine
//
// An address at one of those cannot be delivered by any correctly behaving
// mail server, running or not. The transport is still probed, but only so the
// run can say out loud whether it was relying on a coincidence.
import { config } from '../config.js';
import { query } from '../db.js';
import type { AccountRow } from '../services/accounts.js';

const RESERVED_TLDS = ['.invalid', '.test', '.example', '.localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

export function isUndeliverable(email: string): boolean {
  const domain = String(email ?? '').split('@')[1]?.trim().toLowerCase();
  if (!domain) return false;
  return RESERVED_TLDS.some((t) => domain === t.slice(1) || domain.endsWith(t)) || RESERVED_DOMAINS.includes(domain);
}

export function assertUndeliverable(emails: string[], what = 'these addresses'): void {
  const real = [...new Set(emails.filter((e) => e && !isUndeliverable(e)))];
  if (real.length) {
    throw new Error(
      `Refusing to run: ${what} include ${real.length} address(es) that could actually be delivered — ` +
      `${real.slice(0, 5).join(', ')}${real.length > 5 ? ', …' : ''}. ` +
      `An evaluation may only write to reserved domains (${[...RESERVED_TLDS, ...RESERVED_DOMAINS].join(', ')}).`,
    );
  }
}

// Whether the account's transport would answer at all. Informational: a run is
// safe because of where it is addressed, not because this is down.
export async function transportReachable(acc: AccountRow): Promise<boolean> {
  const url = (acc as any).api_url as string | undefined;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

// The gate every mass-send evaluation calls before it does anything.
// `domains` is what the run intends to use; anything already enrolled on this
// account is checked too, because an eval that reuses a sequence could
// otherwise inherit somebody's real contacts.
export async function assertNothingCanBeDelivered(acc: AccountRow, domains: string[]): Promise<void> {
  if (config.env === 'production') {
    throw new Error('The evaluation scripts do not run on a production install.');
  }
  assertUndeliverable(domains.map((d) => `probe@${d.replace(/^@/, '')}`), 'the domains this run will write to');
  // Anything currently enrolled and active on this account would be picked up
  // by a scheduler tick during the run, whoever created it.
  const live = await query<{ email: string }>(
    `SELECT DISTINCT c.email FROM enrollments e JOIN contacts c ON c.id=e.contact_id
      WHERE e.account_id=$1 AND e.status IN ('active','waiting_review') AND e.next_run_at <= now() + interval '1 hour'`,
    [acc.id],
  );
  assertUndeliverable(live.map((r) => r.email), 'contacts already due on this account');
  const reachable = await transportReachable(acc);
  console.log(
    `send guard: ${live.length} contact(s) already due on ${acc.email}, all undeliverable; ` +
    `transport ${reachable ? 'IS reachable — the run is safe because of the addresses, not because the server is down' : 'is not reachable'}`,
  );
}
