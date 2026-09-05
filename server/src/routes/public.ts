// Unsubscribe landing page. No login, no JavaScript required, one click.
// The token is signed, so it cannot be guessed for another contact, and it
// carries nothing but ids.
import { Router } from 'express';
import { one, query } from '../db.js';
import { verifyPayload } from '../crypto.js';
import { escapeHtml } from '../services/merge.js';

export const publicRouter = Router();

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7fb;color:#1c1f2b;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e4e7f0;border-radius:14px;padding:32px;max-width:440px;width:calc(100% - 32px);box-shadow:0 10px 30px rgba(20,30,60,.06)}h1{font-size:20px;margin:0 0 8px}p{color:#5b6274;line-height:1.5;margin:0 0 20px}
button{background:#1c1f2b;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:15px;cursor:pointer;width:100%}.ok{color:#1c7c4d}</style></head><body><div class="card">${body}</div></body></html>`;
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

publicRouter.get('/u/:token', async (req, res) => {
  const r = await resolve(String(req.params.token));
  if (!r) { res.status(404).send(page('Link not valid', '<h1>This link is not valid</h1><p>The unsubscribe link may have been altered. Reply to the email with the word "stop" instead and you will be removed.</p>')); return; }
  res.send(page('Unsubscribe', `<h1>Stop receiving these emails?</h1><p>Confirm below and <strong>${escapeHtml(r.email)}</strong> will not be contacted again.</p><form method="post"><button type="submit">Unsubscribe</button></form>`));
});

async function unsubscribe(r: { userId: number; contactId: number; email: string }): Promise<void> {
  await query(`INSERT INTO suppressions (user_id, email, reason, source) VALUES ($1, lower($2), 'unsubscribe', 'link') ON CONFLICT (user_id, email) DO UPDATE SET reason='unsubscribe'`, [r.userId, r.email]);
  await query(`UPDATE contacts SET status='unsubscribed', updated_at=now() WHERE id=$1`, [r.contactId]);
  await query(`UPDATE enrollments SET status='unsubscribed', updated_at=now(), finished_at=now() WHERE contact_id=$1 AND status IN ('active','waiting_review','paused')`, [r.contactId]);
}

// Both a form submit from the page and RFC 8058 one-click (List-Unsubscribe-Post) land here.
publicRouter.post('/u/:token', async (req, res) => {
  const r = await resolve(String(req.params.token));
  if (!r) { res.status(404).send(page('Link not valid', '<h1>This link is not valid</h1>')); return; }
  await unsubscribe(r);
  if (String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded') && String(req.headers.accept ?? '').includes('text/html')) {
    res.send(page('Unsubscribed', `<h1 class="ok">You are unsubscribed</h1><p>${escapeHtml(r.email)} will not receive further emails from this sender.</p>`));
  } else {
    res.json({ ok: true });
  }
});
