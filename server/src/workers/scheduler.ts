// Background work on a 20-second tick: sequence steps, scheduled sends,
// snoozed threads. Claims use guarded conditional updates so a second
// process (or an overlapping tick) can never send the same step twice.
import { one, query } from '../db.js';
import { logger } from '../log.js';
import { publish } from '../events.js';
import { getAccount, type AccountRow } from '../services/accounts.js';
import { composeAndSend, type ComposeInput } from '../services/compose.js';
import { contactContext, htmlToText, renderHtml, renderText, textToHtml } from '../services/merge.js';
import { jitterMs, reserveSendSlot } from '../services/sending.js';
import { chat, getAiSettings } from '../ai/llm.js';
import { buildMessages, cleanOutput } from '../ai/prompts.js';
import { escapeHtml } from '../services/merge.js';
import * as actions from '../jmap/actions.js';
import { unsubscribeUrl } from '../services/compose.js';

const log = logger('scheduler');
let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startScheduler(intervalMs = 20_000): void {
  timer = setInterval(() => void tick(), intervalMs);
  setTimeout(() => void tick(), 3000);
  log.info('scheduler started');
}
export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await processSnoozes();
    await processOutbox();
    await processEnrollments();
    await processAiJobs();
  } catch (e) {
    log.error('tick failed', { err: (e as Error).message });
  } finally {
    ticking = false;
  }
}

// ---------- Snoozes ----------

async function processSnoozes(): Promise<void> {
  const due = await query<any>(`SELECT * FROM snoozes WHERE NOT restored AND until_at <= now() LIMIT 50`);
  for (const s of due) {
    const claimed = await query(`UPDATE snoozes SET restored=true WHERE id=$1 AND NOT restored RETURNING id`, [s.id]);
    if (!claimed.length) continue;
    try {
      const acc = await getAccount(s.account_id);
      if (!acc) continue;
      const inbox = await actions.mailboxByRole(acc.id, 'inbox');
      const ids = await query<{ jmap_id: string }>('SELECT jmap_id FROM emails WHERE account_id=$1 AND thread_id=$2', [acc.id, s.thread_id]);
      if (inbox && ids.length) {
        await actions.addToMailbox(acc, ids.map((r) => r.jmap_id), inbox.jmap_id);
        await actions.setKeyword(acc, ids.map((r) => r.jmap_id), '$seen', false);
      }
      publish({ type: 'sync', userId: s.user_id, accountId: s.account_id });
    } catch (e) {
      log.error('snooze restore failed', { err: (e as Error).message, snooze: s.id });
    }
  }
}

// ---------- Outbox (send later) ----------

async function processOutbox(): Promise<void> {
  const due = await query<any>(`SELECT id FROM outbox WHERE status='scheduled' AND send_at <= now() ORDER BY send_at LIMIT 20`);
  for (const { id } of due) {
    const rows = await query<any>(`UPDATE outbox SET status='sending', attempts = attempts + 1 WHERE id=$1 AND status='scheduled' RETURNING *`, [id]);
    const item = rows[0];
    if (!item) continue;
    const acc = await getAccount(item.account_id);
    if (!acc) { await query(`UPDATE outbox SET status='failed', error='Account no longer exists' WHERE id=$1`, [id]); continue; }
    const payload: ComposeInput & { humanize?: boolean } = item.payload;
    if (payload.humanize) {
      // The person asked for a natural gap: respect the account's pacing and
      // window rather than firing at the exact second.
      const slot = await reserveSendSlot(acc);
      if (!slot.ok) {
        await query(`UPDATE outbox SET status='scheduled', attempts = attempts - 1, send_at=$2 WHERE id=$1`, [id, new Date(slot.retryAt.getTime() + Math.random() * 30_000)]);
        continue;
      }
      if (slot.waitMs) await new Promise((r) => setTimeout(r, Math.min(slot.waitMs, 5000)));
    }
    try {
      await composeAndSend(acc, { ...payload, kind: payload.kind === 'auto_reply' ? 'auto_reply' : 'scheduled' });
      await query(`UPDATE outbox SET status='sent', sent_at=now(), error=NULL WHERE id=$1`, [id]);
    } catch (e) {
      const msg = (e as Error).message;
      if (item.attempts < 3) await query(`UPDATE outbox SET status='scheduled', send_at = now() + interval '5 minutes', error=$2 WHERE id=$1`, [id, msg.slice(0, 500)]);
      else await query(`UPDATE outbox SET status='failed', error=$2 WHERE id=$1`, [id, msg.slice(0, 500)]);
    }
  }
}

