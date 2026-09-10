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

- **Provider**: Ollama (bundled or elsewhere), Anthropic's Messages API, or
  any OpenAI-compatible endpoint (`/v1/chat/completions`), with an optional
  API key. The **Start from** row above the fields fills in the shape and the
  address for the hosts Tern knows — Ollama, perch, OpenAI, Anthropic, Groq,
  OpenRouter, Together, Fireworks, NanoGPT and Google. It is a shortcut, not a
  gate: the setting remains a shape and an address, so an endpoint that is not
  on that list — a vLLM in your own rack, a proxy in front of one of these — is
  configured by typing its address in, exactly as before.
- **Model**: pull curated models with one click or type any name from
  ollama.com/library. The page shows the RAM-based recommendation. The list of
  what is installed is read from the model server every few seconds rather
  than cached, which matters most when the model server is somebody else's —
  a model pulled from the perch console on the GPU box, or removed there with
  `ollama rm`, shows up here within a poll. When the server cannot be reached
  the card says so; an empty table and an unreachable server are no longer the
  same screen. A deletion is only reported as done once that server's own list
  agrees, so a delete a proxy accepted but did not apply is an error rather
  than a row that quietly comes back on the next refresh.
- **Temperature** and **context window**: 0.7 and 8192 by default. The
  conversation given to the model is sized to the context window: a long
  thread keeps its newest messages and its opening ones, where the dates and
  the figures were agreed, and drops the middle, saying how many went. A
  smaller window costs less memory and drops more.
- **Reply length** and **thinking budget** (both **unlimited by default**):
  ceilings on the answer and on the working-out. Neither is set out of the
  box, and that is deliberate — the prompt is what decides how long an answer
  should be, so a ceiling on top of it can only ever cut a good answer short.
  A frontier model with reasoning enabled is a supported configuration here,
  and those deliberate for far longer than any local model, so a budget sized
  to a 12B would silently truncate exactly the setup it was meant to serve.

  Unlimited means the parameter is **not sent**, rather than sent as a large
  number — a big number is still a ceiling and would be the wrong one on the
  next model. The single exception is Anthropic, whose API requires
  `max_tokens`; there Tern asks that API what the model's own maximum is and
  sends that.

  Set either to a number if you want a hard ceiling — for a hosted provider
  billed by the token, that is a real reason to. What neither can exceed is
  the context window, which Tern computes and enforces with the model's actual
  limit.
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
- **Presets** hold a set of these numbers under a name, because one model
  does not want what another wants — and a reasoning model does not want what
  it wants itself with thinking off. Pick one and **Apply**; **Save current
  as…** keeps the sliders as they stand as a preset of your own, which you can
  update or delete. Three ship with Tern and cannot be edited or deleted
  (save a copy instead):
  - **Balanced (small models)** — Tern's own defaults: qwen3.5, gemma3,
    gemma3, thinking off.
  - **Qwen3.5 — straight answer** — temperature 0.7, top-p 0.8, top-k 20,
    presence penalty 1.5, thinking off. What Qwen3.5 asks for in
    non-thinking mode, and the setting for email on a CPU-only box.
  - **Qwen3.5 — thinking** — temperature 1.0, top-p 0.95, top-k 20, presence
    penalty 1.5, thinking on at medium effort with a 3000-token budget. The
    wider sampling Qwen3.5 asks for while it reasons.

  Both Qwen3.5 presets leave the repeat penalty at 1.0: on that model the
  presence penalty does that job, and stacking the two flattens the writing.
  A preset carries sampling, reply length and the thinking settings only —
  never the context window, the keep-alive, the provider or the model, which
  are decisions about the machine rather than about how the assistant writes
  (a preset that resized the context would resize every parallel slot with
  it). The model a preset was written for is shown as a badge, and warns when
  you are running something else.
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

### Downloads

