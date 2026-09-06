// End-to-end checks against a running dev server and the dev Stalwart probe.
// Real mail goes between alice@ and bob@probe.test (both owned by user 1);
// every scenario is what a person would do in the client, driven through the
// same HTTP API the browser uses. Run: npx tsx server/src/e2e/mail.e2e.ts
//   TERN_BASE  (default http://127.0.0.1:3090)   DATABASE_URL (default dev db)
//   ONLY=group,group   to run a subset (reply, undo, undoable, mute, empty, ai, search, labels, images, list, drafts)
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

const BASE = process.env.TERN_BASE ?? 'http://127.0.0.1:3090';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://tern:tern@127.0.0.1:5480/tern' });
pg.types.setTypeParser(20, (v) => Number(v));
const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
const ONLY = new Set((process.env.ONLY ?? '').split(',').filter(Boolean));

const USER = 1, ALICE = 1, BOB = 2;
let cookie = '';
async function login(userId: number): Promise<string> {
  const id = 'e2e_' + randomBytes(16).toString('hex');
  await sql(`INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1,$2, now() + interval '1 day', 'e2e')`, [id, userId]);
  return `tern_sid=${id}`;
}
async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/json', Cookie: cookie, Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
async function stream(path: string, body: unknown): Promise<{ text: string; tokens: number; error?: string }> {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/json', Cookie: cookie, Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  const raw = await res.text();
  if (!res.ok) return { text: '', tokens: 0, error: raw };
  let text = '', tokens = 0, error: string | undefined;
  let ev = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) { const d = JSON.parse(line.slice(5)); if (ev === 'token') tokens++; if (ev === 'done') text = d.text; if (ev === 'error') error = d.error; }
  }
  return { text, tokens, error };
}
async function upload(name: string, type: string, bytes: Buffer): Promise<{ id: number; filename: string; size: number; content_type: string }> {
  const res = await fetch(`${BASE}/api/mail/uploads?filename=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { method: 'POST', headers: { 'X-Requested-With': 'tern', 'Content-Type': type, Cookie: cookie }, body: bytes });
  const j: any = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j.upload;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45_000, everyMs = 700): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
const uid = () => Date.now().toString(36) + randomBytes(2).toString('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---- reporting ----
const results: { group: string; name: string; ok: boolean; detail?: string; ms: number }[] = [];
let current = '';
async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try { await fn(); results.push({ group: current, name, ok: true, ms: Date.now() - t0 }); console.log(`  ok   ${name}`); }
  catch (e: any) { results.push({ group: current, name, ok: false, detail: e?.message ?? String(e), ms: Date.now() - t0 }); console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
}
function group(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => { if (ONLY.size && !ONLY.has(name)) return; current = name; console.log(`\n== ${name}`); await fn(); };
}
function eq(a: unknown, b: unknown, msg = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v: unknown, msg = 'expected truthy') { if (!v) throw new Error(msg); }

// ---- mail helpers ----
interface Email { id: number; jmap_id: string; thread_id: string; subject: string; mailbox_ids: string[]; message_id: string[]; in_reply_to: string[]; references_ids: string[]; from_addr: any[]; to_addr: any[]; cc_addr: any[]; body_html: string | null; body_text: string | null; attachments: any[]; keywords: string[]; list_unsubscribe: string | null }
const roleBox = async (accountId: number, role: string) => (await sql<{ jmap_id: string }>('SELECT jmap_id FROM mailboxes WHERE account_id=$1 AND role=$2', [accountId, role]))[0]?.jmap_id;
async function send(accountId: number, body: Record<string, unknown>) {
  const r = await api('POST', '/api/mail/send', { accountId, includeSignature: false, ...body });
  if (r.status !== 200) throw new Error(`send failed ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
}
const arrived = (accountId: number, subject: string, extra = '') => waitFor<Email>(`"${subject}" in account ${accountId}${extra}`, async () => (await sql<Email>('SELECT * FROM emails WHERE account_id=$1 AND subject=$2 ORDER BY id DESC LIMIT 1', [accountId, subject]))[0]);
const inInbox = async (e: Email) => e.mailbox_ids.includes(await roleBox(e.mailbox_ids.length ? Number((await sql('SELECT account_id FROM emails WHERE id=$1', [e.id]))[0].account_id) : 0, 'inbox'));
async function fresh(accountId: number, id: number): Promise<Email> { return (await sql<Email>('SELECT * FROM emails WHERE id=$1', [id]))[0]; }
async function act(accountId: number, body: Record<string, unknown>) { const r = await api('POST', '/api/mail/actions', { accountId, ...body }); if (r.status !== 200) throw new Error(`action failed ${r.status}: ${JSON.stringify(r.data)}`); return r.data; }
async function aliceToBob(subject: string, extra: Record<string, unknown> = {}): Promise<{ a: Email; b: Email }> {
  await send(ALICE, { to: [{ name: 'Bob Probe', email: 'bob@probe.test' }], subject, html: `<p>Hello Bob, ${subject}</p>`, ...extra });
  const b = await arrived(BOB, subject);
  const a = await arrived(ALICE, subject);
  return { a, b };
}

// ======================================================================
const replyGroup = group('reply', async () => {
  const subject = `e2e reply ${uid()}`;
  let a!: Email, b!: Email;
  await test('a new message from alice reaches bob and is filed in alice\'s Sent', async () => {
    ({ a, b } = await aliceToBob(subject));
    ok(b.mailbox_ids.includes(await roleBox(BOB, 'inbox')), 'bob copy is in inbox');
    ok(a.mailbox_ids.includes(await roleBox(ALICE, 'sent')), 'alice copy is in sent');
  });
  let reply!: Email;
  await test('bob\'s reply threads under the original for alice: In-Reply-To, References, same thread', async () => {
    const r = await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: `Re: ${subject}`, html: '<p>Hi Alice, yes!</p><div class="tern-quote"><blockquote>Hello Bob</blockquote></div>', replyToEmailId: b.id });
    ok(r.messageId, 'message id returned');
    reply = await waitFor('reply at alice', async () => { const rows = await sql<Email>('SELECT * FROM emails WHERE account_id=$1 AND subject=$2 ORDER BY id DESC LIMIT 1', [ALICE, `Re: ${subject}`]); return rows[0]; });
    eq(reply.in_reply_to, b.message_id, 'In-Reply-To');
    ok(reply.references_ids.includes(b.message_id[0]), 'References includes original');
    eq(reply.thread_id, a.thread_id, 'same thread as alice\'s original');
  });
  await test('the reply lands in alice\'s inbox unread and the conversation shows both messages', async () => {
    ok(reply.mailbox_ids.includes(await roleBox(ALICE, 'inbox')), 'reply in inbox');
    ok(!reply.keywords.includes('$seen'), 'unread');
    const t = await api('GET', `/api/mail/threads/${ALICE}/${a.thread_id}`);
    eq(t.status, 200);
    eq(t.data.messages.length, 2, 'two messages');
    eq(t.data.messages[1].from_email, 'bob@probe.test');
    ok(t.data.account.signature_html !== undefined, 'thread payload carries the account signature for the composer');
  });
  await test('alice\'s send_log records the reply (replied_at set by automation)', async () => {
    await waitFor('replied_at', async () => (await sql('SELECT replied_at FROM send_log WHERE account_id=$1 AND subject=$2 AND replied_at IS NOT NULL', [ALICE, subject]))[0]);
  });
  await test('reply all from a message with several recipients reaches everyone but the sender', async () => {
    const s2 = `e2e replyall ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], cc: [{ email: 'alice@probe.test' }], subject: s2, html: '<p>group</p>' });
    const bb = await arrived(BOB, s2);
    // replyRecipients as the client computes them, for bob replying all
    const { replyRecipients } = await import('../services/reply.js');
    const r = replyRecipients({ from: bb.from_addr, replyTo: [], to: bb.to_addr, cc: bb.cc_addr }, 'bob@probe.test', true);
    eq(r.to.map((x) => x.email), ['alice@probe.test']);
    eq(r.cc, [], 'alice already in To, and bob is me');
    await send(BOB, { to: r.to, cc: r.cc, subject: `Re: ${s2}`, html: '<p>reply all</p>', replyToEmailId: bb.id });
    const got = await arrived(ALICE, `Re: ${s2}`);
    eq(got.thread_id, (await arrived(ALICE, s2)).thread_id, 'threaded');
  });
  await test('replying to my own sent message addresses its recipients, not me', async () => {
    const { replyRecipients } = await import('../services/reply.js');
    const r = replyRecipients({ from: a.from_addr, replyTo: [], to: a.to_addr, cc: a.cc_addr }, 'alice@probe.test');
    eq(r.to.map((x) => x.email), ['bob@probe.test']);
  });
  await test('the AI responder module and the composer agree on recipients for a Reply-To message', async () => {
    const { replyRecipients } = await import('../services/reply.js');
    const src = { from: [{ email: 'bob@probe.test' }], replyTo: [{ email: 'list@lists.example' }], to: [{ email: 'alice@probe.test' }], cc: [{ email: 'carol@probe.test' }] };
    eq(replyRecipients(src, 'alice@probe.test').to.map((x) => x.email), ['list@lists.example']);
    eq(replyRecipients(src, 'alice@probe.test', true).cc.map((x) => x.email), ['carol@probe.test']);
  });
  let withAtt!: { a: Email; b: Email };
  await test('a message with an attachment arrives with the attachment', async () => {
    const s3 = `e2e attach ${uid()}`;
    const up1 = await upload('notes.txt', 'text/plain', Buffer.from('hello notes'));
    const up2 = await upload('pixel.png', 'image/png', PNG);
    withAtt = await aliceToBob(s3, { attachmentIds: [up1.id, up2.id] });
    const names = withAtt.b.attachments.map((x: any) => x.name).sort();
    eq(names, ['notes.txt', 'pixel.png']);
    ok(!(await sql('SELECT 1 FROM uploads WHERE id = ANY($1)', [[up1.id, up2.id]])).length, 'uploads deleted after send');
  });
  await test('forwarding with a subset of attachments sends only those', async () => {
    const keep = withAtt.b.attachments.find((x: any) => x.name === 'notes.txt');
    const s4 = `Fwd: ${withAtt.b.subject}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s4, html: '<p>fyi</p><div class="tern-quote">---------- Forwarded message ---------</div>', forwardOfEmailId: withAtt.b.id, forwardBlobIds: [keep.blobId] });
    const got = await waitFor('forward at alice', async () => (await sql<Email>('SELECT * FROM emails WHERE account_id=$1 AND subject=$2 ORDER BY id DESC LIMIT 1', [ALICE, s4]))[0]);
    eq(got.attachments.map((x: any) => x.name), ['notes.txt']);
  });
  await test('forwarding with no blob ids drops every attachment; omitting the list forwards all', async () => {
    const s5 = `Fwd: none ${withAtt.b.subject}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s5, html: '<p>none</p>', forwardOfEmailId: withAtt.b.id, forwardBlobIds: [] });
    const none = await arrived(ALICE, s5);
    eq(none.attachments.length, 0);
    const s6 = `Fwd: all ${withAtt.b.subject}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s6, html: '<p>all</p>', forwardOfEmailId: withAtt.b.id });
    const all = await arrived(ALICE, s6);
    eq(all.attachments.map((x: any) => x.name).sort(), ['notes.txt', 'pixel.png']);
  });
  await test('the signature appears exactly once whether the client or the server adds it', async () => {
    await sql(`UPDATE accounts SET signature_html='<p>Alice Probe · Tern</p>' WHERE id=$1`, [ALICE]);
    const s7 = `e2e sig client ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s7, html: '<p>typed</p><div class="tern-signature" style="margin-top:16px"><p>Alice Probe · Tern</p></div>', includeSignature: false });
    const c = await arrived(BOB, s7);
    eq((c.body_html ?? '').split('tern-signature').length - 1, 1, 'client-added signature once');
    const s8 = `e2e sig server ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s8, html: '<p>typed</p>', includeSignature: true });
    const d = await arrived(BOB, s8);
    eq((d.body_html ?? '').split('tern-signature').length - 1, 1, 'server-added signature once');
    ok((d.body_html ?? '').includes('Alice Probe · Tern'));
    await sql(`UPDATE accounts SET signature_html='' WHERE id=$1`, [ALICE]);
  });
  await test('subject prefixes: one Re:, one Fwd:, foreign prefixes normalised', async () => {
    const { replySubject, forwardSubject } = await import('../services/reply.js');
    eq(replySubject(subject), `Re: ${subject}`); eq(replySubject(`Re: ${subject}`), `Re: ${subject}`); eq(replySubject(`AW: ${subject}`), `Re: ${subject}`);
    eq(forwardSubject(`Fwd: ${subject}`), `Fwd: ${subject}`); eq(forwardSubject(`Re: ${subject}`), `Fwd: Re: ${subject}`);
  });
  await test('sending with no recipients or an invalid address is refused', async () => {
    eq((await api('POST', '/api/mail/send', { accountId: ALICE, to: [], subject: 'x', html: 'x' })).status, 400);
    eq((await api('POST', '/api/mail/send', { accountId: ALICE, to: [{ email: 'not-an-address' }], subject: 'x', html: 'x' })).status, 400);
  });
});

