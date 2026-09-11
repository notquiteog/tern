// Fixtures for the live evaluations.
//
// These were rewritten because the old ones were not testing what they
// claimed to. The whole 24-message "deep thread" was 2,322 characters — 596
// tokens, 18 words a message — which fits in any context window with room to
// spare. It never truncated, never exercised `threadBudgetChars` or the
// pack-from-both-ends logic, and would have passed on a 0.5b model. Every
// "deep thread" result measured against it was passing for the wrong reason.
//
// A real 24-message B2B thread is 8k-20k tokens, and the reason is not that
// people write more sentences. It is everything a synthetic fixture leaves
// out and a mail client puts in:
//
//   - signature blocks, and sometimes a legal footer nobody reads
//   - the previous message quoted underneath the reply, which is the bulk of
//     a real thread and the main thing that eats a window
//   - social padding: weekends, apologies for slow replies, the warehouse
//   - tangents that go nowhere and are never resolved, so that telling a
//     load-bearing fact from a pleasantry is part of what is being tested
//   - the fact that matters sitting in the third sentence of a paragraph
//     about something else, rather than alone on its own line where any
//     model can retrieve it
//
// The graded facts are deliberately unchanged from the fixture this replaces
// — 30 September year end, the second-Tuesday blackout, £4,800 fixed and
// £950 a month, 1,900 VAT rows, three cost centres, Priya as the day-to-day
// contact, and Tomasz approving late — so the same assertions now run
// against a realistic amount of text.

export interface Person { name: string; email: string; title?: string; company?: string; phone?: string }

export const ALEX: Person = { name: 'Alex Rivera', email: 'alex@brightledger.example', title: 'Founder', company: 'Brightledger', phone: '+44 7700 900118' };
export const DANA: Person = { name: 'Dana Osei', email: 'dana@northwind.example', title: 'Head of Finance', company: 'Northwind Supply', phone: '+44 113 496 0142' };
export const PRIYA: Person = { name: 'Priya Raman', email: 'priya@northwind.example', title: 'Financial Controller', company: 'Northwind Supply', phone: '+44 113 496 0188' };
// Named repeatedly, quoted below the fold, and never once a participant.
// A responder that greets him has failed in the way that matters most.
export const TOMASZ: Person = { name: 'Tomasz Nowak', email: 'tomasz@northwind.example', title: 'Managing Director', company: 'Northwind Supply' };

export function signature(p: Person, opts: { footer?: boolean; short?: boolean } = {}): string {
  if (opts.short) return `${p.name.split(' ')[0]}`;
  const lines = [p.name.split(' ')[0], '', p.name];
  if (p.title && p.company) lines.push(`${p.title}, ${p.company}`);
  if (p.phone) lines.push(p.phone);
  lines.push(p.email);
  if (opts.footer) {
    lines.push(
      '',
      'This email and any attachments are confidential and intended solely for the',
      'addressee. If you have received it in error please notify the sender and delete',
      `it from your system. ${p.company} Ltd is registered in England and Wales.`,
    );
  }
  return lines.join('\n');
}

interface Draft {
  who: Person;
  body: string;
  /** Sign-off style. A person who is on their phone does not send a signature block. */
  sig?: 'full' | 'footer' | 'short' | 'none';
  /** Real replies quote what they are answering. A few deliberately do not. */
  quote?: boolean;
}

