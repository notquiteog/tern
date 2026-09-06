# Encrypting mail in Tern

Layers 1 (encryption at rest) and 2 (OpenPGP) are built; see "What runs
today" at the end. Layer 3, sealed accounts, remains a design. This document
sets out what "encrypt the emails" can mean for an app like Tern, what each
option protects against, what it costs in features, and the order to build
it in.

## The constraint that shapes everything

Tern is a *client with a server-side brain*. Almost every feature that makes
it more than a webmail reads message content on the server, while the user
is not logged in:

| Feature | Needs to read on the server |
|---|---|
| Sync | writes every new message into the cache |
| Search (`from:`, `is:unread`, full text) | subject, body, addresses |
| Threading, unread counts, labels | headers, keywords |
| Reply and bounce detection for sequences | `In-Reply-To`, `References`, sender, body |
| Inbox rules | headers and body as mail arrives |
| AI responders and AI review | whole thread |
| Sequences that "stop on reply" | inbound mail while nobody is signed in |

If the server cannot read a message, none of those work for it. And the mail
server (Stalwart, Fastmail) holds the plaintext anyway: Tern's cache is a
copy. So there are two different things one might want, and they are not
the same feature:

1. **Protect the copy** so a stolen database dump, a leaked backup or a
   misconfigured Postgres yields nothing readable. Tern can still work
   normally. This is *encryption at rest*.
2. **Keep the server itself out** so that even the box's operator cannot
   read someone's mail. This is *end-to-end*; it turns most of Tern off for
   that account and is only meaningful if the mail server is also out of
   the operator's hands (a separate provider).

The proposal below does 1 for everyone by default and offers 2 as an opt-in
mode per account, plus real OpenPGP for mail on the wire.

## About the "hash the username" fallback

Anything derived from the username alone is not a key. The username is
public (it is in the audit log, the user list, the invite), so anyone with
the database can derive the same value and decrypt. A key has to come from
something the database does not contain: the server's `ENCRYPTION_KEY`
in `.env`, the user's password (which the server sees only at sign-in), or
a key the user holds (PGP). Those are the three roots used below.

## Layer 1: encryption at rest, per user, server-held keys — built

Built as described below, with two deliberate differences from the original
design, both recorded in the sections that follow: the address and
attachment columns became `TEXT` holding sealed JSON rather than staying
`JSONB`, and the blind index is one set of terms per message rather than one
per field, so `subject:` matches a word anywhere in the message. The code is
`server/src/services/vault.ts` (keys, sealing, the blind index),
`mailVault.ts` (which columns, and the terms a message contributes) and
`backfill.ts` (converting an install that already has mail).

**What it protects against.** Database dumps, backups, disk images, a
compromised Postgres role, and one user's data being readable through a
bug in another user's query. It does not protect against someone with root
on the box while the app runs, because the app must decrypt to work.

**Design.**

- Each user gets a random 256-bit **data key (DEK)**, generated at sign-up,
  stored in `users.dek_wrapped` encrypted with the server master key
  (`ENCRYPTION_KEY`, already in `.env`, already used for mailbox
  credentials). Rotating the master key means re-wrapping the DEKs, not
  re-encrypting the mail.
- Every content column becomes ciphertext under the owner's DEK with
  AES-256-GCM (Node `crypto`, no new dependency): `emails.subject`,
  `preview`, `body_text`, `body_html`, `from_addr`, `to_addr`, `cc_addr`,
  `bcc_addr`, `reply_to`, `attachments`; `drafts.*` body and addresses;
  `outbox.payload`; `review_queue.subject/body_html/context`;
  `contacts.notes/fields`; `send_log.subject`; `templates.body_html`.
  Format: `v1.<iv>.<tag>.<ct>` as `crypto.ts` already does.
