// Unsubscribe landing page. No login, no JavaScript required, one click.
// The token is signed, so it cannot be guessed for another contact, and it
// carries nothing but ids.
import { Router } from 'express';
import { one, query } from '../db.js';
import { verifyPayload } from '../crypto.js';
import { escapeHtml } from '../services/merge.js';
import { checkValves } from '../services/valves.js';
import { logger } from '../log.js';

const log = logger('public');

// Mounted at `/u` in app.ts, so the paths below are relative to it: `/:token`
// is the `/u/<token>` that `unsubscribeUrl()` puts in every campaign footer
// and in the List-Unsubscribe header. They used to be written `/u/:token`
// here as well, which put the real page at `/u/u/<token>` and left the
// advertised link falling through to the SPA — a dead unsubscribe in every
// message, and a one-click POST that answered 404.
export const publicRouter = Router();

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7fb;color:#1c1f2b;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e4e7f0;border-radius:14px;padding:32px;max-width:440px;width:calc(100% - 32px);box-shadow:0 10px 30px rgba(20,30,60,.06)}h1{font-size:20px;margin:0 0 8px}p{color:#5b6274;line-height:1.5;margin:0 0 20px}
button{background:#1c1f2b;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:15px;cursor:pointer;width:100%}.ok{color:#1c7c4d}
.ask{margin:24px 0 10px;font-size:14px}button.reason{background:#fff;color:#1c1f2b;border:1px solid #e4e7f0;margin-bottom:8px;font-size:14px;padding:10px 14px}button.reason:hover{background:#f6f7fb}</style></head><body><div class="card">${body}</div></body></html>`;
}

async function resolve(token: string): Promise<{ userId: number; contactId: number; accountId: number; email: string } | null> {
  const payload = verifyPayload(token);
  if (!payload) return null;
  const [kind, u, c, a] = payload.split(':');
  if (kind !== 'u') return null;
  const contact = await one<{ email: string }>('SELECT email FROM contacts WHERE id=$1 AND user_id=$2', [Number(c), Number(u)]);
  if (!contact) return null;
  return { userId: Number(u), contactId: Number(c), accountId: Number(a), email: contact.email };
}

publicRouter.get('/:token', async (req, res) => {
  const r = await resolve(String(req.params.token));
  if (!r) { res.status(404).send(page('Link not valid', '<h1>This link is not valid</h1><p>The unsubscribe link may have been altered. Reply to the email with the word "stop" instead and you will be removed.</p>')); return; }
  res.send(page('Unsubscribe', `<h1>Stop receiving these emails?</h1><p>Confirm below and <strong>${escapeHtml(r.email)}</strong> will not be contacted again.</p><form method="post"><button type="submit">Unsubscribe</button></form>`));
});

async function unsubscribe(r: { userId: number; contactId: number; email: string }): Promise<void> {
  await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), 'unsubscribe', 'link') ON CONFLICT (user_id, email) DO UPDATE SET reason='unsubscribe'`, [r.userId, r.email]);
  await query(`UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE id=$1`, [r.contactId]);
  // Which campaigns they were on, read before the update, because the update
  // is what takes them off it.
  const on = await query<{ sequence_id: number }>(
    `SELECT DISTINCT sequence_id FROM enrollments WHERE contact_id=$1 AND status IN ('active','waiting_review','paused')`,
    [r.contactId],
  );
  await query(`UPDATE enrollments SET status='unsubscribed', updated_at=now(), finished_at=now() WHERE contact_id=$1 AND status IN ('active','waiting_review','paused')`, [r.contactId]);
  // The link is how most people leave, so this is the valve's main input. It
  // runs after the enrollment is closed so the count it reads includes this
  // one. Never allowed to fail the request: somebody clicking unsubscribe must
  // be unsubscribed whatever else goes wrong.
  for (const row of on) {
    if (!row.sequence_id) continue;
    try { await checkValves(row.sequence_id); } catch (e) { log.error('valve check failed', { sequence: row.sequence_id, err: (e as Error).message }); }
  }
}

/**
 * The four answers worth telling apart.
 *
 * Closed list, because a free-text box on an unsubscribe page collects abuse
 * and typos and needs moderating, and because these four lead to genuinely
 * different fixes: pacing, targeting, consent, and everything else. "Other" is
 * there so somebody who wants to answer is never forced into a wrong box.
 */
const UNSUB_REASONS: Record<string, string> = {
  too_many: 'Too many emails',
  not_relevant: 'Not relevant to me',
  never_signed_up: 'I never signed up for this',
  other: 'Something else',
};

// Both a form submit from the page and RFC 8058 one-click (List-Unsubscribe-Post) land here.
/**
 * Record why, if they chose to say.
 *
 * Written onto every enrollment this contact was taken off, which is the only
 * row that knows both the person and the campaign. Never fails visibly: the
 * unsubscribe already happened on the previous request, and an error here must
 * not suggest otherwise.
 */
publicRouter.post('/:token/reason', async (req, res) => {
  const r = await resolve(String(req.params.token));
  const reason = String((req.body as Record<string, unknown>)?.reason ?? '');
  if (r && UNSUB_REASONS[reason]) {
    try {
      await query(
        `UPDATE enrollments SET unsub_reason=$2 WHERE contact_id=$1 AND status='unsubscribed' AND unsub_reason IS NULL`,
        [r.contactId, reason],
      );
    } catch (e) { log.error('unsubscribe reason not recorded', { err: (e as Error).message }); }
  }
  res.send(page('Thank you', '<h1 class="ok">Thank you</h1><p>That is all we needed. You can close this page.</p>'));
});

publicRouter.post('/:token', async (req, res) => {
  const r = await resolve(String(req.params.token));
  if (!r) { res.status(404).send(page('Link not valid', '<h1>This link is not valid</h1>')); return; }
  await unsubscribe(r);
  if (String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded') && String(req.headers.accept ?? '').includes('text/html')) {
    // Asked *after* the unsubscribe has already happened, and never required.
    // The person is leaving; making them answer a question first would be
    // both hostile and, under the one-click rules, non-compliant.
    const buttons = Object.entries(UNSUB_REASONS)
      .map(([k, label]) => `<button type="submit" name="reason" value="${k}" class="reason">${escapeHtml(label)}</button>`)
      .join('');
    res.send(page('Unsubscribed', `<h1 class="ok">You are unsubscribed</h1><p>${escapeHtml(r.email)} will not receive further emails from this sender.</p>
<form method="post" action="/u/${encodeURIComponent(String(req.params.token))}/reason"><p class="ask">If you have a moment — why?</p>${buttons}</form>`));
  } else {
    res.json({ ok: true });
  }
});
