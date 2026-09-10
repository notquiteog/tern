import type { ViewContext } from '../state/assistant';

export function assistantContextLabel(view: ViewContext): string {
  if (view.draft) return view.draft.subject ? `Draft: ${view.draft.subject}` : 'Your open draft';
  if (view.thread) return 'Your open conversation';
  if (view.focus) return view.focus.label;
  return view.page ? `${view.page} page` : 'Your workspace';
}

/** Only suggest actions the server actually offers to this person. */
export function assistantSuggestions(view: ViewContext, tools: string[]): { label: string; prompt: string }[] {
  const available = new Set(tools);
  const suggestions: { label: string; prompt: string }[] = [];
  const add = (needs: string[], label: string, prompt: string) => {
    if (needs.every((t) => available.has(t))) suggestions.push({ label, prompt });
  };
  if (view.draft) {
    add(['draft_email'], 'Make it shorter', 'Make this draft shorter, keeping the facts and recipients. Put the revised email in a draft card.');
    add([], 'Check before sending', 'Check this draft for unclear wording, unanswered questions, and missing details. Suggest specific changes without inventing facts.');
  } else if (view.thread) {
    add(['read_thread'], 'Summarise this', 'Read this conversation and summarise the decisions and any unanswered questions.');
    add(['read_thread', 'draft_email'], 'Draft a reply', 'Read this conversation and draft a reply to the latest message. Flag any facts you still need from me.');
    add(['read_thread', 'record_commitment'], 'Track a commitment', 'Read this conversation and propose any outstanding commitments that are not already tracked.');
  } else if (view.focus?.kind === 'contact') {
    add(['find_contacts', 'search_mail_exact'], 'Catch me up', 'Look up this contact and search our recent mail. Summarise where things stand, citing the conversations you read.');
    add(['my_commitments'], 'What is outstanding?', 'Check my commitments and show what I owe this contact and what I am waiting on from them.');
  } else if (view.focus?.kind === 'day') {
    add(['my_day'], 'Plan this day', 'Check my calendar for the date on screen. Summarise the day and flag any overlapping meetings.');
  }
  if (view.page === 'Commitments') {
    add(['my_commitments'], 'Help me prioritise', 'Review my open commitments. Suggest what to tackle first based on due dates, separating what I owe from what I am waiting on.');
  }
  if (!suggestions.length) {
    add(['my_commitments'], 'What needs my attention?', 'Check my open commitments and tell me what needs my attention first.');
    add(['my_day'], 'Plan today', 'Check my calendar for today and summarise the day.');
    add(['search_mail_exact'], 'Find unread mail', 'Find my unread mail from the last seven days and show the results with references.');
  }
  return suggestions.slice(0, 3);
}
