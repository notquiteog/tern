// Dictation (F9), as a button that can be attached to anything.
//
// The requirement was "any text entry", which rules out building it into the
// composer and calling it done. So this is two pieces: a hook that records
// and transcribes, and a button that knows how to put the result into
// whatever it is sitting next to — an <input>, a <textarea>, or the
// contenteditable the rich editor uses. Text is inserted at the cursor and
// the cursor ends after it, which is what makes it feel like typing rather
// than like a form filling itself in.
//
// The recording never touches disk on either side. It exists as a Blob in
// the tab, goes up as the request body, and the server zeroes its buffer
// before replying. Nothing is stored, here or there.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { uploadWithWork } from '../lib/work';
import { useVoiceConfigured } from '../lib/queries';
import { useCan } from '../state/features';
import { useToast } from '../state/toast';

export type DictateState = 'idle' | 'recording' | 'working';

// Formats a browser will give us, in the order we would rather have them.
// Opus in WebM is small and universally supported by whisper builds; the
// others are what Safari offers.
const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/wav'];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of PREFERRED) if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}

export function useDictation(onText: (text: string) => void) {
  const toast = useToast();
  const [state, setState] = useState<DictateState>('idle');
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
    chunks.current = [];
  }, []);

  // A tab that is closed or navigated away from mid-recording must release
  // the microphone; the browser's indicator staying on is alarming and fair.
  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    const mimeType = pickMimeType();
    if (!mimeType) { toast.error('This browser cannot record audio'); return; }
    // Browsers hide mediaDevices entirely outside a secure context, so on a
    // plain-HTTP install this is undefined rather than a refusal. Saying so
    // is kinder than "no microphone", which sends people to their hardware.
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error(window.isSecureContext
        ? 'This browser cannot record audio'
        : 'Dictation needs a secure connection. Serve Tern over HTTPS, or use localhost.');
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as Error).name;
      toast.error(name === 'NotAllowedError'
        ? 'The microphone was not allowed. Check the permission for this site.'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'No microphone is available.'
          : 'The microphone could not be started.');
      return;
    }
    stream.current = media;
    const rec = new MediaRecorder(media, { mimeType });
    recorder.current = rec;
    chunks.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks.current, { type: mimeType.split(';')[0] });
      chunks.current = [];
      cleanup();
      if (blob.size < 1200) { setState('idle'); return; } // a tap, not a sentence
      setState('working');
      try {
        const r = await uploadWithWork<{ text: string }>('voice', '/api/assist/voice', blob, blob.type);
        if (r.text) onText(r.text);
        else toast.toast('Nothing was said in that recording');
      } catch (e) {
        toast.error(e);
      } finally {
        setState('idle');
      }
    };
    rec.start();
    setState('recording');
    // A recorder left running is a microphone left on. Two minutes is the
    // server's ceiling too, so stopping here avoids an upload that would be
    // refused.
    window.setTimeout(() => { if (recorder.current?.state === 'recording') stop(); }, 120_000);
  }, [cleanup, onText, stop, toast]);

  return { state, start, stop, toggle: () => (state === 'recording' ? stop() : void start()) };
}

// The button. Renders nothing at all when dictation is not both installed
// and turned on, which is the rule everywhere: no control for a feature that
// would fail.
export function DictateButton({ onText, title = 'Dictate', className }: { onText: (text: string) => void; title?: string; className?: string }) {
  const can = useCan('voice');
  const { data: configured, isError } = useVoiceConfigured(can);
  const { state, toggle } = useDictation(onText);

  if (!can || configured === false || isError) return null;

  return (
    <button
      type="button"
      className={`btn btn-icon dictate-btn${state === 'recording' ? ' dictate-recording' : ''}${className ? ` ${className}` : ''}`}
      title={state === 'recording' ? 'Stop and transcribe' : state === 'working' ? 'Transcribing…' : title}
      aria-label={state === 'recording' ? 'Stop and transcribe' : title}
      aria-pressed={state === 'recording'}
      disabled={state === 'working'}
      onClick={toggle}
    >
      {state === 'working' ? <Loader2 size={15} className="spin" /> : state === 'recording' ? <Square size={14} /> : <Mic size={15} />}
    </button>
  );
}

// Talking into a field that already has words in it adds to them rather than
// replacing them: a second sentence spoken after a first is a second
// sentence, not a correction. The space is the one the speaker would have
// left. Search is the exception and says so where it overrides this.
export function appendDictated(prev: string, text: string): string {
  const base = prev.replace(/\s+$/, '');
  return base ? `${base} ${text}` : text;
}

// A mic docked inside a text box rather than beside it, for the AI fields
// that are a paragraph rather than a line. A button next to a full-width
// textarea either squashes it or sits oddly under it; this puts the mic in a
// gutter the text never runs into. When dictation is off the button renders
// nothing and the CSS gives the gutter back, so those installs see exactly
// the box they had.
export function DictateBox({ onText, title = 'Dictate', className, children }: { onText: (text: string) => void; title?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`dictate-box${className ? ` ${className}` : ''}`}>
      {children}
      <DictateButton className="btn-sm" title={title} onText={onText} />
    </div>
  );
}

// Puts text where the cursor is, for the three kinds of field in this app.
// Exported because the composer's editor and the search box both want it and
// neither is a plain input.
export function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null, text: string): void {
  if (!el || !text) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    // A space between a word and dictated text, unless one is already there.
    const glue = before && !/\s$/.test(before) ? ' ' : '';
    el.value = `${before}${glue}${text}${after}`;
    const at = start + glue.length + text.length;
    el.setSelectionRange(at, at);
    // React listens for input events, not for assignments to .value.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return;
  }
  // contenteditable: insert at the selection if it is inside this element,
  // and at the end if it is not.
  el.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    el.appendChild(document.createTextNode(text));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
