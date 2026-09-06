import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { chatStream, deleteModel, forgetModelCapabilities, getAiSettings, isValidKeepAlive, listModels, loadedModels, modelCanThink, modelKvBytesPerToken, ollamaHealth, pullModel, releaseReplacedModel, saveAiSettings, unloadModel, aiDefaults, type AiSettings } from '../ai/llm.js';
import { slotAdvice, slotPlan, slotStats } from '../ai/slots.js';
import { hostMemory } from '../ai/memory.js';
import { createPreset, deletePreset, listPresets, updatePreset, PRESET_FIELDS } from '../ai/presets.js';
import { buildMessages, finalizeOutput, modeTuning, threadBudgetChars, DEFAULT_SYSTEM_PROMPT, type DraftInput } from '../ai/prompts.js';
import { CURATED_MODELS, MODEL_TIERS, recommendModel } from '../ai/models.js';
import { config } from '../config.js';
import { getUserAccount, listAccounts } from '../services/accounts.js';
import { htmlToText } from '../services/merge.js';
import { rateLimit } from '../util/rateLimit.js';
import { logger } from '../log.js';
import { openEmails } from '../services/mailVault.js';
import { cachedSummaries, generateSummary, MAX_PER_REQUEST } from '../services/summaries.js';

const log = logger('ai');

export const aiRouter = Router();
aiRouter.use(requireAuth);

function sse(res: any) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
}

// Members learn whether drafting works and which model answers; the
// provider address, prompt, tuning and model catalogue are for admins.
aiRouter.get('/status', async (req, res) => {
  const s = await getAiSettings();
  const health = await ollamaHealth();
  let models: Awaited<ReturnType<typeof listModels>> = [];
  let loaded: Awaited<ReturnType<typeof loadedModels>> = [];
  if (health.ok && s.provider === 'ollama') {
    try { models = await listModels(); loaded = await loadedModels(); } catch { /* reported via health */ }
  }
  const modelInstalled = s.provider !== 'ollama' || models.some((m) => m.name === s.model || m.name === `${s.model}:latest`);
  if (req.user!.role !== 'admin') {
    res.json({ settings: { enabled: s.enabled, model: s.model, provider: s.provider }, health: { ok: health.ok, error: health.ok ? undefined : 'not reachable' }, modelInstalled, models: [], loaded: [], curated: [], tiers: [] });
    return;
  }
  // Whether the chosen model can reason at all. Turning "let reasoning models
  // think" on for a model that cannot is the usual reason someone sees no
  // working-out and assumes the streamer is broken.
  const canThink = health.ok && s.provider === 'ollama' ? await modelCanThink(s.baseUrl, s.model) : null;
  const { apiKey, ...safe } = s;
  res.json({
    settings: { ...safe, hasApiKey: Boolean(apiKey) },
    health,
    models,
    loaded,
    concurrency: await concurrencyView(s, models),
    presets: await listPresets(),
    modelInstalled,
    modelCanThink: canThink,
    recommended: recommendModel(config.totalMemBytes),
    tiers: MODEL_TIERS,
    curated: CURATED_MODELS,
    totalMemGiB: Math.round((config.totalMemBytes / 1024 ** 3) * 10) / 10,
    defaults: (({ apiKey: _k, ...d }) => d)(aiDefaults()),
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
});

// How many people this install can answer at once, and whether that is
// enough for the people who have accounts. Ollama fixes its slot count when
// it starts, so the app cannot raise it — it can only say what to set, which
// is what `./bin/tern ai-slots` then does.
async function concurrencyView(s: AiSettings, models: Awaited<ReturnType<typeof listModels>>) {
  const users = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE NOT disabled`))?.n ?? 1;
  const plan = slotPlan(s.concurrency);
  const kvPerToken = s.provider === 'ollama' ? await modelKvBytesPerToken(s.baseUrl, s.model).catch(() => null) : null;
  const modelBytes = models.find((m) => m.name === s.model || m.name === `${s.model}:latest`)?.size ?? 0;
  const advice = slotAdvice({ users, configured: config.ollamaNumParallel, numCtx: s.numCtx, kvPerToken, modelBytes, memBudgetBytes: config.ollamaMemLimitBytes });
  return { ...advice, plan, kvCacheType: config.ollamaKvCacheType, memLimitBytes: config.ollamaMemLimitBytes || null, stats: slotStats() };
}

// The live meter. Polled by Admin → AI model every few seconds, so it stays
// small: one read of /proc/meminfo and one /api/ps.
aiRouter.get('/memory', requireAdmin, async (_req, res) => {
  const s = await getAiSettings();
  const host = await hostMemory();
  let loaded: Awaited<ReturnType<typeof loadedModels>> = [];
  if (s.provider === 'ollama') { try { loaded = await loadedModels(); } catch { /* shown as nothing resident */ } }
  const resident = loaded.reduce((n, m) => n + (m.size ?? 0), 0);
  const vram = loaded.reduce((n, m) => n + (m.sizeVram ?? 0), 0);
  const kvPerToken = s.provider === 'ollama' ? await modelKvBytesPerToken(s.baseUrl, s.model).catch(() => null) : null;
  const plan = slotPlan(s.concurrency);
  const perSlotBytes = kvPerToken ? Math.round(kvPerToken * s.numCtx) : null;
  res.json({
    host,
    ollama: { limitBytes: config.ollamaMemLimitBytes || null, resident, vram, models: loaded },
    slots: { ...plan, ...slotStats(), perSlotBytes, kvBytes: perSlotBytes === null ? null : perSlotBytes * plan.slots, kvCacheType: config.ollamaKvCacheType, numCtx: s.numCtx },
  });
});

// How the model writes. The same shape is accepted on the settings and on a
// preset, because a preset is exactly these fields under a name — one list,
// so a bound can never be enforced in one place and not the other.
const TUNING_SHAPE = {
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(200).optional(),
  minP: z.number().min(0).max(1).optional(),
  repeatPenalty: z.number().min(0.5).max(2).optional(),
  // -1 is "the whole context", 0 turns repetition tracking off; anything
  // else is a window in tokens.
  repeatLastN: z.number().int().min(-1).max(8192).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  maxTokens: z.number().int().min(64).max(4096).optional(),
  allowThinking: z.boolean().optional(),
  thinkEffort: z.enum(['low', 'medium', 'high']).optional(),
  thinkingBudget: z.number().int().min(0).max(8192).optional(),
};
const presetBody = z.object({
  name: z.string().min(1).max(60),
  note: z.string().max(400).optional(),
  forModel: z.string().max(120).optional(),
  values: z.object(TUNING_SHAPE),
});

aiRouter.get('/presets', requireAdmin, async (_req, res) => {
  res.json({ presets: await listPresets(), fields: PRESET_FIELDS });
});

// A preset is applied by the browser: it puts the numbers into the tuning
// form and saves them like any other change, so applying one is audited, and
// reversible, exactly the way editing the sliders by hand is.
aiRouter.post('/presets', requireAdmin, async (req, res) => {
  const b = parse(presetBody, req.body);
  const presets = await createPreset(b).catch((e) => { throw badRequest((e as Error).message); });
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'ai.preset_created',$2)`, [req.user!.id, JSON.stringify({ name: b.name })]);
  res.json({ presets });
});