A pull is a job on the server, not the request that asked for it. Closing the
page, reloading, switching tab or letting a laptop sleep leaves it running,
and coming back shows it where it is; the only thing that stops one is the
**Cancel** button beside it. That is not a nicety on a slow line — a 17 GB
model is a long download to lose to a screen lock, and losing it left no
evidence beyond a model that never appeared.

The bar is the whole download. Ollama reports progress one layer at a time,
so a bar drawn from those numbers restarts from zero at each layer and reaches
"100%" several times; this one sums every layer the stream has mentioned and
adds the transferred bytes, a smoothed rate and an estimate. While nothing has
been sized yet — during `pulling manifest` — it shows the phase and no
percentage rather than an invented zero.

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

## Features, and turning them off

Everything that reads a mailbox for a purpose other than showing it to its
owner, and everything that reaches the model, lives behind two switches.

**Settings → Features** is the person's own list. Nothing is on for a new
account. Each row says what is read and what is kept, and turning one off
erases what it produced rather than pausing it.

**Admin → Features** is the same list for the install. This is the one to
reach for when the box is struggling: it takes effect on the next request and
the next scheduler tick — nothing caches a flag for more than five seconds —
and it leaves everybody's consent alone, so switching it back on restores
what people had already chosen rather than making them choose again.

The heavy ones, in the order they cost you:

| Feature | What it costs |
|---|---|
| Meaning search | One embedding model call per message, once. `all-minilm` is 46 MB and enough; `nomic-embed-text` is 274 MB and noticeably better. 256 bytes of storage per message |
| Dictation | A separate container, 400 MB to 1 GB while transcribing |
| The brief | One generation, only when somebody presses the button |
| Commitments | One generation per changed conversation, in the background |
| Search inside attachments | One download and one parse per file, in the background |
| Conversation summaries | One generation per conversation shown |
| Priority ordering | Nothing. No model, and the training data is already in the search index |
| Impersonation guard, link cleaning, invitations | Nothing. All deterministic |

The background passes take turns — one per twenty-second tick, rotating
between the six kinds of work and between people — so a box with one model
resident never tries to embed a mailbox, read attachments and answer somebody
at the same time. `workers/enrichment.ts`.

### The embedding model

**Admin → AI model → Meaning search**, or `AI_EMBED_MODEL` in `.env` before
the first start. The installer picks `nomic-embed-text` when the box has 6 GB
or more and `all-minilm` below that, and downloads it.

Meaning search uses a second model from the one that writes, and a much
smaller one: it never generates a word, it only has to place similar messages
near each other. It loads *beside* the writing model rather than instead of
it, so the figure that decides whether it fits is what it wants loaded, not
the download — which is why the card shows both.

| Model | Download | Loaded | Per vector | |
|---|---|---|---|---|
| `all-minilm` | 46 MB | ~286 MB | 23M · 512 tok | The default below 6 GB. Loads beside the writing model without competing for room. |
| `nomic-embed-text` | 274 MB | ~572 MB | 137M · 8,192 tok | Better quality and a much longer window, so a whole message embeds as one vector instead of just its opening. |
| `embeddinggemma` | 621 MB | ~1.0 GB | 300M · 2,048 tok | Larger again. Worth it only if you search a big mailbox and find the others imprecise. |
| `qwen3-embedding:0.6b` | 640 MB | ~1.1 GB | 0.6B · 32,768 tok | The Qwen3 family without a graphics card: the same long window and the same query instruction, in 1024-wide vectors. |
| `mxbai-embed-large` | 670 MB | ~1.1 GB | 335M · 512 tok | Strong English retrieval in a small download, 1024 wide. The short window is the catch: only the opening of a long message reaches the vector. |
| `bge-m3` | 1.2 GB | ~1.6 GB | 567M · 8,192 tok | Multilingual retrieval over a hundred languages, 1024 wide. The usual choice for a mailbox that is not mostly English but has no card to give Qwen3. |
| `snowflake-arctic-embed2` | 1.2 GB | ~1.6 GB | 568M · 8,192 tok | Multilingual and Matryoshka-trained, 1024 wide. A middle between the tiny defaults and the Qwen3 pair. |
| `qwen3-embedding:4b` | 2.5 GB | ~3.4 GB | 4B · 32,768 tok | Strong multilingual retrieval, 2560-wide vectors, and a window wide enough that Tern sends it the whole of any ordinary message. Wants a graphics card. |
| `qwen3-embedding:8b` | 4.7 GB | ~6.2 GB | 8B · 32,768 tok | The best open-weight retrieval model here and the widest at 4096. Only worth it with room on the card beside the writing model. |

