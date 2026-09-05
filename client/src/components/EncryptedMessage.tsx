import { useEffect, useMemo, useState } from 'react';
import { Lock, LockOpen, ShieldCheck, ShieldAlert, ShieldQuestion, Download, Paperclip } from 'lucide-react';
import { api } from '../api';
import { usePgp } from '../state/pgp';
import { Button, Spinner } from './ui';
import { MessageBody } from './MessageBody';
import { decryptArmored, looksEncrypted, verifyDetached, type SignatureStatus } from '../lib/pgp';
import { flatten, parseMime } from '../lib/mime';
import { fmtBytes } from '../lib/format';

// How a cached message relates to OpenPGP, decided from what sync stored:
//   pgp/mime      multipart/encrypted arrived; the ciphertext is the encrypted.asc part
//   inline        the text body is itself an armored message
//   signed        multipart/signed; the body is readable, the signature is an attachment
export type PgpKind = 'pgp/mime' | 'inline' | 'signed' | null;
export function pgpKindOf(m: { body_text: string | null; body_html: string | null; attachments: any[] }): PgpKind {
  const atts: any[] = m.attachments ?? [];
  if (atts.some((a) => a.type === 'application/pgp-encrypted' || /^encrypted\.asc$/i.test(a.name ?? ''))) return 'pgp/mime';
  if (looksEncrypted(m.body_text) || looksEncrypted(m.body_html?.replace(/<[^>]+>/g, '\n') ?? null)) return 'inline';
  if (atts.some((a) => a.type === 'application/pgp-signature' || /^signature\.asc$/i.test(a.name ?? ''))) return 'signed';
  return null;
}

async function senderKeys(email: string | undefined): Promise<string[]> {
  if (!email) return [];
  try { const r = await api.get<{ keys: Record<string, { publicKey: string }> }>(`/api/pgp/recipients?emails=${encodeURIComponent(email)}`); const k = r.keys[email.toLowerCase()]; return k ? [k.publicKey] : []; } catch { return []; }
}

export function SignatureBadge({ status, sender }: { status: SignatureStatus[] | 'none' | 'checking' | 'nokey'; sender?: string }) {
  if (status === 'none') return null;
  if (status === 'checking') return <span className="badge"><Spinner size={10} /> checking signature</span>;
  if (status === 'nokey') return <span className="badge badge-warning" title="Add this sender's public key on their contact card to verify signatures"><ShieldQuestion size={12} /> signed, no key to verify</span>;
  const ok = status.length > 0 && status.every((s) => s.verified);
  return ok
    ? <span className="badge badge-success" title={`Key ${status.map((s) => s.keyId).join(', ')}`}><ShieldCheck size={12} /> signed by {status[0].signer ?? sender ?? 'known key'}</span>
    : <span className="badge badge-danger"><ShieldAlert size={12} /> signature does not verify</span>;
}

