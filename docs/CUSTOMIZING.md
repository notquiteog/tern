# Customising Tern

## Sending policy (per account)

Settings → Accounts → Edit → **Sending policy**.

| Setting | Meaning | Default |
|---|---|---|
| Daily cap | Automated sends per local day. Manual sends never count against it or wait for it. | 40 |
| Send window | Hours, days and timezone during which sequences and delayed sends may go out. Outside it, sends queue until it opens. | 09:00–17:00, Mon–Fri, UTC |
| Randomised delay | On/off. Each automated send waits a random gap between the minimum and maximum before leaving. The gap is enforced per account, so two sequences sharing a mailbox never fire together. | on, 45–240 s |
| Enabled | Pause syncing and sending for the account without removing it. | on |

How it fits together: a sequence step becomes due, the scheduler checks the
window, the cap, and whether the previous send's gap has elapsed. If all pass
it sends and schedules the next gap. If not, it retries at the earliest time
the failing check can pass. "Send with a natural delay" from the composer
takes the same path.

## Sequences

- **Steps**: any mix of email and wait steps. Emails can use a template or
  their own content. A follow-up with "same thread" on is sent as a reply to
  the previous message, with `Re:` and proper threading headers.
- **Stop on reply**: a reply from the contact ends their enrollment. Detected
  from `In-Reply-To`/`References` and from the sender address; auto-replies
  with an `Auto-Submitted` header are ignored.
- **Bounces**: delivery failure reports end the enrollment, mark the contact
  bounced and add the address to the suppression list.
- **"Stop" replies**: a reply starting with stop, unsubscribe, remove me or
  similar suppresses the contact.
- **Unsubscribe footer**: adds a one-click unsubscribe line and
  `List-Unsubscribe` / `List-Unsubscribe-Post` headers. Set the footer text
  and your postal address under Admin → General.
- **AI personalise**: per step. The model writes each contact's message from
  the template's brief (or body) and the contact's fields and notes. The
  sequence's AI mode decides whether drafts wait in **AI review** (default),
  send automatically, or are skipped.
- **Enrollment**: by tag, by picking contacts, or everyone active. Contacts
  who are unsubscribed, bounced, suppressed or already enrolled are skipped.

## AI responders

Responders → New responder. A responder watches incoming mail on one or all
accounts and asks the model for a reply.

- **Mode**: *Draft* files a suggested reply in the thread and in Drafts, and
  you send it; *Review* puts it in AI review, where approving sends it;
  *Send automatically* sends with nobody reading it first.
- **Which messages**: optional conditions (same builder as inbox rules).
  With no conditions, every inbound message qualifies. "Contacts only"
  restricts it to people in Contacts.
- **Skip lists**: on by default. Newsletters, notifications, no-reply
  senders and anything with `List-Unsubscribe`, `List-Id` or a bulk
  `Precedence` header are ignored, as are auto-replies, bounces and
  messages you already answered.
- **Instructions, tone, length, reply-all**: what the reply should do. The
  model also sees the thread, the contact's notes, the account's writing
  voice and the system prompt.
- **Safety valves**: a daily cap per responder, one reply per thread per
  cooldown period (stops bot-to-bot loops), and "respect the account's send
  policy" so automatic replies leave inside the window with a random delay.
- **Try it** runs the responder against the latest inbound message without
  sending anything, so you can see the tone before enabling it.

Generation happens in the background; a thread shows "an AI responder is
writing a reply" until the draft appears.

## AI campaigns

Sequences → **AI campaign**. Give it a name, a sending account, a brief (the
facts the email must convey), optional style instructions, and an audience
(a tag or all active contacts). It creates a sequence with an AI-personalised
step and an optional same-thread follow-up, enrolls the audience and
activates it. With "Review each draft", every email waits in AI review; with
"Send automatically", it goes out under the account's cap, window and delay.

## System prompt, voice and tuning

Settings → AI (admins):

