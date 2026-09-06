import { Router } from 'express';
import { one, query } from '../db.js';
import { config } from '../config.js';
import { dummyHash, generateRecoveryCodes, generateTotpSecret, hashPassword, otpauthUrl, sha256hex, verifyPassword, verifyTotp } from '../crypto.js';
import { checkLoginAllowed, clearLoginFailures, clientIp, createSession, destroySession, destroyUserSessions, publicUser, recordLoginFailure, requireAuth, setSessionCookie, type UserRow } from '../auth.js';
import { listAccounts } from '../services/accounts.js';
import { syncManager } from '../workers/syncManager.js';
import { createChallenge, createDecoyChallenge, encryptStream, getUserKeys, verifyChallenge } from '../services/pgp.js';
import { parse, z } from '../util/validate.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { authSettings } from './users.js';
import { clearFailures as powClear, issueChallenge, recordFailure as powFail, verifySolution, type PowPurpose } from '../pow.js';
import { assertMailboxFree, provisionMailbox } from '../services/provision.js';

export const authRouter = Router();

const powSchema = z.object({ challenge: z.string().max(600), nonce: z.string().max(64) });

const registerSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/, 'letters, numbers, dots, dashes'),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  invite: z.string().max(200).optional(),
  pow: powSchema.optional(),
});

// Self-registration is off unless an admin opens it or hands out an invite
// link. Either way the new account gets the role the admin decided on.
authRouter.post('/register', async (req, res) => {
  const body = parse(registerSchema, req.body);
  verifySolution('register', body.username, body.pow);
  const settings = await authSettings();
  let role: 'admin' | 'member' = settings.defaultRole;
  let invite: any = null;
  if (body.invite) {
    invite = await one<any>('SELECT * FROM invites WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [body.invite]);
    if (!invite) throw badRequest('This invite link is invalid or has expired');
    role = invite.role;
  } else if (!settings.allowRegistration) {
    throw forbidden('Registration is by invitation only');
  }
  const username = body.username.toLowerCase();
  if (await one('SELECT 1 FROM users WHERE username=$1', [username])) throw badRequest('That username is taken');
  // With the bundled mail server, the username becomes the person's address;
  // an address someone already has on the server cannot be claimed here.
  await assertMailboxFree(username);
  const rows = await query<UserRow>(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`, [username, body.displayName, await hashPassword(body.password), role]);
  if (invite) await query('UPDATE invites SET used_by=$2, used_at=now() WHERE id=$1', [invite.id, rows[0].id]);
  const sid = await createSession(rows[0].id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'auth.registered',$2)`, [rows[0].id, JSON.stringify({ via: invite ? 'invite' : 'open', role })]);
  const mailbox = await provisionMailbox(rows[0]);
  res.json({ user: publicUser(rows[0]), mailbox });
});

// Step one of every sign-in or registration: a signed, single-use challenge
// whose difficulty reflects recent failures for that username. See pow.ts.
authRouter.get('/pow', (req, res) => {
  const purpose = String(req.query.purpose ?? 'login') as PowPurpose;
  if (!['login', 'register', 'setup'].includes(purpose)) throw badRequest('Unknown purpose');
  const username = String(req.query.username ?? '').slice(0, 64);
  res.setHeader('Cache-Control', 'no-store');
  res.json(issueChallenge(purpose, username));
});

authRouter.get('/invite/:token', async (req, res) => {
  const inv = await one<any>('SELECT role, note, expires_at FROM invites WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [String(req.params.token)]);
  if (!inv) throw notFound('This invite link is invalid or has expired');
  res.json({ valid: true, role: inv.role, note: inv.note, expiresAt: inv.expires_at });
});

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200), code: z.string().max(32).optional(), pgpChallengeId: z.string().max(64).optional(), pgpResponse: z.string().max(200).optional(), pow: powSchema.optional() });

