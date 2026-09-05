import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Maximize2, Minimize2, Minus, Paperclip, Send, Sparkles, Trash2, X, Clock, Shuffle, FileText, ShieldCheck, Lock, LockOpen, PenLine } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePgp } from '../state/pgp';
import { encryptText, signDetached } from '../lib/pgp';
import { buildMime, htmlToPlain } from '../lib/mime';
import { useDebounced } from '../lib/hooks';
import { api } from '../api';
import { useCompose, type ComposeWindow } from '../state/compose';
import { useToast } from '../state/toast';
import { useAccounts, useTemplates } from '../lib/queries';
import { AddressInput } from './AddressInput';
import { Editor, type EditorHandle } from './Editor';
import { AiPanel } from './AiPanel';
import { Button, IconButton, Menu, MenuItem, Modal, Input, Field } from './ui';
import { cls, fmtBytes, localDateTimeValue, type Addr } from '../lib/format';

export function ComposeDock() {
  const { windows } = useCompose();
  if (!windows.length) return null;
  return <div className="compose-dock">{windows.map((w) => <ComposeWin key={w.key} win={w} />)}</div>;
}

function ComposeWin({ win }: { win: ComposeWindow }) {
  const { close, update } = useCompose();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const { data: templates = [] } = useTemplates();
  const editor = useRef<EditorHandle>(null);
  const [accountId, setAccountId] = useState<number | null>(win.accountId ?? null);
  const [to, setTo] = useState<Addr[]>(win.to ?? []);
  const [cc, setCc] = useState<Addr[]>(win.cc ?? []);
  const [bcc, setBcc] = useState<Addr[]>(win.bcc ?? []);
  const [showCc, setShowCc] = useState(Boolean(win.cc?.length));
  const [showBcc, setShowBcc] = useState(Boolean(win.bcc?.length));
  const [subject, setSubject] = useState(win.subject ?? '');
  const [attachments, setAttachments] = useState(win.attachments ?? []);
  const [ai, setAi] = useState(Boolean(win.autoAi));
  const [sending, setSending] = useState(false);
  const [schedule, setSchedule] = useState<null | string>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(win.draftId ?? null);
  const [dirty, setDirty] = useState(false);
  const html = useRef(win.html ?? (win.quoteHtml ? `<p><br></p>${win.quoteHtml}` : ''));
  const fileInput = useRef<HTMLInputElement>(null);

  // OpenPGP: encrypt when every recipient has a key (on by default, one click
  // to turn off), sign with the unlocked key when asked.
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
  const showPgpBar = Boolean(myKey?.key) || emailList.length > 0 && Object.keys(recipientKeys ?? {}).length > 0;

  // Signing needs the exact bytes that leave, so the browser builds the MIME
  // part (with the account signature and every attachment) and signs or
  // encrypts it; the server only adds the envelope.
  async function protectInBrowser(): Promise<{ mode: 'encrypted' | 'signed'; armored?: string; inner?: string; signature?: string }> {
    const key = await requestKey(encrypt ? 'Sign and encrypt this message' : 'Sign this message');
    const files = await Promise.all(attachments.map(async (a) => ({ name: a.filename, type: a.content_type, data: new Uint8Array(await (await fetch(`/api/mail/uploads/${a.id}`)).arrayBuffer()) })));
    const body = html.current + (account?.signature_html?.trim() ? `<div class="tern-signature" style="margin-top:16px">${account.signature_html}</div>` : '');
    const inner = buildMime({ html: body, text: htmlToPlain(body), attachments: files });
    if (encrypt) {
      const keys = [...emailList.map((e) => recipientKeys![e].publicKey), ...(myKey?.key ? [myKey.key.publicKey] : [])];
      return { mode: 'encrypted', armored: await encryptText(inner, keys, key) };
    }
    return { mode: 'signed', inner, signature: await signDetached(inner, key) };
  }

  useEffect(() => { if (accountId === null && accounts.length) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const account = accounts.find((a) => a.id === accountId);
  const title = subject || (win.kind === 'reply' || win.kind === 'reply_all' ? 'Reply' : win.kind === 'forward' ? 'Forward' : 'New message');

  // Autosave every couple of seconds while something changed.
  const save = useCallback(async () => {
    if (!dirty) return;
    try {
      const r = await api.post<{ draft: { id: number } }>('/api/mail/drafts', { id: draftId, accountId, kind: win.kind, replyToEmailId: win.replyToEmailId ?? null, threadId: win.threadKey?.split(':')[1] ?? null, to, cc, bcc, subject, html: html.current, attachmentIds: attachments.map((a) => a.id) });
      setDraftId(r.draft.id); setDirty(false);
      qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] });
    } catch { /* keep in memory */ }
  }, [dirty, draftId, accountId, win.kind, win.replyToEmailId, win.threadKey, to, cc, bcc, subject, attachments, qc]);
  useEffect(() => { const t = setTimeout(() => void save(), 2000); return () => clearTimeout(t); }, [save]);

  async function send(opts: { scheduleAt?: string | null; humanize?: boolean } = {}) {
    if (!accountId) { toast.error('Choose a sending account'); return; }
    if (!to.length && !cc.length && !bcc.length) { toast.error('Add a recipient'); return; }
    if (!subject.trim() && !confirm('Send without a subject?')) return;
    setSending(true);
    try {
      const pgp = sign && canSign ? await protectInBrowser() : null;
      const r = await api.post<any>('/api/mail/send', { accountId, to, cc, bcc, subject, html: html.current, replyToEmailId: win.replyToEmailId ?? null, forwardOfEmailId: win.forwardOfEmailId ?? null, attachmentIds: pgp ? [] : attachments.map((a) => a.id), draftId, scheduleAt: opts.scheduleAt ?? null, humanize: Boolean(opts.humanize), contactId: win.contactId ?? null, encrypt: !pgp && encrypt ? 'always' : null, pgp });
      if (pgp) for (const a of attachments) api.del(`/api/mail/uploads/${a.id}`).catch(() => {});
      if (r.scheduled) toast.success(opts.scheduleAt ? `Scheduled for ${new Date(r.sendAt).toLocaleString()}` : `Will send in a moment with a natural delay`);
      else toast.success(encrypt ? (sign ? 'Sent, signed and encrypted' : 'Sent encrypted') : sign ? 'Sent and signed' : 'Sent');
      qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['counts'] }); qc.invalidateQueries({ queryKey: ['outbox'] }); qc.invalidateQueries({ queryKey: ['drafts'] });
      close(win.key);
    } catch (e) { toast.error(e); } finally { setSending(false); }
  }
  async function discard() {
    if (draftId) api.del(`/api/mail/drafts/${draftId}`).then(() => { qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['counts'] }); }).catch(() => {});
    close(win.key);
  }
  async function addFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.size > 25 * 1024 * 1024) { toast.error(`${f.name} is over 25 MB`); continue; }
      try {
        const r = await api.upload<{ upload: any }>(`/api/mail/uploads?filename=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.type || 'application/octet-stream')}`, f, f.type || 'application/octet-stream');
        setAttachments((a) => [...a, r.upload]); setDirty(true);
        if (r.upload.scrubbed?.changed) toast.success(`${f.name}: ${r.upload.scrubbed.note}`);
      } catch (e) { toast.error(e); }
    }
  }
  // Templates are rendered for the first recipient (their contact fields,
  // fallbacks, conditionals, one variation) before landing in the editor.
  async function insertTemplate(t: any) {
    try {
      const r = await api.post<any>('/api/templates/preview', { subject: t.subject, body_html: t.body_html, contactEmail: to[0]?.email ?? null, accountId, seed: Math.floor(Math.random() * 1e6) });
      if (r.subject && !subject) setSubject(r.subject);
      editor.current?.insertHtml(r.html);
      if (!to[0]?.email && (t.fields?.length ?? 0) > 0) toast.toast('Rendered with sample values; add the recipient first to use their details');
    } catch (e) { toast.error(e); }
    setDirty(true);
  }
  const recipientEmail = to[0]?.email;
  const recipientName = to[0]?.name ?? undefined;
  const aiContext = useMemo(() => ({ accountId, contactId: win.contactId, threadKey: win.threadKey, subject, recipientEmail, recipientName }), [accountId, win.contactId, win.threadKey, subject, recipientEmail, recipientName]);

  if (win.minimized) {
    return (
      <div className="compose-win minimized" onClick={() => update(win.key, { minimized: false })}>
        <div className="compose-head"><span className="truncate flex-1">{title}</span><IconButton label="Close" onClick={(e) => { e.stopPropagation(); void save(); close(win.key); }}><X size={15} /></IconButton></div>
      </div>
    );
  }
  return (
    <div className={cls('compose-win', win.maximized && 'maximized')} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}>
      <div className="compose-head" onDoubleClick={() => update(win.key, { maximized: !win.maximized })}>
        <span className="truncate flex-1">{title}</span>
        <IconButton label="Minimize" onClick={() => update(win.key, { minimized: true })}><Minus size={15} /></IconButton>
        <IconButton label={win.maximized ? 'Restore' : 'Maximize'} onClick={() => update(win.key, { maximized: !win.maximized })}>{win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</IconButton>
        <IconButton label="Close (saves draft)" onClick={() => { void save(); close(win.key); }}><X size={16} /></IconButton>
      </div>
      <div className="compose-body">
        {accounts.length > 1 && (
          <div className="addr-row"><label>From</label>
            <select className="select input-sm" style={{ maxWidth: 360 }} value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt;</option>)}</select>
          </div>
        )}
        <div className="addr-row"><label>To</label><AddressInput value={to} onChange={(v) => { setTo(v); setDirty(true); }} placeholder="Recipients" autoFocus={!win.to?.length} />
          <div className="addr-extra">{!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}{!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}</div>
        </div>
        {showCc && <div className="addr-row"><label>Cc</label><AddressInput value={cc} onChange={(v) => { setCc(v); setDirty(true); }} /></div>}
        {showBcc && <div className="addr-row"><label>Bcc</label><AddressInput value={bcc} onChange={(v) => { setBcc(v); setDirty(true); }} /></div>}
        <div className="subject-row"><input value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} placeholder="Subject" /></div>
        <Editor ref={editor} initialHtml={html.current} placeholder="Write your message…" minHeight={120} onChange={(h) => { html.current = h; setDirty(true); }} />
        {attachments.length > 0 && (
          <div className="compose-attach">{attachments.map((a) => <span key={a.id} className="chip" title={a.scrubbed?.note ?? undefined}>{a.scrubbed?.changed ? <ShieldCheck size={12} style={{ color: 'var(--success)' }} /> : <Paperclip size={12} />}<span className="truncate">{a.filename}</span><span className="faint">{fmtBytes(a.size)}</span><button type="button" className="chip-x" onClick={() => { api.del(`/api/mail/uploads/${a.id}`).catch(() => {}); setAttachments((l) => l.filter((x) => x.id !== a.id)); setDirty(true); }}><X size={12} /></button></span>)}</div>
        )}
        {showPgpBar && (
          <div className="pgp-bar">
            <button type="button" className={cls('pgp-pill', encrypt && 'on', !canEncrypt && 'off')} disabled={!canEncrypt} title={canEncrypt ? (encrypt ? 'Encrypted to every recipient and to you. Click to send in the clear.' : 'Click to encrypt') : emailList.length ? `No key on file for ${missingKeys.join(', ')}. Add one on their contact card or under Settings → Encryption.` : 'Add recipients'} onClick={() => setEncryptPref(!encrypt)}>{encrypt ? <Lock size={13} /> : <LockOpen size={13} />}{encrypt ? 'Encrypted' : canEncrypt ? 'Not encrypted' : 'No key for recipient'}</button>
            {myKey?.key && <button type="button" className={cls('pgp-pill', sign && canSign && 'on', !canSign && 'off')} disabled={!canSign} title={canSign ? 'Sign with your OpenPGP key in this browser' : 'Your private key is not available in this browser'} onClick={() => setSign((s) => !s)}><PenLine size={13} />{sign && canSign ? 'Signed' : 'Not signed'}</button>}
          </div>
        )}
        {ai && <AiPanel context={aiContext} autoRun={Boolean(win.autoAi)} defaultMode={win.autoAi ?? undefined} getDraft={() => editor.current?.getHtml() ?? ''} onClose={() => setAi(false)} onSubject={(s) => { setSubject(s); setDirty(true); }} onInsert={(h, mode) => { if (mode === 'compose' || mode === 'reply') { const quote = win.quoteHtml ?? ''; editor.current?.setHtml(h + (quote ? `<p><br></p>${quote}` : '')); } else editor.current?.setHtml(h + (win.quoteHtml ? `<p><br></p>${win.quoteHtml}` : '')); html.current = editor.current?.getHtml() ?? ''; setDirty(true); }} />}
        <div className="compose-foot">
          <span className="send-group">
            <Button variant="primary" icon={<Send size={15} />} loading={sending} onClick={() => send()}>Send</Button>
            <Menu align="left" width={260} trigger={(open) => <Button variant="primary" iconOnly onClick={open} aria-label="More send options"><ChevronDown size={15} /></Button>}>
              {(c) => <>
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
          <Button variant="ai" size="sm" icon={<Sparkles size={14} />} onClick={() => setAi((v) => !v)} className={ai ? 'active' : ''}>Draft with AI</Button>
          <span className="ml-auto small faint desktop-only">{draftId ? (dirty ? 'Saving…' : 'Draft saved') : ''}{account && account.jitter_enabled ? '' : ''}</span>
          <IconButton label="Discard" onClick={discard}><Trash2 size={17} /></IconButton>
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
    </div>
  );
}