**How much of a message goes into one vector** is decided by the model's own
window, and Tern adds no ceiling of its own — so a 32k-window embedder is sent
up to about 65,000 characters and an ordinary message is never truncated at
all.

It took two goes to get there. A flat 2,000 characters for every model made the
window column above decorative; a ceiling of 8,000 replaced it, and that was
invisible until a 32k-window model became the floor and clipped it to a
fourteenth of what it could hold.

### Where the vectors live

**Qdrant, in a container that comes up on every deployment** — development and
production alike, behind no profile. `install.sh` generates its key; the
container refuses to start without one rather than coming up open to the
compose network.

They used to live in Postgres, and every search scanned all of them. Measured
on the development database: 94 ms over 50,000 messages and 383 ms over
200,000, of which **82% was shipping rows into Node** rather than the
arithmetic. An index does not make the maths faster; it stops the rows being
sent at all.

Three things about the layout are worth knowing before you change anything:

- **One collection per user, per model.** Vectors are rotated with a per-user
  key, so one collection holding several rotations would give the index a graph
  built from distances that mean nothing across users — costing recall *within*
  a user, not merely across them. The model is in the name too, because vectors
  from two embedders are not comparable, so switching model writes into a new
  collection instead of poisoning the old one. This is right for tens of users
  and wrong for tens of thousands, since collections are not free.
- **The index holds ids, scores and the account — no content.** Everything
  shown comes from a join back to Postgres, and that is what preserves the
  guarantee that deleting a message takes its vector with it: a point that
  outlived its email joins to no row and disappears before anything is
  rendered. Content in a payload would survive in a store the cascade cannot
  reach and no backup captures.
- **The index is not in your backup, deliberately.** `./bin/tern backup` is
  `pg_dump` plus `.env`, and vectors are derived data. `restore` queues every
  message for re-embedding and says so; meaning search is thin until that
  finishes — overnight on a CPU-only box with a large mailbox — and ordinary
  text search is unaffected throughout. **Settings → AI** shows how many are
  left.

The cost of embedding a very long message whole is that its vector is an
average of everything in it, so long mail is findable but less precisely. The
ceiling was never a fix for that — it addressed dilution by throwing the tail
away, losing the precision *and* the content. Chunking, several vectors per
message, is the real answer and is not built yet.

The Qwen3 and Gemini models are also given the task instruction their training
expects — `Instruct: …` in front of a **search**, and deliberately not in
front of a stored message, because prefixing both would put the same words in
every vector in the mailbox. Voyage is told the same thing as a real request
field instead.

### Embedding somewhere other than the writing model

**Admin → AI model → Embeddings.** By default this is left on *the same server
as the language model*, which inherits its whole connection — address, key,
certificate rule and Tor switch — and is what every install had before the
setting existed.

It is separable because the two are different jobs on different-sized models,
and because one provider cannot do both: **the Messages API has no embeddings
endpoint at all**, so an install drafting on Anthropic must point meaning
search somewhere else or go without it. The other combinations are just as
real — drafting on your own GPU and embedding on a hosted retrieval model, or
the reverse.

Four shapes are accepted here, two of which drafting does not offer:

