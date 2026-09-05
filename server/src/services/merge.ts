// Merge-field rendering for templates and sequences.
//   {{first_name}}            -> value or empty string
//   {{first_name|there}}      -> value or "there"
//   {{company | your team}}   -> whitespace around the pipe is fine
// HTML bodies get escaped values so a contact named "<script>" stays text.
export type MergeContext = Record<string, string | number | null | undefined>;

const FIELD_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderText(template: string, ctx: MergeContext): string {
  return template.replace(FIELD_RE, (_m, key: string, fallback?: string) => {
    const v = ctx[key];
    if (v === null || v === undefined || String(v).trim() === '') return fallback ?? '';
    return String(v);
  });
}

export function renderHtml(template: string, ctx: MergeContext): string {
  return template.replace(FIELD_RE, (_m, key: string, fallback?: string) => {
    const v = ctx[key];
    if (v === null || v === undefined || String(v).trim() === '') return escapeHtml(fallback ?? '');
    // Allow a few "trusted" keys that are themselves HTML we generated.
    if (key === 'signature' || key === 'unsubscribe_link') return String(v);
    return escapeHtml(String(v));
  });
}

export function listFields(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(FIELD_RE)) out.add(m[1]);
  return [...out];
}

export interface ContactLike {
  email: string; first_name?: string; last_name?: string; company?: string; title?: string; phone?: string; website?: string;
  fields?: Record<string, unknown>;
}

export function contactContext(c: ContactLike, extra: MergeContext = {}): MergeContext {
  const first = c.first_name ?? '';
  const last = c.last_name ?? '';
  const ctx: MergeContext = {
    email: c.email,
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' '),
    name: [first, last].filter(Boolean).join(' ') || first,
    company: c.company ?? '',
    title: c.title ?? '',
    phone: c.phone ?? '',
    website: c.website ?? '',
    domain: c.email.split('@')[1] ?? '',
    today: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
    weekday: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
  };
  for (const [k, v] of Object.entries(c.fields ?? {})) {
    if (v === null || v === undefined) continue;
    ctx[k] = typeof v === 'object' ? JSON.stringify(v) : (v as any);
  }
  return { ...ctx, ...extra };
}

// Plain-text alternative for an HTML body: good enough for the text/plain
// part that spam filters like to see, not a full HTML renderer.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<\/(div|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
