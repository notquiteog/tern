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
  archive, junk, mute, search with operators (`from:`, `subject:`, `is:unread`,
  `has:attachment`, `newer_than:7d`, `-word`) and a search-options panel,
  list filters, date groups, select by read/unread/starred, right-click menu,
  drag conversations onto labels and folders, keyboard shortcuts (`j`/`k`,
  `e`, `#`, `r`, `a`, `f`, `c`, `/`, `?`, `]`/`[`), a reading pane beside or
  below the list or off, profile pictures for people and contacts, and
  **Undo** on every archive, delete, junk, snooze, label and move.
- Gmail-style conversations: reply, reply all and forward open **inline** at
  the bottom of the thread (pop out to a window any time), the quoted
  original folds behind a "…" button in both received mail and your reply,
  per-message star, expand and collapse all, newer/older conversation
  arrows, block sender, find messages from this sender, one-click
  **Unsubscribe** for list mail, attachment previews in a lightbox, print,
  and drafts shown in the conversation they belong to.
- Clean, modern interface (monochrome "Ink" over a barely moving "Mist" by
  default) with light, dark and auto themes, eighteen colour palettes and
  fifteen WebGL2 shader backgrounds that follow the cursor, warm and cool
  with the hour, and pick up the colour of the category being read; works on
  phones and desktops.
- Two ways to read a list: the dense **List** view, or **Cards** with room
  for the summary, the people and the attachments. On a phone, swipe a
  conversation right to archive it or left to delete it.
- Everything the list can tell you about a sender at a glance: a **verified
  brand** tick where the domain publishes a BIMI logo and passes DMARC, a
  lock on end-to-end encrypted threads, and a shield on bulk mail whose
  remote images and tracking pixels are held back.
- **Optional, all off until you ask for them:** smart categories (Primary,
  Transactions, Updates, Promotions, worked out from the headers as mail
  arrives — never from a model, and never for someone in your contacts),
  stacking a run of messages from one sender into one row, and a one-line
  **AI summary** above each conversation.
- The search box is an omnibox: every operator you type becomes a chip you
  can take off one at a time, and Backspace in an empty box removes the last.
- Settings split in two: **Settings** is about you (profile, mailboxes,
  mail apps, appearance, security, encryption); **Admin** is the workspace
  (users and sign-up, the mail server, the AI model, branding, audit log).
- With the bundled mail server, every new login gets
  `username@your-domain` created and connected automatically; an address
  that already exists on the server cannot be claimed. People can show or
  reset their own mailbox password under Settings → Mail apps to set up
  Thunderbird, a phone, or any JMAP client.
- Compose with rich text (sizes, colours, alignment, lists, indent, links,
  emoji), inline images that go out as proper `cid:` parts, attachment cards
  with thumbnails, forwarded attachments you can drop before sending, your
  signature visible in the editor, contact autocomplete, templates, drafts
  that autosave, `Ctrl+Enter` to send, a "did you forget the attachment?"
  check, **Undo send** (0 to 30 seconds), **Send and archive**, **Schedule
  send**, and **Send with a natural delay**.
- Remote images blocked by default, with "always show from this sender" and
  automatic display for people in your contacts; HTML mail renders in a
  sandboxed frame, and a link whose text names one site but leads to
  another asks before it opens.
- A **burner address** gets its own place in the sidebar, directly under
  Inbox: everything that arrived at the masked address, with its own unread
  count. Recipients are encrypted at rest, so it is matched on the blind
  index and only ever on the exact address.
- **Out-of-office auto-reply** per mailbox: a message, an optional date
  range, once per sender per interval, never to lists or other robots.
- Live updates over JMAP push, so new mail appears without reloading; the
  tab title carries the unread count.

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
- A hard filter in front of every automated send: a responder in send mode
  or a sequence step that still contains a merge field, a placeholder such
  as "[Your Name]", echoed prompt text or an "as an AI" line is held in the
  review queue instead of being sent.
