// How big a prompt actually is, according to the model that will read it.
//
// Character counts are what the thread budget is expressed in, and they are
// the wrong unit for judging whether a fixture is realistic: the old "deep
// thread" fixture was 2,322 characters, which sounds like a lot until it is
// 596 tokens and fits six times over in the smallest window Tern ships. So
// the evaluations report the token count of what they send, and they get it
// from the tokenizer rather than from a ratio.
//
// Ollama reports `prompt_eval_count` on any generation, so one token of
// output is enough to be told how many tokens went in. It is only used by the
// evaluation scripts and the depth sweep; nothing in the mail path calls it.
import { config } from '../config.js';

export interface PromptSize { tokens: number; chars: number }

// -1 when the endpoint would not say, so a report can print "unknown" rather
// than a number that is quietly a guess.
export async function countTokens(text: string, model: string, baseUrl = config.ollamaUrl): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
        stream: false,
        think: false,
        // One token out, and a window big enough that a long fixture is
        // counted rather than truncated before it is counted.
        options: { num_predict: 1, num_ctx: 131_072 },
        keep_alive: '5m',
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) return -1;
    const j: any = await res.json();
    return typeof j.prompt_eval_count === 'number' ? j.prompt_eval_count : -1;
  } catch {
    return -1;
  }
}

export async function sizeOf(text: string, model: string, baseUrl?: string): Promise<PromptSize> {
  return { tokens: await countTokens(text, model, baseUrl), chars: text.length };
}

export function describeSize(s: PromptSize): string {
  return `${s.chars.toLocaleString()} chars / ${s.tokens < 0 ? 'unknown' : s.tokens.toLocaleString()} tokens`;
}
