# What Tern stores, and for how long

Tern is a client for a mailbox that lives somewhere else. Everything below is
about Tern's own database; the mail server (Fastmail, Stalwart or another
JMAP host) keeps the mail itself under its own rules.

## Never stored

- **IP addresses.** No access log in the app, no address column anywhere.
  Caddy's access log is off. The sign-in throttle keeps a 15-minute in-memory
  counter keyed by a SHA-256 of `username|address`, never the address.
- **Passwords** in clear. Logins are scrypt hashes; mailbox passwords and API
  tokens are AES-256-GCM ciphertext under `ENCRYPTION_KEY` from `.env`,
  never under a key that is in the database.
- **Attachment metadata.** Photos and videos are stripped of EXIF, XMP, ICC,
  IPTC, comments, thumbnails and video `udta`/`meta` boxes when uploaded,
  and again on the way out for forwarded files. See `services/scrub.ts`.
- **Message bodies in logs.** Log lines carry ids, never subjects, addresses
  or text.
- **Anything sent to a third party.** The AI model runs on the same box
  (or wherever the admin pointed the OpenAI-compatible endpoint; that is the
  admin's choice and is shown on the AI settings page).

## Stored, and why

| Data | Why | Kept |
|---|---|---|
| Users: username, display name, role, scrypt hash, TOTP secret, hashed recovery codes, appearance prefs, avatar | Sign-in | Until the user deletes the account |
| Sessions: random id, created, last seen, user agent | Session list, "sign out everywhere" (other sessions are shown by a hash of the id, never the id) | Until expiry (30 days) or revocation; expired rows purged hourly |
| Accounts: mailbox address, JMAP URLs, encrypted credential, sending policy, signature, voice | Sync and send | Until removed |
| Mail cache (`emails`, `mailboxes`): headers, addresses, subject, body, attachment metadata, keywords. Content is encrypted at rest under your own data key; mailbox ids, keywords, dates and threading headers are not | The inbox, search, threading, reply detection, rules, responders | Newest N messages per account (`sync_limit`); anything left in Trash or Junk past the mailbox's window (30 days by default) is destroyed there and on the mail server; deleted with the account |
| Contacts, suppressions, templates, sequences, enrollments, rules, responders | The outreach features | Until deleted by the user |
| `send_log`: recipient, subject, Message-ID, outcome | Daily caps, reply and bounce matching, statistics | Until the account is removed |
| `drafts`, `outbox` | Unsent mail. Both are encrypted at rest like the cache | Drafts until discarded; sent or cancelled outbox rows purged after 7 days |
| Passkeys (`webauthn_credentials`): public key, credential id, a name, when it was last used | Signing in | Until you remove the passkey, or the account is deleted |
| `uploads` | Attachments staged for a message being written | Deleted on send; orphans purged after 24 hours |
| `review_queue`, `ai_jobs` | AI review and responder runs | Decided or finished rows purged after 30 days |
| `audit_log`: who did which admin or security action, when; successful and failed sign-ins with the method and the client name (never an address) | Accountability; spotting someone guessing at an account | 365 days; a deleted user's rows keep the action but lose details |
| `invites` | Registration links | Purged 30 days after use or expiry |
| Brand logos | BIMI | Until removed by an admin |
| `vacation_replies`: per mailbox, the addresses that received the out-of-office reply and when | So each person is answered once per interval | Until the account is removed |
| OpenPGP keys: your public key, your private key passphrase-protected and wrapped with the server key, other people's public keys | Encrypting mail, sign-in with the key | Until you remove them |

Retention runs from the scheduler once an hour (`workers/scheduler.ts`,
`housekeeping`).

## What each person can do

- **Export**: Settings → Security → *Export my data* streams one JSON file with
  every row above that belongs to them, including the cached mail. Secrets
  are left out.
- **Delete**: Settings → Security → *Delete my account* removes the login and,
  through foreign keys, every row that belongs to it. It asks for the
  password, the two-factor code when enabled, and the username typed out.
  The last remaining admin cannot delete themselves.

## What an admin can see

Admins manage users (names, roles, 2FA on/off, last sign-in), invites, the
audit log, app-wide settings, the AI model and the bundled mail server. They
do not see other people's mail, contacts, sequences or drafts in Tern. The
Stalwart admin panel, for installs that run it, is a separate login with
full access to every mailbox on that server; Tern records in the audit log
each time an admin views that login.

## Encrypted mail

The whole mail cache is encrypted at rest: every subject, body, address list
and attachment name is AES-256-GCM under a data key that belongs to you and
is itself stored only wrapped under the server's `ENCRYPTION_KEY`, which
lives in `.env` and never in the database. A stolen dump or backup is
unreadable without that file. The server still decrypts to work — sync,
search, rules and auto-replies run while you are signed out — so this
protects the copy, not against the operator.

Mail encrypted with OpenPGP additionally stays ciphertext the server cannot
open at all, and is decrypted only in your browser; the server never holds a
usable private key. See [ENCRYPTION.md](ENCRYPTION.md) for what is built and
what remains (sealed accounts, where even sync cannot read a mailbox).