export function EncryptedMessage({ m, accountId, kind }: { m: any; accountId: number; kind: Exclude<PgpKind, null> }) {
  const { requestKey } = usePgp();
  const [state, setState] = useState<'locked' | 'working' | 'open' | 'error'>('locked');
  const [error, setError] = useState('');
  const [content, setContent] = useState<{ html: string | null; text: string | null; attachments: { name: string; type: string; data: Uint8Array; cid: string | null }[] } | null>(null);
  const [sig, setSig] = useState<SignatureStatus[] | 'none' | 'checking' | 'nokey'>('none');
  const sender: string | undefined = m.from_addr?.[0]?.email;

  // Signed but not encrypted: readable now, verify in the background from the raw message.
  useEffect(() => {
    if (kind !== 'signed') return;
    let cancelled = false;
    (async () => {
      setSig('checking');
      const keys = await senderKeys(sender);
      if (!keys.length) { if (!cancelled) setSig('nokey'); return; }
      try {
        const raw = await (await fetch(`/api/mail/blob/${accountId}/${encodeURIComponent(m.blob_id)}?name=message.eml&type=message/rfc822&download=1`)).text();
        const norm = raw.replace(/\r?\n/g, '\r\n');
        const bm = norm.match(/boundary="?([^";\r\n]+)"?/i);
        const sigAtt = (m.attachments ?? []).find((a: any) => a.type === 'application/pgp-signature' || /^signature\.asc$/i.test(a.name ?? ''));
        if (!bm || !sigAtt) throw new Error('not multipart/signed');
        const b = `--${bm[1]}`;
        const first = norm.indexOf(`${b}\r\n`) + b.length + 2;
        const second = norm.indexOf(`\r\n${b}`, first);
        const signedPart = norm.slice(first, second);
        const signature = await (await fetch(`/api/mail/blob/${accountId}/${encodeURIComponent(sigAtt.blobId)}?name=signature.asc&type=text/plain&download=1`)).text();
        const r = await verifyDetached(signedPart, signature, keys);
        if (!cancelled) setSig(r);
      } catch { if (!cancelled) setSig([{ keyId: '', verified: false, signer: null }]); }
    })();
    return () => { cancelled = true; };
  }, [kind, accountId, m.blob_id, m.attachments, sender]);

  async function unlock() {
    setState('working'); setError('');
    try {
      let armored: string;
      if (kind === 'inline') {
        const src = looksEncrypted(m.body_text) ? m.body_text : (m.body_html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
        armored = src.slice(src.indexOf('-----BEGIN PGP MESSAGE-----'), src.indexOf('-----END PGP MESSAGE-----') + 25);
      } else {
        const att = (m.attachments ?? []).find((a: any) => /^encrypted\.asc$/i.test(a.name ?? '') || (a.type === 'application/octet-stream' && /\.asc$/i.test(a.name ?? ''))) ?? (m.attachments ?? []).find((a: any) => a.type !== 'application/pgp-encrypted');
        if (!att) throw new Error('The encrypted part is missing from this message');
        armored = await (await fetch(`/api/mail/blob/${accountId}/${encodeURIComponent(att.blobId)}?name=encrypted.asc&type=text/plain&download=1`)).text();
      }
      const key = await requestKey('Read this encrypted message');
      const keys = await senderKeys(sender);
      const r = await decryptArmored(armored, key, keys);
      if (kind === 'inline') setContent({ html: null, text: r.text, attachments: [] });
      else { const flat = flatten(parseMime(r.text)); setContent(flat); }
      setSig(r.signatures.length ? (keys.length ? r.signatures : 'nokey') : 'none');
      setState('open');
    } catch (e: any) { setError(e.message ?? String(e)); setState('error'); }
  }

  const blobUrls = useMemo(() => (content?.attachments ?? []).map((a) => URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.type }))), [content]);
  useEffect(() => () => blobUrls.forEach((u) => URL.revokeObjectURL(u)), [blobUrls]);

  if (kind === 'signed') {
    return (
      <>
        <div className="row mb-8"><SignatureBadge status={sig} sender={sender} /></div>
        <MessageBody html={m.body_html} text={m.body_text} attachments={(m.attachments ?? []).filter((a: any) => a.type !== 'application/pgp-signature' && !/^signature\.asc$/i.test(a.name ?? ''))} accountId={accountId} />
      </>
    );
  }
  if (state !== 'open') {
    return (
      <div className="pgp-locked">
        <div className="row"><Lock size={18} /><div className="flex-1"><div className="strong">Encrypted message</div><div className="small muted">Only your key can open it. It is decrypted in this browser and never stored readable.</div></div><Button variant="primary" size="sm" icon={state === 'working' ? undefined : <LockOpen size={14} />} loading={state === 'working'} onClick={unlock}>Unlock</Button></div>
        {error && <div className="small mt-8" style={{ color: 'var(--danger)' }}>{error}</div>}
      </div>
    );
  }
  const inlineCids = new Map(content!.attachments.filter((a) => a.cid).map((a, i) => [a.cid!, blobUrls[content!.attachments.indexOf(a)] ?? '']));
  const html = content!.html ? content!.html.replace(/src="cid:([^"]+)"/g, (_m, cid: string) => `src="${inlineCids.get(cid) ?? ''}"`) : null;
  return (
    <>
      <div className="row mb-8 wrap gap-4"><span className="badge badge-success"><LockOpen size={12} /> decrypted in your browser</span><SignatureBadge status={sig} sender={sender} /></div>
      <MessageBody html={html} text={content!.text} attachments={[]} accountId={accountId} allowRemote={false} />
      {content!.attachments.filter((a) => !a.cid).length > 0 && (
        <div className="attachments" style={{ padding: '12px 0 0' }}>
          {content!.attachments.map((a, i) => a.cid ? null : <a key={i} className="attachment" href={blobUrls[i]} download={a.name} title={a.name}>{/^image\//.test(a.type) ? <img src={blobUrls[i]} alt="" /> : <Paperclip size={15} className="faint" />}<span className="col" style={{ gap: 0, minWidth: 0 }}><span className="a-name">{a.name}</span><span className="a-size">{fmtBytes(a.data.length)}</span></span><Download size={14} className="faint" /></a>)}
        </div>
      )}
    </>
  );
}
