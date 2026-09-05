// DNS guidance and verification for the bundled mail server. Stalwart hands
// us a zone file; we turn it into records a person can publish one by one,
// add the ones Stalwart cannot know (A, reverse DNS, BIMI), explain what each
// one is for, and check them against the live DNS from this box.
import dns from 'node:dns/promises';
import net from 'node:net';

export type RecordType = 'A' | 'PTR' | 'MX' | 'TXT' | 'CNAME' | 'SRV';
export type Group = 'required' | 'recommended' | 'brand' | 'clients';
export interface DnsRecord { id: string; group: Group; type: RecordType; name: string; value: string; purpose: string; priority?: number; srv?: { priority: number; weight: number; port: number; target: string } }
export type Status = 'ok' | 'missing' | 'mismatch' | 'error' | 'skipped';
export interface CheckResult { id: string; status: Status; found: string[]; note?: string }

// Zone lines can span parentheses; TXT values arrive as several quoted chunks.
export function parseZone(zone: string): { name: string; type: RecordType; value: string; priority?: number; srv?: DnsRecord['srv'] }[] {
  const out: { name: string; type: RecordType; value: string; priority?: number; srv?: DnsRecord['srv'] }[] = [];
  const joined: string[] = [];
  let buf = '';
  let depth = 0;
  for (const raw of zone.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    buf += (buf ? ' ' : '') + line;
    depth += (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);
    if (depth <= 0) { joined.push(buf); buf = ''; depth = 0; }
  }
  if (buf) joined.push(buf);
  for (const l of joined) {
    const m = l.match(/^(\S+)\.?\s+(?:\d+\s+)?IN\s+(A|AAAA|MX|TXT|CNAME|SRV)\s+(.*)$/i);
    if (!m) continue;
    const name = m[1].replace(/\.$/, '');
    const type = m[2].toUpperCase() as RecordType;
    let rest = m[3].trim();
    if (type === 'TXT') {
      const parts = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\"/g, '"'));
      out.push({ name, type, value: parts.join('') });
    } else if (type === 'MX') {
      const mm = rest.match(/^(\d+)\s+(\S+)/);
      if (mm) out.push({ name, type, value: mm[2].replace(/\.$/, ''), priority: Number(mm[1]) });
    } else if (type === 'SRV') {
      const sm = rest.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
      if (sm) out.push({ name, type, value: sm[4].replace(/\.$/, ''), srv: { priority: Number(sm[1]), weight: Number(sm[2]), port: Number(sm[3]), target: sm[4].replace(/\.$/, '') } });
    } else if (type === 'CNAME') {
      out.push({ name, type, value: rest.replace(/\.$/, '') });
    }
  }
  return out;
}

function purposeFor(name: string, type: RecordType, value: string, domain: string, mailHost: string): { group: Group; purpose: string } {
  const n = name.toLowerCase();
  if (type === 'MX') return { group: 'required', purpose: 'Tells the world which server receives mail for the domain.' };
  if (type === 'TXT' && value.startsWith('v=DKIM1')) return { group: 'required', purpose: `DKIM public key (${/k=ed25519/.test(value) ? 'Ed25519' : 'RSA'}). Receivers use it to verify that mail was really signed by this server.` };
  if (type === 'TXT' && value.startsWith('v=spf1')) return { group: 'required', purpose: n === domain.toLowerCase() ? 'SPF: only the MX host may send mail for the domain. Everything else is rejected.' : 'SPF for the mail host itself, used for bounce and report messages.' };
  if (type === 'TXT' && value.startsWith('v=DMARC1')) return { group: 'required', purpose: 'DMARC: tells receivers to reject mail that fails SPF and DKIM, and where to send reports. Required for BIMI logos.' };
  if (type === 'TXT' && value.startsWith('v=STSv1')) return { group: 'recommended', purpose: 'MTA-STS: announces that this domain has a TLS policy, so other servers refuse to deliver to you over plain text.' };
  if (type === 'CNAME' && n.startsWith('mta-sts.')) return { group: 'recommended', purpose: 'Hosts the MTA-STS policy file at https://mta-sts.' + domain + '/.well-known/mta-sts.txt (served by the mail server through Caddy).' };
  if (type === 'TXT' && value.startsWith('v=TLSRPTv1')) return { group: 'recommended', purpose: 'TLS-RPT: receive daily reports when someone could not connect to you securely.' };
  if (type === 'TXT' && value.startsWith('v=BIMI1')) return { group: 'brand', purpose: 'BIMI: points mail clients at your brand logo so it appears beside your messages.' };
  if (type === 'CNAME' && /^(autoconfig|autodiscover|ua-auto-config)\./.test(n)) return { group: 'clients', purpose: 'Lets mail apps configure themselves from just the address.' };
  if (type === 'TXT' && value.startsWith('v=UAAC1')) return { group: 'clients', purpose: 'Signature for the automatic client configuration.' };
  if (type === 'SRV') return { group: 'clients', purpose: 'Service discovery for mail, calendar and contacts apps.' };
  return { group: 'recommended', purpose: '' };
}