aiRouter.put('/presets/:id', requireAdmin, async (req, res) => {
  const b = parse(presetBody.partial(), req.body);
  const presets = await updatePreset(String(req.params.id), b).catch((e) => { throw badRequest((e as Error).message); });
  res.json({ presets });
});

aiRouter.delete('/presets/:id', requireAdmin, async (req, res) => {
  const presets = await deletePreset(String(req.params.id)).catch((e) => { throw badRequest((e as Error).message); });
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'ai.preset_deleted',$2)`, [req.user!.id, JSON.stringify({ id: req.params.id })]);
  res.json({ presets });
});

aiRouter.put('/settings', requireAdmin, async (req, res) => {
  const b = parse(z.object({ ...TUNING_SHAPE, enabled: z.boolean().optional(), provider: z.enum(['ollama', 'openai']).optional(), baseUrl: z.string().url().optional(), apiKey: z.string().max(500).optional(), model: z.string().min(1).max(120).optional(), numCtx: z.number().int().min(512).max(131072).optional(), keepAlive: z.string().max(20).optional(),
    systemPrompt: z.string().max(8000).optional(),
    concurrency: z.boolean().optional() }), req.body);
  // Caught here rather than at the model: Ollama refuses a bare number as a
  // duration, so "-1" has to be recognised as seconds before it is stored.
  if (b.keepAlive !== undefined && !isValidKeepAlive(b.keepAlive)) {
    throw badRequest('Keep model loaded needs a duration with a unit (30s, 10m, 1h), or a number of seconds (-1 to never unload, 0 to unload at once)');
  }
  if (b.model !== undefined || b.baseUrl !== undefined || b.provider !== undefined) forgetModelCapabilities();
  const before = await getAiSettings();
  const next = await saveAiSettings(b);
  // Picking a different model drops the previous one from memory rather than
  // leaving it to time out beside its replacement. Best effort: a mail server
  // that cannot reach Ollama should still be able to save its settings.
  try { await releaseReplacedModel(before, next); } catch { /* reported by /status */ }
  const { apiKey, ...safe } = next;
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'ai.settings_updated',$2)`, [req.user!.id, JSON.stringify({ ...b, apiKey: b.apiKey ? '(set)' : undefined })]);
  res.json({ settings: { ...safe, hasApiKey: Boolean(apiKey) } });
});

