// Mailbox provisioning on the bundled Stalwart. Admin only: creating a
// mailbox creates a real account on the mail server, optionally a Tern login
// for the same person, and connects the two.
import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth, type UserRow } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { config } from '../config.js';
import * as sw from '../services/stalwart.js';
import { connectAccount, encryptSecret, type AccountRow } from '../services/accounts.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { assertPasswordOk } from '../util/password.js';
import { syncManager } from '../workers/syncManager.js';
import { jmapErrorMessage } from '../jmap/client.js';
import { buildRecords, checkAll, checkOutbound25, detectServerIp, type DnsRecord } from '../services/dnsCheck.js';
import { getBrand } from '../services/brand.js';
import { bimiUrlFor } from './brand.js';

export const stalwartRouter = Router();
stalwartRouter.use(requireAuth);

stalwartRouter.get('/', requireAdmin, async (_req, res) => {
  if (!sw.stalwartEnabled()) { res.json({ enabled: false }); return; }
  const health = await sw.health();
  if (!health.ok) { res.json({ enabled: true, host: config.stalwartHost, domain: config.stalwartDomain, reachable: false, error: health.error, domains: [], mailboxes: [], dns: '' }); return; }
  const domains = await sw.listDomains();
  const mailboxes = await sw.listMailboxes();
  const connected = await query<{ email: string; user_id: number; username: string; account_id: number }>(`SELECT a.email, a.user_id, u.username, a.id AS account_id FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.provider='stalwart'`);
  const primary = domains.find((d) => d.name === config.stalwartDomain) ?? domains[0];
  const dns = primary ? await sw.dnsZone(primary.id) : '';
  res.json({
    enabled: true, host: config.stalwartHost, domain: config.stalwartDomain, reachable: true, adminUrl: config.stalwartHost ? `https://${config.stalwartHost}/admin` : null,
    domains, dns,
    mailboxes: mailboxes.map((m) => ({ ...m, connections: connected.filter((c) => c.email.toLowerCase() === m.email.toLowerCase()).map((c) => ({ userId: c.user_id, username: c.username, accountId: c.account_id })) })),
  });
});

const createSchema = z.object({
  localPart: z.string().min(1).max(64),
  domainId: z.string().min(1),
  password: z.string().min(12).max(200).optional(),
  displayName: z.string().max(120).default(''),
  connect: z.enum(['none', 'me', 'user', 'new']).default('none'),
  userId: z.number().int().optional(),
  newUser: z.object({ username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/), password: z.string().min(10).max(200), displayName: z.string().min(1).max(120), role: z.enum(['admin', 'member']).default('member') }).optional(),
});

async function connectMailbox(user: UserRow, email: string, password: string, displayName: string): Promise<AccountRow> {
  const rows = await query<AccountRow>(
    `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_user, auth_secret_enc, pin_origin, color)
     VALUES ($1,$2,$3,'stalwart',$4,'basic',$3,$5,true,$6)
     ON CONFLICT (user_id, email) DO UPDATE SET auth_secret_enc=EXCLUDED.auth_secret_enc, api_url=NULL, sync_status='idle', sync_error=NULL RETURNING *`,
    [user.id, displayName || email.split('@')[0], email.toLowerCase(), `${config.stalwartUrl}/.well-known/jmap`, encryptSecret(password), '#2fa572'],
  );
  const acc = rows[0];
  await connectAccount(acc);
  syncManager.add(acc.id);
  return acc;
}

