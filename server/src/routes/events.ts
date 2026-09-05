import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { bus, type AppEvent } from '../events.js';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

// Per-user server-sent events. Browsers use this to refresh the thread list
// when a sync lands, so there is no client-side polling.
eventsRouter.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`event: hello\ndata: {}\n\n`);
  const uid = req.user!.id;
  const handler = (ev: AppEvent) => {
    if ('userId' in ev && ev.userId !== uid && ev.userId !== 0) return;
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  bus.on('event', handler);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => { bus.off('event', handler); clearInterval(ping); });
});
