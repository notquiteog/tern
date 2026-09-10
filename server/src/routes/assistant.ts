// The assistant: conversations, one streaming turn, and a voice.
//
// Everything expensive here carries a proof of work as well as its capability,
// for the reason `services/workGuard.ts` gives: the model is a shared resource
// with a fixed number of slots, and a throttle that scales with contention is
// the only one that does not punish somebody working quickly exactly as hard
// as a script. Reading a stored conversation carries neither — it is an
// ordinary read of the person's own rows.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { parse, z, idParam } from '../util/validate.js';
import { badRequest, notFound } from '../errors.js';
import { rateLimit } from '../util/rateLimit.js';
import { requireCapability, allowed } from '../services/capabilities.js';
import { powGuard } from '../services/workGuard.js';
import { logger } from '../log.js';
import { getAiSettings } from '../ai/llm.js';
import { runAgent, type ViewContext } from '../ai/agent.js';
import { toolsFor } from '../ai/tools.js';
import {
  appendMessage, conversationExists, createConversation, deleteAllConversations,
  deleteConversation, listConversations, readConversation,
} from '../ai/conversation.js';
import { MAX_SPEECH_CHARS, speak, speechConfigured, voiceConfigured } from '../services/voice.js';

const log = logger('assistant');

export const assistantRouter = Router();
assistantRouter.use(requireAuth);

function sse(res: any) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
}

// What the browser needs to decide whether to show the assistant at all, and
// which of its abilities to mention. A control with nothing behind it is a
// promise the install has not made, so the client hides rather than disables.
assistantRouter.get('/status', async (req, res) => {
  const s = await getAiSettings();
  const can = await allowed(req.user!.id, 'ai.assistant');
  const tools = can ? await toolsFor(req.user!.id) : [];
  res.json({
    enabled: s.enabled,
    consented: can,
    model: s.model,
    // Named rather than counted: the panel lists what it can do for you, and
    // "6 tools" is not a sentence anybody can act on.
    tools: tools.map((t) => ({ name: t.spec.name, offBox: Boolean(t.offBox) })),
    voice: { listen: await voiceConfigured(), speak: await speechConfigured(), maxChars: MAX_SPEECH_CHARS },
  });
});

// ---------- Conversations ----------

assistantRouter.get('/conversations', requireCapability('ai.assistant'), async (req, res) => {
  res.json({ conversations: await listConversations(req.user!.id) });
});

assistantRouter.get('/conversations/:id', requireCapability('ai.assistant'), async (req, res) => {
  const id = idParam(req.params.id);
  if (!(await conversationExists(req.user!.id, id))) throw notFound('Conversation not found');
  res.json({ messages: await readConversation(req.user!.id, id) });
});

assistantRouter.delete('/conversations/:id', requireCapability('ai.assistant'), async (req, res) => {
  if (!(await deleteConversation(req.user!.id, idParam(req.params.id)))) throw notFound('Conversation not found');
  res.json({ ok: true });
});

// Everything, in one act. The same thing withdrawing consent does, offered
// separately so somebody can clear the history without turning the feature
// off — those are different intentions and only one of them should cost you
// the feature.
assistantRouter.delete('/conversations', requireCapability('ai.assistant'), async (req, res) => {
  res.json({ deleted: await deleteAllConversations(req.user!.id) });
});

// ---------- One turn ----------

const viewSchema = z.object({
  thread: z.object({ accountId: z.number().int(), threadId: z.string().max(200) }).nullish(),
  draft: z.object({
    to: z.array(z.string().max(320)).max(50).optional(),
    subject: z.string().max(500).optional(),
    body: z.string().max(50_000).optional(),
  }).nullish(),
  page: z.string().max(40).nullish(),
  focus: z.object({
    kind: z.enum(['contact', 'sequence', 'day']),
    label: z.string().max(200),
    ref: z.string().max(320).nullish(),
    detail: z.string().max(500).nullish(),
  }).nullish(),
}).optional();

assistantRouter.post(
  '/chat',
  requireCapability('ai.assistant'),
  powGuard('ai'),
  rateLimit({ name: 'assistant-chat', perMinute: 20, message: 'The assistant is still working through your earlier messages; wait a moment' }),
  async (req, res) => {
    const b = parse(z.object({
      conversationId: z.number().int().positive().nullish(),
      message: z.string().min(1).max(8000),
      view: viewSchema,
      tz: z.string().max(64).optional(),
    }), req.body);

    // The conversation is resolved BEFORE the stream opens, so a bad id is an
    // ordinary 404 with a status line rather than an error event inside a
    // 200 that the browser has to unpick.
    let conversationId = b.conversationId ?? null;
    if (conversationId !== null && !(await conversationExists(req.user!.id, conversationId))) {
      throw notFound('Conversation not found');
    }
    if (conversationId === null) conversationId = await createConversation(req.user!.id, b.message);

    const view: ViewContext = {
      thread: b.view?.thread ?? null,
      draft: b.view?.draft ?? null,
      page: b.view?.page ?? null,
      focus: b.view?.focus ?? null,
    };

    // Saved before a token is generated. A turn that fails halfway still shows
    // the person what they asked, which is the difference between a
    // conversation with a gap in it and one that has silently lost a message.
    const userMessageId = await appendMessage(req.user!.id, conversationId, { role: 'user', content: b.message });

    const send = sse(res);
    send('start', { conversationId, userMessageId });

    // A browser that goes away takes the generation with it: the model is a
    // shared resource and finishing an answer nobody will read is a slot
    // somebody else is queuing for.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    try {
      for await (const ev of runAgent({
        userId: req.user!.id,
        conversationId,
        view,
        tz: b.tz,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        send(ev.type, ev);
      }
      if (!abort.signal.aborted) send('done', { conversationId });
    } catch (e) {
      const message = (e as Error)?.message ?? 'the assistant stopped unexpectedly';
      if (!abort.signal.aborted) {
        log.warn('a turn failed', { user: req.user!.id, conversation: conversationId, err: message });
        send('error', { error: message });
      }
    } finally {
      res.end();
    }
  },
);

// ---------- Speaking ----------
//
// The second half of turn-taking. The first half is the existing dictation
// route (`POST /api/assist/voice`), which is reused rather than duplicated:
// a recording is a recording whether it is going into a text box or into a
// conversation, and it is already careful in ways worth not rewriting.

assistantRouter.post(
  '/speak',
  requireCapability('voice'),
  powGuard('voice'),
  rateLimit({ name: 'assistant-speak', perMinute: 30, message: 'Too much to say at once; wait a moment' }),
  async (req, res) => {
    const { text } = parse(z.object({ text: z.string().min(1).max(MAX_SPEECH_CHARS) }), req.body);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const spoken = await speak(req.user!.id, text, { signal: abort.signal });
    res.setHeader('Content-Type', spoken.contentType);
    res.setHeader('Content-Length', String(spoken.audio.length));
    // Never cached, by anything, anywhere. The clip is a reading of somebody's
    // mail; a proxy holding a copy is a copy nothing here can reach to delete.
    res.setHeader('Cache-Control', 'no-store');
    res.end(spoken.audio);
  },
);
