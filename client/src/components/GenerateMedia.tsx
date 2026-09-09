// Making a picture or a short video from a sentence, in the composer.
//
// ── Why this is a panel and not a one-click button ──────────────────────────
//
// Because every generation costs the administrator real money on somebody
// else's hardware, and because a picture is not a draft: a draft that comes
// back wrong is deleted and rewritten in the same second, whereas a picture
// that comes back wrong has already been paid for. So the prompt is written
// deliberately, what came back is shown before it goes anywhere near the
// message, and putting it in is a separate act from making it.
//
// ── Why the panel says where the prompt is going ────────────────────────────
//
// There is no bundled image server and there is not going to be one, so
// unlike every other model in this app the answer to "does this leave the
// box" is almost always yes. The rest of Tern is careful to say that where it
// is true; this is the one feature where it is true by default, and the line
// under the box says so rather than leaving somebody to infer it from an
// address only an admin can see.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clapperboard, ImagePlus, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { postWithWork } from '../lib/work';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';
import { Button, Field, IconButton, Input, Modal, Segmented, Spinner, Textarea } from './ui';
import { fmtBytes } from '../lib/format';

export interface GeneratedUpload { id: number; filename: string; content_type: string; size: number }

interface MediaStatus {
  images: boolean;
  videos: boolean;
  imageModel: string;
  videoModel: string;
  videoSeconds: number;
  local: { image: boolean | null; video: boolean | null };
}

interface VideoJob {
  id: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  status: string;
  pct: number | null;
  upload?: GeneratedUpload;
  error?: string;
}

// A fact about the install rather than about the screen, so it is asked once
// and kept: only an admin can change it, and the composer opens often.
export const useMediaStatus = (enabled = true) => useQuery({
  queryKey: ['media-status'],
  queryFn: () => api.get<MediaStatus>('/api/ai/media/status'),
  staleTime: 5 * 60_000,
  retry: false,
  enabled,
});

/**
 * The button, which is absent rather than disabled when there is nothing
 * behind it.
 *
 * A greyed-out button is a promise the install has not made: an admin who has
 * not configured an image host has not decided to have this feature and
 * should not be advertised one, and a member who has not turned the
 * capability on in Settings → Features is told where to go rather than shown
 * a control that fails.
 */
export function GenerateMediaButton({ onInsert, onAttach }: {
  onInsert: (url: string, alt: string) => void;
  onAttach: (upload: GeneratedUpload) => void;
}) {
  const can = useCan('ai.media');
  const status = useMediaStatus(can);
  const [open, setOpen] = useState(false);
  if (!can || !status.data || (!status.data.images && !status.data.videos)) return null;
  return (
    <>
      <IconButton label="Make a picture" onClick={() => setOpen(true)}><ImagePlus size={17} /></IconButton>
      <GenerateMediaModal open={open} onClose={() => setOpen(false)} status={status.data} onInsert={onInsert} onAttach={onAttach} />
    </>
  );
}