// ---------- Sequences ----------

interface StepRow { id: number; sequence_id: number; position: number; kind: 'email' | 'wait'; template_id: number | null; subject: string; body_html: string; wait_days: number; wait_hours: number; ai_personalize: boolean; ai_instructions: string; reply_in_thread: boolean }

async function processEnrollments(): Promise<void> {
  const due = await query<{ id: number }>(
    `SELECT e.id FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
     WHERE e.status='active' AND s.status='active' AND e.next_run_at <= now() ORDER BY e.next_run_at LIMIT 25`,
  );
  for (const { id } of due) {
    // Lease the row for ten minutes; a crash mid-step retries after that.
    const claimed = await query<any>(
      `UPDATE enrollments SET next_run_at = now() + interval '10 minutes', updated_at=now() WHERE id=$1 AND status='active' AND next_run_at <= now() RETURNING *`,
      [id],
    );
    if (!claimed.length) continue;
    try {
      await runEnrollment(claimed[0]);
    } catch (e) {
      const msg = (e as Error).message;
      log.error('enrollment step failed', { enrollment: id, err: msg });
      await query(`UPDATE enrollments SET error=$2, next_run_at = now() + interval '30 minutes', updated_at=now() WHERE id=$1 AND status='active'`, [id, msg.slice(0, 500)]);
      const enr = claimed[0];
      publish({ type: 'enrollment', userId: 0, sequenceId: enr.sequence_id, enrollmentId: id, status: 'error' });
    }
  }
}

async function finish(enr: any, status: string, error: string | null = null): Promise<void> {
  await query(`UPDATE enrollments SET status=$2, error=$3, updated_at=now(), finished_at=now() WHERE id=$1`, [enr.id, status, error]);
  publish({ type: 'enrollment', userId: enr.user_id ?? 0, sequenceId: enr.sequence_id, enrollmentId: enr.id, status });
}

function waitMs(step: StepRow): number {
  return (step.wait_days * 24 + step.wait_hours) * 3600_000;
}