// One response for "no such user", "wrong password" and "disabled", and
// bcrypt-equivalent work in every branch, so the login form cannot be used
// to enumerate usernames.
authRouter.post('/login', async (req, res) => {
  const body = parse(loginSchema, req.body);
  const username = body.username.toLowerCase().trim();
  // Throttle keys are hashed so not even the in-memory map holds a raw address.
  const key = sha256hex(`${username}|${clientIp(req)}`);
  checkLoginAllowed(key);
  verifySolution('login', username, body.pow);
  const user = await one<UserRow>('SELECT * FROM users WHERE username=$1', [username]);
  const ok = user ? await verifyPassword(body.password, user.password_hash) : (await verifyPassword(body.password, await dummyHash()), false);
  if (!ok || !user || user.disabled) {
    recordLoginFailure(key); powFail('login', username);
    throw unauthorized('Incorrect username or password');
  }
  // Second factors: an authenticator code, a recovery code, or the answer to
  // a challenge encrypted to the user's OpenPGP key. Any one of the enabled
  // methods passes. The stored private key is never released before the
  // second factor succeeds, so a leaked password does not yield the key.
  const methods: string[] = [];
  if (user.totp_enabled && user.totp_secret) methods.push('totp');
  const keys = await getUserKeys(user.id);
  if (keys.publicKey && keys.auth !== 'off') methods.push('pgp');
  if (methods.length) {
    let passed = false;
    const code = body.code?.trim();
    if (code) {
      if (methods.includes('totp') && verifyTotp(user.totp_secret!, code)) passed = true;
      const hashed = sha256hex(code.toLowerCase());
      if (!passed && user.recovery_codes.includes(hashed)) {
        passed = true;
        await query('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id=$1', [user.id, hashed]);
      }
    }
    if (!passed && body.pgpResponse && methods.includes('pgp')) passed = verifyChallenge(body.pgpChallengeId, body.pgpResponse, 'login') === user.id;
    if (!passed) {
      if (code || body.pgpResponse) { recordLoginFailure(key); powFail('login', username); throw unauthorized('That code was not accepted'); }
      const pgp = methods.includes('pgp') ? await createChallenge(user.id, keys.publicKey!, 'login') : null;
      res.json({ mfaRequired: true, methods, pgp: pgp ? { challengeId: pgp.id, challenge: pgp.armored, fingerprint: keys.fingerprint } : null });
      return;
    }
  }
  clearLoginFailures(key); powClear('login', username);
  const sid = await createSession(user.id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  res.json({ user: publicUser(user) });
});

// Sign in with the key alone. The username gets a challenge whether or not
// it exists or allows this, so the exchange reveals nothing; only a real,
// enabled account's challenge can be answered. Proof of work applies as to
// any sign-in attempt.
authRouter.post('/pgp/start', async (req, res) => {
  const b = parse(z.object({ username: z.string().min(1).max(64), pow: powSchema.optional() }), req.body);
  const username = b.username.toLowerCase().trim();
  checkLoginAllowed(sha256hex(`${username}|${clientIp(req)}`));
  verifySolution('login', username, b.pow);
  const user = await one<UserRow>('SELECT * FROM users WHERE username=$1', [username]);
  const keys = user && !user.disabled ? await getUserKeys(user.id) : null;
  const c = keys?.publicKey && keys.auth === 'passwordless' ? await createChallenge(user!.id, keys.publicKey, 'passwordless') : await createDecoyChallenge();
  res.json({ challengeId: c.id, challenge: c.armored });
});

authRouter.post('/pgp/finish', async (req, res) => {
  const b = parse(z.object({ username: z.string().min(1).max(64), challengeId: z.string().max(64), response: z.string().max(200) }), req.body);
  const username = b.username.toLowerCase().trim();
  const key = sha256hex(`${username}|${clientIp(req)}`);
  const uid = verifyChallenge(b.challengeId, b.response, 'passwordless');
  const user = uid ? await one<UserRow>('SELECT * FROM users WHERE id=$1 AND username=$2', [uid, username]) : null;
  if (!user || user.disabled) { recordLoginFailure(key); powFail('login', username); throw unauthorized('That answer was not accepted'); }
  clearLoginFailures(key); powClear('login', username);
  const sid = await createSession(user.id, req.headers['user-agent']);
  setSessionCookie(res, sid);
  await query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.pgp_login')`, [user.id]);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', async (req, res) => {
  if (req.sessionId) await destroySession(req.sessionId);
  setSessionCookie(res, null);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const accounts = await query<{ n: number }>('SELECT count(*)::int AS n FROM accounts WHERE user_id=$1', [req.user!.id]);
  const { stalwartEnabled } = await import('../services/stalwart.js');
  res.json({ user: publicUser(req.user!), accountCount: accounts[0]?.n ?? 0, version: config.version, stalwartProvisioning: stalwartEnabled() && req.user!.role === 'admin' });
});

authRouter.put('/profile', requireAuth, async (req, res) => {
  const b = parse(z.object({ displayName: z.string().min(1).max(120) }), req.body);
  const rows = await query<UserRow>(`UPDATE users SET display_name=$2 WHERE id=$1 RETURNING *`, [req.user!.id, b.displayName]);
  res.json({ user: publicUser(rows[0]) });
});

authRouter.put('/prefs', requireAuth, async (req, res) => {
  const prefs = parse(z.record(z.string(), z.unknown()), req.body);
  const rows = await query<UserRow>(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1 RETURNING *`, [req.user!.id, JSON.stringify(prefs)]);
  res.json({ user: publicUser(rows[0]) });
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const body = parse(z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }), req.body);
  if (!(await verifyPassword(body.current, req.user!.password_hash))) throw badRequest('Current password is incorrect');
  await query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [req.user!.id, await hashPassword(body.next)]);
  await destroyUserSessions(req.user!.id, req.sessionId);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.password_changed')`, [req.user!.id]);
  res.json({ ok: true });
});

// TOTP: setup stores a pending secret; enable verifies one code and turns it
// on with fresh recovery codes shown exactly once.
authRouter.post('/totp/setup', requireAuth, async (req, res) => {
  const secret = generateTotpSecret();
  await query('UPDATE users SET totp_secret=$2, totp_enabled=false WHERE id=$1', [req.user!.id, secret]);
  res.json({ secret, otpauth: otpauthUrl('Tern', req.user!.username, secret) });
});

authRouter.post('/totp/enable', requireAuth, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
  const user = await one<UserRow>('SELECT * FROM users WHERE id=$1', [req.user!.id]);
  if (!user?.totp_secret) throw badRequest('Run setup first');
  if (!verifyTotp(user.totp_secret, code)) throw badRequest('That code was not accepted. Check the time on your device.');
  const codes = generateRecoveryCodes();
  await query('UPDATE users SET totp_enabled=true, recovery_codes=$2 WHERE id=$1', [user.id, codes.map((c) => sha256hex(c.toLowerCase()))]);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.totp_enabled')`, [user.id]);
  res.json({ ok: true, recoveryCodes: codes });
});

authRouter.post('/totp/disable', requireAuth, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  await query(`UPDATE users SET totp_enabled=false, totp_secret=NULL, recovery_codes='{}' WHERE id=$1`, [req.user!.id]);
  await query(`INSERT INTO audit_log (user_id, action) VALUES ($1,'auth.totp_disabled')`, [req.user!.id]);
  res.json({ ok: true });
});

