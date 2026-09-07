// Operator commands, run inside the container: create the first admin from
// install.sh, reset a password, list users. Every command applies pending
// migrations first so it works before the server has ever started.
import { migrate, pool, query, waitForDb } from './db.js';
import { hashPassword } from './crypto.js';
import { destroyUserSessions } from './auth.js';
import { passwordProblem } from './util/password.js';

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
      { const problem = passwordProblem(password, username); if (problem) throw new Error(problem); }
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
      { const problem = passwordProblem(password, username); if (problem) throw new Error(problem); }
      const rows = await query<{ id: number }>('UPDATE users SET password_hash=$2, password_changed_at=now(), disabled=false WHERE username=$1 RETURNING id', [username, await hashPassword(password)]);
      if (!rows.length) throw new Error('no such user');
      await destroyUserSessions(rows[0].id);
      console.log('password updated; all sessions signed out');
      break;
    }
    case 'disable-totp': {
      const username = arg('username')?.toLowerCase();
      if (!username) throw new Error('usage: disable-totp --username U');
      await query(`UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL, recovery_codes='{}' WHERE username=$1`, [username]);
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
    // What each connected mailbox is actually talking to. api_url is the
    // endpoint cached from the last session fetch, and the usual reason a
    // mailbox sits on an error that restarting the app did not clear.
    // --reconnect drops it so the next sync fetches the session again.
    case 'accounts': {
      const target = arg('reconnect');
      if (target) {
        const all = target === 'all';
        const rows = await query<{ email: string }>(
          `UPDATE accounts SET api_url=NULL, sync_status='idle', sync_error=NULL
             WHERE ${all ? 'true' : '(id::text=$1 OR lower(email)=lower($1))'} RETURNING email`,
          all ? [] : [target],
        );
        if (!rows.length) throw new Error(`no account matching '${target}'`);
        console.log(`reconnecting ${rows.map((r) => r.email).join(', ')}: the next sync fetches the session again`);
        break;
      }
      const rows = await query(`SELECT id, email, provider, session_url, api_url, sync_status, left(sync_error, 60) AS sync_error, last_sync_at FROM accounts ORDER BY id`);
      console.table(rows);
      break;
    }
    case 'list-users': {
      const rows = await query('SELECT id, username, display_name, role, disabled, totp_enabled, last_login_at FROM users ORDER BY id');
      console.table(rows);
      break;
    }
    // How many requests Ollama should serve at once: one per person who can
    // sign in, as far as the memory limit allows. ./bin/tern ai-slots reads
    // --quiet and writes the answer into .env.
    case 'ai-slots': {
      const { getAiSettings, listModels, modelKvBytesPerToken } = await import('./ai/llm.js');
      const { slotAdvice } = await import('./ai/slots.js');
      const { config } = await import('./config.js');
      const s = await getAiSettings();
      const users = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE NOT disabled`))[0]?.n ?? 1;
      let models: Awaited<ReturnType<typeof listModels>> = [];
      try { models = await listModels(); } catch { /* Ollama down: the advice is then people-only */ }
      const kvPerToken = s.provider === 'ollama' ? await modelKvBytesPerToken(s.baseUrl, s.model).catch(() => null) : null;
      const modelBytes = models.find((m) => m.name === s.model || m.name === `${s.model}:latest`)?.size ?? 0;
      const a = slotAdvice({ users, configured: config.ollamaNumParallel, numCtx: s.numCtx, kvPerToken, modelBytes, memBudgetBytes: config.ollamaMemLimitBytes });
      if (process.argv.includes('--quiet')) { console.log(a.recommended); break; }
      const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`;
      console.log(`Users who can sign in: ${a.users}`);
      console.log(`OLLAMA_NUM_PARALLEL now: ${a.configured}${a.enough ? ' (a slot each)' : ` (${a.users - a.configured} more people than slots)`}`);
      if (a.perSlotBytes) console.log(`One slot holds ${s.numCtx} tokens of ${config.ollamaKvCacheType} KV cache: ${mb(a.perSlotBytes)}`);
      if (a.affordable !== null) console.log(`Ollama's memory limit pays for about ${a.affordable} slot(s) beside ${s.model}`);
      if (a.memoryBound) console.log('Memory, not the setting, is what stops everyone having a slot: raise OLLAMA_MEM_LIMIT, lower the context window, or use a smaller model.');
      console.log(`Recommended: ${a.recommended}`);
      break;
    }
    case 'stats': {
      const r = await query(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM emails) AS emails, (SELECT count(*) FROM contacts) AS contacts, (SELECT count(*) FROM send_log WHERE status='sent') AS sent`);
      console.table(r);
      break;
    }
    // The scheduler encrypts an existing cache in the background anyway; this
    // is for doing it now, before handing a machine over or taking a backup
    // that is meant to be unreadable without .env.
    case 'encrypt-cache': {
      const { backfillAll, backfillPending } = await import('./services/backfill.js');
      const pending = await backfillPending();
      if (!pending) { console.log('The mail cache is already encrypted.'); break; }
      console.log(`Encrypting ${pending} messages. Back up .env with the database: without ENCRYPTION_KEY this mail cannot be read.`);
      let last = Date.now();
      const total = await backfillAll((p) => {
        if (Date.now() - last > 2000) { console.log(`  ${p.remaining} to go`); last = Date.now(); }
      });
      console.log(`Encrypted ${total} messages.`);
      break;
    }
    case 'encryption-status': {
      const r = await query(`SELECT (SELECT count(*) FROM emails WHERE sealed) AS encrypted, (SELECT count(*) FROM emails WHERE NOT sealed) AS plaintext, (SELECT count(*) FROM users WHERE dek_wrapped IS NOT NULL) AS users_with_keys`);
      console.table(r);
      break;
    }
    default:
      console.log('commands: migrate | create-user | set-password | disable-totp | list-users | accounts [--reconnect ID|EMAIL|all] | add-mailbox | dns-check | ai-slots | stats | encrypt-cache | encryption-status');
  }
  await pool.end();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
