import { Bot } from 'lucide-react';
import { useAssistant, type ViewContext } from '../state/assistant';
import { useCan } from '../state/features';
import { Button } from './ui';

/** Reuse the dock and its tools from wherever the question comes up. */
export function AskAssistant({ label = 'Ask assistant', prompt, context, onAsk }: {
  label?: string; prompt?: string; context?: ViewContext; onAsk?: () => void;
}) {
  const assistant = useAssistant();
  const can = useCan('ai.assistant');
  if (!can) return null;
  return <Button size="sm" variant="ai" icon={<Bot size={14} />} onClick={() => { assistant.show(prompt, context); onAsk?.(); }}>{label}</Button>;
}
