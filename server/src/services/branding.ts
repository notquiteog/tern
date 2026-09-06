// The web app's own name and logo, set by admins under Admin → Branding.
// Shown in the top bar, on the sign-in pages and as the tab title; nothing
// here is secret, so the public setup/status endpoint carries it. The logo
// gets the same treatment as attachments and mail logos: SVGs are cleaned
// of scripts and metadata, rasters have their metadata stripped.
import { one, query } from '../db.js';
import { sanitizeSvg } from './brand.js';
import { toTinyPs } from './svgTiny.js';
import { scrubMedia } from './scrub.js';

export const DEFAULT_APP_NAME = 'Tern';
export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export const ICON_NAMES = ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'] as const;
export const ICON_MAX_BYTES = 512 * 1024;
export const DEFAULT_ICON_BG = '#4f6df5';

export interface Branding { name: string; logo: { type: LogoType; data: string; bytes: number } | null; logoVersion: number; iconBg: string; icons: Record<string, string> | null }
export interface PublicBranding { name: string; logo: string | null; version: number }

export async function getBranding(): Promise<Branding> {
  const row = await one<{ value: Partial<Branding> }>(`SELECT value FROM settings WHERE key='branding'`);
  const v = row?.value ?? {};
  return { name: String(v.name || DEFAULT_APP_NAME), logo: v.logo ?? null, logoVersion: Number(v.logoVersion ?? 0), iconBg: String(v.iconBg || DEFAULT_ICON_BG), icons: v.icons ?? null };
}

export function publicBranding(b: Branding): PublicBranding {
  return { name: b.name, logo: b.logo ? `/logo?v=${b.logoVersion}` : null, version: b.logoVersion };
}

async function save(b: Branding): Promise<void> {
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ('branding', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(b)]);
}

export async function setAppName(name: string): Promise<Branding> {
  const b = await getBranding();
  b.name = name.trim() || DEFAULT_APP_NAME;
  await save(b);
  return b;
}

export interface PreparedLogo { type: LogoType; data: Buffer; bytes: number; originalBytes: number; note: string | null }

// Pure: validate and clean an uploaded logo. Exported for tests.
export function prepareLogo(input: Buffer, contentType: string, title: string): PreparedLogo {
  const type = contentType.toLowerCase().split(';')[0].trim() as LogoType;
  if (!(LOGO_TYPES as readonly string[]).includes(type)) throw new Error('Choose an SVG, PNG, JPEG or WebP image');
  if (input.length === 0) throw new Error('The file is empty');
  if (input.length > LOGO_MAX_BYTES) throw new Error('The file is larger than 1 MB');
  if (type === 'image/svg+xml') {
    const safe = sanitizeSvg(input.toString('utf8'));
    if (!safe.ok) throw new Error(safe.error);
    const tiny = toTinyPs(safe.svg, { title: title || DEFAULT_APP_NAME });
    if (!tiny.ok) throw new Error(tiny.error);
    const removed = Object.values(tiny.report.removedElements).reduce((a, b) => a + b, 0);
    const note = removed || tiny.report.removedAttributes ? `stripped ${removed} element${removed === 1 ? '' : 's'} and ${tiny.report.removedAttributes} attribute${tiny.report.removedAttributes === 1 ? '' : 's'} of metadata` : null;
    const data = Buffer.from(tiny.svg, 'utf8');
    return { type, data, bytes: data.length, originalBytes: input.length, note };
  }
  const scrubbed = scrubMedia(input, type);
  if (!scrubbed.handled) throw new Error('The file does not look like a valid image');
  return { type, data: scrubbed.data, bytes: scrubbed.data.length, originalBytes: input.length, note: scrubbed.removed.length ? `removed ${scrubbed.removed.join(', ')}` : null };
}

export async function setLogo(input: Buffer, contentType: string): Promise<{ branding: Branding; prepared: PreparedLogo }> {
  const b = await getBranding();
  const prepared = prepareLogo(input, contentType, b.name);
  b.logo = { type: prepared.type, data: prepared.data.toString('base64'), bytes: prepared.bytes };
  b.logoVersion += 1;
  await save(b);
  return { branding: b, prepared };
}

export async function clearLogo(): Promise<Branding> {
  const b = await getBranding();
  b.logo = null;
  b.icons = null;
  b.logoVersion += 1;
  await save(b);
  return b;
}

export async function getLogo(): Promise<{ type: LogoType; data: Buffer; version: number } | null> {
  const b = await getBranding();
  if (!b.logo) return null;
  return { type: b.logo.type, data: Buffer.from(b.logo.data, 'base64'), version: b.logoVersion };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Home-screen icons rendered by the admin's browser from the custom logo.
// All four are required so the manifest and iOS always find what they ask for.
export async function setIcons(iconBg: string, icons: Record<string, Buffer>): Promise<Branding> {
  const b = await getBranding();
  if (!b.logo) throw new Error('Upload a logo first');
  const stored: Record<string, string> = {};
  for (const name of ICON_NAMES) {
    const buf = icons[name];
    if (!buf) throw new Error(`Missing icon ${name}`);
    if (buf.length > ICON_MAX_BYTES) throw new Error(`${name} is larger than 512 KB`);
    if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${name} is not a PNG`);
    stored[name] = scrubMedia(buf, 'image/png').data.toString('base64');
  }
  b.iconBg = iconBg;
  b.icons = stored;
  b.logoVersion += 1;
  await save(b);
  return b;
}

export async function getIcon(name: string): Promise<Buffer | null> {
  const b = await getBranding();
  const data = b.icons?.[name];
  return data ? Buffer.from(data, 'base64') : null;
}

// The web app manifest. Icon URLs carry the version so installs pick up a
// new logo; without custom icons they resolve to the static defaults.
export function manifest(b: Branding, version: string): Record<string, unknown> {
  const v = b.icons ? b.logoVersion : 0;
  const icon = (name: string, sizes: string, purpose?: string) => ({ src: `/icons/${name}?v=${v}`, sizes, type: 'image/png', ...(purpose ? { purpose } : {}) });
  return {
    id: '/',
    name: b.name,
    short_name: b.name.length <= 12 ? b.name : b.name.slice(0, 12).trim(),
    description: 'Mail, contacts and outreach sequences on your own server.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f6f7fb',
    theme_color: b.icons ? b.iconBg : DEFAULT_ICON_BG,
    icons: [icon('icon-192.png', '192x192'), icon('icon-512.png', '512x512'), icon('icon-512-maskable.png', '512x512', 'maskable')],
    shortcuts: [
      { name: 'Inbox', url: '/mail/inbox', icons: [icon('icon-192.png', '192x192')] },
      { name: 'Compose', url: '/mail/inbox?compose=1', icons: [icon('icon-192.png', '192x192')] },
      { name: 'Contacts', url: '/contacts', icons: [icon('icon-192.png', '192x192')] },
    ],
    categories: ['productivity', 'business'],
    version,
  };
}
