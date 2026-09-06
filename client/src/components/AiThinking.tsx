import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';

// A reasoning model's working-out, streamed while it happens. Every place the
// assistant writes shows it the same way: quieter than the answer, folded
// away as soon as the answer starts, and never what gets inserted. Without it
// a thinking model looks like a stalled spinner for a minute or two.

export interface AiThinkingTrace {
  text: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  reset: () => void;
  /** Feed it every SSE event. True when the event was reasoning, so a caller can skip it. */
  onEvent: (event: string, data: { t?: string }) => boolean;
}

export function useAiThinking(): AiThinkingTrace {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(true);
  return {
    text,
    open,
    setOpen,
    reset: () => { setText(''); setOpen(true); },
    onEvent: (event, data) => {
      if (event === 'thinking') { setText((t) => t + (data.t ?? '')); return true; }
      // The answer has started arriving: the working-out folds itself away.
      if (event === 'token' || event === 'done') setOpen(false);
      return false;
    },
  };
}

export function AiThinking({ trace, busy, className }: { trace: AiThinkingTrace; busy?: boolean; className?: string }) {
  const body = useRef<HTMLDivElement | null>(null);
  // Follow the reasoning as it is written, the way a log tails.
  useEffect(() => { const el = body.current; if (el && trace.open) el.scrollTop = el.scrollHeight; }, [trace.text, trace.open]);
  if (!trace.text) return null;
  return (
    <div className={className ? `ai-thinking ${className}` : 'ai-thinking'}>
      <button type="button" className="ai-thinking-head" onClick={() => trace.setOpen(!trace.open)} aria-expanded={trace.open}>
        <ChevronRight size={13} className={trace.open ? 'rot90' : ''} />
        <Brain size={13} />
        <span>{busy ? 'Working it out' : 'Reasoning'}</span>
        <span className="faint">· not part of the draft</span>
      </button>
      {trace.open && <div className="ai-thinking-body" ref={body}>{trace.text}</div>}
    </div>
  );
}
