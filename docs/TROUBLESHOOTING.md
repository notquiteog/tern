# Troubleshooting

## Where to look

```bash
./bin/tern ps                 # container status
./bin/tern logs app           # application log (sync, sends, errors)
./bin/tern logs caddy         # TLS and proxy
./bin/tern logs ollama        # model loading
./bin/tern logs stalwart      # mail server
./bin/tern cli stats          # row counts
```

Settings → Accounts shows each mailbox's sync state and last error; Settings
→ AI shows whether the model server is reachable and the model installed;
Admin → Audit log shows the audit log.

## The site does not load / certificate errors

- DNS must point at the server before Caddy can get a certificate. Check `dig
  +short your.host`; then `./bin/tern logs caddy` for `obtaining certificate`.
- Ports 80 and 443 must be open at the provider firewall and on the box.
- Behind another proxy or a CDN, set `SITE_ADDRESS=:80` in `.env`, terminate
  TLS there and keep `APP_URL` as the public https URL.

## "The session URL points at a private or internal address"

The server refuses to connect to mail servers, SMTP hosts or key directories
on loopback, private (10/8, 172.16/12, 192.168/16), link-local or
carrier-NAT addresses, and to names without a dot, so a signed-in member can
never make it talk to the other containers. The bundled Stalwart is the one
exception. If your JMAP server really lives on your LAN, set
`ALLOW_PRIVATE_NETWORK_HOSTS=true` in `.env` and `./bin/tern up`; every
member can then connect any reachable host, so only do this on a trusted
network. A public hostname that resolves to a private address (split-horizon
DNS on the server) trips the same check.

## "Mail server rejected the credentials"

- Fastmail: the API token needs Mail read/write scope; tokens are shown once.
- Stalwart: use the full address (`alex@team.example.com`) and the mailbox
  password, or an app password.
- After changing a password, edit the account in Tern and enter the new one;
  syncing resumes automatically.

## Mail is syncing but sending fails

- "Blob upload failed" or "Send rejected": the server refused the message.
  For Stalwart, check the account is allowed to send (`emailSend`) and that
  the From address is one of its identities.
- "no JMAP submission": the server cannot send over JMAP; add SMTP details
  under Edit account → Connection.
- Sequence steps show their last error in the enrollments table; they retry
  every 30 minutes.

## Sequence is active but nothing goes out

In order of likelihood:

1. The send window is closed (see the account card on the Overview page).
2. The daily cap is reached.
3. The contact is unsubscribed, bounced or on the suppression list.
4. The sequence's AI mode is Review and the drafts are waiting under AI review.
5. The account is paused.

The enrollments table shows each contact's status and next send time.

## Replies are not detected

Replies are matched by threading headers and by the sender's address. If the
reply came from a different address than the one enrolled, add that address
as a contact or merge it manually. Auto-replies (`Auto-Submitted`) are ignored
on purpose.

## The assistant is slow or unavailable

- On a CPU-only 4.5 GB box a 1.5B model takes 10 to 30 seconds for a draft.
  The first request after ten idle minutes also has to load the model.
- "not downloaded": pull it under Settings → AI or `./bin/tern pull-model`.
- Out of memory: pick a smaller model, or lower `OLLAMA_MEM_LIMIT` so the
  container is limited before the host swaps.
- **"The assistant is busy answering other people right now"**: every slot is
  generating and the queue is full. Admin → AI model shows how many slots
  there are, how many people can sign in, and what each slot costs in memory;
  `./bin/tern ai-slots` raises the count to one per person as far as memory
  allows. It is also the honest answer on a small box — a CPU that can write
  one email at a time cannot write five.
- **Drafts crawl when several people are working**: the slots share the same
  cores, so each generation is slower when more than one runs. A smaller
  model, a smaller context window (each slot holds its own), or a GPU are the
  three ways out; the meter on Admin → AI model shows which of them you are
  short of.

## Stalwart

- Admin panel over an SSH tunnel: `ssh -L 8080:127.0.0.1:8080 server`, then
  `http://127.0.0.1:8080/admin`.
- Start with `./bin/tern doctor`: it checks every container, the Stalwart
  API, the listener Caddy uses, the certificate, DNS, ports and disk, and
  names the command that fixes each problem.
- `https://mx1.example.com/admin` (or the MTA-STS policy) answers **502**
  while mail still flows: Stalwart has banned the address the request came
  from, or Caddy is pointed at a listener that does not exist yet. Caddy
  talks to a dedicated PROXY-protocol listener on port 8081 so Stalwart sees
  each visitor's real address and bans only them; `./bin/tern
  stalwart-trust-proxy` creates that listener and allow-lists our own
  containers, `./bin/tern stalwart-unban` lifts existing bans, and
  `./update.sh` regenerates the Caddyfile.
- Lost the admin password: set `STALWART_RECOVERY_MODE=1` and
  `STALWART_RECOVERY_ADMIN=recovery:newpass` in `.env`, `./bin/tern up`,
  fix things via the panel on port 8080, then clear both and `./bin/tern up`.
- No TLS on SMTP/IMAP: `./bin/tern cert-sync` after Caddy has the
  certificate for the mail host; it exits 2 if Caddy does not have it yet.
- Not receiving mail: port 25 inbound, MX record, and `./bin/tern logs stalwart`.
- Not delivering: port 25 outbound, reverse DNS, SPF/DKIM published.

## Recovery

- Lost admin password: `./bin/tern cli set-password --username admin --password '…'`.
- Locked out by 2FA: `./bin/tern cli disable-totp --username admin`.
- Restore a backup: `./bin/tern restore backups/tern-backup-….tar.gz`. The
  backup's `.env` carries the `ENCRYPTION_KEY`; without the original key,
  stored mailbox credentials cannot be decrypted and must be re-entered.
- Full reset: `./bin/tern down`, `podman volume rm tern_tern-db`, `./install.sh`.
