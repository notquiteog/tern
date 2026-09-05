# Architecture

One app container, one database, one model server, one reverse proxy, and
optionally one mail server. No message queue, no Redis, no external service
in the mail path.

```
browser ──HTTPS──▶ Caddy ──▶ app (Express + workers) ──▶ PostgreSQL
                     │            │        │
                     │            │        └──HTTP──▶ Ollama (local LLM)
                     │            └──JMAP over HTTPS──▶ Fastmail / any JMAP server
                     └──HTTPS──▶ Stalwart (optional, same box) ◀──JMAP over the compose network── app
```

## Server (`server/src`)

| Area | Files | Notes |
|---|---|---|
| HTTP | `app.ts`, `routes/*` | Express 5. JSON API under `/api`, SSE at `/api/events`, public unsubscribe at `/u/:token`, static client with SPA fallback. Every mutating call needs the `X-Requested-With: tern` header (CSRF). |
| Auth | `auth.ts`, `routes/auth.ts`, `crypto.ts`, `pow.ts` | Server-side sessions in Postgres, scrypt passwords, TOTP with recovery codes, login throttling. Sign-in, registration and setup require a proof of work: a signed, single-use SHA-256 challenge bound to the form and username, whose difficulty rises with recent failures for that username and with the global request rate (15 to 22 leading zero bits). Mailbox credentials are AES-256-GCM encrypted with `ENCRYPTION_KEY`. |
| JMAP | `jmap/client.ts`, `jmap/sync.ts`, `jmap/actions.ts`, `jmap/send.ts` | A small RFC 8620/8621 client. Sync is Email/changes-driven with a full resync fallback; actions patch keywords and mailbox membership; sending builds raw MIME once (nodemailer's stream transport) and submits it with Email/import + EmailSubmission/set, or SMTP as a fallback. |
| Workers | `workers/syncManager.ts`, `workers/scheduler.ts` | One runner per account holds a push (EventSource) connection and a poll timer. The scheduler ticks every 20 s for sequence steps, scheduled sends and snoozes, claiming rows with guarded conditional updates. |
| Outreach | `services/compose.ts`, `services/sending.ts`, `services/automation.ts`, `services/merge.ts` | Every outgoing message goes through `composeAndSend`, which logs to `send_log`. `reserveSendSlot` enforces cap, window and jitter. Automation runs on new mail: reply and bounce matching, contact linking, "stop" handling, rules. |
| AI | `ai/llm.ts`, `ai/prompts.ts`, `ai/models.ts` | Streams from Ollama's `/api/chat` or an OpenAI-compatible endpoint. Prompts are built from the mode plus the thread, recipient facts and draft. Model tiers by RAM are shared with `install.sh`. |
| Data | `db.ts`, `migrations.ts` | `pg` with raw SQL; migrations are TypeScript strings applied on start under an advisory lock. |

### The local mail cache

`emails` holds a copy of every synced message: headers, parsed addresses,
text and HTML bodies, attachment metadata, keywords and mailbox ids. Threads
are a `GROUP BY (account_id, thread_id)`; the thread list query aggregates
unread, starred, latest message and participants in one statement. Full-text
search is a generated `tsvector` over subject and body; operators such as
`from:` map to SQL predicates in `services/search.ts`.

The server is always right. Actions update the cache optimistically, push the
change with Email/set, and ask the sync manager to reconcile.

### Reply matching

Every send records its `Message-ID`. Incoming mail whose `In-Reply-To` or
`References` contains one of ours is a reply to that send. Replies also match
by sender address for contacts with an active enrollment, because some clients
strip threading headers. Bounces match by `Message-ID` or by the failed
address appearing in the report body.

## Client (`client/src`)

React 19, react-router, TanStack Query, no CSS framework. `styles/app.css`
holds the design tokens and every component style; light and dark share
token names. `components/DataTable.tsx` renders every list as a table on
wide screens and as a stack of cards on phones; `lib/powSolver.ts` is the
sign-in proof-of-work solver, run in a Web Worker (`lib/pow.worker.ts`). Server events invalidate query keys so views update without
polling. HTML mail renders in a sandboxed iframe with a CSP that blocks remote
resources until the reader allows them; DOMPurify strips scripts and forms.

## Deployment

`compose.yml` runs `db`, `app`, `ollama`, `caddy`. `compose.stalwart.yml`
adds `stalwart` and wires the app and Caddy to it. `compose.gpu.yml` passes an
NVIDIA GPU to Ollama via CDI. `install.sh` writes `.env` and the Caddyfile,
builds the image, bootstraps Stalwart through its JMAP management API, and
installs a systemd unit. `bin/tern` wraps the day-to-day commands, including
`cert-sync`, which copies Caddy's certificate for the mail host into Stalwart.

Memory budget on a 4.5 GB box: Postgres ~60 MB, app ~200 MB, Caddy ~30 MB,
Stalwart ~150 MB, Ollama ~250 MB idle plus the model (1.5B q4 ≈ 1.2 GB) while
loaded. Ollama unloads the model 10 minutes after the last request.
