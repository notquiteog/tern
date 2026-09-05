import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { parse, z } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { chatStream, deleteModel, getAiSettings, listModels, loadedModels, ollamaHealth, pullModel, saveAiSettings, aiDefaults } from '../ai/llm.js';
import { buildMessages, finalizeOutput, DEFAULT_SYSTEM_PROMPT, type DraftInput } from '../ai/prompts.js';
import { CURATED_MODELS, MODEL_TIERS, recommendModel } from '../ai/models.js';
import { config } from '../config.js';
import { getUserAccount } from '../services/accounts.js';
import { htmlToText } from '../services/merge.js';

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
  const { apiKey, ...safe } = s;
  res.json({
    settings: { ...safe, hasApiKey: Boolean(apiKey) },
    health,
    models,
    loaded,
    modelInstalled,
    recommended: recommendModel(config.totalMemBytes),
    tiers: MODEL_TIERS,
    curated: CURATED_MODELS,
    totalMemGiB: Math.round((config.totalMemBytes / 1024 ** 3) * 10) / 10,
    defaults: (({ apiKey: _k, ...d }) => d)(aiDefaults()),
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
});

aiRouter.put('/settings', requireAdmin, async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean().optional(), provider: z.enum(['ollama', 'openai']).optional(), baseUrl: z.string().url().optional(), apiKey: z.string().max(500).optional(), model: z.string().min(1).max(120).optional(), temperature: z.number().min(0).max(2).optional(), numCtx: z.number().int().min(512).max(32768).optional(), keepAlive: z.string().max(20).optional(),
    systemPrompt: z.string().max(8000).optional(), topP: z.number().min(0).max(1).optional(), topK: z.number().int().min(1).max(200).optional(), repeatPenalty: z.number().min(0.5).max(2).optional(), maxTokens: z.number().int().min(64).max(4096).optional() }), req.body);
  const next = await saveAiSettings(b);
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

const draftSchema = z.object({
  mode: z.enum(['compose', 'reply', 'rewrite', 'shorten', 'expand', 'summarize', 'subject', 'personalize', 'polish']),
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

// Streams tokens as SSE. The browser inserts them into the editor as they
// arrive so a slow CPU-only model still feels responsive.
aiRouter.post('/draft', async (req, res) => {
  const b = parse(draftSchema, req.body);
  const s = await getAiSettings();
  if (!s.enabled) throw badRequest('AI drafting is turned off');
  const acc = b.accountId ? await getUserAccount(req.user!.id, b.accountId) : null;
  const input: DraftInput = { mode: b.mode, instruction: b.instruction, tone: b.tone, length: b.length, senderName: acc?.name ?? req.user!.display_name, senderEmail: acc?.email, draft: b.draft ? htmlToText(b.draft) : undefined, subject: b.subject, template: b.template, systemPrompt: s.systemPrompt, voice: acc?.voice };
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
    const msgs = await query<any>('SELECT from_addr, received_at, body_text, body_html, preview FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC', [tacc.id, threadId]);
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
    for await (const piece of chatStream({ messages: buildMessages(input), signal: abort.signal, maxTokens: b.mode === 'subject' ? 40 : b.mode === 'summarize' ? 300 : 700, temperature: b.mode === 'subject' || b.mode === 'polish' ? 0.3 : undefined })) {
      full += piece;
      send('token', { t: piece });
    }
    send('done', { text: finalizeOutput(full, b.mode, { recipient: input.recipient, senderName: input.senderName, senderEmail: input.senderEmail }) });
  } catch (e) {
    send('error', { error: (e as Error).message });
  }
  res.end();
});