aiRouter.post('/models/pull', requireAdmin, async (req, res) => {
  const { name } = parse(z.object({ name: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/) }), req.body);
  const send = sse(res);
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  try {
    for await (const p of pullModel(name, abort.signal)) send('progress', p);
    send('done', { ok: true });
  } catch (e) {
    send('error', { error: (e as Error).message });
  }
  res.end();
});

aiRouter.delete('/models/:name', requireAdmin, async (req, res) => {
  await deleteModel(String(req.params.name));
  res.json({ ok: true });
});

// Frees the memory a resident model is holding without deleting it from disk.
// Ollama loads it again on the next request, so this costs a slow first
// generation and nothing else.
aiRouter.post('/models/unload', requireAdmin, async (req, res) => {
  const { name } = parse(z.object({ name: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/) }), req.body);
  const s = await getAiSettings();
  if (s.provider !== 'ollama') throw badRequest('Only an Ollama model can be unloaded from here');
  const unloaded = await unloadModel(s.baseUrl, name);
  res.json({ unloaded });
});

// One-line summaries for the conversations the browser can currently see.
// Anything already written comes back at once; a few of the missing ones are
// generated per request so a page of fifty does not queue fifty generations
// on someone's CPU.
aiRouter.post('/summaries', rateLimit({ name: 'ai-summaries', perMinute: 30, message: 'Too many summary requests; wait a moment' }), async (req, res) => {
  const b = parse(z.object({ keys: z.array(z.string().max(200)).max(60), generate: z.boolean().optional() }), req.body);
  const s = await getAiSettings();
  // Pairs of accountId:threadId, kept only where the account is this user's.
  const wanted: { accountId: number; threadId: string }[] = [];
  for (const k of b.keys) {
    const i = k.indexOf(':');
    if (i <= 0) continue;
    const accountId = Number(k.slice(0, i));
    const threadId = k.slice(i + 1);
    if (Number.isFinite(accountId) && threadId) wanted.push({ accountId, threadId });
  }
  const mine = new Map((await listAccounts(req.user!.id)).map((a) => [a.id, a]));
  const allowed = wanted.filter((w) => mine.has(w.accountId));
  const cached = await cachedSummaries(req.user!.id, [...new Set(allowed.map((w) => w.accountId))], [...new Set(allowed.map((w) => w.threadId))]);
  const out: Record<string, string> = {};
  for (const [k, v] of cached) out[k] = v.text;

  if (b.generate && s.enabled) {
    // Stale lines first — they are describing a conversation that has moved
    // on — then the ones with nothing at all.
    const missing = allowed.filter((w) => !cached.has(`${w.accountId}:${w.threadId}`));
    const stale = allowed.filter((w) => cached.get(`${w.accountId}:${w.threadId}`)?.stale);
    for (const w of [...stale, ...missing].slice(0, MAX_PER_REQUEST)) {
      try {
        const made = await generateSummary(req.user!.id, mine.get(w.accountId)!, w.threadId);
        if (made) out[`${w.accountId}:${w.threadId}`] = made.text;
      } catch (e) {
        // A model that is down must not fail the list, but it must not fail
        // silently either: a summary that never appears is otherwise
        // indistinguishable from one the model declined to write.
        log.warn('summary generation failed', { account: w.accountId, thread: w.threadId, err: (e as Error).message });
      }
    }
  }
  res.json({ summaries: out, enabled: s.enabled });
});

const draftSchema = z.object({
  mode: z.enum(['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish', 'quick_replies']),
  instruction: z.string().max(4000).optional(),
  tone: z.string().max(60).optional(),
  length: z.enum(['short', 'medium', 'long']).optional(),
  accountId: z.number().int().nullable().optional(),
  contactId: z.number().int().nullable().optional(),
  threadKey: z.string().max(200).nullable().optional(),
  draft: z.string().max(60000).optional(),
  subject: z.string().max(998).optional(),
  recipientEmail: z.string().max(320).optional(),
  recipientName: z.string().max(200).optional(),
  template: z.string().max(60000).optional(),
});

