# What Tern stores, and for how long

Tern is a client for a mailbox that lives somewhere else. Everything below is
about Tern's own database; the mail server (Fastmail, Stalwart or another
JMAP host) keeps the mail itself under its own rules.

## Nothing here reads your mail until you say so

Every feature that reads a mailbox for a purpose other than showing it to its
owner, and every feature that reaches the language model, is off for a new
account and stays off until that person turns it on in **Settings →
Features**. There is no "recommended" preset and nothing is opted in by an
upgrade.

Two switches have to be open for any of it to run:

- **The person's own consent**, per feature, recorded with the moment it was
  given. Turning one off *erases what it produced* — the meaning index, the
  priority scores, the guard's flags, the extracted attachment text, the
  commitments, the brief — in the same request. It is not a pause.
- **The install's own switch**, which an administrator can close at any time
  from Admin → Features. Closing it stops the background work within about
  twenty seconds and makes the routes refuse, and it leaves everybody's
  consent alone, so re-opening restores what people had already chosen.

This is enforced by the type system rather than by convention. The two
functions that can decrypt a message take a `reader` argument that is either
`'owner'` or a named capability, and the three that can reach the model take
a `consent`; both are required, so a code path that forgets to ask does not
compile. `services/capabilities.test.ts` then walks the source for the one
hole types cannot close — the raw data key — and holds it to an allow-list.
`e2e/features.e2e.ts` checks the whole thing against a real database.

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
| `review_queue`, `ai_jobs` | AI review and responder runs | The payload of an AI job — the copy of the message it was asked about — is emptied the moment the job stops running, not at the next sweep. Rows: decided reviews 7 days, finished jobs 12 hours. Both are settings under Admin → Retention |
| `email_vectors` | Meaning search. Each row is a keyed projection of one message's embedding, never the embedding: rotated with a pattern derived from your own data key and then cut from 1024 coordinates to 256, so distances survive and the axes an inversion attack needs do not. 256 bytes per message | Until you turn meaning search off, which deletes all of it |
| `triage_models` | Priority ordering. A weight vector over the hashed terms already in your search index — no message text is read to build it. Sealed with your key like anything else learned from your mail | Until you turn priority ordering off |
| `emails.guard_flags`, `guard_detail` | The impersonation guard. The flags are a fixed vocabulary and are stored as they are; anything naming a domain or a person is sealed | Until you turn the guard off |
| `attachment_text` | Searching inside attachments. The extracted words, sealed, and folded into the same blind index as the body. File names are sealed too | Until you turn it off, or the message is deleted |
| `commitments`, `commitment_scans` | What you promised and what you are waiting on. Text and counterparty sealed; dates and state are not, because the list is ordered and counted by them | Closed items purged after 14 days; all of it on turning the feature off |
| `briefs` | One per person, sealed, replaced in place. A cache of a page rather than a record of anything | 7 days, or on regeneration |
| `calendar_events` | Invitations found in mail. Everything a person would read is sealed; the times are not, because the list is ordered by them and clashes are found with them | 60 days after the meeting |
| `mail_imports` | Progress of an archive import. Counts only — the archive itself is held in memory for the length of the run and never written to disk | 7 days after it finishes |
| `user_capabilities` | Which features each person has turned on, and when | Until revoked or the account is deleted |
| `audit_log`: who did which admin or security action, when; successful and failed sign-ins with the method and the client name (never an address) | Accountability; spotting someone guessing at an account | 365 days; a deleted user's rows keep the action but lose details |
| `invites` | Registration links | Purged 30 days after use or expiry |
| Brand logos | BIMI | Until removed by an admin |
| `vacation_replies`: per mailbox, the addresses that received the out-of-office reply and when | So each person is answered once per interval | Until the account is removed |
| OpenPGP keys: your public key, your private key passphrase-protected and wrapped with the server key, other people's public keys | Encrypting mail, sign-in with the key | Until you remove them |

Retention runs from the scheduler once an hour (`workers/scheduler.ts`,
`housekeeping`). Every window above is a setting under **Admin → Retention**,
with defaults chosen as the shortest each feature still works with rather
than as a round number. The two that hold mail content — a queued AI job's
prompt and a decided review's copy of the message — have their content
emptied when they stop being needed, so the window applies to the row rather
than to the text.

