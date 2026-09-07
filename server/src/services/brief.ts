// F8: the brief.
//
// Not a daily notification. A push once a morning is a thing that happens to
// you, at a time somebody else chose, whether or not there was anything to
// say — and if you were not looking at your phone it is gone. This is a
// page: it is there when you go to it, it shows when it was made, and there
// is a button to make a new one. Nothing generates on a timer, so a mailbox
// nobody is reading costs nothing at all.
//
// It is cached because it is expensive. On a 4.5 GB box a brief is a minute
// of a local model's time; asking for one on every page load would make the
// page useless and the box unusable. So: one stored brief per person,
// sealed, replaced in place, with the moment it covers written on it.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { chat, getAiSettings } from '../ai/llm.js';
import { assertFreshConversation } from '../ai/prompts.js';
import { dataKey, openWith, sealWith } from './vault.js';
import { openEmails } from './mailVault.js';
import { htmlToText } from './merge.js';
import { allowed } from './capabilities.js';
import { listCommitments, openCount } from './commitments.js';
import { describe as describeGuard, type GuardFlag, type GuardDetail } from './guard.js';

const log = logger('brief');

export interface BriefSection { title: string; items: BriefItem[] }
export interface BriefItem {
  text: string;
  accountId?: number;
  threadId?: string;
  emailId?: number;
  /** 'needs-you' | 'waiting' | 'warning' | 'bulk' — how the row is drawn. */
  tone?: string;
}

export interface Brief {
  summary: string;
  sections: BriefSection[];
  generatedAt: string;
  coversFrom: string | null;
  coversTo: string | null;
  model: string | null;
  durationMs: number | null;
  stale: boolean;
}

// How far back a brief looks. A week, because "what needs you" over a
// weekend is a different question from "what arrived since 6am" and the page
// is not on a daily rhythm.
const WINDOW_DAYS = 7;

// ---------- Reading the stored one ----------

