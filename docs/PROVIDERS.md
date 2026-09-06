# Mail providers

Tern talks JMAP. Any server that implements RFC 8620 and RFC 8621 works; the
three below are the ones the add-account form has presets for.

## Fastmail

The easiest path. Fastmail hosts the mailbox, signs with DKIM and delivers
from its own reputation. You host only Tern.

1. In Fastmail, add your domain (Settings → Domains) and publish the MX, SPF
   and DKIM records it shows. For outreach, use a subdomain such as
   `team.example.com` so the root domain's reputation is insulated.
2. Create a user per sending identity, for example `alex@team.example.com`.
3. As that user: Settings → Privacy & Security → Integrations → **New API
   token**, with **Mail** read and write scope. Copy the token.
4. In Tern: Settings → Accounts → Add account → Fastmail → paste the token →
   Test connection → Connect.

Fastmail sends through JMAP submission; nothing else to configure. It has its
own per-account sending limits, so keep the daily cap modest.

## Stalwart on this server (bundled)

Say yes to "Run a Stalwart mail server here?" in the installer. It:

- starts Stalwart beside Tern, with SMTP (25, 465, 587), IMAP (993) and
  ManageSieve (4190) published, and its HTTP interface reachable only from
  Caddy and from `127.0.0.1:8080` on the host;
- bootstraps it with your mail hostname and domain, generates DKIM keys, and
  prints the admin credentials (also kept in `.env`);
- optionally creates the first mailbox;
- proxies `https://<mail host>/admin` and the JMAP endpoints through Caddy,
  which obtains the certificate;
- copies that certificate into Stalwart for SMTP and IMAP TLS (`./bin/tern
  cert-sync`, run daily by a systemd timer).

### Before it can receive or deliver mail

Everything below is outside the box and cannot be automated by the installer.

1. **Port 25 in both directions.** Many providers block it on new servers.
   Hetzner opens it after the first paid invoice, on request. OVH, RackNerd,
   Contabo and Hostinger have it open from the start. DigitalOcean, Vultr,
   AWS, Azure and Google Cloud block it (some open it by ticket). Njalla
   blocks it outright.
2. **Reverse DNS.** Set the server IP's PTR record to the mail hostname in
   your provider's panel. Gmail rejects mail from hosts whose forward and
   reverse names disagree. Check with `dig -x <ip>` and `dig <mail host>`.
3. **Publish the DNS records.** Admin → Mail server lists every record
   with a purpose and a live check, and [DNS.md](DNS.md) walks through them:
   the `A` record and reverse DNS for the mail host, `MX`, SPF, two DKIM
   keys, DMARC, then MTA-STS and TLS-RPT for encryption, BIMI for a brand
   logo, and the autoconfig records for mail apps.
4. **A clean IP.** Check the address on Spamhaus, UCEPROTECT and MXToolbox
   before the first send; reprovision the VPS if it is listed.
5. **Warm up.** Twenty to thirty sends a day for the first two weeks, then
   raise the cap gradually.

### Creating more mailboxes

Admin → **Mail server** creates mailboxes, generates passwords,
and connects them to Tern users or creates the user in the same step. The
DNS records for the domain are shown there too. The same is available as
`./bin/tern cli add-mailbox --address sam@team.example.com --user sam`.

### Connecting the mailbox to Tern

Settings → Accounts → Add account → **Stalwart (this server)**. The session
URL is prefilled with the internal address; enter the mailbox address and
password. Tern reaches Stalwart over the compose network in plain HTTP,
which never leaves the host.

### Managing Stalwart

- Admin panel: `https://<mail host>/admin`, or `http://127.0.0.1:8080/admin`
  over an SSH tunnel.
- Raw API: `./bin/tern stalwart-api '[["x:Account/get",{"ids":null},"c1"]]'`.
- Add another domain or mailbox from the panel; DKIM keys are generated
  automatically for new domains.
- Relaying outbound through SES or Mailgun instead of delivering directly:
  in the panel, Delivery → Routes, add a **Relay host** route with the
  provider's SMTP host, port 587 and credentials. Inbound stays on your box.
- Logs: `./bin/tern logs stalwart`.

## Stalwart elsewhere, or any other JMAP server

Add account → **Stalwart** or **Other JMAP server**. Enter the session URL,
normally `https://host/.well-known/jmap`, and how it authenticates:

- Stalwart: HTTP Basic with the mailbox address and password, or an app
  password created in the account settings.
- Cyrus, Apache James, Twake and others: whatever the server documents;
  Basic and Bearer are both supported.

**Rewrite advertised URLs**: some servers publish JMAP URLs built from a
public hostname that the Tern container cannot resolve (a server on the same
LAN, or reached through a tunnel). Turn this on and Tern rewrites the API,
upload, download and push URLs to the host in the session URL. The Stalwart
preset enables it by default.

**No JMAP submission**: if a server can read mail over JMAP but not send,
add SMTP details under Edit account → Connection → SMTP fallback. Tern sends
over SMTP and still files the copy in Sent through JMAP.

## Web app and mail on one domain

The site, the mailbox domain and the mail host are separate DNS names and do
not interfere:

| Name | Role | Records |
|---|---|---|
| `example.com`, `www.example.com` | your website, untouched | existing |
| `outreach.example.com` | Tern web app | `A` to this server |
| `team.example.com` | mailbox domain (`alex@team.example.com`) | `MX`, SPF, DKIM, DMARC |
| `mx1.example.com` | mail server hostname | `A`, reverse DNS |

Put `v=spf1 -all` and a `_dmarc` record with `p=reject` on any name that
should never send mail, including the root, so nobody can spoof it while you
send from the subdomain.