authRouter.post('/totp/recovery', requireAuth, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  if (!(await verifyPassword(password, req.user!.password_hash))) throw badRequest('Password is incorrect');
  const codes = generateRecoveryCodes();
  await query('UPDATE users SET recovery_codes=$2 WHERE id=$1 AND totp_enabled', [req.user!.id, codes.map((c) => sha256hex(c.toLowerCase()))]);
  res.json({ recoveryCodes: codes });
});

authRouter.get('/sessions', requireAuth, async (req, res) => {
  const rows = await query('SELECT id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id=$1 AND expires_at > now() ORDER BY last_seen_at DESC', [req.user!.id]);
  res.json({ sessions: rows.map((r) => ({ ...r, current: r.id === req.sessionId, id: r.id.slice(0, 8) + '…', fullId: r.id === req.sessionId ? null : r.id })) });
});

authRouter.post('/sessions/revoke', requireAuth, async (req, res) => {
  const { id, all } = parse(z.object({ id: z.string().optional(), all: z.boolean().optional() }), req.body);
  if (all) await destroyUserSessions(req.user!.id, req.sessionId);
  else if (id) await query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  res.json({ ok: true });
});


// ---------- Your data: export and delete ----------

// Everything the server holds about the signed-in person, as one JSON
// document streamed table by table (the mail cache can be large). Secrets
// are left out: password hash, TOTP secret, recovery codes, mailbox
// credentials. Attachment bytes staged for sending are transient and omitted.
const EXPORT_SECTIONS: { name: string; sql: string }[] = [
  { name: 'accounts', sql: 'SELECT id, name, email, provider, session_url, auth_type, auth_user, color, signature_html, voice, daily_cap, jitter_enabled, jitter_min_s, jitter_max_s, send_window, sync_limit, enabled, send_via, created_at FROM accounts WHERE user_id=$1' },
  { name: 'mailboxes', sql: 'SELECT m.id, m.account_id, m.jmap_id, m.name, m.parent_id, m.role, m.color FROM mailboxes m JOIN accounts a ON a.id=m.account_id WHERE a.user_id=$1' },
  { name: 'contacts', sql: 'SELECT id, email, first_name, last_name, company, title, phone, website, fields, tags, notes, source, consent_source, status, timezone, last_contacted_at, last_replied_at, created_at, updated_at FROM contacts WHERE user_id=$1' },
  { name: 'suppressions', sql: 'SELECT id, email, reason, source, created_at FROM suppressions WHERE user_id=$1' },
  { name: 'templates', sql: 'SELECT id, name, subject, body_html, category, ai_brief, description, include_signature, starred, library_key, use_count, created_at, updated_at FROM templates WHERE user_id=$1' },
  { name: 'sequences', sql: 'SELECT id, account_id, name, description, status, stop_on_reply, ai_mode, unsubscribe_footer, created_at, updated_at FROM sequences WHERE user_id=$1' },
  { name: 'sequence_steps', sql: 'SELECT st.id, st.sequence_id, st.position, st.kind, st.template_id, st.subject, st.body_html, st.wait_days, st.wait_hours, st.ai_personalize, st.ai_instructions, st.reply_in_thread FROM sequence_steps st JOIN sequences s ON s.id=st.sequence_id WHERE s.user_id=$1' },
  { name: 'enrollments', sql: 'SELECT e.id, e.sequence_id, e.contact_id, e.account_id, e.status, e.current_step, e.next_run_at, e.thread_id, e.last_message_id, e.last_subject, e.error, e.created_at, e.updated_at, e.finished_at FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE s.user_id=$1' },
  { name: 'send_log', sql: 'SELECT id, account_id, contact_id, sequence_id, step_id, enrollment_id, responder_id, template_id, message_id, jmap_email_id, thread_id, to_email, subject, kind, status, error, sent_at, replied_at, bounced_at FROM send_log WHERE user_id=$1' },
  { name: 'review_queue', sql: 'SELECT id, kind, enrollment_id, account_id, contact_id, step_id, responder_id, reply_to_email_id, thread_id, to_addr, subject, body_html, context, ai_model, status, created_at, decided_at FROM review_queue WHERE user_id=$1' },
  { name: 'rules', sql: 'SELECT id, account_id, name, enabled, match, conditions, actions, position, hits, created_at, updated_at FROM rules WHERE user_id=$1' },
  { name: 'responders', sql: 'SELECT id, account_id, name, enabled, mode, match, conditions, only_contacts, skip_lists, instructions, tone, length, reply_all, humanize, daily_cap, cooldown_hours, position, hits, created_at, updated_at FROM responders WHERE user_id=$1' },
  { name: 'drafts', sql: 'SELECT id, account_id, kind, reply_to_email_id, thread_id, to_addr, cc_addr, bcc_addr, subject, body_html, attachment_ids, source, responder_id, created_at, updated_at FROM drafts WHERE user_id=$1' },
  { name: 'outbox', sql: 'SELECT id, account_id, payload, send_at, status, error, attempts, created_at, sent_at FROM outbox WHERE user_id=$1' },
  { name: 'snoozes', sql: 'SELECT id, account_id, thread_id, until_at, restored, created_at FROM snoozes WHERE user_id=$1' },
  { name: 'ai_jobs', sql: 'SELECT id, kind, payload, status, attempts, error, result, created_at, updated_at FROM ai_jobs WHERE user_id=$1' },
  { name: 'uploads', sql: 'SELECT id, filename, content_type, size, created_at FROM uploads WHERE user_id=$1' },
  { name: 'sessions', sql: "SELECT left(id, 8) || '…' AS id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id=$1" },
  { name: 'audit_log', sql: 'SELECT id, action, target, details, created_at FROM audit_log WHERE user_id=$1' },
  { name: 'invites_created', sql: 'SELECT id, role, note, expires_at, used_at, created_at FROM invites WHERE created_by=$1' },
  { name: 'emails', sql: 'SELECT e.id, e.account_id, e.jmap_id, e.thread_id, e.mailbox_ids, e.keywords, e.size, e.received_at, e.sent_at, e.message_id, e.in_reply_to, e.references_ids, e.from_addr, e.to_addr, e.cc_addr, e.bcc_addr, e.reply_to, e.subject, e.preview, e.has_attachment, e.body_text, e.body_html, e.attachments FROM emails e JOIN accounts a ON a.id=e.account_id WHERE a.user_id=$1' },
];

