// Verifying BIMI end to end, including the part nobody can check by eye: the
// Verified Mark Certificate. A VMC carries a copy of the logo inside it, and
// Gmail compares that copy against the file your BIMI record points at. When
// the two differ — which happens the moment the logo is re-uploaded or
// re-traced after the certificate was issued — the logo silently stops
// appearing, with no bounce, no report and nothing in the headers to explain
// it. So we pull the certificate apart, take the logo out of it, and compare
// the bytes with the ones we serve.
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { createHash, X509Certificate } from 'node:crypto';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';
// `step` groups the checks under the five stages the UI walks through.
export interface BimiCheck { id: string; step: number; label: string; status: CheckStatus; detail: string; fix?: string }

const LOGOTYPE_OID = '1.3.6.1.5.5.7.1.12';
// The two mark verifying authorities Gmail and Apple Mail accept. A
// certificate from anyone else parses fine and proves nothing to them.
const KNOWN_CAS = ['digicert', 'entrust'];

// ---------- a small DER reader ----------
// Enough of BER/DER to walk a certificate and dig the logo out of an
// extension. Not a validator: the certificate has already been parsed by
// OpenSSL through X509Certificate by the time we get here.
interface Node { tag: number; constructed: boolean; contentStart: number; contentEnd: number; end: number }

function readNode(b: Buffer, pos: number, limit: number): Node | null {
  if (pos + 2 > limit) return null;
  const tag = b[pos];
  if ((tag & 0x1f) === 0x1f) return null; // high tag numbers do not occur in these structures
  let p = pos + 1;
  let len = b[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > limit) return null; // indefinite length is not DER
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  const end = p + len;
  if (end > limit) return null;
  return { tag, constructed: (tag & 0x20) !== 0, contentStart: p, contentEnd: end, end };
}

function childrenOf(b: Buffer, n: Node): Node[] {
  const out: Node[] = [];
  let p = n.contentStart;
  while (p < n.contentEnd) {
    const c = readNode(b, p, n.contentEnd);
    if (!c || c.end <= p) break;
    out.push(c);
    p = c.end;
  }
  return out;
}

// An OCTET STRING that holds one complete TLV is a wrapper (an extension
// value, a nested structure) and worth descending into.
function unwrap(b: Buffer, n: Node): Node[] {
  if (n.constructed) return childrenOf(b, n);
  if (n.tag !== 0x04) return [];
  const inner = readNode(b, n.contentStart, n.contentEnd);
  return inner && inner.end === n.contentEnd ? [inner] : [];
}

function walk(b: Buffer, n: Node, visit: (node: Node, kids: Node[]) => void, depth = 0): void {
  if (depth > 32) return;
  const kids = unwrap(b, n);
  visit(n, kids);
  for (const k of kids) walk(b, k, visit, depth + 1);
}

