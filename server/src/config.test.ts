// Reading the environment. The one that bites is a compose placeholder that
// was never substituted: podman-compose leaves `${KEY:-default}` alone when
// KEY is missing from .env, and the container then starts with the literal
// text as its value.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OLLAMA_NUM_PARALLEL = '${OLLAMA_NUM_PARALLEL:-2}';
process.env.OLLAMA_MEM_LIMIT = '${OLLAMA_MEM_LIMIT:-2560m}';
process.env.OLLAMA_KV_CACHE_TYPE = '  ';
process.env.SYNC_POLL_SECONDS = '45';
const { config } = await import('./config.js');

test('an unsubstituted compose placeholder is not a value', () => {
  // It used to throw on boot — `OLLAMA_NUM_PARALLEL must be an integer` —
  // rather than falling back to the default written beside it.
  assert.equal(config.ollamaNumParallel, 2);
  assert.equal(config.ollamaMemLimitBytes, 0);
  assert.equal(config.ollamaKvCacheType, 'f16');
});

test('a real value is still read, and still parsed', () => {
  assert.equal(config.syncPollSeconds, 45);
});

test('memory limits are read the way compose writes them', async () => {
  // Same parser, exercised through the public value: bytes, kB, MB and GB.
  for (const [text, want] of [['2300m', 2300 * 1024 ** 2], ['4g', 4 * 1024 ** 3], ['1024', 1024], ['2.5g', Math.round(2.5 * 1024 ** 3)]] as const) {
    process.env.OLLAMA_MEM_LIMIT = text;
    const fresh = await import(`./config.js?${text}`);
    assert.equal(fresh.config.ollamaMemLimitBytes, want, text);
  }
});
