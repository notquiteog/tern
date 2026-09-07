# Security

What protects a Tern install, what it assumes, and what to keep an eye on.
This is the operator's view; the data inventory is in [PRIVACY.md](PRIVACY.md)
and the encryption design in [ENCRYPTION.md](ENCRYPTION.md).

## Threat model

Tern runs on one box you control, behind Caddy, for a small team. The
threats it is built against, in order of how likely they are:

1. **Hostile mail.** Every message is untrusted input: its HTML, its links,
   its attachments, its headers, and anything an AI feature reads out of it.
2. **A stolen or shared session.** A laptop left open, a session cookie
   copied, a phone lost.
3. **Password guessing** against the sign-in form, from many addresses.
4. **A member of the team** who should see only their own mailboxes and
   must not be able to reach the other containers.
5. **The box itself** being read (a backup copied, a disk image taken).

Out of scope: a compromised browser or operating system on the person's
device, a compromised mail provider, and a hostile root user on the server.

## Sign-in

- Passwords are scrypt hashes (N=16384, r=8, p=1, 16-byte salt). The rules:
  at least 10 characters, not on the short list of the most common
  passwords, not a keyboard walk, not containing the username. Enforced for
  setup, registration, admin-created users, password changes and the CLI.
- No email-based password reset, by design. An admin sets a new password
  from Admin → Users or with `./bin/tern cli set-password`; every other
  session of that user is signed out.
- **Proof of work instead of IP rate limits** on sign-in, registration and
  setup: a signed, single-use, purpose- and username-bound SHA-256 challenge
  whose difficulty climbs with recent failures for that username and with
  the global request rate (15 to 22 leading zero bits). A guessing run costs
  the attacker CPU whatever addresses it comes from; a real person waits
  under a second normally. A per-username-and-address counter (hashed, in
  memory, 15 minutes) adds a hard stop after 8 failures.
- One response for "no such user", "wrong password" and "disabled", with the
  same scrypt work in every branch.
- **Second factor**: a passkey, TOTP (RFC 6238) with eight single-use
  recovery codes, or an OpenPGP key that answers an encrypted challenge; any
  one of them passes, and a passkey or the key can replace the password
  altogether. A TOTP code is accepted once: the time step of the last
  accepted code is stored, so a code seen over a shoulder cannot be replayed
  inside its window. Enrolling a second factor, turning it off, viewing a
  mailbox password, changing the key's or the passkey's sign-in mode,
  deleting the account and viewing the mail server's admin login all ask for
  the password again.
- **Passkeys (WebAuthn level 2)**, verified in-process with Node's crypto and
  no third-party library: ES256, EdDSA and RS256, the CBOR and COSE parsing
  written to refuse anything it does not expect. The relying party id and the
  origin come from `APP_URL`, so a passkey made here answers only here and a
  lookalike page cannot borrow it — which is the property a password, a TOTP
  code and a recovery code all lack. Challenges are random, single use and
  five minutes. Attestation is not checked (`attestation: none`): Tern has no
  policy about makes of authenticator, only that the same one answers next
  time. A signature counter that fails to move forward means the credential
  has been copied; that sign-in is refused and the attempt is logged.
  A passkey that verified the person (PIN, fingerprint, face) can be the whole
  sign-in, with no username typed — the authenticator names the account — and
  the exchange therefore reveals nothing about which usernames exist. One that
  only proved presence stays a second step after the password.
- Successful and failed sign-ins are written to the audit log (user, method,
  client; never an address).

## Sessions

- Server-side sessions in Postgres: a 256-bit random id in an `HttpOnly`,
  `SameSite=Lax`, `Secure` cookie. Over HTTPS the cookie is named
  `__Host-tern_sid`, so no subdomain or plain-http origin can plant one.
- Thirty days, absolute. Disabling a user, a password change or "sign out
  everywhere else" takes effect on the next request.
- The session list shows other devices by a hash of their token; the token
  itself is never sent back to the browser.
- Every state-changing API call must carry `X-Requested-With: tern`, which a
  cross-site form cannot add, so there is no CSRF token to rotate.