- **Search** cannot use a `tsvector` over plaintext (the index would leak
  words). Replace it with a **blind index**: for each message, the set of
  `HMAC-SHA256(user_search_key, normalised_token)` values in a `search_terms
  BYTEA[]` column with a GIN index. A query hashes its words the same way
  and matches on `&&`. Exact word match, prefix match by also indexing the
  first 3, 5 and 8 characters of each token, no ranking. `from:`/`to:`
  operators use a blind index of the addresses; `is:unread`,
  `has:attachment`, dates and mailbox membership stay as plain columns
  because they are needed for the inbox itself and reveal little.
- **Generated columns** (`from_email`, `is_unread`, `is_flagged`,
  `search_tsv`) go: `from_email` becomes an HMAC blind index column written
  by sync; the flags are already plain arrays.
- **Reply matching** compares `Message-ID`s, which stay plain (they are
  random tokens with the domain; low sensitivity, essential for threading).
- **Where decryption happens.** A small `services/vault.ts` with
  `encryptFor(userId, text)` / `decryptFor(userId, text)` and a per-process
  LRU of unwrapped DEKs. Sync, the scheduler and the routes call it; the
  browser never sees keys.
- **Migration.** Add columns, encrypt existing rows in batches from the CLI
  (`tern-cli encrypt-cache`), then drop the plaintext columns in a later
  release. Rows are readable throughout because reads try ciphertext first
  and fall back to plaintext until the migration is marked done.
- **Backups** become useless without `.env`. `bin/tern backup` should
  include an explicit warning and offer to write the master key to a
  separate file.

**What shipped, against that design.** The DEK, the wrapping, the
`v1.<iv>.<tag>.<ct>` format (behind a `k1.` prefix that says which key opens
a value) and the blind index are as written. Differences worth knowing:

- The columns that were `JSONB` (`from_addr`, `to_addr`, `cc_addr`,
  `bcc_addr`, `reply_to`, `attachments`, and `outbox.payload`) are now
  `TEXT`. Ciphertext is not JSON, and the queries that used to pick fields
  out of them in SQL — thread participants, attachment names, address
  autocomplete — now open the blob and do that work in JavaScript.
- Prefix terms are the first 3, 5 and 8 characters as planned, and a query
  emits both the exact hash and the one bucket that fits its length. Without
  that pair a word of exactly 3, 5 or 8 characters would never match itself.
- Terms are grouped per word, and the groups are ANDed. A two-word search
  therefore still means both words.
- `-word` exclusion is implemented as a negated overlap, because the
  advanced search form emits it and `websearch_to_tsquery` used to honour it.
- `review_queue` is sealed (subject, body, recipients and the context slice
  of the message being answered). `send_log.subject` is not: the send log is
  looked up by subject, and a random IV per value would make that impossible.
- Contacts keep their own plaintext `tsvector`. Contacts, templates, the
  audit log and the send log are outside this layer.

**Effort.** Roughly two days: vault module, migration, sync writers, the
search rewrite, and tests. It touches every query that reads bodies, so it
is a single focused change rather than something to do piecemeal.

## Layer 2: OpenPGP — built

Users upload a **public key**. From that point:

- **Export bundles** (Settings → Security → Export) can be encrypted to the
  key on the way out, so a data export on a shared machine is safe.
- **The private key never reaches the server.** It is generated or imported
  in the browser, unlocked with a passphrase, and kept in that browser's
  IndexedDB. Everything that needs it (decrypting, signing) happens there.
- **Outgoing mail** to recipients whose public key is known (uploaded per
  contact, or looked up over WKD and keys.openpgp.org) is encrypted, and
  signed **in the browser at compose time**: the server receives finished
  bytes. "Send later" stores those bytes in the outbox and submits them when
  due. A copy is always encrypted to the user's own key too, so the Sent
  folder stays readable. Recipients without a key get plaintext, with a
  clear indicator in the composer.
- **Automated sends** (sequences, responders, campaigns) can be encrypted to
  a recipient's public key, since that needs only public material, but
  **cannot be signed**: nobody's browser is present when the scheduler runs.
  They go out encrypted and unsigned, and the sequence settings say so. A
  server-held *signing subkey* would close that gap at the price of a
  private key on the server; if ever offered, it is a separate, clearly
  labelled opt-in, not part of this design.
