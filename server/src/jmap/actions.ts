// Mailbox actions. Each one updates the local cache optimistically, then
// pushes the same change to the server; the next sync reconciles. Keywords
// and mailbox membership are the whole model: archive is "not in inbox",
// trash is "only in trash", a label is "also in that mailbox".
import { one, query } from '../db.js';
import { clientFor, type AccountRow } from '../services/accounts.js';
import { notFound } from '../errors.js';
import { touchAccount } from '../services/mailCache.js';

export interface MailboxRow { id: number; account_id: number; jmap_id: string; name: string; parent_id: string | null; role: string | null; sort_order: number; total_emails: number; unread_emails: number; total_threads: number; unread_threads: number; color: string | null }

export async function mailboxByRole(accountId: number, role: string): Promise<MailboxRow | null> {
  return one<MailboxRow>('SELECT * FROM mailboxes WHERE account_id=$1 AND role=$2 ORDER BY id LIMIT 1', [accountId, role]);
}

export async function mailboxByJmapId(accountId: number, jmapId: string): Promise<MailboxRow | null> {
  return one<MailboxRow>('SELECT * FROM mailboxes WHERE account_id=$1 AND jmap_id=$2', [accountId, jmapId]);
}

// Servers differ on whether an Archive mailbox exists. JMAP requires every
// message to sit in at least one mailbox, so archiving from a message that
// is only in Inbox needs somewhere to go. Create it once, remember it.
export async function ensureArchive(acc: AccountRow): Promise<MailboxRow> {
  const existing = await mailboxByRole(acc.id, 'archive');
  if (existing) return existing;
  const byName = await one<MailboxRow>(`SELECT * FROM mailboxes WHERE account_id=$1 AND lower(name)='archive' LIMIT 1`, [acc.id]);
  if (byName) return byName;
  return createMailbox(acc, 'Archive', null, 'archive');
}

