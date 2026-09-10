// The guard, driven through the pure half. The expensive half of the design
// is not the detection, it is the restraint: a check that fires on ordinary
// mail is worse than no check, because people stop reading banners. Most of
// what follows is therefore about what must *not* be flagged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMessage, describe as describeFlags, editDistance, looksLike, parseAuthResults,
  registrable, skeleton, withoutSelf, type GuardKnowledge,
} from './guard.js';

const knowledge = (opts: Partial<GuardKnowledge> = {}): GuardKnowledge => ({
  domains: opts.domains ?? new Map(),
  names: opts.names ?? new Map(),
  addresses: opts.addresses ?? new Set(),
  // How many messages each address sent. Defaults to "seen once" for every
  // known address, which is what the checks below assume when they do not say.
  counts: opts.counts ?? new Map([...(opts.addresses ?? new Set<string>())].map((a) => [a, 1])),
});

const mailbox = knowledge({
  domains: new Map([
    ['corpexample.com', { count: 140, example: 'ana@corpexample.com' }],
    ['bigbank.example', { count: 32, example: 'noreply@bigbank.example' }],
    ['gmail.com', { count: 400, example: 'friend@gmail.com' }],
  ]),
  names: new Map([
    ['ana duarte', { email: 'ana@corpexample.com', count: 88 }],
    ['jo', { email: 'jo@gmail.com', count: 4 }],
  ]),
  addresses: new Set(['ana@corpexample.com', 'friend@gmail.com', 'noreply@bigbank.example', 'jo@gmail.com']),
});

const MINE = new Set(['me@mine.example']);

const check = (input: Partial<Parameters<typeof checkMessage>[0]>, prior: string[] = [], known = mailbox) =>
  checkMessage(
    {
      fromEmail: 'someone@nowhere.example', fromName: null, replyToEmails: [],
      authResults: null, threadId: 't1', accountId: 1, mine: MINE, ...input,
    },
    known,
    { fromEmails: prior },
  );

// ---------- Domain skeletons ----------

test('confusables fold to what they imitate', () => {
  assert.equal(skeleton('corpexamp1e.com'), skeleton('corpexample.com'));
  assert.equal(skeleton('paypa1.com'), 'paypal.com');
  assert.equal(skeleton('rnicrosoft.com'), 'microsoft.com');
  // Cyrillic а, е, о and с in an otherwise Latin word: the classic homograph.
  assert.equal(skeleton('соrpexample.com'), 'corpexample.com');
});

test('hyphens do not make a new domain', () => {
  assert.equal(skeleton('corp-example.com'), skeleton('corpexample.com'));
});

test('the registrable part survives subdomains and two-part suffixes', () => {
  assert.equal(registrable('mail.corpexample.com'), 'corpexample.com');
  assert.equal(registrable('a.b.c.corpexample.co.uk'), 'corpexample.co.uk');
  assert.equal(registrable('corpexample.com'), 'corpexample.com');
});

test('bounded edit distance stops early instead of finishing', () => {
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('corpexample', 'corpexarnple', 2), 2);
  assert.equal(editDistance('short', 'completely-different-string', 2), 3);
});

// ---------- What counts as a lookalike ----------

test('a one-character swap on a domain you know is a lookalike', () => {
  assert.ok(looksLike('corpexamp1e.com', 'corpexample.com'));
  assert.ok(looksLike('corpexarnple.com', 'corpexample.com'));
  assert.ok(looksLike('corp-example.com', 'corpexample.com'));
});

test('the same domain is never a lookalike of itself', () => {
  assert.ok(!looksLike('corpexample.com', 'corpexample.com'));
  assert.ok(!looksLike('mail.corpexample.com', 'corpexample.com'));
});

test('genuinely different domains are left alone', () => {
  for (const [a, b] of [
    ['stripe.com', 'github.com'],
    ['linear.app', 'notion.so'],
    ['someagency.co.uk', 'corpexample.com'],
  ]) assert.ok(!looksLike(a, b), `${a} vs ${b}`);
});

test('short domains need an exact skeleton, not an edit', () => {
  // "bp.com" and "hp.com" are one edit apart and have nothing to do with
  // each other. Every two-letter brand would warn about every other one.
  assert.ok(!looksLike('hp.com', 'bp.com'));
  assert.ok(!looksLike('xero.com', 'zero.com'));
  // But an exact visual collision still counts at any length.
  assert.ok(looksLike('b-p.com', 'bp.com'));
});

// ---------- Authentication-Results ----------

test('authentication results are read, and silence is not failure', () => {
  const pass = parseAuthResults('mx.example; spf=pass smtp.mailfrom=a.com; dkim=pass header.d=a.com; dmarc=pass');
  assert.deepEqual(pass, { dkim: 'pass', spf: 'pass', dmarc: 'pass' });
  const fail = parseAuthResults('mx.example; dkim=fail reason="bad signature"; dmarc=fail');
  assert.equal(fail.dkim, 'fail');
  assert.equal(fail.dmarc, 'fail');
  // A domain that publishes nothing produces "none", which is an absence of
  // evidence and is recorded as one.
  assert.equal(parseAuthResults('mx.example; dmarc=none').dmarc, null);
  assert.deepEqual(parseAuthResults(null), { dkim: null, spf: null, dmarc: null });
  assert.deepEqual(parseAuthResults(''), { dkim: null, spf: null, dmarc: null });
});