export function buildRecords(input: { zone: string; domain: string; mailHost: string; serverIp?: string | null; bimiUrl?: string | null }): DnsRecord[] {
  const { zone, domain, mailHost } = input;
  const out: DnsRecord[] = [];
  out.push({ id: 'a-mail', group: 'required', type: 'A', name: mailHost, value: input.serverIp || '<this server\'s IPv4>', purpose: 'The mail server\'s address. Every other record points here.' });
  out.push({ id: 'ptr', group: 'required', type: 'PTR', name: input.serverIp ? `${input.serverIp} (reverse DNS)` : 'reverse DNS of the server IP', value: mailHost, purpose: 'Reverse DNS, set in your hosting provider\'s panel, not at the registrar. Gmail and Microsoft reject mail from servers whose forward and reverse names disagree.' });
  let i = 0;
  for (const r of parseZone(zone)) {
    const { group, purpose } = purposeFor(r.name, r.type, r.value, domain, mailHost);
    out.push({ id: `z${i++}`, group, type: r.type, name: r.name, value: r.value, priority: r.priority, srv: r.srv, purpose });
  }
  if (input.bimiUrl) {
    out.push({ id: 'bimi', group: 'brand', type: 'TXT', name: `default._bimi.${domain}`, value: `v=BIMI1; l=${input.bimiUrl}; a=;`, purpose: 'BIMI: points mail clients at your brand logo so it appears beside your messages. Yahoo, Fastmail and others show it as is; Gmail and Apple Mail also want a paid Verified Mark Certificate (a=).' });
  }
  const order: Group[] = ['required', 'recommended', 'brand', 'clients'];
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\.$/, '');

async function withTimeout<T>(p: Promise<T>, ms = 6000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('DNS lookup timed out')), ms))]);
}

