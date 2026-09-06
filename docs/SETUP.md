# First run

This is the full walkthrough from an empty server to a working inbox.

## 1. What you need

- A Linux server with 2 CPUs and at least 4.5 GB of RAM. Debian 13 or Ubuntu 24.04 are the tested targets; anything with podman 4+ works.
- Root or sudo.
- Optional but recommended: a domain name pointing at the server (an `A` record). Without one, Tern runs over plain HTTP on the server's IP.
- A mailbox to connect. Fastmail, a Stalwart server you already run, or the Stalwart the installer can set up for you. See [PROVIDERS.md](PROVIDERS.md).

## 2. Run the installer

```bash
git clone <repository> tern
cd tern
sudo ./install.sh
```

Every question shows its default in brackets; press Enter to accept. The installer:

1. **Container runtime.** Installs `podman` and `podman-compose` if missing.
2. **Web address.** Asks for the public hostname. With one, Caddy fetches a Let's Encrypt certificate (ports 80 and 443 must be reachable and DNS must already point here). Without one, it asks for an HTTP port and serves the app on the server's IP.
3. **Admin account.** Username and password. Leave the password blank to have one generated; it is printed at the end. On a re-run, blank keeps the existing password; typing one resets it.
4. **AI assistant.** Detects RAM and proposes a model. The tiers:

   | RAM | Model | Notes |
   |---|---|---|
   | under 3.5 GB | `qwen2.5:0.5b` | subject lines and light rewrites |
   | 3.5 to 6 GB | `qwen2.5:1.5b` | the pick for a 4.5 GB VPS |
   | 6 to 10 GB | `qwen2.5:3b` | noticeably better tone |
   | 10 to 20 GB | `qwen2.5:7b` | strong writing, slow on CPU |
   | 20 GB and up | `qwen2.5:14b` | best quality, wants a GPU |

   Any model from ollama.com/library works; type its name instead, either
   short (`gemma3:4b`) or fully qualified (`ollama.com/library/gemma3:4b`) —
   Ollama keeps the long form as its own entry, so set the model field to
   whichever spelling you pulled. If an NVIDIA GPU with the container toolkit
   is present, it offers to use it.

   **Reasoning models** (qwen3, qwen3.5, deepseek-r1 and the like) work an
   answer out before writing it. Tern turns that off, because a short reply
   length can be used up entirely on the working-out and leave no message
   behind. If you want it on, Admin → AI model has "Let reasoning models
   think" — raise the reply length well above the default when you do, and
   note that the reasoning is never put into a draft.
5. **Mail server.** Whether to run Stalwart on this box. Say no if you use Fastmail or a mail server elsewhere. If yes, it asks for the mail domain, the mail hostname, and whether to create a first mailbox.
6. **Configuration.** Writes `.env` (secrets are generated once and kept), `deploy/generated/Caddyfile`, and opens firewall ports if `ufw` is active.
7. **Build and start.** Builds the app image, starts Postgres, the app, Ollama and Caddy, creates the admin user, downloads the model, and bootstraps Stalwart if enabled.
8. **Boot.** Installs a systemd unit so the stack starts after a reboot.

It ends with the URL and credentials. With Stalwart enabled it also prints the
mail server's admin login and a numbered DNS walkthrough; the same guide with
live verification is in the app under Admin → Mail server, and
[DNS.md](DNS.md) explains every record.

Run `sudo ./install.sh` again to change anything. It re-reads `.env`, offers each previous answer as the default, and only restarts what changed.

Before starting anything the installer checks that the ports it needs are free (80 and 443, plus 25, 465, 587, 993 and 4190 with the mail server). A leftover Postfix or Exim on port 25 is the usual conflict; the installer names the service and offers to stop and disable it.

Non-interactive installs: `sudo ./install.sh --yes` takes values from `.env` or `TERN_*` environment variables (`TERN_APP_URL`, `TERN_ADMIN_USER`, `TERN_ADMIN_PASSWORD`, `TERN_AI_MODEL`, `TERN_STALWART_ENABLED`, ...).

## 3. Sign in and connect a mailbox

Open the URL, sign in, then **Settings → Accounts → Add account**.

- **Fastmail**: paste an API token (Settings → Privacy & Security → Integrations → API tokens, with Mail read/write).
- **Stalwart (this server)**: the address and password of the mailbox the installer created. The session URL is filled in.
- **Other JMAP**: the session URL (usually `https://host/.well-known/jmap`) and either a password or a bearer token.

"Test connection" verifies the credentials before saving. The first sync pulls the newest 3,000 messages and takes a minute or two; mail appears as it arrives.

## 4. Set the sending policy

Each account carries its own policy under **Settings → Accounts → Edit → Sending policy**:

- **Daily cap**: automated sends per day. Start a new mailbox at 20 to 30.
- **Send window**: hours and days in a timezone, so follow-ups land during the recipient's working day.
- **Randomised delay**: on by default. Each automated send waits a random gap in the range you set, so messages leave at irregular intervals.

These apply to sequences and to "Send with a natural delay". Manual sends are never blocked.

## 5. Import contacts and start a sequence

1. **Contacts → Import CSV.** Drop any export. Columns are matched automatically; confirm the mapping, name any extra columns to keep them as merge fields, tag the batch, and record the consent source.
2. **Templates → New template.** Write with `{{first_name|there}}`, `{{company}}`, and your own fields. Preview against a real contact.
3. **Sequences → New sequence.** Pick the sending account, add email and wait steps, enroll by tag, and activate. The overview page shows what went out and who replied.

## 6. Turn on the assistant

**Settings → AI** shows whether Ollama is reachable and the model is installed, and lets an admin pull other models. **Keep model loaded** takes a duration with a unit (`30s`, `10m`, `1h`) or a plain number of seconds, where `-1` never unloads it and `0` unloads it straight after each request. In the composer, **Draft with AI** opens the assistant; in a thread, **Summarize**.

For sequences, a step's **AI personalise** switch has the model write each contact's message from the template brief and the contact's fields and notes. With the sequence's AI mode on **Review** (the default), those drafts wait in **AI review** for approval.

## 7. Let the model answer mail

**Responders → New responder.** Start in *Draft* mode: each matching message
gets a suggested reply in its thread and under Drafts, and you press Send.
Use "Try it" to see what it would write to your latest message. Switch to
*Review* or *Send automatically* once the tone is right. Details and safety
valves are in [CUSTOMIZING.md](CUSTOMIZING.md#ai-responders).

## 8. Add your team

**Admin → Users.** Create accounts directly, or make an invite link and
send it; the person picks their own password. Open self-registration is a
switch on the same page, off by default.

## 9. Keep it running

| Task | Command |
|---|---|
| Update to the latest code | `./update.sh` |
| Logs | `./bin/tern logs app` (or `db`, `ollama`, `caddy`, `stalwart`) |
| Status | `./bin/tern ps` |
| Health check with fixes suggested | `./bin/tern doctor` |
| Lift Stalwart's automatic IP bans | `./bin/tern stalwart-unban` |
| Backup database and `.env` | `./bin/tern backup` |
| Restore | `./bin/tern restore backups/tern-backup-….tar.gz` |
| Reset a password | `./bin/tern cli set-password --username alice --password '…'` |
| Disable someone's 2FA | `./bin/tern cli disable-totp --username alice` |
| Pull a model | `./bin/tern pull-model qwen2.5:3b` |
| Give everyone their own AI slot | `./bin/tern ai-slots` |

Back up `.env` with the database: `ENCRYPTION_KEY` in it decrypts the stored mailbox credentials.
