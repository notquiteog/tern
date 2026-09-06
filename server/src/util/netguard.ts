// Outbound request guard. The server fetches URLs that people type in (a
// JMAP session URL, an SMTP host, a push endpoint) and URLs derived from
// addresses (Web Key Directory lookups). Left unchecked, a member could
// point one of those at the compose network and reach services that trust
// it: Ollama has no authentication, Postgres and Stalwart's management API
// listen there. So every such host is resolved first and refused when it
// lands on a loopback, private, link-local or metadata address, unless it
// is the bundled mail server's own origin, or the admin opted in for a
// JMAP server on a LAN (ALLOW_PRIVATE_NETWORK_HOSTS).
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { badRequest } from '../errors.js';

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; addrs: string[] }>();

export function isPrivateAddress(ip: string): boolean {
  const v6 = ip.includes(':');
  if (v6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) is judged by its IPv4 part.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
    if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
    if (lower.startsWith('::ffff:0')) return true;
    if (lower.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local and cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

// Names that only mean something inside the compose network or the box.
function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.');
}

export async function resolveHost(host: string): Promise<string[]> {
  const h = host.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return [h];
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.addrs;
  const results = await dns.lookup(h, { all: true, verbatim: true });
  const addrs = results.map((r) => r.address);
  cache.set(h, { at: Date.now(), addrs });
  if (cache.size > 500) cache.clear();
  return addrs;
}

// The bundled Stalwart is reached over the compose network on purpose.
export function isInternalOrigin(url: string): boolean {
  if (!config.stalwartUrl) return false;
  try { return new URL(url).origin === new URL(config.stalwartUrl).origin; } catch { return false; }
}

export interface GuardOptions { allowPrivate?: boolean; what?: string }

// Throws a 400 when `host` resolves to an address this server must not talk to.
export async function assertPublicHost(host: string, opts: GuardOptions = {}): Promise<void> {
  if (opts.allowPrivate || config.allowPrivateHosts) return;
  const what = opts.what ?? 'That host';
  if (!host || isLocalName(host)) throw badRequest(`${what} points at this server's own network, which is not allowed`);
  let addrs: string[];
  try { addrs = await resolveHost(host); } catch { throw badRequest(`${what} could not be resolved (${host})`); }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw badRequest(`${what} points at a private or internal address, which is not allowed`);
}

// Same check for a full URL; only http(s) is ever fetched.
export async function assertPublicUrl(url: string, opts: GuardOptions = {}): Promise<URL> {
  let u: URL;
  try { u = new URL(url); } catch { throw badRequest(`${opts.what ?? 'That URL'} is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest(`${opts.what ?? 'That URL'} must use http or https`);
  if (u.username || u.password) throw badRequest(`${opts.what ?? 'That URL'} must not carry credentials`);
  if (opts.allowPrivate || isInternalOrigin(url)) return u;
  await assertPublicHost(u.hostname, opts);
  return u;
}

// For tests: forget cached lookups.
export function clearHostCache(): void { cache.clear(); }
