// The pure half of proposing times: turning slots into the sentence that goes
// into an email, and deciding whether a message was asking for them.
//
// Separate from the component because both are worth testing and neither
// needs React — and because the phrasing that reaches a recipient is the part
// of this feature most worth pinning down.

export interface Slot { startsAt: string; endsAt: string }

// "Tuesday 9 September, 10:00–10:30". Written out in full because it is going
// into an email somebody has to read and act on: an abbreviation saves four
// characters and costs the reader a moment of decoding.
export function writeSlot(s: Slot): string {
  const from = new Date(s.startsAt);
  const to = new Date(s.endsAt);
  const day = from.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const t = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${t(from)}–${t(to)}`;
}

// Prose, not a data structure. One time is a question; several are a list
// with a way out at the end, because an offer of three times with no "or say
// if none of them work" reads as an ultimatum.
export function writeSlots(slots: Slot[]): string {
  if (!slots.length) return '';
  if (slots.length === 1) return `Would ${writeSlot(slots[0])} work?`;
  const lines = slots.map((s) => `• ${writeSlot(s)}`).join('\n');
  return `Would any of these work?\n\n${lines}\n\nHappy to find another time if none of them suit.`;
}

// Does this message ask when you are free?
//
// Deliberately a small, dull list of phrases rather than anything cleverer.
// It decides whether one extra chip appears beside the AI's suggestions, so a
// false positive costs a button nobody presses and a false negative costs
// nothing at all — and unlike the suggestions themselves, no model runs to
// work it out.
const ASKS_TIME = /\b(?:when (?:are|would) you|your availability|availabilit(?:y|ies)|are you (?:free|available)|(?:a )?time that (?:works|suits)|does .{0,20}(?:work|suit) for you|(?:set|line) up a (?:call|chat|meeting)|(?:book|schedule|arrange) (?:a |an |some )?(?:call|chat|meeting|time)|(?:hop|jump) on a call|find a time|suggest (?:a |some )?times?|let me know .{0,30}(?:free|available|suits)|calendar)\b/i;

export function asksAboutTime(text: string | null | undefined): boolean {
  if (!text) return false;
  // Only the top of a message: a signature block or a legal footer mentioning
  // a calendar is not somebody asking for one.
  return ASKS_TIME.test(text.slice(0, 4000));
}

// The browser's zone, which is the only place the answer to "nine in the
// morning" lives. No IP is stored server-side and the account's send window is
// about when mail may leave, not when its owner is awake.
export function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