// The conversation. One paragraph or two per message, three to six sentences,
// in the English people actually use in a procurement thread.
//
// Where a graded fact appears it is inside a paragraph about something else,
// never alone on a line: a figure on its own line is trivially retrievable
// and proves nothing.
const DRAFTS: Draft[] = [
  {
    who: DANA,
    quote: false,
    sig: 'full',
    body: `Hi Alex,

We met briefly at the Leeds finance meetup last month — you were on the panel about closing the books without a finance team, and I cornered you by the coffee afterwards to complain about Sage. I run finance at Northwind Supply: we are 42 people across three warehouses, mostly wholesale into independent retailers, and our books have been a mess since we came off Sage in March. My predecessor left in the middle of the migration and I inherited a chart of accounts that nobody can explain to me.

I am not really sure what I am asking for yet, which is part of the problem. Is untangling something like this the sort of work Brightledger takes on, or are we too small and too far into the hole?`,
  },
  {
    who: ALEX,
    sig: 'full',
    body: `Hi Dana,

Good to hear from you, and I remember the conversation — you were not the only person at that meetup with a Sage story, for what it is worth. Coming off Sage mid-year is the single most common thing we get called in for, so you are neither too small nor too far gone. The shape of it is usually a two week clean-up to get the ledger honest again, and then a monthly close that we run with you until you would rather run it yourselves.

The clean-up is the part that needs your people more than mine: I can reconcile anything I can see, but somebody at your end has to tell me which of two accounts a cost was supposed to land in. Before I put any numbers on it, could you tell me roughly how far the migration got before your predecessor left?`,
  },
  {
    who: DANA,
    sig: 'full',
    body: `Hi Alex,

Far enough to be dangerous, not far enough to be useful — the balances came over, the transaction detail mostly did not, and a lot of it landed in a suspense account that now has about eleven thousand pounds in it that I cannot account for. I will get you read-only access to the new system this week so you can see it rather than take my word for it.

Two constraints before we go any further, because they have killed two other projects here and I would rather say them now than in week three. Our fiscal year ends 30 September, which is earlier than most people assume and means the clean-up has to be finished and reconciled before then or we are carrying the mess into the audit. The other is that our board meets on the second Tuesday of every month and the whole finance team is consumed by the pack for the week around it, so nothing can be in flight during that week — not a data load, not a cutover, not a "quick question", nothing. Both of those are immovable, I am afraid.`,
  },
  {
    who: ALEX,
    sig: 'short',
    quote: true,
    body: `Hi Dana,

Understood on both, and thank you for saying them up front rather than in week three — that is genuinely unusual and it makes this much easier to plan. September year end and the second Tuesday blackout are both fine; I have built plans around tighter than that. I will treat the blackout week as if it does not exist in the calendar rather than trying to schedule light work into it, which never works.

Read-only access whenever it suits you. If the suspense account has eleven thousand pounds in it there is a reasonable chance it is two or three postings that went in with the sign flipped, and that is a nice quick win to open with.`,
  },
  {
    who: DANA,
    sig: 'full',
    body: `Morning Alex,

Hope you had a good weekend — ours was spent at a wholesale trade show in Birmingham which was about as restful as it sounds. Access is set up, I have sent the credentials separately through our password tool rather than by email, and you should be able to see everything except payroll.

One thing on how we work: Priya Raman is our financial controller and she will be your day to day contact from here, not me. She owns the ledger, she knows where every oddity came from, and honestly she is better at this than I am — I get pulled into commercial things and go quiet for days at a time, which is not useful to you. I am copying her in now. Please treat her answer as ours on anything technical; I will stay on the thread for the commercial side and for anything that needs signing.`,
  },
  {
    who: PRIYA,
    sig: 'footer',
    quote: true,
    body: `Hello Alex,

Priya here — Dana has been threatening to introduce us for a fortnight. I have owned the ledger since March, which means I own the mess, and I would like it gone before year end rather more than anyone else here does.

Happy to answer anything technical, and I would rather you asked me twice than guessed once. Fair warning that I am part time on Fridays, so if something is urgent on a Thursday afternoon it is better to catch me before three.`,
  },
  {
    who: ALEX,
    sig: 'short',
    quote: true,
    body: `Hi Priya,

Good to meet you, and noted on Fridays — I will keep anything that needs a same-day answer to Monday through Thursday.

First real question, since it determines the order everything else happens in: are the March to June entries still sitting in Sage, or have they already been exported out? The two cases are quite different jobs. If they are still in Sage I would rather pull them myself with the mapping under my control; if they are already out, I need to see what shape the export came out in before I promise anything about how long it takes.`,
  },
  {
    who: PRIYA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

Already exported, unfortunately, and not by me — my predecessor ran the export the week before leaving and I have no idea what options were chosen. The files themselves are fine, comma separated, one per month, and the totals tie back to the Sage trial balance which was the first thing I checked.

The problem is the VAT codes. They did not come across cleanly: some rows have the code the transaction actually carried, some have a default that was applied to everything the exporter did not recognise, and some are simply blank. I have counted the affected rows twice now because I did not believe the number the first time, and it is about 1,900 of them, spread right across the four months rather than clustered in one. Everything else in the export looks sane, which somehow makes the VAT thing more annoying rather than less.`,
  },
  {
    who: ALEX,
    sig: 'full',
    quote: true,
    body: `Hi Priya,

That is the usual failure and it is more tractable than it looks. A Sage export that hits an unrecognised code silently substitutes a default, which is why you are seeing three populations rather than two — real codes, substituted defaults, and the ones it gave up on entirely.

The approach we use is to remap the codes with a script rather than by hand, driven by the transaction detail rather than by the broken code column, and then reconcile the result against the VAT returns you have actually filed. The filed returns are the thing that makes this safe: if the remapped ledger agrees with what you told HMRC, the remap is right, and if it does not, the difference tells you exactly which population is wrong. Doing 1,900 rows by hand would take a fortnight and introduce its own errors, so we do not.`,
  },
  {
    who: DANA,
    sig: 'short',
    quote: true,
    body: `Alex — jumping in on the commercial side.

How long does the remap actually take on that many rows, and how much of it needs Priya sitting next to it? I am trying to work out what this costs us in her time as much as in yours, because her time is the scarcer of the two at the moment.`,
  },
  {
    who: ALEX,
    sig: 'full',
    quote: true,
    body: `Hi Dana,

Two days of my time to write and run the remap, and then a third day for Priya to spot check it — not to check all 1,900, but to pull a sample across each of the three populations and confirm the logic did what it claims. That third day is not optional, I am afraid: I can prove the ledger is internally consistent but only somebody at Northwind can tell me a posting is actually right.

So three days elapsed, of which one is Priya's, and it does not need to be three consecutive days if her diary is difficult. The spot check can sit a week behind the remap without anything going stale.`,
  },
  {
    who: DANA,
    sig: 'short',
    quote: false,
    body: `That is more reasonable than I feared. What does the whole thing cost — clean-up and then the ongoing close? I need a number I can take to someone, not a range.`,
  },
  {
    who: ALEX,
    sig: 'footer',
    quote: true,
    body: `Hi Dana,

A number rather than a range, then. The clean-up is a fixed £4,800 — fixed rather than day rate deliberately, because the last thing either of us wants is me billing you for the extra days your suspense account turns out to need, and I would rather carry that risk than argue about it in October. That covers the remap, the reconciliation against the filed returns, the suspense account, and rebuilding the chart of accounts into something Priya can explain to an auditor.

After that the monthly close is £950 a month on a rolling three month term, so you can stop with a quarter's notice if you decide you would rather run it in house — and to be honest, with Priya there, I would expect you to want to within the year. There is no setup fee on the monthly and no minimum beyond the rolling three months.`,
  },
  {
    who: DANA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

Thank you, that is clear. The monthly is inside my own budget so I can simply say yes to that part — consider it agreed, subject to the paperwork being unremarkable.

The clean-up is a different matter. Anything over five thousand goes to our MD, Tomasz Nowak, and £4,800 is close enough to the line that he will want to look at it anyway. He is not difficult about this sort of thing but he is slow, and he is away for the back half of next week. So: the monthly is a yes, the £4,800 needs his sign-off, and I will chase him. Please do not plan around the clean-up starting until I come back to you.`,
  },
  {
    who: ALEX,
    sig: 'short',
    quote: true,
    body: `Hi Dana,

No rush at all, and thank you for being straight about where it sits rather than letting me assume. I will hold the clean-up as unconfirmed and plan only the parts that do not depend on it.

If it would help him decide, I am happy to do a twenty minute call with Tomasz — not a pitch, just so he can ask a sceptical question of a person rather than of a proposal document. Entirely up to you whether that is useful or whether it would only add a step.`,
  },
  {
    who: DANA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

I will ask him, though he may well decline — he tends to either sign things or not.

Separately, and this is really a question for the ongoing close rather than the clean-up: do you support multi currency? We buy a fair amount from a supplier in Poland and pay them in euros, maybe fifteen invoices a month, and the way we have been handling it is embarrassing enough that I would rather show you than describe it. There is also a much smaller thing with a Norwegian freight forwarder but that is two invoices a year and I suspect the answer is "just do it by hand", so ignore that unless it is easy. See below for the euro one, I have pasted a typical invoice at the bottom.`,
  },
  {
    who: ALEX,
    sig: 'full',
    quote: true,
    body: `Hi Dana,

Yes, and the euro case is well trodden. Purchases in euros are posted at the rate on the invoice date and then revalued monthly at the ECB reference rate, with the difference going to an exchange gain or loss account so it does not quietly distort your gross margin. Fifteen invoices a month is nothing; the work is in setting the revaluation up once, not in running it.

You are right about the Norwegian forwarder — two invoices a year is not worth automating, and I would post those manually and move on. I will not build anything for it.`,
  },
  {
    who: PRIYA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

That works for the euro purchases, and revaluing monthly rather than at year end will make my life considerably easier.

One thing I want to flag now rather than discover in the rebuild, because my predecessor got this wrong and it caused a genuine argument with the board. When you rebuild the chart of accounts, the warehouse cost centres have to stay separate — there are three of them, Leeds, Wakefield and the small one at Castleford, and every one of them needs its own cost centre reporting independently. They were merged into a single "Operations" line last year on the grounds that it was tidier, and the result was that we could not answer the board's questions about Castleford for two quarters. Three separate cost centres, please, not a merged one, whatever the tidier option looks like.`,
  },
  {
    who: ALEX,
    sig: 'short',
    quote: true,
    body: `Hi Priya,

Noted, and thank you — three cost centres kept separate, Leeds, Wakefield and Castleford, each reporting on its own. I will build it that way from the start rather than merging and splitting later, which is a much worse job.

That also argues for putting the freight and handling costs at cost centre level rather than in a central pot, otherwise you get separate cost centres that cannot answer the only question anyone asks of them.`,
  },
  {
    who: PRIYA,
    sig: 'none',
    quote: false,
    body: `Agreed. Sending the CSV export over tomorrow morning, it is on my machine at the office.

Sent from my phone`,
  },
  {
    who: DANA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

Some good news and a small piece of scheduling. Tomasz has approved the £4,800 — he read the proposal on the train, asked me one question about whether the fixed fee really was fixed, and signed it, so the clean-up is confirmed and you can plan around it. He declined the call, as predicted, so do not take that personally.

On timing, we would like to start after the board meeting rather than before it, for the blackout reason I gave you at the beginning. I have also asked Priya to get the export to you before then so you are not waiting on us. One thing I should mention: our purchasing manager has muttered about wanting a supplier scorecard out of all this, which is nothing to do with you and I have told him so, but he may well email you directly at some point and I would rather you heard it from me first.`,
  },
  {
    who: ALEX,
    sig: 'full',
    quote: true,
    body: `Hi Dana,

Excellent news, and thank Tomasz for reading it on the train — that is more than most. I will draft a start plan and send it over.

Noted on your purchasing manager. If he does write to me I will be friendly and unhelpful and point him back at you, which I think is what you are asking for. A supplier scorecard is a reasonable thing to want and a terrible thing to bolt onto a ledger clean-up.`,
  },
  {
    who: PRIYA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

CSV is sent — four files, one per month, March through June, and the 1,900 VAT rows we discussed are in there along with the euro supplier ledger you asked about. I have not touched anything, so what you have is exactly what came out of Sage.

I have also forwarded you the note from our old bookkeeper about the export, which arrived while I was writing this and explains at least part of how we got here:

---------- Forwarded message ----------
From: Michael Osborne <m.osborne@northwind.example>
Date: Fri, 19 Jun 2026
Subject: Re: Sage export options

I ran the export with the standard settings and did not change the VAT
handling, since the guidance note said the defaults were correct for a
standard UK scheme. If some codes did not come across I would guess it is
the reduced rate ones on the freight lines, those were always set up oddly.

Michael`,
  },
  {
    who: DANA,
    sig: 'full',
    quote: true,
    body: `Hi Alex,

Before you send the start plan out — could you put the two constraints we gave you right at the very beginning of this conversation into one message, along with the monthly figure? Not because I have forgotten them, but because I need to forward one clean message to Tomasz and I would rather it came from you than be reconstructed by me from a thread this long.

So: the two dates, and what the ongoing monthly comes to. Nothing else, and please do not attach the proposal again, he has it.`,
  },
];

