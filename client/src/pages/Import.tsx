// Importing an archive (F12).
//
// The unglamorous feature that makes the clever ones work. Meaning search,
// priority ordering and commitment tracking are all mediocre on two weeks of
// mail and immediately convincing on ten years of it, so this is the one
// that should be run first and is described that way.
//
// It is honest about three things people find out the hard way otherwise:
// where the mail lands (a separate mailbox, never the inbox), what does not
// come with it (attachment contents, because those bytes are not on the mail
// server), and the size ceiling — the archive is held in memory and never
// written to disk, which is what makes "nothing is left behind" a fact
// rather than a promise about cleanup code.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CheckCircle2, FileUp, Loader2, XCircle } from 'lucide-react';
import { api } from '../api';
import { uploadWithWork } from '../lib/work';
import { useFeatures } from '../state/features';
import { Button, Callout, Field, Progress, Select, Spinner } from '../components/ui';
import { FeatureOffNotice } from './Features';
import { useToast } from '../state/toast';
import { fmtBytes, fmtNumber } from '../lib/format';

// Matches the server's ceiling. Checked here too so a person picking a
// three-gigabyte Takeout is told before they wait for an upload that will
// be refused.
const MAX_BYTES = 256 * 1024 * 1024;

interface ImportRow {
  id: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  total: number; done: number; skipped: number; failed: number;
  error: string | null; filename: string | null;
}

export default function ImportPage() {
  const { can, info } = useFeatures();
  const toast = useToast();
  const [accounts, setAccounts] = useState<{ id: number; email: string }[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [run, setRun] = useState<ImportRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const allowed = can('import');

  useEffect(() => {
    if (!allowed) return;
    void api.get<{ accounts: { id: number; email: string }[] }>('/api/accounts')
      .then((r) => { setAccounts(r.accounts); setAccountId((a) => a ?? r.accounts[0]?.id ?? null); })
      .catch(() => {});
  }, [allowed]);

  // Poll while it is running. Two seconds: fast enough that the bar moves,
  // slow enough that a long import is not a thousand requests.
  const poll = useCallback(async (id: number) => {
    try {
      const r = await api.get<{ import: ImportRow }>(`/api/assist/import/${id}`);
      setRun(r.import);
      if (r.import.status === 'pending' || r.import.status === 'running') {
        window.setTimeout(() => void poll(id), 2000);
      }
    } catch { /* the run row is gone; stop asking */ }
  }, []);

  const start = async (file: File) => {
    if (!accountId) return;
    if (file.size > MAX_BYTES) {
      toast.error(`That file is ${fmtBytes(file.size)}. The limit is ${fmtBytes(MAX_BYTES)} — import a folder at a time, or split the mbox.`);
      return;
    }
    setUploading(true);
    try {
      const r = await uploadWithWork<{ import: ImportRow }>(
        'import',
        `/api/assist/import?accountId=${accountId}&filename=${encodeURIComponent(file.name)}`,
        file,
        'application/mbox',
      );
      setRun(r.import);
      void poll(r.import.id);
    } catch (e) { toast.error(e); } finally { setUploading(false); }
  };

  const cancel = async () => {
    if (!run) return;
    try { await api.post(`/api/assist/import/${run.id}/cancel`); await poll(run.id); }
    catch (e) { toast.error(e); }
  };

  if (!allowed) {
    return (
      <div className="stack-20">
        <h2>Import an archive</h2>
        <FeatureOffNotice cap={info('import')}>
          Reads an mbox file — a Google Takeout export, a Thunderbird folder — and files it into
          your encrypted cache. Nothing leaves this server, and the file is never written to its
          disk.
        </FeatureOffNotice>
      </div>
    );
  }

  const running = run?.status === 'pending' || run?.status === 'running';

  return (
    <div className="stack-20">
      <div>
        <h2>Import an archive</h2>
        <p className="muted small" style={{ maxWidth: '68ch' }}>
          Worth doing first. Meaning search, priority ordering and commitments all learn from what
          is in your cache, and they are far better on years of mail than on days of it.
        </p>
      </div>

      <Callout kind="info">
        Imported mail goes into a mailbox called <strong>Imported</strong>, never your inbox, and
        stays on this server — it is not uploaded to your mail provider. Attachments are listed by
        name and size but their contents are not imported, because those bytes are not in the mbox
        in a form the mail server can serve back.
      </Callout>

      {accounts.length > 1 && (
        <Field label="Import into">
          <Select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))} disabled={running}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
          </Select>
        </Field>
      )}

      <input
        ref={fileInput}
        type="file"
        accept=".mbox,application/mbox,text/plain"
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void start(f); }}
      />

      {!running && (
        <div>
          <Button
            variant="primary"
            icon={uploading ? <Loader2 size={15} className="spin" /> : <FileUp size={15} />}
            loading={uploading}
            disabled={!accountId}
            onClick={() => fileInput.current?.click()}
          >
            Choose an mbox file
          </Button>
          <p className="muted small" style={{ marginTop: 6 }}>
            Up to {fmtBytes(MAX_BYTES)}. The file is held in memory for the length of the import and
            never written to the disk, which is why there is a limit at all. A bigger Takeout can be
            imported one folder at a time.
          </p>
        </div>
      )}

      {run && (
        <div className="card pad-24 stack-12">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {running ? <Spinner size={16} /> : run.status === 'done' ? <CheckCircle2 size={16} style={{ color: 'var(--success)' }} /> : <XCircle size={16} style={{ color: 'var(--danger)' }} />}
            <strong>{run.filename ?? 'Archive'}</strong>
            <span className="muted small">
              {run.status === 'done' ? 'Finished' : run.status === 'cancelled' ? 'Cancelled' : run.status === 'failed' ? 'Failed' : 'Reading…'}
            </span>
          </div>

          {run.total > 0 && <Progress value={run.done + run.skipped + run.failed} max={run.total} />}

          <div className="muted small">
            {fmtNumber(run.done)} imported
            {run.skipped ? `, ${fmtNumber(run.skipped)} already had` : ''}
            {run.failed ? `, ${fmtNumber(run.failed)} unreadable` : ''}
            {run.total ? ` of ${fmtNumber(run.total)} found` : ''}.
          </div>

          {run.error && <Callout kind="danger">{run.error}</Callout>}

          {running
            ? <div><Button onClick={cancel}>Stop</Button></div>
            : run.status === 'done' && run.done > 0 && (
              <Callout kind="success">
                <Archive size={14} /> Done. The new mail is in <strong>Imported</strong>. If you have
                meaning search on, it will read through the new messages in the background — Settings
                → Features shows how far it has got.
              </Callout>
            )}
        </div>
      )}
    </div>
  );
}
