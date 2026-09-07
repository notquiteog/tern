// Admin → Features, Retention, and Security.
//
// Three panels that answer three questions an operator of a box this size
// actually has: what is this thing spending my CPU on, how long is it
// keeping things, and am I running the code I think I am.
//
// The features panel is the one that matters when the box is struggling.
// Every switch here takes effect on the next request and the next scheduler
// tick — nothing caches a flag for longer than five seconds — and turning
// one off leaves everybody's consent alone, so turning it back on restores
// what people had already chosen rather than making them choose again.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Box, Brain, CheckCircle2, Eye, Gauge, KeyRound, Loader2, Printer, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Callout, Confirm, Field, Input, Modal, Spinner, Toggle } from '../components/ui';
import { useToast } from '../state/toast';
import { fmtNumber, fmtRelative } from '../lib/format';

// ---------- Features ----------

interface AdminCapability {
  id: string; label: string; what: string;
  readsMail: boolean; usesAi: boolean; heavy: boolean;
  enabled: boolean; users: number;
}

export function AdminFeatures() {
  const toast = useToast();
  const [caps, setCaps] = useState<AdminCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setCaps((await api.get<{ capabilities: AdminCapability[] }>('/api/admin/features')).capabilities); }
    catch (e) { toast.error(e); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const set = async (cap: AdminCapability, enabled: boolean) => {
    setBusy(cap.id);
    try {
      await api.put(`/api/admin/features/${cap.id}`, { enabled });
      setCaps((prev) => prev.map((c) => (c.id === cap.id ? { ...c, enabled } : c)));
      toast.success(enabled
        ? `${cap.label} is available again`
        : `${cap.label} is off for everyone — ${cap.users ? `${fmtNumber(cap.users)} kept their setting` : 'nobody had it on'}`);
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  if (loading) return <div className="center pad-24"><Spinner /></div>;

  const heavy = caps.filter((c) => c.heavy);
  const light = caps.filter((c) => !c.heavy);

  return (
    <div className="stack-20">
      <div>
        <h2>Features</h2>
        <p className="muted small" style={{ maxWidth: '68ch' }}>
          What this install allows at all. Nobody has any of it until they also turn it on for
          themselves; this is the switch for when the box is under load, or when a feature is not
          something this workspace wants to offer. Turning one off stops the background work within
          about twenty seconds and leaves everyone's own choice untouched.
        </p>
      </div>

      <section className="stack-8">
        <h3 className="section-title"><Gauge size={15} /> Costs real CPU</h3>
        <div className="card">
          {heavy.map((c) => <AdminRow key={c.id} cap={c} busy={busy === c.id} onChange={(v) => set(c, v)} />)}
        </div>
      </section>

      <section className="stack-8">
        <h3 className="section-title">Cheap</h3>
        <div className="card">
          {light.map((c) => <AdminRow key={c.id} cap={c} busy={busy === c.id} onChange={(v) => set(c, v)} />)}
        </div>
      </section>
    </div>
  );
}

function AdminRow({ cap, busy, onChange }: { cap: AdminCapability; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="admin-feature-row">
      <div className="admin-feature-main">
        <div className="feature-head">
          <strong>{cap.label}</strong>
          {cap.readsMail && <Badge kind="warning"><Eye size={11} /> Reads mail</Badge>}
          {cap.usesAi && <Badge kind="accent"><Brain size={11} /> Model</Badge>}
          {cap.users > 0 && <Badge>{fmtNumber(cap.users)} using it</Badge>}
        </div>
        <p className="muted small feature-what">{cap.what}</p>
      </div>
      {busy ? <Loader2 size={18} className="spin" /> : <Toggle checked={cap.enabled} onChange={onChange} label={cap.label} />}
    </div>
  );
}

// ---------- Retention ----------

interface RetentionPolicy {
  outboxDays: number; reviewDays: number; aiJobHours: number;
  auditDays: number; briefDays: number; commitmentDays: number; calendarDays: number;
}

const FIELDS: [keyof RetentionPolicy, string, string][] = [
  ['outboxDays', 'Sent copies', 'Days a sent message stays in the outbox. The mailbox has the real one.'],
  ['reviewDays', 'Decided reviews', 'Days an accepted or rejected AI draft is kept.'],
  ['aiJobHours', 'Finished AI jobs', 'Hours. Their prompts are erased the moment the job stops running, whatever this is.'],
  ['briefDays', 'Briefs', 'Days a generated brief is kept before it is thrown away.'],
  ['commitmentDays', 'Closed commitments', 'Days a done or dismissed commitment is kept.'],
  ['calendarDays', 'Past invitations', 'Days an invitation is kept after the meeting.'],
  ['auditDays', 'Audit log', 'Days of the record of who did what.'],
];

export function AdminRetention() {
  const toast = useToast();
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [defaults, setDefaults] = useState<RetentionPolicy | null>(null);
  const [holding, setHolding] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ retention: RetentionPolicy; defaults: RetentionPolicy; holding: Record<string, number> }>('/api/admin/vault/retention');
      setPolicy(r.retention); setDefaults(r.defaults); setHolding(r.holding);
    } catch (e) { toast.error(e); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  if (!policy || !defaults) return <div className="center pad-24"><Spinner /></div>;

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put<{ retention: RetentionPolicy }>('/api/admin/vault/retention', policy);
      setPolicy(r.retention);
      toast.success('Retention saved');
      await load();
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };

  return (
    <div className="stack-20">
      <div>
        <h2>Retention</h2>
        <p className="muted small" style={{ maxWidth: '68ch' }}>
          How long Tern keeps the copies and by-products it makes while doing its job. None of this
          is mail anybody asked to keep, so every default is the shortest the feature still works
          with. Emptying Trash and Junk is a separate, per-account setting under Settings → Accounts.
        </p>
      </div>

      <Callout kind="info">
        Right now: {fmtNumber(holding.ai_jobs ?? 0)} finished AI jobs
        {holding.ai_jobs_with_content ? `, ${fmtNumber(holding.ai_jobs_with_content)} of which still hold a prompt (the next sweep empties them)` : ' — none holding a prompt'},
        {' '}{fmtNumber(holding.reviews ?? 0)} decided reviews, {fmtNumber(holding.audit_log ?? 0)} audit entries,
        {' '}{fmtNumber(holding.briefs ?? 0)} briefs.
      </Callout>

      {Boolean(holding.calendar_events_synced) && (
        <Callout>
          Also held, and <b>not</b> covered by anything on this page:{' '}
          {fmtNumber(holding.calendar_events_synced)} events synced from connected calendars
          {holding.calendar_occurrences ? <> ({fmtNumber(holding.calendar_occurrences)} occurrences worked out from them)</> : null}.
          Everything else here is a by-product Tern made and can make again; those are somebody
          else&rsquo;s records that this server holds a copy of, so deleting them on a timer would make
          the calendar wrong rather than smaller — the next sync would fetch them straight back. They
          go when the calendar is disconnected, or when someone turns the Calendar feature off.
          Occurrences outside the rolling window are trimmed automatically.
        </Callout>
      )}

      <div className="retention-grid">
        {FIELDS.map(([key, label, hint]) => (
          <Field key={key} label={label} hint={<>{hint} Default {defaults[key]}.</>}>
            <Input
              type="number"
              min={1}
              value={policy[key]}
              onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
            />
          </Field>
        ))}
      </div>

      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        <Button onClick={() => setPolicy(defaults)}>Back to defaults</Button>
      </div>
    </div>
  );
}

