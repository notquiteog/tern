import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecords, normIp6, parseZone, splitSrvName } from './dnsCheck.js';
import { generateDefaultSvg, sanitizeSvg } from './brand.js';

const ZONE = `v1-rsa-20260905._domainkey.probe.test. IN TXT (
    "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBg"
    "kqhkiG9w0BAQEFAAOCAQ8A"
)
probe.test. IN TXT "v=spf1 mx -all"
probe.test. IN MX 10 mail.probe.test.
_dmarc.probe.test. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@probe.test"
_imaps._tcp.probe.test. IN SRV 0 1 993 mail.probe.test.
mta-sts.probe.test. IN CNAME mail.probe.test.
probe.test. IN A 203.0.113.5
mail.probe.test. IN AAAA 2001:0db8:0000:0000:0000:0000:0000:0010
`;

test('parseZone joins multi-line TXT chunks and reads MX, SRV and CNAME', () => {
  const r = parseZone(ZONE);
  const dkim = r.find((x) => x.name.startsWith('v1-rsa'))!;
  assert.equal(dkim.type, 'TXT');
  assert.equal(dkim.value, 'v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
  const mx = r.find((x) => x.type === 'MX')!;
  assert.equal(mx.value, 'mail.probe.test'); assert.equal(mx.priority, 10);
  const srv = r.find((x) => x.type === 'SRV')!;
  assert.deepEqual(srv.srv, { priority: 0, weight: 1, port: 993, target: 'mail.probe.test' });
  assert.equal(r.find((x) => x.type === 'CNAME')!.value, 'mail.probe.test');
  // A and AAAA used to match the line regex and then fall through every
  // branch, so they vanished without a trace.
  assert.equal(r.find((x) => x.type === 'A')!.value, '203.0.113.5');
  assert.equal(r.find((x) => x.type === 'AAAA')!.value, '2001:0db8:0000:0000:0000:0000:0000:0010');
});

test('normIp6 expands the two spellings of one address to the same string', () => {
  assert.equal(normIp6('2001:db8::10'), normIp6('2001:0db8:0000:0000:0000:0000:0000:0010'));
  assert.equal(normIp6('2001:DB8::10'), '2001:db8:0:0:0:0:0:10');
  assert.equal(normIp6('::1'), '0:0:0:0:0:0:0:1');
  assert.equal(normIp6('2001:db8::'), '2001:db8:0:0:0:0:0:0');
  assert.equal(normIp6('[2001:db8::10]'), '2001:db8:0:0:0:0:0:10');
  assert.equal(normIp6('fe80::1%eth0'), 'fe80:0:0:0:0:0:0:1');
  assert.equal(normIp6('::ffff:192.0.2.1'), '0:0:0:0:0:ffff:c000:201');
  assert.equal(normIp6('not-an-address'), 'not-an-address');
});

test('buildRecords checks reverse DNS for the IPv6 address too', () => {
  const base = { zone: ZONE, domain: 'probe.test', mailHost: 'mail.probe.test', serverIp: '203.0.113.5' };
  // IPv4-only box: no AAAA row invented, and no v6 PTR to fail on.
  const v4 = buildRecords(base);
  assert.equal(v4.filter((r) => r.type === 'PTR').length, 1);
  assert.ok(!v4.some((r) => r.type === 'AAAA'));

  // .env names the IPv6: both an AAAA row and its own PTR row, each pointed
  // at the v6 address rather than the v4 one.
  const v6 = buildRecords({ ...base, serverIpv6: '2001:db8::10' });
  const aaaa = v6.find((r) => r.type === 'AAAA')!;
  assert.equal(aaaa.value, '2001:db8::10');
  assert.equal(aaaa.group, 'required');
  const ptr6 = v6.find((r) => r.id === 'ptr6')!;
  assert.equal(ptr6.ip, '2001:db8::10');
  assert.equal(ptr6.value, 'mail.probe.test');
  assert.equal(ptr6.group, 'required');
  assert.equal(v6.find((r) => r.id === 'ptr')!.ip, '203.0.113.5');

  // Nothing in .env, but the host publishes an AAAA: check that address's
  // reverse DNS, without an AAAA row that would only compare DNS to itself.
  const pub = buildRecords({ ...base, publishedIpv6: '2001:db8::99' });
  assert.equal(pub.find((r) => r.id === 'ptr6')!.ip, '2001:db8::99');
  assert.ok(!pub.some((r) => r.type === 'AAAA'));

  // The host's own address rows come from this box, not from the zone, so a
  // zone AAAA for the same name must not produce a second row.
  assert.equal(v6.filter((r) => r.type === 'AAAA' && r.name === 'mail.probe.test').length, 1);
  assert.ok(v6.some((r) => r.type === 'A' && r.name === 'probe.test'), 'other names from the zone are kept');
});

test('buildRecords adds A, PTR and BIMI and groups by importance', () => {
  const recs = buildRecords({ zone: ZONE, domain: 'probe.test', mailHost: 'mail.probe.test', serverIp: '203.0.113.5', bimiUrl: 'https://app.example/bimi/probe.test.svg' });
  assert.equal(recs[0].type, 'A'); assert.equal(recs[0].value, '203.0.113.5');
  assert.ok(recs.some((r) => r.id === 'ptr' && r.type === 'PTR'));
  assert.ok(recs.some((r) => r.type === 'TXT' && r.value.startsWith('v=BIMI1; l=https://app.example/bimi/probe.test.svg')));
  const groups = recs.map((r) => r.group);
  assert.equal(groups.indexOf('recommended') > groups.lastIndexOf('required'), true);
  assert.ok(recs.find((r) => r.value.startsWith('v=DMARC1'))!.purpose.includes('BIMI'));
});

test('splitSrvName breaks a name into the fields a registrar asks for', () => {
  assert.deepEqual(splitSrvName('_jmap._tcp.probe.test', 'probe.test'), { service: '_jmap', protocol: '_tcp', host: '@' });
  // A record under a subdomain keeps the label, without the zone repeated.
  assert.deepEqual(splitSrvName('_imaps._tcp.mail.probe.test', 'probe.test'), { service: '_imaps', protocol: '_tcp', host: 'mail' });
  assert.deepEqual(splitSrvName('_jmap._tcp.probe.test.', 'probe.test.'), { service: '_jmap', protocol: '_tcp', host: '@' });
  // Anything that is not service._protocol.zone is left whole rather than cut in the wrong place.
  assert.deepEqual(splitSrvName('probe.test', 'probe.test'), { service: '', protocol: '', host: 'probe.test' });
});

test('buildRecords carries the SRV fields for the mail-app rows', () => {
  const srv = buildRecords({ zone: ZONE, domain: 'probe.test', mailHost: 'mail.probe.test', serverIp: '203.0.113.5' }).find((r) => r.type === 'SRV')!;
  assert.equal(srv.group, 'clients');
  assert.deepEqual(srv.srv, { service: '_imaps', protocol: '_tcp', host: '@', priority: 0, weight: 1, port: 993, target: 'mail.probe.test' });
});

test('sanitizeSvg accepts clean logos and rejects unsafe ones', () => {
  const ok = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>');
  assert.ok(ok.ok && ok.svg.includes('baseProfile="tiny-ps"') && ok.svg.includes('<title>'));
  assert.equal(sanitizeSvg('<svg><script>alert(1)</script></svg>').ok, false);
  assert.equal(sanitizeSvg('<svg><iframe src="x"/></svg>').ok, false);
  assert.equal(sanitizeSvg('<div>no</div>').ok, false);
  // bitmaps, links and handlers are stripped by the Tiny PS pass rather than refused
  assert.ok(sanitizeSvg('<svg><image href="https://x/y.png"/></svg>').ok);
  assert.ok(sanitizeSvg('<svg><a href="https://x"/></svg>').ok);
  const handlers = sanitizeSvg('<svg><rect onclick="x"/></svg>');
  assert.ok(handlers.ok, 'event handlers are stripped later, not a reason to refuse');
});

test('generateDefaultSvg is a valid tiny-ps document with escaped text', () => {
  const svg = generateDefaultSvg({ initials: 'a<b', color: '#ffffff', bg: '#123456', name: 'Acme & Co' });
  assert.ok(svg.includes('baseProfile="tiny-ps"'));
  assert.ok(svg.includes('A&lt;B'));
  assert.ok(svg.includes('<title>Acme &amp; Co</title>'));
  assert.ok(sanitizeSvg(svg).ok);
});