// Only these modes work on what is in the editor. The others (compose, reply,
// summarize) start from the task's own inputs, so a previous generation that
// was inserted into the editor never feeds the next one.
const DRAFT_MODES = new Set(['rewrite', 'polish', 'shorten', 'expand', 'subject']);

// Streams tokens as SSE. The browser inserts them into the editor as they
// arrive so a slow CPU-only model still feels responsive.
aiRouter.post('/draft', rateLimit({ name: 'ai-draft', perMinute: 40, message: 'The assistant is busy with your earlier requests; wait a moment' }), async (req, res) => {
  const b = parse(draftSchema, req.body);
  const s = await getAiSettings();
  if (!s.enabled) throw badRequest('AI drafting is turned off');
  const acc = b.accountId ? await getUserAccount(req.user!.id, b.accountId) : null;
  // How this mode is tuned, and how much of a conversation it may be given:
  // the same numbers the scheduler uses for responders and campaigns.
  const tuning = modeTuning(b.mode);
  const threadChars = Math.min(threadBudgetChars(s.numCtx, tuning.maxTokens ?? s.maxTokens), tuning.threadChars ?? Infinity);
  const input: DraftInput = { mode: b.mode, instruction: b.instruction, tone: b.tone, length: b.length, senderName: acc?.name ?? req.user!.display_name, senderEmail: acc?.email, draft: DRAFT_MODES.has(b.mode) && b.draft ? htmlToText(b.draft) : undefined, subject: b.subject, template: b.template, systemPrompt: s.systemPrompt, voice: acc?.voice, threadChars };
  if (b.contactId) {
    const c = await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [b.contactId, req.user!.id]);
    if (c) input.recipient = { name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, company: c.company, title: c.title, notes: c.notes, fields: c.fields };
  } else if (b.recipientEmail) {
    const c = await one<any>('SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=lower($2)', [req.user!.id, b.recipientEmail]);
    input.recipient = c ? { name: [c.first_name, c.last_name].filter(Boolean).join(' ') || b.recipientName, email: c.email, company: c.company, title: c.title, notes: c.notes, fields: c.fields } : { name: b.recipientName?.trim() || undefined, email: b.recipientEmail };
  }
  if (b.threadKey) {
    const [accId, threadId] = b.threadKey.split(':');
    const tacc = await getUserAccount(req.user!.id, Number(accId));
    if (!tacc) throw notFound('Thread not found');
    const msgs = await openEmails(req.user!.id, await query<any>('SELECT from_addr, received_at, body_text, body_html, preview FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC', [tacc.id, threadId]));
    input.thread = msgs.map((m) => ({ from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(), date: new Date(m.received_at).toDateString(), text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').replace(/\n>.*$/gm, '').trim() }));
    // A reply goes to whoever wrote to us; if we only have their address, the thread usually has their name.
    if (input.recipient?.email && !input.recipient.name) {
      const hit = msgs.map((m) => m.from_addr?.[0]).find((a: any) => a?.email && a.name && String(a.email).toLowerCase() === input.recipient!.email!.toLowerCase());
      if (hit) input.recipient.name = String(hit.name);
    }
  }
  const send = sse(res);
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  let full = '';
  try {
    send('start', { model: s.model });
    // Short modes have their own ceiling; a full draft uses the reply length
    // set in Admin → AI model, which is what the "empty answer" message
    // tells people to raise.
    for await (const piece of chatStream({
      messages: buildMessages(input), signal: abort.signal, maxTokens: tuning.maxTokens, temperature: tuning.temperature, stop: tuning.stop,
      // Somebody is watching this one arrive, and it is theirs: it takes an
      // interactive slot, and only one person's worth of them.
      owner: req.user!.id,
      // Reasoning is shown while it happens and never inserted into the
      // editor: the browser keeps it in its own panel and drops it when the
      // draft itself starts arriving.
      onThinking: (t) => send('thinking', { t }),
    })) {
      full += piece;
      send('token', { t: piece });
    }
    send('done', { text: finalizeOutput(full, b.mode, { recipient: input.recipient, senderName: input.senderName, senderEmail: input.senderEmail }) });
  } catch (e) {
    send('error', { error: (e as Error).message });
  }
  res.end();
});