async function* exportChunks(uid: number, user: UserRow): AsyncGenerator<string> {
  const avatar = await one<{ avatar: Buffer | null; avatar_type: string | null }>('SELECT avatar, avatar_type FROM users WHERE id=$1', [uid]);
  const profile = { ...publicUser(user), avatar: avatar?.avatar ? `data:${avatar.avatar_type};base64,${avatar.avatar.toString('base64')}` : null };
  yield `{"format":"tern-export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"note":"Everything this server stores about you. Mailbox passwords, your password hash, two-factor secrets, recovery codes and your private key are never exported.","user":${JSON.stringify(profile)}`;
  for (const section of EXPORT_SECTIONS) {
    yield `,\n${JSON.stringify(section.name)}:[`;
    let last = 0, first = true;
    for (;;) {
      const rows = await query<any>(`SELECT * FROM (${section.sql}) t WHERE (t.id::text ~ '^[0-9]+$' AND t.id::bigint > $2) OR t.id::text !~ '^[0-9]+$' ORDER BY 1 LIMIT 500`, [uid, last]);
      if (!rows.length) break;
      yield (first ? '' : ',') + rows.map((r) => JSON.stringify(r)).join(',');
      first = false;
      const numeric = rows.filter((r) => /^[0-9]+$/.test(String(r.id)));
      if (numeric.length < rows.length || rows.length < 500) break;
      last = Math.max(...numeric.map((r) => Number(r.id)));
    }
    yield ']';
  }
  yield '\n}\n';
}