// ---------- The checks, in the shape they will actually meet ----------

test('an ordinary message from a known correspondent is not flagged at all', () => {
  const r = check({ fromEmail: 'ana@corpexample.com', fromName: 'Ana Duarte' }, ['ana@corpexample.com']);
  assert.deepEqual(r.flags, []);
});

test('a known name on a new address is caught', () => {
  const r = check({ fromEmail: 'ana.duarte.finance@gmail.com', fromName: 'Ana Duarte' });
  assert.ok(r.flags.includes('display_name_mismatch'));
  assert.equal(r.detail.expected, 'ana@corpexample.com');
  assert.equal(r.detail.actual, 'ana.duarte.finance@gmail.com');
  assert.match(describeFlags(r.flags, r.detail) ?? '', /Ana Duarte/);
});

test('a name we have only seen a couple of times does not accuse anyone', () => {
  // A display name of three characters or fewer is not evidence of anything:
  // there is more than one Jo, and warning about the second one teaches
  // people to ignore the banner.
  const r = check({ fromEmail: 'jo.other@work.example', fromName: 'Jo' });
  assert.ok(!r.flags.includes('display_name_mismatch'));
});

test('a lookalike domain names the domain it is imitating', () => {
  const r = check({ fromEmail: 'billing@corpexamp1e.com', fromName: 'Billing' });
  assert.ok(r.flags.includes('lookalike_domain'));
  assert.equal(r.detail.expected, 'corpexample.com');
  assert.match(describeFlags(r.flags, r.detail) ?? '', /corpexamp1e\.com looks like corpexample\.com/);
});

test('a domain we have barely seen is not something to imitate', () => {
  const sparse = knowledge({ domains: new Map([['corpexample.com', { count: 2, example: 'a@corpexample.com' }]]) });
  const r = check({ fromEmail: 'billing@corpexamp1e.com' }, [], sparse);
  assert.ok(!r.flags.includes('lookalike_domain'), 'two messages is not a relationship');
});

test('a reply-to on another domain is noted, mildly', () => {
  const r = check({ fromEmail: 'ana@corpexample.com', replyToEmails: ['ana.duarte@gmail.com'] }, ['ana@corpexample.com']);
  assert.ok(r.flags.includes('reply_to_offsite'));
  assert.equal(r.flags[0], 'reply_to_offsite', 'nothing worse fired');
});

test('a reply-to on the same registrable domain is normal', () => {
  const r = check({ fromEmail: 'ana@corpexample.com', replyToEmails: ['support@mail.corpexample.com'] }, ['ana@corpexample.com']);
  assert.ok(!r.flags.includes('reply_to_offsite'));
});

test('a conversation that changes hands is the loudest flag', () => {
  const r = check(
    { fromEmail: 'ana@corpexamp1e.com', fromName: 'Ana Duarte' },
    ['ana@corpexample.com', 'me@mine.example', 'ana@corpexample.com'],
  );
  assert.equal(r.flags[0], 'thread_sender_changed');
  assert.equal(r.detail.expected, 'corpexample.com');
  assert.match(describeFlags(r.flags, r.detail) ?? '', /Check before replying/);
});

test('a third party joining a group thread is not a hijack', () => {
  // Two other domains already in the conversation, and the new one resembles
  // neither: that is a meeting, not an impersonation.
  const r = check(
    { fromEmail: 'lawyer@ext-counsel.example' },
    ['ana@corpexample.com', 'sam@agency.example'],
  );
  assert.ok(!r.flags.includes('thread_sender_changed'));
});

test('our own mail is never flagged', () => {
  const r = check({ fromEmail: 'me@mine.example', fromName: 'Ana Duarte' }, ['ana@corpexample.com']);
  assert.deepEqual(r.flags, []);
});

test('failed authentication only counts for a domain we know', () => {
  const known = check({ fromEmail: 'ana@corpexample.com', authResults: 'mx; dmarc=fail' }, ['ana@corpexample.com']);
  assert.ok(known.flags.includes('unauthenticated'));
  const stranger = check({ fromEmail: 'x@never-heard-of.example', authResults: 'mx; dmarc=fail' });
  assert.ok(!stranger.flags.includes('unauthenticated'), 'a stranger failing DMARC is noise');
});

test('first contact is recorded but says nothing out loud', () => {
  const r = check({ fromEmail: 'new@stranger.example' });
  assert.deepEqual(r.flags, ['first_contact']);
  assert.equal(describeFlags(r.flags, r.detail), null, 'no banner for meeting someone');
});

test('flags come back worst first', () => {
  const r = check(
    { fromEmail: 'ana@corpexamp1e.com', fromName: 'Ana Duarte', replyToEmails: ['pay@elsewhere.example'] },
    ['ana@corpexample.com'],
  );
  const severities = r.flags.map((f) => ({ thread_sender_changed: 5, lookalike_domain: 4, display_name_mismatch: 3, reply_to_offsite: 2, unauthenticated: 1, first_contact: 0 })[f]);
  assert.deepEqual(severities, [...severities].sort((a, b) => b - a));
});