- **System prompt**: the standing instructions every generation starts
  with. Empty means the built-in default, shown as the placeholder. Put house
  rules here ("never quote prices", "British spelling", "sign off with the
  team name").
- **Tuning**: temperature, top-p, top-k, repeat penalty, max tokens per
  reply, context window, and how long the model stays loaded.
- **Playground**: run a draft, reply, rewrite or subject line with the saved
  prompt and tuning to check the effect of a change.

Settings → Accounts → Edit → Identity → **Writing voice**: a short note on
how that mailbox writes. It is added to every generation for that account,
so two people sharing a Tern install can sound like themselves.

## Mailboxes on the bundled mail server

Admin → **Mail server** (admins, only when the installer set up Stalwart)
lists the mailboxes on the server and the DNS records for the domain, and
creates new mailboxes: choose the address and domain, a display name, and a
password (or let one be generated and shown once). The same step can connect
the mailbox to your own Tern account, to another user, or create a brand new
Tern login for the person, so onboarding someone is one form. Passwords can
be reset from the same page, which also updates the connected Tern account.
Deleting a mailbox destroys its mail on the server.

Headless: `./bin/tern cli add-mailbox --address sam@team.example.com --name "Sam" --user sam`.

Fastmail has no provisioning API; create users in Fastmail's own settings.

## Registration and invites

Admin → Users:

- **Invite links**: create a link with a role and an expiry; the person
  opens it, picks a username and password, and lands in the app. Links are
  single-use.
- **Open registration**: off by default. When on, the sign-in page shows
  "Create an account" and new users get the role you choose.

## Templates and merge fields

Templates → **Library** offers 25 starter templates (cold and warm intros,
follow-ups, break-up, customer check-in, upsell, win-back, feedback,
testimonial and referral asks, event invitation, meeting confirmation,
reschedule, thank-you, onboarding, product update, invoice reminder,
partnership, reactivation, holiday greeting, and reply templates). Copies
are yours to edit; square brackets mark the sentences you fill in.

Every template has a name, category, description, subject, body, an AI
brief, "append signature" and "star" options. Cards show validation
problems, fields used and how often it was sent. Export and import as JSON
to move templates between installs or share them.

The template language, usable in subjects, bodies and sequence steps:

| Syntax | Result |
|---|---|
| `{{first_name}}` | the field, or empty |
| `{{first_name\|there}}` | the field, or the fallback |
| `{{company:possessive}}` | a filter; chain with `{{name:first:capitalize}}` |
| `{{#if company}} at {{company}}{{/if}}` | kept only when the field has a value |
| `{{#unless phone}}What number works?{{/unless}}` | kept only when it is empty |
| `{Hi\|Hello\|Hey} {{first_name}}` | one option chosen per email |

Filters: `upper`, `lower`, `capitalize`, `title`, `trim`, `first`, `last`,
`possessive`, `initials`, `domain`.

Built-in fields: `first_name` `last_name` `full_name` `name` `email`
`company` `title` `phone` `website` `domain` `sender_name`
`sender_first_name` `sender_email` `greeting` (good morning/afternoon/evening
in the contact's or account's timezone) `today` `weekday` `month` `year`
`unsubscribe_url`, plus every custom field on the contact (`{{city}}`,
`{{plan}}`), including columns kept at CSV import. Values are HTML-escaped in
bodies.

**Preview** renders with a sample contact or any contact by address, flags
fields that have no value for them, and can shuffle the variations. **Send a
test to myself** delivers the rendered template to one of your own
accounts. In the composer, inserting a template renders it for the first
recipient; if there is no recipient yet, sample values are used.

## The AI assistant

Settings → AI (admins).

Every request to the model, whether a draft, a reply, a summary, a subject
line, a sequence's personalised email or a responder's answer, is a fresh
single-turn conversation: one system prompt and one message built from that
task's inputs alone. Nothing from earlier requests, other users or previous
outputs is carried over, no conversation state is kept on the server, and
the transport refuses anything that is not that shape. The assistant panel
only sends the editor's contents for the modes that edit a draft (rewrite,
polish, shorten, expand, subject).

- **Provider**: Ollama (bundled) or any OpenAI-compatible endpoint (`/v1/chat/completions`), with an optional API key.
- **Model**: pull curated models with one click or type any name from
  ollama.com/library. The page shows the RAM-based recommendation.
- **Temperature** and **context window**: 0.7 and 8192 by default. The
  conversation given to the model is sized to the context window: a long
  thread keeps its newest messages and its opening ones, where the dates and
  the figures were agreed, and drops the middle, saying how many went. A
  smaller window costs less memory and drops more.