// `?pgp=1` encrypts the file to the user's OpenPGP key on the way out, so an
// export made on a shared machine is readable only where the key is.
authRouter.get('/export', requireAuth, async (req, res) => {
  const uid = req.user!.id;
  const stamp = new Date().toISOString().slice(0, 10);
  const write = (chunk: string) => new Promise<void>((resolve) => { if (res.write(chunk)) resolve(); else res.once('drain', () => resolve()); });
  res.setHeader('Cache-Control', 'no-store');
  const wantPgp = String(req.query.pgp ?? '') === '1';
  if (wantPgp) {
    const keys = await getUserKeys(uid);
    if (!keys.publicKey) throw badRequest('Add an OpenPGP key first to download an encrypted export');
    res.setHeader('Content-Type', 'application/pgp-encrypted; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tern-export-${req.user!.username}-${stamp}.json.asc"`);
    const source = ReadableStream.from(exportChunks(uid, req.user!)) as ReadableStream<string>;
    const encrypted = await encryptStream(source, [keys.publicKey]);
    for await (const chunk of encrypted as any) await write(String(chunk));
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tern-export-${req.user!.username}-${stamp}.json"`);
    for await (const chunk of exportChunks(uid, req.user!)) await write(chunk);
  }
  res.end();
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'auth.data_exported',$2)`, [uid, JSON.stringify({ encrypted: wantPgp })]);
});

// Deleting the account removes the person and, through foreign keys, every
// row that belongs to them: mailboxes and the cached mail, contacts,
// sequences, templates, drafts, logs. Their earlier audit entries stay for
// accountability but lose their details. Nothing changes on the mail server.
authRouter.post('/delete-account', requireAuth, async (req, res) => {
  const b = parse(z.object({ password: z.string().min(1), code: z.string().max(32).optional(), confirm: z.string().max(64) }), req.body);
  const me = req.user!;
  if (b.confirm.trim().toLowerCase() !== me.username.toLowerCase()) throw badRequest('Type your username to confirm');
  if (!(await verifyPassword(b.password, me.password_hash))) throw badRequest('Password is incorrect');
  if (me.totp_enabled && me.totp_secret) {
    const code = (b.code ?? '').trim();
    const ok = verifyTotp(me.totp_secret, code) || me.recovery_codes.includes(sha256hex(code.toLowerCase()));
    if (!ok) throw badRequest('Two-factor code is required');
  }
  if (me.role === 'admin') {
    const others = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role='admin' AND NOT disabled AND id <> $1`, [me.id]);
    if (!others?.n) throw badRequest('You are the only admin. Make someone else an admin before deleting your account.');
  }
  const accounts = await listAccounts(me.id);
  for (const a of accounts) syncManager.remove(a.id);
  await query(`UPDATE audit_log SET details='{}'::jsonb, target=NULL WHERE user_id=$1`, [me.id]);
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES (NULL,'auth.account_deleted',$1)`, [JSON.stringify({ role: me.role, accounts: accounts.length })]);
  await query('DELETE FROM users WHERE id=$1', [me.id]);
  setSessionCookie(res, null);
  res.json({ ok: true });
});