- **Incoming PGP mail** is decrypted in the browser. Such messages are
  stored in the cache as received (ciphertext), so search, rules and AI do
  not see them; the thread view shows a lock and decrypts on open. Sync
  still threads them by headers.
- **Fallback for people without keys**: nothing changes for them. There is
  no sensible way to "encrypt to the username"; the at-rest layer is what
  protects their copy.

Library: `openpgp` (OpenPGP.js) on both sides; pure JavaScript, audited,
about 400 KB in the browser bundle, loaded only on pages that need it.

**Effort.** Key management UI and export encryption: a day. Sending
encrypted and decrypting in the browser: two to three days including the
composer indicator and a message view that handles inline and PGP/MIME.

## Layer 3: sealed accounts (opt-in end-to-end) — still a design

A per-account switch: *"Seal this mailbox: only my browser can read it."*
When on:

- Sync encrypts each new message's subject, body and addresses **to the
  user's PGP public key** at the moment it is fetched, and writes only the
  ciphertext plus the plain threading headers.
- The browser decrypts with the private key from IndexedDB, and builds the
  inbox list and search **locally** from a decrypted index held in memory
  for the session.
- Rules, responders, sequence reply detection, AI review and server-side
  search are shown as unavailable for that account, with the reason. Manual
  compose, reply, labels, archive, snooze and sequences *without* stop-on-
  reply still work because they need only headers.
- Losing the private key loses the cache; the mail is still on the mail
  server and a re-sync with a new key rebuilds it.

This is the honest version of "the server never holds unencrypted email".
It is worth offering, but as a choice with its consequences on the label,
not as the default that silently disables half the product.

**Effort.** A week, mostly client work (local index, decrypt-on-render,
graceful degradation of every view for sealed accounts).

## Alternative root for layer 1: the user's password

Instead of wrapping the DEK only with the server key, wrap it **also** with
a key derived from the user's password (scrypt). The server unwraps at
sign-in and keeps the DEK in memory only while sessions exist. This does
protect against an operator reading the database at rest even with `.env`,
but background sync for a signed-out user needs the key, so it comes down
to the same choice as layer 3: either the server keeps a copy of the DEK
(then the password wrap adds little) or features stop when nobody is signed
in. Tern's sequences and responders exist to work while people are away,
so the recommendation is: server-wrapped DEK for everyone (layer 1), PGP
for those who want the server out (layers 2 and 3). Offer a recovery code
for the private key rather than a password-derived wrap.

## Order of work

1. ~~Layer 1, at rest, everyone.~~ Built. The visible change is search:
   whole-word and prefix matching, no ranking, no stemming, no phrases.
2. ~~Layer 2a: public key upload and encrypted export.~~ Built.
3. ~~Layer 2b: PGP on the wire.~~ Built.
4. Layer 3: sealed accounts. Still open.

## What runs today

Settings → Encryption, `server/src/services/pgp.ts`, `routes/pgp.ts`,
`client/src/lib/pgp.ts`, `client/src/lib/mime.ts`.

