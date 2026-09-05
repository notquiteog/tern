import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecords, parseZone } from './dnsCheck.js';
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
});

test('buildRecords adds A, PTR and BIMI and groups by importance', () => {
  const recs = buildRecords({ zone: ZONE, domain: 'probe.test', mailHost: 'mail.probe.test', serverIp: '203.0.113.5', bimiUrl: 'https://app.example/bimi/probe.test.svg' });
  assert.equal(recs[0].type, 'A'); assert.equal(recs[0].value, '203.0.113.5');
  assert.equal(recs[1].type, 'PTR');
  assert.ok(recs.some((r) => r.type === 'TXT' && r.value.startsWith('v=BIMI1; l=https://app.example/bimi/probe.test.svg')));
  const groups = recs.map((r) => r.group);
  assert.equal(groups.indexOf('recommended') > groups.lastIndexOf('required'), true);
  assert.ok(recs.find((r) => r.value.startsWith('v=DMARC1'))!.purpose.includes('BIMI'));
});

test('sanitizeSvg accepts clean logos and rejects unsafe ones', () => {
  const ok = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>');
  assert.ok(ok.ok && ok.svg.includes('baseProfile="tiny-ps"') && ok.svg.includes('<title>'));
  assert.equal(sanitizeSvg('<svg><script>alert(1)</script></svg>').ok, false);
  assert.equal(sanitizeSvg('<svg><image href="https://x/y.png"/></svg>').ok, false);
  assert.equal(sanitizeSvg('<svg><a href="https://x"/></svg>').ok, false);
  assert.equal(sanitizeSvg('<div>no</div>').ok, false);
  assert.equal(sanitizeSvg('<svg><rect onclick="x"/></svg>').ok, false);
});

test('generateDefaultSvg is a valid tiny-ps document with escaped text', () => {
  const svg = generateDefaultSvg({ initials: 'a<b', color: '#ffffff', bg: '#123456', name: 'Acme & Co' });
  assert.ok(svg.includes('baseProfile="tiny-ps"'));
  assert.ok(svg.includes('A&lt;B'));
  assert.ok(svg.includes('<title>Acme &amp; Co</title>'));
  assert.ok(sanitizeSvg(svg).ok);
});
