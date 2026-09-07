// How a template has actually done, which the app knew and never said.
//
// The template card used to end in "48 sent", which measures effort. A
// template is for getting an answer, so the number that belongs there is how
// many of those 48 came back — and it is the number that should decide which
// template the composer offers first, rather than whatever order the list
// happened to arrive in.
//
// It lives here rather than beside either of them because the page that shows
// the rate and the composer that sorts by it must agree about what counts.

// A handful of sends is not a rate. Below this the card says how many went
// out and stops: "100%" over two emails is a claim about luck.
export const RATE_FLOOR = 8;

export function replyRate(t: { sent_count?: number; reply_count?: number }): number | null {
  const sent = Number(t.sent_count ?? 0);
  if (sent < RATE_FLOOR) return null;
  return Math.round((100 * Number(t.reply_count ?? 0)) / sent);
}

// Best first, then the starred, then whatever was touched most recently.
// Anything without a rate sorts below everything with one, rather than to the
// top on a zero it has not earned.
export function byPerformance(a: any, b: any): number {
  const ra = replyRate(a);
  const rb = replyRate(b);
  if (ra !== null || rb !== null) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    if (ra !== rb) return rb - ra;
  }
  if (Boolean(a.starred) !== Boolean(b.starred)) return a.starred ? -1 : 1;
  return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
}
