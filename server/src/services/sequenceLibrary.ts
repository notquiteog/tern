// Sequences you can start from, rather than from a blank page.
//
// Templates have had a starter library since they shipped and sequences never
// did, so every campaign began with an empty editor and a decision about how
// many steps and how long to wait — questions somebody writing their first
// outreach sequence has no basis to answer, and which have well-known answers.
//
// ── Why these are shapes and not copy ───────────────────────────────────────
//
// Each one is a structure — how many emails, how far apart, what each is for —
// with the brief written as an instruction to the person rather than as
// sendable prose. A library of ready-made sales copy would be the wrong thing
// twice: it would be somebody else's voice, and it would be the same email
// every install of Tern sends, which is exactly what spam filters are built to
// notice. The waits and the shape are the reusable part.
export interface LibrarySequence {
  key: string;
  name: string;
  description: string;
  /** What it is for, in the person's terms, shown on the card. */
  when: string;
  steps: { kind: 'email' | 'wait'; days?: number; brief?: string; instructions?: string }[];
}

export const SEQUENCE_LIBRARY: LibrarySequence[] = [
  {
    key: 'cold-three-touch',
    name: 'Cold intro, three touches',
    when: 'A list you have never written to. The shape most cold outreach should be.',
    description: 'One short opener, a nudge four days later, and a last short note a week after that. Stops the moment anybody replies.',
    steps: [
      { kind: 'email', brief: 'Say who you are in one sentence, name the one specific thing you do that is relevant to this company, and ask a single question. No pitch, no list of features, under 90 words.', instructions: 'Under 90 words. No exclamation marks. Do not open with "I hope this finds you well".' },
      { kind: 'wait', days: 4 },
      { kind: 'email', brief: 'A short nudge in the same thread. Restate the single most useful point in one sentence and ask the same question again, more briefly. Do not apologise for writing again.', instructions: 'Under 60 words. Same thread, so no greeting block and no signature repetition.' },
      { kind: 'wait', days: 7 },
      { kind: 'email', brief: 'A last short note saying you will stop writing, and leaving the door open. Ask them to reply with a single word if it is ever worth revisiting.', instructions: 'Under 50 words. Warm, not wounded.' },
    ],
  },
  {
    key: 'reengage-quiet',
    name: 'Re-engage the quiet ones',
    when: 'Customers or contacts who have gone quiet. Pairs with the "quiet 90 days" contact filter.',
    description: 'Two emails a week apart, written as a check-in rather than a sale.',
    steps: [
      { kind: 'email', brief: 'A genuine check-in. Reference that it has been a while, say the one thing that has changed since you last spoke that they would care about, and ask an open question about how things are going for them.', instructions: 'Under 100 words. Conversational. No offer and no pricing.' },
      { kind: 'wait', days: 7 },
      { kind: 'email', brief: 'A brief follow-up offering one concrete, small next step — a short call, a link, an answer to a question they might have. Make it easy to say no to.', instructions: 'Under 70 words.' },
    ],
  },
  {
    key: 'after-event',
    name: 'After a meeting or an event',
    when: 'People you have actually met. Shorter and warmer, because there is a reason to write.',
    description: 'A same-week note and one follow-up, both referring to the conversation you had.',
    steps: [
      { kind: 'email', brief: 'Thank them for the conversation, name the specific thing you talked about, and propose the next step you agreed on. If nothing was agreed, ask whether a short call would be useful.', instructions: 'Under 80 words. Warm and specific; a generic thank-you is worse than nothing.' },
      { kind: 'wait', days: 5 },
      { kind: 'email', brief: 'A short reminder of the next step, with the single most useful thing you can give them attached as a link rather than a file.', instructions: 'Under 60 words.' },
    ],
  },
  {
    key: 'single-announcement',
    name: 'One announcement, one follow-up',
    when: 'A launch, a price change, an event. Everybody gets the same news.',
    description: 'One clear email and one reminder, with the ask in both.',
    steps: [
      { kind: 'email', brief: 'State the news in the first sentence. Say what it means for this reader specifically. End with one ask. Put every real figure and date in the brief before running this — anything not here will be held back rather than invented.', instructions: 'Under 120 words. Lead with the news, not with context.' },
      { kind: 'wait', days: 5 },
      { kind: 'email', brief: 'A short reminder in the same thread, restating the deadline or the ask and nothing else.', instructions: 'Under 50 words.' },
    ],
  },
];

export const LIBRARY_BY_KEY = new Map(SEQUENCE_LIBRARY.map((s) => [s.key, s]));