- Signing out clears the in-memory data cache in the browser and locks the
  unlocked OpenPGP key.

## Hostile mail

- **HTML mail renders in a sandboxed `<iframe>`** (`sandbox="allow-same-origin"`,
  no scripts, no forms, no popups) with its own Content-Security-Policy:
  no scripts, no fonts, no frames, no remote resources until the reader
  clicks "Show images" (or the sender is in their contacts, or was
  allow-listed). DOMPurify runs first and removes scripts, event handlers,
  forms, `<meta>`, `<base>`, `<style>` blocks, SVG and MathML.
- **Links are opened by the app, not by the frame.** A link whose visible
  text names one site and whose address is another (the shape of phishing
  mail) asks before opening and shows where it really goes. Only `http`,
  `https`, `mailto` and `tel` are ever opened, always in a new tab with
  `noopener`.
- **The composer is not a sandbox**, so anything that enters it as HTML (a
  quoted original on reply or forward, a saved draft, a template, a paste)
  goes through a stricter sanitiser profile: on top of the above it drops
  ids, classes, `url()` in inline styles, fixed and absolute positioning,
  media elements and `<details>`; the editor is also paint-contained so
  nothing inside it can overlay the rest of the page.
- Every parsing helper that looks at mail HTML (splitting a draft, taking
  its text, finding the quote) uses an inert `DOMParser` document, so
  nothing loads or runs while the app is merely inspecting markup.
- **Attachments** are served with `X-Content-Type-Options: nosniff`, a
  `Content-Security-Policy: sandbox` and as a download unless the type is a
  raster image, PDF, audio or video; HTML, SVG and text attachments never
  render on the app's origin. Previews open from a `blob:` URL.
- **The page CSP** (`script-src 'self'`, `object-src 'none'`, `base-uri
  'self'`, `form-action 'self'`, `frame-ancestors 'none'`) is the backstop:
  even markup that slipped past a sanitiser cannot run script or post a form
  elsewhere.
- **AI features** see mail as text only. Automated mail (sequence steps,
  auto-replies) is checked for leftover placeholders, prompt text and
  "as an AI" lines before it can leave, and an AI responder's reply quotes
  the original as plain text, never as its HTML.

## Members and the network

- Members see only their own mailboxes, contacts, sequences, drafts and
  settings; every query is scoped by user id. Admins additionally manage
  users, invites, the AI model, branding and the bundled mail server, and
  do not see other people's mail.
- **Outbound requests are guarded.** A JMAP session URL, an SMTP host, a
  push endpoint or a key-directory lookup is resolved first and refused when
  it lands on a loopback, private, link-local, carrier-NAT or multicast
  address or an internal name, and redirects are followed hop by hop under
  the same rule. Without this a member could make the server talk to the
  compose network, where Ollama has no authentication and Postgres and the
  mail server's management API listen. The bundled Stalwart's own origin is
  the one exception; `ALLOW_PRIVATE_NETWORK_HOSTS=true` in `.env` lifts the
  rule for installs whose JMAP server sits on a LAN.
- Expensive endpoints (connection tests, AI drafts, key lookups, uploads,
  data export, push tests) have a per-user rate limit.
- Postgres, Ollama and the app are not published on the host; only Caddy
  (80/443) and, with the mail server, the mail ports are.

## Stored data

- Mailbox passwords and API tokens, SMTP passwords and the OpenAI-compatible
  API key are AES-256-GCM ciphertext under `ENCRYPTION_KEY` from `.env`,
  which is never in the database. Back up `.env` with the database; without
  the key the credentials are unrecoverable.
- **The mail cache is encrypted at rest.** Each person has a random 256-bit
  data key, stored only wrapped under `ENCRYPTION_KEY`. Every message's
  subject, preview, text and HTML bodies, address lists and attachment
  metadata are AES-256-GCM under it, as are drafts and anything queued to
  send. A database dump, a copied backup or a disk image yields ciphertext.
  What stays readable, because the inbox is built from it and it says little:
  mailbox membership, keywords, dates, sizes, and the `Message-ID`,
  `In-Reply-To` and `References` headers that threading and reply detection
  need. What this does not protect against is root on the running box: the
  app decrypts to sync, search and answer mail while nobody is signed in.
  ENCRYPTION.md's layer 3 (sealed accounts) is the answer for anyone who
  wants the server itself out.
