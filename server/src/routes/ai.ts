import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { chatStream, checkProvider, deleteModel, forgetModelCapabilities, getAiSettings, isValidKeepAlive, listModels, liveModels, loadedModels, modelCanThink, modelKvBytesPerToken, ollamaHealth, pullModel, releaseReplacedModel, saveAiSettings, unloadModel, aiDefaults, type AiSettings } from '../ai/llm.js';
import { cancelPull, listPulls, startPull, watchPull, type PullView } from '../ai/pulls.js';
import { slotAdvice, slotPlan, slotStats } from '../ai/slots.js';
import { hostMemory } from '../ai/memory.js';
import { createPreset, deletePreset, listPresets, updatePreset, PRESET_FIELDS } from '../ai/presets.js';
import { buildMessages, finalizeOutput, modeTuning, threadBudgetChars, writeDate, DEFAULT_SYSTEM_PROMPT, type DraftInput } from '../ai/prompts.js';
import { CURATED_MODELS, EMBED_MODELS, MODEL_TIERS, recommendModel } from '../ai/models.js';
import { EMBED_CATALOGUE, PROVIDER_PRESETS } from '../ai/providers.js';
import { getCommitment } from '../services/commitments.js';
import { config } from '../config.js';
import { getUserAccount, listAccounts } from '../services/accounts.js';
import { htmlToText } from '../services/merge.js';
import { rateLimit } from '../util/rateLimit.js';
import { logger } from '../log.js';
import { openEmails } from '../services/mailVault.js';
import { cachedSummaries, generateSummary, MAX_PER_REQUEST } from '../services/summaries.js';
import { requireCapability } from '../services/capabilities.js';
import { availabilityFor } from '../services/calendar/index.js';
import { invalidateVectorsFrom } from '../services/semantic.js';
import { powGuard } from '../services/workGuard.js';
import { deleteVoiceModel, getVoiceSettings, pullVoiceModel, saveVoiceSettings, validVoiceModelId, voiceCapabilities, voiceDefaults, voiceHealth, voiceModelView, type VoiceSettings } from '../services/voice.js';
import { isLocalReach } from '../util/netguard.js';
import { inspectCertificate, normalizeBaseUrl } from '../util/outbound.js';

const log = logger('ai');

