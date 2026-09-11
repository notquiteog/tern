// A reply, scored out of ten.
//
// The other graders in this directory answer "did this case pass" with a list
// of named checks, which is right for a regression suite: a check held or it
// did not. A reply to a real conversation is not like that. One that greets
// the right person, answers two of the three questions and invents nothing is
// a decent draft with a gap; one that is word salad from another thread is not
// a draft at all; and a pass/fail line cannot tell somebody reading the report
// which of the two they are looking at.
//
// So every reply is scored against the same ten points, and reply.eval.ts
// reports X/10 per run, the mean and the worst per case, and which points were
// lost. Deterministic, like every other grader here — no second model marks
// the first one's homework — so a score means the same thing on every run:
//
//   1  delivered   a draft came back, of at least a dozen words
//   1  addressed   the first line greets the recipient, and nobody else is greeted
//   1  clean       no placeholder, merge field, prompt text, reasoning or markdown
//   2  coherent    no markup or stray script (1); no run-on, loop or cut-off (1)
//   2  on-thread   nothing from any other conversation in the mailbox, and filed
//                  against the conversation it was asked for
//   2  answers     the facts the reply had to state, pro rata
//   1  faithful    no figure, date or term it was never given, and no position
//                  the thread moved away from
//
// "coherent" and "on-thread" are also reported as critical. They are the two
// failures the bug report that prompted this was made of, and a run with
// either is a failed run whatever else it scored.
import { describeHits, findGarbledText, findGreetingProblems, findInventedSpecifics, findTemplateArtifacts } from './guard.js';
import { firstNameOf } from './names.js';
import type { ReplyTask } from './replyFixtures.js';

export interface GradeInput {
  /** The finished draft, after the product's own clean-up; null when none came back. */
  draft: string | null;
  subject?: string;
  task: ReplyTask;
  /** Everything the thread says. What "was it in the conversation?" is judged against. */
  threadText: string;
  /** Words that belong to other conversations in the mailbox. Any that also occur in this thread are ignored. */
  foreignMarks: string[];
  /** Anything else the reply was legitimately given — the person's own instruction. */
  extraFacts?: string;
  /** The conversation the draft was filed against, when that is not the one it was asked for. */
  wrongThread?: string | null;
}

export interface Criterion { id: string; points: number; max: number; why?: string }
export interface Grade { score: number; max: number; criteria: Criterion[]; critical: string[] }

const MARKDOWN_RE = /\*\*[^*\n]+\*\*|^#{1,6}\s|^```|__[^_\n]+__/m;
const GREETING_RE = /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening|day))\b[\s,]*(.*)$/iu;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A whole word or phrase, in any script, ignoring case. */
export function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export function gradeReply(g: GradeInput): Grade {
  const draft = (g.draft ?? '').trim();
  const words = draft.split(/\s+/).filter(Boolean).length;
  if (words < 12) {
    // Nothing to judge. Saying so once is clearer than seven reasons that
    // all mean "there was no email".
    const why = draft ? `only ${words} word${words === 1 ? '' : 's'} came back` : 'no draft came back';
    return { score: 0, max: 10, criteria: [{ id: 'delivered', points: 0, max: 10, why }], critical: [why] };
  }

  const criteria: Criterion[] = [];
  const score = (id: string, max: number, why: string | null, partial = 0) => criteria.push(why ? { id, max, points: partial, why } : { id, max, points: max });
  const facts = `${g.threadText}\n${g.extraFacts ?? ''}`;

  score('delivered', 1, null);

  const first = firstNameOf(g.task.recipient.name) || '';
  const line = draft.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const greeting = line.match(GREETING_RE);
  const greetsThem = Boolean(greeting && first && new RegExp(`^${escapeRe(first)}(?!\\p{L})`, 'iu').test(greeting[1]!.trim()));
  const wrong = findGreetingProblems(draft, { first, forbidden: g.task.forbidden });
  score('addressed', 1, !greetsThem ? `opens "${line.slice(0, 50)}" rather than greeting ${first}` : wrong.length ? describeHits(wrong) : null);

  const artifacts = findTemplateArtifacts({ subject: g.subject, text: draft });
  const md = draft.match(MARKDOWN_RE);
  score('clean', 1, artifacts.length ? describeHits(artifacts) : md ? `markdown "${md[0].slice(0, 30)}"` : null);

  const garbled = findGarbledText(draft, { context: facts });
  const notText = garbled.filter((h) => /^markup|script/.test(h.sample));
  const notProse = garbled.filter((h) => !/^markup|script/.test(h.sample));
  score('coherent/text', 1, notText.length ? describeHits(notText) : null);
  score('coherent/prose', 1, notProse.length ? describeHits(notProse) : null);

  const leaked = g.foreignMarks.filter((w) => hasWord(draft, w) && !hasWord(g.threadText, w));
  const offThread = [
    ...(g.wrongThread ? [`filed against another conversation (${g.wrongThread})`] : []),
    ...(leaked.length ? [`words from other conversations: ${leaked.join(', ')}`] : []),
  ];
  score('on-thread', 2, offThread.length ? offThread.join('; ') : null);

  const missing = g.task.required.filter((r) => !r.re.test(draft));
  const share = g.task.required.length ? Math.round(((g.task.required.length - missing.length) / g.task.required.length) * 4) / 2 : 2;
  score('answers', 2, missing.length ? `missing ${missing.map((r) => r.why).join('; ')}` : null, share);

  const invented = findInventedSpecifics(`${g.subject ?? ''}\n${draft}`, { facts });
  const stale = (g.task.superseded ?? []).filter((s) => s.re.test(draft));
  score('faithful', 1, invented.length ? `invented ${describeHits(invented)}` : stale.length ? `superseded: ${stale.map((s) => s.why).join('; ')}` : null);

  const critical = [...garbled.map((h) => `garbled: ${h.sample}`), ...offThread];
  return { score: criteria.reduce((n, x) => n + x.points, 0), max: 10, criteria, critical };
}