- In the composer: draft, reply, rewrite, fix grammar, shorten, expand,
  subject lines. In a thread: one-click AI reply (written inline, addressed
  to the right person), **Quick replies** (three one-line suggestions to pick
  from) and summarise.
- **AI responders**: answer incoming mail automatically as a suggested draft
  in the thread, through the review queue, or sent without a human in the
  loop, with list and auto-reply detection, per-thread cooldown, daily caps
  and the account's send pacing.
- **AI campaigns**: a brief plus an audience becomes a personalised email
  for every contact, reviewed or automatic, with a same-thread follow-up.
- Sequence steps can be personalised per contact by the model.
- **System prompt and tuning in the UI**: edit the standing instructions,
  temperature, top-p, top-k, min-p, repeat penalty, context window and
  length; a playground to try changes; a writing-voice note per account.
- **Long threads stay in one piece**: the conversation handed to the model is
  packed to fit its context window from both ends — the newest messages and
  the opening ones, where the dates and figures were agreed — so a reply
  twenty messages deep still quotes what was actually said.
- **Reasoning models** (qwen3, deepseek-r1) are supported: the working-out
  is streamed into the page while it happens — in the composer, a thread
  summary, quick replies, templates and the admin playground alike — so a
  slow generation shows its progress rather than a spinner; it never reaches
  a draft, it is paid for out of its own budget so it cannot leave the email
  empty, and a model that spends it all is asked again without it rather than
  failing. Admin → AI model says whether the chosen model can reason at all,
  because turning the setting on for one that cannot is the usual reason no
  working-out appears. One-line inbox summaries never think, whatever the
  setting says: they are not worth a reasoning budget.
- **One model at a time.** Choosing a different model unloads the previous
  one instead of leaving it to time out beside its replacement, which on a
  4.5 GB box is the difference between working and being killed. Changing
  "keep model loaded" reaches the model already in memory, so a `-1` set once
  is no longer permanent. Admin → AI model shows what is resident, what it is
  holding and when it expires, with an **Unload** button, and deleting a
  model frees its memory first and reports a refusal rather than failing
  quietly.
- **Reachable through Tor, as an opt-in toggle.** Off by default and pointless
  for a model on this box; the case it is for is a model on somebody else's
  hardware, which otherwise logs this server's address with every request. It
  also makes an `.onion` model server reachable at all. It changes who learns
  where you are, not what is sent — the same prompt crosses either way, and the
  page still says plainly whether the model is local. With it on, nothing
  resolves or connects to the model host outside the proxy: the certificate
  inspector and the "is this local" probe both stand down, because a
  diagnostic that leaks is still a leak.
- Any OpenAI-compatible endpoint works too, and so does Anthropic's Messages
  API for people who would rather rent the model than run one. Anthropic has
  no embeddings endpoint, so meaning search gets its own server setting there:
  draft on Anthropic, embed on the Ollama that was already running, or leave
  it unset and search falls back to matching words.

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

**Everything below is off until you ask for it**

Every feature that reads a mailbox for a purpose other than showing it to you,
and every feature that reaches the model, is off for a new account. **Settings
→ Features** is one page with one switch each, a sentence saying what is read
and what is kept, and a mark for *reads your mail* and *uses the model*.
Turning one off erases what it made — the index, the scores, the flags, the
extracted text — rather than pausing it. **Admin → Features** is the same list
for the whole install, which is the switch to reach for when the box is
struggling; it takes effect within about twenty seconds and leaves everybody's
own choice alone.

The gate is enforced by the compiler, not by convention: the functions that
decrypt a message and the ones that reach the model all take a required
argument naming who is asking and why, so a path that forgets to ask does not
build. A test then walks the source for the one hole types cannot close.

- **Meaning search.** "Find the thread where we settled the price", answered
  from an index that holds no words. Each message is embedded once and the
  vector is passed through a keyed rotation derived from your own data key
  and then cut from 1024 coordinates to 256 — cosine survives, the axes an
  inversion attack needs do not. Results appear *under* the exact ones, never
  instead of them.