| Shape | For | Notes |
|---|---|---|
| Ollama | `all-minilm`, `nomic-embed-text`, `embeddinggemma`, `qwen3-embedding:4b`/`:8b` | Anything the server reports as `embedding`-capable. |
| OpenAI-compatible | `text-embedding-3-large` (3072 wide), `-small` (1536), `Qwen/Qwen3-Embedding-8B` on Together, Fireworks, OpenRouter and the rest | The width depends on the model, not the host. |
| Google Gemini | `gemini-embedding-2` (3072 wide, 8k window) | Its own API: the model goes in the path and the key is sent as `x-goog-api-key`, never in the URL. Gemini *drafting* is a different endpoint — use the "Google (Gemini)" preset for that. |
| Voyage AI | `voyage-3-large` (1024 wide, 32k window) | The only host here that is told whether it is embedding a search or a message, which measurably changes what comes back. It publishes no model list, so that one picker falls back to the models Tern knows and says so. |

Every other picker on the page is the live answer from the server at that
address, read every few seconds — including on hosted providers, which the
page used to skip. A model pulled on the GPU box, or a model added to a hosted
catalogue, appears without an upgrade.

**Wider vectors do not cost storage**, which is worth saying plainly because
the opposite is the natural assumption and this page used to assert it. Every
vector is projected down to a fixed width before it is stored, so an
`all-minilm` row and a `qwen3-embedding:8b` row are the same 256 bytes and an
index over the same mailbox is the same size either way. Measured across the
whole catalogue above.

What a wider model does cost is the download, the memory to keep it loaded, and
wanting a graphics card to run at a sensible speed. Those are real — and they
are the only reasons to pick a smaller one. The picker shows the width beside
each model it knows.

The embedding connection has **its own Tor switch and its own certificate
rule**, not the language model's. That is deliberate and was once a bug: while
they were shared, pointing meaning search at a machine on the LAN silently
sent it through Tor if the GPU happened to be reached that way.

The card downloads, deletes, loads and unloads them, the same as the writing
models above, and anything else from the registry can be pulled by name — a
model Ollama reports as `embedding`-capable appears here rather than in the
writing list, so it cannot be picked as the drafting model by mistake.

**Changing it re-indexes.** A vector made by one model is not comparable with
one made by another — the cosine distance between an `all-minilm` vector and a
`nomic-embed-text` one is noise, not similarity — so switching queues every
message already indexed to be embedded again, and the page says how many. Old
vectors are not deleted, because a message that has been re-embedded should be
findable immediately rather than at the end of the pass; they are simply not
scored. A search only compares against vectors made by the model that is
currently set, so during a rebuild meaning search narrows to what has been
rebuilt and then widens back out, rather than returning noise from the old
geometry with a plausible-looking score on it. On a large mailbox that pass
takes a while; it shares the twenty-second enrichment tick with everything
else, so it will not monopolise the model.

### Pictures and video

**Admin → AI model → Pictures and video.** Off, with nowhere to send a prompt,
until an address is set — and a member still has to turn **Pictures and video**
on under Settings → Features before the button appears for them.

This is the one model connection with no local option. There is no bundled
image server and there is not going to be one: the smallest useful diffusion
model is larger than everything else Tern ships put together, and none of them
run on the 4.5 GB box the rest of this is sized for. So the host is somebody
else's hardware unless you own a GPU box, **every prompt your people type goes
to it**, and the card and the composer both say so rather than leaving it to
be inferred from an address only an admin can see. Nothing from anybody's
mailbox is sent — only the sentence they wrote.

Two shapes, because image generation genuinely arrived twice:

| Shape | Endpoint | Hosts |
|---|---|---|
| `/v1/images/generations` | a path of its own | OpenAI, Together AI, Fireworks, NanoGPT, and a local ComfyUI, SwarmUI or LocalAI behind their OpenAI shims |
| `/v1/chat/completions` | the picture comes back inside the chat reply, as a data URL | OpenRouter, Google's compatibility layer |

