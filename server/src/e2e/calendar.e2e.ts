// End-to-end checks for the calendar (F13), against the dev database.
//
//   npx tsx --env-file=.env.dev server/src/e2e/calendar.e2e.ts
//   ONLY=series,busy   to run a subset
//
// These drive the services directly rather than over HTTP, because what is
// being checked is what lands in Postgres and what comes back out of it —
// the expansion, the sealing, the two-way bookkeeping and the consent gate.
// A provider is never contacted: the CalDAV, Google and Microsoft paths are
// covered by the unit tests and, in the end, only by a real account.
//
// Everything here uses a throwaway user that is deleted at the end.
import { migrate, one, pool, query, waitForDb } from '../db.js';
import { encrypt } from '../crypto.js';
import { grant, revoke } from '../services/capabilities.js';
import { eraseCapabilityData } from '../services/capabilityData.js';
import { dataKey, openWith } from '../services/vault.js';
import {
  acceptIntoCalendar, agendaFor, availabilityFor, busyIn, createEvent, createSource, dayWindow,
  deleteEvent, defaultCalendar, dueReminders, eventsIn, markNotified, updateEvent, upsertCalendar,
} from '../services/calendar/index.js';
import { storeInvitation, upcoming, freeSlotsFor } from '../services/calendarMail.js';
import { putObject } from '../services/calendar/store.js';
import { newEvent, parseCalendar, vtimeOf, writeCalendar } from '../services/calendar/vevent.js';

