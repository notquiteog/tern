// Smart categories: Primary, Transactions, Updates, Promotions.
//
// The mail cache is encrypted at rest, so this cannot run over the database
// later — it runs once as a message is synced, while the headers and the
// subject are still in the clear, and only the four-value answer is stored.
//
// It is a header-first classifier rather than a model. Bulk mail announces
// itself (List-Id, List-Unsubscribe, Precedence, Auto-Submitted) and the
// remaining ambiguity is mostly between a receipt and an advert, which the
// subject settles. Anything that shows no sign of being automated stays in
// Primary: the cost of a misfiled receipt is small, the cost of hiding a
// message a person actually wrote is not.
export type Category = 'primary' | 'transactions' | 'updates' | 'promotions';
export const CATEGORIES: Category[] = ['primary', 'transactions', 'updates', 'promotions'];

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as string[]).includes(v);
}

export interface CategoryInput {
  subject?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  listId?: string | null;
  listUnsubscribe?: string | null;
  autoSubmitted?: string | null;
  precedence?: string | null;
  // The sender is someone this user has in their contacts, or has written to
  // before. A real correspondent is never filed away, whatever their mail
  // server puts in the headers.
  knownContact?: boolean;
}

// A receipt is the one kind of bulk mail people go looking for, so it is
// matched first and on strong words only. "Order", "payment" and "invoice"
// carry their own weight; "confirmation" and "receipt" need no help either.
const TRANSACTION_SUBJECT = /\b(receipt|invoice|order|purchase|payment|paid|refund|billing statement|statement|transaction|shipped|shipping|dispatched|out for delivery|delivered|tracking|booking|reservation|itinerary|check-?in|ticket|subscription renew\w*|renewal|charged|charge of|payout|remittance|e-?ticket|boarding pass)\b/i;
// Localparts that only ever send transactional mail.
const TRANSACTION_SENDER = /^(billing|invoices?|receipts?|orders?|payments?|pay|checkout|store|shop|sales-?receipt|statements?|accounts?receivable|ar|no-?reply-?billing)\b/i;
// Order numbers and money in a subject line: "#10428", "Order 55-2201", "£42.10".
const TRANSACTION_SHAPE = /(#\s?\d{4,}|\b(?:no\.?|number)\s?\d{4,}\b|[€£$¥]\s?\d+(?:[.,]\d{2})?\b)/i;

// Marketing language. Kept to phrases that do not appear in a receipt, so a
// "your order has shipped" mail with a footer advert is not reclassified.
const PROMO_SUBJECT = /(\b\d{1,3}\s?% ?off\b|\bsale\b|\bdeals?\b|\bdiscount\w*\b|\bcoupon\b|\bpromo\w*\b|\boffer ends\b|\blast chance\b|\bdon'?t miss\b|\blimited time\b|\bexclusive\b|\bblack friday\b|\bcyber monday\b|\bclearance\b|\bflash sale\b|\bsave (?:up to )?\d|\bfree shipping\b|\bnew arrivals?\b|\bshop now\b|\bbuy now\b|\bbest sellers?\b|\bgiveaway\b|\bwebinar\b|\bnewsletter\b|\bunsubscribe\b|🎉|🔥|💥)/i;
const PROMO_SENDER = /^(marketing|promo\w*|deals?|offers?|newsletter|news|hello|hi|team|info|campaign\w*|mail(?:er|ing)|updates?-?marketing)\b/i;

// Machine mail that is neither a receipt nor an advert: alerts, digests,
// password resets, social notifications, CI, monitoring.
const UPDATE_SUBJECT = /\b(notification|alert|reminder|digest|summary|report|security|sign-?in|log-?in|verify|verification|confirm your|password|reset|one-?time|2fa|two-?factor|code is|expires?|expiring|renewal notice|policy|terms|privacy|maintenance|scheduled|incident|status|deploy\w*|build|pull request|issue|comment|mentioned you|invited you|shared)\b/i;
const UPDATE_SENDER = /^(no-?reply|do-?not-?reply|notifications?|alerts?|noreply-\w+|mailer-daemon|postmaster|support|help|system|admin|security|automated|auto|bot|ci|build|jenkins|github|gitlab|jira|updates?)\b/i;

const norm = (v: string | null | undefined) => String(v ?? '').trim();

// True when the message carries a header that only bulk or machine mail has.
export function looksAutomated(input: CategoryInput): boolean {
  const auto = norm(input.autoSubmitted).toLowerCase();
  const prec = norm(input.precedence).toLowerCase();
  return Boolean(
    norm(input.listId) ||
    norm(input.listUnsubscribe) ||
    (auto && auto !== 'no') ||
    ['bulk', 'list', 'junk'].includes(prec),
  );
}

export function categorize(input: CategoryInput): Category {
  const subject = norm(input.subject);
  const email = norm(input.fromEmail).toLowerCase();
  const local = email.split('@')[0] ?? '';
  const automated = looksAutomated(input);

  // Someone in the address book is a person, not a channel — even when they
  // write from a system that stamps List-Unsubscribe on everything.
  if (input.knownContact) return 'primary';

  const transactional = TRANSACTION_SUBJECT.test(subject) || TRANSACTION_SENDER.test(local) ||
    (TRANSACTION_SHAPE.test(subject) && (automated || UPDATE_SENDER.test(local)));
  // Deliberately not matched against the display name: "Sale" is a surname,
  // "Exclusive Ltd" is a company, and neither is an advert. The subject and
  // the sending address are the honest signals.
  const promotional = PROMO_SUBJECT.test(subject) || PROMO_SENDER.test(local);

  // A receipt beats an advert: shops send both, and the one with an order
  // number in it is the one that will be needed again.
  if (transactional && !(promotional && !TRANSACTION_SUBJECT.test(subject))) return 'transactions';

  if (!automated) {
    // No bulk headers at all. Only an unmistakably promotional subject from
    // an unmistakably promotional sender moves it out of Primary; everything
    // else is treated as a person writing.
    return promotional && PROMO_SENDER.test(local) ? 'promotions' : 'primary';
  }

  if (promotional) return 'promotions';
  if (UPDATE_SUBJECT.test(subject) || UPDATE_SENDER.test(local)) return 'updates';
  // Bulk, but nothing says what kind. A mailing list with a List-Id reads as
  // an update; a bare List-Unsubscribe is the mark of a marketing send.
  return norm(input.listId) ? 'updates' : 'promotions';
}
