import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { notFound } from '../errors.js';
import { publish } from '../events.js';
import { getAccount } from '../services/accounts.js';
import { composeAndSend } from '../services/compose.js';
import { openEmailWith, openReview, openReviewWith, sealReview } from '../services/mailVault.js';
import { dataKey, seal } from '../services/vault.js';

export const reviewRouter = Router();
reviewRouter.use(requireAuth);

reviewRouter.get('/', async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*, c.email, c.first_name, c.last_name, c.company, s.name AS sequence_name, s.id AS sequence_id, a.email AS account_email, st.position AS step_position, rp.name AS responder_name,
            (SELECT jsonb_build_object('subject', x.subject, 'from', x.from_addr, 'preview', x.preview, 'received_at', x.received_at) FROM emails x WHERE x.id=r.reply_to_email_id) AS original
     FROM review_queue r LEFT JOIN contacts c ON c.id=r.contact_id LEFT JOIN enrollments e ON e.id=r.enrollment_id LEFT JOIN sequences s ON s.id=e.sequence_id JOIN accounts a ON a.id=r.account_id LEFT JOIN sequence_steps st ON st.id=r.step_id LEFT JOIN responders rp ON rp.id=r.responder_id
     WHERE r.user_id=$1 AND r.status='pending' ORDER BY r.created_at`,
    [req.user!.id],
  );
  // Both the queued reply and the `original` it answers are sealed.
  const dek = await dataKey(req.user!.id);
  const items = rows.map((r) => openReviewWith(dek, r));
  for (const r of items) {
    if (!r.original) continue;
    const o = openEmailWith(dek, { subject: r.original.subject, preview: r.original.preview, from_addr: r.original.from });
    r.original = { ...r.original, subject: o.subject, preview: o.preview, from: o.from_addr };
  }
  res.json({ items });
});

reviewRouter.post('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ action: z.enum(['approve', 'reject']), subject: z.string().max(998).optional(), body_html: z.string().max(500000).optional() }), req.body);
  const stored = await one<any>('SELECT * FROM review_queue WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  if (!stored) throw notFound('Review item not found');
  const item = (await openReview(req.user!.id, stored))!;
  if (b.action === 'approve') {
    // What the person edited comes back in the clear and is sealed again.
    const edited = await sealReview(req.user!.id, { subject: b.subject ?? item.subject, body_html: b.body_html ?? item.body_html });
    await query(`UPDATE review_queue SET status='approved', subject=$2, body_html=$3, decided_at=now() WHERE id=$1`, [id, edited.subject, edited.body_html]);
    if (item.kind === 'reply') {
      // An approved auto-reply goes out now, through the account's pacing if the responder asked for it.
      const acc = await getAccount(item.account_id);
      const responder = item.responder_id ? await one<any>('SELECT * FROM responders WHERE id=$1', [item.responder_id]) : null;
      if (acc) {
        const payload = { to: item.to_addr, subject: b.subject ?? item.subject, html: b.body_html ?? item.body_html, replyToEmailId: item.reply_to_email_id, kind: 'auto_reply', contactId: item.contact_id, responderId: item.responder_id, includeSignature: true, encrypt: 'if_possible', reviewed: true };
        if (responder?.humanize) await query('INSERT INTO outbox (user_id, account_id, payload, send_at) VALUES ($1,$2,$3,now())', [acc.user_id, acc.id, await seal(acc.user_id, JSON.stringify({ ...payload, humanize: true }))]);
        else await composeAndSend(acc, payload as any);
      }
    } else if (item.enrollment_id) {
      await query(`UPDATE enrollments SET status='active', next_run_at=now(), updated_at=now() WHERE id=$1 AND status='waiting_review'`, [item.enrollment_id]);
    }
  } else {
    await query(`UPDATE review_queue SET status='rejected', decided_at=now() WHERE id=$1`, [id]);
    if (item.enrollment_id) await query(`UPDATE enrollments SET status='paused', updated_at=now() WHERE id=$1 AND status='waiting_review'`, [item.enrollment_id]);
  }
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [req.user!.id]);
  publish({ type: 'review', userId: req.user!.id, count: pending?.n ?? 0 });
  res.json({ ok: true, pending: pending?.n ?? 0 });
});
