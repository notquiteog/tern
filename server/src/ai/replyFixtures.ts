// Detailed conversations for reply.eval.ts, and for the grader's own tests.
//
// fixtures.ts holds one conversation, and one conversation cannot tell you
// whether a reply came from the thread it was meant to answer. These are
// several, with nothing in common but the mailbox they sit in: a kitchen
// refit, a supplier outage, a job offer, a school trip, the Northwind
// procurement thread, and two pieces of marketing mail that nobody will ever
// answer.
//
// Each carries words that belong to it and to no other (`marks`). A reply to
// one of them that says something from another has pulled it across — which
// is what "it looks like it's pulling data from other email threads" means,
// and something no single-thread fixture can detect.
//
// The marketing mail is HTML only, with Quill-style markup, a promo code and a
// list of industries, in the shape of what turned up inside a reply that went
// wrong. It is never replied to; it is only ever something that must not leak.
//
// As in fixtures.ts, a graded fact sits inside a paragraph about something
// else rather than alone on a line, and several threads change their mind
// part-way through so that stating the old position is a separate failure
// from forgetting the new one.
import { ALEX, DANA, PRIYA, TOMASZ, quoteOf, realisticThread, signature, type Person } from './fixtures.js';
import { htmlToText } from '../services/merge.js';

/** The mailbox owner. The evaluation swaps in the real account's name and address. */
export const ME: Person = ALEX;

const MARTA: Person = { name: 'Marta Kowalczyk', email: 'marta@kowalczykjoinery.example', title: 'Director', company: 'Kowalczyk & Sons Joinery', phone: '+44 161 496 0731' };
const DEV: Person = { name: 'Dev Patel', email: 'dev.patel@kowalczykjoinery.example', title: 'Site Manager', company: 'Kowalczyk & Sons Joinery', phone: '+44 161 496 0755' };
const HANNAH: Person = { name: 'Hannah Brooks', email: 'hannah.brooks@relaywire.example', title: 'Account Manager', company: 'Relaywire' };
const KENJI: Person = { name: 'Kenji Watanabe', email: 'kenji@relaywire.example', title: 'Support Engineer', company: 'Relaywire' };
const GRACE: Person = { name: 'Grace Lin', email: 'grace@talentbridge.example', title: 'Senior Recruiter', company: 'TalentBridge', phone: '+44 113 496 0901' };
const TOMAS: Person = { name: 'Tomás Ferreira', email: 'tomas.ferreira@mailbox.example' };
const ELEANOR: Person = { name: 'Eleanor Hughes', email: 'e.hughes@stbrigids.example', title: 'Year 6 Trip Coordinator', company: "St Brigid's Primary School" };
const CHIDI: Person = { name: 'Chidi Nwosu', email: 'chidi.nwosu@parentmail.example' };
const LEDGERLY: Person = { name: 'Ledgerly Launch Team', email: 'hello@news.ledgerly.example' };
const BRIGHTWATER: Person = { name: 'Brightwater Roasters', email: 'orders@brightwater.example' };

interface Msg {
  who: Person;
  to: Person[];
  cc?: Person[];
  /** When it arrived, in UTC. */
  at: string;
  body?: string;
  /** For mail that is HTML only, the way most marketing mail is. */
  html?: string;
  sig?: 'full' | 'footer' | 'short' | 'none';
  quote?: boolean;
}

/** A fact a correct reply states, as any of the ways it could be written. */
export interface Required { id: string; re: RegExp; why: string }
/** A position the thread moved away from. Stating it is confidently wrong. */
export interface Superseded { id: string; re: RegExp; why: string }

export interface ReplyTask {
  /** What the person asks for, as they would type it. Deliberately not a list of the facts. */
  instruction: string;
  /** Who the reply is to. */
  recipient: Person;
  /** People in the thread who are not the recipient and must not be greeted. */
  forbidden: string[];
  required: Required[];
  superseded?: Superseded[];
  length?: 'short' | 'medium' | 'long';
}