They cannot be told apart from the address — OpenRouter serves both on the
same origin — so the card asks which one the host speaks. **Ollama is
deliberately not offered**: it runs vision models that *read* a picture and
has no endpoint that draws one, so an option for it would be an option that
cannot work, the same judgement that keeps Anthropic off the embedding list.

**Video** is a second connection, defaulting to sharing the image one whole —
address, key, certificate rule and Tor switch. It is asked for over
`/v1/videos`, which is a job rather than a request: the host takes the prompt,
hands back an id, and is asked later how it went. Closing the composer, or
reloading the page, does not lose a generation; only pressing **Stop** does.
A generation does not survive a restart of the Tern server itself, so the
host's own id for it is shown, which is what you would need to collect one by
hand.

Each connection has **its own Tor switch and its own certificate rule**, like
every other model connection here — and this is the one where the switch earns
its keep most obviously, since a host that is billing somebody learns this
server's address from every request otherwise.

What comes back is filed exactly as a photo somebody dragged in: the same
`uploads` row, the same metadata scrub — several hosts write the prompt into
the picture's own EXIF, and that is stripped before it can travel with the
message — the same `cid:` inline part, and the same delete when it is
discarded. The file type is read from the bytes rather than from the host's
label, because the label is what decides whether the composer can show it at
all.

Generations are reachable only from a composer with a person in front of it.
**A responder or a sequence step cannot make one**: the hard filter in front
of every automated send reads text and can say whether a draft still contains
a merge field, and nothing reads a picture and says whether it is fit to put
in front of a stranger.

### Dictation

Add the container by re-running `./install.sh` and answering yes, or by hand:

```bash
echo 'COMPOSE_FILE=compose.yml:compose.voice.yml' >> .env   # append to the existing value
echo 'WHISPER_MODEL=base' >> .env                           # optional; base is the default
./bin/tern up
```

The container downloads its own weights the first time it starts, so the
first `up` takes a few minutes and the port does not answer until it is
done — `./bin/tern logs whisper` shows the progress. Deleting the
`tern-whisper` volume is how you make it fetch them again.

`WHISPER_MODEL` chooses the speech model (`base` is 150 MB and fits a 4.5 GB
box beside a chat model; `small` is 500 MB and better on accents and names).
Change it and restart the container to switch. Without the container the
Dictation switch says so rather than failing at the microphone.

#### What the Dictation card offers depends on the transcriber

"Something speaking OpenAI's transcription shape" covers two quite different
servers, so the card asks which one it is talking to instead of assuming, and
shows the controls the answer justifies.

The bundled whisper.cpp holds **one** model, fixed when the container starts,
and has no model API at all — `/v1/models` is a 404 there. The card says so
and leaves the model box as free text, because there is nothing to list.

speaches (and faster-whisper-server before it) hosts many: it lists what it
has at `/v1/models`, publishes everything it could fetch at `/v1/registry`,
and downloads and removes through `POST` and `DELETE` on `/v1/models/{id}`.
Against one of those the card becomes a live table — the model box becomes a
list of what is actually there, with **Download** for anything in the registry
and **Delete** for anything installed. Both are checked against the
transcriber's own list afterwards rather than against the status code.

A download here is a job on the server in exactly the way a model pull is, so
it survives the page. What it cannot have is a percentage: speaches downloads
in one blocking call and reports nothing until it finishes, so the card shows
a moving stripe, the elapsed time and a line saying why there is no number,
which is more use than a bar that invents one.

A hosted transcription API usually lists its models and lets you manage none
of them. That case gets the list without the buttons.

#### A transcriber on another machine

A 4.5 GB box holding a chat model has no room for a speech model as well, and
the usual answer is the machine with the spare cores rather than a bigger VPS.
**Admin → AI model → Dictation** takes the address of anything speaking
OpenAI's `/v1/audio/transcriptions` — whisper.cpp's own server, faster-whisper,
speaches, or a hosted API — with an optional bearer token for one behind a
reverse proxy, a model name for a server that hosts several, and a **Test
connection** button that tries the address before it is saved. It overrides
`WHISPER_URL` without a restart, and clearing it turns dictation off.