// ---------- Security: recovery shares and attestation ----------

interface RecoveryRecord { createdAt: string; n: number; k: number; fingerprints: string[]; current: boolean }
interface ContainerReport { name: string; image: string; digest: string | null; source: string; registry: string | null; status: string; drifted: boolean; expected: string | null }
interface Attestation { available: boolean; reason: string | null; version: string; bundle: string | null; containers: ContainerReport[]; pinnedAt: string | null }

export function AdminVault() {
  const toast = useToast();
  const [record, setRecord] = useState<RecoveryRecord | null>(null);
  const [attest, setAttest] = useState<Attestation | null>(null);
  const [shares, setShares] = useState<{ shares: string[]; threshold: number } | null>(null);
  const [makeOpen, setMakeOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [n, setN] = useState(5);
  const [k, setK] = useState(3);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [r, a] = await Promise.allSettled([
      api.get<{ record: RecoveryRecord | null }>('/api/admin/vault/recovery'),
      api.get<Attestation>('/api/admin/vault/attestation'),
    ]);
    if (r.status === 'fulfilled') setRecord(r.value.record);
    if (a.status === 'fulfilled') setAttest(a.value);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const make = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ shares: string[]; threshold: number }>('/api/admin/vault/recovery', { shares: n, threshold: k });
      setShares({ shares: r.shares, threshold: r.threshold });
      setMakeOpen(false);
      await load();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const pin = async () => {
    setBusy(true);
    try { await api.post('/api/admin/vault/attestation/pin'); toast.success('Pinned what is running now'); await load(); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  return (
    <div className="stack-20">
      <section className="stack-12">
        <div>
          <h2><KeyRound size={17} /> Recovery shares</h2>
          <p className="muted small" style={{ maxWidth: '68ch' }}>
            Everything in the mail cache is encrypted with <code>ENCRYPTION_KEY</code> from{' '}
            <code>.env</code>. Lose that file and every cached message, every mailbox password and
            every index is gone — there is no reset by design. These shares split the key so that
            any few of them can rebuild it and any fewer reveal nothing at all. They are shown once
            and never stored: print them and keep them apart.
          </p>
        </div>

        {record ? (
          <div className="card pad-24 stack-8">
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              {record.current
                ? <Badge kind="success"><CheckCircle2 size={11} /> For the key in use</Badge>
                : <Badge kind="danger"><AlertTriangle size={11} /> For a different key</Badge>}
              <span className="muted small">
                {record.k} of {record.n}, made {fmtRelative(record.createdAt)}
              </span>
            </div>
            {!record.current && (
              <Callout kind="warning">
                These shares were made for a different <code>ENCRYPTION_KEY</code> than the one this
                install is running. They will not restore it. Make a new set.
              </Callout>
            )}
            <p className="muted small">
              To use them: <code>./bin/tern recover-key</code> on the box, then paste any {record.k}.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <Button onClick={() => setMakeOpen(true)}>Make a new set</Button>
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setForgetOpen(true)}>Forget this set</Button>
            </div>
          </div>
        ) : (
          <div className="card pad-24 stack-8">
            <p className="muted small">No recovery shares have been made.</p>
            <div><Button variant="primary" onClick={() => setMakeOpen(true)}>Make recovery shares</Button></div>
          </div>
        )}
      </section>

      <section className="stack-12">
        <div>
          <h2><ShieldCheck size={17} /> What is running</h2>
          <p className="muted small" style={{ maxWidth: '68ch' }}>
            Every privacy claim this app makes is a claim about code. This is which images the
            containers actually started from, and whether any of them has changed since you last
            said "this is what I meant to install".
          </p>
        </div>
        <div className="card">
          {!attest ? <div className="center pad-24"><Spinner /></div>
            : !attest.available ? <div className="pad-24 muted small">{attest.reason}</div>
              : (
                <>
                  {attest.containers.map((c) => (
                    <div key={c.name} className="attest-row">
                      <Box size={14} className="muted" />
                      <span className="attest-name">{c.name}</span>
                      <span className="attest-digest flex-1" title={c.image}>{c.image}</span>
                      {c.source === 'local' && <Badge>built here</Badge>}
                      {c.drifted
                        ? <Badge kind="warning"><AlertTriangle size={11} /> changed</Badge>
                        : c.expected ? <Badge kind="success">matches</Badge> : null}
                    </div>
                  ))}
                  <div className="attest-row">
                    <span className="muted small flex-1">
                      Tern {attest.version}
                      {attest.bundle ? ` · bundle ${attest.bundle.slice(7, 19)}` : ''}
                      {attest.pinnedAt ? ` · pinned ${fmtRelative(attest.pinnedAt)}` : ' · nothing pinned yet'}
                    </span>
                    <Button size="sm" icon={<RefreshCw size={13} />} loading={busy} onClick={pin}>
                      Pin what is running now
                    </Button>
                  </div>
                </>
              )}
        </div>
      </section>

      <Modal
        open={makeOpen}
        onClose={() => setMakeOpen(false)}
        title="Make recovery shares"
        footer={<><Button onClick={() => setMakeOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={make}>Make them</Button></>}
      >
        <div className="stack-12">
          <Callout kind="warning">
            They are shown once. There is no way to see them again, because nothing about them is
            stored — that is what makes them safe to make.
          </Callout>
          <Field label="How many shares" hint="Keep them in separate places.">
            <Input type="number" min={2} max={16} value={n} onChange={(e) => setN(Number(e.target.value))} />
          </Field>
          <Field label="How many are needed" hint={`Any ${Math.min(k, n)} of the ${n} rebuild the key. Fewer reveal nothing at all.`}>
            <Input type="number" min={2} max={n} value={k} onChange={(e) => setK(Number(e.target.value))} />
          </Field>
        </div>
      </Modal>

      <SharesModal shares={shares} onClose={() => setShares(null)} />

      <Confirm
        open={forgetOpen}
        onClose={() => setForgetOpen(false)}
        onConfirm={async () => {
          await api.del('/api/admin/vault/recovery');
          setForgetOpen(false);
          await load();
          toast.success('Forgotten');
        }}
        title="Forget this set?"
        danger
        confirmLabel="Forget"
        message="Tern stops recording that these shares exist. The printed shares still rebuild the key — this only removes the note saying they were made, and with it the check that tells you whether they are still the right ones."
      />
    </div>
  );
}

function SharesModal({ shares, onClose }: { shares: { shares: string[]; threshold: number } | null; onClose: () => void }) {
  const [ack, setAck] = useState(false);
  useEffect(() => { if (shares) setAck(false); }, [shares]);
  if (!shares) return null;
  return (
    <Modal
      open
      onClose={ack ? onClose : () => {}}
      size="wide"
      title="Your recovery shares"
      footer={
        <>
          <Button icon={<Printer size={14} />} onClick={() => window.print()}>Print</Button>
          <Button variant={ack ? 'primary' : 'default'} disabled={!ack} onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="stack-12 share-print">
        <Callout kind="warning">
          This is the only time these are shown. Write them down or print them now.
          Any <strong>{shares.threshold}</strong> of these <strong>{shares.shares.length}</strong> rebuild the key;
          any fewer reveal nothing.
        </Callout>
        <div className="share-list">
          {shares.shares.map((s, i) => (
            <div key={i} className="share-item">
              <span className="share-index">Share {i + 1}</span>
              <span className="share-code">{s}</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          To use them, on the server: <code>./bin/tern recover-key</code>, then paste any{' '}
          {shares.threshold}. It prints the <code>ENCRYPTION_KEY</code> line for <code>.env</code>.
        </p>
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span className="small">I have written these down somewhere safe.</span>
        </label>
      </div>
    </Modal>
  );
}