export function decodeOid(b: Buffer, n: Node): string {
  const bytes = b.subarray(n.contentStart, n.contentEnd);
  if (!bytes.length) return '';
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let acc = 0;
  for (let i = 1; i < bytes.length; i++) {
    acc = acc * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join('.');
}

// ---------- the logotype extension ----------
export interface Logotype {
  mediaType: string | null;
  uris: string[];
  hashes: { alg: string; hex: string }[];
  // The logo itself, when the certificate embeds it as a data: URI (which is
  // how every VMC issued so far carries it).
  image: Buffer | null;
  encoding: 'gzip' | 'deflate' | 'none' | null;
}

const HASH_NAMES: Record<string, string> = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' };

// A base64 data: URI, gzipped or not. Anything else is left alone.
export function decodeDataUri(uri: string): { bytes: Buffer; encoding: 'gzip' | 'deflate' | 'none' } | null {
  const m = uri.match(/^data:([^,;]*)(;[^,]*)?,(.*)$/s);
  if (!m) return null;
  const raw = /;base64/i.test(m[2] ?? '') ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return inflateIfPacked(raw);
}

export function inflateIfPacked(raw: Buffer): { bytes: Buffer; encoding: 'gzip' | 'deflate' | 'none' } {
  try {
    if (raw[0] === 0x1f && raw[1] === 0x8b) return { bytes: zlib.gunzipSync(raw), encoding: 'gzip' };
    if ((raw[0] & 0x0f) === 0x08) return { bytes: zlib.inflateSync(raw), encoding: 'deflate' };
  } catch { /* not compressed after all; the bytes are the image */ }
  return { bytes: raw, encoding: 'none' };
}

export function readLogotype(der: Buffer): Logotype | null {
  const root = readNode(der, 0, der.length);
  if (!root) return null;
  let value: Node | null = null;
  walk(der, root, (_n, kids) => {
    // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
    if (value || kids.length < 2 || kids[0].tag !== 0x06) return;
    if (decodeOid(der, kids[0]) !== LOGOTYPE_OID) return;
    const last = kids[kids.length - 1];
    if (last.tag === 0x04) value = last;
  });
  if (!value) return null;
  const strings: string[] = [];
  const hashes: { alg: string; hex: string }[] = [];
  walk(der, value, (n, kids) => {
    if (n.tag === 0x16 || n.tag === 0x0c) strings.push(der.subarray(n.contentStart, n.contentEnd).toString('utf8'));
    // HashAlgAndValue ::= SEQUENCE { hashAlg AlgorithmIdentifier, hashValue OCTET STRING }
    if (kids.length === 2 && kids[0].constructed && kids[1].tag === 0x04) {
      const alg = childrenOf(der, kids[0]).find((k) => k.tag === 0x06);
      if (alg) hashes.push({ alg: HASH_NAMES[decodeOid(der, alg)] ?? decodeOid(der, alg), hex: der.subarray(kids[1].contentStart, kids[1].contentEnd).toString('hex') });
    }
  });
  const data = strings.find((s) => s.startsWith('data:'));
  const decoded = data ? decodeDataUri(data) : null;
  return {
    mediaType: strings.find((s) => /^[a-z]+\/[\w.+-]+$/i.test(s)) ?? null,
    uris: strings.filter((s) => /^https?:\/\//i.test(s)),
    hashes,
    image: decoded?.bytes ?? null,
    encoding: decoded?.encoding ?? null,
  };
}

// ---------- the certificate ----------
export function splitPem(pem: string): string[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0]);
}