function GenerateMediaModal({ open, onClose, status, onInsert, onAttach }: {
  open: boolean;
  onClose: () => void;
  status: MediaStatus;
  onInsert: (url: string, alt: string) => void;
  onAttach: (upload: GeneratedUpload) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<'image' | 'video'>(status.images ? 'image' : 'video');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ upload: GeneratedUpload; revisedPrompt?: string | null } | null>(null);
  const [job, setJob] = useState<VideoJob | null>(null);
  const stream = useRef<EventSource | null>(null);

  // A generation that is still running when the panel closes keeps going on
  // the server — that is the whole point of it being a job — so this only
  // stops listening. See ai/media.ts.
  useEffect(() => () => { stream.current?.close(); stream.current = null; }, []);

  function reset(): void {
    stream.current?.close();
    stream.current = null;
    setMade(null); setJob(null); setBusy(false);
  }

  function close(): void { reset(); setPrompt(''); onClose(); }

  async function generate(): Promise<void> {
    const text = prompt.trim();
    if (text.length < 2) return;
    reset();
    setBusy(true);
    try {
      if (kind === 'image') {
        const r = await postWithWork<{ upload: GeneratedUpload; revisedPrompt: string | null }>(
          'ai', '/api/ai/media/image', { prompt: text, ...(size ? { size } : {}) });
        setMade({ upload: r.upload, revisedPrompt: r.revisedPrompt });
        setBusy(false);
        return;
      }
      const r = await postWithWork<{ job: VideoJob }>('ai', '/api/ai/media/video', { prompt: text, ...(size ? { size } : {}) });
      setJob(r.job);
      watch(r.job.id);
    } catch (e) { toast.error(e); setBusy(false); }
  }

  // Watching rather than driving: dropping this stream does not stop the
  // generation, and reopening the panel could pick it up again.
  function watch(id: string): void {
    const es = new EventSource(`/api/ai/media/video/${encodeURIComponent(id)}/stream`);
    stream.current = es;
    const settle = (view: VideoJob) => {
      setJob(view);
      es.close();
      stream.current = null;
      setBusy(false);
      if (view.state === 'error') toast.error(view.error ?? 'The video could not be made');
      // The finished view carries the whole upload row, so there is nothing
      // to go back and ask for — which matters because this stream may have
      // been reattached long after the request that started it.
      if (view.state === 'done' && view.upload) setMade({ upload: view.upload });
    };
    es.addEventListener('progress', (e) => setJob(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('done', (e) => settle(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => { es.close(); stream.current = null; setBusy(false); toast.error('Lost touch with the generation; it may still be running'); };
  }

  const model = kind === 'image' ? status.imageModel : status.videoModel;
  const local = kind === 'image' ? status.local.image : status.local.video;
  const both = status.images && status.videos;

  return (
    <Modal open={open} onClose={close} title={kind === 'video' ? 'Make a video' : 'Make a picture'} footer={
      <>
        <Button variant="ghost" onClick={close}>Close</Button>
        <Button variant="primary" loading={busy} disabled={prompt.trim().length < 2}
          icon={<Sparkles size={15} />} onClick={() => void generate()}>
          {made ? 'Make another' : kind === 'image' ? 'Make it' : 'Start'}
        </Button>
      </>
    }>
      {both && (
        <div className="mb-16">
          <Segmented value={kind} onChange={(v) => { setKind(v); reset(); }} options={[
            { value: 'image', label: <><ImagePlus size={13} /> Picture</> },
            { value: 'video', label: <><Clapperboard size={13} /> Video</> },
          ]} />
        </div>
      )}
      <Field label={kind === 'video' ? 'What should the video show?' : 'What should it be a picture of?'}>
        <Textarea rows={3} value={prompt} autoFocus placeholder="a grey heron on a wooden jetty at dawn, photographic"
          onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <p className="small muted">
        {/* The one sentence this panel exists to say. `local` is null when no
            address is set and false whenever the connection goes through Tor,
            which is a remote host by construction. */}
        {local === true
          ? <>{kind === 'video' ? 'Made' : 'Drawn'} by <code>{model}</code> on this server. Nothing leaves the box.</>
          : <>Your sentence is sent to <code>{model}</code> on the model host your administrator configured, which is not this machine. Nothing from your mailbox goes with it.</>}
      </p>
      <Field label="Size" hint={kind === 'video'
        ? `Leave empty for whatever the host defaults to. The clip is ${status.videoSeconds} seconds; only an administrator can change that, because it is what each one costs.`
        : 'Leave empty for whatever the host defaults to. Not every model accepts every size.'}>
        <Input value={size} onChange={(e) => setSize(e.target.value)} placeholder={kind === 'image' ? '1024x1024' : '1280x720'} style={{ maxWidth: 200 }} />
      </Field>

      {job && job.state === 'running' && (
        <div className="row gap-8 mt-16">
          <Spinner size={15} />
          <span className="small">
            {job.status}{job.pct !== null ? ` · ${job.pct}%` : ''} — a few seconds of video is minutes of work.
            You can close this; it keeps going.
          </span>
          <Button size="sm" variant="ghost" onClick={() => { void api.post(`/api/ai/media/video/${encodeURIComponent(job.id)}/cancel`).catch(() => {}); reset(); }}>Stop</Button>
        </div>
      )}

      {made && (
        <div className="mt-16">
          {/^image\//.test(made.upload.content_type)
            ? <img src={`/api/mail/uploads/${made.upload.id}?inline=1`} alt="" style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
            : <video src={`/api/mail/uploads/${made.upload.id}`} controls style={{ maxWidth: '100%', borderRadius: 8 }} />}
          {made.revisedPrompt && (
            <p className="small muted mt-8">That host rewrote the prompt before drawing: “{made.revisedPrompt}”</p>
          )}
          <div className="row gap-8 mt-8">
            {/* Inline for a picture, attached for a video: an <img> in an
                email body is ordinary and a <video> in one is not — mail
                clients do not play them, so a video belongs on the message
                rather than in it. */}
            {/^image\//.test(made.upload.content_type) && (
              <Button variant="primary" onClick={() => { onInsert(`/api/mail/uploads/${made.upload.id}?inline=1`, prompt.trim().slice(0, 120)); close(); }}>
                Put it in the message
              </Button>
            )}
            <Button variant={/^image\//.test(made.upload.content_type) ? 'ghost' : 'primary'}
              onClick={() => { onAttach(made.upload); close(); }}>
              Attach it{made.upload.size ? ` (${fmtBytes(made.upload.size)})` : ''}
            </Button>
            {/* Discarding deletes the upload rather than orphaning it: a
                generation nobody used should not sit in the database until
                the draft sweep happens to notice it. */}
            <IconButton label="Discard" onClick={() => { void api.del(`/api/mail/uploads/${made.upload.id}`).catch(() => {}); setMade(null); }}><X size={16} /></IconButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