export async function checkRecord(r: DnsRecord, serverIp?: string | null): Promise<CheckResult> {
  try {
    switch (r.type) {
      case 'A': {
        const found = await withTimeout(dns.resolve4(r.name));
        if (!found.length) return { id: r.id, status: 'missing', found };
        if (serverIp && !found.includes(serverIp)) return { id: r.id, status: 'mismatch', found, note: `Resolves to ${found.join(', ')} but this server appears to be ${serverIp}` };
        return { id: r.id, status: 'ok', found };
      }
      case 'PTR': {
        if (!serverIp) return { id: r.id, status: 'skipped', found: [], note: 'Server IP unknown; set SERVER_IP in .env or re-run the installer' };
        const found = await withTimeout(dns.reverse(serverIp));
        if (!found.length) return { id: r.id, status: 'missing', found };
        return found.map(norm).includes(norm(r.value)) ? { id: r.id, status: 'ok', found } : { id: r.id, status: 'mismatch', found, note: `Reverse DNS says ${found.join(', ')}` };
      }
      case 'MX': {
        const found = await withTimeout(dns.resolveMx(r.name));
        const hosts = found.map((m) => `${m.priority} ${m.exchange}`);
        return found.some((m) => norm(m.exchange) === norm(r.value)) ? { id: r.id, status: 'ok', found: hosts } : { id: r.id, status: found.length ? 'mismatch' : 'missing', found: hosts };
      }
      case 'CNAME': {
        const found = await withTimeout(dns.resolveCname(r.name));
        return found.map(norm).includes(norm(r.value)) ? { id: r.id, status: 'ok', found } : { id: r.id, status: found.length ? 'mismatch' : 'missing', found };
      }
      case 'SRV': {
        const found = await withTimeout(dns.resolveSrv(r.name));
        const strs = found.map((s) => `${s.priority} ${s.weight} ${s.port} ${s.name}`);
        return found.some((s) => norm(s.name) === norm(r.value) && s.port === r.srv?.port) ? { id: r.id, status: 'ok', found: strs } : { id: r.id, status: found.length ? 'mismatch' : 'missing', found: strs };
      }
      case 'TXT': {
        const found = (await withTimeout(dns.resolveTxt(r.name))).map((chunks) => chunks.join(''));
        const want = norm(r.value);
        if (found.map(norm).includes(want)) return { id: r.id, status: 'ok', found };
        // DKIM and DMARC records are compared on the parts that matter.
        const tag = (s: string, k: string) => (s.match(new RegExp(`(?:^|;)\\s*${k}=([^;]*)`, 'i'))?.[1] ?? '').replace(/\s+/g, '');
        if (r.value.startsWith('v=DKIM1')) {
          const ok = found.some((f) => tag(f, 'p') === tag(r.value, 'p'));
          return { id: r.id, status: ok ? 'ok' : found.length ? 'mismatch' : 'missing', found, note: ok ? undefined : found.length ? 'A DKIM record exists but the key differs; the server rotated keys or an old record was left behind' : undefined };
        }
        if (r.value.startsWith('v=DMARC1')) {
          const f = found.find((x) => x.toLowerCase().startsWith('v=dmarc1'));
          if (!f) return { id: r.id, status: 'missing', found };
          const p = tag(f, 'p').toLowerCase();
          return ['reject', 'quarantine'].includes(p) ? { id: r.id, status: 'ok', found, note: p === 'quarantine' ? 'p=quarantine works; p=reject is the goal once reports look clean' : undefined } : { id: r.id, status: 'mismatch', found, note: `p=${p || 'none'} does not protect the domain (and BIMI requires quarantine or reject)` };
        }
        if (r.value.startsWith('v=spf1')) {
          const f = found.find((x) => x.toLowerCase().startsWith('v=spf1'));
          return f ? { id: r.id, status: 'mismatch', found, note: 'An SPF record exists but differs; there must be exactly one and it should include the MX host' } : { id: r.id, status: 'missing', found };
        }
        if (r.value.startsWith('v=STSv1')) {
          const f = found.find((x) => x.toLowerCase().startsWith('v=stsv1'));
          return f ? { id: r.id, status: 'ok', found, note: 'Present (the id may differ from the server\'s; it changes when the policy changes)' } : { id: r.id, status: 'missing', found };
        }
        if (r.value.startsWith('v=BIMI1')) {
          const f = found.find((x) => x.toLowerCase().startsWith('v=bimi1'));
          return f ? { id: r.id, status: tag(f, 'l') === tag(r.value, 'l') ? 'ok' : 'mismatch', found } : { id: r.id, status: 'missing', found };
        }
        return { id: r.id, status: found.length ? 'mismatch' : 'missing', found };
      }
    }
  } catch (e) {
    const code = (e as any)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { id: r.id, status: 'missing', found: [] };
    return { id: r.id, status: 'error', found: [], note: (e as Error).message };
  }
}

export async function checkAll(records: DnsRecord[], serverIp?: string | null): Promise<CheckResult[]> {
  return Promise.all(records.map((r) => checkRecord(r, serverIp)));
}

// Can this box open outbound port 25? Providers that block it stop all
// direct delivery, and the failure is silent until the queue fills up.
export async function checkOutbound25(host = 'gmail-smtp-in.l.google.com'): Promise<{ ok: boolean; note: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: 25 });
    const done = (ok: boolean, note: string) => { try { s.destroy(); } catch { /* ignore */ } resolve({ ok, note }); };
    s.setTimeout(6000, () => done(false, `No answer from ${host}:25 within 6 seconds; the hosting provider probably blocks outbound port 25`));
    s.once('connect', () => done(true, `Outbound port 25 is open (connected to ${host})`));
    s.once('error', (e) => done(false, `Could not connect to ${host}:25 (${(e as any).code ?? e.message})`));
  });
}

export function detectServerIp(): string | null {
  const v = process.env.SERVER_IP?.trim();
  return v && net.isIPv4(v) ? v : null;
}
