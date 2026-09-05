# Tern

A self-hosted outreach inbox. Tern is a Gmail-style web client for any JMAP
mailbox (Fastmail, Stalwart, or any other RFC 8620 server) with the tools a
small team needs to run personal outreach honestly: contact lists, templates,
multi-step sequences that stop when someone replies, humanised send timing,
inbox rules, and a drafting assistant that runs on a local language model.

Everything runs in podman containers on one box, down to a 4.5 GB VPS.
Nothing leaves your server except the mail itself.

## What you get

**Mail**
- Unified inbox across accounts, conversation threading, labels, stars, snooze,
  archive, junk, search with operators (`from:`, `subject:`, `is:unread`,
  `has:attachment`, `newer_than:7d`), list filters, right-click menu,
  keyboard shortcuts (`j`/`k`, `e`, `#`, `r`, `c`, `/`, `?`), split or
  full-width reading pane, profile pictures for people and contacts.
- Glassmorphism interface with light, dark and auto themes, eight colour
  palettes and six WebGL2 shader backgrounds; works on phones and desktops.
- Compose with rich text, attachments, contact autocomplete, signatures,
  drafts that autosave, **Schedule send**, and **Send with a natural delay**.
- Remote images blocked by default; HTML mail renders in a sandboxed frame.
- Live updates over JMAP push, so new mail appears without reloading.

**Outreach**
- Contacts with CSV import (column mapping, dedupe, custom merge fields,
  tags, consent source), a suppression list, and a per-contact timeline.
- Templates: a 25-piece starter library, merge fields with fallbacks,
  filters, conditionals and variations, validation, contact-aware preview,
  test-send, import and export.
- Sequences: email and wait steps, same-thread follow-ups, automatic stop on
  reply, bounce detection, one-click unsubscribe with `List-Unsubscribe`.
- Per-account sending policy: daily cap, send window in a timezone, and a
  **toggleable randomised delay** between automated sends.
- Inbox rules that run as mail arrives.

**AI, locally**
- Bundled Ollama container; the installer picks a model that fits the RAM.
- In the composer: draft, reply, rewrite, fix grammar, shorten, expand,
  subject lines. In a thread: one-click AI reply and summarise.
- **AI responders**: answer incoming mail automatically as a suggested draft
  in the thread, through the review queue, or sent without a human in the
  loop, with list and auto-reply detection, per-thread cooldown, daily caps
  and the account's send pacing.
- **AI campaigns**: a brief plus an audience becomes a personalised email
  for every contact, reviewed or automatic, with a same-thread follow-up.
- Sequence steps can be personalised per contact by the model.
- **System prompt and tuning in the UI**: edit the standing instructions,
  temperature, top-p, top-k, repeat penalty, context window and length; a
  playground to try changes; a writing-voice note per account.
- Any OpenAI-compatible endpoint works too.

**Accounts and admin**
- Sign in with username and password, TOTP two-factor with recovery codes,
  session management, audit log. Registration is by invite link, or open
  self-registration if an admin turns it on. No email-based password reset
  by design.
- Sign-in, registration and first-run setup are protected by an adaptive
  browser proof of work instead of IP rate limits or CAPTCHAs: every attempt
  costs the client CPU, and the cost climbs with failed attempts for that
  username and with server-wide load.
- Members see only their own mailboxes, contacts, sequences and settings;
  admins additionally manage users, invites, the app-wide settings and the
  bundled mail server. Admins do not see other people's mail.
- A **Mail apps** tab gives every user the IMAP, SMTP and JMAP details for
  their mailboxes with step-by-step instructions for Thunderbird, Apple Mail,
  iPhone, Outlook, Android and Windows Mail.

**Privacy**
- Photos and videos attached to a message lose their metadata before they
  are stored or sent: EXIF (camera, GPS, time), XMP, IPTC, ICC profiles,
  comments, embedded thumbnails, and the location and device boxes in MP4
  and MOV files. Forwarded attachments are scrubbed too.
- Every user can export everything the server holds about them as one JSON
  file, and delete their account with all of it, from Settings → Security.
- No IP addresses are stored anywhere. Staged attachments, finished AI jobs,
  decided reviews, sent outbox copies and expired sessions are purged on a
  schedule. The full inventory is in [docs/PRIVACY.md](docs/PRIVACY.md);
  the plan for encrypting the mail cache and adding OpenPGP is in
  [docs/ENCRYPTION.md](docs/ENCRYPTION.md).
- AI drafts always open with a greeting to the actual recipient: the
  salutation is checked and corrected after generation, so a small model
  cannot greet the wrong person or invent a name.

**OpenPGP**
- Generate or import a key pair under Settings → Encryption. The private key
  is stored only passphrase-protected and unlocked in your browser; the
  server never has a usable copy.
- Mail to anyone whose public key is on file (contact card, pasted, or found
  through their Web Key Directory and keys.openpgp.org) is encrypted by
  default, and you can sign per message. Sequences and AI responders encrypt
  to contacts with keys too. Encrypted mail you receive is decrypted in the
  browser, with signatures verified against known keys.
- Use the key to sign in: as a second factor after the password, or with no
  password at all. Works from browsers that hold the key, or by decrypting
  the challenge with GnuPG.
- Optional Stalwart mail server on the same box, bootstrapped by the
  installer, with mailbox creation, password resets, a guided DNS setup with
  live verification (A, reverse DNS, MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT,
  autoconfig), BIMI brand logo hosting, and the admin login inside Tern.

## Install

Debian 12/13, Ubuntu 22.04+, Fedora, or anything with podman 4+.

```bash
git clone <this repository> tern
cd tern
sudo ./install.sh
```

The installer walks through domain and TLS, the admin account, the AI model,
and the optional mail server. Run it again any time; it keeps your answers.

Later: `./update.sh` pulls, rebuilds and restarts. `./bin/tern logs app`,
`./bin/tern backup`, `./bin/tern cli list-users`.

Then open the web app and go to **Settings → Accounts → Add account**.

## Documentation

- [docs/SETUP.md](docs/SETUP.md): first run, step by step, and what each installer question means.
- [docs/PROVIDERS.md](docs/PROVIDERS.md): connecting Fastmail, Stalwart (bundled or elsewhere), other JMAP servers; port 25 and reverse DNS.
- [docs/DNS.md](docs/DNS.md): every DNS record for trusted mail, MTA-STS, BIMI logos, and how to verify them.
- [docs/CUSTOMIZING.md](docs/CUSTOMIZING.md): sending policy, sequences, AI models, rules, theming, environment variables.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): logs, common errors, recovery.

## Development

```bash
npm install
podman run -d --name tern-dev-db -p 5480:5432 -e POSTGRES_USER=tern -e POSTGRES_PASSWORD=tern -e POSTGRES_DB=tern docker.io/library/postgres:17-alpine
npm run dev:server     # Express on :3080, migrations run on start
npm run dev:client     # Vite on :5180, proxies /api to :3080
```

Stack: TypeScript everywhere. React 19 + Vite on the client; Express 5,
`pg`, and Node's built-in `crypto` on the server; PostgreSQL 17; Caddy for
TLS; Ollama for the model. The JMAP client is written against the RFCs, not
a vendor SDK.

## A note on sending

Tern is built for low-volume personal outreach from a real mailbox: a few
dozen messages a day, written to people who will recognise the sender. The
randomised delay and send window make automated mail leave the way a person's
would; they do not make unsolicited bulk mail deliverable or lawful. Keep
consent sources on your contacts, keep the unsubscribe footer on, and start a
new mailbox at 20 to 30 sends a day.