- **Let reasoning models think** (off by default): qwen3 and deepseek-r1
  work an answer out before writing it. The reasoning never reaches a draft
  and is paid for out of its own **thinking budget** on top of the reply
  length, so it cannot leave the email empty; if the model spends it all
  and writes nothing anyway, Tern asks again with thinking off rather than
  showing an error. It is several times slower without a GPU and rarely
  reads better for email. Models that cannot reason ignore the setting —
  Ollama refuses `think` outright on them, so it is only sent to models
  that report the capability. While it thinks, the working-out is streamed
  into the page — in the composer's assistant panel, the thread summary,
  quick replies, the template writer and the playground — as a folded
  "Working it out" panel, so a two-minute generation shows its progress
  instead of an unmoving spinner. It is never inserted into a draft.
- **Min-p** (0, off): keeps only tokens at least this likely relative to the
  best one. A gentler tail cut than top-p, and it holds up better at higher
  temperatures; 0.05 is a reasonable place to start. Sent to Ollama and to
  OpenAI-compatible endpoints that accept it, and omitted entirely when 0.
- **Repeat penalty** (1.1) and **repeat window** (256 tokens): the penalty,
  and how far back it looks for something to penalise. Ollama's own window is
  64 tokens — less than a paragraph, so a model that opens every paragraph
  the same way is never caught by it. `-1` is the whole context, `0` turns
  repetition tracking off.
- **Frequency** and **presence penalty** (both 0, off): the repetition
  controls that cross providers. Repeat penalty and top-k are *not* sent to
  an OpenAI-compatible endpoint, because real OpenAI answers `400` to a
  parameter it does not know; these two are accepted by OpenAI, vLLM,
  llama.cpp and Ollama alike, so on that provider they are the only
  repetition controls there are.
- Some parameters are deliberately not settings. **Stop sequences** are set
  per task — a subject line ends at its first newline, every mode stops if
  the model starts a second turn of the conversation — because they are
  about the shape of a request, not about how the assistant writes. **Seed**
  is used only by the evaluation scripts, which compare runs: a fixed seed
  would make everyone's "try again" produce the same draft again. **Mirostat**
  is not offered at all: it replaces top-p and top-k with its own controller,
  so turning it on would silently disable three settings that are on the same
  page. **DRY sampling** (`dry_multiplier` and friends) is not an Ollama
  parameter — it belongs to llama.cpp's own server — and Ollama ignores it.
- Ollama keeps the model loaded for 10 minutes after use (`OLLAMA_KEEP_ALIVE`
  in `.env`); on a small VPS this is what keeps memory free between drafts.
  With several people using it, a longer keep-alive is worth more than it
  looks: every expiry costs the next person a cold load of the whole model.
- **GPU**: re-run the installer and answer yes, or add `compose.gpu.yml` to
  `COMPOSE_FILE` in `.env`.

### Several people at once

One model is loaded, and everyone shares it. Ollama serves
`OLLAMA_NUM_PARALLEL` requests per model at the same time and queues the
rest, so with one slot the second person to ask for a draft waits for the
first person's whole email with nothing to look at. Each slot holds its own
context window of KV cache, so slots cost memory: roughly
`num_ctx × (bytes per token for the model) × slots`, which Admin → AI model
prices for the model you are running.

- **Answer several people at once** (Admin → AI model, on by default) is the
  app's side of it: up to one generation per slot, one slot always kept for
  somebody waiting at a composer so inbox summaries and sequence mail cannot
  take them all, and one interactive generation per person so nobody's
  clicking starves anyone else. Turned off, every generation on the install
  waits for the one before it.
- **The slot count itself is Ollama's**, read when its container starts, so
  it lives in `.env` rather than on the admin page. The installer sizes it
  from RAM (2, 4 or 8). When more people have accounts than there are slots,
  the admin page says so and

  ```bash
  ./bin/tern ai-slots
  ```

  works out the number — one slot per person who can sign in, capped by what
  `OLLAMA_MEM_LIMIT` can pay for beside the model's own weights — writes it
  to `.env` and restarts. `./bin/tern ai-slots 4` sets it by hand.
