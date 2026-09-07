// What a campaign has actually done, in the five numbers a person running one
// wants: how many are queued, sent, failed, replied and unsubscribed.
//
// The sequence list already showed enrollment states, which answer "where is
// everybody in the sequence" rather than "what has this campaign done to my
// sending domain". Those are different questions, and the second one is the
// one that decides whether to keep going.
import { one } from '../db.js';

export interface CampaignMetrics {
  /** People enrolled, whatever state they are in. */
  enrolled: number;
  /** Drafts waiting for a person in the review queue. */
  queued: number;
  /** Of those, the ones the guard stopped rather than the ones merely awaiting a look. */
  held: number;
  sent: number;
  failed: number;
  replied: number;
  unsubscribed: number;
  bounced: number;
}

export async function campaignMetrics(sequenceId: number): Promise<CampaignMetrics> {
  const r = await one<CampaignMetrics>(
    `SELECT
       (SELECT count(*)::int FROM enrollments e WHERE e.sequence_id=$1) AS enrolled,
       (SELECT count(*)::int FROM review_queue q JOIN enrollments e ON e.id=q.enrollment_id WHERE e.sequence_id=$1 AND q.status='pending') AS queued,
       (SELECT count(*)::int FROM review_queue q JOIN enrollments e ON e.id=q.enrollment_id WHERE e.sequence_id=$1 AND q.hold_reason IS NOT NULL) AS held,
       (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=$1 AND l.status='sent') AS sent,
       (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=$1 AND l.status='failed') AS failed,
       (SELECT count(*)::int FROM send_log l WHERE l.sequence_id=$1 AND l.replied_at IS NOT NULL) AS replied,
       (SELECT count(*)::int FROM enrollments e WHERE e.sequence_id=$1 AND e.status='unsubscribed') AS unsubscribed,
       (SELECT count(*)::int FROM enrollments e WHERE e.sequence_id=$1 AND e.status='bounced') AS bounced`,
    [sequenceId],
  );
  return r ?? { enrolled: 0, queued: 0, held: 0, sent: 0, failed: 0, replied: 0, unsubscribed: 0, bounced: 0 };
}
