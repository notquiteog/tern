// Operator commands, run inside the container: create the first admin from
// install.sh, reset a password, list users. Every command applies pending
// migrations first so it works before the server has ever started.
import { migrate, pool, query, waitForDb } from './db.js';
import { hashPassword } from './crypto.js';
import { destroyUserSessions } from './auth.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  await waitForDb();
  await migrate();
  switch (cmd) {
    case 'migrate':
      console.log('migrations applied');
      break;
    case 'create-user': {
      const username = arg('username')?.toLowerCase();
      const password = arg('password') ?? process.env.TERN_ADMIN_PASSWORD;
      const name = arg('name') ?? username;
      const role = arg('role') ?? 'admin';
      if (!username || !password) throw new Error('usage: create-user --username U --password P [--name N] [--role admin|member] [--if-missing]');
      if (password.length < 10) throw new Error('password must be at least 10 characters');
      const existing = await query('SELECT id FROM users WHERE username=$1', [username]);
      if (existing.length && process.argv.includes('--if-missing')) {
        // install.sh re-runs: keep the existing user and password untouched.
        console.log(`exists ${username}`);
      } else if (existing.length) {
        await query('UPDATE users SET password_hash=$2, role=$3, display_name=$4, disabled=false WHERE username=$1', [username, await hashPassword(password), role, name]);
        console.log(`updated existing user ${username}`);
      } else {
        await query('INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4)', [username, name, await hashPassword(password), role]);
        console.log(`created ${role} ${username}`);
      }
      break;
    }
    case 'set-password': {
      const username = arg('username')?.toLowerCase();
      const password = arg('password');
      if (!username || !password) throw new Error('usage: set-password --username U --password P');
      const rows = await query<{ id: number }>('UPDATE users SET password_hash=$2, password_changed_at=now(), disabled=false WHERE username=$1 RETURNING id', [username, await hashPassword(password)]);
      if (!rows.length) throw new Error('no such user');
      await destroyUserSessions(rows[0].id);
      console.log('password updated; all sessions signed out');
      break;
    }
    case 'disable-totp': {
      const username = arg('username')?.toLowerCase();
      if (!username) throw new Error('usage: disable-totp --username U');
      await query(`UPDATE users SET totp_enabled=false, totp_secret=NULL, recovery_codes='{}' WHERE username=$1`, [username]);
      console.log('two-factor disabled');
      break;
    }
    case 'add-mailbox': {
      // tern-cli add-mailbox --address sam@team.example.com [--password P] [--name "Sam"] [--user alice]
      const sw = await import('./services/stalwart.js');
      const { connectAccount, encryptSecret } = await import('./services/accounts.js');
      const { config } = await import('./config.js');
      const address = arg('address')?.toLowerCase();
      if (!address?.includes('@')) throw new Error('usage: add-mailbox --address user@domain [--password P] [--name N] [--user tern-username]');
      const [local, domainName] = address.split('@');
      const domains = await sw.listDomains();
      const domain = domains.find((d) => d.name === domainName);
      if (!domain) throw new Error(`domain ${domainName} is not on the mail server (have: ${domains.map((d) => d.name).join(', ')})`);
      const password = arg('password') ?? sw.generateMailboxPassword();
      const mailbox = await sw.createMailbox({ localPart: local, domainId: domain.id, password, displayName: arg('name') ?? '' });
      console.log(`created mailbox ${mailbox.email}`);
      if (!arg('password')) console.log(`password: ${password}`);
      const username = arg('user')?.toLowerCase();
      if (username) {
        const u = await query<{ id: number }>('SELECT id FROM users WHERE username=$1', [username]);
        if (!u.length) throw new Error(`no Tern user ${username}`);
        const rows = await query<any>(
          `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_user, auth_secret_enc, pin_origin) VALUES ($1,$2,$3,'stalwart',$4,'basic',$3,$5,true)
           ON CONFLICT (user_id, email) DO UPDATE SET auth_secret_enc=EXCLUDED.auth_secret_enc, api_url=NULL RETURNING *`,
          [u[0].id, arg('name') ?? local, mailbox.email, `${config.stalwartUrl}/.well-known/jmap`, encryptSecret(password)],
        );
        await connectAccount(rows[0]);
        console.log(`connected to Tern user ${username}; it will sync when the server is running`);
      }
      break;
    }
    case 'dns-check': {
      // tern-cli dns-check [--port25]   prints every record with its live status
      const sw = await import('./services/stalwart.js');
      const { buildRecords, checkAll, checkOutbound25, detectServerIp } = await import('./services/dnsCheck.js');
      const { getBrand } = await import('./services/brand.js');
      const { config } = await import('./config.js');
      if (!sw.stalwartEnabled()) throw new Error('the bundled mail server is not enabled');
      const domains = await sw.listDomains();
      const primary = domains.find((d) => d.name === config.stalwartDomain) ?? domains[0];
      if (!primary) throw new Error('no domain on the mail server');
      const brand = await getBrand(primary.name);
      const records = buildRecords({ zone: await sw.dnsZone(primary.id), domain: primary.name, mailHost: config.stalwartHost, serverIp: detectServerIp(), bimiUrl: brand ? `${config.appUrl}/bimi/${primary.name}.svg` : null, vmcUrl: brand?.vmc_url || null });
      const results = await checkAll(records, detectServerIp());
      const icon: Record<string, string> = { ok: 'OK ', missing: 'MISSING', mismatch: 'DIFFERS', error: 'ERROR', skipped: 'SKIP' };
      for (const r of records) {
        const c = results.find((x) => x.id === r.id)!;
        const val = r.type === 'MX' ? `${r.priority} ${r.value}` : r.type === 'SRV' ? `${r.srv!.priority} ${r.srv!.weight} ${r.srv!.port} ${r.value}` : r.value;
        console.log(`${icon[c.status].padEnd(8)} ${r.group.padEnd(12)} ${r.type.padEnd(6)} ${r.name}`);
        console.log(`         want: ${val.length > 110 ? val.slice(0, 107) + '...' : val}`);
        if (c.found.length && c.status !== 'ok') console.log(`         found: ${c.found.join(' | ').slice(0, 160)}`);
        if (c.note) console.log(`         note: ${c.note}`);
      }
      if (process.argv.includes('--port25')) { const o = await checkOutbound25(); console.log(`\n${o.ok ? 'OK ' : 'FAIL'}     outbound port 25: ${o.note}`); }
      const required = records.filter((r) => r.group === 'required');
      const bad = required.filter((r) => results.find((x) => x.id === r.id)?.status !== 'ok');
      console.log(bad.length ? `\n${bad.length} required record(s) still missing or wrong.` : '\nAll required records are in place.');
      break;
    }
    case 'list-users': {
      const rows = await query('SELECT id, username, display_name, role, disabled, totp_enabled, last_login_at FROM users ORDER BY id');
      console.table(rows);
      break;
    }
    case 'stats': {
      const r = await query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM emails) AS emails, (SELECT count(*) FROM contacts) AS contacts, (SELECT count(*) FROM send_log WHERE status='sent') AS sent`);
      console.table(r);
      break;
    }
    default:
      console.log('commands: migrate | create-user | set-password | disable-totp | list-users | add-mailbox | dns-check | stats');
  }
  await pool.end();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