- **Keys.** Generate a Curve25519 pair in the browser or import either half.
  A private key is stored only passphrase-protected (OpenPGP's own S2K),
  wrapped once more with the server master key, and released only to a fully
  signed-in session; an unprotected import gets a passphrase in the browser
  first. The browser can also remember the locked key locally. The
  passphrase never leaves the browser.
- **Sending.** When every recipient has a key on file (contact card, pasted,
  or found over WKD / keys.openpgp.org) the composer encrypts by default,
  one click to turn off. The server does the encryption (public keys only;
  it already has the plaintext you typed) and always includes your own key so
  Sent stays readable. Signing is per message and happens in the browser:
  the browser builds the MIME part with attachments, signs or signs-and-
  encrypts it, and the server adds only the RFC 3156 envelope.
- **Automated mail.** Sequences have an "encrypt to contacts with keys"
  switch; AI responders and approved AI replies encrypt whenever the
  recipient has a key. None of it is signed, and the UI says so.
- **Reading.** PGP/MIME and inline messages stay ciphertext in the cache and
  are decrypted in the browser on open, with the sender's signature verified
  against their key when one is on file. `multipart/signed` mail is verified
  from the raw message. Search, rules and AI do not see inside encrypted
  messages; threading, labels, snooze and replies work as usual.
- **Sign-in.** The server encrypts a one-time token to the public key; the
  browser decrypts it. As a second factor it runs after the password (an
  authenticator code or recovery code also passes). As passwordless sign-in
  the key and its passphrase are the whole proof. Unknown usernames get a
  decoy challenge, every attempt costs the proof of work, and the challenge
  can be answered with GnuPG for browsers that do not hold the key.
- **Export.** `?pgp=1` streams the data export encrypted to your key.
- **Autocrypt (level 1).** `server/src/services/autocrypt.ts`. Every
  message from a user with a key carries an `Autocrypt` header (address,
  optional `prefer-encrypt=mutual`, a pruned copy of the public key: primary
  key, one user ID, the encryption subkey). Every inbound message updates
  the sender's peer state in `autocrypt_peers` exactly as the spec says:
  the newest header wins, a message without one only refreshes "last
  seen", a key not re-announced for 35 days is "discouraged". Group mail
  that Tern encrypts carries `Autocrypt-Gossip` headers inside the
  protected part; the browser reports the ones it finds after decrypting,
  and the server accepts those for addresses the message was sent to. The
  composer follows the recommendation: encrypt by default only when both
  sides said `mutual`, otherwise the key is one click away; keys learned
  this way can be promoted to normal recipient keys (Settings → Encryption
  → Autocrypt → Use key). The setting has an on/off switch and a "prefer
  encrypted (mutual)" switch per user. Not implemented: the Autocrypt Setup
  Message for moving a key between clients (export the key instead).
- **Post-quantum readiness.** The OpenPGP post-quantum profile
  (draft-ietf-openpgp-pqc: ML-KEM-768 + X25519, ML-DSA-65 + Ed25519, on v6
  keys) is not implemented by OpenPGP.js 6.3, which reserves the algorithm
  ids and nothing more. What Tern does today: `server/src/services/
  pgpPackets.ts` walks the raw packets of every key that is imported,
  looked up or received, so a key with post-quantum subkeys is recognised
  and labelled even though the library skips those packets; mail to such a
  key is encrypted to its classical subkey, which is what every client can
  open. Key generation offers a **Modern (v6, RFC 9580)** format next to
  the compatible v4 one; v6 is what post-quantum subkeys attach to, so a
  v6 key needs no replacing when the library catches up. Settings →
  Encryption → Post-quantum shows where your key and your recipients' keys
  stand.

- **At rest (layer 1).** `server/src/services/vault.ts`, `mailVault.ts`,
  `backfill.ts`. Every user has a data key, wrapped under `ENCRYPTION_KEY`
  and never stored in the clear. Subjects, previews, bodies, address lists
  and attachment metadata on `emails`, the same fields on `drafts`, and the
  whole `outbox` payload are AES-256-GCM under it. Search runs on an HMAC
  blind index with a separate key for addresses. Mailbox membership,
  keywords, dates, sizes and the threading headers stay plain, because the
  inbox is built from them. An install that already had mail converts in the
  background, a batch per scheduler tick, and reads work throughout;
  `./bin/tern cli encrypt-cache` does it immediately and
  `encryption-status` reports progress.
- **Passkeys.** `server/src/services/webauthn.ts` verifies WebAuthn
  registration and assertions with Node's crypto alone — its own CBOR and
  COSE readers, ES256/EdDSA/RS256, origin and relying-party checks bound to
  `APP_URL`, single-use challenges, and a clone check on the signature
  counter. A verifying passkey can replace the password; a
  presence-only one is a second factor.

Still open from the plan: layer 3 (sealed accounts).