- **Search uses a blind index.** A Postgres full-text index over the
  plaintext would have held every word of every message in the clear, so it
  is gone. Searchable words become `HMAC-SHA256(your search key, word)`
  truncated to 12 bytes; a query hashes its words the same way and matches
  opaque terms. Addresses have their own key, so `from:` cannot be confused
  with a body word. The cost, stated plainly: whole-word and prefix matching
  only — no relevance ranking (results are newest first), no stemming, no
  phrase search, and `subject:` behaves as a word search because the index
  does not record which field a term came from. Everything that is not text
  (dates, flags, mailboxes, size, `has:attachment`) is unchanged. Exclusion
  with `-word` still works.
- An install that already had mail encrypts it in the background after the
  upgrade, a batch at a time, and stays usable throughout: a row that has not
  been converted yet is plaintext and is read as such. `./bin/tern cli
  encrypt-cache` does it now instead; `encryption-status` says how far it
  has got. Contacts, templates, the audit log and the send log are not part
  of this and remain plaintext.
- Your private OpenPGP key is stored only in its passphrase-protected form,
  wrapped once more with the server key; the server never has a usable copy.
- Uploaded photos and videos lose their metadata before they are stored.
- No IP addresses anywhere; see PRIVACY.md.
- Postgres runs with data checksums; `./bin/tern backup` dumps the database
  and `.env` into one tarball. Keep backups somewhere else and encrypted.

## Transport and headers

Caddy terminates TLS with Let's Encrypt certificates and sends
`Strict-Transport-Security` for a year. The app adds `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy:
same-origin`, a `Permissions-Policy` that turns off camera, microphone,
geolocation, payment and USB, and the Content-Security-Policy above, on
every response. In production the server never returns internal error
messages to the browser; they go to the log.

## Retention

- **Trash and Junk empty themselves after 30 days**, as they do at Gmail and
  Proton. The window is per mailbox and the whole thing can be turned off in
  Settings → Accounts → Storage & drafts, which also says how many messages
  the next run would remove. Deletion is real: the message goes from the mail
  server as well as from the cache. A message that is also filed somewhere
  else — labelled, or kept in Archive — is never touched, and one sitting in
  both Trash and Junk waits for the longer of the two windows. The clock runs
  from when the message was received, which is what other mail services mean
  by it: **on the first run after upgrading, mail that has sat in Trash or
  Junk for over a month is destroyed.**
- Everything else is a setting under **Admin → Retention**, and every default
  is the shortest the feature still works with rather than a round number:
  staged attachments a day, sent outbox copies two days, decided reviews a
  week, finished AI jobs twelve hours, briefs a week, closed commitments a
  fortnight, past invitations two months, audit entries ninety days.
- The two rows that hold mail content have their content emptied when they
  stop being needed rather than when the row expires. An AI job's payload —
  the copy of the message the model was asked about — is cleared the moment
  the job leaves `running`, so there is no window in which a finished job is
  holding somebody's mail.

## Consent, and the work guard

Nothing that reads a mailbox for a purpose other than showing it to its owner,
and nothing that reaches the model, runs without two switches being open: the
person's own consent (Settings → Features, off for a new account) and the
install's (Admin → Features, which an administrator can close at any time).
See PRIVACY.md for what each one holds and what turning it off erases.

The enforcement is worth stating precisely, because "we audited the call
sites" is a claim that stops being true the day after the audit:

- `openEmail`/`openEmails` take a required `reader` — `'owner'` or a named
  capability. `chat`/`chatStream`/`embed` take a required `consent`. A path
  that forgets to ask does not compile.