async function runEnrollment(enr: any): Promise<void> {
  const seq = await one<any>('SELECT * FROM sequences WHERE id=$1', [enr.sequence_id]);
  if (!seq || seq.status !== 'active') { await query(`UPDATE enrollments SET next_run_at = now() + interval '1 hour' WHERE id=$1`, [enr.id]); return; }
  enr.user_id = seq.user_id;
  const steps = await query<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY position, id', [seq.id]);
  const step = steps[enr.current_step];
  if (!step) { await finish(enr, 'finished'); return; }

  if (step.kind === 'wait') {
    await query(`UPDATE enrollments SET current_step = current_step + 1, next_run_at = now() + ($2 || ' milliseconds')::interval, updated_at=now() WHERE id=$1`, [enr.id, String(waitMs(step))]);
    return;
  }

  const contact = await one<any>('SELECT * FROM contacts WHERE id=$1', [enr.contact_id]);
  if (!contact) { await finish(enr, 'error', 'Contact was deleted'); return; }
  if (['unsubscribed', 'do_not_contact'].includes(contact.status)) { await finish(enr, 'unsubscribed'); return; }
  if (contact.status === 'bounced') { await finish(enr, 'bounced'); return; }
  const suppressed = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND lower(email)=lower($2)', [seq.user_id, contact.email]);
  if (suppressed) { await finish(enr, 'unsubscribed'); return; }
  const acc = await getAccount(enr.account_id);
  if (!acc || !acc.enabled) { await query(`UPDATE enrollments SET next_run_at = now() + interval '1 hour', error='Sending account is paused', updated_at=now() WHERE id=$1`, [enr.id]); return; }

  // Content: an approved review, or the template, or the LLM.
  const approved = await one<any>(`SELECT * FROM review_queue WHERE enrollment_id=$1 AND step_id=$2 AND status='approved' ORDER BY decided_at DESC LIMIT 1`, [enr.id, step.id]);
  let subject: string, html: string;
  const rendered = await renderStep(acc, seq, step, contact, enr);
  if (approved) {
    subject = approved.subject; html = approved.body_html;
  } else if (step.ai_personalize && seq.ai_mode !== 'off') {
    const gen = await personalize(acc, step, contact, rendered);
    subject = gen.subject; html = gen.html;
    if (seq.ai_mode === 'review') {
      await query(`DELETE FROM review_queue WHERE enrollment_id=$1 AND step_id=$2 AND status='pending'`, [enr.id, step.id]);
      await query(
        `INSERT INTO review_queue (user_id, enrollment_id, account_id, contact_id, step_id, subject, body_html, ai_model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [seq.user_id, enr.id, acc.id, contact.id, step.id, subject, html, gen.model],
      );
      await query(`UPDATE enrollments SET status='waiting_review', updated_at=now() WHERE id=$1`, [enr.id]);
      const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [seq.user_id]);
      publish({ type: 'review', userId: seq.user_id, count: pending?.n ?? 0 });
      publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId: enr.id, status: 'waiting_review' });
      return;
    }
  } else {
    subject = rendered.subject; html = rendered.html;
  }

  const slot = await reserveSendSlot(acc);
  if (!slot.ok) {
    await query(`UPDATE enrollments SET next_run_at=$2, updated_at=now(), error=NULL WHERE id=$1`, [enr.id, new Date(slot.retryAt.getTime() + Math.random() * 60_000)]);
    log.debug(`enrollment ${enr.id} deferred (${slot.reason}) until ${slot.retryAt.toISOString()}`);
    return;
  }

  const threaded = step.reply_in_thread && enr.last_message_id;
  const finalSubject = threaded ? (/^re:/i.test(subject) ? subject : `Re: ${enr.last_subject || subject}`) : subject;
  const { outcome } = await composeAndSend(acc, {
    to: [{ name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null, email: contact.email }],
    subject: finalSubject,
    html,
    kind: 'sequence',
    contactId: contact.id,
    sequenceId: seq.id,
    stepId: step.id,
    enrollmentId: enr.id,
    includeSignature: rendered.includeSignature,
    templateId: rendered.templateId,
    inReplyTo: threaded ? enr.last_message_id : null,
    references: threaded ? [enr.last_message_id] : [],
    unsubscribeFooter: seq.unsubscribe_footer,
  });

  const nextIndex = enr.current_step + 1;
  const next = steps[nextIndex];
  let nextRun: Date | null;
  if (!next) nextRun = null;
  else if (next.kind === 'wait') nextRun = new Date(Date.now() + waitMs(next));
  else nextRun = new Date(Date.now() + Math.max(jitterMs(acc), 60_000));
  if (!next) {
    await query(`UPDATE enrollments SET current_step=$2, last_message_id=$3, thread_id=COALESCE($4, thread_id), last_subject=$5, status='finished', finished_at=now(), next_run_at=NULL, error=NULL, updated_at=now() WHERE id=$1`, [enr.id, nextIndex, outcome.messageId, outcome.threadId, finalSubject]);
    publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId: enr.id, status: 'finished' });
  } else {
    await query(`UPDATE enrollments SET current_step=$2, last_message_id=$3, thread_id=COALESCE($4, thread_id), last_subject=$5, next_run_at=$6, error=NULL, updated_at=now() WHERE id=$1`, [enr.id, nextIndex, outcome.messageId, outcome.threadId, finalSubject, nextRun]);
    publish({ type: 'enrollment', userId: seq.user_id, sequenceId: seq.id, enrollmentId: enr.id, status: 'active' });
  }
}

export async function renderStep(acc: AccountRow, seq: any, step: StepRow, contact: any, enr?: any): Promise<{ subject: string; html: string; brief: string; includeSignature: boolean; templateId: number | null }> {
  let subjectTpl = step.subject, bodyTpl = step.body_html, brief = '', includeSignature = true, templateId: number | null = null;
  if (step.template_id) {
    const t = await one<any>('SELECT * FROM templates WHERE id=$1', [step.template_id]);
    if (t) { subjectTpl = subjectTpl || t.subject; bodyTpl = bodyTpl || t.body_html; brief = t.ai_brief ?? ''; includeSignature = t.include_signature !== false; templateId = t.id; }
  }
  const ctx = contactContext(contact, {
    sender_name: acc.name,
    sender_email: acc.email,
    sender_first_name: acc.name.split(' ')[0],
    sender_tz: acc.send_window?.tz,
    unsubscribe_url: contact.id ? unsubscribeUrl(seq.user_id, contact.id, acc.id) : '',
  });
  const seed = enr?.id ? Number(enr.id) * 7919 + Number(step.id) : undefined;
  return { subject: renderText(subjectTpl ?? '', ctx, seed), html: renderHtml(bodyTpl ?? '', ctx, seed), brief: renderText(brief, ctx, seed), includeSignature, templateId };
}

async function personalize(acc: AccountRow, step: StepRow, contact: any, rendered: { subject: string; html: string; brief: string }): Promise<{ subject: string; html: string; model: string }> {
  const settings = await getAiSettings();
  const messages = buildMessages({
    mode: 'personalize',
    instruction: step.ai_instructions || undefined,
    senderName: acc.name,
    systemPrompt: settings.systemPrompt,
    voice: acc.voice,
    recipient: { name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), email: contact.email, company: contact.company, title: contact.title, notes: contact.notes, fields: contact.fields },
    template: rendered.brief || htmlToText(rendered.html),
    subject: rendered.subject,
    length: 'medium',
  });
  const body = cleanOutput(await chat({ messages, maxTokens: 600 }), 'personalize');
  let subject = rendered.subject;
  if (!subject.trim()) {
    subject = cleanOutput(await chat({ messages: buildMessages({ mode: 'subject', draft: body }), maxTokens: 40, temperature: 0.4 }), 'subject');
  }
  return { subject, html: textToHtml(body), model: settings.model };
}


// ---------- AI responders ----------
// Generates the reply a responder asked for, then either files it as a
// draft, queues it for review, or sends it (through the outbox when the
// responder wants the account's pacing and random delay).

async function processAiJobs(): Promise<void> {
  for (let n = 0; n < 2; n++) {
    const rows = await query<any>(`UPDATE ai_jobs SET status='running', attempts = attempts + 1, updated_at=now() WHERE id = (SELECT id FROM ai_jobs WHERE status='pending' ORDER BY created_at LIMIT 1) AND status='pending' RETURNING *`);
    const job = rows[0];
    if (!job) return;
    try {
      const result = job.kind === 'responder' ? await runResponderJob(job) : 'unknown job kind';
      await query(`UPDATE ai_jobs SET status='done', result=$2, updated_at=now() WHERE id=$1`, [job.id, result]);
    } catch (e) {
      const msg = (e as Error).message;
      log.error('ai job failed', { job: job.id, err: msg });
      if (job.attempts >= 3) await query(`UPDATE ai_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
      else await query(`UPDATE ai_jobs SET status='pending', error=$2, updated_at=now() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
    }
  }
}

export async function generateResponderReply(responder: any, acc: AccountRow, email: any): Promise<{ subject: string; html: string; text: string; to: { name: string | null; email: string }[]; model: string }> {
  const settings = await getAiSettings();
  const thread = await query<any>('SELECT from_addr, received_at, body_text, body_html, preview FROM emails WHERE account_id=$1 AND thread_id=$2 ORDER BY received_at ASC', [acc.id, email.thread_id]);
  const contact = await one<any>('SELECT * FROM contacts WHERE user_id=$1 AND lower(email)=$2', [acc.user_id, String(email.from_addr?.[0]?.email ?? '').toLowerCase()]);
  const messages = buildMessages({
    mode: 'reply',
    instruction: responder.instructions || undefined,
    tone: responder.tone || undefined,
    length: responder.length || 'medium',
    senderName: acc.name,
    subject: email.subject,
    systemPrompt: settings.systemPrompt,
    voice: acc.voice,
    recipient: contact ? { name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), email: contact.email, company: contact.company, title: contact.title, notes: contact.notes, fields: contact.fields } : { name: email.from_addr?.[0]?.name ?? undefined, email: email.from_addr?.[0]?.email },
    thread: thread.map((m) => ({ from: `${m.from_addr?.[0]?.name ?? ''} <${m.from_addr?.[0]?.email ?? ''}>`.trim(), date: new Date(m.received_at).toDateString(), text: (m.body_text || htmlToText(m.body_html || '') || m.preview || '').replace(/\n>.*$/gm, '').trim() })),
  });
  const text = cleanOutput(await chat({ messages, maxTokens: settings.maxTokens }), 'reply');
  const me = acc.email.toLowerCase();
  const replyTo: any[] = email.reply_to?.length ? email.reply_to : email.from_addr ?? [];
  let to = replyTo.filter((a: any) => String(a.email).toLowerCase() !== me).map((a: any) => ({ name: a.name ?? null, email: a.email }));
  if (responder.reply_all) {
    for (const a of [...(email.to_addr ?? []), ...(email.cc_addr ?? [])]) if (String(a.email).toLowerCase() !== me && !to.some((t: any) => t.email.toLowerCase() === String(a.email).toLowerCase())) to.push({ name: a.name ?? null, email: a.email });
  }
  const quote = `<div class="tern-quote" style="margin-top:16px"><div style="color:#5b6274;font-size:12.5px;margin-bottom:6px">On ${escapeHtml(new Date(email.received_at).toUTCString())}, ${escapeHtml(email.from_addr?.[0]?.email ?? '')} wrote:</div><blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:2px solid #d0d4e0">${email.body_html ?? `<div style="white-space:pre-wrap">${escapeHtml(email.body_text ?? '')}</div>`}</blockquote></div>`;
  return { subject: /^re:/i.test(email.subject ?? '') ? email.subject : `Re: ${email.subject ?? ''}`, html: textToHtml(text) + quote, text, to, model: settings.model };
}

async function runResponderJob(job: any): Promise<string> {
  const p = job.payload;
  const responder = await one<any>('SELECT * FROM responders WHERE id=$1 AND enabled', [p.responderId]);
  if (!responder) return 'responder gone or disabled';
  const acc = await getAccount(p.accountId);
  if (!acc || !acc.enabled) return 'account unavailable';
  const email = await one<any>('SELECT * FROM emails WHERE id=$1 AND account_id=$2', [p.emailDbId, acc.id]);
  if (!email) return 'email gone';
  // Someone may have answered by hand in the meantime.
  const answered = await one(`SELECT 1 FROM emails WHERE account_id=$1 AND thread_id=$2 AND from_email=$3 AND received_at > $4`, [acc.id, email.thread_id, acc.email.toLowerCase(), email.received_at]);
  if (answered) return 'already answered';
  const gen = await generateResponderReply(responder, acc, email);
  if (!gen.to.length) return 'no recipient';
  const contact = await one<{ id: number }>('SELECT id FROM contacts WHERE user_id=$1 AND lower(email)=$2', [acc.user_id, gen.to[0].email.toLowerCase()]);
  await query('UPDATE responders SET hits = hits + 1, updated_at=now() WHERE id=$1', [responder.id]);
  if (responder.mode === 'draft') {
    await query(
      `INSERT INTO drafts (user_id, account_id, kind, reply_to_email_id, thread_id, to_addr, subject, body_html, source, responder_id) VALUES ($1,$2,'reply',$3,$4,$5,$6,$7,'ai',$8)`,
      [acc.user_id, acc.id, email.id, email.thread_id, JSON.stringify(gen.to), gen.subject, gen.html, responder.id],
    );
    publish({ type: 'sync', userId: acc.user_id, accountId: acc.id });
    publish({ type: 'ai', userId: acc.user_id, status: 'draft' });
    return 'draft created';
  }
  if (responder.mode === 'review') {
    await query(
      `INSERT INTO review_queue (user_id, account_id, contact_id, subject, body_html, ai_model, kind, responder_id, reply_to_email_id, thread_id, to_addr, context)
       VALUES ($1,$2,$3,$4,$5,$6,'reply',$7,$8,$9,$10,$11)`,
      [acc.user_id, acc.id, contact?.id ?? null, gen.subject, gen.html, gen.model, responder.id, email.id, email.thread_id, JSON.stringify(gen.to), (email.body_text || email.preview || '').slice(0, 2000)],
    );
    const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [acc.user_id]);
    publish({ type: 'review', userId: acc.user_id, count: pending?.n ?? 0 });
    return 'queued for review';
  }
  const payload = { to: gen.to, subject: gen.subject, html: gen.html, replyToEmailId: email.id, kind: 'auto_reply', contactId: contact?.id ?? null, responderId: responder.id, includeSignature: true };
  if (responder.humanize) {
    await query('INSERT INTO outbox (user_id, account_id, payload, send_at) VALUES ($1,$2,$3,now())', [acc.user_id, acc.id, JSON.stringify({ ...payload, humanize: true })]);
    return 'queued to send with natural delay';
  }
  await composeAndSend(acc, payload as any);
  return 'sent';
}