- **`OLLAMA_KV_CACHE_TYPE=q8_0`** (the default here) roughly halves what each
  slot's context costs at close to no quality cost, which is what makes
  several slots affordable on a small box. It needs `OLLAMA_FLASH_ATTENTION`,
  which is also on. `q4_0` halves it again and does cost quality; `f16` turns
  the saving off.
- **`OLLAMA_MAX_QUEUE=32`**: once every slot is busy, Ollama queues. Its own
  default is 512 — deep enough that a loaded box looks like a hung spinner
  for minutes — so it is kept short here and a full queue becomes "The
  assistant is busy answering other people right now" instead.
- The memory meter on Admin → AI model shows all of this live: what the
  machine has left, what Ollama's container is holding against its limit, how
  much of the model is in VRAM when there is a GPU, and how many slots are
  generating or waiting right now.

On a CPU-only box the slots share the same cores, so two drafts at once are
each slower than one alone. The win is that nobody waits behind somebody
else's whole email before seeing a first word.

Prompts live in `server/src/ai/prompts.ts`. They are short on purpose; small
models follow short instructions best.

Two evaluation scripts run against a real model rather than a mock, and
grade what comes back with deterministic checks:

```bash
cd server && npx tsx --env-file=../.env.dev src/ai/live.eval.ts
```

covers every mode — names, long threads, quick replies, summaries, the
editing modes and campaign personalisation (`MODEL=`, `RUNS=`, `ONLY=`,
`THINK=on|off`, `VERBOSE=1`). And

```bash
cd server && npx tsx --env-file=../.env.dev src/ai/campaign.eval.ts
```

runs the whole mass-generation flow: a CSV through the import parser, an AI
campaign over the contacts it created, the scheduler generating one email
per contact, the guard, and the pacing the approved ones would leave
under (`N=`, `MODE=review|auto`).

## Inbox rules

Rules → New rule. Conditions on from, to, cc, subject, body, anywhere,
mailing-list headers or attachments; actions archive, mark read, star, label,
delete, junk. Rules run on new inbox mail in order; a delete or junk action
ends the chain. "Run on inbox" applies a rule to mail already there.

## Settings and Admin

There are two settings areas. **Settings** (the gear in the sidebar, or the
avatar menu) is about you: profile, mail accounts, mail apps, mail
behaviour, your AI assistant page, appearance, security and encryption.
**Admin** (sidebar, admins only) is the workspace: General (compliance
footer), Users (people, invites, open registration, mailbox provisioning),
Mail server (the bundled Stalwart: mailboxes, DNS, brand logo, admin
access), AI model (provider, model, system prompt, tuning, downloads),
Branding (name and logo) and the Audit log. Old `/settings/users`,
`/settings/general` and `/settings/mailserver` links redirect.

### A mailbox for every login

With the bundled mail server, Admin → Users → **Give every new login a
mailbox** (on by default) makes `username@your-domain` on Stalwart whenever
someone registers, accepts an invite, is added by an admin, or creates the
first admin account, and connects it as their first account with a
generated password Tern keeps encrypted. A username whose address already
exists on the server (as a mailbox or an alias) cannot register; an admin
connects that mailbox to a login under Admin → Mail server instead. The
outcome is in the audit log either way.

### Your mailbox password

Settings → Mail apps → **Mailbox password**. Tern signs in to the mailbox
with that password, so after re-entering your Tern password it can show it
to you for Thunderbird, a phone or a JMAP client. On the bundled mail server
you can also **set a new password** there (generated, or one you choose);
Tern updates its own connection, other apps need the new one. Both actions
are written to the audit log.

### What automation will not send

