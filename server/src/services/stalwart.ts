// Management client for the bundled Stalwart. Only exists when install.sh
// enabled the mail server and wrote the admin credentials into .env; the
// app then provisions mailboxes for its own users. Talks to Stalwart's JMAP
// management endpoint with the admin account over the compose network.
import { config } from '../config.js';
import { basicAuth } from '../jmap/client.js';

export function stalwartEnabled(): boolean {
  return Boolean(config.stalwartUrl && config.stalwartAdminUser && config.stalwartAdminPassword);
}

async function call(methodCalls: unknown[]): Promise<any[]> {
  if (!stalwartEnabled()) throw new Error('The bundled mail server is not enabled on this install');
  const res = await fetch(`${config.stalwartUrl}/jmap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuth(config.stalwartAdminUser, config.stalwartAdminPassword) },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Stalwart rejected the admin credentials in .env');
  if (!res.ok) throw new Error(`Stalwart returned HTTP ${res.status}`);
  const body: any = await res.json();
  const responses: any[] = body.methodResponses ?? [];
  for (const [name, args] of responses) if (name === 'error') throw new Error(`Stalwart error: ${args?.type}${args?.description ? ' - ' + args.description : ''}`);
  return responses;
}

export interface StalwartDomain { id: string; name: string }
export interface StalwartMailbox { id: string; name: string; email: string; description: string | null; aliases: string[] }

export async function health(): Promise<{ ok: boolean; error?: string }> {
  try { await call([['x:Domain/get', { ids: null, properties: ['id'] }, 'c1']]); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function listDomains(): Promise<StalwartDomain[]> {
  const [[, r]] = await call([['x:Domain/get', { ids: null, properties: ['id', 'name'] }, 'c1']]);
  return (r.list ?? []).map((d: any) => ({ id: d.id, name: d.name }));
}

export async function dnsZone(domainId: string): Promise<string> {
  const [[, r]] = await call([['x:Domain/get', { ids: [domainId], properties: ['dnsZoneFile'] }, 'c1']]);
  return r.list?.[0]?.dnsZoneFile ?? '';
}

export async function listMailboxes(): Promise<StalwartMailbox[]> {
  const [[, r]] = await call([['x:Account/get', { ids: null, properties: ['id', 'name', 'emailAddress', 'description', 'aliases'] }, 'c1']]);
  const adminLocal = config.stalwartAdminUser.split('@')[0];
  return (r.list ?? [])
    .filter((a: any) => a.emailAddress && a.name !== adminLocal && a.name !== 'admin')
    .map((a: any) => {
      // Object lists come back keyed by id ({"0": {...}}), not as arrays.
      const raw = a.aliases ?? {};
      const list: any[] = Array.isArray(raw) ? raw : Object.values(raw);
      return { id: a.id, name: a.name, email: a.emailAddress, description: a.description ?? null, aliases: list.map((x: any) => (typeof x === 'string' ? x : x?.emailAddress ?? x?.email ?? '')).filter(Boolean) };
    });
}

export async function createMailbox(input: { localPart: string; domainId: string; password: string; displayName?: string }): Promise<StalwartMailbox> {
  const local = input.localPart.trim().toLowerCase();
  if (!/^[a-z0-9._+-]{1,64}$/.test(local)) throw new Error('The address may contain letters, digits, dots, underscores, plus and dashes');
  const [[, r]] = await call([['x:Account/set', { create: { a: { '@type': 'User', name: local, domainId: input.domainId, description: input.displayName || null, credentials: { '0': { '@type': 'Password', secret: input.password } } } } }, 'c1']]);
  const created = r.created?.a;
  if (!created) {
    const err = r.notCreated?.a;
    throw new Error(err?.description ? String(err.description) : `Stalwart refused the mailbox (${err?.type ?? 'unknown error'})`);
  }
  const all = await listMailboxes();
  return all.find((m) => m.id === created.id) ?? { id: created.id, name: local, email: created.emailAddress ?? '', description: input.displayName ?? null, aliases: [] };
}

export async function setMailboxPassword(id: string, password: string): Promise<void> {
  const [[, r]] = await call([['x:Account/set', { update: { [id]: { credentials: { '0': { '@type': 'Password', secret: password } } } } }, 'c1']]);
  if (r.notUpdated?.[id]) throw new Error(r.notUpdated[id].description ?? `Could not change the password (${r.notUpdated[id].type})`);
}

export async function deleteMailbox(id: string): Promise<void> {
  const [[, r]] = await call([['x:Account/set', { destroy: [id] }, 'c1']]);
  if (r.notDestroyed?.[id]) throw new Error(r.notDestroyed[id].description ?? `Could not delete the mailbox (${r.notDestroyed[id].type})`);
}

// Strong enough for Stalwart's password policy, readable enough to type once.
export function generateMailboxPassword(): string {
  const words = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'ginger', 'harbor', 'indigo', 'juniper', 'kestrel', 'lantern', 'meadow', 'nutmeg', 'orchid', 'pepper', 'quartz', 'river', 'saffron', 'timber', 'umber', 'velvet', 'willow', 'zephyr'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${pick()}-${pick()}-${pick()}-${num}`;
}

export async function getMtaStsMode(): Promise<string> {
  // Without the explicit id Stalwart answers with an empty list (verified on
  // 0.16), which made this always report "testing" whatever was set.
  const [[, r]] = await call([['x:MtaSts/get', { ids: ['singleton'] }, 'c1']]);
  return String(r.list?.[0]?.mode ?? 'testing').toLowerCase();
}
export async function setMtaStsMode(mode: 'enforce' | 'testing' | 'disable'): Promise<void> {
  const [[, r]] = await call([['x:MtaSts/set', { update: { singleton: { mode } } }, 'c1']]);
  if (r.notUpdated?.singleton) throw new Error(r.notUpdated.singleton.description ?? 'Could not change the MTA-STS mode');
}