function nameFields(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Node prints one field per line; commas inside a value stay put, which is
  // why this splits on newlines and not on commas.
  for (const line of name.split('\n')) {
    const i = line.indexOf('=');
    // OpenSSL escapes the characters that separate fields; an organisation
    // called "Probe Industries, Inc." arrives with a backslash in it.
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/\\([,+"\\<>;= ])/g, '$1');
  }
  return out;
}

export interface VmcInfo {
  ok: boolean;
  error: string | null;
  certificates: number;
  subject: Record<string, string>;
  organization: string | null;
  issuer: string | null;
  issuerTrusted: boolean;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  altNames: string[];
  coversDomain: boolean;
  logotype: Logotype | null;
  // How the logo inside the certificate relates to the one we serve.
  logoMatch: 'exact' | 'hash' | 'similar' | 'different' | 'unknown';
  logoBytes: number | null;
}

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

export function inspectVmc(pem: string, opts: { domain: string; logo: Buffer | null }): VmcInfo {
  const blocks = splitPem(pem);
  const empty: VmcInfo = { ok: false, error: null, certificates: blocks.length, subject: {}, organization: null, issuer: null, issuerTrusted: false, validFrom: null, validTo: null, daysLeft: null, altNames: [], coversDomain: false, logotype: null, logoMatch: 'unknown', logoBytes: null };
  if (!blocks.length) return { ...empty, error: 'The file contains no PEM certificate block. A VMC download is a text file of -----BEGIN CERTIFICATE----- blocks; make sure the URL serves that and not a .p7b, .der or an HTML page.' };
  let cert: X509Certificate;
  try { cert = new X509Certificate(blocks[0]); } catch (e) { return { ...empty, error: `The first certificate could not be parsed: ${(e as Error).message}` }; }
  const subject = nameFields(cert.subject);
  const issuer = nameFields(cert.issuer);
  const issuerName = issuer.O || issuer.CN || cert.issuer.replace(/\n/g, ', ');
  const altNames = (cert.subjectAltName ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^DNS:/i, ''));
  const validTo = cert.validTo ? new Date(cert.validTo) : null;
  const logotype = readLogotype(cert.raw);
  let logoMatch: VmcInfo['logoMatch'] = 'unknown';
  if (logotype && opts.logo) {
    if (logotype.image && logotype.image.equals(opts.logo)) logoMatch = 'exact';
    else if (logotype.hashes.some((h) => h.alg === 'sha256' && hashesOf(opts.logo!).includes(h.hex))) logoMatch = 'hash';
    else if (logotype.image && strip(logotype.image.toString('utf8')) === strip(opts.logo.toString('utf8'))) logoMatch = 'similar';
    else if (logotype.image || logotype.hashes.length) logoMatch = 'different';
  }
  return {
    ok: true,
    error: null,
    certificates: blocks.length,
    subject,
    organization: subject.O ?? null,
    issuer: issuerName,
    issuerTrusted: KNOWN_CAS.some((c) => issuerName.toLowerCase().includes(c)),
    validFrom: cert.validFrom ? new Date(cert.validFrom).toISOString() : null,
    validTo: validTo ? validTo.toISOString() : null,
    daysLeft: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86400000) : null,
    altNames,
    coversDomain: Boolean(cert.checkHost(opts.domain)) || altNames.some((n) => n.toLowerCase() === opts.domain.toLowerCase()),
    logotype,
    logoMatch,
    logoBytes: logotype?.image?.length ?? null,
  };
}

// The certificate may hash the file as served or as gzipped; try both rather
// than guess which the certificate authority chose.
function hashesOf(logo: Buffer): string[] {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const out = [sha(logo)];
  try { out.push(sha(zlib.gzipSync(logo))); } catch { /* hashing the plain bytes is enough */ }
  return out;
}

// ---------- fetching what the world sees ----------
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    return o[0] === 0 || o[0] === 10 || o[0] === 127 || (o[0] === 169 && o[1] === 254) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || o[0] >= 224;
  }
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