export async function createMailbox(acc: AccountRow, name: string, parentJmapId: string | null, role: string | null = null): Promise<MailboxRow> {
  const client = clientFor(acc);
  const accountId = client.session!.accountId;
  const create: Record<string, unknown> = { name, parentId: parentJmapId };
  if (role) create.role = role;
  let res = await client.one('Mailbox/set', { accountId, create: { m: create } });
  if (res.notCreated?.m && role) {
    // Some servers refuse client-set roles; retry as a plain folder.
    res = await client.one('Mailbox/set', { accountId, create: { m: { name, parentId: parentJmapId } } });
  }
  const id = res.created?.m?.id;
  if (!id) throw new Error(`Could not create mailbox: ${JSON.stringify(res.notCreated?.m ?? res)}`);
  const rows = await query<MailboxRow>(
    `INSERT INTO mailboxes (account_id, jmap_id, name, parent_id, role) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (account_id, jmap_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
    [acc.id, id, name, parentJmapId, res.created.m.role ?? role],
  );
  return rows[0];
}

export async function renameMailbox(acc: AccountRow, jmapId: string, name: string): Promise<void> {
  const client = clientFor(acc);
  const res = await client.one('Mailbox/set', { accountId: client.session!.accountId, update: { [jmapId]: { name } } });
  if (res.notUpdated?.[jmapId]) throw new Error(`Rename failed: ${res.notUpdated[jmapId].type}`);
  await query('UPDATE mailboxes SET name=$3 WHERE account_id=$1 AND jmap_id=$2', [acc.id, jmapId, name]);
}

export async function destroyMailbox(acc: AccountRow, jmapId: string): Promise<void> {
  const client = clientFor(acc);
  const res = await client.one('Mailbox/set', { accountId: client.session!.accountId, destroy: [jmapId], onDestroyRemoveEmails: false });
  if (res.notDestroyed?.[jmapId]) throw new Error(`Delete failed: ${res.notDestroyed[jmapId].type}${res.notDestroyed[jmapId].description ? ' - ' + res.notDestroyed[jmapId].description : ''}`);
  await query('DELETE FROM mailboxes WHERE account_id=$1 AND jmap_id=$2', [acc.id, jmapId]);
}

// Apply one patch to many emails in a single Email/set.
async function patchAll(acc: AccountRow, jmapIds: string[], patchFor: (id: string) => Record<string, unknown>): Promise<void> {
  if (!jmapIds.length) return;
  const client = clientFor(acc);
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of jmapIds) update[id] = patchFor(id);
  for (let i = 0; i < jmapIds.length; i += 200) {
    const slice = Object.fromEntries(jmapIds.slice(i, i + 200).map((id) => [id, update[id]]));
    const res = await client.one('Email/set', { accountId: client.session!.accountId, update: slice });
    const failed = res.notUpdated ? Object.keys(res.notUpdated) : [];
    if (failed.length === jmapIds.length) {
      const first = res.notUpdated[failed[0]];
      throw new Error(`Server refused the update: ${first?.type}${first?.description ? ' - ' + first.description : ''}`);
    }
  }
}

export async function setKeyword(acc: AccountRow, jmapIds: string[], keyword: string, on: boolean): Promise<void> {
  await query(
    on
      ? `UPDATE emails SET keywords = array_append(array_remove(keywords, $3), $3), updated_at=now() WHERE account_id=$1 AND jmap_id = ANY($2)`
      : `UPDATE emails SET keywords = array_remove(keywords, $3), updated_at=now() WHERE account_id=$1 AND jmap_id = ANY($2)`,
    [acc.id, jmapIds, keyword],
  );
  touchAccount(acc.id);
  await patchAll(acc, jmapIds, () => ({ [`keywords/${keyword}`]: on ? true : null }));
}

export async function addToMailbox(acc: AccountRow, jmapIds: string[], mailboxJmapId: string): Promise<void> {
  await query(`UPDATE emails SET mailbox_ids = array_append(array_remove(mailbox_ids, $3), $3), updated_at=now() WHERE account_id=$1 AND jmap_id = ANY($2)`, [acc.id, jmapIds, mailboxJmapId]);
  touchAccount(acc.id);
  await patchAll(acc, jmapIds, () => ({ [`mailboxIds/${mailboxJmapId}`]: true }));
}

// Remove from a mailbox, moving to `fallback` when it was the only one.
export async function removeFromMailbox(acc: AccountRow, jmapIds: string[], mailboxJmapId: string, fallback: string | null): Promise<void> {
  const rows = await query<{ jmap_id: string; mailbox_ids: string[] }>('SELECT jmap_id, mailbox_ids FROM emails WHERE account_id=$1 AND jmap_id = ANY($2)', [acc.id, jmapIds]);
  const needFallback = new Set(rows.filter((r) => r.mailbox_ids.every((m) => m === mailboxJmapId)).map((r) => r.jmap_id));
  await query(`UPDATE emails SET mailbox_ids = array_remove(mailbox_ids, $3), updated_at=now() WHERE account_id=$1 AND jmap_id = ANY($2)`, [acc.id, jmapIds, mailboxJmapId]);
  touchAccount(acc.id);
  if (fallback && needFallback.size) {
    await query(`UPDATE emails SET mailbox_ids = array_append(mailbox_ids, $3) WHERE account_id=$1 AND jmap_id = ANY($2)`, [acc.id, [...needFallback], fallback]);
  }
  await patchAll(acc, jmapIds, (id) => {
    const patch: Record<string, unknown> = { [`mailboxIds/${mailboxJmapId}`]: null };
    if (fallback && needFallback.has(id)) patch[`mailboxIds/${fallback}`] = true;
    return patch;
  });
}

export async function moveToOnly(acc: AccountRow, jmapIds: string[], mailboxJmapId: string): Promise<void> {
  await query(`UPDATE emails SET mailbox_ids = ARRAY[$3]::text[], updated_at=now() WHERE account_id=$1 AND jmap_id = ANY($2)`, [acc.id, jmapIds, mailboxJmapId]);
  touchAccount(acc.id);
  await patchAll(acc, jmapIds, () => ({ mailboxIds: { [mailboxJmapId]: true } }));
}

// Put messages back exactly where they were: the undo of archive, trash,
// junk, move and label. Each message gets its own mailbox set.
export async function restoreMailboxes(acc: AccountRow, items: { jmapId: string; mailboxIds: string[] }[]): Promise<void> {
  const valid = items.filter((i) => i.mailboxIds.length);
  if (!valid.length) return;
  const known = new Set((await query<{ jmap_id: string }>('SELECT jmap_id FROM mailboxes WHERE account_id=$1', [acc.id])).map((r) => r.jmap_id));
  const usable = valid.map((i) => ({ jmapId: i.jmapId, mailboxIds: i.mailboxIds.filter((m) => known.has(m)) })).filter((i) => i.mailboxIds.length);
  for (const i of usable) await query(`UPDATE emails SET mailbox_ids=$3::text[], updated_at=now() WHERE account_id=$1 AND jmap_id=$2`, [acc.id, i.jmapId, i.mailboxIds]);
  touchAccount(acc.id);
  const byId = new Map(usable.map((i) => [i.jmapId, i.mailboxIds]));
  await patchAll(acc, [...byId.keys()], (id) => ({ mailboxIds: Object.fromEntries(byId.get(id)!.map((m) => [m, true])) }));
}

export async function destroyEmails(acc: AccountRow, jmapIds: string[]): Promise<void> {
  const client = clientFor(acc);
  await query('DELETE FROM emails WHERE account_id=$1 AND jmap_id = ANY($2)', [acc.id, jmapIds]);
  touchAccount(acc.id);
  await client.one('Email/set', { accountId: client.session!.accountId, destroy: jmapIds });
}

export async function archive(acc: AccountRow, jmapIds: string[]): Promise<void> {
  const inbox = await mailboxByRole(acc.id, 'inbox');
  if (!inbox) throw notFound('No inbox mailbox on this account');
  const arch = await ensureArchive(acc);
  await removeFromMailbox(acc, jmapIds, inbox.jmap_id, arch.jmap_id);
}

export async function trash(acc: AccountRow, jmapIds: string[]): Promise<void> {
  const t = await mailboxByRole(acc.id, 'trash');
  if (!t) throw notFound('No trash mailbox on this account');
  await moveToOnly(acc, jmapIds, t.jmap_id);
}

export async function spam(acc: AccountRow, jmapIds: string[]): Promise<void> {
  const j = (await mailboxByRole(acc.id, 'junk')) ?? (await mailboxByRole(acc.id, 'spam'));
  if (!j) throw notFound('No junk mailbox on this account');
  await moveToOnly(acc, jmapIds, j.jmap_id);
}

export async function toInbox(acc: AccountRow, jmapIds: string[]): Promise<void> {
  const inbox = await mailboxByRole(acc.id, 'inbox');
  if (!inbox) throw notFound('No inbox mailbox on this account');
  await moveToOnly(acc, jmapIds, inbox.jmap_id);
}