// ---------- the traffic a real thread accumulates ----------
//
// A depth sweep needs more messages than the spine has, and padding it with
// copies would measure compression rather than recall. These are the messages
// a real procurement thread fills up with between the decisions: scheduling,
// invoices, an out-of-office, a question that answers itself, a supplier
// nobody follows up on. Not one of them touches a graded fact, which is the
// point — telling a load-bearing sentence from a pleasantry is the thing being
// tested, and at depth 50 most of what the model can see is this.
const FILLER: Draft[] = [
  { who: PRIYA, sig: 'short', body: `Hi Alex,\n\nQuick administrative one: our finance system will be read-only on Thursday morning while IT patch the server. Nothing to do at your end, I just did not want you to try a load and think something had broken.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Priya,\n\nNoted, thank you. I will keep Thursday morning clear of anything that touches the ledger and pick it up in the afternoon.` },
  { who: DANA, sig: 'full', body: `Hi Alex,\n\nOur purchasing manager has been asking again about a supplier scorecard. I have told him twice that it is not part of this and he keeps finding new ways to describe it as though it were. Ignore him if he writes; I am not asking you to build it.\n\nSeparately, do you have a preference for how we get you documents — the shared drive or attachments? No strong feeling either way here.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Dana,\n\nThe shared drive, if it is all the same to you. Attachments have a way of becoming the authoritative copy of something and then diverging from the real one.\n\nAnd understood about the scorecard. I will be friendly and unhelpful.` },
  { who: PRIYA, sig: 'footer', body: `Hi Alex,\n\nOne of the euro invoices from the Poland supplier has come through with a different VAT number on it than the previous ones. I suspect they have re-registered rather than anything sinister, but I have parked it rather than posting it. Will chase them and let you know.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Priya,\n\nParking it is right. A changed VAT number mid-year is usually a re-registration or a group restructure, and posting it under the old one is much harder to unpick later than waiting a week.` },
  { who: DANA, sig: 'none', body: `Out of office until Monday — back then, nothing urgent.\n\nSent from my phone` },
  { who: PRIYA, sig: 'full', body: `Hi Alex,\n\nWhile Dana is out: our auditors have asked for a copy of the engagement letter for their file. Could you send one over when you get a moment? No rush, they will not look at it until the autumn.\n\nAlso, entirely unrelated, do you know whether anyone still supports the old Sage report format? Someone here has a spreadsheet that depends on it and I suspect the honest answer is that they should stop.` },
  { who: ALEX, sig: 'full', quote: true, body: `Hi Priya,\n\nEngagement letter is on its way over to the shared drive this afternoon.\n\nOn the old report format — the honest answer is that they should stop. It is technically still produced but nothing validates it any more, so a spreadsheet built on it will break silently rather than loudly, which is the worst way for a spreadsheet to break.` },
  { who: PRIYA, sig: 'short', quote: true, body: `Hi Alex,\n\nThat is roughly what I told them, but it lands better coming from someone external. Thank you.` },
  { who: DANA, sig: 'full', body: `Morning Alex,\n\nBack, and catching up. Nothing has fallen over while I was away as far as I can tell, which is either a good sign or evidence that I am not needed.\n\nOne small thing: we are moving office in the spring, only across town, but it will mean a new registered address on everything at some point. Not your problem yet and possibly never, just flagging it so it is not a surprise.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Dana,\n\nWelcome back. A new registered address is a twenty minute job when it happens, so genuinely not a problem — but thank you for flagging it early rather than the week it changes.` },
  { who: PRIYA, sig: 'full', body: `Hi Alex,\n\nThe Poland supplier came back: it was a re-registration, as you thought. New number is on the invoice and they have confirmed the old one is dead. I will post the parked one under the new number unless you would rather look at it first.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Priya,\n\nGo ahead and post it. That is exactly the outcome that needed confirming rather than assuming.` },
  { who: DANA, sig: 'full', body: `Hi Alex,\n\nSomething I keep meaning to ask and keep forgetting: is there any value in us doing management accounts monthly rather than quarterly, or is that a solution looking for a problem at our size? Genuinely open question, no agenda.` },
  { who: ALEX, sig: 'full', quote: true, body: `Hi Dana,\n\nAt 42 people, with three sites and a real inventory position, monthly is usually worth it — not because the numbers change that fast but because a quarter is long enough for a bad month to hide inside a decent one. The cost is a day of Priya's time a month, so it is a real trade rather than a free improvement.\n\nI would not change anything until the clean-up is done, though. Reporting more often on a ledger you do not trust yet just gives you more opportunities to be misled.` },
  { who: DANA, sig: 'short', quote: true, body: `Hi Alex,\n\nThat is a sensible answer and I will park it until afterwards. Thank you for not simply saying yes.` },
  { who: PRIYA, sig: 'full', body: `Hi Alex,\n\nOur bank has changed its statement export again — same data, different column order, because of course it has. I have updated the import mapping at our end. Mentioning it only in case you have a mapping of your own that will need the same treatment.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Priya,\n\nI do, and it will. Thank you — that would have surfaced as a very confusing reconciliation failure in about a fortnight.` },
  { who: DANA, sig: 'full', body: `Hi Alex,\n\nA colleague asked me who we were using and I mentioned you. She runs a smaller wholesale business out of Sheffield, maybe fifteen people. I have not given her your address, I would rather ask first — happy to pass it on or not, entirely up to you.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Dana,\n\nPlease do pass it on, and thank you. That is much appreciated.` },
  { who: PRIYA, sig: 'footer', body: `Hi Alex,\n\nThe IT patching I mentioned has been moved to the following week, so Thursday is fine after all. Sorry for the noise.\n\nWhile I have you: is there a sensible retention period for the raw export files once everything is reconciled, or do we keep them indefinitely? I have no idea what the right answer is here.` },
  { who: ALEX, sig: 'full', quote: true, body: `Hi Priya,\n\nNo noise at all, better to know.\n\nOn retention — keep the raw exports until the year they cover has been audited and signed off, then they are just copies of data that exists in a better form elsewhere. Indefinitely is the default only because nobody ever decides otherwise.` },
  { who: DANA, sig: 'short', body: `Hi Alex,\n\nOur board pack template is being redesigned by someone in marketing, which I mention only so that when you see it you know it was not my idea and I could not stop it.` },
  { who: ALEX, sig: 'short', quote: true, body: `Hi Dana,\n\nUnderstood. I will admire the typography and say nothing about the numbers moving.` },
  { who: PRIYA, sig: 'full', body: `Hi Alex,\n\nLast small thing from me before the weekend: one of the Castleford stock adjustments from May has a note on it that just says "per DM" and nobody knows who DM is or what they decided. I am going to treat it as unexplained rather than invent a reason for it.\n\nHave a good weekend.` },
];