const ONLY = new Set((process.env.ONLY ?? '').split(',').filter(Boolean));
const results: { group: string; name: string; ok: boolean; detail?: string }[] = [];
let current = '';

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ group: current, name, ok: true }); console.log(`  ok   ${name}`); }
  catch (e: any) { results.push({ group: current, name, ok: false, detail: e?.message ?? String(e) }); console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
}
function group(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => { if (ONLY.size && !ONLY.has(name)) return; current = name; console.log(`\n== ${name}`); await fn(); };
}
function ok(v: unknown, msg = 'expected truthy') { if (!v) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg = '') { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function deep(a: unknown, b: unknown, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function throws(fn: () => Promise<unknown>, match: RegExp, msg: string): Promise<void> {
  try { await fn(); } catch (e) {
    if (match.test((e as Error).message)) return;
    throw new Error(`${msg}: threw the wrong thing — ${(e as Error).message}`);
  }
  throw new Error(`${msg}: it did not refuse`);
}

// ---------- A throwaway person with one calendar ----------

interface Fixture { userId: number; accountId: number; calendarId: number; sourceId: number }
const created: number[] = [];

async function makeFixture(): Promise<Fixture> {
  const tag = `e2ecal${Date.now().toString(36)}`;
  const u = await one<{ id: number }>(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,'Calendar e2e','x','member') RETURNING id`, [tag],
  );
  created.push(u!.id);
  const a = await one<{ id: number }>(
    `INSERT INTO accounts (user_id, name, email, provider, session_url, auth_type, auth_secret_enc)
     VALUES ($1,'e2e',$2,'jmap','http://x','bearer',$3) RETURNING id`,
    [u!.id, `${tag}@probe.test`, encrypt('e2e-token')],
  );
  await grant(u!.id, 'calendar');
  // A source that is never contacted: nothing here pushes, because every
  // write is left dirty and the worker is not running.
  const source = await createSource(u!.id, { kind: 'caldav', label: 'e2e', baseUrl: 'https://e2e.invalid/dav/', username: 'e2e', secret: 'e2e' });
  const cal = await upsertCalendar(u!.id, source.id, { remoteId: 'https://e2e.invalid/dav/work/', name: 'Work' });
  return { userId: u!.id, accountId: a!.id, calendarId: cal.id, sourceId: source.id };
}

// The prefix services/vault.ts puts on everything it seals.
const SEAL = 'k1.';

const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 16);
const soon = (days: number, hour = 10) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

// ======================================================================
const storageGroup = group('storage', async () => {
  const f = await makeFixture();

  await test('an event is stored and read back', async () => {
    const start = soon(2);
    const ev = await createEvent(f.userId, {
      calendarId: f.calendarId, summary: 'Kickoff', location: 'Room 1',
      startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    eq(ev.summary, 'Kickoff');
    eq(ev.dirty, true, 'a new event is waiting to be pushed');
    const shown = await eventsIn(f.userId, soon(1), soon(3));
    eq(shown.length, 1);
    eq(shown[0].summary, 'Kickoff');
  });

  await test('nothing readable is left in the clear', async () => {
    const rows = await query<any>('SELECT summary, location, ical, starts_at FROM calendar_objects WHERE user_id=$1', [f.userId]);
    ok(rows.length, 'there should be a row');
    for (const r of rows) {
      for (const col of ['summary', 'location', 'ical'] as const) {
        ok(r[col] === null || String(r[col]).startsWith(SEAL), `${col} is not sealed: ${String(r[col]).slice(0, 40)}`);
      }
      ok(!String(r.summary ?? '').includes('Kickoff'), 'the title is readable in the database');
      // Times are plain on purpose; the grid and free/busy are ordered by them.
      ok(r.starts_at instanceof Date, 'the start should be a plain timestamp');
    }
    const inst = await query<any>('SELECT summary FROM calendar_instances WHERE user_id=$1', [f.userId]);
    for (const r of inst) ok(r.summary === null || String(r.summary).startsWith(SEAL), 'occurrence titles must be sealed too');
  });

  await test('a title survives a round trip through the seal', async () => {
    const dek = await dataKey(f.userId);
    const row = await one<any>('SELECT summary FROM calendar_objects WHERE user_id=$1 LIMIT 1', [f.userId]);
    eq(openWith(dek, row.summary), 'Kickoff');
  });

  await test('a read-only calendar refuses a write', async () => {
    await query('UPDATE calendars SET read_only=true WHERE id=$1', [f.calendarId]);
    await throws(
      () => createEvent(f.userId, { calendarId: f.calendarId, summary: 'no', startsAt: soon(3).toISOString() }),
      /read-only/i, 'a read-only calendar',
    );
    await query('UPDATE calendars SET read_only=false WHERE id=$1', [f.calendarId]);
  });

  await test('an event that ends before it starts is refused', async () => {
    await throws(
      () => createEvent(f.userId, { calendarId: f.calendarId, summary: 'backwards', startsAt: soon(3, 12).toISOString(), endsAt: soon(3, 11).toISOString() }),
      /ends before it starts/i, 'a backwards event',
    );
  });
});

// ======================================================================
const seriesGroup = group('series', async () => {
  const f = await makeFixture();
  const first = soon(1, 9);

  const makeSeries = async () => {
    const ev = await createEvent(f.userId, {
      calendarId: f.calendarId, summary: 'Stand-up',
      startsAt: first.toISOString(), endsAt: new Date(first.getTime() + 900_000).toISOString(),
      rrule: 'FREQ=DAILY;COUNT=5',
    });
    return ev;
  };

  await test('a repeating event expands into occurrences', async () => {
    await query('DELETE FROM calendar_objects WHERE user_id=$1', [f.userId]);
    await makeSeries();
    const shown = await eventsIn(f.userId, soon(0), soon(10));
    eq(shown.length, 5, 'five occurrences');
    deep(shown.map((s) => iso(s.startsAt)), [0, 1, 2, 3, 4].map((n) => iso(new Date(first.getTime() + n * 86_400_000))));
  });

  await test('changing one occurrence leaves the others alone', async () => {
    const ev = (await query<any>('SELECT id FROM calendar_objects WHERE user_id=$1', [f.userId]))[0];
    const third = new Date(first.getTime() + 2 * 86_400_000);
    await updateEvent(f.userId, ev.id, { summary: 'Stand-up (moved)', startsAt: new Date(third.getTime() + 2 * 3_600_000).toISOString() }, { scope: 'this', occurrence: third.toISOString() });
    const shown = await eventsIn(f.userId, soon(0), soon(10));
    eq(shown.length, 5, 'still five');
    eq(shown.filter((s) => s.summary === 'Stand-up (moved)').length, 1, 'exactly one moved');
    eq(shown.filter((s) => s.summary === 'Stand-up').length, 4, 'the rest are untouched');
    eq(iso(shown[2].startsAt), iso(new Date(third.getTime() + 2 * 3_600_000)), 'the moved one is at its new time');
  });

  await test('deleting one occurrence removes only that one', async () => {
    const ev = (await query<any>('SELECT id FROM calendar_objects WHERE user_id=$1', [f.userId]))[0];
    const second = new Date(first.getTime() + 86_400_000);
    await deleteEvent(f.userId, ev.id, { scope: 'this', occurrence: second.toISOString() });
    const shown = await eventsIn(f.userId, soon(0), soon(10));
    eq(shown.length, 4, 'one fewer');
    ok(!shown.some((s) => iso(s.startsAt) === iso(second)), 'the deleted one is gone');
  });

  await test('changing this and all later ones splits the series in two', async () => {
    await query('DELETE FROM calendar_objects WHERE user_id=$1', [f.userId]);
    const ev = await makeSeries();
    const third = new Date(first.getTime() + 2 * 86_400_000);
    await updateEvent(f.userId, ev.id, { summary: 'Stand-up (new format)' }, { scope: 'future', occurrence: third.toISOString() });
    const objects = await query<any>('SELECT id FROM calendar_objects WHERE user_id=$1', [f.userId]);
    eq(objects.length, 2, 'the split makes a second event');
    const shown = await eventsIn(f.userId, soon(0), soon(10));
    eq(shown.length, 5, 'the same five occurrences, in two events');
    // The past keeps its old name; from the third on, the new one.
    deep(shown.map((s) => s.summary), ['Stand-up', 'Stand-up', 'Stand-up (new format)', 'Stand-up (new format)', 'Stand-up (new format)']);
  });

  await test('deleting this and all later ones truncates rather than erasing history', async () => {
    await query('DELETE FROM calendar_objects WHERE user_id=$1', [f.userId]);
    const ev = await makeSeries();
    const fourth = new Date(first.getTime() + 3 * 86_400_000);
    await deleteEvent(f.userId, ev.id, { scope: 'future', occurrence: fourth.toISOString() });
    const shown = await eventsIn(f.userId, soon(0), soon(10));
    eq(shown.length, 3, 'the first three survive');
    ok(shown.every((s) => new Date(s.startsAt) < fourth), 'nothing from the fourth on');
  });

  await test('a one-off ignores the scope rather than refusing it', async () => {
    const ev = await createEvent(f.userId, { calendarId: f.calendarId, summary: 'Once', startsAt: soon(6).toISOString() });
    await updateEvent(f.userId, ev.id, { summary: 'Once, renamed' }, { scope: 'this', occurrence: soon(6).toISOString() });
    const shown = await eventsIn(f.userId, soon(5), soon(7));
    eq(shown.length, 1);
    eq(shown[0].summary, 'Once, renamed');
  });

  await test('the raw iCalendar keeps the rule rather than a list of dates', async () => {
    await query('DELETE FROM calendar_objects WHERE user_id=$1', [f.userId]);
    await makeSeries();
    const dek = await dataKey(f.userId);
    const row = await one<any>('SELECT ical FROM calendar_objects WHERE user_id=$1 LIMIT 1', [f.userId]);
    const text = openWith(dek, row.ical) ?? '';
    ok(/RRULE:FREQ=DAILY/.test(text), 'the rule should still be there');
    eq(parseCalendar(text).events.filter((e) => !e.recurrenceId).length, 1, 'one master, not five events');
  });
});

// ======================================================================
const busyGroup = group('busy', async () => {
  const f = await makeFixture();

  await test('an event blocks its time, and a transparent one does not', async () => {
    const start = soon(2, 14);
    await createEvent(f.userId, { calendarId: f.calendarId, summary: 'Meeting', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() });
    await createEvent(f.userId, { calendarId: f.calendarId, summary: 'Focus', transparent: true, startsAt: soon(2, 16).toISOString(), endsAt: soon(2, 18).toISOString() });
    const busy = await busyIn(f.userId, soon(2, 0), soon(3, 0));
    eq(busy.length, 1, 'only the opaque one');
    eq(iso(new Date(busy[0].from)), iso(start));
  });

  await test('a calendar that is not shown is not counted as busy', async () => {
    await query('UPDATE calendars SET selected=false WHERE id=$1', [f.calendarId]);
    eq((await busyIn(f.userId, soon(2, 0), soon(3, 0))).length, 0);
    await query('UPDATE calendars SET selected=true WHERE id=$1', [f.calendarId]);
  });

  await test('proposed times avoid what is already booked', async () => {
    const r = await freeSlotsFor(f.userId, { minutes: 60, days: 5, count: 20, startHour: 0, endHour: 24, tz: 'UTC' });
    const clash = r.slots.find((s) => iso(s.startsAt) === iso(soon(2, 14)));
    ok(!clash, 'the booked hour should not be offered');
  });

  await test('an accepted invitation does not clash with its own copy in the calendar', async () => {
    const start = soon(4, 11);
    const end = new Date(start.getTime() + 3_600_000);
    await storeInvitation(f.userId, f.accountId, null as unknown as number, {
      uid: 'e2e-invite@example.com', summary: 'Quarterly review', description: null, location: null,
      organizer: null, attendees: [], start, end, allDay: false, sequence: 0, status: null, recurrence: null, approximate: false,
    });
    const before = (await upcoming(f.userId, 30)).find((i) => i.uid === 'e2e-invite@example.com');
    eq(before?.clashes.length, 0, 'nothing clashes yet');

    await acceptIntoCalendar(f.userId, {
      uid: 'e2e-invite@example.com', summary: 'Quarterly review', location: null, description: null,
      startsAt: start.toISOString(), endsAt: end.toISOString(), allDay: false,
      organizer: null, attendees: [], partstat: 'ACCEPTED',
    });
    const after = (await upcoming(f.userId, 30)).find((i) => i.uid === 'e2e-invite@example.com');
    eq(after?.clashes.length, 0, 'accepting must not make it clash with itself');

    // But something genuinely in the way still counts.
    const other = newEvent('e2e-other@example.com');
    other.summary = 'Somebody else';
    other.start = vtimeOf(start); other.end = vtimeOf(end);
    await putObject(f.userId, f.calendarId, { ical: writeCalendar([other]) });
    const withOther = (await upcoming(f.userId, 30)).find((i) => i.uid === 'e2e-invite@example.com');
    eq(withOther?.clashes.length, 1, 'a real conflict is still reported');
  });
});

// ======================================================================
const availabilityGroup = group('availability', async () => {
  const f = await makeFixture();

  await test('the assistant is given times and never titles', async () => {
    await createEvent(f.userId, {
      calendarId: f.calendarId, summary: 'Board meeting about the acquisition', location: 'Room 9',
      startsAt: soon(1, 14).toISOString(), endsAt: soon(1, 15).toISOString(),
    });
    const a = await availabilityFor(f.userId, { tz: 'UTC', days: 5, startHour: 0, endHour: 24 });
    ok(a, 'there should be availability');
    const text = JSON.stringify(a);
    ok(!/acquisition|Board|Room 9/i.test(text), `a title leaked into the model's input: ${text.slice(0, 200)}`);
    ok(/\d\d:\d\d-\d\d:\d\d/.test(text), 'it should carry times');
  });

  await test('a day is the reader’s day, not the server’s', async () => {
    // 01:30 UTC is the evening of the day before in Chicago.
    const evening = new Date('2026-09-08T01:30:00Z');
    eq(dayWindow(evening, 'America/Chicago').from.toISOString(), '2026-09-07T05:00:00.000Z');
    eq(dayWindow(evening).from.toISOString(), '2026-09-08T00:00:00.000Z');
  });

  await test('the agenda for a day holds what is on it', async () => {
    const day = await agendaFor(f.userId, soon(1, 12), 'UTC');
    eq(day.length, 1);
    eq(day[0].summary, 'Board meeting about the acquisition');
  });
});