## Dictation, if it is installed

A recording never touches disk on either side. It exists as one buffer in the
browser, goes up as the request body, and the server zeroes that buffer in a
`finally` before replying. The transcript is returned and forgotten: it is
not stored, not logged, and not attached to anything. The only trace a
dictation leaves is a log line with a byte count and a duration.

## Pictures and video, if they are configured

The one feature here whose model is somebody else's machine by default. There
is no bundled image server, so the prompt someone types in the composer goes
to whatever host the administrator configured — and that is said plainly on
the card an administrator sets up and again beside the box a person types in,
rather than left to be inferred from an address only an administrator can see.

What goes: the sentence, the size, and nothing else. No message, no thread, no
contact, no address book. The connection has its own Tor switch, so an install
that would rather not hand its own address to a company it is buying pictures
from can turn that on for this connection alone.

What comes back is stripped before it is stored. Several hosts write the
prompt into the picture's own EXIF; that goes through the same metadata scrub
as a photo dragged in from a phone, so it does not travel with the message.
The prompt itself is not stored anywhere on this server: it is not written to
the upload row, not logged, and not kept with the generation.

## What the model is holding

A generation is a session, and it ends when the last token arrives. The
prompt is dropped there — the message array is emptied and each message's
content replaced — so nothing downstream is still holding the text of an
email. Prompts and completions are never logged, never written to a job row,
and never attached to an error.

Ollama also keeps the prompt in its own KV cache for as long as the model
stays resident, which by default is ten minutes after the last request. With
**wipe after use** on (the default), an idle timer unloads the model once
nothing is generating, so that copy goes too. The grace period exists so that
somebody working through their inbox is not paying a model load per message.

### Changing the embedding model removes the old index

Vectors are stored per user and per embedding model, so switching embedder
writes into a new index rather than mixing two geometries. The other end of
that bargain is that the previous one is dropped in the same action — it is not
kept "just in case", and it is not left to be tidied up later. Nothing can read
it once the setting changes (search is scoped to the model that made the
vectors), and a copy of your mail's meaning that nothing will ever read is
exactly the sort of thing that should not survive.

Three things now remove vectors, and between them they cover every way the
question can be asked: turning **Meaning search** off erases your whole index,
deleting your account takes it with everything else, and changing the model
drops what the previous one built. If the index service is unreachable at that
moment the erase is not abandoned — the change still goes through, the failure
is logged loudly, and `./bin/tern vectors-sweep` clears whatever was left.

### The assistant is the exception, and here is exactly how far it goes

Everything above is true of every feature except one. A conversation with the
assistant is *kept*, because a conversation you cannot ask a follow-up question
in is not a conversation. This is the only place in Tern where what was said to
a model outlives the request, so it is worth being precise about what that
means.

**What is stored**: your messages, the assistant's replies, and the results of
the tools it ran on your behalf — which include real paragraphs of your mail,
because that is what it went and read. Also any draft or picture it proposed.

**How**: every one of those columns is sealed with your own data key, exactly
as your mail is, in `ai_conversations` and `ai_messages`. Three columns are
left readable — the role (one of three words), the tool's name (one of eight
known strings) and a random call id — because they carry no content and are
what lets a transcript be put back in order and checked for shape without
opening it first.

**What is not stored**: the model's working-out. A reasoning model's thinking
is streamed to your browser so a slow answer looks like something happening,
and then it is gone. It is not part of the answer and storing it would double
the size of a transcript with the part nobody wants to read back.

**What you can do about it**: every conversation is listed in the panel, any
one of them can be deleted, all of them can be deleted at once, and turning
*The assistant* off in Settings → Features erases the lot in the same request.

**What the model was asked to do with it** is your own setting, where an
administrator has allowed that. Reasoning — the model working an answer out
before writing it — is a trade of speed for accuracy, and it is applied once on
the server to everything done in your name. The working-out itself is never
stored, on any path.

**Spoken replies** are not stored either. The text of an answer goes to
whichever voice the administrator configured and the audio comes straight back
to your browser; nothing is written down on this server, and nothing is cached
on the way — the response carries `no-store`, because a clip of the assistant
reading your mail is a copy of that mail in a form nothing here could reach to
delete.

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
