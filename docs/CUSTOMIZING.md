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
  and your postal address under Settings → General.
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

## Registration and invites

Settings → Users (admins):

- **Invite links**: create a link with a role and an expiry; the person
  opens it, picks a username and password, and lands in the app. Links are
  single-use.
- **Open registration**: off by default. When on, the sign-in page shows
  "Create an account" and new users get the role you choose.

## Merge fields

Available everywhere a template or step body is written:

`{{first_name}}` `{{last_name}}` `{{full_name}}` `{{email}}` `{{company}}`
`{{title}}` `{{phone}}` `{{website}}` `{{domain}}` `{{sender_name}}`
`{{sender_first_name}}` `{{sender_email}}` `{{today}}` `{{weekday}}`
`{{unsubscribe_url}}` plus any custom field from the contact
(`{{city}}`, `{{plan}}`, ...).

Fallbacks: `{{first_name|there}}` renders "there" when the field is empty.
Values are HTML-escaped in bodies.

## The AI assistant

Settings → AI (admins).

- **Provider**: Ollama (bundled) or any OpenAI-compatible endpoint (`/v1/chat/completions`), with an optional API key.
- **Model**: pull curated models with one click or type any name from
  ollama.com/library. The page shows the RAM-based recommendation.
- **Temperature** and **context window**: 0.7 and 4096 by default. A larger
  context lets summaries see more of a long thread at the cost of memory.
- Ollama keeps the model loaded for 10 minutes after use (`OLLAMA_KEEP_ALIVE`
  in `.env`); on a small VPS this is what keeps memory free between drafts.
- **GPU**: re-run the installer and answer yes, or add `compose.gpu.yml` to
  `COMPOSE_FILE` in `.env`.

Prompts live in `server/src/ai/prompts.ts`. They are short on purpose; small
models follow short instructions best.

## Inbox rules

Rules → New rule. Conditions on from, to, cc, subject, body, anywhere,
mailing-list headers or attachments; actions archive, mark read, star, label,
delete, junk. Rules run on new inbox mail in order; a delete or junk action
ends the chain. "Run on inbox" applies a rule to mail already there.

## Appearance

Settings → Appearance: light, dark or system theme; comfortable or compact
density; split or full-width reading pane. Stored per browser.

The design tokens are CSS variables at the top of
`client/src/styles/app.css`. Change `--accent` for a different brand colour;
both themes derive from the same token names.

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
| `OLLAMA_MEM_LIMIT`, `APP_MEM_LIMIT`, `STALWART_MEM_LIMIT` | Container memory limits | from RAM |
| `SYNC_POLL_SECONDS` | Fallback poll interval when push is unavailable | `90` |
| `INITIAL_SYNC_LIMIT` | Newest messages fetched on first sync | `3000` |
| `ALLOW_INSECURE_JMAP` | Allow `http://` session URLs (needed for the bundled Stalwart) | `true` |
| `HTTP_PORT`, `HTTPS_PORT` | Host ports Caddy binds | `80`, `443` |
| `COMPOSE_FILE` | Compose overlays in use | `compose.yml` |
| `STALWART_*` | Bundled mail server settings and admin credentials | set by installer |

## Multiple users

Admins add people under Settings → Users. Each user connects their own
mailboxes and keeps their own contacts, templates, sequences and rules. The
AI settings and compliance footer are shared.