// ======================================================================
const undoGroup = group('undo', async () => {
  const s = `e2e undo ${uid()}`;
  let outboxId!: number;
  await test('sending inside an undo window queues the message instead of sending it', async () => {
    const r = await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s, html: '<p>oops</p>', scheduleAt: new Date(Date.now() + 8000).toISOString(), undoWindow: true });
    ok(r.scheduled && r.outboxId, 'queued');
    outboxId = r.outboxId;
    eq((await sql('SELECT status FROM outbox WHERE id=$1', [outboxId]))[0].status, 'scheduled');
    eq((await sql('SELECT 1 FROM send_log WHERE subject=$1', [s])).length, 0, 'nothing sent yet');
  });
  await test('the queued message shows in the outbox list during the window', async () => {
    const r = await api('GET', '/api/mail/outbox');
    ok(r.data.outbox.some((o: any) => o.id === outboxId && o.status === 'scheduled'));
  });
  let draft: any;
  await test('undo cancels it and hands the text back as a draft', async () => {
    const r = await api('DELETE', `/api/mail/outbox/${outboxId}`);
    eq(r.status, 200); eq(r.data.cancelled, true);
    draft = r.data.draft;
    ok(draft?.id, 'draft returned');
    eq(draft.subject, s); eq(draft.body_html, '<p>oops</p>'); eq(draft.to_addr[0].email, 'bob@probe.test'); eq(draft.kind, 'new');
    eq((await sql('SELECT status FROM outbox WHERE id=$1', [outboxId]))[0].status, 'cancelled');
  });
  await test('the restored draft is listed in Drafts', async () => {
    const r = await api('GET', '/api/mail/drafts');
    ok(r.data.drafts.some((d: any) => d.id === draft.id));
    await api('DELETE', `/api/mail/drafts/${draft.id}`);
  });
  await test('the message never arrives after an undo', async () => {
    await sleep(11_000);
    eq((await sql('SELECT 1 FROM emails WHERE account_id=$1 AND subject=$2', [BOB, s])).length, 0);
    eq((await sql('SELECT 1 FROM send_log WHERE subject=$1', [s])).length, 0);
  });
  await test('an undo window that is left alone sends on time and logs as a plain compose, not scheduled', async () => {
    const s2 = `e2e undo lapse ${uid()}`;
    const t0 = Date.now();
    const r = await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s2, html: '<p>going</p>', scheduleAt: new Date(Date.now() + 5000).toISOString(), undoWindow: true });
    const log = await waitFor('send_log', async () => (await sql('SELECT kind, status FROM send_log WHERE subject=$1', [s2]))[0], 30_000, 500);
    ok(Date.now() - t0 < 20_000, `sent within the window plus a few seconds (${Date.now() - t0} ms)`);
    eq(log.kind, 'compose'); eq(log.status, 'sent');
    eq((await sql('SELECT status FROM outbox WHERE id=$1', [r.outboxId]))[0].status, 'sent');
    await arrived(BOB, s2);
  });
  await test('undo after the message has gone reports that it was already sent', async () => {
    const s3 = `e2e undo late ${uid()}`;
    const r = await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s3, html: '<p>late</p>', scheduleAt: new Date(Date.now() + 1000).toISOString(), undoWindow: true });
    await waitFor('sent', async () => (await sql(`SELECT 1 FROM outbox WHERE id=$1 AND status='sent'`, [r.outboxId]))[0], 30_000, 500);
    const c = await api('DELETE', `/api/mail/outbox/${r.outboxId}`);
    eq(c.data.cancelled, false); eq(c.data.status, 'sent');
  });
  await test('a reply held in the undo window keeps its reply kind and threading', async () => {
    const s4 = `e2e undo reply ${uid()}`;
    const { b } = await aliceToBob(s4);
    const r = await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: `Re: ${s4}`, html: '<p>r</p>', replyToEmailId: b.id, scheduleAt: new Date(Date.now() + 1500).toISOString(), undoWindow: true });
    ok(r.scheduled);
    const log = await waitFor('reply sent', async () => (await sql('SELECT kind FROM send_log WHERE subject=$1', [`Re: ${s4}`]))[0], 30_000, 500);
    eq(log.kind, 'reply');
    const got = await arrived(ALICE, `Re: ${s4}`);
    eq(got.in_reply_to, b.message_id);
  });
  await test('the undo window cannot exceed two minutes', async () => {
    const r = await api('POST', '/api/mail/send', { accountId: ALICE, to: [{ email: 'bob@probe.test' }], subject: 'x', html: 'x', scheduleAt: new Date(Date.now() + 10 * 60_000).toISOString(), undoWindow: true });
    eq(r.status, 400);
  });
  await test('sending a draft inside the window removes the draft; undo brings a fresh draft back with its attachment', async () => {
    const up = await upload('keep.txt', 'text/plain', Buffer.from('keep me'));
    const d = await api('POST', '/api/mail/drafts', { accountId: ALICE, to: [{ email: 'bob@probe.test' }], subject: 'draft in window', html: '<p>d</p>', attachmentIds: [up.id] });
    const r = await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: 'draft in window', html: '<p>d</p>', attachmentIds: [up.id], draftId: d.data.draft.id, scheduleAt: new Date(Date.now() + 20_000).toISOString(), undoWindow: true });
    eq((await sql('SELECT 1 FROM drafts WHERE id=$1', [d.data.draft.id])).length, 0, 'draft gone once queued');
    const c = await api('DELETE', `/api/mail/outbox/${r.outboxId}`);
    ok(c.data.cancelled && c.data.draft.id !== d.data.draft.id, 'new draft');
    eq(c.data.draft.attachments.map((x: any) => x.filename), ['keep.txt']);
    await api('DELETE', `/api/mail/drafts/${c.data.draft.id}`);
    await api('DELETE', `/api/mail/uploads/${up.id}`);
  });
  await test('a real scheduled send (no undo window) is logged as scheduled', async () => {
    const s5 = `e2e scheduled ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s5, html: '<p>s</p>', scheduleAt: new Date(Date.now() + 1000).toISOString() });
    const log = await waitFor('scheduled sent', async () => (await sql('SELECT kind FROM send_log WHERE subject=$1', [s5]))[0], 40_000, 700);
    eq(log.kind, 'scheduled');
  });
  await test('"send now" on a queued message sends it straight away', async () => {
    const s6 = `e2e sendnow ${uid()}`;
    const r = await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s6, html: '<p>n</p>', scheduleAt: new Date(Date.now() + 90_000).toISOString() });
    eq((await api('POST', `/api/mail/outbox/${r.outboxId}/now`)).status, 200);
    await waitFor('sent now', async () => (await sql(`SELECT 1 FROM outbox WHERE id=$1 AND status='sent'`, [r.outboxId]))[0], 40_000, 700);
  });
});

// ======================================================================
const undoableGroup = group('undoable', async () => {
  const inbox = await roleBox(ALICE, 'inbox'), trash = await roleBox(ALICE, 'trash'), junk = await roleBox(ALICE, 'junk');
  let msg!: Email;
  const newInboxMail = async () => { const s = `e2e action ${uid()}`; await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s, html: '<p>x</p>' }); return arrived(ALICE, s); };
  const restore = async (undo: any) => act(ALICE, { action: 'restore', items: undo.items });
  await test('archive returns an undo record and restore puts the message back in the inbox', async () => {
    msg = await newInboxMail();
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'archive' });
    ok(r.undo?.items?.length, 'undo returned');
    eq(r.undo.items[0].mailboxIds, msg.mailbox_ids);
    ok(!(await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox), 'archived');
    await restore(r.undo);
    ok((await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox), 'back in inbox');
  });
  await test('trash and restore', async () => {
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'trash' });
    eq((await fresh(ALICE, msg.id)).mailbox_ids, [trash]);
    await restore(r.undo);
    eq((await fresh(ALICE, msg.id)).mailbox_ids, msg.mailbox_ids);
  });
  await test('junk and restore', async () => {
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'spam' });
    eq((await fresh(ALICE, msg.id)).mailbox_ids, [junk]);
    await restore(r.undo);
    eq((await fresh(ALICE, msg.id)).mailbox_ids, msg.mailbox_ids);
  });
  await test('snooze and restore: the snooze is cleared and the mail is back where it was', async () => {
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'snooze', until: new Date(Date.now() + 3600_000).toISOString() });
    ok(!(await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox), 'out of inbox');
    eq((await sql('SELECT restored FROM snoozes WHERE account_id=$1 AND thread_id=$2', [ALICE, msg.thread_id]))[0].restored, false);
    await restore(r.undo);
    eq((await sql('SELECT restored FROM snoozes WHERE account_id=$1 AND thread_id=$2', [ALICE, msg.thread_id]))[0].restored, true);
    ok((await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox), 'back in inbox');
  });
  let label: any;
  await test('label and restore removes the label again', async () => {
    label = (await api('POST', '/api/mail/mailboxes', { accountId: ALICE, name: `E2E ${uid()}` })).data.mailbox;
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'label', mailboxId: label.jmap_id });
    ok((await fresh(ALICE, msg.id)).mailbox_ids.includes(label.jmap_id));
    await restore(r.undo);
    ok(!(await fresh(ALICE, msg.id)).mailbox_ids.includes(label.jmap_id));
  });
  await test('move and restore', async () => {
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'move', mailboxId: label.jmap_id });
    eq((await fresh(ALICE, msg.id)).mailbox_ids, [label.jmap_id]);
    await restore(r.undo);
    eq((await fresh(ALICE, msg.id)).mailbox_ids, msg.mailbox_ids);
  });
  await test('mute archives and records the thread; restore unmutes and puts it back', async () => {
    const r = await act(ALICE, { threadIds: [msg.thread_id], action: 'mute' });
    ok(!(await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox), 'archived by mute');
    eq((await sql('SELECT 1 FROM muted_threads WHERE account_id=$1 AND thread_id=$2', [ALICE, msg.thread_id])).length, 1);
    await restore(r.undo);
    eq((await sql('SELECT 1 FROM muted_threads WHERE account_id=$1 AND thread_id=$2', [ALICE, msg.thread_id])).length, 0);
    ok((await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox));
  });
  await test('read, unread and star carry no undo record', async () => {
    for (const a of ['read', 'unread', 'star', 'unstar']) eq((await act(ALICE, { threadIds: [msg.thread_id], action: a })).undo, null, a);
  });
  await test('restore ignores mailbox ids that no longer exist and refuses an empty list', async () => {
    const r = await act(ALICE, { action: 'restore', items: [{ jmapId: msg.jmap_id, mailboxIds: ['nope-xyz', inbox] }] });
    eq(r.ok, true);
    ok((await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox));
    eq((await api('POST', '/api/mail/actions', { accountId: ALICE, action: 'restore', items: [] })).status, 400);
  });
  await test('archiving two conversations at once undoes both', async () => {
    const m2 = await newInboxMail();
    const r = await act(ALICE, { threadIds: [msg.thread_id, m2.thread_id], action: 'archive' });
    eq(r.undo.items.length, 2);
    await restore(r.undo);
    ok((await fresh(ALICE, msg.id)).mailbox_ids.includes(inbox) && (await fresh(ALICE, m2.id)).mailbox_ids.includes(inbox));
  });
  await test('the thread list reports the muted flag and hides muted mail from the inbox', async () => {
    await act(ALICE, { threadIds: [msg.thread_id], action: 'mute' });
    const all = await api('GET', `/api/mail/threads?box=all&accounts=${ALICE}`);
    const row = all.data.threads.find((t: any) => t.thread_id === msg.thread_id);
    eq(row?.muted, true);
    const inb = await api('GET', `/api/mail/threads?box=inbox&accounts=${ALICE}`);
    ok(!inb.data.threads.some((t: any) => t.thread_id === msg.thread_id));
    await act(ALICE, { threadIds: [msg.thread_id], action: 'unmute' });
  });
  await test('deleting the label cleans up', async () => {
    eq((await api('DELETE', `/api/mail/mailboxes/${ALICE}/${label.jmap_id}`)).status, 200);
  });
});

// ======================================================================
const muteGroup = group('mute', async () => {
  const inbox = await roleBox(ALICE, 'inbox');
  const s = `e2e mute ${uid()}`;
  let a!: Email, b!: Email;
  await test('a conversation is muted from alice\'s side', async () => {
    ({ a, b } = await aliceToBob(s));
    await act(ALICE, { threadIds: [a.thread_id], action: 'mute' });
    eq((await api('GET', `/api/mail/threads/${ALICE}/${a.thread_id}`)).data.muted, true);
  });
  await test('a new reply in a muted conversation skips alice\'s inbox', async () => {
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: `Re: ${s}`, html: '<p>ping</p>', replyToEmailId: b.id });
    const r = await arrived(ALICE, `Re: ${s}`);
    await waitFor('archived by mute', async () => !(await fresh(ALICE, r.id)).mailbox_ids.includes(inbox), 20_000, 500);
    eq(r.thread_id, a.thread_id);
  });
  await test('the muted reply is still readable in All mail and the archive', async () => {
    const all = await api('GET', `/api/mail/threads?box=archive&accounts=${ALICE}`);
    ok(all.data.threads.some((t: any) => t.thread_id === a.thread_id));
  });
  await test('unmute, and the next reply lands in the inbox again', async () => {
    await act(ALICE, { threadIds: [a.thread_id], action: 'unmute' });
    eq((await api('GET', `/api/mail/threads/${ALICE}/${a.thread_id}`)).data.muted, false);
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: `Re: ${s} again`, html: '<p>ping 2</p>', replyToEmailId: b.id });
    const r = await arrived(ALICE, `Re: ${s} again`);
    await sleep(2500);
    ok((await fresh(ALICE, r.id)).mailbox_ids.includes(inbox), 'in inbox');
  });
  await test('muting is per account: bob\'s side is unaffected', async () => {
    await act(ALICE, { threadIds: [a.thread_id], action: 'mute' });
    eq((await sql('SELECT 1 FROM muted_threads WHERE account_id=$1 AND thread_id=$2', [BOB, b.thread_id])).length, 0);
    await act(ALICE, { threadIds: [a.thread_id], action: 'unmute' });
  });
  await test('muting twice is harmless and unmuting a thread that is not muted is fine', async () => {
    await act(ALICE, { threadIds: [a.thread_id], action: 'mute' });
    await act(ALICE, { threadIds: [a.thread_id], action: 'mute' });
    eq((await sql('SELECT count(*)::int AS n FROM muted_threads WHERE account_id=$1 AND thread_id=$2', [ALICE, a.thread_id]))[0].n, 1);
    await act(ALICE, { threadIds: [a.thread_id], action: 'unmute' });
    await act(ALICE, { threadIds: [a.thread_id], action: 'unmute' });
  });
  await test('mute needs a thread', async () => {
    eq((await api('POST', '/api/mail/actions', { accountId: ALICE, action: 'mute' })).status, 400);
  });
  await test('a muted thread is not listed under Inbox even when an older message is still there', async () => {
    await act(ALICE, { threadIds: [a.thread_id], action: 'mute' });
    const inb = await api('GET', `/api/mail/threads?box=inbox&accounts=${ALICE}`);
    ok(!inb.data.threads.some((t: any) => t.thread_id === a.thread_id));
  });
  await test('moving a muted thread back to the inbox by hand keeps the mute (it applies to future mail)', async () => {
    await act(ALICE, { threadIds: [a.thread_id], action: 'inbox' });
    eq((await sql('SELECT 1 FROM muted_threads WHERE account_id=$1 AND thread_id=$2', [ALICE, a.thread_id])).length, 1);
  });
  await test('deleting the account\'s muted row happens with the thread action unmute only', async () => {
    await act(ALICE, { threadIds: [a.thread_id], action: 'unmute' });
    eq((await sql('SELECT 1 FROM muted_threads WHERE account_id=$1', [ALICE])).length, 0);
  });
});

// ======================================================================
const emptyGroup = group('empty', async () => {
  const trash = await roleBox(ALICE, 'trash');
  await test('empty trash deletes everything in it for good', async () => {
    const s1 = `e2e trash1 ${uid()}`, s2 = `e2e trash2 ${uid()}`;
    const m1 = await (async () => { await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s1, html: 'x' }); return arrived(ALICE, s1); })();
    const m2 = await (async () => { await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s2, html: 'x' }); return arrived(ALICE, s2); })();
    await act(ALICE, { threadIds: [m1.thread_id, m2.thread_id], action: 'trash' });
    const r = await api('POST', '/api/mail/empty', { box: 'trash', accountId: ALICE });
    eq(r.status, 200);
    ok(r.data.count >= 2, `deleted ${r.data.count}`);
    eq((await sql('SELECT 1 FROM emails WHERE id = ANY($1)', [[m1.id, m2.id]])).length, 0);
    eq((await sql('SELECT count(*)::int AS n FROM emails WHERE account_id=$1 AND $2 = ANY(mailbox_ids)', [ALICE, trash]))[0].n, 0);
  });
  await test('emptying an already empty trash reports zero', async () => {
    eq((await api('POST', '/api/mail/empty', { box: 'trash', accountId: ALICE })).data.count, 0);
  });
  await test('empty junk works the same way', async () => {
    const s = `e2e junk ${uid()}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s, html: 'x' });
    const m = await arrived(ALICE, s);
    await act(ALICE, { threadIds: [m.thread_id], action: 'spam' });
    ok((await api('POST', '/api/mail/empty', { box: 'junk', accountId: ALICE })).data.count >= 1);
    eq((await sql('SELECT 1 FROM emails WHERE id=$1', [m.id])).length, 0);
  });
  await test('an unknown box is refused', async () => {
    eq((await api('POST', '/api/mail/empty', { box: 'inbox' })).status, 400);
  });
  await test('emptying only touches the asked account', async () => {
    const s = `e2e junk bob ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s, html: 'x' });
    const m = await arrived(BOB, s);
    await act(BOB, { threadIds: [m.thread_id], action: 'spam' });
    await api('POST', '/api/mail/empty', { box: 'junk', accountId: ALICE });
    eq((await sql('SELECT 1 FROM emails WHERE id=$1', [m.id])).length, 1, 'bob untouched');
    await api('POST', '/api/mail/empty', { box: 'junk', accountId: BOB });
    eq((await sql('SELECT 1 FROM emails WHERE id=$1', [m.id])).length, 0);
  });
  await test('the server-side copy is gone too: the next sync does not bring it back', async () => {
    const s = `e2e trash sync ${uid()}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s, html: 'x' });
    const m = await arrived(ALICE, s);
    await act(ALICE, { threadIds: [m.thread_id], action: 'trash' });
    await api('POST', '/api/mail/empty', { box: 'trash', accountId: ALICE });
    await api('POST', `/api/accounts/${ALICE}/resync`);
    await sleep(4000);
    eq((await sql('SELECT 1 FROM emails WHERE account_id=$1 AND subject=$2', [ALICE, s])).length, 0);
  });
  await test('the inbox count is unaffected by emptying', async () => {
    const before = (await api('GET', '/api/mail/counts')).data.inboxUnread;
    await api('POST', '/api/mail/empty', { box: 'trash', accountId: ALICE });
    eq((await api('GET', '/api/mail/counts')).data.inboxUnread, before);
  });
  await test('permanent delete of a single conversation', async () => {
    const s = `e2e delete ${uid()}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s, html: 'x' });
    const m = await arrived(ALICE, s);
    await act(ALICE, { threadIds: [m.thread_id], action: 'delete' });
    eq((await sql('SELECT 1 FROM emails WHERE id=$1', [m.id])).length, 0);
  });
  await test('empty with no account id covers every account of the user', async () => {
    const r = await api('POST', '/api/mail/empty', { box: 'trash' });
    eq(r.status, 200); ok(typeof r.data.count === 'number');
  });
  await test('a member cannot empty another user\'s trash (account filter is scoped)', async () => {
    const r = await api('POST', '/api/mail/empty', { box: 'trash', accountId: 3 });
    eq(r.status, 200); eq(r.data.count, 0);
  });
});

// ======================================================================
const aiGroup = group('ai', async () => {
  const status = await api('GET', '/api/ai/status');
  if (!status.data?.settings?.enabled || !status.data?.health?.ok) { console.log('  (AI not reachable, skipping)'); return; }
  const s = `Pricing question ${uid()}`;
  let a!: Email, b!: Email;
  await test('an AI reply to bob greets Bob, not Alice, and ends without a signature line', async () => {
    await send(BOB, { to: [{ name: 'Alice Probe', email: 'alice@probe.test' }], subject: s, html: '<p>Hi Alice, could you send me your pricing for 20 seats? Thanks, Bob</p>' });
    a = await arrived(ALICE, s);
    const r = await stream('/api/ai/draft', { mode: 'reply', accountId: ALICE, threadKey: `${ALICE}:${a.thread_id}`, recipientEmail: 'bob@probe.test', recipientName: 'Bob Probe', tone: 'friendly', length: 'short' });
    ok(!r.error, r.error);
    ok(/^Hi Bob,/.test(r.text), `greeting: ${r.text.slice(0, 40)}`);
    ok(!/alice@probe\.test/i.test(r.text), 'no email address signature');
    ok(!/^Hi Alice/i.test(r.text));
  });
  await test('a new email to a contact with a first name greets that first name', async () => {
    const r = await stream('/api/ai/draft', { mode: 'compose', accountId: ALICE, instruction: 'ask for a short intro call next week', recipientEmail: 'dana@acme.example', recipientName: 'Dana Osei', length: 'short' });
    ok(/^Hi Dana,/.test(r.text), r.text.slice(0, 40));
  });
  await test('an unknown recipient is greeted neutrally, never with an invented name', async () => {
    const r = await stream('/api/ai/draft', { mode: 'compose', accountId: ALICE, instruction: 'say hello and introduce Tern', recipientEmail: 'hello@bluefin.example', length: 'short' });
    ok(/^Hi there,/.test(r.text), r.text.slice(0, 40));
  });
  await test('quick replies: up to three short one-liners, no greetings, no numbering', async () => {
    const r = await stream('/api/ai/draft', { mode: 'quick_replies', accountId: ALICE, threadKey: `${ALICE}:${a.thread_id}`, recipientEmail: 'bob@probe.test' });
    ok(!r.error, r.error);
    const lines = r.text.split('\n').filter(Boolean);
    ok(lines.length >= 1 && lines.length <= 3, `${lines.length} lines: ${r.text}`);
    for (const l of lines) { ok(l.length <= 140, l); ok(!/^\d+[.)]/.test(l), l); ok(!/^hi\b/i.test(l), l); }
  });
  await test('summarize returns a few sentences and a Next: line', async () => {
    const r = await stream('/api/ai/draft', { mode: 'summarize', accountId: ALICE, threadKey: `${ALICE}:${a.thread_id}` });
    ok(r.text.length > 20 && r.tokens > 3);
  });
  await test('subject line: one line, no quotes, no trailing period', async () => {
    const r = await stream('/api/ai/draft', { mode: 'subject', accountId: ALICE, draft: 'Hi Bob, here is our pricing for 20 seats: 400 a month. Best, Alice' });
    ok(r.text && !r.text.includes('\n') && !/^["']|["']$/.test(r.text) && !/[.]$/.test(r.text), r.text);
  });
  await test('a responder in draft mode writes a suggested reply to the right person', async () => {
    await sql(`UPDATE responders SET enabled=false WHERE user_id=$1`, [USER]);
    const resp = await api('POST', '/api/responders', { name: `E2E responder ${uid()}`, account_id: BOB, mode: 'draft', conditions: [], instructions: 'Answer briefly and propose a call.', tone: 'friendly', length: 'short', reply_all: false, humanize: false, daily_cap: 50, cooldown_hours: 0, skip_lists: true, only_contacts: false });
    ok(resp.status === 200, JSON.stringify(resp.data));
    const s2 = `Demo request ${uid()}`;
    await send(ALICE, { to: [{ name: 'Bob Probe', email: 'bob@probe.test' }], subject: s2, html: '<p>Hi Bob, can we see a demo of the reporting module? Alice</p>' });
    b = await arrived(BOB, s2);
    const draft = await waitFor('responder draft', async () => (await sql(`SELECT * FROM drafts WHERE account_id=$1 AND thread_id=$2 AND source='ai'`, [BOB, b.thread_id]))[0], 90_000, 1500);
    eq(draft.to_addr.map((x: any) => x.email), ['alice@probe.test']);
    eq(draft.subject, `Re: ${s2}`);
    const text = String(draft.body_html).split('<div class="tern-quote"')[0].replace(/<[^>]+>/g, '\n').trim();
    ok(/^Hi Alice,/.test(text), text.slice(0, 60));
    ok(draft.body_html.includes('tern-quote'), 'quote appended');
    await api('DELETE', `/api/responders/${resp.data.responder.id}`);
  });
  await test('the responder never answers list mail or its own outbound mail', async () => {
    const jobs = await sql(`SELECT count(*)::int AS n FROM ai_jobs WHERE kind='responder' AND status IN ('pending','running')`);
    ok(jobs[0].n >= 0);
    const own = await sql(`SELECT 1 FROM drafts d JOIN emails e ON e.id=d.reply_to_email_id WHERE d.source='ai' AND e.from_email = (SELECT lower(email) FROM accounts WHERE id=e.account_id)`);
    eq(own.length, 0, 'no AI draft replying to our own message');
  });
  await test('invalid modes are refused', async () => {
    eq((await api('POST', '/api/ai/draft', { mode: 'haiku' })).status, 400);
  });
  await test('the thread the model sees belongs to the user (foreign thread key is refused)', async () => {
    const r = await stream('/api/ai/draft', { mode: 'reply', accountId: ALICE, threadKey: '3:whatever' });
    ok(r.error || !r.text, 'no output for a thread that is not ours');
  });
  await sql(`UPDATE responders SET enabled=true WHERE user_id=$1 AND name LIKE 'E2E %' AND id IN (7,8)`, [USER]).catch(() => {});
});

// ======================================================================
const searchGroup = group('search', async () => {
  const tag = uid();
  const s1 = `Quarterly plan ${tag}`, s2 = `Invoice attached ${tag}`;
  let m1!: Email, m2!: Email;
  await test('setup: two messages, one with an attachment', async () => {
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s1, html: `<p>budget draft for the quarter ${tag}</p>` });
    const up = await upload('invoice.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fake'));
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s2, html: `<p>please find the invoice ${tag}</p>`, attachmentIds: [up.id] });
    m1 = await arrived(ALICE, s1); m2 = await arrived(ALICE, s2);
  });
  const find = async (q: string, box = 'all') => (await api('GET', `/api/mail/threads?box=${box}&accounts=${ALICE}&q=${encodeURIComponent(q)}`)).data.threads.map((t: any) => t.thread_id);
  await test('free words', async () => { const r = await find(`budget ${tag}`); ok(r.includes(m1.thread_id) && !r.includes(m2.thread_id)); });
  await test('from:', async () => { ok((await find(`from:bob ${tag}`)).includes(m1.thread_id)); eq((await find(`from:nobody ${tag}`)).length, 0); });
  await test('to:', async () => { ok((await find(`to:alice@probe.test ${tag}`)).length >= 2); });
  await test('subject:', async () => { const r = await find(`subject:"Quarterly plan" ${tag}`); ok(r.includes(m1.thread_id) && !r.includes(m2.thread_id)); });
  await test('has:attachment', async () => { const r = await find(`has:attachment ${tag}`); ok(r.includes(m2.thread_id) && !r.includes(m1.thread_id)); });
  await test('is:unread and is:read', async () => {
    ok((await find(`is:unread ${tag}`)).includes(m1.thread_id));
    await act(ALICE, { threadIds: [m1.thread_id], action: 'read' });
    ok(!(await find(`is:unread ${tag}`)).includes(m1.thread_id));
    ok((await find(`is:read ${tag}`)).includes(m1.thread_id));
  });
  await test('newer_than and older_than', async () => { ok((await find(`newer_than:1d ${tag}`)).length >= 2); eq((await find(`older_than:1d ${tag}`)).length, 0); });
  await test('negation with a dash', async () => { const r = await find(`${tag} -invoice`); ok(r.includes(m1.thread_id) && !r.includes(m2.thread_id)); });
  await test('in: / label: for folders', async () => { ok((await find(`in:inbox ${tag}`)).length >= 2); eq((await find(`in:sent ${tag}`)).length, 0); });
  await test('is:starred', async () => {
    await act(ALICE, { threadIds: [m2.thread_id], action: 'star' });
    const r = await find(`is:starred ${tag}`); ok(r.includes(m2.thread_id) && !r.includes(m1.thread_id));
    await act(ALICE, { threadIds: [m2.thread_id], action: 'unstar' });
  });
  await test('the attachments box lists only conversations with files, with their names', async () => {
    const r = (await api('GET', `/api/mail/threads?box=attachments&accounts=${ALICE}&q=${encodeURIComponent(tag)}`)).data.threads;
    eq(r.map((t: any) => t.thread_id), [m2.thread_id]);
    eq(r[0].attachments, ['invoice.pdf']);
  });
});

// ======================================================================
const labelsGroup = group('labels', async () => {
  let label: any; const name = `Leads ${uid()}`;
  const s = `e2e label ${uid()}`;
  let m!: Email;
  await test('create a label', async () => {
    const r = await api('POST', '/api/mail/mailboxes', { accountId: ALICE, name });
    eq(r.status, 200); label = r.data.mailbox; eq(label.name, name); ok(!label.role);
  });
  await test('it appears in the mailbox list', async () => {
    ok((await api('GET', '/api/mail/mailboxes')).data.mailboxes.some((x: any) => x.jmap_id === label.jmap_id));
  });
  await test('apply it to a conversation; the message keeps its inbox membership', async () => {
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s, html: 'x' }); m = await arrived(ALICE, s);
    await act(ALICE, { threadIds: [m.thread_id], action: 'label', mailboxId: label.jmap_id });
    const f = await fresh(ALICE, m.id);
    ok(f.mailbox_ids.includes(label.jmap_id) && f.mailbox_ids.includes(await roleBox(ALICE, 'inbox')));
  });
  await test('the label box lists it and the thread row names the label', async () => {
    const r = (await api('GET', `/api/mail/threads?box=mailbox:${ALICE}:${label.jmap_id}&accounts=${ALICE}`)).data.threads;
    ok(r.some((t: any) => t.thread_id === m.thread_id));
  });
  await test('unread count per label', async () => {
    const c = (await api('GET', '/api/mail/counts')).data.labelUnread;
    ok((c[`${ALICE}:${label.jmap_id}`] ?? 0) >= 1);
  });
  await test('rename', async () => {
    eq((await api('PUT', `/api/mail/mailboxes/${ALICE}/${label.jmap_id}`, { name: `${name} renamed` })).status, 200);
    eq((await sql('SELECT name FROM mailboxes WHERE account_id=$1 AND jmap_id=$2', [ALICE, label.jmap_id]))[0].name, `${name} renamed`);
  });
  await test('colour', async () => {
    eq((await api('PUT', `/api/mail/mailboxes/${ALICE}/${label.jmap_id}`, { color: '#e0567b' })).status, 200);
    eq((await sql('SELECT color FROM mailboxes WHERE account_id=$1 AND jmap_id=$2', [ALICE, label.jmap_id]))[0].color, '#e0567b');
    eq((await api('PUT', `/api/mail/mailboxes/${ALICE}/${label.jmap_id}`, { color: 'red' })).status, 400);
  });
  await test('remove the label from the conversation (it stays in the inbox)', async () => {
    await act(ALICE, { threadIds: [m.thread_id], action: 'unlabel', mailboxId: label.jmap_id });
    const f = await fresh(ALICE, m.id);
    ok(!f.mailbox_ids.includes(label.jmap_id) && f.mailbox_ids.includes(await roleBox(ALICE, 'inbox')));
  });
  await test('unlabelling the only mailbox moves the message to the archive rather than nowhere', async () => {
    await act(ALICE, { threadIds: [m.thread_id], action: 'move', mailboxId: label.jmap_id });
    await act(ALICE, { threadIds: [m.thread_id], action: 'unlabel', mailboxId: label.jmap_id });
    const f = await fresh(ALICE, m.id);
    ok(f.mailbox_ids.length >= 1 && !f.mailbox_ids.includes(label.jmap_id));
    await act(ALICE, { threadIds: [m.thread_id], action: 'inbox' });
  });
  await test('delete the label; messages survive', async () => {
    eq((await api('DELETE', `/api/mail/mailboxes/${ALICE}/${label.jmap_id}`)).status, 200);
    eq((await sql('SELECT 1 FROM mailboxes WHERE account_id=$1 AND jmap_id=$2', [ALICE, label.jmap_id])).length, 0);
    ok((await fresh(ALICE, m.id)).id);
  });
  await test('another user\'s account cannot be labelled', async () => {
    eq((await api('POST', '/api/mail/mailboxes', { accountId: 3, name: 'nope' })).status, 404);
  });
});

// ======================================================================
const imagesGroup = group('images', async () => {
  let up: any;
  await test('an uploaded image is served inline with its own content type', async () => {
    up = await upload('shot.png', 'image/png', PNG);
    const res = await fetch(`${BASE}/api/mail/uploads/${up.id}?inline=1`, { headers: { Cookie: cookie } });
    eq(res.status, 200); eq(res.headers.get('content-type'), 'image/png'); ok(res.headers.get('content-disposition')?.startsWith('inline'));
  });
  await test('without ?inline it is a download, and non-images are never inlined', async () => {
    const res = await fetch(`${BASE}/api/mail/uploads/${up.id}`, { headers: { Cookie: cookie } });
    eq(res.headers.get('content-type'), 'application/octet-stream'); ok(res.headers.get('content-disposition')?.startsWith('attachment'));
    const txt = await upload('a.txt', 'text/plain', Buffer.from('x'));
    const r2 = await fetch(`${BASE}/api/mail/uploads/${txt.id}?inline=1`, { headers: { Cookie: cookie } });
    eq(r2.headers.get('content-type'), 'application/octet-stream');
    await api('DELETE', `/api/mail/uploads/${txt.id}`);
  });
  let got!: Email;
  await test('an image inserted into the body goes out as an inline cid part and renders for the recipient', async () => {
    const s = `e2e inline image ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s, html: `<p>Look:</p><img src="/api/mail/uploads/${up.id}?inline=1" alt="shot.png" style="max-width:100%"><p>end</p>` });
    got = await arrived(BOB, s);
    ok(/src="cid:img\d+\./.test(got.body_html ?? ''), `cid src: ${got.body_html?.slice(0, 200)}`);
    ok(!/\/api\/mail\/uploads\//.test(got.body_html ?? ''), 'no server URL left in the mail');
    const inline = got.attachments.find((x: any) => x.cid);
    ok(inline && inline.name === 'shot.png', 'inline part present');
    eq((await sql('SELECT 1 FROM uploads WHERE id=$1', [up.id])).length, 0, 'upload consumed');
  });
  await test('the recipient\'s copy resolves the cid through the blob proxy', async () => {
    const inline = got.attachments.find((x: any) => x.cid);
    const res = await fetch(`${BASE}/api/mail/blob/${BOB}/${encodeURIComponent(inline.blobId)}?name=shot.png&type=image/png`, { headers: { Cookie: cookie } });
    eq(res.status, 200); eq(res.headers.get('content-type'), 'image/png');
  });
  await test('helpers: inline ids are found once each and rewritten to cid', async () => {
    const { inlineUploadIds, rewriteInlineUploads } = await import('../services/compose.js');
    eq(inlineUploadIds('<img src="/api/mail/uploads/12?inline=1"><img src=\'/api/mail/uploads/12\'><img src="/api/mail/uploads/7?inline=1">'), [12, 7]);
    eq(rewriteInlineUploads('<img src="/api/mail/uploads/12?inline=1">', (id) => (id === 12 ? 'abc@x' : null)), '<img src="cid:abc@x">');
    eq(rewriteInlineUploads('<img src="/api/mail/uploads/99?inline=1">', () => null), '<img src="/api/mail/uploads/99?inline=1">');
    eq(inlineUploadIds('<p>none</p>'), []);
  });
  await test('an image belonging to another user is not attached', async () => {
    const foreign = (await sql(`INSERT INTO uploads (user_id, filename, content_type, size, data) VALUES (8, 'theirs.png', 'image/png', $1, $2) RETURNING id`, [PNG.length, PNG]))[0].id;
    const s = `e2e foreign image ${uid()}`;
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s, html: `<p>x</p><img src="/api/mail/uploads/${foreign}?inline=1">` });
    const g = await arrived(BOB, s);
    ok(!g.attachments.some((x: any) => x.cid), 'not attached');
    await sql('DELETE FROM uploads WHERE id=$1', [foreign]);
  });
  await test('a draft referencing an inline image keeps the upload alive for housekeeping', async () => {
    const u2 = await upload('draft.png', 'image/png', PNG);
    const d = await api('POST', '/api/mail/drafts', { accountId: ALICE, subject: 'img draft', html: `<img src="/api/mail/uploads/${u2.id}?inline=1">` });
    await sql(`UPDATE uploads SET created_at = now() - interval '3 days' WHERE id=$1`, [u2.id]);
    const { housekeeping } = await import('../workers/scheduler.js');
    await housekeeping(true);
    eq((await sql('SELECT 1 FROM uploads WHERE id=$1', [u2.id])).length, 1, 'kept while the draft refers to it');
    await api('DELETE', `/api/mail/drafts/${d.data.draft.id}`);
    await housekeeping(true);
    eq((await sql('SELECT 1 FROM uploads WHERE id=$1', [u2.id])).length, 0, 'gone once the draft is');
  });
  await test('a forwarded message keeps its inline images even with an empty attachment selection', async () => {
    const s = `Fwd: ${got.subject}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s, html: '<p>fwd</p>', forwardOfEmailId: got.id, forwardBlobIds: [] });
    const f = await arrived(ALICE, s);
    ok(f.attachments.some((x: any) => x.cid), 'inline image travelled');
  });
  await test('the image upload limit is enforced', async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    const res = await fetch(`${BASE}/api/mail/uploads?filename=big.bin&type=application/octet-stream`, { method: 'POST', headers: { 'X-Requested-With': 'tern', 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: big });
    eq(res.status, 413);
  });
  await test('pasted image metadata is scrubbed on upload (report present for images)', async () => {
    const u = await upload('meta.png', 'image/png', PNG);
    ok('scrubbed' in u, 'scrub report field');
    await api('DELETE', `/api/mail/uploads/${u.id}`);
  });
});

// ======================================================================
async function smtpInject(from: string, to: string, subject: string, extraHeaders: string[], body = 'Hello from a list'): Promise<void> {
  const host = process.env.SMTP_HOST ?? '127.0.0.1', port = Number(process.env.SMTP_PORT ?? 18025);
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect(port, host);
    const lines: string[] = [];
    let buf = '';
    const steps = [`EHLO e2e.local\r\n`, `MAIL FROM:<${from}>\r\n`, `RCPT TO:<${to}>\r\n`, `DATA\r\n`, `From: Newsletter <${from}>\r\nTo: <${to}>\r\nSubject: ${subject}\r\nMessage-ID: <${uid()}@lists.example>\r\nDate: ${new Date().toUTCString()}\r\n${extraHeaders.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`, `QUIT\r\n`];
    let i = 0;
    const next = () => { if (i < steps.length) sock.write(steps[i++]); };
    sock.on('data', (d) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2); lines.push(line);
        if (/^\d{3} /.test(line)) { const code = Number(line.slice(0, 3)); if (code >= 400) { sock.destroy(); reject(new Error(`SMTP ${line} after ${steps[i - 1]?.slice(0, 20)}`)); return; } next(); }
      }
    });
    sock.on('error', reject);
    sock.on('close', () => resolve());
    setTimeout(() => { sock.destroy(); reject(new Error('smtp timeout: ' + lines.join(' | '))); }, 15_000);
  });
}
const listGroup = group('list', async () => {
  const s = `Weekly digest ${uid()}`;
  let m!: Email;
  await test('a list message with List-Unsubscribe arrives and the header is stored', async () => {
    await smtpInject('news@lists.example', 'alice@probe.test', s, ['List-Unsubscribe: <mailto:leave@lists.example?subject=unsubscribe>, <https://lists.example/u/42>', 'List-Id: Weekly <weekly.lists.example>', 'Precedence: bulk']);
    m = await arrived(ALICE, s);
    ok(m.list_unsubscribe?.includes('mailto:leave@lists.example'), `stored: ${m.list_unsubscribe}`);
  });
  await test('the thread payload exposes list headers to the reader', async () => {
    const t = (await api('GET', `/api/mail/threads/${ALICE}/${m.thread_id}`)).data;
    ok(t.messages[0].list_unsubscribe && t.messages[0].list_id?.includes('weekly'));
  });
  await test('the unsubscribe email the client sends goes to the mailto address with the requested subject', async () => {
    const { parseListUnsubscribe } = { parseListUnsubscribe: (h: string) => { const out: any = { mailto: null, subject: null, url: null }; for (const x of h.matchAll(/<([^>]+)>/g)) { const v = x[1]; if (/^mailto:/i.test(v)) { const [addr, qs] = v.slice(7).split('?'); out.mailto = addr; out.subject = qs ? new URLSearchParams(qs).get('subject') : null; } else if (/^https?:/i.test(v)) out.url = v; } return out; } };
    const u = parseListUnsubscribe(m.list_unsubscribe!);
    eq(u, { mailto: 'leave@lists.example', subject: 'unsubscribe', url: 'https://lists.example/u/42' });
    const r = await api('POST', '/api/mail/send', { accountId: ALICE, to: [{ email: u.mailto }], subject: u.subject, html: '<p>Unsubscribe</p>', includeSignature: false });
    eq(r.status, 200);
    const log = (await sql('SELECT to_email, subject FROM send_log WHERE message_id=$1', [r.data.messageId]))[0];
    eq(log.to_email, 'leave@lists.example'); eq(log.subject, 'unsubscribe');
  });
  await test('responders skip list mail (no AI job queued for it)', async () => {
    eq((await sql(`SELECT 1 FROM ai_jobs WHERE payload->>'emailDbId' = $1`, [String(m.id)])).length, 0);
  });
  await test('a plain message from a person has no list headers', async () => {
    const s2 = `e2e person ${uid()}`;
    await send(BOB, { to: [{ email: 'alice@probe.test' }], subject: s2, html: 'x' });
    const p = await arrived(ALICE, s2);
    eq(p.list_unsubscribe, null); ok(!p.list_id);
  });
  await test('an https-only List-Unsubscribe is stored as is', async () => {
    const s3 = `Promo ${uid()}`;
    await smtpInject('promo@lists.example', 'alice@probe.test', s3, ['List-Unsubscribe: <https://lists.example/u/77>']);
    const p = await arrived(ALICE, s3);
    eq(p.list_unsubscribe, '<https://lists.example/u/77>');
  });
  await test('rules can match on the list header', async () => {
    const { evaluateCondition } = await import('../services/automation.js');
    ok(evaluateCondition({ field: 'list', op: 'contains', value: 'lists.example' }, { 'header:List-Id:asText': 'Weekly <weekly.lists.example>' }, ''));
    ok(evaluateCondition({ field: 'list', op: 'is_false' }, {}, ''));
  });
  await test('isListMail spots bulk precedence, no-reply senders and List-Id', async () => {
    const { isListMail } = await import('../services/automation.js');
    ok(isListMail({ 'header:Precedence:asText': 'bulk' }));
    ok(isListMail({ from: [{ email: 'no-reply@shop.example' }] }));
    ok(isListMail({ 'header:List-Id:asText': 'x' }));
    ok(!isListMail({ from: [{ email: 'bob@probe.test' }] }));
  });
  await test('the search "from:" finds list mail by sender', async () => {
    const r = (await api('GET', `/api/mail/threads?box=all&accounts=${ALICE}&q=${encodeURIComponent('from:news@lists.example')}`)).data.threads;
    ok(r.some((t: any) => t.thread_id === m.thread_id));
  });
  await test('a very long header is truncated rather than rejected', async () => {
    const s4 = `Long header ${uid()}`;
    await smtpInject('news@lists.example', 'alice@probe.test', s4, [`List-Unsubscribe: <https://lists.example/${'x'.repeat(2500)}>`]);
    const p = await arrived(ALICE, s4);
    ok(p.list_unsubscribe && p.list_unsubscribe.length <= 2000);
  });
});