- **Priority ordering.** Learns from what you archive, star, reply to and
  junk, using only the hashed terms already in your encrypted search index —
  no message text is read and no model is involved. It adds one more way to
  sort the list and hides nothing.
- **Impersonation guard.** A display name you know on an address you do not, a
  domain one confusable character from one you correspond with, `Reply-To`
  leaving the domain, and a conversation whose sender changes partway through.
  One calm line naming the specific reason, never a row of badges.
- **Search inside attachments.** PDF, Word, Excel and PowerPoint text, read on
  arrival, sealed beside the message and folded into the same blind index.
- **Commitments.** What you said you would do and what you are waiting on,
  pulled out of your own conversations and closed automatically when the mail
  settles them.
- **The brief.** A page, not a daily notification: it shows what is stored,
  says when it was written and whether the mailbox has moved since, and
  regenerates only when you press the button.
- **Rules and searches in plain English.** A sentence becomes a draft of a
  rule in the ordinary editor. Once you save it, it runs deterministically
  and the model is never involved again.
- **Invitations.** The `text/calendar` part of a message read properly —
  folded lines, escapes, time zones — shown in your own time, with a warning
  when it clashes, and Yes/Maybe/No that sends a real `METHOD:REPLY` and puts
  the meeting in your calendar.
- **Calendar.** Month, week and agenda views over the calendars you already
  use: Google, Outlook, iCloud, Fastmail, Nextcloud or any CalDAV server, plus
  read-only subscriptions to a published `.ics` address. Two-way, with push
  where the provider offers it and cheap incremental polling where it does
  not, full RFC 5545 recurrence (including the wall-clock rule that keeps a
  nine o'clock meeting at nine across a clock change), and events sealed with
  your own key like everything else. What it buys the rest of the app is that
  Tern stops proposing times you are already busy — the composer, the
  invitation card, the assistant and the daily brief all read real free/busy.
  Only *when* you are busy, never what you are doing. See
  [docs/CALENDAR.md](docs/CALENDAR.md).
- **Dictation** (optional container). Speak into any text box. The recording
  never touches disk on either side and the transcript is never stored. The
  transcriber can be the bundled whisper.cpp container or one on another
  machine, set in Admin → AI model with a key and a connection test — as can
  the language model, for a box too small to hold one.
- **Link cleaning.** Tracking parameters stripped from links you are shown and
  links you send, and redirect wrappers unwrapped by reading the destination
  they carry — never by following them.
- **Import an archive.** An mbox — a Takeout export, a Thunderbird folder —
  read into your encrypted cache. Worth doing first: everything above is far
  better on years of mail than on days of it.

**Privacy**
- Photos and videos attached to a message lose their metadata before they
  are stored or sent: EXIF (camera, GPS, time), XMP, IPTC, ICC profiles,
  comments, embedded thumbnails, and the location and device boxes in MP4
  and MOV files. Forwarded attachments are scrubbed too.
- Every user can export everything the server holds about them as one JSON
  file, and delete their account with all of it, from Settings → Security.
- The security design (sign-in, sessions, hostile mail, the network guard,
  the consent gate) is written up in [docs/SECURITY.md](docs/SECURITY.md).
- Generation, embedding, transcription and importing are priced in **proof of
  work** rather than refused by a counter. The first requests in a window
  cost a few hundred hashes and are invisible; the price doubles per request
  after that and again with how busy the model is. A person notices nothing;
  a loop pays for its own enthusiasm.
- **Recovery shares** (Admin → Security) split the master key so that any *k*
  of *n* rebuild it and any fewer reveal nothing at all. They are printed
  once and never stored; `./bin/tern recover-key` puts them back together
  when `.env` is gone. Without them, a lost `ENCRYPTION_KEY` is still a
  destroyed archive.
- **What is running** (Admin → Security) lists the image each container
  actually started from and flags anything that has changed since it was
  pinned. Every privacy claim here is a claim about code; you should be able
  to check which.
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
- [docs/SECURITY.md](docs/SECURITY.md): the threat model and what defends against each part of it.
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
