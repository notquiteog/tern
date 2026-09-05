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
  `has:attachment`, `newer_than:7d`), keyboard shortcuts (`j`/`k`, `e`, `#`,
  `r`, `c`, `/`, `?`), split or full-width reading pane, dark mode.
- Compose with rich text, attachments, contact autocomplete, signatures,
  drafts that autosave, **Schedule send**, and **Send with a natural delay**.
- Remote images blocked by default; HTML mail renders in a sandboxed frame.
- Live updates over JMAP push, so new mail appears without reloading.

**Outreach**
- Contacts with CSV import (column mapping, dedupe, custom merge fields,
  tags, consent source), a suppression list, and a per-contact timeline.
- Templates with merge fields and fallbacks: `{{first_name|there}}`.
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
- Optional Stalwart mail server on the same box, bootstrapped by the installer.

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
- [docs/PROVIDERS.md](docs/PROVIDERS.md): connecting Fastmail, Stalwart (bundled or elsewhere), other JMAP servers; DNS records; port 25 and reverse DNS.
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
