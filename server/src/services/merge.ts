// Template rendering for templates, sequence steps and campaigns.
//
//   {{first_name}}                 value, or empty
//   {{first_name|there}}           value, or the fallback
//   {{company:possessive}}         value passed through a filter (chainable: {{name:trim:upper}})
//   {{#if company}} … {{/if}}      block kept only when the field is non-empty
//   {{#unless phone}} … {{/unless}}
//   {Hi|Hello|Hey} {{first_name}}  variation: one option chosen per render
//
// HTML bodies get escaped values so a contact named "<script>" stays text.
// Filters and conditionals are deliberately small: a template is something a
// person reads, not a programming language.
export type MergeContext = Record<string, string | number | null | undefined>;

const FIELD_RE = /\{\{\s*(?!#|\/)([a-zA-Z0-9_.-]+)((?::[a-z_]+)*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;
const BLOCK_RE = /\{\{\s*#(if|unless)\s+([a-zA-Z0-9_.-]+)\s*\}\}((?:(?!\{\{\s*#(?:if|unless)\b)[\s\S])*?)\{\{\s*\/\1\s*\}\}/g;
const SPIN_RE = /\{([^{}|]*(?:\|[^{}|]*)+)\}/g;
const TRUSTED_KEYS = new Set(['signature', 'unsubscribe_link']);

export const FILTERS: Record<string, (v: string) => string> = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  capitalize: (v) => (v ? v[0].toUpperCase() + v.slice(1) : v),
  title: (v) => v.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
  trim: (v) => v.trim(),
  first: (v) => v.trim().split(/\s+/)[0] ?? '',
  last: (v) => { const p = v.trim().split(/\s+/); return p.length > 1 ? p[p.length - 1] : ''; },
  possessive: (v) => (v ? (v.endsWith('s') ? `${v}'` : `${v}'s`) : v),
  initials: (v) => v.trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join(''),
  domain: (v) => v.includes('@') ? v.split('@')[1] : v.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
};

// Values land in text nodes and double-quoted attributes, so an apostrophe
// can stay readable; escaping it to &#39; only makes stored HTML ugly.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  return String(v).trim() !== '';
}

// Deterministic when a seed is given (previews stay stable); random per send otherwise.
function rng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  // Scramble first: a plain LCG's first outputs move only slightly between
  // nearby seeds, so consecutive enrollments would all pick the same option.
  let s = (seed >>> 0) || 1;
  s ^= s >>> 16; s = Math.imul(s, 0x45d9f3b) >>> 0; s ^= s >>> 16; s = Math.imul(s, 0x45d9f3b) >>> 0; s ^= s >>> 16;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; s ^= s >>> 13; s = Math.imul(s, 0x5bd1e995) >>> 0; s ^= s >>> 15; return (s >>> 0) / 4294967296; };
}

export interface RenderOptions { html?: boolean; seed?: number }

export function render(template: string, ctx: MergeContext, opts: RenderOptions = {}): string {
  let out = template ?? '';
  // Conditionals, innermost first (the block regex refuses to span a nested opener).
  for (let i = 0; i < 20; i++) {
    const before = out;
    out = out.replace(BLOCK_RE, (_m, kind: string, key: string, body: string) => {
      const keep = kind === 'if' ? truthy(ctx[key]) : !truthy(ctx[key]);
      return keep ? body : '';
    });
    if (out === before) break;
  }
  out = out.replace(FIELD_RE, (_m, key: string, filters: string, fallback?: string) => {
    let v = ctx[key];
    let s = v === null || v === undefined ? '' : String(v);
    if (s.trim() === '') s = fallback ?? '';
    for (const f of filters.split(':').filter(Boolean)) { const fn = FILTERS[f]; if (fn) s = fn(s); }
    if (opts.html && !TRUSTED_KEYS.has(key)) s = escapeHtml(s);
    return s;
  });
  const rand = rng(opts.seed);
  out = out.replace(SPIN_RE, (_m, inner: string) => {
    const options = inner.split('|');
    return options[Math.floor(rand() * options.length)] ?? '';
  });
  return out;
}

export function renderText(template: string, ctx: MergeContext, seed?: number): string {
  return render(template, ctx, { html: false, seed });
}
export function renderHtml(template: string, ctx: MergeContext, seed?: number): string {
  return render(template, ctx, { html: true, seed });
}

export function listFields(template: string): string[] {
  const out = new Set<string>();
  for (const m of (template ?? '').matchAll(FIELD_RE)) out.add(m[1]);
  for (const m of (template ?? '').matchAll(/\{\{\s*#(?:if|unless)\s+([a-zA-Z0-9_.-]+)/g)) out.add(m[1]);
  return [...out];
}

// Problems a person would want to know about before a template goes into a
// sequence: unclosed blocks, unknown filters, odd braces.
export function validateTemplate(template: string): string[] {
  const errors: string[] = [];
  const t = template ?? '';
  const opens = [...t.matchAll(/\{\{\s*#(if|unless)\s+([a-zA-Z0-9_.-]+)\s*\}\}/g)];
  const closes = [...t.matchAll(/\{\{\s*\/(if|unless)\s*\}\}/g)];
  const openIf = opens.filter((m) => m[1] === 'if').length, closeIf = closes.filter((m) => m[1] === 'if').length;
  const openUnless = opens.filter((m) => m[1] === 'unless').length, closeUnless = closes.filter((m) => m[1] === 'unless').length;
  if (openIf !== closeIf) errors.push(`${openIf} {{#if}} but ${closeIf} {{/if}}`);
  if (openUnless !== closeUnless) errors.push(`${openUnless} {{#unless}} but ${closeUnless} {{/unless}}`);
  for (const m of t.matchAll(FIELD_RE)) {
    for (const f of m[2].split(':').filter(Boolean)) if (!FILTERS[f]) errors.push(`Unknown filter ":${f}" on {{${m[1]}}}`);
  }
  const stray = t.replace(BLOCK_RE, '').replace(FIELD_RE, '').replace(SPIN_RE, '').match(/\{\{[^}]*\}?|\{\{/g);
  if (stray?.length) errors.push(`Unrecognised placeholder: ${stray[0].slice(0, 40)}`);
  return [...new Set(errors)];
}

export interface ContactLike {
  email: string; first_name?: string; last_name?: string; company?: string; title?: string; phone?: string; website?: string; timezone?: string | null;
  fields?: Record<string, unknown>;
}

function greetingFor(tz: string | null | undefined): string {
  let hour = new Date().getHours();
  if (tz) {
    try { hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())) % 24; } catch { /* keep local */ }
  }
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function contactContext(c: ContactLike, extra: MergeContext = {}): MergeContext {
  const first = c.first_name ?? '';
  const last = c.last_name ?? '';
  const now = new Date();
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
    today: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    month: now.toLocaleDateString('en-US', { month: 'long' }),
    year: String(now.getFullYear()),
    greeting: greetingFor(c.timezone ?? (extra.sender_tz as string | undefined)),
  };
  for (const [k, v] of Object.entries(c.fields ?? {})) {
    if (v === null || v === undefined) continue;
    ctx[k] = typeof v === 'object' ? JSON.stringify(v) : (v as any);
  }
  return { ...ctx, ...extra };
}

export const BUILTIN_FIELDS: { key: string; label: string }[] = [
  { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' }, { key: 'full_name', label: 'Full name' }, { key: 'email', label: 'Email' },
  { key: 'company', label: 'Company' }, { key: 'title', label: 'Job title' }, { key: 'phone', label: 'Phone' }, { key: 'website', label: 'Website' }, { key: 'domain', label: 'Email domain' },
  { key: 'sender_name', label: 'Your name' }, { key: 'sender_first_name', label: 'Your first name' }, { key: 'sender_email', label: 'Your address' },
  { key: 'greeting', label: 'Good morning/afternoon/evening' }, { key: 'today', label: 'Today (Month day)' }, { key: 'weekday', label: 'Weekday' }, { key: 'month', label: 'Month' }, { key: 'year', label: 'Year' },
  { key: 'unsubscribe_url', label: 'Unsubscribe link' },
];

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
