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
- **Second factor**: TOTP (RFC 6238) with eight single-use recovery codes,
  or an OpenPGP key that answers an encrypted challenge; either can be
  required, and the key can replace the password altogether. A TOTP code is
  accepted once: the time step of the last accepted code is stored, so a code
  seen over a shoulder cannot be replayed inside its window. Enrolling a
  second factor, turning it off, viewing a mailbox password, changing the
  key's sign-in mode, deleting the account and viewing the mail server's
  admin login all ask for the password again.
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

## What is not here (yet)

- **Passkeys / WebAuthn.** The OpenPGP challenge plays the same role
  (something you have, phishing-resistant), but a passkey would be easier
  for most people. Planned.
- **Encryption of the mail cache at rest** beyond disk encryption; see
  ENCRYPTION.md for the design.
- **Automatic emptying of Trash and Junk** after 30 days: destroying mail on
  the server is left to the person, from the folder's "Empty now" button.
- **Drafts synced to the mail server's Drafts folder.** Tern's drafts live
  in Tern; other clients on the same mailbox do not see them.

## Reporting

If you find a problem, open an issue marked security, or write to the
address in the repository's README. Please include the version
(`./bin/tern cli stats` prints it) and the steps to reproduce.