export interface DetailedThread {
  id: string;
  subject: string;
  messages: Msg[];
  /** Words that belong to this conversation and to no other in the mailbox. */
  marks: string[];
  /** Absent for mail nobody answers. */
  task?: ReplyTask;
}

export interface FixtureMail { from: Person; to: Person[]; cc: Person[]; text: string; html: string; at: Date }

// ---------- a kitchen refit ----------

const KITCHEN: DetailedThread = {
  id: 'kitchen',
  subject: 'Kitchen and dining room — quote',
  marks: ['Kowalczyk', 'pantry', 'radiator', 'worktop', 'Didsbury', 'artex', 'skip permit'],
  messages: [
    {
      who: ME, to: [MARTA], at: '2026-08-24T19:40:00Z', sig: 'full',
      body: `Hi Marta,

Your name came from our neighbours at number 14, who could not stop talking about the kitchen you fitted for them in the spring — apparently the drawers still close silently, which in their house is a minor miracle. We are at 22 Grange Road in Didsbury, a 1930s semi, and we would like to knock the kitchen and the dining room into one room with an L-shaped run of units along the back wall and the side.

We have a rough budget of around eighteen thousand for units, worktops and fitting, not including flooring, which we would rather choose ourselves. Ideally the work would start in the autumn, once the school term has settled down. One complication is that the boiler lives in a cupboard in the kitchen and I have no idea whether that is a problem.

Would you be able to come and have a look some evening in the next couple of weeks?`,
    },
    {
      who: MARTA, to: [ME], at: '2026-08-28T08:15:00Z', sig: 'footer', quote: true,
      body: `Hi Alex,

Thank you for getting in touch, and please pass on my thanks to number 14 — the silent drawers are the hinges, not us, but we will take the credit. It was good to see the house on Tuesday evening. The boiler cupboard is not a problem: we can build the run around it and leave the boiler accessible for servicing, which your gas engineer will want anyway.

Our first quote is below. Units, quartz worktops, fitting, plastering the knock-through and the electrics by our usual electrician come to £18,400, excluding flooring as you asked, and we would expect to be on site for six weeks. Because of the artex on the dining room ceiling I would strongly recommend an asbestos survey before anybody takes it down; it costs £350 and we arrange it through a surveyor we trust. Our terms are a 25% deposit on booking and the balance in three stages as the work goes.`,
    },
    {
      who: ME, to: [MARTA], at: '2026-08-29T21:02:00Z', sig: 'short', quote: true,
      body: `Hi Marta,

Thanks for such a clear quote. Two changes before we go any further. We have gone back and forth on the worktops and we would rather have oak than quartz — we like how it ages, and we are prepared to oil it. And we would like to add a tall pantry unit next to the fridge, since the dining room currently holds most of our food in a sideboard that is about to disappear.

The other question is the old cast-iron radiator under the dining room window. It is ugly in a way we have grown fond of. Could it stay, or does the new layout mean it has to move? Please go ahead with the asbestos survey in the meantime.`,
    },
    {
      who: MARTA, to: [ME], cc: [DEV], at: '2026-09-02T10:30:00Z', sig: 'full', quote: true,
      body: `Hi Alex,

Revised figures below, and I am copying in Dev Patel, who will be your site manager and your first call once we are on site. Oak worktops come in £600 cheaper than the quartz and the tall pantry unit adds £1,350, so the revised total is £19,150, which makes the deposit £4,787.50. Everything else in the first quote stands, including the six weeks.

On timing, the earliest we can start is Monday 5 October; the team is on another job until the end of September. On the radiator: keeping it where it is costs nothing, because the new run of units stops short of it. If you would rather move it to the side wall, our plumber would charge £420 to do that. Your choice entirely — plenty of people keep them.`,
    },
    {
      who: DEV, to: [ME], cc: [MARTA], at: '2026-09-04T16:45:00Z', sig: 'full',
      body: `Hi Alex,

Dev here — pleased to meet you, sort of. Good news on the survey: the surveyor came back this morning and there is no asbestos in the artex, so the ceiling can come down in the normal way with no special handling.

We will need a skip for the first week. The council wants five working days' notice for a skip permit, but because it will sit on your drive rather than the road we do not need a parking suspension, which saves both of us a fortnight of paperwork. We arrange the permit and the cost is already in the quote.`,
    },
    {
      who: ME, to: [DEV], cc: [MARTA], at: '2026-09-05T09:12:00Z', sig: 'short', quote: true,
      body: `Hi Dev,

That is a relief about the artex — thank you for chasing it so quickly.

Two small practical things. How often does an oak worktop actually need oiling? I have read everything from weekly to never. And the drive needs to be clear before 8.15 on school days, because that is when we reverse out for the school run; if the skip can sit to the left-hand side we will be fine.`,
    },
    {
      who: DEV, to: [ME], cc: [MARTA], at: '2026-09-07T07:58:00Z', sig: 'short', quote: true,
      body: `Morning Alex,

Every three months for the first year and then twice a year is what we tell everybody, and I will leave you a tin of the oil we use. The skip will arrive on Friday 2 October and go on the left-hand side of the drive, and our vans will park on the road rather than the drive, so the school run is safe.`,
    },
    {
      who: MARTA, to: [ME], cc: [DEV], at: '2026-09-10T12:20:00Z', sig: 'full', quote: true,
      body: `Hi Alex,

Before I book the team in for good, can you confirm you are happy with the revised total and the start date? And do you want to keep the old radiator where it is, or have it moved to the side wall? Once I hear back I will send the deposit invoice and you are in the diary.`,
    },
  ],
  task: {
    instruction: 'Accept the revised total and the start date, and say we would like to keep the old radiator where it is.',
    recipient: MARTA,
    forbidden: [DEV.name],
    required: [
      { id: 'total', re: /19,?150/, why: 'the revised total, £19,150' },
      { id: 'start', re: /\b5(?:th)?\s+(?:of\s+)?october\b|\boctober\s+5(?:th)?\b/i, why: 'the Monday 5 October start' },
      { id: 'radiator', re: /\bradiator\b/i, why: 'the answer about the radiator' },
    ],
    // The first quote was quartz at £18,400. Accepting either of those is
    // accepting a quote that no longer exists.
    superseded: [
      // Not when the new total comes first: "happy with £19,150, up from
      // £18,400" names the old figure to explain the new one.
      { id: 'old-total', re: /\b(?:happy with|accept(?:ing)?|agree(?:d)? to|confirm(?:ing)?)\b(?:(?!19,?150)[^.]){0,40}£?18,?400/i, why: 'accepts the first quote (£18,400) rather than the revised £19,150' },
    ],
  },
};