- `services/capabilities.test.ts` walks the source afterwards for the hole
  the type system cannot close: `dataKey` plus `openEmailWith` will open a
  mailbox with no questions asked, because the list renderer and the backfill
  legitimately need exactly that. Those files are allow-listed by name, so
  adding one is a deliberate act with a reviewer attached.
- `e2e/features.e2e.ts` drives it against a real database: does the gate
  refuse before consent, does an admin switch overrule consent, does revoking
  erase, can one account's search reach another's mail.

### Expensive requests are priced, not counted

Generation, embedding a mailbox, transcription and importing an archive all
carry a **proof of work** as well as a capability, in addition to the sign-in
proof of work that was already there. A counter says "you have had your forty
this minute" and then refuses, which punishes the person working quickly
through their inbox exactly as hard as the script hammering the box. Work is
a dial instead: the first requests in a window cost a few hundred hashes —
under a millisecond, invisible — and the price doubles per request after
that, and again with how many generations are already in flight. A person
notices nothing; a loop pays quadratically for its own enthusiasm.

The challenge is signed, single use, short-lived, and bound to the session as
well as the purpose, so it cannot be pre-computed, shared between people, or
replayed. `services/workGuard.ts`.

## Recovering the master key

Everything in the mail cache is encrypted under `ENCRYPTION_KEY` from `.env`.
Losing that file has always meant losing every cached message, every stored
mailbox password and every index — "no password reset by design" turns one
lost file into a destroyed archive.

Admin → Security can now split that key with Shamir's scheme over GF(256):
`n` shares, any `k` of which rebuild it, and any `k-1` of which reveal
*nothing at all* — that is the theorem, not a difficulty argument. The shares
are displayed once, meant to be printed, and never stored. What the database
keeps is how many exist, when they were made, a fingerprint per share so a
recovery tool can say "that is share 3 again", and a check value that
recognises the right key without being it.

Recovery is a CLI command rather than a page, because the situation it exists
for is one where nothing decrypts and so nobody can sign in to ask:

```
./bin/tern recover-key
```

It reads shares from the terminal, prints the `ENCRYPTION_KEY` line for
`.env`, and — if the database happens to be reachable — says whether it
matches the key this install recorded.

## What is running

Admin → Security also lists the image each container actually started from
and whether any has changed since an administrator last pinned the set. Every
other claim on this page is a claim about code; an operator should be able to
check which code without taking it on faith.

## Drafts

Drafts are written in Tern and mirrored into the mailbox's own Drafts folder
a moment after typing stops, so Thunderbird, Apple Mail or the provider's
webmail show them; sending or deleting removes the copy there. The mirror is
hidden from Tern's own lists so a draft is never shown twice. Editing is
one-way: a draft written in another client is visible but is not editable
here. Per mailbox, and switchable off.

## What is not here (yet)

- **Sealed accounts**, where even the operator cannot read a mailbox because
  sync encrypts to your OpenPGP key on arrival. This is layer 3 in
  ENCRYPTION.md; it turns off search, rules, AI and reply detection for that
  account, which is why it is a choice rather than the default.
- **Encryption at rest for contacts, templates, the audit log and the send
  log.** The mail cache is covered; these are not.
- **Meaning search is sealed, not end-to-end.** The keyed projection means
  somebody with the database alone has an unlabelled point cloud with no axis
  to hold on to. Somebody with the database *and* the server master key can
  re-derive the rotation and do what the app does — compare. They still
  cannot read text back out of the index, because a quarter of the
  coordinates were thrown away on purpose, but the honest claim is "the index
  is sealed the way the mail is", not anything stronger.
- **Reading inside attachments means parsing hostile files.** The parsers are
  written here rather than pulled in, bounded on input size, output size,
  entry count, nesting depth and expansion ratio, and a parser that throws
  produces "no text" rather than an incident. That is a smaller surface than
  a dependency, not no surface.
- **Two-way draft sync.** Drafts written in another client are shown but not
  editable in Tern.

## Reporting

If you find a problem, open an issue marked security, or write to the
address in the repository's README. Please include the version
(`./bin/tern cli stats` prints it) and the steps to reproduce.