// A quoted block the way a mail client writes one: an attribution line, then
// the message being answered with "> " in front of every line, including one
// level of whatever it was itself quoting.
export function quoteOf(prev: { who: Person; rendered: string; date: Date }, depth = 2): string {
  const body = depth <= 1
    ? prev.rendered.split('\n').filter((l) => !l.startsWith('>')).join('\n')
    : prev.rendered;
  const when = prev.date.toUTCString().replace(/ GMT$/, '');
  return [
    `On ${when}, ${prev.who.name} <${prev.who.email}> wrote:`,
    ...body.split('\n').map((l) => (l ? `> ${l}` : '>')),
  ].join('\n');
}

export interface FixtureMessage { who: Person; from: string; date: string; at: Date; text: string }

// The whole conversation, rendered. `n` keeps the first messages, exactly as
// the fixture it replaces did, so a depth sweep sees the opening terms and
// loses the middle rather than starting late.
export function maxDepth(): number { return DRAFTS.length + FILLER.length; }

// The conversation at a given depth.
//
// Up to the length of the spine this is simply the first `n` messages. Beyond
// it, the filler is spliced in *before the closing question* — so however deep
// the thread gets, it always opens with the terms that were agreed and always
// ends with the message being answered, and what grows is the middle. That is
// the shape the packing logic exists for, and the shape that decides whether
// a fact stated in message 13 of 50 survives.
function draftsAt(n: number): Draft[] {
  if (n <= DRAFTS.length) return DRAFTS.slice(0, n);
  const spine = DRAFTS.slice(0, DRAFTS.length - 1);
  const ask = DRAFTS[DRAFTS.length - 1];
  const wanted = Math.min(n - DRAFTS.length, FILLER.length);
  return [...spine, ...FILLER.slice(0, wanted), ask];
}

