import { threadForPrompt, realisticThread } from './fixtures.js';
import { countTokens } from './tokens.js';
async function main() {
  for (const n of [5, 10, 20, 24, 30, 50]) {
    const t = threadForPrompt(n);
    const joined = t.map((m) => `--- From ${m.from} on ${m.date}\n${m.text}`).join('\n');
    console.log(`depth ${String(n).padStart(2)}: ${t.length} msgs, ${joined.length} chars, ${await countTokens(joined, 'qwen3.5:4b')} tokens`);
  }
  const all = realisticThread();
  console.log(`per-message chars: ${all.map((m) => m.text.length).join(', ')}`);
}
void main();