// `z.string().url()` accepts anything `new URL()` parses, which includes
// `file:` and `javascript:`. The only two schemes ever fetched are these.
function httpUrl(v: string): boolean { return /^https?:\/\//i.test(v); }

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
  // Both keys are stripped, not just the main one. `embedApiKey` is a
  // credential for somebody's model server exactly as `apiKey` is, and a
  // rest-spread that names only one of them is how the second quietly becomes
  // readable by every admin page load.
  const { apiKey, embedApiKey, ...safe } = s;
  res.json({
    settings: { ...safe, hasApiKey: Boolean(apiKey), hasEmbedApiKey: Boolean(embedApiKey) },
    // Whether the model this install uses is on this box or somewhere else.
    // The page says so plainly: a remote provider is a supported choice and
    // an admin's to make, but it is the one setting that decides whether
    // email text leaves the building, so it is never left to be inferred
    // from a URL.
    // Both of the next two lines reach the model host directly, outside any
    // proxy: one resolves its name, the other opens a TLS connection to it.
    // With Tor on that is precisely the disclosure the setting exists to
    // prevent, and it would happen every time an admin opened this page. So
    // neither runs — the page reports the reach as non-local, which is what
    // routing through Tor makes it.
    local: s.useTor ? false : await isLocalReach(s.baseUrl),
    // Only when the admin has turned verification off: the page shows what
    // is being trusted rather than leaving it as a checkbox with no subject.
    cert: s.tlsInsecure && !s.useTor ? await inspectCertificate(s.baseUrl).catch(() => null) : null,
    health,
    models,
    loaded,
    concurrency: await concurrencyView(s, models),
    presets: await listPresets(),
    // The hosts a connection can be pointed at — see ai/providers.ts. Named
    // apart from `presets` above, which is the sampling tuning for a model and
    // an entirely different thing that happens to share the word.
    providerPresets: PROVIDER_PRESETS,
    embedCatalogue: EMBED_CATALOGUE,
    modelInstalled,
    modelCanThink: canThink,
    recommended: recommendModel(config.totalMemBytes),
    tiers: MODEL_TIERS,
    curated: CURATED_MODELS,
    // The models for meaning search, which are a different job and a
    // different size from the ones that write. See ai/models.ts.
    embedModels: EMBED_MODELS,
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
  const b = parse(z.object({ ...TUNING_SHAPE, enabled: z.boolean().optional(), provider: z.enum(['ollama', 'openai', 'anthropic']).optional(), baseUrl: z.string().url().max(300).refine(httpUrl, 'The base URL must start with http:// or https://').optional(), apiKey: z.string().max(500).optional(), tlsInsecure: z.boolean().optional(), useTor: z.boolean().optional(), model: z.string().min(1).max(120).optional(), embedModel: z.string().min(1).max(120).optional(),
    // The two embedding-only shapes are accepted here and NOT on `provider`
    // above, which is the same rule the language model's enum applies in the
    // other direction: neither Gemini's embedding API nor Voyage serves chat,
    // and `anthropic` cannot embed. A setting that cannot work should not be
    // storable, whichever end it would fail at.
    embedProvider: z.enum(['same', 'ollama', 'openai', 'gemini', 'voyage']).optional(), embedTlsInsecure: z.boolean().optional(), embedUseTor: z.boolean().optional(), embedBaseUrl: z.string().max(300).refine((v) => v === '' || httpUrl(v), 'The embedding server URL must start with http:// or https://').optional(), embedApiKey: z.string().max(500).optional(), numCtx: z.number().int().min(512).max(131072).optional(), keepAlive: z.string().max(20).optional(),
    systemPrompt: z.string().max(8000).optional(),
    concurrency: z.boolean().optional() }), req.body);
  // Caught here rather than at the model: Ollama refuses a bare number as a
  // duration, so "-1" has to be recognised as seconds before it is stored.
  if (b.keepAlive !== undefined && !isValidKeepAlive(b.keepAlive)) {
    throw badRequest('Keep model loaded needs a duration with a unit (30s, 10m, 1h), or a number of seconds (-1 to never unload, 0 to unload at once)');
  }
  if (b.model !== undefined || b.embedModel !== undefined || b.baseUrl !== undefined || b.provider !== undefined) forgetModelCapabilities();
  const before = await getAiSettings();
  const next = await saveAiSettings(b);
  // Picking a different model drops the previous one from memory rather than
  // leaving it to time out beside its replacement. Best effort: a mail server
  // that cannot reach Ollama should still be able to save its settings.
  try { await releaseReplacedModel(before, next); } catch { /* reported by /status */ }
  // A different embedding model means the stored vectors were made in a
  // different space, so they are queued for rebuilding rather than left to
  // degrade search silently. The count goes back so the page can say how much
  // work it just asked for.
  let reindex = 0;
  if (b.embedModel !== undefined && b.embedModel !== before.embedModel) {
    reindex = await invalidateVectorsFrom(next.embedModel).catch(() => 0);
    if (reindex) log.info('embedding model changed; queued messages for re-indexing', { from: before.embedModel, to: next.embedModel, messages: reindex });
  }
  const { apiKey, embedApiKey, ...safe } = next;
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'ai.settings_updated',$2)`, [req.user!.id, JSON.stringify({
    ...b,
    // The audit row records THAT a key changed, never the key. Both of them:
    // an audit log is long-lived, widely readable, and the last place a
    // credential should end up.
    apiKey: b.apiKey ? '(set)' : undefined,
    embedApiKey: b.embedApiKey ? '(set)' : undefined,
  })]);
  res.json({ settings: { ...safe, hasApiKey: Boolean(apiKey), hasEmbedApiKey: Boolean(embedApiKey) }, reindex });
});

// Try a provider without saving it.
//
// The address, the key and the certificate all have to be right before
// anything works, and each is wrong in its own way. Saving to find out is the
// expensive way to ask: it unloads the model the install was using, so an
// admin checking a rented GPU box takes the assistant down to do it. This
// answers from the form.
aiRouter.post('/test', requireAdmin, async (req, res) => {
  const b = parse(z.object({
    provider: z.enum(['ollama', 'openai', 'anthropic']).optional(),
    baseUrl: z.string().max(300),
    apiKey: z.string().max(500).optional(),
    tlsInsecure: z.boolean().optional(),
    // Testable before it is saved, like every other field here. Without it an
    // admin turning Tor on could only find out whether it worked by saving —
    // and saving unloads the model the install was using.
    useTor: z.boolean().optional(),
    model: z.string().max(120).optional(),
  }), req.body);
  const baseUrl = normalizeBaseUrl(b.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) throw badRequest('The base URL must start with http:// or https://');
  const current = await getAiSettings();
  // A blank key means "keep the stored one", the same as the form says on
  // save — otherwise testing would report a 401 for a key that is fine.
  const candidate: AiSettings = { ...current, ...b, baseUrl, apiKey: b.apiKey || current.apiKey };
  res.json({ result: await checkProvider(candidate), local: candidate.useTor ? false : await isLocalReach(baseUrl) });
});

// ---------- The transcriber (F9) ----------
//
// Dictation's own provider settings, kept apart from the model's because
// they are a different server: the usual small install has the chat model on
// this box and no transcriber at all, and the usual larger one has whisper
// on whichever machine has the spare cores. WHISPER_URL from
// compose.voice.yml is the default, and saving here overrides it without a
// restart.
aiRouter.get('/voice', requireAdmin, async (_req, res) => {
  const v = await getVoiceSettings();
  const { apiKey, ...safe } = v;
  const health = v.baseUrl ? await voiceHealth(v) : { ok: false, error: 'No transcriber address is set' };
  res.json({
    settings: { ...safe, hasApiKey: Boolean(apiKey) },
    health,
    local: v.baseUrl ? await isLocalReach(v.baseUrl) : true,
    defaults: (({ apiKey: _k, ...d }) => d)(voiceDefaults()),
    envUrl: config.whisperUrl || null,
  });
});

const voiceBody = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().max(300).or(z.literal('')).optional(),
  // The rest of the transcriber's connection. It is configured exactly like
  // the language model's and the embedder's — shape, address, key, certificate
  // rule, Tor — because it is the same class of thing: an operator-chosen
  // server that may be anywhere.
  tlsInsecure: z.boolean().optional(),
  useTor: z.boolean().optional(),
  // Blank leaves the stored key alone; clearing one is asking for it to be
  // cleared, which is what `null` says here.
  apiKey: z.string().max(500).nullable().optional(),
  model: z.string().max(120).optional(),
  language: z.string().max(8).optional(),
});

aiRouter.put('/voice', requireAdmin, async (req, res) => {
  const b = parse(voiceBody, req.body);
  const patch: Partial<VoiceSettings> = { ...b, apiKey: undefined };
  // Blank means "leave the stored key alone", null means "clear it". A form
  // that posted the key back would have to be given it first, and a stored
  // key is never sent to a browser.
  if (b.apiKey === null) patch.apiKey = '';
  else if (b.apiKey) patch.apiKey = b.apiKey;
  else delete patch.apiKey;
  const next = await saveVoiceSettings(patch);
  const { apiKey, ...safe } = next;
  await query(`INSERT INTO audit_log (user_id, action, details) VALUES ($1,'ai.voice_updated',$2)`, [
    req.user!.id,
    JSON.stringify({ ...b, apiKey: b.apiKey ? '(set)' : b.apiKey === null ? '(cleared)' : undefined }),
  ]);
  // `isLocalReach` resolves the address, which with Tor on would announce the
  // transcriber's hostname to this machine's resolver — outside the proxy the
  // admin chose. Skipped, and reported as non-local, which is what routing
  // through Tor makes it.
  res.json({ settings: { ...safe, hasApiKey: Boolean(apiKey) }, local: next.useTor ? false : (next.baseUrl ? await isLocalReach(next.baseUrl) : true), health: await voiceHealth(next) });
});

// Try an address before saving it, so a wrong one is a message on the form
// rather than a microphone button that fails for everybody.
aiRouter.post('/voice/test', requireAdmin, async (req, res) => {
  const b = parse(voiceBody.partial(), req.body);
  const current = await getVoiceSettings();
  const trial = { ...current, ...b, apiKey: b.apiKey === null ? '' : (b.apiKey || current.apiKey) };
  if (!trial.baseUrl) throw badRequest('Give the transcriber address first');
  res.json({ health: await voiceHealth(trial), local: trial.useTor ? false : await isLocalReach(trial.baseUrl) });
});

// ---------- The transcriber's models ----------
//
// The same treatment as the writing model, and for the same reason: the model
// a transcriber has is the transcriber's business, not something Tern should
// be remembering. Asked live on every call, so a model downloaded from
// somewhere else — or removed there — shows up here within a poll.
//
// What comes back also says what this particular server can do, because that
// varies more than the transcription shape suggests: the bundled whisper.cpp
// has one model and no model API, speaches has many and a full one. The page
// draws the controls that answer justifies rather than offering buttons that
// cannot work.
aiRouter.get('/voice/models', requireAdmin, async (_req, res) => {
  const view = await voiceModelView();
  res.json({ ...view, pulls: listPulls('voice') });
});

const voiceModelBody = z.object({ id: z.string().min(1).max(200).refine(validVoiceModelId, 'That is not a model name') });

aiRouter.post('/voice/models/pull', requireAdmin, async (req, res) => {
  const { id } = parse(voiceModelBody, req.body);
  const caps = await voiceCapabilities();
  if (!caps.manages) throw badRequest('That transcriber does not download models: it serves the ones it was started with');
  startPull('voice', id, async (emit, signal) => {
    // speaches downloads in one blocking call and says nothing until it is
    // finished, so there are no byte counts to report and none are invented.
    // The job still survives the page, still confirms the result against the
    // model list, and still says how long it has been going.
    emit({ status: 'downloading' });
    await pullVoiceModel(id, signal);
  });
  await streamPull(res, 'voice', id);
});

aiRouter.get('/voice/models/pulls', requireAdmin, (_req, res) => {
  res.json({ pulls: listPulls('voice') });
});

aiRouter.post('/voice/models/pull/cancel', requireAdmin, async (req, res) => {
  const { id } = parse(voiceModelBody, req.body);
  res.json({ cancelled: cancelPull('voice', id) });
});

// The id is a Hugging Face repository path and contains slashes, so it
// travels in the query string rather than the path.
aiRouter.delete('/voice/models', requireAdmin, async (req, res) => {
  const { id } = parse(voiceModelBody, { id: String(req.query.id ?? '') });
  const installed = await relaying(() => deleteVoiceModel(id));
  // Deleting the model the install was set to use leaves the setting naming
  // something that is not there, which would fail at the microphone. It is
  // cleared, which means "whatever the server defaults to" — the same as a
  // fresh install.
  const current = await getVoiceSettings();
  let settings = current;
  if (current.model && current.model === id) settings = await saveVoiceSettings({ model: '' });
  res.json({ ok: true, deleted: id, installed, modelCleared: settings !== current });
});

// The model tables, read from the model server on every call.
//
// Separate from /status on purpose. /status carries the catalogue, the
// tuning, the presets and a database count, and is far too heavy to poll;
// this is two HTTP calls to Ollama and is polled every few seconds while the
// page is open, which is what makes the list live rather than a snapshot from
// whenever the page was opened. It matters most for a model server that is
// somebody else's — a perch on the GPU box, where models appear and vanish
// without Tern being involved at all.
aiRouter.get('/models', requireAdmin, async (req, res) => {
  // Which connection's catalogue. The embedding endpoint is very often a
  // different machine from the drafting one — that is the whole reason it is
  // separable — so "the models" is not one list, and a page that showed the
  // language model's would offer an embedding slot models the embedding server
  // has never heard of.
  const which = req.query.endpoint === 'embed' ? 'embed' : 'llm';
  const live = await liveModels(which);
  // Pulls belong to the Ollama that is being pulled INTO, and only the
  // drafting connection has a pull UI today; sending the same list under the
  // embedding catalogue would show progress bars for downloads happening
  // somewhere else.
  res.json({ ...live, endpoint: which, pulls: which === 'llm' ? listPulls('model') : [] });
});

const modelName = z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/);

/**
 * The model server's own reasons, kept.
 *
 * The catch-all in app.ts answers "Something went wrong on the server" and
 * puts the message in the log, which is right for a bug here and wrong for
 * every failure in this section. "That server has no model called X", "it is
 * still there after the delete was accepted" and perch's "model management is
 * switched off on this perch" are the whole answer, and an admin who is shown
 * the generic line instead has a button that does nothing and nowhere to look.
 */
async function relaying<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, (e as Error)?.message ?? String(e), 'model_server');
  }
}

// Downloads run as jobs, so closing the page does not cancel one.
//
// The response is still an event stream — a bar that moves is the difference
// between "working" and "stuck" — but the stream is a view of a job rather
// than the job itself. Asking twice for the same model attaches to the
// download already running; reloading the page reattaches; and the only thing
// that stops one is /models/pull/cancel.
aiRouter.post('/models/pull', requireAdmin, async (req, res) => {
  const { name } = parse(z.object({ name: modelName }), req.body);
  const s = await getAiSettings();
  if (s.provider !== 'ollama') throw badRequest('Only an Ollama model can be downloaded from here');
  startPull('model', name, async (emit, signal) => {
    for await (const line of pullModel(name, signal)) emit(line);
  });
  await streamPull(res, 'model', name);
});

// What is downloading now, for a page that has just been opened or reloaded.
aiRouter.get('/models/pulls', requireAdmin, (_req, res) => {
  res.json({ pulls: listPulls('model') });
});

aiRouter.post('/models/pull/cancel', requireAdmin, async (req, res) => {
  const { name } = parse(z.object({ name: modelName }), req.body);
  res.json({ cancelled: cancelPull('model', name) });
});

// Shared by the model and the transcriber sides: replay where the job is now,
// then follow it. Detaching does not touch the download.
async function streamPull(res: any, kind: 'model' | 'voice', name: string): Promise<void> {
  const send = sse(res);
  await new Promise<void>((resolve) => {
    let done = false;
    let detach: (() => void) | null = null;
    const stop = (view?: PullView) => {
      if (done) return;
      done = true;
      detach?.();
      if (view) send(view.state === 'done' ? 'done' : view.state === 'running' ? 'detached' : 'error', view);
      resolve();
    };
    detach = watchPull(kind, name, (view) => {
      send('progress', view);
      if (view.state !== 'running') stop(view);
    });
    if (!detach) { send('error', { state: 'error', error: 'that download is no longer running' }); resolve(); return; }
    // The client going away detaches the watcher and nothing else: the job
    // carries on, and the next page to ask picks it up where it is.
    res.on('close', () => stop());
  });
  res.end();
}

// A deletion, and then the truth about what is left.
//
// The name travels in the query string as well as the path because a model
// tag legitimately contains a slash — `huihui_ai/qwen3.5-abliterated:9b` —
// and a percent-encoded one does not survive every proxy in front of Tern.
// The body of the answer is the live list, so the page redraws from what the
// server actually has rather than from an assumption that the row it just
// asked about is gone.
async function handleDelete(req: any, res: any): Promise<void> {
  const raw = String(req.query.name ?? req.params.name ?? '');
  const { name } = parse(z.object({ name: modelName }), { name: raw });
  const models = await relaying(() => deleteModel(name));
  const loaded = await loadedModels().catch(() => []);
  res.json({ ok: true, deleted: name, models, loaded });
}

// Two routes rather than one optional segment: Express 5 refuses `:name?`
// outright — path-to-regexp v8 dropped the suffix and throws while the router
// is being built, which takes the whole server down rather than one endpoint.
aiRouter.delete('/models', requireAdmin, handleDelete);
aiRouter.delete('/models/:name', requireAdmin, handleDelete);

// Frees the memory a resident model is holding without deleting it from disk.
// Ollama loads it again on the next request, so this costs a slow first
// generation and nothing else.
aiRouter.post('/models/unload', requireAdmin, async (req, res) => {
  const { name } = parse(z.object({ name: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/) }), req.body);
  const s = await getAiSettings();
  if (s.provider !== 'ollama') throw badRequest('Only an Ollama model can be unloaded from here');
  const unloaded = await relaying(() => unloadModel(s.baseUrl, name));
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

// One conversation, summarised because somebody asked for it rather than
// because it scrolled past. The list writes a handful per request and gives
// up once a round settles nothing, which is right for filling a page in the
// background and leaves rows with no line at all; this is how a reader gets
// the line for the row in front of them.
//
// It generates unconditionally, including where the model declined before.
// A decline is remembered so the list stops asking by itself, not so that a
// person can never ask again.
aiRouter.post('/summaries/one', requireCapability('ai.summaries'), rateLimit({ name: 'ai-summary-one', perMinute: 15, message: 'Too many summary requests; wait a moment' }), async (req, res) => {
  const { key } = parse(z.object({ key: z.string().min(3).max(200) }), req.body);
  const i = key.indexOf(':');
  const accountId = Number(key.slice(0, i));
  const threadId = key.slice(i + 1);
  if (i <= 0 || !Number.isFinite(accountId) || !threadId) throw badRequest('Not a conversation');
  const s = await getAiSettings();
  if (!s.enabled) throw badRequest('The assistant is switched off');
  const acc = await getUserAccount(req.user!.id, accountId);
  if (!acc) throw notFound('No such conversation');
  // Somebody is watching this one arrive, so it takes an interactive slot.
  const made = await generateSummary(req.user!.id, acc, threadId, { interactive: true });
  // An empty line is the model declining rather than a failure, and the
  // browser is told which of the two it got.
  res.json({ key, summary: made?.text ?? '' });
});

const draftSchema = z.object({
  mode: z.enum(['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish', 'quick_replies', 'reschedule', 'nudge']),
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
  // For 'reschedule' and 'nudge'. Only the id travels: the promise itself is
  // read out of the ledger below, so a request cannot ask the model to
  // apologise for something that was never recorded.
  commitmentId: z.number().int().optional(),
  reason: z.string().max(1000).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  // Only ever used to write a date the way the reader will read it. Not a
  // fact about the person, and not stored.
  tz: z.string().max(64).optional(),
});

// Only these modes work on what is in the editor. The others (compose, reply,
// summarize) start from the task's own inputs, so a previous generation that
// was inserted into the editor never feeds the next one.
const DRAFT_MODES = new Set(['rewrite', 'polish', 'shorten', 'expand', 'subject']);

// Streams tokens as SSE. The browser inserts them into the editor as they
// arrive so a slow CPU-only model still feels responsive.
aiRouter.post('/draft', requireCapability('ai.compose'), powGuard('ai'), rateLimit({ name: 'ai-draft', perMinute: 40, message: 'The assistant is busy with your earlier requests; wait a moment' }), async (req, res) => {
  const b = parse(draftSchema, req.body);
  const s = await getAiSettings();
  if (!s.enabled) throw badRequest('AI drafting is turned off');
  const acc = b.accountId ? await getUserAccount(req.user!.id, b.accountId) : null;
  // How this mode is tuned, and how much of a conversation it may be given:
  // the same numbers the scheduler uses for responders and campaigns.
  const tuning = modeTuning(b.mode);
  const threadChars = Math.min(threadBudgetChars(s.numCtx, tuning.maxTokens ?? s.maxTokens), tuning.threadChars ?? Infinity);
  const input: DraftInput = { mode: b.mode, instruction: b.instruction, tone: b.tone, length: b.length, senderName: acc?.name ?? req.user!.display_name, senderEmail: acc?.email, draft: DRAFT_MODES.has(b.mode) && b.draft ? htmlToText(b.draft) : undefined, subject: b.subject, template: b.template, systemPrompt: s.systemPrompt, voice: acc?.voice, threadChars };
  // What the sender's diary says about the next few working days (F13), for
  // the modes that can commit them to a time. Times only — never a title —
  // and absent entirely for somebody with no calendar connected, so the
  // prompt is unchanged for an install that does not use the feature.
  if (['reply', 'compose', 'reschedule', 'nudge', 'quick_replies'].includes(b.mode)) {
    input.availability = await availabilityFor(req.user!.id, { tz: b.tz, days: 5 }).catch(() => undefined);
  }
  if (b.contactId) {
    const c = await one<any>('SELECT * FROM contacts WHERE id=$1 AND user_id=$2', [b.contactId, req.user!.id]);
    if (c) input.recipient = { name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, company: c.company, title: c.title, notes: c.notes, fields: c.fields };
  } else if (b.recipientEmail) {
    const c = await one<any>('SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=lower($2)', [req.user!.id, b.recipientEmail]);
    input.recipient = c ? { name: [c.first_name, c.last_name].filter(Boolean).join(' ') || b.recipientName, email: c.email, company: c.company, title: c.title, notes: c.notes, fields: c.fields } : { name: b.recipientName?.trim() || undefined, email: b.recipientEmail };
  }
  // The ledger entry behind a reschedule or a nudge.
  //
  // Read before the conversation below, because who this is addressed to
  // comes out of the ledger and the thread then fills in their name. Getting
  // that order wrong is how a reschedule ends up opening "Hi there" and
  // signing off with the recipient's own name.
  //
  // The dates are written out here rather than left as timestamps: the model
  // is poor at turning an ISO instant into "Thursday the 11th" and has no
  // business trying.
  if (b.mode === 'reschedule' || b.mode === 'nudge') {
    if (!b.commitmentId) throw badRequest('Which commitment this is about was not given');
    const c = await getCommitment(req.user!.id, b.commitmentId);
    if (!c) throw notFound('Commitment not found');
    if (b.mode === 'reschedule' && c.kind !== 'owed') throw badRequest('Only something you owe can be rescheduled');
    if (b.mode === 'nudge' && c.kind !== 'awaiting') throw badRequest('Only something you are waiting on can be nudged');
    input.commitment = {
      kind: c.kind,
      what: c.text,
      reason: b.reason?.trim() || undefined,
      was: c.dueAt ? writeDate(c.dueAt, b.tz) : undefined,
      now: b.dueAt ? writeDate(b.dueAt, b.tz) : undefined,
    };
    // A counterparty is whatever was recorded: sometimes an address, often
    // just a name. An address is worth a contact lookup and lets the thread
    // supply the name; a bare name is used as one.
    const party = c.counterparty?.trim();
    if (!input.recipient && party) {
      if (party.includes('@')) {
        const known = await one<any>('SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=lower($2)', [req.user!.id, party]);
        input.recipient = known
          ? { name: [known.first_name, known.last_name].filter(Boolean).join(' '), email: known.email, company: known.company, title: known.title, notes: known.notes, fields: known.fields }
          : { email: party };
      } else {
        input.recipient = { name: party };
      }
    }
  }

  if (b.threadKey) {
    const [accId, threadId] = b.threadKey.split(':');
    const tacc = await getUserAccount(req.user!.id, Number(accId));
    if (!tacc) throw notFound('Thread not found');
    const msgs = await openEmails(req.user!.id, 'ai.compose', await query<any>('SELECT from_addr, received_at, body_text, body_html, preview FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC', [tacc.id, threadId]));
    input.thread = msgs.map((m) => ({ from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(), date: new Date(m.received_at).toDateString(), text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').replace(/\n>.*$/gm, '').trim() }));
    // A reply goes to whoever wrote to us; if we only have their address, the thread usually has their name.
    if (input.recipient?.email && !input.recipient.name) {
      const hit = msgs.map((m) => m.from_addr?.[0]).find((a: any) => a?.email && a.name && String(a.email).toLowerCase() === input.recipient!.email!.toLowerCase());
      if (hit) input.recipient.name = String(hit.name);
    }
    // Who a reschedule or a nudge is addressed to, settled against the
    // conversation rather than against the ledger alone.
    //
    // Two cases, and both are real. A commitment can carry no counterparty at
    // all — plenty are written down without one — and then the thread is the
    // only thing that knows, or the email opens "Hi there" to somebody whose
    // name is three lines below it. And a counterparty can name the mailbox's
    // own owner, which happens whenever the promise was read out of something
    // you sent; addressing yourself is never right, and it is what the
    // composer would silently disagree with, because it addresses the other
    // party. The composer's answer wins, so it is the one used here.
    if (b.mode === 'reschedule' || b.mode === 'nudge') {
      const mine = String(tacc.email).toLowerCase();
      const addressingMyself = String(input.recipient?.email ?? '').toLowerCase() === mine;
      if (!input.recipient?.email || addressingMyself) {
        const them = [...msgs].reverse().map((m: any) => m.from_addr?.[0]).find((a: any) => a?.email && String(a.email).toLowerCase() !== mine)
          ?? msgs.flatMap((m: any) => m.to_addr ?? []).find((a: any) => a?.email && String(a.email).toLowerCase() !== mine);
        if (them) input.recipient = { name: them.name ? String(them.name) : undefined, email: String(them.email) };
        else if (addressingMyself) input.recipient = undefined;
      }
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
      // Writing help, which is what the composer's buttons are. The gate has
      // already run in the middleware above; passing it again is what makes
      // chatStream refuse a request that slipped past a route.
      consent: { userId: req.user!.id, capability: 'ai.compose' },
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
    send('done', { text: finalizeOutput(full, b.mode, { recipient: input.recipient, senderName: input.senderName, senderEmail: input.senderEmail, commitment: input.commitment }) });
  } catch (e) {
    send('error', { error: (e as Error).message });
  }
  res.end();
});