// ---------- A message must not vouch for itself, and the archive must count ----------
//
// These two pull in opposite directions and both matter. The guard used to
// satisfy the first by excluding the whole batch under test from what the
// mailbox "knows" — correct while mail trickles in, and catastrophic on an
// import, where the batch IS the mailbox: the knowledge came back empty, every
// message read as first contact, and the lookalike-domain check could not fire
// because it had no relationship to compare against. `withoutSelf` subtracts
// one message instead of the whole batch.

const archive = (): GuardKnowledge => knowledge({
  domains: new Map([
    ['meridian-logistics.example', { count: 3, example: 'dana@meridian-logistics.example' }],
    ['northwind-design.example', { count: 1, example: 'priya@northwind-design.example' }],
  ]),
  names: new Map([['dana okafor', { email: 'dana@meridian-logistics.example', count: 3 }]]),
  addresses: new Set(['dana@meridian-logistics.example', 'priya@northwind-design.example']),
  counts: new Map([['dana@meridian-logistics.example', 3], ['priya@northwind-design.example', 1]]),
});

const from = (email: string, name: string | null = null) => ({
  fromEmail: email, fromName: name, replyToEmails: [], authResults: null,
  threadId: 't', accountId: 1, mine: new Set(['alex@perchconsulting.example']),
});

test('a lookalike domain is caught when the real one is only in the same import', () => {
  // The regression this exists for. Both domains arrive in one mbox; the
  // impostor must still be recognised against the genuine correspondent.
  const known = withoutSelf(archive(), 'dana@meridian-iogistics.example');
  const { flags, detail } = checkMessage(from('dana@meridian-iogistics.example', 'Dana Okafor'), known, { fromEmails: [] });
  assert.ok(flags.includes('lookalike_domain'), `expected a lookalike flag, got ${flags.join(',')}`);
  assert.equal(detail.expected, 'meridian-logistics.example');
  assert.equal(detail.actual, 'meridian-iogistics.example');
});

test('the sender of the message being checked does not count as having met them', () => {
  // Priya has written exactly once, and that once is the message under test.
  const known = withoutSelf(archive(), 'priya@northwind-design.example', 'Priya Raman');
  assert.ok(!known.addresses.has('priya@northwind-design.example'));
  assert.ok(!known.domains.has('northwind-design.example'), 'her only message should not establish her domain');
  const { flags } = checkMessage(from('priya@northwind-design.example', 'Priya Raman'), known, { fromEmails: [] });
  assert.ok(flags.includes('first_contact'));
});

test('a sender with a history keeps it when one of their messages is checked', () => {
  // Dana has written three times. Checking one of them must not turn her into
  // a stranger, or every message from a regular correspondent reads as first
  // contact the moment it is examined.
  const known = withoutSelf(archive(), 'dana@meridian-logistics.example', 'Dana Okafor');
  assert.ok(known.addresses.has('dana@meridian-logistics.example'));
  assert.equal(known.domains.get('meridian-logistics.example')?.count, 2);
  const { flags } = checkMessage(from('dana@meridian-logistics.example', 'Dana Okafor'), known, { fromEmails: [] });
  assert.ok(!flags.includes('first_contact'), `should know her, got ${flags.join(',')}`);
});

test('a display name on the wrong address survives the subtraction', () => {
  const known = withoutSelf(archive(), 'dana.okafor.finance@webmail.example', 'Dana Okafor');
  const { flags, detail } = checkMessage(from('dana.okafor.finance@webmail.example', 'Dana Okafor'), known, { fromEmails: [] });
  assert.ok(flags.includes('display_name_mismatch'), flags.join(','));
  assert.equal(detail.expected, 'dana@meridian-logistics.example');
});

test('a lookalike domain with an off-site reply-to names both, and names them right', () => {
  // The ordinary shape of an invoice redirection: a domain one character out,
  // and a Reply-To pointing somewhere else again. The two flags share one
  // detail object, and the Reply-To used to overwrite the impostor domain — so
  // the banner named the reply-to address as the thing that "looks like" the
  // real domain, which is the wrong string on the one screen where the right
  // string is the whole point.
  const known = withoutSelf(archive(), 'dana@meridian-iogistics.example');
  const { flags, detail } = checkMessage(
    { ...from('dana@meridian-iogistics.example', 'Dana Okafor'), replyToEmails: ['accounts@secure-remit-desk.example'] },
    known, { fromEmails: [] },
  );
  assert.ok(flags.includes('lookalike_domain') && flags.includes('reply_to_offsite'), flags.join(','));
  assert.equal(detail.actual, 'meridian-iogistics.example', 'the impostor domain must survive');
  assert.equal(detail.replyTo, 'accounts@secure-remit-desk.example');
  const line = describeFlags(flags, detail)!;
  assert.match(line, /^meridian-iogistics\.example looks like meridian-logistics\.example/);
  assert.match(line, /A reply would go to accounts@secure-remit-desk\.example\./);
});