// The URL comes from an admin, but it is still an address this server is
// being asked to open: keep it to public https so it cannot be pointed at
// the machine's own metadata service or a neighbour on the private network.
export async function fetchPublic(url: string, maxBytes = 512 * 1024): Promise<{ ok: true; bytes: Buffer; contentType: string; status: number } | { ok: false; error: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: 'That is not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'The URL must be https; mail clients will not follow anything else' };
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length) return { ok: false, error: `${u.hostname} does not resolve` };
    if (addrs.some((a) => isPrivateAddress(a.address))) return { ok: false, error: `${u.hostname} resolves to a private address, so no mail client on the internet could fetch it` };
  } catch (e) {
    return { ok: false, error: `${u.hostname} does not resolve (${(e as any)?.code ?? (e as Error).message})` };
  }
  try {
    const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'tern-bimi-check' } });
    if (!res.ok) return { ok: false, error: `${u.href} answered ${res.status} ${res.statusText}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: `${u.href} returned ${Math.round(buf.length / 1024)} KB, more than expected for this file` };
    return { ok: true, bytes: buf, contentType: res.headers.get('content-type') ?? '', status: res.status };
  } catch (e) {
    return { ok: false, error: `Could not fetch ${u.href}: ${(e as Error).message}` };
  }
}

// ---------- DNS ----------
const tagOf = (s: string, k: string) => (s.match(new RegExp(`(?:^|;)\\s*${k}=([^;]*)`, 'i'))?.[1] ?? '').trim();

async function txt(name: string): Promise<string[]> {
  try {
    const r = await Promise.race([dns.resolveTxt(name), new Promise<string[][]>((_, rej) => setTimeout(() => rej(new Error('DNS lookup timed out')), 6000))]);
    return r.map((chunks) => chunks.join(''));
  } catch (e) {
    const code = (e as any)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw e;
  }
}

export interface BimiReport {
  domain: string;
  checks: BimiCheck[];
  dmarc: { record: string | null; policy: string; pct: number } | null;
  bimi: { record: string | null; l: string; a: string } | null;
  vmc: (VmcInfo & { url: string }) | null;
  ready: { basic: boolean; gmail: boolean };
}

// Everything BIMI needs, in the order the UI walks through it: the logo, the
// DMARC policy it rests on, the record that points at it, the certificate,
// and whether the certificate really describes the logo we serve.
export async function checkBimi(input: { domain: string; hostedUrl: string; logo: Buffer | null; vmcUrl: string | null }): Promise<BimiReport> {
  const { domain, hostedUrl } = input;
  const checks: BimiCheck[] = [];
  const add = (c: BimiCheck) => { checks.push(c); return c; };

  // 1. The logo.
  if (!input.logo) {
    add({ id: 'logo', step: 1, label: 'Logo prepared', status: 'fail', detail: 'No logo is stored for this domain yet.', fix: 'Upload an image above, or generate a default avatar.' });
  } else {
    const svg = input.logo.toString('utf8');
    const kb = Math.round(input.logo.length / 1024 * 10) / 10;
    const tiny = /baseProfile\s*=\s*"tiny-ps"/i.test(svg);
    const clean = !/<image\b/i.test(svg) && !/<script/i.test(svg);
    add({
      id: 'logo', step: 1,
      label: 'Logo prepared',
      status: tiny && clean && input.logo.length <= 32 * 1024 ? 'ok' : 'warn',
      detail: `${kb} KB, ${tiny ? 'SVG Tiny PS' : 'no tiny-ps baseProfile'}${clean ? '' : ', contains a bitmap or a script'}. Served at ${hostedUrl}.`,
      fix: tiny && clean ? undefined : 'Re-upload the logo so it is rebuilt as SVG Tiny Portable/Secure; certificate authorities reject anything else.',
    });
  }

  // 2. DMARC. BIMI is only honoured for domains that already tell receivers
  // to act on failures, so a permissive policy stops everything downstream.
  let dmarc: BimiReport['dmarc'] = null;
  try {
    const found = (await txt(`_dmarc.${domain}`)).filter((r) => /^v=dmarc1/i.test(r));
    const record = found[0] ?? null;
    const policy = record ? (tagOf(record, 'p').toLowerCase() || 'none') : '';
    const pct = record ? Number(tagOf(record, 'pct') || 100) : 0;
    dmarc = record ? { record, policy, pct } : null;
    if (!record) add({ id: 'dmarc', step: 2, label: 'DMARC enforced', status: 'fail', detail: `No DMARC record at _dmarc.${domain}.`, fix: 'Publish the DMARC record from the DNS setup tab, then raise it to quarantine or reject.' });
    else if (!['quarantine', 'reject'].includes(policy)) add({ id: 'dmarc', step: 2, label: 'DMARC enforced', status: 'fail', detail: `p=${policy} does not enforce anything, and BIMI is ignored without enforcement.`, fix: 'Move to p=quarantine once the DMARC reports look clean, then to p=reject.' });
    else if (pct < 100) add({ id: 'dmarc', step: 2, label: 'DMARC enforced', status: 'warn', detail: `p=${policy} but pct=${pct}; BIMI needs the policy applied to all mail.`, fix: 'Remove the pct tag, or set pct=100.' });
    else add({ id: 'dmarc', step: 2, label: 'DMARC enforced', status: 'ok', detail: `p=${policy}, applied to all mail.` });
  } catch (e) {
    add({ id: 'dmarc', step: 2, label: 'DMARC enforced', status: 'warn', detail: `Could not look up _dmarc.${domain}: ${(e as Error).message}` });
  }

  // 3. The BIMI record itself.
  let bimi: BimiReport['bimi'] = null;
  try {
    const found = (await txt(`default._bimi.${domain}`)).filter((r) => /^v=bimi1/i.test(r));
    const record = found[0] ?? null;
    bimi = record ? { record, l: tagOf(record, 'l'), a: tagOf(record, 'a') } : null;
    if (!record) add({ id: 'record', step: 3, label: 'BIMI record published', status: 'fail', detail: `No record at default._bimi.${domain}.`, fix: 'Publish the TXT record shown above at your DNS host.' });
    else if (!bimi!.l) add({ id: 'record', step: 3, label: 'BIMI record published', status: 'fail', detail: 'The record has no l= tag, so it names no logo.', fix: 'Replace it with the record shown above.' });
    else if (bimi!.l !== hostedUrl) add({ id: 'record', step: 3, label: 'BIMI record published', status: 'warn', detail: `l= points at ${bimi!.l}, not at ${hostedUrl}.`, fix: 'That is fine if you host the logo elsewhere on purpose — the checks below compare against the file this server holds.' });
    else add({ id: 'record', step: 3, label: 'BIMI record published', status: 'ok', detail: `l= points at the hosted logo${bimi!.a ? ', a= names a certificate' : ', with no a= certificate'}.` });
  } catch (e) {
    add({ id: 'record', step: 3, label: 'BIMI record published', status: 'warn', detail: `Could not look up default._bimi.${domain}: ${(e as Error).message}` });
  }

  // 4 and 5. The certificate: fetch it, read it, and hold it against the logo.
  const url = input.vmcUrl || bimi?.a || '';
  let vmc: BimiReport['vmc'] = null;
  if (!url) {
    add({ id: 'vmc-url', step: 4, label: 'Mark certificate', status: 'skipped', detail: 'No certificate URL yet. Yahoo, Fastmail and La Poste show the logo without one; Gmail and Apple Mail do not.', fix: 'Buy a VMC or CMC from DigiCert or Entrust, host the .pem at a public https address, and paste the URL below.' });
  } else {
    const got = await fetchPublic(url);
    if (!got.ok) {
      add({ id: 'vmc-url', step: 4, label: 'Certificate reachable', status: 'fail', detail: got.error, fix: 'Mail clients fetch this URL directly, so it must be public https with a valid certificate of its own.' });
    } else {
      const pem = got.bytes.toString('utf8');
      add({ id: 'vmc-url', step: 4, label: 'Certificate reachable', status: 'ok', detail: `${Math.round(got.bytes.length / 1024 * 10) / 10} KB from ${url}${got.contentType ? ` (${got.contentType.split(';')[0]})` : ''}.` });
      // Compare against what the world is served, when that differs from the
      // copy in the database: a stale file at the l= URL breaks the match
      // just as thoroughly as a stale certificate.
      let logo = input.logo;
      if (bimi?.l && bimi.l !== hostedUrl) {
        const served = await fetchPublic(bimi.l, 64 * 1024);
        if (served.ok) logo = served.bytes;
      }
      const info = inspectVmc(pem, { domain, logo });
      vmc = { ...info, url };
      if (!info.ok) {
        add({ id: 'vmc-parse', step: 5, label: 'Certificate readable', status: 'fail', detail: info.error ?? 'The certificate could not be read.' });
      } else {
        if (info.certificates < 2) add({ id: 'vmc-chain', step: 5, label: 'Full chain', status: 'warn', detail: `The file holds ${info.certificates} certificate${info.certificates === 1 ? '' : 's'}.`, fix: 'Host the full chain the authority issued — the mark certificate followed by its intermediates — in one .pem file.' });
        else add({ id: 'vmc-chain', step: 5, label: 'Full chain', status: 'ok', detail: `${info.certificates} certificates: the mark certificate and its chain.` });

        add({ id: 'vmc-issuer', step: 5, label: 'Issued by a recognised authority', status: info.issuerTrusted ? 'ok' : 'warn', detail: info.issuer ? `Issued by ${info.issuer}${info.organization ? ` to ${info.organization}` : ''}.` : 'The issuer could not be read.', fix: info.issuerTrusted ? undefined : 'Gmail and Apple Mail only accept DigiCert and Entrust as mark verifying authorities.' });

        add({ id: 'vmc-domain', step: 5, label: 'Covers this domain', status: info.coversDomain ? 'ok' : 'fail', detail: info.altNames.length ? `Names in the certificate: ${info.altNames.join(', ')}.` : 'The certificate names no domains.', fix: info.coversDomain ? undefined : `The certificate must list ${domain}; ask the authority to reissue it with that name.` });

        const days = info.daysLeft;
        add({ id: 'vmc-expiry', step: 5, label: 'In date', status: days === null ? 'warn' : days < 0 ? 'fail' : days < 30 ? 'warn' : 'ok', detail: info.validTo ? `Valid until ${info.validTo.slice(0, 10)}${days !== null ? ` (${days < 0 ? `expired ${-days} days ago` : `${days} days left`})` : ''}.` : 'No validity dates could be read.', fix: days !== null && days < 30 ? 'Mark certificates last a year. Renew it before it lapses, and keep the logo unchanged so the new one still matches.' : undefined });

        if (!info.logotype) {
          add({ id: 'vmc-logo', step: 5, label: 'Logo inside the certificate', status: 'fail', detail: 'The certificate carries no logotype extension, so it is not a mark certificate.', fix: 'A TLS certificate cannot stand in for a VMC. Check that you are hosting the mark certificate the authority issued.' });
        } else {
          const size = info.logoBytes ? `${Math.round(info.logoBytes / 1024 * 10) / 10} KB` : 'no embedded copy';
          const detail = { exact: 'The logo in the certificate is byte for byte the one served here.', hash: 'The hash in the certificate matches the logo served here.', similar: `The certificate holds the same drawing but not the same bytes (${size} against ${input.logo ? Math.round(input.logo.length / 1024 * 10) / 10 + ' KB' : 'nothing'} here); mail clients compare bytes, so this still fails.`, different: `The certificate holds a different file (${size}) from the one served here.`, unknown: 'There is nothing to compare it against.' }[info.logoMatch];
          add({
            id: 'vmc-logo', step: 5,
            label: 'Certificate matches the logo',
            status: info.logoMatch === 'exact' || info.logoMatch === 'hash' ? 'ok' : info.logoMatch === 'unknown' ? 'warn' : 'fail',
            detail,
            fix: info.logoMatch === 'similar' || info.logoMatch === 'different' ? 'Re-upload the exact SVG that went to the certificate authority, or have the certificate reissued from the file served here. Gmail drops the logo without a word when these differ.' : undefined,
          });
        }

        if (bimi?.a && info.ok && bimi.a !== url) add({ id: 'vmc-record', step: 5, label: 'Record names this certificate', status: 'warn', detail: `The published record's a= is ${bimi.a}, but the certificate checked here is ${url}.`, fix: 'Publish the record shown above so a= and the saved URL agree.' });
      }
    }
  }

  const fine = (id: string) => checks.find((c) => c.id === id)?.status === 'ok';
  return {
    domain, checks, dmarc, bimi, vmc,
    ready: {
      basic: fine('logo') && fine('dmarc') && fine('record'),
      gmail: fine('logo') && fine('dmarc') && fine('record') && fine('vmc-domain') && fine('vmc-expiry') && fine('vmc-logo'),
    },
  };
}
