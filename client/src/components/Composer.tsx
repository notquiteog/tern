import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Paperclip, Send, Sparkles, Trash2, X, Clock, Shuffle, FileText, ShieldCheck, Lock, LockOpen, PenLine, Reply, ReplyAll, Forward, ExternalLink, Archive, CloudDownload, MoreHorizontal, Pencil } from 'lucide-react';
import { usePgp } from '../state/pgp';
import { encryptText, signDetached } from '../lib/pgp';
import { buildMime, htmlToPlain } from '../lib/mime';
import { useDebounced } from '../lib/hooks';
import { api } from '../api';
import { useCompose, seedFromDraft, type ComposeSeed, type ForwardAttachment, type Upload } from '../state/compose';
import { useToast } from '../state/toast';
import { useAccounts, useTemplates } from '../lib/queries';
import { useMailPrefs } from '../state/mailPrefs';
import { AddressInput } from './AddressInput';
import { Editor, type EditorHandle } from './Editor';
import { AiPanel } from './AiPanel';
import { Avatar, Button, IconButton, Menu, MenuItem, Modal, Input, Field } from './ui';
import { cls, fmtBytes, localDateTimeValue, textToHtml, type Addr } from '../lib/format';
import { bodyText, isBlankHtml, joinBody, mentionsAttachment, splitBody } from '../lib/body';

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export type ComposeKind = 'new' | 'reply' | 'reply_all' | 'forward';
// What switching between reply, reply all and forward changes; the typed text stays.
export type KindOptions = Partial<Record<ComposeKind, { to: Addr[]; cc: Addr[]; subject: string; quoteHtml: string; replyToEmailId?: number | null; forwardOfEmailId?: number | null; forwardAttachments?: ForwardAttachment[] }>>;

export interface ComposerProps {
  seed: ComposeSeed;
  variant: 'window' | 'inline';
  onClose: () => void;
  onPopOut?: (seed: ComposeSeed) => void;
  onDraftId?: (id: number | null) => void;
  onSent?: () => void;
  onEscape?: () => void;
  kindOptions?: KindOptions;
  // The window title bar is drawn by the parent; the inline variant draws its own header.
  header?: (a: { close: () => void; subject: string; kind: ComposeKind }) => ReactNode;
}

const KIND_LABEL: Record<ComposeKind, string> = { new: 'New message', reply: 'Reply', reply_all: 'Reply all', forward: 'Forward' };
const KIND_ICON: Record<ComposeKind, ReactNode> = { new: <Pencil size={14} />, reply: <Reply size={14} />, reply_all: <ReplyAll size={14} />, forward: <Forward size={14} />, };

function inlineUploadIds(html: string): number[] {
  return [...new Set([...html.matchAll(/\/api\/mail\/uploads\/(\d+)/g)].map((m) => Number(m[1])))];
}

