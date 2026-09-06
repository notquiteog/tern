// The vault's cryptography, driven through the key-taking half so nothing
// here needs a database. The userId wrappers are one line each over these.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressKey, addressQueryWith, addressTermsWith, indexTermsWith, isSealed, openWith,
  queryTermGroupsWith, searchKey, sealWith, termsOverlap, tokenize,
} from './vault.js';

const DEK = Buffer.alloc(32, 9);
const OTHER = Buffer.alloc(32, 4);
const SK = searchKey(DEK);
const AK = addressKey(DEK);

const matchesAll = (indexed: string, queried: string) => {
  const terms = indexTermsWith(SK, indexed);
  const groups = queryTermGroupsWith(SK, queried);
  return groups.length > 0 && groups.every((g) => termsOverlap(terms, g));
};

// ---------- Tokenising ----------

test('tokenising lowercases, splits and drops punctuation', () => {
  const t = tokenize('Invoice #1024 — Due FRIDAY, please pay!');
  for (const w of ['invoice', '1024', 'friday', 'please']) assert.ok(t.includes(w), w);
  assert.ok(!t.includes('#1024'));
});

test('one-character words are not indexed', () => {
  assert.deepEqual(tokenize('a I x'), []);
});

test('an address is findable by its parts', () => {
  const t = tokenize('write to ana.silva@corp.example today');
  for (const w of ['ana.silva@corp.example', 'ana', 'silva', 'corp', 'example']) assert.ok(t.includes(w), w);
});

test('unicode is normalised so composed and decomposed forms agree', () => {
  assert.deepEqual(tokenize('café'), tokenize('café'));
});

test('a pathological token does not enter the index', () => {
  assert.deepEqual(tokenize('x'.repeat(200)), []);
});

test('the token set is capped', () => {
  const many = Array.from({ length: 9000 }, (_, i) => `word${i}`).join(' ');
  assert.ok(tokenize(many).length <= 4200);
});

// ---------- Blind index ----------

test('an exact word is found', () => {
  assert.equal(matchesAll('the quarterly invoice is attached', 'invoice'), true);
});

test('a short exact word is found: the prefix bucket must not shadow it', () => {
  assert.equal(matchesAll('the cat sat', 'cat'), true);
});

test('a word of exactly a bucket length is found', () => {
  // A bucket is only written when the word is *longer* than it, so a word of
  // exactly 3, 5 or 8 characters has to match on its exact hash.
  assert.equal(matchesAll('the fox ran', 'fox'), true);           // 3
  assert.equal(matchesAll('hello there', 'hello'), true);         // 5
  assert.equal(matchesAll('shipping confirmed', 'shipping'), true); // 8
});

test('a prefix finds the longer word', () => {
  assert.equal(matchesAll('the quarterly invoice is attached', 'invo'), true);
  assert.equal(matchesAll('shipping confirmed', 'shippin'), true);
  assert.equal(matchesAll('reimbursement approved', 'reimburse'), true);
});

test('an unrelated word does not match', () => {
  assert.equal(matchesAll('the quarterly invoice is attached', 'refund'), false);
});

test('two words mean both, not either', () => {
  assert.equal(matchesAll('quarterly invoice attached', 'invoice quarterly'), true);
  assert.equal(matchesAll('quarterly invoice attached', 'invoice refund'), false);
});

test('search is case-insensitive', () => {
  assert.equal(matchesAll('URGENT: Invoice', 'invoice urgent'), true);
});

test('a term reveals nothing of its word', () => {
  for (const t of indexTermsWith(SK, 'invoice')) {
    assert.equal(t.length, 12);
    assert.ok(!t.toString('latin1').includes('invo'));
  }
});

test('two users hash the same word differently', () => {
  const mine = indexTermsWith(SK, 'invoice');
  const theirs = indexTermsWith(searchKey(OTHER), 'invoice');
  assert.equal(termsOverlap(mine, theirs), false);
});

test('a body term and an address term never collide', () => {
  assert.equal(termsOverlap(indexTermsWith(SK, 'example'), addressTermsWith(AK, ['ana@example.com'])), false);
});

test('an address is found whole, by domain and by local part', () => {
  const terms = addressTermsWith(AK, ['Ana.Silva@Corp.Example']);
  for (const needle of ['ana.silva@corp.example', 'corp.example', 'ana.silva']) {
    assert.equal(termsOverlap(terms, addressQueryWith(AK, needle)), true, needle);
  }
});

test('one address at a domain does not answer for another', () => {
  const terms = addressTermsWith(AK, ['ana@corp.example']);
  assert.equal(termsOverlap(terms, addressQueryWith(AK, 'bob@corp.example')), false);
});

test('but a bare domain still finds everyone at it', () => {
  for (const who of ['ana@corp.example', 'bob@corp.example']) {
    assert.equal(termsOverlap(addressTermsWith(AK, [who]), addressQueryWith(AK, 'corp.example')), true, who);
  }
});

test('address matching is case-insensitive and trimmed', () => {
  const terms = addressTermsWith(AK, ['ana@corp.example']);
  assert.equal(termsOverlap(terms, addressQueryWith(AK, '  ANA@Corp.Example ')), true);
});

// ---------- Sealing ----------

test('a sealed value round-trips and is not readable in store', () => {
  const sealed = sealWith(DEK, 'the quarterly invoice');
  assert.ok(sealed!.startsWith('k1.'));
  assert.ok(!sealed!.includes('invoice'));
  assert.equal(openWith(DEK, sealed), 'the quarterly invoice');
});

test('the wrong key does not open it', () => {
  assert.equal(openWith(OTHER, sealWith(DEK, 'secret')), null);
});

test('plaintext left over from before the migration still reads', () => {
  assert.equal(openWith(DEK, 'a plain old subject'), 'a plain old subject');
  assert.equal(isSealed('a plain old subject'), false);
});

test('null passes through untouched', () => {
  assert.equal(sealWith(DEK, null), null);
  assert.equal(openWith(DEK, null), null);
});

test('empty string seals and opens as empty, not as null', () => {
  const sealed = sealWith(DEK, '');
  assert.ok(isSealed(sealed));
  assert.equal(openWith(DEK, sealed), '');
});

test('a tampered ciphertext does not open', () => {
  const sealed = sealWith(DEK, 'secret')!;
  const flipped = sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A');
  assert.equal(openWith(DEK, flipped), null);
});

test('a truncated ciphertext does not open', () => {
  assert.equal(openWith(DEK, 'k1.short'), null);
  assert.equal(openWith(DEK, 'k1.'), null);
});

test('every sealing of the same text differs', () => {
  assert.notEqual(sealWith(DEK, 'same'), sealWith(DEK, 'same'));
});

test('unicode and long bodies survive the round trip', () => {
  const body = `Ana — café ☕ ${'x'.repeat(50_000)}`;
  assert.equal(openWith(DEK, sealWith(DEK, body)), body);
});
