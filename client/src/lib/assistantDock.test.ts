import './testdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../state/auth';
import { FeaturesProvider } from '../state/features';
import { AssistantProvider, useAssistant } from '../state/assistant';
import { AssistantDock } from '../components/Assistant';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('the dock serialises handoffs and ignores late events after starting a new conversation', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { body: any; stream: ReadableStreamDefaultController<Uint8Array>; closed: boolean }[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/setup/status') return json({ needsSetup: false, version: 'test' });
    if (url === '/api/auth/me') return json({ user: { id: 1, prefs: {} }, accountCount: 1 });
    if (url === '/api/features') return json({ capabilities: [{ id: 'ai.assistant', available: true, granted: true }] });
    if (url.startsWith('/api/features/work')) return json({ challenge: 'test', difficulty: 0 });
    if (url === '/api/ai/thinking') return json({ allowed: false });
    if (url === '/api/assistant/status') return json({ enabled: true, consented: true, model: 'test', tools: [], voice: { listen: false, speak: false, maxChars: 1000 } });
    if (url === '/api/assistant/conversations') return json({ conversations: [] });
    if (url === '/api/assistant/chat') {
      const body = JSON.parse(String(init?.body));
      return new Response(new ReadableStream<Uint8Array>({ start(stream) { requests.push({ body, stream, closed: false }); } }));
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  const emit = (i: number, event: string, data: unknown) => requests[i].stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const finish = (i: number) => { requests[i].stream.close(); requests[i].closed = true; };
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 80; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      if (check()) return;
    }
    assert.fail('Timed out waiting for the dock');
  };
  let assistant!: ReturnType<typeof useAssistant>;
  function Probe() { assistant = useAssistant(); return null; }
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  try {
    await act(async () => root.render(h(QueryClientProvider, { client }, h(MemoryRouter, null,
      h(AuthProvider, null, h(FeaturesProvider, null, h(AssistantProvider, null, h(Probe), h(AssistantDock))))))));
    // This first handoff precedes both the capability and model status checks.
    await act(async () => assistant.show('First', { focus: { kind: 'contact', label: 'Dana' } }));
    await waitFor(() => requests.length === 1);
    await act(async () => {
      emit(0, 'start', { conversationId: 7, userMessageId: 1 });
      assistant.show('Second', { focus: { kind: 'day', label: 'Friday', ref: '2026-09-11' } });
    });
    assert.equal(requests.length, 1);
    assert.match(el.textContent ?? '', /1 question waiting/);
    await act(async () => { emit(0, 'saved', { id: 2, role: 'assistant', content: 'First answer' }); finish(0); });
    await waitFor(() => requests.length === 2);
    assert.equal(requests[1].body.conversationId, 7);
    assert.equal(requests[1].body.view.focus.ref, '2026-09-11');
    assert.equal(requests[0].body.view.focus.label, 'Dana');

    await act(async () => (el.querySelector('[aria-label="New conversation"]') as HTMLButtonElement).click());
    await act(async () => assistant.show('Fresh question'));
    await waitFor(() => requests.length === 3);
    assert.equal(requests[2].body.conversationId, null);
    // Simulate a transport that delivers old events after abort was requested.
    await act(async () => {
      emit(1, 'start', { conversationId: 99, userMessageId: 90 });
      emit(1, 'saved', { id: 91, role: 'assistant', content: 'Stale answer' });
      finish(1);
    });
    assert.doesNotMatch(el.textContent ?? '', /Stale answer|First answer/);
    assert.ok(el.querySelector('[aria-label="Stop"]'), 'the old finally must not stop the new turn');
    await act(async () => {
      emit(2, 'start', { conversationId: 8, userMessageId: 3 });
      emit(2, 'saved', { id: 4, role: 'assistant', content: 'Fresh answer' });
      finish(2);
    });
    await waitFor(() => !el.querySelector('[aria-label="Stop"]'));
    assert.match(el.textContent ?? '', /Fresh answer/);
  } finally {
    await act(async () => { for (let i = 0; i < requests.length; i++) if (!requests[i].closed) finish(i); root.unmount(); });
    client.clear();
    el.remove();
    globalThis.fetch = originalFetch;
  }
});
