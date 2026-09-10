import './testdom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantProvider, useAssistant, useDraftContext, useFocusContext, type ViewContext } from '../state/assistant';
import { assistantContextLabel, assistantSuggestions } from './assistant';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('handoffs while open are queued with independent snapshots of their originating screen', async () => {
  let assistant!: ReturnType<typeof useAssistant>;
  function Probe() { assistant = useAssistant(); return null; }
  const el = document.createElement('div');
  const root = createRoot(el);
  try {
    await act(async () => { root.render(createElement(AssistantProvider, null, createElement(Probe))); });
    const context: ViewContext = { focus: { kind: 'contact', label: 'Dana', ref: 'dana@example.org' } };
    let unregister!: () => void;
    await act(async () => { unregister = assistant.registerFocus(context.focus!); assistant.show('Catch me up'); });
    assert.equal(assistant.open, true);
    await act(async () => { unregister(); assistant.show('Plan today', { focus: { kind: 'day', label: 'Friday', ref: '2026-09-11' } }); });
    context.focus!.label = 'Changed after asking';
    assert.equal(assistant.pendingCount, 2);
    let first!: ReturnType<typeof assistant.takePending>;
    let second!: ReturnType<typeof assistant.takePending>;
    await act(async () => { first = assistant.takePending(); second = assistant.takePending(); });
    assert.equal(first?.view.focus?.label, 'Dana');
    assert.equal(second?.view.focus?.ref, '2026-09-11');
    assert.equal(assistant.pendingCount, 0);
    await act(async () => { assistant.show('Later'); assistant.clearPending(); });
    assert.equal(assistant.pendingCount, 0);
  } finally { await act(async () => root.unmount()); }
});

test('closing a foreground draft restores the mounted draft beneath it and reads current text', async () => {
  let assistant!: ReturnType<typeof useAssistant>;
  let body = 'Before';
  function Probe() { assistant = useAssistant(); return null; }
  function Draft({ popup }: { popup: boolean }) {
    useDraftContext(() => ({ body: popup ? 'Popup' : body }));
    return null;
  }
  function Contact() { useFocusContext({ kind: 'contact', label: 'Dana' }); return null; }
  const root = createRoot(document.createElement('div'));
  const render = (popup: boolean) => createElement(AssistantProvider, null,
    createElement(Probe), createElement(Contact), createElement(Draft, { key: 'inline', popup: false }),
    popup ? createElement(Draft, { key: 'popup', popup: true }) : null);
  try {
    await act(async () => root.render(render(false)));
    body = 'Just typed';
    assert.equal(assistant.view().draft?.body, 'Just typed');
    await act(async () => root.render(render(true)));
    assert.equal(assistant.view().draft?.body, 'Popup');
    await act(async () => root.render(render(false)));
    assert.equal(assistant.view().draft?.body, 'Just typed');
    assert.equal(assistant.view().focus?.label, 'Dana');
    let older!: () => void;
    let newer!: () => void;
    await act(async () => {
      older = assistant.registerThread({ accountId: 1, threadId: 'old' });
      newer = assistant.registerThread({ accountId: 2, threadId: 'new' });
    });
    await act(async () => older());
    assert.equal(assistant.view().thread?.threadId, 'new');
    await act(async () => newer());
    assert.equal(assistant.view().thread, null);
  } finally { await act(async () => root.unmount()); }
});

test('suggestions follow foreground context and available tools', () => {
  const tools = ['read_thread', 'draft_email', 'my_day', 'find_contacts', 'search_mail_exact', 'my_commitments'];
  const context: ViewContext = { thread: { accountId: 1, threadId: 't' }, draft: { subject: 'Proposal' }, focus: { kind: 'contact', label: 'Dana' } };
  assert.equal(assistantContextLabel(context), 'Draft: Proposal');
  assert.deepEqual(assistantSuggestions(context, tools).map((s) => s.label), ['Make it shorter', 'Check before sending']);
  assert.deepEqual(assistantSuggestions({ thread: context.thread }, []).map((s) => s.label), []);
  assert.deepEqual(assistantSuggestions({ focus: { kind: 'day', label: 'Friday' } }, tools).map((s) => s.label), ['Plan this day']);
  assert.ok(!assistantSuggestions({ thread: context.thread }, tools).some((s) => s.label === 'Track a commitment'));
  assert.equal(assistantSuggestions({ page: 'Commitments' }, tools)[0].label, 'Help me prioritise');
});