Every message that leaves without a person pressing Send (sequence steps,
AI responders in send mode, approved-then-scheduled mail) passes a guard in
`server/src/ai/guard.ts`. It looks for unrendered merge fields
(`{{first_name}}`, `{Hi|Hello}`), placeholders (`[Your Name]`, `<insert
date>`, `__NAME__`), echoed prompt scaffolding ("Recipient facts", "--- From
"), AI self-references ("as an AI language model") and filler ("lorem
ipsum"). Anything flagged goes to the review queue with the reason shown on
the card, the enrollment waits, and nothing is sent until someone edits and
approves it. Quoted text from the other side is not inspected. Mail a
person wrote or approved is never touched.

## Appearance

Settings → Appearance, or the theme button in the top bar for the quick
version. Everything is saved in the browser and mirrored to your profile.

**The house style.** Admin → Appearance sets what everyone starts with: the
look on a new account, in a browser that has never been used here, and on the
sign-in page, where there is no person yet. It is a *default*, so it reaches
anyone who has not chosen for themselves, key by key — change the house
palette and someone who once picked dark mode keeps dark and gets the new
palette. **Apply to everyone** is the separate button that does overrule a
personal choice: it clears what people picked, in the browser and in their
profile, and puts everyone on the current default the next time their browser
loads the app. They are free to change it again afterwards, and Settings →
Appearance has a "Use the default style" button that goes back.

- **Theme**: Auto (follows the system), Light or Dark.
- **Colour palette**: eighteen palettes. Ink (black on white, the default),
  Graphite, Slate, Indigo, Arctic, Midnight, Ocean, Violet, Lavender, Rose,
  Sakura, Sunset, Peach, Amber, Copper, Forest, Mint and Lime. A palette
  sets the accent colours, the colour drawn on top of the accent, and the
  four gradient stops the background shaders mix. Add one in
  `client/src/lib/palettes.ts`, then run `npm run gen:theme -w client` to
  regenerate `client/public/theme-init.js` for the first paint.
- **Background**: fifteen WebGL2 fragment shaders drawn behind the glass
  panels, grouped by mood. Calm: Mist (the default, a barely-there haze),
  Silk, Halo, Horizon, Topo, Dust, Aurora, Orbs. Lively: Mesh, Liquid,
  Nebula, Plasma, Prism, Waves, Grid. Or Plain. They render at reduced
  resolution, cap at 30 fps, pause in hidden tabs, and freeze to a single
  frame when motion is reduced. Without WebGL2 a CSS gradient stands in.
  Shaders live in `client/src/lib/shaders.ts`; each one is a fragment shader
  that gets the palette's four colours, the time and the pointer.
- **Glass**: Subtle, Balanced or Strong translucency and blur for the panels.
- **Motion**: Full or Reduced. The operating system's reduce-motion setting
  is always respected.
- **Density** and **reading pane** as before.

Message bodies follow the theme: plain correspondence is drawn in the theme's
text colours, while designed newsletters keep their own colours on a light
card in dark mode with a "Match theme" switch that inverts them.

## Name and logo

Admin → Branding → **Name and logo** (admins). The name replaces "Tern" in
the top bar, on the sign-in and registration pages and in the browser tab;
the logo replaces the feather and becomes the favicon. Upload an SVG, PNG,
JPEG or WebP up to 1 MB. SVGs are cleaned the same way as mail logos
(scripts, external references and metadata removed); rasters have their
metadata stripped. Remove the logo to return to the default.

The app installs as a PWA (browser menu → *Install* or *Add to Home Screen*)
and opens in its own window with the name and logo above. Home-screen icons
are rendered from the logo on a background colour you pick on the same card;
without a logo the default Tern icons are used. The service worker keeps the
app shell available offline and never caches mail.

## Notifications

Settings → Profile → **Notifications**. Turn it on per device: the browser
asks for permission and registers with the server through the service
worker. Each new message in the inbox becomes a notification with the sender
and subject; when many arrive at once you get one summary. Mail bodies never
leave the server. Needs https (the installer's default) and, on iPhone and
iPad, the app added to the Home Screen first.

## Burner addresses

Settings → Profile → **Burner address**, for anyone with a mailbox on the
bundled mail server. One per user, generated (never chosen), receive-only:
it is an alias on the user's own mailbox, so mail to it lands in the same
inbox, and Tern only ever sends from the mailbox's real address. Creating a
new one replaces the old, which bounces from then on. There is a short
cooldown between replacements.

## Profile pictures

Settings → Profile: upload a picture (squared and shrunk to 256 px in the
browser). It appears in the top bar and next to messages you sent. Contacts
get photos from their drawer in Contacts; those show in the inbox list and
thread view for mail from that address. Pictures are stored in Postgres and
served only to signed-in users.

## Environment variables

Set in `.env` (the installer writes it; edit and `./bin/tern up` to apply).

| Variable | Purpose | Default |
|---|---|---|
| `APP_URL` | Public URL, used in unsubscribe links | set by installer |
| `SITE_ADDRESS` | What Caddy serves (`https://host` or `:80`) | set by installer |
| `SESSION_SECRET` | Signs session and unsubscribe tokens | generated |
| `ENCRYPTION_KEY` | AES-256-GCM key for stored mailbox credentials | generated |
| `AI_ENABLED`, `AI_MODEL` | Assistant on/off and default model | from RAM |
| `OLLAMA_KEEP_ALIVE` | How long a model stays loaded | `10m` |
| `OLLAMA_NUM_PARALLEL` | People the model answers at once; each slot holds its own context window (`./bin/tern ai-slots`) | from RAM: `2`, `4` or `8` |
| `OLLAMA_KV_CACHE_TYPE` | How the context cache is stored: `q8_0`, `q4_0` or `f16` | `q8_0` |
| `OLLAMA_MAX_QUEUE` | Requests Ollama queues once every slot is busy, before answering "busy" | `32` |
| `OLLAMA_MEM_LIMIT`, `APP_MEM_LIMIT`, `STALWART_MEM_LIMIT` | Container memory limits | from RAM |
| `SYNC_POLL_SECONDS` | Fallback poll interval when push is unavailable | `90` |
| `INITIAL_SYNC_LIMIT` | Newest messages fetched on first sync | `3000` |
| `ALLOW_INSECURE_JMAP` | Allow `http://` session URLs (needed for the bundled Stalwart) | `true` |
| `ALLOW_PRIVATE_NETWORK_HOSTS` | Allow JMAP, SMTP and key-directory hosts on private, loopback or link-local addresses. Off, so no member can point the server at the compose network; the bundled Stalwart is always allowed. Turn on for a JMAP server on your LAN. | `false` |
| `HTTP_PORT`, `HTTPS_PORT` | Host ports Caddy binds | `80`, `443` |
| `COMPOSE_FILE` | Compose overlays in use | `compose.yml` |
| `STALWART_*` | Bundled mail server settings and admin credentials | set by installer |

## Multiple users

Admins add people under Admin → Users. Each user connects their own
mailboxes and keeps their own contacts, templates, sequences and rules. The
AI settings and compliance footer are shared.

## Mail preferences

Under **Settings → Mail** every person chooses, for themselves:

- **Undo send**: how long a message is held after Send (off, 5, 10, 20 or
  30 seconds). During that window the toast in the corner has an Undo
  button; undoing puts the message back in the composer as a draft. The
  message is queued in the outbox and leaves at the exact moment the window
  closes, so it is not delayed by the scheduler tick. Held messages are
  logged as the reply or compose they are, not as "scheduled".
- **Reading pane**: beside the list, below it, or off.
- **Replies**: whether the reply shortcut and "AI reply" answer everyone on
  the message by default, and whether "Send and archive" is offered.
- **Images**: show remote images automatically in mail from contacts.
  Individual senders can be allowed from the "Remote images are hidden"
  bar; that list lives in the browser.
- **Mark as read**: at once, or after a couple of seconds.

The choices are stored in the browser and mirrored to the profile, so they
follow the person to another device.

## Out-of-office auto-reply

**Settings → Accounts → Edit → Auto-reply**, per mailbox. A message, an
optional first and last day (in the account's send-window timezone), and how
many days to wait before the same person is answered again. Optionally only
people in your contacts. The reply carries `Auto-Submitted: auto-replied`
and `X-Auto-Response-Suppress: All`, and is never sent to mailing lists,
notifications, no-reply senders, bounces, other auto-replies, or to your own
address. Rules and AI responders run first; a message an AI responder picks
up gets no auto-reply. Turning it on or off is written to the audit log.

## Muting and blocking

**Mute** (the `m` key, or the conversation's More menu) archives a
conversation and files every later reply straight into the archive; nothing
about it reaches the inbox until it is unmuted. **Block sender** creates an
inbox rule that sends future mail from that address to Junk and moves the
current conversation there. Both are undoable from the toast.

## List mail

Messages with a `List-Unsubscribe` header show an Unsubscribe link in the
message header. A `mailto:` target sends the unsubscribe request as an
email from the account that received the message; an `https:` target opens
the list's page. AI responders never answer list mail.
