// Burner addresses: one per user, on the bundled mail server, receive-only.
// It is an alias on the user's own mailbox there, so mail to it lands in
// the same inbox. The name is generated, never chosen, and a new one
// replaces the old (which stops working). Tern only ever sends from the
// mailbox's real address, so the burner cannot be used as a sender.
import { one, query } from '../db.js';
import { config } from '../config.js';
import { badRequest, tooMany } from '../errors.js';
import { findAccountByName, getAliases, listDomains, setAliases, stalwartEnabled } from './stalwart.js';
import type { AccountRow } from './accounts.js';

export interface Burner { user_id: number; account_id: number; address: string; local_part: string; created_at: Date }

const WORDS = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'ginger', 'harbor', 'indigo', 'juniper', 'kestrel', 'lantern', 'meadow', 'nutmeg', 'orchid', 'pepper', 'quartz', 'river', 'saffron', 'timber', 'umber', 'velvet', 'willow', 'zephyr', 'aspen', 'birch', 'coral', 'dune', 'elm', 'fern', 'glacier', 'heron', 'iris', 'jade', 'kelp', 'lotus', 'moss', 'nova', 'opal', 'pine', 'reef', 'sage', 'tundra', 'violet'];
const ROTATE_COOLDOWN_MS = 10 * 60 * 1000;

function generateLocalPart(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${pick()}-${pick()}-${num}`;
}

// The user's mailbox on the bundled Stalwart, if they connected one.
export async function burnerAccount(userId: number): Promise<AccountRow | null> {
  if (!stalwartEnabled()) return null;
  return one<AccountRow>(`SELECT * FROM accounts WHERE user_id=$1 AND enabled AND provider='stalwart' AND session_url LIKE $2 ORDER BY id LIMIT 1`, [userId, `${config.stalwartUrl}%`]);
}

export async function getBurner(userId: number): Promise<Burner | null> {
  return one<Burner>('SELECT * FROM burner_addresses WHERE user_id=$1', [userId]);
}

async function applyAlias(acc: AccountRow, oldLocal: string | null, newLocal: string | null): Promise<string> {
  const local = acc.email.split('@')[0];
  const sw = await findAccountByName(local);
  if (!sw) throw badRequest('Your mailbox was not found on the mail server');
  const domains = await listDomains();
  const domain = domains.find((d) => d.name.toLowerCase() === config.stalwartDomain.toLowerCase()) ?? domains[0];
  if (!domain) throw badRequest('The mail server has no domain yet');
  const current = await getAliases(sw.id);
  const kept = Object.values(current).filter((a) => a.name !== oldLocal);
  if (newLocal) kept.push({ name: newLocal, domainId: domain.id });
  const next: Record<string, { name: string; domainId: string }> = {};
  kept.forEach((a, i) => { next[String(i)] = { name: a.name, domainId: a.domainId }; });
  await setAliases(sw.id, next);
  return domain.name;
}

export async function rotateBurner(userId: number): Promise<Burner> {
  const acc = await burnerAccount(userId);
  if (!acc) throw badRequest('Connect your mailbox on the bundled mail server first (Settings → Accounts)');
  const existing = await getBurner(userId);
  if (existing && Date.now() - new Date(existing.created_at).getTime() < ROTATE_COOLDOWN_MS) throw tooMany('You just created one; try again in a few minutes');
  let local = generateLocalPart();
  for (let i = 0; i < 5 && (await one('SELECT 1 FROM burner_addresses WHERE local_part=$1', [local])); i++) local = generateLocalPart();
  const domain = await applyAlias(acc, existing?.local_part ?? null, local);
  const address = `${local}@${domain}`;
  await query(
    `INSERT INTO burner_addresses (user_id, account_id, address, local_part, created_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id) DO UPDATE SET account_id=EXCLUDED.account_id, address=EXCLUDED.address, local_part=EXCLUDED.local_part, created_at=now()`,
    [userId, acc.id, address, local],
  );
  return (await getBurner(userId))!;
}

export async function removeBurner(userId: number): Promise<void> {
  const existing = await getBurner(userId);
  if (!existing) return;
  const acc = (await burnerAccount(userId)) ?? (await one<AccountRow>('SELECT * FROM accounts WHERE id=$1', [existing.account_id]));
  if (acc) { try { await applyAlias(acc, existing.local_part, null); } catch { /* the mailbox may be gone; the row goes regardless */ } }
  await query('DELETE FROM burner_addresses WHERE user_id=$1', [userId]);
}
