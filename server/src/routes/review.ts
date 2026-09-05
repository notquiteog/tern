import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { idParam, parse, z } from '../util/validate.js';
import { notFound } from '../errors.js';
import { publish } from '../events.js';

export const reviewRouter = Router();
reviewRouter.use(requireAuth);

reviewRouter.get('/', async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*, c.email, c.first_name, c.last_name, c.company, s.name AS sequence_name, s.id AS sequence_id, a.email AS account_email, st.position AS step_position
     FROM review_queue r JOIN contacts c ON c.id=r.contact_id JOIN enrollments e ON e.id=r.enrollment_id JOIN sequences s ON s.id=e.sequence_id JOIN accounts a ON a.id=r.account_id LEFT JOIN sequence_steps st ON st.id=r.step_id
     WHERE r.user_id=$1 AND r.status='pending' ORDER BY r.created_at`,
    [req.user!.id],
  );
  res.json({ items: rows });
});

reviewRouter.post('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = parse(z.object({ action: z.enum(['approve', 'reject']), subject: z.string().max(998).optional(), body_html: z.string().max(500000).optional() }), req.body);
  const item = await one<any>('SELECT * FROM review_queue WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
  if (!item) throw notFound('Review item not found');
  if (b.action === 'approve') {
    await query(`UPDATE review_queue SET status='approved', subject=COALESCE($2,subject), body_html=COALESCE($3,body_html), decided_at=now() WHERE id=$1`, [id, b.subject ?? null, b.body_html ?? null]);
    await query(`UPDATE enrollments SET status='active', next_run_at=now(), updated_at=now() WHERE id=$1 AND status='waiting_review'`, [item.enrollment_id]);
  } else {
    await query(`UPDATE review_queue SET status='rejected', decided_at=now() WHERE id=$1`, [id]);
    await query(`UPDATE enrollments SET status='paused', updated_at=now() WHERE id=$1 AND status='waiting_review'`, [item.enrollment_id]);
  }
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM review_queue WHERE user_id=$1 AND status='pending'`, [req.user!.id]);
  publish({ type: 'review', userId: req.user!.id, count: pending?.n ?? 0 });
  res.json({ ok: true, pending: pending?.n ?? 0 });
});