The audio still never touches disk on this side, but it does leave the box:
the card says so whenever the address is not on this machine or this network.
Put such a transcriber on a private network or behind TLS, and prefer one you
run — a hosted transcription API is a company keeping your people's voices,
which is the thing the local container exists to avoid.

### A model on another machine

The same applies to the assistant itself. **Admin → AI model** has taken a
base URL for a while; what it now also has is an **API key** field for the
Ollama provider, because Ollama has no authentication of its own — a remote
one belongs behind a proxy that wants a token, and that token is sent on every
request Tern makes to it, management calls included. The bundled container on
the compose network needs nothing there.

A remote provider is the one setting that decides whether mail leaves your
server: everything the assistant is shown — the text of the emails it drafts
replies to — is sent wherever that URL points. The card says so plainly when
the address is not local. It is a supported choice, and the right one when the
model is on your own hardware elsewhere; it is not one to make by accident.

Three things have to be right, and each is wrong in its own way, so there is a
**Test connection** button beside **Save settings** that asks without saving —
worth using, because saving unloads whatever model the install was on.

- **The base URL is the server's root.** Scheme, host and port, nothing else:
  `https://203.0.113.10:40123`, not `.../api` and not with a trailing slash.
  Every call appends its own path, so a stored slash makes `//api/chat`, which
  Ollama answers 404 to — health, model list and drafting alike. Tern now
  trims it on the way in and on the way out, so an address pasted from a copy
  button works, but it is still the shape to aim for.
- **The API key is the proxy's token.** Ollama has no authentication of its
  own, so anything reachable off the box is behind something that does. The
  key is sent as `Authorization: Bearer` on every request, management calls
  included. Rented GPU hosts usually call it an instance or open-button token.
- **The certificate has to be one this machine can verify** — unless you say
  otherwise. A host that generates its own certificate at boot, which is the
  norm for a rented GPU box reached at its IP, will fail verification, and the
  page says so and offers **Trust this server's certificate even if it cannot
  be verified**. Turning it on keeps the connection encrypted but stops
  proving the machine at the other end is the one you meant, so it is for a
  server whose address you control; the page shows the certificate's subject,
  issuer and fingerprint so you can see what you are trusting. Where the host
  offers a proxied URL with a real certificate, prefer that and leave the
  switch off.

A hosted Ollama — the [Vast.ai Ollama template](https://docs.vast.ai/ollama-webui)
is the shape of it — is all three at once: the port is mapped to an external
one, the token is required, and the certificate is self-signed. Base URL
`https://<instance-ip>:<external-port>`, the instance token in the API key
field, and the trust switch on unless you are going through the host's proxy.

### Importing an archive

**Settings → Import.** The file is held in memory for the length of the run
and never written to the server's disk, which is what makes "nothing is left
behind" a fact rather than a promise about cleanup code — and is also why
there is a 256 MB ceiling. A Google Takeout larger than that exports one
mbox per label, so import them one at a time.

Imported mail lands in a mailbox called **Imported**, never the inbox, and
stays in Tern's cache: it is not uploaded to your mail provider. Attachment
contents do not come with it, because those bytes are not in the mbox in a
form the mail server can serve back; names, types and sizes are listed.

### Retention

**Admin → Retention** sets how long each by-product is kept. Every default is
the shortest the feature still works with. The two rows that hold mail
content — a queued AI job's prompt and a decided review's copy of the message
— are emptied when they stop being needed rather than when the row expires.

### Recovery shares

**Admin → Security.** Split `ENCRYPTION_KEY` into `n` printed shares, any `k`
of which rebuild it. They are shown once and never stored. To use them:

```bash
./bin/tern recover-key
```

Make a new set if you rotate `ENCRYPTION_KEY`; the page says when the shares
on file are for a different key than the one running.