export function realisticThread(n = DRAFTS.length): FixtureMessage[] {
  const start = new Date('2026-06-01T09:12:00Z');
  const out: FixtureMessage[] = [];
  const drafts = draftsAt(n);
  let prev: { who: Person; rendered: string; date: Date } | null = null;
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const at = new Date(start.getTime() + i * 86400_000 + (i % 5) * 3600_000);
    const sig = d.sig === 'none' ? '' : signature(d.who, { footer: d.sig === 'footer', short: d.sig === 'short' });
    const own = [d.body.trim(), sig].filter(Boolean).join('\n\n');
    const text = d.quote && prev ? `${own}\n\n${quoteOf(prev, 2)}` : own;
    out.push({ who: d.who, from: `${d.who.name} <${d.who.email}>`, date: at.toDateString(), at, text });
    prev = { who: d.who, rendered: own, date: at };
  }
  return out;
}

// The shape `live.eval.ts` hands to `buildMessages`.
export function threadForPrompt(n?: number): { from: string; date: string; text: string }[] {
  return realisticThread(n).map((m) => ({ from: m.from, date: m.date, text: m.text }));
}

// The shape `responder.eval.ts` seeds into the mail cache.
export function threadForCache(us: Person, n?: number): { from: Person; text: string; at: Date }[] {
  return realisticThread(n).map((m) => ({ from: m.who.email === ALEX.email ? us : m.who, text: m.text, at: m.at }));
}

// ---------- the facts a reply has to keep ----------
//
// Named so a grader and a report can refer to the same thing, and so that
// "which fact did depth 30 lose" has an answer rather than a guess.
export const GRADED_FACTS = {
  yearEnd: { id: 'year-end', at: 2, why: '30 September fiscal year end' },
  blackout: { id: 'blackout', at: 2, why: 'the second-Tuesday board blackout' },
  contact: { id: 'day-to-day', at: 4, why: 'Priya is the day-to-day contact' },
  vatRows: { id: 'vat-rows', at: 7, why: '1,900 affected VAT rows' },
  fixedFee: { id: 'fixed-fee', at: 12, why: 'the £4,800 fixed clean-up fee' },
  monthly: { id: 'monthly', at: 12, why: 'the £950 a month ongoing close' },
  costCentres: { id: 'cost-centres', at: 17, why: 'three separate warehouse cost centres' },
  // Stated at 13 and superseded at 20. Getting this one backwards is a
  // different failure from forgetting it, and is graded separately.
  approval: { id: 'approval', statedAt: 13, supersededAt: 20, why: 'Tomasz approved the £4,800 (he no longer needs to sign it off)' },
} as const;
