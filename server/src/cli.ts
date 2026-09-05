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
      if (!username || !password) throw new Error('usage: create-user --username U --password P [--name N] [--role admin|member]');
      if (password.length < 10) throw new Error('password must be at least 10 characters');
      const existing = await query('SELECT id FROM users WHERE username=$1', [username]);
      if (existing.length) {
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
      console.log('commands: migrate | create-user | set-password | disable-totp | list-users | stats');
  }
  await pool.end();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