export function Composer({ seed, variant, onClose, onPopOut, onDraftId, onSent, onEscape, kindOptions, header }: ComposerProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const compose = useCompose();
  const [prefs] = useMailPrefs();
  const { data: accounts = [] } = useAccounts();
  const { data: templates = [] } = useTemplates();
  const editor = useRef<EditorHandle>(null);
  const [kind, setKind] = useState<ComposeKind>(seed.kind ?? 'new');
  const [accountId, setAccountId] = useState<number | null>(seed.accountId ?? null);
  const [to, setTo] = useState<Addr[]>(seed.to ?? []);
  const [cc, setCc] = useState<Addr[]>(seed.cc ?? []);
  const [bcc, setBcc] = useState<Addr[]>(seed.bcc ?? []);
  const [showCc, setShowCc] = useState(Boolean(seed.cc?.length));
  const [showBcc, setShowBcc] = useState(Boolean(seed.bcc?.length));
  const [subject, setSubject] = useState(seed.subject ?? '');
  const [subjectShown, setSubjectShown] = useState(variant === 'window' || seed.kind === 'forward' || seed.kind === 'new');
  const [attachments, setAttachments] = useState<Upload[]>(seed.attachments ?? []);
  const [fwdAttachments, setFwdAttachments] = useState<ForwardAttachment[]>(seed.forwardAttachments ?? []);
  const replyToEmailId = useRef<number | null>(seed.replyToEmailId ?? null);
  const forwardOfEmailId = useRef<number | null>(seed.forwardOfEmailId ?? null);
  const [ai, setAi] = useState(Boolean(seed.autoAi));
  const [sending, setSending] = useState(false);
  const [schedule, setSchedule] = useState<null | string>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'subject' | 'attachment'; opts: SendOpts } | null>(null);
  const [draftId, setDraftId] = useState<number | null>(seed.draftId ?? null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closing = useRef(false);

  useEffect(() => { if (accountId === null && accounts.length) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const account = accounts.find((a) => a.id === accountId);

  // The body: what the person types (plus their signature) lives in the
  // editor; the quoted original stays outside, collapsed, until asked for.
  const initial = useMemo(() => {
    const parts = seed.html ? splitBody(seed.html) : { main: '', signature: null as string | null, quote: null as string | null };
    let main = parts.main;
    if (seed.initialText) main = textToHtml(seed.initialText) + (isBlankHtml(main) ? '' : main);
    if (isBlankHtml(main)) main = '<p><br></p>';
    const quote = parts.quote ?? seed.quoteHtml ?? null;
    const expanded = seed.kind === 'forward';
    return { main, signature: parts.signature, quote, expanded };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [quote, setQuote] = useState<string | null>(initial.quote);
  const [quoteShown, setQuoteShown] = useState(initial.expanded);
  const html = useRef(joinBody({ main: initial.main, signature: initial.signature, quote: initial.expanded ? initial.quote : null }));
  const sigApplied = useRef(initial.signature !== null);
  const sigAccount = useRef<number | null>(null);

  // The account's signature goes in once it is known, and follows a change of sending account.
  useEffect(() => {
    if (!account) return;
    const sig = account.signature_html?.trim() || null;
    if (sigApplied.current && sigAccount.current === null) { sigAccount.current = account.id; return; }
    if (sigApplied.current && sigAccount.current === account.id) return;
    const parts = splitBody(editor.current?.getHtml() ?? html.current);
    sigApplied.current = true;
    sigAccount.current = account.id;
    if ((parts.signature ?? null) === sig) return;
    const wasDirty = dirty;
    const next = joinBody({ main: parts.main, signature: sig, quote: parts.quote });
    editor.current?.setHtml(next);
    html.current = next;
    if (!wasDirty) setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const fullHtml = useCallback(() => (quote && !quoteShown ? html.current + quote : html.current), [quote, quoteShown]);
  // A reply with nothing typed is not worth keeping; a new message counts as started once it has a recipient or subject.
  const isEmpty = () => isBlankHtml(splitBody(html.current).main) && !attachments.length && (kind !== 'new' || (!subject.trim() && !to.length && !cc.length && !bcc.length));

  // ---- OpenPGP: encrypt when every recipient has a key, sign on request ----
  const { requestKey } = usePgp();
  const { data: myKey } = useQuery({ queryKey: ['pgp-me'], queryFn: () => api.get<{ key: { publicKey: string } | null; hasPrivate: boolean }>('/api/pgp/me'), staleTime: 60_000 });
  const allEmails = useDebounced([...to, ...cc, ...bcc].map((a) => a.email.toLowerCase()).filter(Boolean).sort().join(','), 400);
  const { data: recipientKeys } = useQuery({ queryKey: ['pgp-recipients', allEmails], queryFn: () => api.get<{ keys: Record<string, { fingerprint: string; publicKey: string }> }>(`/api/pgp/recipients?emails=${encodeURIComponent(allEmails)}`).then((r) => r.keys), enabled: allEmails.length > 0, staleTime: 60_000 });
  const emailList = allEmails ? allEmails.split(',') : [];
  const missingKeys = emailList.filter((e) => !recipientKeys?.[e]);
  const canEncrypt = emailList.length > 0 && missingKeys.length === 0;
  const [encryptPref, setEncryptPref] = useState<boolean | null>(null);
  const encrypt = canEncrypt && (encryptPref ?? true);
  const [sign, setSign] = useState<boolean>(() => { try { return localStorage.getItem('tern.pgp.sign') === '1'; } catch { return false; } });
  const canSign = Boolean(myKey?.key) && (myKey?.hasPrivate || Boolean(localStorage.getItem('tern.pgp.privateKey')));
  useEffect(() => { try { localStorage.setItem('tern.pgp.sign', sign ? '1' : '0'); } catch { /* ignore */ } }, [sign]);
  const showPgpBar = Boolean(myKey?.key) || (emailList.length > 0 && Object.keys(recipientKeys ?? {}).length > 0);

  async function protectInBrowser(): Promise<{ mode: 'encrypted' | 'signed'; armored?: string; inner?: string; signature?: string }> {
    const key = await requestKey(encrypt ? 'Sign and encrypt this message' : 'Sign this message');
    const files = await Promise.all(attachments.map(async (a) => ({ name: a.filename, type: a.content_type, data: new Uint8Array(await (await fetch(`/api/mail/uploads/${a.id}`)).arrayBuffer()) })));
    const body = fullHtml();
    const inner = buildMime({ html: body, text: htmlToPlain(body), attachments: files });
    if (encrypt) {
      const keys = [...emailList.map((e) => recipientKeys![e].publicKey), ...(myKey?.key ? [myKey.key.publicKey] : [])];
      return { mode: 'encrypted', armored: await encryptText(inner, keys, key) };
    }
    return { mode: 'signed', inner, signature: await signDetached(inner, key) };
  }

  // ---- drafts ----
  const threadId = seed.threadKey?.split(':')[1] ?? null;
  const save = useCallback(async (force = false) => {
    if (!dirty && !force) return;
    if (closing.current && !force) return;
    try {
      const r = await api.post<{ draft: { id: number } }>('/api/mail/drafts', { id: draftId, accountId, kind, replyToEmailId: replyToEmailId.current, forwardOfEmailId: forwardOfEmailId.current, forwardBlobIds: fwdAttachments.map((a) => a.blobId), threadId, to, cc, bcc, subject, html: fullHtml(), attachmentIds: attachments.map((a) => a.id) });
      if (r.draft.id !== draftId) { setDraftId(r.draft.id); onDraftId?.(r.draft.id); }
      setDirty(false); setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] });
      if (threadId) qc.invalidateQueries({ queryKey: ['thread'] });
      return r.draft.id;
    } catch { /* keep in memory */ }
    return draftId;
  }, [dirty, draftId, accountId, kind, threadId, to, cc, bcc, subject, attachments, fwdAttachments, fullHtml, qc, onDraftId]);
  useEffect(() => { const t = setTimeout(() => void save(), 2000); return () => clearTimeout(t); }, [save]);
  const saveRef = useRef(save); saveRef.current = save;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  async function closeKeepingDraft() {
    closing.current = true;
    if (isEmpty()) { if (draftId) api.del(`/api/mail/drafts/${draftId}`).then(() => { qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); if (threadId) qc.invalidateQueries({ queryKey: ['thread'] }); }).catch(() => {}); onClose(); return; }
    if (dirtyRef.current || !draftId) await saveRef.current(true);
    onClose();
  }
  async function discard() {
    closing.current = true;
    if (draftId) api.del(`/api/mail/drafts/${draftId}`).then(() => { qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); if (threadId) qc.invalidateQueries({ queryKey: ['thread'] }); }).catch(() => {});
    for (const id of [...attachments.map((a) => a.id), ...inlineUploadIds(html.current)]) api.del(`/api/mail/uploads/${id}`).catch(() => {});
    onClose();
  }

  // ---- sending ----
  interface SendOpts { scheduleAt?: string | null; humanize?: boolean; archive?: boolean; skipChecks?: boolean }
  async function send(opts: SendOpts = {}) {
    if (!accountId) { toast.error('Choose a sending account'); return; }
    const recipients = [...to, ...cc, ...bcc];
    if (!recipients.length) { toast.error('Add a recipient'); return; }
    const bad = recipients.filter((a) => !EMAIL_RE.test(a.email));
    if (bad.length) { toast.error(`Not a valid address: ${bad.map((a) => a.email).join(', ')}`); return; }
    if (!opts.skipChecks) {
      if (!subject.trim()) { setConfirm({ kind: 'subject', opts }); return; }
      const mainText = bodyText(splitBody(html.current).main);
      if (mentionsAttachment(mainText) && !attachments.length && !fwdAttachments.length && !/<img\b/i.test(html.current)) { setConfirm({ kind: 'attachment', opts }); return; }
    }
    setSending(true);
    closing.current = true;
    try {
      const pgp = sign && canSign ? await protectInBrowser() : null;
      const undoSecs = prefs.undoSendSeconds;
      const useUndo = !opts.scheduleAt && !opts.humanize && undoSecs > 0;
      const scheduleAt = useUndo ? new Date(Date.now() + undoSecs * 1000).toISOString() : opts.scheduleAt ?? null;
      const r = await api.post<any>('/api/mail/send', {
        accountId, to, cc, bcc, subject, html: fullHtml(),
        replyToEmailId: replyToEmailId.current, forwardOfEmailId: forwardOfEmailId.current, forwardBlobIds: forwardOfEmailId.current ? fwdAttachments.map((a) => a.blobId) : null,
        attachmentIds: pgp ? [] : attachments.map((a) => a.id), includeSignature: false, draftId, scheduleAt, undoWindow: useUndo, humanize: Boolean(opts.humanize), contactId: seed.contactId ?? null,
        encrypt: !pgp && encrypt ? 'always' : null, pgp,
      });
      if (pgp) for (const a of attachments) api.del(`/api/mail/uploads/${a.id}`).catch(() => {});
      const [accStr, tid] = (seed.threadKey ?? '').split(':');
      if (opts.archive && tid) api.post('/api/mail/actions', { accountId: Number(accStr), threadIds: [tid], action: 'archive' }).then(() => { qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); }).catch(() => {});
      const what = encrypt ? (sign ? 'Sent, signed and encrypted' : 'Sent encrypted') : sign && canSign ? 'Sent and signed' : 'Sent';
      if (useUndo) {
        toast.toast(`${opts.archive ? 'Sending and archiving' : 'Sending'}…`, { ttl: undoSecs * 1000 + 500, action: { label: 'Undo', onClick: async () => {
          try {
            const c = await api.del<{ cancelled: boolean; draft: any }>(`/api/mail/outbox/${r.outboxId}`);
            if (c.cancelled) { toast.toast('Sending undone; the message is back in drafts'); qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); if (c.draft) compose.open(seedFromDraft(c.draft)); }
            else toast.error('Too late, it has already been sent');
          } catch (e) { toast.error(e); }
        } } });
      } else if (r.scheduled) toast.success(opts.scheduleAt ? `Scheduled for ${new Date(r.sendAt).toLocaleString()}` : 'Will send in a moment with a natural delay');
      else toast.success(what);
      qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); qc.invalidateQueries({ queryKey: ['outbox'] }); qc.invalidateQueries({ queryKey: ['drafts'] });
      if (threadId) setTimeout(() => qc.invalidateQueries({ queryKey: ['thread'] }), useUndo ? (undoSecs + 2) * 1000 : 1500);
      onSent?.();
      onClose();
    } catch (e) { closing.current = false; toast.error(e); } finally { setSending(false); }
  }

  // ---- files ----
  async function upload(f: File): Promise<Upload | null> {
    if (f.size > 25 * 1024 * 1024) { toast.error(`${f.name} is over 25 MB`); return null; }
    try {
      const r = await api.upload<{ upload: Upload }>(`/api/mail/uploads?filename=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.type || 'application/octet-stream')}`, f, f.type || 'application/octet-stream');
      if (r.upload.scrubbed?.changed) toast.success(`${f.name}: ${r.upload.scrubbed.note}`);
      return r.upload;
    } catch (e) { toast.error(e); return null; }
  }
  async function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    for (const f of Array.from(files)) { const u = await upload(f); if (u) { setAttachments((a) => [...a, u]); setDirty(true); } }
  }
  async function insertImage(f: File): Promise<string | null> {
    const u = await upload(f);
    if (!u) return null;
    setDirty(true);
    return `/api/mail/uploads/${u.id}?inline=1`;
  }
  function filesIntoEditor(files: File[], how: 'paste' | 'drop'): boolean {
    const images = files.filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type));
    const others = files.filter((f) => !images.includes(f));
    for (const f of images) void insertImage(f).then((url) => { if (url) editor.current?.insertHtml(`<img src="${url}" alt="${f.name.replace(/"/g, '')}" style="max-width:100%">`); html.current = editor.current?.getHtml() ?? html.current; setDirty(true); });
    if (others.length) void addFiles(others);
    return true;
  }

  async function insertTemplate(t: any) {
    try {
      const r = await api.post<any>('/api/templates/preview', { subject: t.subject, body_html: t.body_html, contactEmail: to[0]?.email ?? null, accountId, seed: Math.floor(Math.random() * 1e6) });
      if (r.subject && !subject) setSubject(r.subject);
      editor.current?.insertHtml(r.html);
      html.current = editor.current?.getHtml() ?? html.current;
      if (!to[0]?.email && (t.fields?.length ?? 0) > 0) toast.toast('Rendered with sample values; add the recipient first to use their details');
    } catch (e) { toast.error(e); }
    setDirty(true);
  }

  function showQuote() {
    if (!quote || quoteShown) return;
    const next = html.current + quote;
    editor.current?.setHtml(next);
    html.current = next;
    setQuoteShown(true);
  }
  function switchKind(k: ComposeKind) {
    const o = kindOptions?.[k];
    if (!o) return;
    setKind(k); setTo(o.to); setCc(o.cc); setShowCc(Boolean(o.cc.length)); setSubject(o.subject);
    replyToEmailId.current = o.replyToEmailId ?? null; forwardOfEmailId.current = o.forwardOfEmailId ?? null;
    setFwdAttachments(o.forwardAttachments ?? []);
    const parts = splitBody(editor.current?.getHtml() ?? html.current);
    const expanded = k === 'forward';
    const next = joinBody({ main: parts.main, signature: parts.signature, quote: expanded ? o.quoteHtml : null });
    editor.current?.setHtml(next); html.current = next;
    setQuote(o.quoteHtml); setQuoteShown(expanded);
    if (k === 'forward') setSubjectShown(true);
    setDirty(true);
  }
  function popOut() {
    closing.current = true;
    onPopOut?.({ ...seed, kind, accountId, to, cc, bcc, subject, html: fullHtml(), quoteHtml: undefined, attachments, forwardAttachments: fwdAttachments, draftId, replyToEmailId: replyToEmailId.current, forwardOfEmailId: forwardOfEmailId.current, autoAi: null, initialText: undefined });
  }
  function onKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); }
    else if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
  }

  const recipientEmail = to[0]?.email;
  const recipientName = to[0]?.name ?? undefined;
  const aiContext = useMemo(() => ({ accountId, contactId: seed.contactId, threadKey: seed.threadKey, subject, recipientEmail, recipientName }), [accountId, seed.contactId, seed.threadKey, subject, recipientEmail, recipientName]);
  const isReply = kind === 'reply' || kind === 'reply_all';
  const kindMenu = kindOptions && (
    <Menu width={220} trigger={(open) => <button type="button" className="kind-pill" onClick={open} title="Change reply type">{KIND_ICON[kind]}<ChevronDown size={12} /></button>}>
      {(c) => <>
        {(['reply', 'reply_all', 'forward'] as ComposeKind[]).filter((k) => kindOptions[k]).map((k) => <MenuItem key={k} active={k === kind} icon={KIND_ICON[k]} onClick={() => { switchKind(k); c(); }}>{KIND_LABEL[k]}</MenuItem>)}
        <div className="menu-sep" />
        {!subjectShown && <MenuItem icon={<Pencil size={14} />} onClick={() => { setSubjectShown(true); c(); }}>Edit subject</MenuItem>}
        {onPopOut && <MenuItem icon={<ExternalLink size={14} />} onClick={() => { popOut(); c(); }}>Pop out to a window</MenuItem>}
      </>}
    </Menu>
  );

  return (
    <div className={cls('composer', variant === 'inline' ? 'composer-inline' : 'composer-window')} onKeyDown={onKeyDown} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); void addFiles(e.dataTransfer.files); } }}>
      {header?.({ close: () => void closeKeepingDraft(), subject, kind })}
      {variant === 'inline' && (
        <div className="composer-inline-head">
          <Avatar name={account?.name} email={account?.email} size="sm" />
          {kindMenu}
          <div className="flex-1 addr-inline"><AddressInput value={to} onChange={(v) => { setTo(v); setDirty(true); }} placeholder="Recipients" /></div>
          <div className="addr-extra">{!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}{!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}</div>
          {onPopOut && <IconButton label="Pop out to a window" className="btn-sm" onClick={popOut}><ExternalLink size={14} /></IconButton>}
          <IconButton label="Close (keeps the draft)" className="btn-sm" onClick={() => void closeKeepingDraft()}><X size={15} /></IconButton>
        </div>
      )}
      <div className="composer-body">
        {variant === 'window' && accounts.length > 1 && (
          <div className="addr-row"><label>From</label>
            <select className="select input-sm" style={{ maxWidth: 360 }} value={accountId ?? ''} onChange={(e) => { setAccountId(Number(e.target.value)); setDirty(true); }}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt;</option>)}</select>
          </div>
        )}
        {variant === 'window' && (
          <div className="addr-row"><label>To</label><AddressInput value={to} onChange={(v) => { setTo(v); setDirty(true); }} placeholder="Recipients" autoFocus={!seed.to?.length} />
            <div className="addr-extra">{!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}{!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}</div>
          </div>
        )}
        {showCc && <div className="addr-row"><label>Cc</label><AddressInput value={cc} onChange={(v) => { setCc(v); setDirty(true); }} /></div>}
        {showBcc && <div className="addr-row"><label>Bcc</label><AddressInput value={bcc} onChange={(v) => { setBcc(v); setDirty(true); }} /></div>}
        {subjectShown && <div className="subject-row"><input value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} placeholder="Subject" autoFocus={variant === 'window' && Boolean(seed.to?.length) && !seed.subject} /></div>}
        <Editor ref={editor} initialHtml={html.current} placeholder={isReply ? 'Write your reply…' : 'Write your message…'} minHeight={variant === 'inline' ? 110 : 120} autoFocus={variant === 'inline' || Boolean(seed.subject && seed.to?.length)}
          onChange={(h) => { html.current = h; setDirty(true); }} onFiles={filesIntoEditor} onInsertImage={insertImage} />
        {quote && !quoteShown && <button type="button" className="quote-toggle" title="Show quoted text" onClick={showQuote}><MoreHorizontal size={14} /></button>}
        {(attachments.length > 0 || fwdAttachments.length > 0) && (
          <div className="compose-attach">
            {fwdAttachments.map((a) => <span key={a.blobId} className="att-card" title={`${a.name} (forwarded)`}><CloudDownload size={14} className="faint" /><span className="col" style={{ gap: 0, minWidth: 0 }}><span className="truncate">{a.name}</span><span className="tiny faint">{fmtBytes(a.size)} · forwarded</span></span><button type="button" className="chip-x" aria-label="Remove" onClick={() => { setFwdAttachments((l) => l.filter((x) => x.blobId !== a.blobId)); setDirty(true); }}><X size={12} /></button></span>)}
            {attachments.map((a) => <span key={a.id} className="att-card" title={a.scrubbed?.note ?? a.filename}>{/^image\//.test(a.content_type) ? <img src={`/api/mail/uploads/${a.id}?inline=1`} alt="" /> : a.scrubbed?.changed ? <ShieldCheck size={14} style={{ color: 'var(--success)' }} /> : <Paperclip size={14} className="faint" />}<span className="col" style={{ gap: 0, minWidth: 0 }}><span className="truncate">{a.filename}</span><span className="tiny faint">{fmtBytes(a.size)}</span></span><button type="button" className="chip-x" aria-label="Remove" onClick={() => { api.del(`/api/mail/uploads/${a.id}`).catch(() => {}); setAttachments((l) => l.filter((x) => x.id !== a.id)); setDirty(true); }}><X size={12} /></button></span>)}
          </div>
        )}
        {showPgpBar && (
          <div className="pgp-bar">
            <button type="button" className={cls('pgp-pill', encrypt && 'on', !canEncrypt && 'off')} disabled={!canEncrypt} title={canEncrypt ? (encrypt ? 'Encrypted to every recipient and to you. Click to send in the clear.' : 'Click to encrypt') : emailList.length ? `No key on file for ${missingKeys.join(', ')}. Add one on their contact card or under Settings → Encryption.` : 'Add recipients'} onClick={() => setEncryptPref(!encrypt)}>{encrypt ? <Lock size={13} /> : <LockOpen size={13} />}{encrypt ? 'Encrypted' : canEncrypt ? 'Not encrypted' : 'No key for recipient'}</button>
            {myKey?.key && <button type="button" className={cls('pgp-pill', sign && canSign && 'on', !canSign && 'off')} disabled={!canSign} title={canSign ? 'Sign with your OpenPGP key in this browser' : 'Your private key is not available in this browser'} onClick={() => setSign((s) => !s)}><PenLine size={13} />{sign && canSign ? 'Signed' : 'Not signed'}</button>}
          </div>
        )}
        {ai && <AiPanel context={aiContext} autoRun={Boolean(seed.autoAi)} defaultMode={seed.autoAi ?? undefined} getDraft={() => splitBody(editor.current?.getHtml() ?? '').main} onClose={() => setAi(false)} onSubject={(s) => { setSubject(s); setSubjectShown(true); setDirty(true); }}
          onInsert={(h) => { const parts = splitBody(editor.current?.getHtml() ?? ''); const next = joinBody({ main: h, signature: parts.signature ?? (account?.signature_html?.trim() || null), quote: quoteShown ? parts.quote : null }); editor.current?.setHtml(next); html.current = next; setDirty(true); }} />}
        <div className="compose-foot">
          <span className="send-group">
            <Button variant="primary" icon={<Send size={15} />} loading={sending} onClick={() => send()} title="Send (Ctrl+Enter)">Send</Button>
            <Menu align="left" width={260} trigger={(open) => <Button variant="primary" iconOnly onClick={open} aria-label="More send options"><ChevronDown size={15} /></Button>}>
              {(c) => <>
                {seed.threadKey && <MenuItem icon={<Archive size={15} />} onClick={() => { c(); void send({ archive: true }); }}>Send and archive</MenuItem>}
                <MenuItem icon={<Shuffle size={15} />} onClick={() => { c(); void send({ humanize: true }); }}>Send with a natural delay</MenuItem>
                <MenuItem icon={<Clock size={15} />} onClick={() => { c(); setSchedule(localDateTimeValue(new Date(Date.now() + 3600_000))); setScheduleOpen(true); }}>Schedule send…</MenuItem>
              </>}
            </Menu>
          </span>
          <IconButton label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></IconButton>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          {templates.length > 0 && (
            <Menu trigger={(open) => <IconButton label="Insert template" onClick={open}><FileText size={17} /></IconButton>} width={280}>
              {(c) => <>{templates.map((t) => <MenuItem key={t.id} onClick={() => { void insertTemplate(t); c(); }}><span className="col" style={{ gap: 0, minWidth: 0 }}><span className="truncate">{t.starred ? '★ ' : ''}{t.name}</span><span className="small faint truncate">{t.category}{t.subject ? ` · ${t.subject}` : ''}</span></span></MenuItem>)}</>}
            </Menu>
          )}
          <Button variant="ai" size="sm" icon={<Sparkles size={14} />} onClick={() => setAi((v) => !v)} className={ai ? 'active' : ''}>{isReply ? 'AI reply' : 'Draft with AI'}</Button>
          <span className="ml-auto small faint desktop-only">{dirty ? 'Saving…' : savedAt || draftId ? 'Draft saved' : ''}</span>
          <IconButton label="Discard draft" onClick={() => void discard()}><Trash2 size={17} /></IconButton>
        </div>
      </div>
      <Modal open={scheduleOpen} onClose={() => setScheduleOpen(false)} title="Schedule send" footer={<><Button onClick={() => setScheduleOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setScheduleOpen(false); void send({ scheduleAt: new Date(schedule!).toISOString() }); }}>Schedule</Button></>}>
        <Field label="Send at"><Input type="datetime-local" value={schedule ?? ''} onChange={(e) => setSchedule(e.target.value)} /></Field>
        <div className="row wrap gap-4">
          {[['In 1 hour', 3600_000], ['Tomorrow 9:00', -1], ['Monday 9:00', -2]].map(([label, v]) => <Button key={String(label)} size="sm" onClick={() => {
            const d = new Date();
            if (v === -1) { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
            else if (v === -2) { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); }
            else d.setTime(d.getTime() + Number(v));
            setSchedule(localDateTimeValue(d));
          }}>{label}</Button>)}
        </div>
        <p className="help-text mt-16">Scheduled messages respect the account's send window and daily cap only when you pick "Send with a natural delay". A scheduled time sends at that time.</p>
      </Modal>
      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title={confirm?.kind === 'subject' ? 'Send without a subject?' : 'Did you forget to attach a file?'} footer={<><Button onClick={() => setConfirm(null)}>{confirm?.kind === 'subject' ? 'Add a subject' : 'Attach a file'}</Button><Button variant="primary" onClick={() => { const o = confirm!.opts; setConfirm(null); void send({ ...o, skipChecks: true }); }}>Send anyway</Button></>}>
        <div className="muted">{confirm?.kind === 'subject' ? 'Messages without a subject are easy to lose and more likely to be filtered as junk.' : 'The message mentions an attachment, but nothing is attached.'}</div>
      </Modal>
    </div>
  );
}

