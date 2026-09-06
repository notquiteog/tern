// Sealing and opening the parts of a cached message, and building its blind
// index terms. Everything that writes to `emails` goes through sealEmail;
// everything that reads a row for display or for the AI goes through
// openEmail. Keeping both in one place is what makes it possible to say
// which columns are ciphertext and which are not.
//
// Plain, on purpose:
//   mailbox_ids, keywords, received_at, sent_at, size, has_attachment,
//   thread_id, jmap_id, blob_id — the inbox itself is built from these, and
//   they say little: that a message arrived, unread, with a file.
//   message_id, in_reply_to, references_ids — random tokens plus a domain,
//   and threading and reply detection are impossible without them.
// Ciphertext:
//   subject, preview, body_text, body_html, every address list, and the
//   attachment metadata (names leak as much as bodies).
import { addressKey, addressTermsWith, dataKey, indexTermsWith, openWith, searchKey, sealWith } from './vault.js';

export interface Addr { name?: string | null; email: string }

// The columns sealEmail produces, in the order the sync writer uses them.
export interface SealedContent {
  subject: string; preview: string; body_text: string | null; body_html: string | null;
  from_addr: string; to_addr: string; cc_addr: string; bcc_addr: string; reply_to: string;
  attachments: string;
  search_terms: Buffer[]; address_terms: Buffer[]; from_terms: Buffer[];
}

export interface PlainContent {
  subject: string; preview: string; body_text: string | null; body_html: string | null;
  from_addr: Addr[]; to_addr: Addr[]; cc_addr: Addr[]; bcc_addr: Addr[]; reply_to: Addr[];
  attachments: unknown[];
}

const emails = (list: Addr[] | undefined): string[] => (list ?? []).map((a) => String(a?.email ?? '')).filter(Boolean);

export async function sealEmail(userId: number, c: PlainContent): Promise<SealedContent> {
  const dek = await dataKey(userId);
  const sk = searchKey(dek);
  const ak = addressKey(dek);
  const s = (v: string | null) => sealWith(dek, v);
  const j = (v: unknown) => sealWith(dek, JSON.stringify(v ?? []))!;

  // What the blind index covers: the subject and the body, plus the names on
  // the message so "from Ana" finds it. Addresses have their own index.
  const searchable = [
    c.subject ?? '',
    c.body_text || stripTags(c.body_html ?? '') || c.preview || '',
    ...[...(c.from_addr ?? []), ...(c.to_addr ?? []), ...(c.cc_addr ?? [])].map((a) => `${a?.name ?? ''} ${a?.email ?? ''}`),
  ].join('\n').slice(0, 400_000);

  return {
    subject: s(c.subject ?? '')!,
    preview: s(c.preview ?? '')!,
    body_text: s(c.body_text ?? null),
    body_html: s(c.body_html ?? null),
    from_addr: j(c.from_addr), to_addr: j(c.to_addr), cc_addr: j(c.cc_addr), bcc_addr: j(c.bcc_addr), reply_to: j(c.reply_to),
    attachments: j(c.attachments),
    search_terms: indexTermsWith(sk, searchable),
    address_terms: addressTermsWith(ak, [...emails(c.from_addr), ...emails(c.to_addr), ...emails(c.cc_addr), ...emails(c.bcc_addr)]),
    from_terms: addressTermsWith(ak, emails(c.from_addr)),
  };
}

// Turns a row as it came out of Postgres back into the shape the rest of the
// app has always seen. Rows the backfill has not reached are plaintext and
// pass through unchanged, so a read never has to ask which it is holding.
export async function openEmail<T extends Record<string, any>>(userId: number, row: T): Promise<T> {
  if (!row) return row;
  const dek = await dataKey(userId);
  return openEmailWith(dek, row);
}

export function openEmailWith<T extends Record<string, any>>(dek: Buffer, row: T): T {
  const out: Record<string, any> = { ...row };
  for (const k of ['subject', 'preview', 'body_text', 'body_html'] as const) {
    if (k in out) out[k] = openWith(dek, out[k]) ?? (k === 'subject' || k === 'preview' ? '' : null);
  }
  for (const k of ['from_addr', 'to_addr', 'cc_addr', 'bcc_addr', 'reply_to', 'attachments'] as const) {
    if (k in out) out[k] = parseList(openWith(dek, out[k]));
  }
  // Was a generated column over the plaintext; the callers that used it want
  // the sender's address and nothing more.
  if ('from_addr' in out) out.from_email = String(out.from_addr?.[0]?.email ?? '').toLowerCase() || null;
  // Never leave the index terms on a row that is about to be serialised: the
  // browser has no use for them and they are the one part a reader should
  // not be handed.
  delete out.search_terms; delete out.address_terms; delete out.from_terms;
  return out as T;
}

