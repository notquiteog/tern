# Calendar

Tern syncs the calendars you already use rather than asking you to move to a
new one. Four kinds of source, two of which need nothing from an
administrator:

| Source | Protocol | Two-way | Live |
| --- | --- | --- | --- |
| iCloud, Fastmail, Nextcloud, Radicale, SOGo, Baikal, Synology… | CalDAV (RFC 4791) | yes | polled |
| Google Calendar | Calendar API v3 | yes | push |
| Outlook / Microsoft 365 | Microsoft Graph | yes | push |
| A published `.ics` or `webcal://` address | plain HTTP | no | polled |

There is no single protocol behind "live calendar sync", and anyone who tells
you otherwise is selling one integration and calling it three. Microsoft
removed CalDAV from Exchange Online years ago, so Graph is not a preference
there — it is the only door. Google still speaks CalDAV but its own API is the
only path with sync tokens and push. And CalDAV has no push at all: the one
extension is Apple's, and it delivers over APNs to Apple devices.

So Tern does what each provider actually supports, and the parts that differ
are three files under `server/src/services/calendar/`.

## What "live" means here

Push where it exists, polling as the floor, and the floor is cheap.

- **Google and Microsoft** are asked for a webhook per calendar. The
  notification carries no event data — only that something moved — and echoes
  back the secret its channel was created with, which is checked before
  anything is synced. A calendar with a working channel drops to a fifteen
  minute safety poll.
- **CalDAV** is polled with a `sync-collection` REPORT carrying the last sync
  token (RFC 6578). That is one small request that almost always returns an
  empty list, which is why a five-minute poll costs about as much as a
  heartbeat. Servers that do not implement it fall back to comparing etags.
- **Subscriptions** are conditional `GET`s: with an `ETag` or a
  `Last-Modified`, almost every poll is a 304 with no body. They are never
  fresher than the publisher makes them, which is typically fifteen minutes to
  a day and is not under this server's control.

Webhooks need a public https address. An install on plain http or behind a
LAN keeps polling, and the admin page says so rather than leaving you to
wonder why nothing is instant.

## Setting up Google and Outlook

**Tern ships no OAuth credentials of its own.** Whoever runs the server
registers an app, under **Admin → Calendar**, which shows the exact redirect
URI to paste into each console.

This is a deliberate cost. Shipping a client ID would make this project the
party Google and Microsoft hold responsible for every install's calendar
access, put every deployment behind one verification review and one shared
rate limit, and show your people a consent screen carrying a stranger's name.
Ten minutes in a console keeps the relationship between the company holding
the calendar and the people whose calendar it is.

CalDAV and subscribed addresses need none of this and work on a fresh install.

## What is stored, and what leaves

Events live on your server, sealed with your own key exactly like your mail:
titles, locations, descriptions, guest lists and the raw iCalendar are all
encrypted at rest and unreadable in a `psql` session.

**Times are not encrypted.** The grid is ordered by them and free/busy is
computed from them, and an encrypted timestamp can do neither. What that
leaks to somebody holding the database but not the key is that you were busy
from two until three — the price of the feature working at all.

Connecting a calendar does send your events to and from that provider. That
is the entire point of the feature, it is the one place data crosses the
boundary, and the consent switch under Settings → Features says so in those
words. Turning it off deletes the connections and everything synced through
them.

## What else uses it

The calendar is not a page that sits by itself. Once one is connected:

- **Proposing times** (`Suggest times` in the composer, and the invitation
  card) works from real free/busy rather than only from invitations that
  happened to arrive by mail. Before this, Tern would cheerfully offer a slot
  you were already in a meeting for — it had no way to know.
- **The assistant** is given the next few working days as busy and free
  periods when it writes a reply, a reschedule or a nudge. **Times only,
  never titles**: it is told "busy 14:00–15:30 on Thursday", not what the
  meeting is. A language model does not need your diary to avoid
  double-booking you.
- **Answering an invitation** puts the meeting in your calendar, which is
  what accepting one means everywhere else. A declined invitation still goes
  in — recorded as declined, so it shows in the day without blocking the
  time.
- **The daily brief** opens with what is actually on today.
- **Invitation clashes** are checked against the calendar as well as against
  other invitations.

## How recurrence is handled

Properly, which is most of the work. `services/calendar/recurrence.ts`
implements RFC 5545 expansion — `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`,
`BYDAY` with ordinals, `BYMONTHDAY`, `BYYEARDAY`, `BYMONTH`, `BYWEEKNO`,
`BYSETPOS`, `WKST` — plus `EXDATE`, `RDATE` and `RECURRENCE-ID` overrides
including `RANGE=THISANDFUTURE`.

Two things it gets right that a simpler implementation does not:

- **Expansion runs on the wall clock, not on elapsed time.** A nine o'clock
  stand-up is at nine before the clocks change and at nine after, which is a
  different number of hours. Getting this wrong moves a recurring meeting by
  an hour twice a year for half the year.