stalwartRouter.post('/mailboxes', requireAdmin, async (req, res) => {
  const b = parse(createSchema, req.body);
  const domains = await sw.listDomains();
  const domain = domains.find((d) => d.id === b.domainId);
  if (!domain) throw badRequest('Unknown domain');
  const password = b.password ?? sw.generateMailboxPassword();
  let newUser: UserRow | null = null;
  if (b.connect === 'new') {
    if (!b.newUser) throw badRequest('New user details are required');
    assertPasswordOk(b.newUser.password, b.newUser.username);
    if (await one('SELECT 1 FROM users WHERE username=$1', [b.newUser.username.toLowerCase()])) throw badRequest('That username is taken');
  }
  if (b.connect === 'user' && !b.userId) throw badRequest('Choose a user');
  const mailbox = await sw.createMailbox({ localPart: b.localPart, domainId: b.domainId, password, displayName: b.displayName });
  const email = mailbox.email || `${b.localPart.toLowerCase()}@${domain.name}`;
  let account: AccountRow | null = null;
  let connectError: string | null = null;
  try {
    if (b.connect === 'new' && b.newUser) {
      const rows = await query<UserRow>(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`, [b.newUser.username.toLowerCase(), b.newUser.displayName, await hashPassword(b.newUser.password), b.newUser.role]);
      newUser = rows[0];
      account = await connectMailbox(newUser, email, password, b.displayName || b.newUser.displayName);
    } else if (b.connect === 'me') {
      account = await connectMailbox(req.user!, email, password, b.displayName);
    } else if (b.connect === 'user') {
      const u = await one<UserRow>('SELECT * FROM users WHERE id=$1', [b.userId]);
      if (!u) throw notFound('User not found');
      account = await connectMailbox(u, email, password, b.displayName);
    }
  } catch (e) {
    connectError = jmapErrorMessage(e);
  }
  await query(`INSERT INTO audit_log (user_id, action, target, details) VALUES ($1,'stalwart.mailbox_created',$2,$3)`, [req.user!.id, email, JSON.stringify({ connect: b.connect, newUser: newUser?.username ?? null })]);
  res.json({ mailbox: { ...mailbox, email }, password: b.password ? null : password, account: account ? { id: account.id, user_id: account.user_id } : null, user: newUser ? { id: newUser.id, username: newUser.username } : null, connectError });
});

stalwartRouter.post('/mailboxes/:id/password', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const b = parse(z.object({ password: z.string().min(12).max(200).optional() }), req.body ?? {});
  const mailboxes = await sw.listMailboxes();
  const m = mailboxes.find((x) => x.id === id);
  if (!m) throw notFound('Mailbox not found');
  const password = b.password ?? sw.generateMailboxPassword();
  await sw.setMailboxPassword(id, password);
  // Keep every Tern account that uses this mailbox working.
  const updated = await query<{ id: number }>(`UPDATE accounts SET auth_secret_enc=$2, api_url=NULL, sync_status='idle', sync_error=NULL WHERE provider='stalwart' AND lower(email)=lower($1) RETURNING id`, [m.email, encryptSecret(password)]);
  for (const a of updated) await syncManager.refresh(a.id);
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'stalwart.mailbox_password_reset',$2)`, [req.user!.id, m.email]);
  res.json({ ok: true, password: b.password ? null : password, updatedAccounts: updated.length });
});

stalwartRouter.delete('/mailboxes/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const mailboxes = await sw.listMailboxes();
  const m = mailboxes.find((x) => x.id === id);
  if (!m) throw notFound('Mailbox not found');
  await sw.deleteMailbox(id);
  const accounts = await query<{ id: number }>(`DELETE FROM accounts WHERE provider='stalwart' AND lower(email)=lower($1) RETURNING id`, [m.email]);
  for (const a of accounts) syncManager.remove(a.id);
  await query(`INSERT INTO audit_log (user_id, action, target) VALUES ($1,'stalwart.mailbox_deleted',$2)`, [req.user!.id, m.email]);
  res.json({ ok: true, removedAccounts: accounts.length });
});


// ---------- Guided DNS setup ----------

async function expectedRecords(): Promise<{ domain: string; mailHost: string; records: DnsRecord[]; serverIp: string | null; bimiUrl: string | null }> {
  const domains = await sw.listDomains();
  const primary = domains.find((d) => d.name === config.stalwartDomain) ?? domains[0];
  if (!primary) throw badRequest('The mail server has no domain yet');
  const zone = await sw.dnsZone(primary.id);
  const brand = await getBrand(primary.name);
  const bimiUrl = brand ? bimiUrlFor(primary.name) : null;
  const serverIp = detectServerIp();
  return { domain: primary.name, mailHost: config.stalwartHost, records: buildRecords({ zone, domain: primary.name, mailHost: config.stalwartHost, serverIp, bimiUrl, vmcUrl: brand?.vmc_url || null }), serverIp, bimiUrl };
}

stalwartRouter.get('/dns', requireAdmin, async (_req, res) => {
  const r = await expectedRecords();
  res.json({ ...r, zone: r.records.filter((x) => x.type !== 'PTR').map((x) => x.type === 'A' ? `${x.name}.\tIN\tA\t${x.value}` : x.type === 'MX' ? `${x.name}.\tIN\tMX\t${x.priority} ${x.value}.` : x.type === 'SRV' ? `${x.name}.\tIN\tSRV\t${x.srv!.priority} ${x.srv!.weight} ${x.srv!.port} ${x.value}.` : x.type === 'CNAME' ? `${x.name}.\tIN\tCNAME\t${x.value}.` : `${x.name}.\tIN\tTXT\t"${x.value.replace(/"/g, '\\"')}"`).join('\n') });
});

// Live verification from this server's resolver. Optional `records` lets
// the UI re-check a single edited record; `port25` adds the outbound test.
stalwartRouter.post('/dns/check', requireAdmin, async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string()).optional(), port25: z.boolean().default(false) }), req.body ?? {});
  const r = await expectedRecords();
  const targets = b.ids?.length ? r.records.filter((x) => b.ids!.includes(x.id)) : r.records;
  const results = await checkAll(targets, r.serverIp);
  const outbound = b.port25 ? await checkOutbound25() : null;
  const required = r.records.filter((x) => x.group === 'required');
  const okCount = results.filter((x) => x.status === 'ok').length;
  const requiredOk = required.every((x) => results.find((y) => y.id === x.id)?.status === 'ok');
  res.json({ results, outbound, summary: { checked: results.length, ok: okCount, requiredOk } });
});

const mtaStsSchema = z.object({ mode: z.enum(['enforce', 'testing', 'disable']) });
stalwartRouter.post('/mta-sts', requireAdmin, async (req, res) => {
  const { mode } = parse(mtaStsSchema, req.body);
  await sw.setMtaStsMode(mode);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'stalwart.mta_sts',$2)`, [req.user!.id, JSON.stringify({ mode })]);
  res.json({ ok: true, mode });
});
stalwartRouter.get('/mta-sts', requireAdmin, async (_req, res) => {
  res.json({ mode: await sw.getMtaStsMode() });
});

// The admin login for the mail server's own panel. Only admins, only on
// request, only after re-entering the Tern password, and audit-logged: it
// is the master key to the mail system.
stalwartRouter.post('/admin-access', requireAdmin, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body ?? {});
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Your Tern password is incorrect');
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'stalwart.admin_credentials_viewed')`, [req.user!.id]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: config.stalwartHost ? `https://${config.stalwartHost}/admin` : null, localUrl: 'http://127.0.0.1:8080/admin (over an SSH tunnel)', username: config.stalwartAdminUser, password: config.stalwartAdminPassword });
});