// ---------- a supplier outage and the credit it earned ----------

const OUTAGE: DetailedThread = {
  id: 'outage',
  subject: 'Webhook deliveries failing — ticket RW-48213',
  marks: ['Relaywire', 'RW-48213', 'webhook', 'TLS', 'X-Relaywire-Seq', 'credit note'],
  messages: [
    {
      who: ME, to: [KENJI], at: '2026-09-02T08:31:00Z', sig: 'full',
      body: `Hi Kenji,

Our webhook deliveries from Relaywire have been failing since 09:10 BST this morning — according to your own delivery log every POST to our endpoint is timing out on your side before it reaches us. It matters more than usual because we use those webhooks to sync bank feeds for about forty bookkeeping clients, and all forty are now stalled.

I have opened ticket RW-48213 through the portal with the delivery IDs attached to it. Is this something on your end? Your status page is still showing everything green.`,
    },
    {
      who: KENJI, to: [ME], at: '2026-09-02T08:52:00Z', sig: 'full', quote: true,
      body: `Hi Alex,

Thanks for the detail, it helped. Yes, this is on our side: we are seeing failures on the EU webhook gateway across a number of customers and I have declared an incident. The status page lags the incident channel by a few minutes and should catch up shortly. I will update you on the ticket as soon as we know the cause.`,
    },
    {
      who: KENJI, to: [ME], at: '2026-09-02T12:05:00Z', sig: 'full', quote: true,
      body: `Hi Alex,

This is resolved as of 12:50 BST, so the incident ran for three hours and forty minutes. The cause was an expired TLS certificate on the EU webhook gateway: the renewal job had been failing quietly for a week, and the alert that should have told us so was pointed at a mailbox nobody reads any more. We have renewed it and replayed every queued event.

Could you confirm your endpoint received the backlog? We show everything delivered from our side, but I would rather hear it from you.`,
    },
    {
      who: ME, to: [KENJI], cc: [HANNAH], at: '2026-09-03T07:40:00Z', sig: 'full', quote: true,
      body: `Hi Kenji,

The backlog arrived, thank you — although 212 of the events came through out of order, which posted a handful of reversals before the original transactions and gave two of our clients a very confusing morning. We have untangled it by hand.

I am copying in Hannah, because our contract has a monthly uptime commitment of 99.9% and yesterday was well below that. Hannah, could you let me know what service credit applies, and could we have a written root cause analysis? We will need to show it to two of our own clients.`,
    },
    {
      who: HANNAH, to: [ME], cc: [KENJI], at: '2026-09-04T10:15:00Z', sig: 'footer', quote: true,
      body: `Hi Alex,

I am sorry — that is not the experience we want anybody to have, and the monitoring gap Kenji described is embarrassing. Under the SLA schedule in your contract, a month that falls below 99.9% earns a service credit of 10% of the monthly fee. You are on the Growth plan at £1,200 a month, so the credit comes to £120. Kenji's team will have the written RCA to you by 18 September.

On the ordering: Relaywire guarantees at-least-once delivery but not ordering, which is in the docs but clearly not prominently enough. Every event carries an X-Relaywire-Seq header, and ordering by that on your side would have kept the reversals behind their originals. Kenji is happy to walk your developer through it.`,
    },
    {
      who: ME, to: [HANNAH], cc: [KENJI], at: '2026-09-07T16:20:00Z', sig: 'short', quote: true,
      body: `Hi Hannah,

Thank you, that is a fair answer and a clear one. For what it is worth, three hours forty is about half a percent of the month, so we will end up nearer 99.5% than 99.9%, but the schedule is what it is and 10% is fine.

One request on the mechanics: September's invoice has already been paid by direct debit, so could the credit go on the October invoice instead? And I would like to take Kenji up on his offer — our developer, Sunita, will be in touch about the sequence header. Separately, it would reassure me to know that certificate expiry is now watched somewhere a human will actually see it.`,
    },
    {
      who: HANNAH, to: [ME], cc: [KENJI], at: '2026-09-10T14:02:00Z', sig: 'full', quote: true,
      body: `Hi Alex,

Certificate expiry now alerts the on-call rota directly, and Kenji will cover that in the RCA as well.

Finance have asked me to get the credit in writing before they raise the credit note. Could you confirm the amount you are expecting and which invoice you would like it applied to? Please quote the ticket reference as well, so they can match it to the incident.`,
    },
  ],
  task: {
    instruction: 'Give her what finance need.',
    recipient: HANNAH,
    forbidden: [KENJI.name, 'Sunita'],
    required: [
      { id: 'amount', re: /£?\s?120(?:\.00)?\b/, why: 'the £120 credit' },
      { id: 'invoice', re: /\boctober\b/i, why: 'the October invoice' },
      { id: 'ticket', re: /\bRW-?48213\b/i, why: 'the ticket reference RW-48213' },
    ],
    superseded: [
      // Not when October comes first: "apply it to October's bill, as
      // September's invoice is paid" is the right answer with its reason.
      { id: 'september-invoice', re: /\b(?:appl(?:y|ied)|put|go(?:es)?|credit(?:ed)?)\b(?:(?!\boctober\b)[^.]){0,30}\bseptember(?:'s)? invoice\b/i, why: 'asks for the credit on the September invoice, which was already paid' },
    ],
  },
};

// ---------- a job offer, renegotiated ----------

const OFFER: DetailedThread = {
  id: 'offer',
  subject: 'Senior Data Engineer — Tomás Ferreira',
  marks: ['Senior Data Engineer', 'TalentBridge', 'Ferreira', 'Owen Marsh', 'pension'],
  messages: [
    {
      who: GRACE, to: [ME], at: '2026-08-20T09:05:00Z', sig: 'full',
      body: `Hi Alex,

As promised on the phone, here is the candidate I mentioned for your Senior Data Engineer role. Tomás Ferreira has six years at a payments fintech in Manchester, most recently leading their move from nightly batch jobs to streaming, which is almost exactly the project you described. He is on £74,000 at the moment, has a four-week notice period, and is looking for something north of £80,000. He would strongly prefer a hybrid arrangement to full time in the office.

His CV is on the TalentBridge portal under your account. Would you like me to set up a first interview?`,
    },
    {
      who: ME, to: [GRACE], at: '2026-08-21T08:30:00Z', sig: 'short', quote: true,
      body: `Hi Grace,

He looks strong, and the streaming work is exactly what we need, so yes please. For your planning, the band for this role is £78,000 to £85,000, the team is based in our Leeds office, and the standard arrangement is two days a week working from home. We do not offer relocation for this role, which should not matter if he is in Manchester.`,
    },
    {
      who: GRACE, to: [ME], cc: [TOMAS], at: '2026-08-26T11:10:00Z', sig: 'full', quote: true,
      body: `Hi both,

Lovely — I have booked the interview for Thursday 3 September at 14:00 at the Leeds office. It will be a panel of three, including Alex, followed by a forty-minute technical exercise on a laptop we provide, so there is nothing to bring except a photo ID for reception. Tomás, parking is on the street behind the building; the car park at the front is permit only.`,
    },
    {
      who: ME, to: [TOMAS], cc: [GRACE], at: '2026-09-04T16:30:00Z', sig: 'full',
      body: `Hi Tomás,

Thank you for yesterday — the whole panel came out of it wanting to work with you, which does not always happen. I am delighted to offer you the Senior Data Engineer role at a base salary of £82,000, with 25 days' holiday plus bank holidays and a pension matched up to 6%. Allowing for your four weeks' notice, we would suggest a start date of Monday 2 November.

The standard arrangement is two days a week working from home, like the rest of the team. Owen Marsh in HR will send the contract once you have said yes in principle.`,
    },
    {
      who: TOMAS, to: [ME], cc: [GRACE], at: '2026-09-06T19:14:00Z', sig: 'short', quote: true,
      body: `Hi Alex,

Thank you, that is a great offer and I am very happy with the salary and the start date. One thing I would like to ask before I accept: could it be three days a week from home rather than two? My partner works Mondays and Fridays, and school pickup on those days is ours to solve. I would be in the office Tuesdays and Wednesdays without fail, and of course flexible for anything that genuinely needs me there.`,
    },
    {
      who: ME, to: [TOMAS], cc: [GRACE], at: '2026-09-08T10:45:00Z', sig: 'short', quote: true,
      body: `Hi Tomás,

Yes, that is fine, and thank you for asking plainly rather than hoping. So: three days a week from home, in the Leeds office on Tuesdays and Wednesdays. I have told Owen Marsh in HR so the contract says so rather than the standard two days, and the start date stays as it was.`,
    },
    {
      who: TOMAS, to: [ME], at: '2026-09-10T07:05:00Z', sig: 'short', quote: true,
      body: `Hi Alex,

Before I sign, could you confirm in writing the hybrid arrangement we agreed and my start date? My current employer's HR team want the date for my leaving paperwork, and I would rather it came from you than from me.`,
    },
  ],
  task: {
    instruction: 'Confirm both in writing.',
    recipient: TOMAS,
    forbidden: [GRACE.name, 'Owen Marsh'],
    required: [
      { id: 'start', re: /\b2(?:nd)?\s+(?:of\s+)?november\b|\bnovember\s+2(?:nd)?\b/i, why: 'the Monday 2 November start' },
      { id: 'hybrid', re: /\b(?:three|3)\s+days\b/i, why: 'three days a week from home' },
      { id: 'office-days', re: /tuesdays?\b[^.]{0,40}\bwednesdays?|wednesdays?\b[^.]{0,40}\btuesdays?/i, why: 'the office days, Tuesday and Wednesday' },
    ],
    superseded: [
      { id: 'two-days', re: /\b(?:two|2)\s+days\s+(?:a\s+week\s+)?(?:from home|working from home|remote(?:ly)?|at home)\b(?![^.]{0,40}\b(?:rather than|instead|changed|not)\b)/i, why: 'states the original two days at home; it was changed to three' },
    ],
  },
};

// ---------- a school trip ----------

const TRIP: DetailedThread = {
  id: 'trip',
  subject: 'Year 6 residential — Kingswood, October',
  marks: ['Kingswood', 'residential', 'Year 6', 'instalment', 'antihistamine', 'zip wire'],
  messages: [
    {
      who: ELEANOR, to: [ME, CHIDI], at: '2026-09-01T14:30:00Z', sig: 'full',
      body: `Dear Year 6 parents and carers,

I am delighted to confirm that this year's Year 6 residential will go ahead at Kingswood Dearne Valley from Wednesday 14 to Friday 16 October. The children will do climbing, archery, a night walk and the famous zip wire, and in our experience it is the thing they talk about for the rest of the year.

The cost is £285 per child, which can be paid in three instalments of £95 through the school payments app: the first by 18 September, the second by 1 October and the last by 12 October. Please also return the medical and consent form, including details of any medication your child will need while away, by 30 September at the latest. The kit list is on the school website under Year 6.`,
    },
    {
      who: CHIDI, to: [ELEANOR], cc: [ME], at: '2026-09-02T06:45:00Z', sig: 'short', quote: true,
      body: `Hi Mrs Hughes,

Thanks for this, Ada is already packing. Two quick ones that I suspect every parent is wondering: are the children allowed their phones, and roughly what time will the coach be back on the Friday? We both work and need to sort out pickup.`,
    },
    {
      who: ELEANOR, to: [CHIDI], cc: [ME], at: '2026-09-02T11:10:00Z', sig: 'full', quote: true,
      body: `Dear Mr Nwosu,

No phones, I am afraid — it is a residential rule and, honestly, a large part of why the trip works. We post a short update with photos on the school blog each evening so you can see what they have been up to. The coach should be back at school at about 3.30pm on Friday 16 October, and we will text if we are running late.`,
    },
    {
      who: ME, to: [ELEANOR], at: '2026-09-04T19:30:00Z', sig: 'short',
      body: `Dear Mrs Hughes,

I have paid Maya's first instalment through the app this evening. One thing to flag early: Maya has a mild nut allergy. It has never been serious, but she carries antihistamine tablets and knows when to take them. Could you tell me how the centre handles allergies at mealtimes?`,
    },
    {
      who: ELEANOR, to: [ME], at: '2026-09-07T15:05:00Z', sig: 'full', quote: true,
      body: `Dear Alex,

Thank you for letting me know, and for paying so promptly. Kingswood's kitchen is nut-free for school groups, so Maya will be fine at mealtimes, and the staff there are trained to give antihistamine if it is needed. Please put the tablets and the dose on the medical form so our first aider has it in writing.

Separately, her form from last year's day trip says she was vegetarian. The centre needs dietary numbers from us for the kitchen — is that still the case?`,
    },
    {
      who: ELEANOR, to: [ME], at: '2026-09-10T08:40:00Z', sig: 'full', quote: true,
      body: `Dear Alex,

Just chasing gently before the kitchen deadline. Could you let me know by Friday whether Maya still needs the vegetarian option, and whether you have sent back the medical form yet? It needs to be with us by the end of the month.`,
    },
  ],
  task: {
    instruction: 'Tell her Maya is still vegetarian and that the medical form will be with her before the deadline.',
    recipient: ELEANOR,
    forbidden: [CHIDI.name],
    required: [
      { id: 'vegetarian', re: /\bvegetarian\b/i, why: 'the vegetarian answer' },
      { id: 'form', re: /\b(?:medical|consent)?\s*form\b/i, why: 'the medical form' },
      { id: 'deadline', re: /\b30(?:th)?\s+(?:of\s+)?september\b|\bseptember\s+30(?:th)?\b|\bend of (?:the |this )?month\b|\bbefore the deadline\b/i, why: 'that it will arrive by 30 September' },
    ],
  },
};

// ---------- the procurement thread from fixtures.ts ----------

const NORTHWIND: DetailedThread = {
  id: 'northwind',
  subject: 'Northwind Supply — coming off Sage',
  marks: ['Northwind', 'Castleford', 'Wakefield', 'Sage', 'Tomasz'],
  // Rendered from fixtures.ts rather than copied, so a change there is a
  // change here. See `renderThread`.
  messages: [],
  task: {
    instruction: 'Answer the question in the last message.',
    recipient: DANA,
    forbidden: [PRIYA.name, TOMASZ.name],
    required: [
      { id: 'year-end', re: /\b30(?:th)?\s+(?:of\s+)?september\b|\bseptember\s+30(?:th)?\b/i, why: 'the 30 September year end' },
      { id: 'blackout', re: /\b(?:second|2nd)\s+tuesday\b/i, why: 'the second-Tuesday blackout' },
      { id: 'monthly', re: /\b950\b/, why: 'the £950 monthly figure' },
    ],
    superseded: [
      { id: 'approval', re: /\b(?:needs?|awaiting|pending|require[sd]?)\b[^.]{0,40}\b(?:sign[- ]?off|approval|approve)/i, why: 'says the £4,800 still needs approval; Tomasz approved it' },
    ],
  },
};

// ---------- mail nobody answers ----------
//
// HTML only, as marketing mail almost always is, so the text a tool or a
// prompt sees has come through htmlToText. The class names are the ones a
// Quill editor writes, because those are what surfaced in the broken reply.

const NEWSLETTER: DetailedThread = {
  id: 'newsletter',
  subject: 'New Same Day Bookkeeping Launch Event Today — use code QUILLFEATHER for 10%',
  marks: ['QUILLFEATHER', 'Ledgerly', 'launch event', 'early adopters', 'Claim your discount'],
  messages: [{
    who: LEDGERLY, to: [ME], at: '2026-09-10T07:00:00Z',
    html: `<div class="ql-editor"><p>Hello friend,</p><p><strong>New Same Day Bookkeeping</strong> — our launch event is this week only. Use code <b>QUILLFEATHER</b> at checkout for 10% off your entire order, through next Friday noon EST, when every offer expires unless extended due to demand.</p><ul class="ql-syntax"><li>Retail</li><li>Finance</li><li>Insurance</li><li>Healthcare</li><li>Hospitality</li><li>Logistics</li></ul><p>Ledgerly is trusted by early adopters across multiple markets globally, including yours.</p><p><a href="https://news.ledgerly.example/launch?utm_source=mail&amp;utm_campaign=launch">Claim your discount</a></p><p style="font-size:11px;color:#999">Ledgerly Ltd · You are receiving this because you signed up at a trade show. <a href="https://news.ledgerly.example/u/8812">Unsubscribe</a></p></div>`,
  }],
};

const RECEIPT: DetailedThread = {
  id: 'receipt',
  subject: 'Your Brightwater order BW-99120 has shipped',
  marks: ['Brightwater', 'BW-99120', 'espresso', 'Guatemalan'],
  messages: [{
    who: BRIGHTWATER, to: [ME], at: '2026-09-09T16:20:00Z',
    html: `<table class="receipt" width="100%"><tr><td><h1>Your order is on its way</h1><p>Order <b>BW-99120</b> — 2 × Guatemalan espresso beans, 1kg</p><p>Subtotal £34.40 · Delivery £4.00 · <b>Total £38.40</b></p><p>Tracking number: RM 7731 2290 GB. Expected Monday.</p></td></tr></table><p style="font-size:11px">Brightwater Roasters Ltd · <a href="https://brightwater.example/unsub">Unsubscribe</a></p>`,
  }],
};

/** The conversations a reply is asked for, in the order the evaluation runs them. */
export const REPLY_THREADS: DetailedThread[] = [KITCHEN, OUTAGE, OFFER, TRIP, NORTHWIND];
/** Everything in the fixture mailbox, including the mail nobody answers. */
export const MAILBOX: DetailedThread[] = [...REPLY_THREADS, NEWSLETTER, RECEIPT];

/**
 * A thread as a mail client would store it: signatures, quoted replies, and
 * the owner's own messages under whatever name and address `me` has.
 */
export function renderThread(t: DetailedThread, me: Person = ME): FixtureMail[] {
  const swap = (p: Person) => (p.email === ME.email ? { ...p, name: me.name, email: me.email } : p);
  if (t.id === 'northwind') {
    return realisticThread(24).map((m) => {
      const from = swap(m.who);
      const other = m.who.email === ME.email ? DANA : me;
      return { from, to: [other], cc: [], text: m.text, html: textAsHtml(m.text), at: m.at };
    });
  }
  const out: FixtureMail[] = [];
  let prev: { who: Person; rendered: string; date: Date } | null = null;
  for (const m of t.messages) {
    const at = new Date(m.at);
    const from = swap(m.who);
    if (m.html) {
      out.push({ from, to: m.to.map(swap), cc: (m.cc ?? []).map(swap), text: '', html: m.html, at });
      continue;
    }
    const sig = !m.sig || m.sig === 'none' ? '' : signature(from, { footer: m.sig === 'footer', short: m.sig === 'short' });
    const own = [String(m.body ?? '').trim(), sig].filter(Boolean).join('\n\n');
    const text = m.quote && prev ? `${own}\n\n${quoteOf(prev, 2)}` : own;
    out.push({ from, to: m.to.map(swap), cc: (m.cc ?? []).map(swap), text, html: textAsHtml(text), at });
    prev = { who: from, rendered: own, date: at };
  }
  return out;
}

/** Everything the thread says, as text — what "was it in the conversation?" is judged against. */
export function threadText(t: DetailedThread, me: Person = ME): string {
  return renderThread(t, me).map((m) => m.text || htmlToText(m.html)).join('\n\n');
}

/**
 * The reply that prompted reply.eval.ts, as it was reported: subject line and
 * body verbatim (the recipient's address is left out). The grader's tests use
 * it as the bottom of the scale — whatever else changes, this has to score as
 * the non-email it is.
 */
export const REPORTED_REPLY = {
  subject: 'New Same Day Bookkeeping Launch Event Today Use code BUTTS DALE for 10%',
  body: `Hello? Hi there,</p> We've officially opened our new Same Day Bookkeeping service this week so we're running an exclusive launch event for everyone who signs up today.</br></div><ul class="ql-syntax ql-line末</li>We'd love if your team could join us by using code BUTTS DALE at checkout which gives every customer ten percent instantly on their entire order right now through next Friday noon EST when all offers expire immediately after that deadline passes unless extended later due demand spikes from early adopters across multiple markets globally including yours specifically since last quarter showed strong growth potential in similar sectors like retail finance insurance healthcare technology media entertainment sports education government non profit social impact sustainability climate change energy water food agriculture manufacturing construction transportation logistics hospitality travel tourism gaming gambling betting lotteries raffles sweepstakes contests giveaways prizes awards scholarships grants loans mortgages refinances home equity lines of credit reverse mortgage annuities IRAs Roth IRA traditional SEP SIMPLE Keogh Solo KEOHACHIEC HSA FLEXIBLE SPENDING ACCOUNTS HSAS FS As well as other financial products offered directly via third party providers such banks brokers dealers`,
};

function textAsHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}