export async function getBrief(userId: number): Promise<Brief | null> {
  const row = await one<any>('SELECT * FROM briefs WHERE user_id=$1', [userId]);
  if (!row) return null;
  const text = openWith(await dataKey(userId), row.content);
  if (!text) return null;
  let parsed: { summary: string; sections: BriefSection[] };
  try { parsed = JSON.parse(text); } catch { return null; }
  const generatedAt = new Date(row.generated_at);
  // Anything newer than the brief means it is describing a mailbox that has
  // moved on. The page says so and offers the button rather than silently
  // regenerating, which would spend a minute of model time nobody asked for.
  const newer = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND e.received_at > $2`,
    [userId, generatedAt],
  );
  return {
    summary: parsed.summary ?? '',
    sections: parsed.sections ?? [],
    generatedAt: generatedAt.toISOString(),
    coversFrom: row.covers_from ? new Date(row.covers_from).toISOString() : null,
    coversTo: row.covers_to ? new Date(row.covers_to).toISOString() : null,
    model: row.model,
    durationMs: row.duration_ms,
    stale: (newer?.n ?? 0) > 0,
  };
}

// ---------- Making one ----------

const SYSTEM = [
  'You write one short paragraph summarising somebody’s recent mail.',
  'You are given a list of conversations that are already sorted and labelled. Do not re-order them, do not add anything that is not there, and do not invent names, numbers or dates.',
  'Three sentences at most. Say what is waiting, what is unusual, and nothing else.',
  'Write plainly, in the second person ("You have…"). No greeting, no sign-off, no bullet points, no headings.',
].join('\n');

export async function generateBrief(userId: number): Promise<Brief> {
  await allowedOrThrow(userId);
  const started = Date.now();
  const s = await getAiSettings();
  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * 86_400_000);

  const sections: BriefSection[] = [];

  // 1. What is warning you. Deterministic, from the guard, and first because
  //    it is the only part where being late matters.
  const warnings = await guardSection(userId, from);
  if (warnings.items.length) sections.push(warnings);

  // 2. What needs a reply: unread, addressed to you, in a conversation you
  //    have been part of. Ordered by the triage score when there is one.
  const needsYou = await needsReplySection(userId, from);
  if (needsYou.items.length) sections.push(needsYou);

  // 3. What you owe and what you are owed, from F6.
  const commitments = await commitmentSection(userId);
  if (commitments.items.length) sections.push(commitments);

  // 4. What can go in one action.
  const bulk = await bulkSection(userId, from);
  if (bulk.items.length) sections.push(bulk);

  // The model writes the paragraph at the top and nothing else. Everything
  // below it is already true, already ordered, and already linked; handing
  // that to a model to re-render would only give it the chance to be wrong.
  let summary = '';
  const facts = sections.flatMap((sec) => sec.items.slice(0, 8).map((i) => `${sec.title}: ${i.text}`)).join('\n').slice(0, 6000);
  if (facts) {
    const messages = [
      { role: 'system' as const, content: SYSTEM },
      { role: 'user' as const, content: `Today is ${to.toDateString()}.\n\n${facts}` },
    ];
    assertFreshConversation(messages);
    try {
      summary = tidyParagraph(await chat({
        messages, maxTokens: 220, temperature: 0.3, noThink: true,
        owner: String(userId),
        consent: { userId, capability: 'brief' },
      }));
    } catch (e) {
      // A brief without its paragraph is still a brief. The sections are the
      // part that carries information.
      log.warn('the brief’s summary could not be written', { user: userId, err: (e as Error).message });
    }
  }
  if (!summary) summary = fallbackSummary(sections);

  const dek = await dataKey(userId);
  const durationMs = Date.now() - started;
  await query(
    `INSERT INTO briefs (user_id, content, model, covers_from, covers_to, generated_at, duration_ms)
     VALUES ($1,$2,$3,$4,$5,now(),$6)
     ON CONFLICT (user_id) DO UPDATE SET content=EXCLUDED.content, model=EXCLUDED.model,
       covers_from=EXCLUDED.covers_from, covers_to=EXCLUDED.covers_to, generated_at=now(), duration_ms=EXCLUDED.duration_ms`,
    [userId, sealWith(dek, JSON.stringify({ summary, sections })), s.model, from, to, durationMs],
  );
  log.info('brief written', { user: userId, sections: sections.length, ms: durationMs });
  return { summary, sections, generatedAt: new Date().toISOString(), coversFrom: from.toISOString(), coversTo: to.toISOString(), model: s.model, durationMs, stale: false };
}

async function allowedOrThrow(userId: number): Promise<void> {
  if (!(await allowed(userId, 'brief'))) {
    const { assertCapability } = await import('./capabilities.js');
    await assertCapability(userId, 'brief');
  }
}

// ---------- The sections ----------

async function guardSection(userId: number, from: Date): Promise<BriefSection> {
  const items: BriefItem[] = [];
  if (await allowed(userId, 'guard')) {
    const rows = await query<any>(
      `SELECT e.id, e.account_id, e.thread_id, e.guard_flags, e.guard_detail, e.subject
         FROM emails e JOIN accounts a ON a.id=e.account_id
        WHERE a.user_id=$1 AND e.received_at > $2
          AND e.guard_flags && ARRAY['thread_sender_changed','lookalike_domain','display_name_mismatch']
        ORDER BY e.received_at DESC LIMIT 10`,
      [userId, from],
    );
    const dek = await dataKey(userId);
    for (const r of rows) {
      let detail: GuardDetail = {};
      try { detail = JSON.parse(openWith(dek, r.guard_detail) ?? '{}'); } catch { /* unreadable */ }
      const line = describeGuard(r.guard_flags as GuardFlag[], detail);
      if (line) items.push({ text: line, accountId: r.account_id, threadId: r.thread_id, emailId: r.id, tone: 'warning' });
    }
  }
  return { title: 'Worth checking', items };
}

async function needsReplySection(userId: number, from: Date): Promise<BriefSection> {
  // Unread, not from a list, not automatic, in a thread with more than one
  // message or from somebody in contacts. Ordered by priority when triage is
  // on and by arrival when it is not.
  const rows = await query<any>(
    `SELECT e.id, e.account_id, e.thread_id, e.subject, e.from_addr, e.priority, e.received_at
       FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND e.received_at > $2
        AND e.is_unread AND NOT e.is_draft
        AND e.list_id IS NULL AND (e.auto_submitted IS NULL OR e.auto_submitted='no')
        AND EXISTS (SELECT 1 FROM mailboxes m WHERE m.account_id=e.account_id AND m.role='inbox' AND e.mailbox_ids @> ARRAY[m.jmap_id])
      ORDER BY e.priority DESC NULLS LAST, e.received_at DESC
      LIMIT 12`,
    [userId, from],
  );
  const opened = await openEmails(userId, 'brief', rows);
  return {
    title: 'Waiting for you',
    items: opened.map((m: any) => ({
      text: `${m.from_addr?.[0]?.name || m.from_addr?.[0]?.email || 'Someone'} — ${m.subject || '(no subject)'}`,
      accountId: m.account_id, threadId: m.thread_id, emailId: m.id, tone: 'needs-you',
    })),
  };
}

async function commitmentSection(userId: number): Promise<BriefSection> {
  if (!(await allowed(userId, 'commitments'))) return { title: 'Owed and awaiting', items: [] };
  const counts = await openCount(userId);
  if (!counts.owed && !counts.awaiting) return { title: 'Owed and awaiting', items: [] };
  const list = await listCommitments(userId, 'open');
  const now = Date.now();
  return {
    title: 'Owed and awaiting',
    items: list.slice(0, 10).map((c) => ({
      text: [
        c.kind === 'owed' ? 'You said you would' : 'You are waiting on',
        c.kind === 'owed' ? c.text.replace(/^You (?:said you would |will |'ll )?/i, '') : `${c.counterparty ?? 'someone'}: ${c.text}`,
        c.dueAt ? (new Date(c.dueAt).getTime() < now ? '— overdue' : `— by ${new Date(c.dueAt).toDateString()}`) : '',
      ].filter(Boolean).join(' '),
      accountId: c.accountId, threadId: c.threadId,
      tone: c.kind === 'owed' ? 'needs-you' : 'waiting',
    })),
  };
}

async function bulkSection(userId: number, from: Date): Promise<BriefSection> {
  // Senders whose recent mail is entirely unread. One line each, with the
  // count, so the page can offer to archive the lot.
  const rows = await query<any>(
    `SELECT e.account_id, e.from_blind, count(*)::int AS n,
            max(e.received_at) AS latest,
            (array_agg(e.from_addr ORDER BY e.received_at DESC))[1] AS sample
       FROM emails e JOIN accounts a ON a.id=e.account_id
      WHERE a.user_id=$1 AND e.received_at > $2 AND e.is_unread AND e.from_blind IS NOT NULL
        AND (e.list_id IS NOT NULL OR e.category IN ('promotions','updates'))
      GROUP BY e.account_id, e.from_blind
     HAVING count(*) >= 3
      ORDER BY count(*) DESC LIMIT 6`,
    [userId, from],
  );
  if (!rows.length) return { title: 'Can go in one action', items: [] };
  const dek = await dataKey(userId);
  return {
    title: 'Can go in one action',
    items: rows.map((r) => {
      let who = 'a sender';
      try { const a = JSON.parse(openWith(dek, r.sample) ?? '[]')[0]; who = a?.name || a?.email || who; } catch { /* unreadable */ }
      return { text: `${r.n} unread from ${who}`, accountId: r.account_id, tone: 'bulk' };
    }),
  };
}

// ---------- Wording ----------

export function tidyParagraph(raw: string): string {
  let t = String(raw ?? '').trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, '');
  t = t.replace(/^(?:here(?:'s| is) (?:your|the) (?:brief|summary)|summary|brief)\s*[:\-–]\s*/i, '');
  t = t.replace(/^(?:hi|hello|good (?:morning|afternoon|evening))\b[^.!?]*[.!?]\s*/i, '');
  // A model given "three sentences at most" sometimes writes ten.
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
  t = sentences.join(' ').trim();
  return t.length > 600 ? '' : t;
}

function fallbackSummary(sections: BriefSection[]): string {
  const counts = sections.filter((s) => s.items.length).map((s) => `${s.items.length} ${s.title.toLowerCase()}`);
  if (!counts.length) return 'Nothing is waiting for you.';
  return `You have ${counts.join(', ')}.`;
}