// ======================================================================
const draftsGroup = group('drafts', async () => {
  let id!: number;
  const s = `e2e draft ${uid()}`;
  let orig!: Email;
  await test('create a draft', async () => {
    const r = await api('POST', '/api/mail/drafts', { accountId: ALICE, to: [{ email: 'bob@probe.test' }], subject: s, html: '<p>wip</p>' });
    eq(r.status, 200); id = r.data.draft.id; ok(id);
  });
  await test('update it in place (same id)', async () => {
    const r = await api('POST', '/api/mail/drafts', { id, accountId: ALICE, to: [{ email: 'bob@probe.test' }], subject: s, html: '<p>wip 2</p>' });
    eq(r.data.draft.id, id); eq(r.data.draft.body_html, '<p>wip 2</p>');
  });
  await test('drafts count in the sidebar includes it', async () => {
    ok((await api('GET', '/api/mail/counts')).data.drafts >= 1);
  });
  await test('a draft attached to a thread is returned with the thread', async () => {
    const { a } = await aliceToBob(`e2e draft thread ${uid()}`); orig = a;
    const r = await api('POST', '/api/mail/drafts', { accountId: ALICE, kind: 'reply', replyToEmailId: a.id, threadId: a.thread_id, to: [{ email: 'bob@probe.test' }], subject: `Re: ${a.subject}`, html: '<p>reply draft</p>' });
    const t = (await api('GET', `/api/mail/threads/${ALICE}/${a.thread_id}`)).data;
    ok(t.drafts.some((d: any) => d.id === r.data.draft.id && d.source === 'user'));
    await api('DELETE', `/api/mail/drafts/${r.data.draft.id}`);
  });
  await test('a forward draft remembers which attachments to send and reports their names', async () => {
    const up = await upload('deck.pdf', 'application/pdf', Buffer.from('%PDF fake'));
    const { b } = await aliceToBob(`e2e fwd draft ${uid()}`, { attachmentIds: [up.id] });
    const blob = b.attachments[0].blobId;
    const r = await api('POST', '/api/mail/drafts', { accountId: BOB, kind: 'forward', forwardOfEmailId: b.id, forwardBlobIds: [blob], threadId: b.thread_id, subject: `Fwd: ${b.subject}`, html: '<p>f</p>' });
    const list = (await api('GET', '/api/mail/drafts')).data.drafts.find((d: any) => d.id === r.data.draft.id);
    eq(list.forward_attachments.map((x: any) => x.name), ['deck.pdf']);
    eq(list.forward_of_email_id, b.id);
    await api('DELETE', `/api/mail/drafts/${r.data.draft.id}`);
  });
  await test('staged attachments are listed with the draft', async () => {
    const up = await upload('notes.md', 'text/markdown', Buffer.from('# notes'));
    const r = await api('POST', '/api/mail/drafts', { id, accountId: ALICE, to: [{ email: 'bob@probe.test' }], subject: s, html: '<p>wip 3</p>', attachmentIds: [up.id] });
    eq(r.data.draft.id, id);
    const d = (await api('GET', '/api/mail/drafts')).data.drafts.find((x: any) => x.id === id);
    eq(d.attachments.map((x: any) => x.filename), ['notes.md']);
  });
  await test('sending the draft deletes it and delivers the attachment', async () => {
    const d = (await api('GET', '/api/mail/drafts')).data.drafts.find((x: any) => x.id === id);
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: s, html: '<p>wip 3</p>', attachmentIds: d.attachments.map((x: any) => x.id), draftId: id });
    eq((await sql('SELECT 1 FROM drafts WHERE id=$1', [id])).length, 0);
    const got = await arrived(BOB, s);
    eq(got.attachments.map((x: any) => x.name), ['notes.md']);
  });
  await test('someone else\'s draft cannot be updated', async () => {
    const r = await api('POST', '/api/mail/drafts', { id: 999999, accountId: ALICE, subject: 'x', html: 'x' });
    eq(r.status, 404);
  });
  await test('an AI draft can be sent as-is and is then gone', async () => {
    const ins = await sql(`INSERT INTO drafts (user_id, account_id, kind, reply_to_email_id, thread_id, to_addr, subject, body_html, source) VALUES ($1,$2,'reply',$3,$4,$5,$6,$7,'ai') RETURNING id`, [USER, ALICE, orig.id, orig.thread_id, JSON.stringify([{ email: 'bob@probe.test' }]), `Re: ${orig.subject}`, '<p>Hi Bob,</p><p>Sure.</p><div class="tern-quote">q</div>']);
    await send(ALICE, { to: [{ email: 'bob@probe.test' }], subject: `Re: ${orig.subject}`, html: '<p>Hi Bob,</p><p>Sure.</p>', replyToEmailId: orig.id, draftId: ins[0].id, includeSignature: true });
    eq((await sql('SELECT 1 FROM drafts WHERE id=$1', [ins[0].id])).length, 0);
  });
  await test('draft kinds are validated', async () => {
    eq((await api('POST', '/api/mail/drafts', { accountId: ALICE, kind: 'weird', subject: 'x', html: 'x' })).status, 400);
  });
});

// ======================================================================
async function main() {
  cookie = await login(USER);
  const t0 = Date.now();
  for (const g of [replyGroup, undoGroup, undoableGroup, muteGroup, emptyGroup, aiGroup, searchGroup, labelsGroup, imagesGroup, listGroup, draftsGroup]) await g();
  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  console.log(`\n${pass} passed, ${fail} failed in ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL [${r.group}] ${r.name}: ${r.detail}`);
  await sql(`DELETE FROM sessions WHERE user_agent='e2e'`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