// Opens many rows for one user with a single key lookup.
export async function openEmails<T extends Record<string, any>>(userId: number, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const dek = await dataKey(userId);
  return rows.map((r) => openEmailWith(dek, r));
}

function parseList(text: string | null): any[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Body HTML is indexed by its text, not its markup: nobody searches for
// "div", and indexing tag names would fill every message's terms with the
// same handful of hashes.
function stripTags(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ');
}

// ---------- Drafts ----------
// A draft is unsent mail and gets the same treatment: subject, body and
// recipients sealed. The staged upload ids stay plain — they are this user's
// own files, referenced by number, and the uploads table is keyed by user.

// The composer sends either a bare address or a {name, email}; both are
// stored as objects so a reader never has to ask which it has.
export type AddrInput = string | { name?: string | null; email: string };
export interface PlainDraft { subject: string; body_html: string; to_addr: AddrInput[]; cc_addr: AddrInput[]; bcc_addr: AddrInput[] }

function asAddrs(list: AddrInput[] | undefined): Addr[] {
  return (list ?? []).map((a) => (typeof a === 'string' ? { name: null, email: a } : { name: a?.name ?? null, email: a?.email ?? '' })).filter((a) => a.email);
}

export async function sealDraft(userId: number, d: PlainDraft): Promise<{ subject: string; body_html: string; to_addr: string; cc_addr: string; bcc_addr: string }> {
  const dek = await dataKey(userId);
  return {
    subject: sealWith(dek, d.subject ?? '')!,
    body_html: sealWith(dek, d.body_html ?? '')!,
    to_addr: sealWith(dek, JSON.stringify(asAddrs(d.to_addr)))!,
    cc_addr: sealWith(dek, JSON.stringify(asAddrs(d.cc_addr)))!,
    bcc_addr: sealWith(dek, JSON.stringify(asAddrs(d.bcc_addr)))!,
  };
}

export function openDraftWith<T extends Record<string, any>>(dek: Buffer, row: T): T {
  const out: Record<string, any> = { ...row };
  for (const k of ['subject', 'body_html'] as const) if (k in out) out[k] = openWith(dek, out[k]) ?? '';
  for (const k of ['to_addr', 'cc_addr', 'bcc_addr'] as const) if (k in out) out[k] = parseList(openWith(dek, out[k]));
  return out as T;
}

export async function openDraft<T extends Record<string, any>>(userId: number, row: T): Promise<T> {
  return openDraftWith(await dataKey(userId), row);
}

export async function openDrafts<T extends Record<string, any>>(userId: number, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const dek = await dataKey(userId);
  return rows.map((r) => openDraftWith(dek, r));
}

// ---------- The review queue ----------
// An AI-drafted reply waiting for a person, plus `context`: a slice of the
// message it answers. Both are mail content.

export async function sealReview(userId: number, r: { subject: string; body_html: string; context?: string | null; to_addr?: AddrInput[] | null }): Promise<{ subject: string; body_html: string; context: string | null; to_addr: string | null }> {
  const dek = await dataKey(userId);
  return {
    subject: sealWith(dek, r.subject ?? '')!,
    body_html: sealWith(dek, r.body_html ?? '')!,
    context: r.context === null || r.context === undefined ? null : sealWith(dek, r.context),
    to_addr: r.to_addr === null || r.to_addr === undefined ? null : sealWith(dek, JSON.stringify(asAddrs(r.to_addr))),
  };
}

export function openReviewWith<T extends Record<string, any>>(dek: Buffer, row: T): T {
  const out: Record<string, any> = { ...row };
  for (const k of ['subject', 'body_html'] as const) if (k in out) out[k] = openWith(dek, out[k]) ?? '';
  if ('context' in out) out.context = openWith(dek, out.context);
  if ('to_addr' in out) out.to_addr = parseList(openWith(dek, out.to_addr));
  return out as T;
}

export async function openReview<T extends Record<string, any>>(userId: number, row: T | null): Promise<T | null> {
  if (!row) return row;
  return openReviewWith(await dataKey(userId), row);
}

export async function openReviews<T extends Record<string, any>>(userId: number, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const dek = await dataKey(userId);
  return rows.map((r) => openReviewWith(dek, r));
}