// ======================================================================
const remindersGroup = group('reminders', async () => {
  const f = await makeFixture();

  await test('an event with no reminder is never due', async () => {
    await createEvent(f.userId, { calendarId: f.calendarId, summary: 'Quiet', startsAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    const due = (await dueReminders()).filter((d) => d.userId === f.userId);
    eq(due.length, 0);
  });

  await test('an event starting inside its reminder window is due', async () => {
    await createEvent(f.userId, {
      calendarId: f.calendarId, summary: 'Soon', alarms: [30],
      startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const due = (await dueReminders()).filter((d) => d.userId === f.userId);
    eq(due.length, 1, 'it should be due');
    eq(due[0].summary, 'Soon');
  });

  await test('an announced occurrence is not announced twice', async () => {
    const due = (await dueReminders()).filter((d) => d.userId === f.userId);
    await markNotified(due.map((d) => d.instanceId));
    eq((await dueReminders()).filter((d) => d.userId === f.userId).length, 0);
  });

  await test('an event further out than its reminder is not due yet', async () => {
    await createEvent(f.userId, {
      calendarId: f.calendarId, summary: 'Later', alarms: [10],
      startsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    });
    eq((await dueReminders()).filter((d) => d.userId === f.userId && d.summary === 'Later').length, 0);
  });

  await test('importing history does not produce a year of notifications', async () => {
    const past = newEvent('e2e-past@example.com');
    past.summary = 'Last month';
    past.alarms = [15];
    past.start = vtimeOf(soon(-30)); past.end = vtimeOf(new Date(soon(-30).getTime() + 3_600_000));
    await putObject(f.userId, f.calendarId, { ical: writeCalendar([past]) });
    eq((await dueReminders()).filter((d) => d.userId === f.userId && d.summary === 'Last month').length, 0);
  });

  await test('the reminder is on the event, so other calendar apps see it', async () => {
    const dek = await dataKey(f.userId);
    const rows = await query<any>('SELECT ical, alarm_minutes FROM calendar_objects WHERE user_id=$1', [f.userId]);
    const withAlarm = rows.find((r) => r.alarm_minutes === 30);
    ok(withAlarm, 'the earliest alarm should be stored beside the event');
    ok(/BEGIN:VALARM/.test(openWith(dek, withAlarm.ical) ?? ''), 'and written into the iCalendar');
  });
});

// ======================================================================
const consentGroup = group('consent', async () => {
  const f = await makeFixture();

  await test('withdrawing consent takes the calendars and the events with it', async () => {
    await createEvent(f.userId, { calendarId: f.calendarId, summary: 'Doomed', startsAt: soon(2).toISOString() });
    ok((await query('SELECT 1 FROM calendar_objects WHERE user_id=$1', [f.userId])).length, 'there should be an event');

    await revoke(f.userId, 'calendar');
    await eraseCapabilityData(f.userId, 'calendar');

    for (const table of ['calendar_sources', 'calendars', 'calendar_objects', 'calendar_instances', 'calendar_events']) {
      const rows = await query(`SELECT 1 FROM ${table} WHERE user_id=$1`, [f.userId]);
      eq(rows.length, 0, `${table} should be empty`);
    }
  });

  await test('free/busy says nothing once consent is withdrawn', async () => {
    eq((await busyIn(f.userId, soon(0), soon(10))).length, 0);
    eq(await availabilityFor(f.userId, { tz: 'UTC' }), undefined);
  });

  await test('and the calendar can be used again once it is granted back', async () => {
    await grant(f.userId, 'calendar');
    const source = await createSource(f.userId, { kind: 'caldav', label: 'again', baseUrl: 'https://e2e.invalid/dav/', username: 'e2e', secret: 'e2e' });
    const cal = await upsertCalendar(f.userId, source.id, { remoteId: 'https://e2e.invalid/dav/work/', name: 'Work' });
    ok(await defaultCalendar(f.userId), 'there should be somewhere to write');
    await createEvent(f.userId, { calendarId: cal.id, summary: 'Back', startsAt: soon(2).toISOString() });
    eq((await eventsIn(f.userId, soon(1), soon(3))).length, 1);
  });
});

// ======================================================================
async function main() {
  await waitForDb(30);
  await migrate();
  const t0 = Date.now();
  for (const g of [storageGroup, seriesGroup, busyGroup, availabilityGroup, remindersGroup, consentGroup]) {
    try { await g(); } catch (e) { console.log(`  GROUP FAILED: ${(e as Error).message}`); results.push({ group: current, name: '(group)', ok: false, detail: (e as Error).message }); }
  }
  for (const id of created) await query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});

  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  console.log(`\n${pass} passed, ${fail} failed in ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL [${r.group}] ${r.name}: ${r.detail}`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