- **A monthly on the 31st skips the months without one** rather than clamping
  to the 30th, which would invent a meeting that does not exist.

Occurrences are materialised into `calendar_instances` over a rolling window
(120 days back, 550 forward) and extended by a sweep, so "who is free on
Thursday" is one indexed query rather than a recurrence expansion per row.

## Changing one meeting, or all of them

Editing or deleting an occurrence of a series asks which ones it applies to,
because "cancel the stand-up" meaning this Tuesday and meaning for ever are
the same sentence and different actions.

- **This occurrence** writes a `RECURRENCE-ID` override into the same event.
  The override is seeded from the master, so a client reading only it still
  sees a complete meeting.
- **This and all later ones** splits the series: the original is truncated
  with an `UNTIL` the moment before, and a new event carries the change
  forward. Editing the master in place would rewrite history — last month's
  stand-up would retroactively have been at eleven. A counted series has its
  `COUNT` divided between the halves, or five meetings become seven.
- **Every occurrence** edits the master, as before.

Deleting one occurrence writes an `EXDATE` rather than a cancelled override:
it is the shorter statement and every client understands it. Deleting "this
and later" truncates rather than erasing, so the past is left alone.

## Guests

Adding people to an event records them on it. **Emailing them an invitation
is a separate switch**, off by default, and that is deliberate: most Exchange
and CalDAV servers do their own scheduling and will send invitations
themselves when the event is pushed to them. Two invitations for one meeting
is worse than none, so Tern asks rather than assumes.

When it is on, Tern sends a proper iTIP message (RFC 5546) from your own
address, through the ordinary send path — so it inherits the account's
sending window, pacing and log like any other message. Creating or changing
an event sends `METHOD:REQUEST`; deleting one sends `METHOD:CANCEL`, naming
the single occurrence where only one was cancelled. Replies coming back are
read by the invitation reader that already existed.

The calendar part travels twice: as a `text/calendar` alternative beside the
HTML, which is what draws Accept and Decline buttons in Outlook, Gmail and
Apple Mail, and as an `invite.ics` attachment, which is what everything else
lets you open by hand. Your own reminders are stripped from the copy that
goes out — an alarm is the sender's business, not the guests'.

Tern is not a scheduling server. It does not maintain anybody else's attendee
list and does not speak CalDAV scheduling.

## Reminders

A `VALARM` on an event becomes a notification through the same web push the
mailbox uses. Reading and writing both work, so a reminder set in Tern shows
up in Apple Calendar and the other way round.

The sweep runs every minute — a reminder that is late is not a reminder — and
only ever announces an occurrence once, whatever the notification did. It
will not fire for anything that started more than a quarter of an hour ago,
so a server that was off overnight does not wake up and deliver two hundred
notifications for meetings that already happened; and occurrences that were
already in the past when their event was first synced are never announced at
all, so importing a year of history is silent.

Only `DISPLAY` and `AUDIO` alarms with a relative trigger are kept. An
`EMAIL` or `PROCEDURE` alarm is somebody else's automation and is left where
it was found.

## Somebody else's availability

Proposing a time reads the guests' calendars as well as yours, where a
connected account can answer for them — Google and Microsoft both offer a
free/busy query. Times only: the answer is opaque blocks, never what is in
them.

CalDAV has no equivalent that most self-hosted servers implement, and an
address outside your organisation usually cannot be answered for at all.
Those come back **named as unchecked** rather than treated as free, and the
picker says so, because "everyone is free at three" and "you are free at
three and I could not check the others" are different claims.

## Two people editing the same event

A local change is written to the far side under the etag it was read at
(`If-Match`, or `If-None-Match: *` on a create). If the server says that etag
has moved on, **the far side wins** and the local edit is refused. A calendar
is shared by definition, and silently overwriting a colleague's change to a
meeting is worse than an error message.

Edits made while the network is down are kept and pushed on the next sync,
so an event created on a train is not lost.

## Troubleshooting

**"Needs reconnecting"** — the OAuth grant was revoked, or the refresh token
expired. A Google app still in "testing" expires refresh tokens after seven
days; publishing it stops that.

**A CalDAV server connects but shows no calendars** — the address may point
at a collection that holds only tasks or notes. Tern skips collections whose
`supported-calendar-component-set` excludes `VEVENT`.

**A Nextcloud or Radicale on the LAN is refused** — outbound requests to
private addresses are blocked by default, for the same reason a JMAP server
is (`server/src/util/netguard.ts`). Turn on "Allow CalDAV servers on this
network" under Admin → Calendar if you run one here.

**Nothing is instant** — check Admin → Calendar. If `APP_URL` is not https,
no provider can deliver a webhook and everything is polled.

**Guests got two invitations** — the calendar's own server sent one and so
did Tern. Turn off "Email the guests an invitation" when saving to a server
that schedules for itself, which most Exchange and CalDAV servers do.

**No reminders arrive** — notifications have to be allowed in the browser
first (Settings → Security shows whether this device is subscribed), and the
event needs a reminder set on it. Tern never invents one.
