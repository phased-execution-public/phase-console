/**
 * The composer (turn-by-turn phase 3, §Architecture 3): ONE module writes
 * every person-facing word of every item of Your turn — the title (the act),
 * the meta in words, the steps by precedence, the check in words, the timing —
 * and the inbox row's title, need and how and the push's title and body are
 * read from it, so the bell, the Runs home, the phone and the page say the
 * same thing. No machine word reaches a person: a proof ref is said in words
 * (`shared/proof-words.js`), a phase is "Phase 3 of demo", the plan's own act
 * is "the plan demo"; the raw record stays one press away under Raw.
 *
 * Where the steps come from — the first that exists:
 *   1. the authored guide (a session's `--guide`, a plan bullet's `guide:`
 *      file), its steps and its "If it goes wrong";
 *   2. the plan's `## Operator errands` row the item's E-ref binds (read into
 *      a guide by `turn/plan-items.ts`, so it arrives as one);
 *   3. the step's own numbered lines (`--step-line`);
 *   4. the situation's ASK — a projected row's own lines, else its how;
 *   5. a minimal guide: what to open, and what proves it, in words.
 *
 * Pure: facts in, words out.
 */

import { KIND_META, redactSecrets, type HumanStepKind } from '../../shared/human-step-model.js';
import {
  CHECKED_BY_LABEL, REASON_META, readinessOf, type ProofType, type StepsFrom, type TurnRecord, type TurnSource, type WhyPerson,
} from '../../shared/turn-model.js';
import { gateProofOf, proofPartsOf, proofWords, startAtOf, whenWords } from '../../shared/proof-words.js';
import { guideDirection, type Guide } from '../../shared/guide-grammar.js';
import type { StepVerdict } from './verdict.ts';
import { answerFileWords, answerLineFor, answerTargetOf } from './answer-target.ts';

/** One step a person follows — the guide grammar's shape, so the page draws every source on one track. */
export type ComposedStep = { text: string; code?: string; expect?: string; warn?: string; link?: { label: string; url: string } };

export type { StepsFrom };

/**
 * An item's clocks (§Architecture 2's `timing`), each an ISO instant or a
 * sentence: when it was assigned, when it starts if not yet, the deadline a
 * plan or session declared, when its window closes (never called a deadline),
 * when the person said it was done, and when the check answered.
 */
export type TurnTiming = {
  assignedAt: string;
  startAt?: string;
  startWhen?: string;
  deadline?: string;
  openUntil?: string;
  submittedAt?: string;
  checkedAt?: string;
};

/**
 * One way on, bound to the verb that takes it (turn-by-turn phase 4,
 * §Architecture 2): the label, what choosing it does, whether it is the
 * recommended one — at most one is — and the press itself. `says` names the
 * body key a note goes in; `flag` the capability the press needs when this
 * console lacks it.
 */
export type TurnOption = {
  id: string;
  label: string;
  consequence?: string;
  recommended?: boolean;
  verb: { method: 'POST' | 'GET' | 'DELETE'; endpoint: string; body?: unknown };
  says?: { field: string; label: string; placeholder?: string };
  flag?: string;
};

/**
 * A yes or a no on something an AI, a plan or a session wants to do
 * (§Architecture 2's `approval`): what it is, who asked, what approving does
 * and what denying leaves — and, for a grant, the scopes it may be given at.
 */
export type ApprovalBlock = {
  what: string;
  askedBy: string;
  ifApproved: string;
  ifDenied: string;
  scopes?: readonly string[];
};

/** A situation's card words from the ladder's ASK table (`runner/ladder.ts` `askFor`). */
export type AskFacts = { title: string; steps: readonly string[]; check: string };

/**
 * The files a run branch holds that its trunk does not, grouped by repository
 * (#377) — the landing errand's folded *Details*: "12 files in aws · 3 in
 * web". `repo` is the repository as a person reads it.
 */
export type LandingFiles = { repo: string; paths: string[] }[];

/** Every word the composer writes for one item. */
export type Composed = {
  /**
   * The act, as a person would say it: "Sign the gh CLI in", never "Your turn
   * — …". Sentence case, at most `TITLE_MAX` characters, never a path list and
   * never the plan's errand ref (#377, `shortTitle`).
   */
  title: string;
  /** The act's whole words when `title` had to be cut — absent when the title says it all (#377). */
  headline?: string;
  /** The plan's errands-table ref the act carries — "E-4" — drawn as a chip, never in the title (#377). */
  errandRef?: string;
  /** Where it belongs and what it costs, in words: "demo · Phase 3 · about 10 min · unblocks Phase 4". */
  meta: string;
  /** Why only the person fits it — the row's need. */
  need: string;
  /** Where and how, in one line — the row's how. */
  how: string;
  steps: ComposedStep[];
  stepsFrom: StepsFrom;
  /** How it is checked, as a sentence. */
  check: string;
  trouble: { symptom: string; fix: string }[];
  timing: TurnTiming;
  /** The ways on, each bound to its verb, at most one recommended — empty when the item offers no choice. */
  options: TurnOption[];
  /** The approval block of an item that is a yes or a no — null on every other. */
  approval: ApprovalBlock | null;
};

/** A ledger step's facts the composer reads (the merged detail of `turn/index.ts`, or the ledger's own). */
export type StepFacts = {
  /** The ledger id — what a decision's options are answered through. */
  id?: string;
  title: string;
  kind?: string;
  state?: string;
  where?: 'host' | 'any';
  lines?: readonly string[];
  guide?: Guide;
  guideFrom?: string;
  openUrl?: string;
  openCommand?: string;
  proof?: string;
  proofWords?: string;
  code?: string;
  options?: readonly { id: string; label: string; consequence?: string; recommended?: boolean }[];
  dueWhen?: string;
  dueAt?: string;
  until?: string;
  deadline?: string;
  declaredAt?: string;
  checkedAt?: string;
  verdict?: StepVerdict;
  effortMin?: number;
  unblocks?: readonly { slug: string; phase: number }[];
  eref?: string;
};

/** A projected row's words the composer reads. */
export type RowFacts = {
  title: string;
  need: string;
  how: string;
  since?: string;
  expiresAt?: string;
  openUntil?: string;
  humanStep?: { title?: string; lines?: readonly string[]; openUrl?: string; openCommand?: string; proof?: string; dueWhen?: string } | undefined;
  supervisor?: { card: string; situation: string; verb: string | null; why: string; command?: string } | undefined;
  /** The situation's ASK words, on an errand row (turn-by-turn phase 4). */
  ask?: AskFacts | undefined;
  /** What the parked phase asked a person for, in its session's words — an errand's first step. */
  asked?: string | undefined;
  /** The ways on the row offers, bound. */
  options?: readonly TurnOption[] | undefined;
  /** The row's approval block. */
  approval?: ApprovalBlock | undefined;
};

/** What the composer is handed for one item. */
export type ComposeFacts = {
  source: TurnSource;
  record: TurnRecord;
  kind: HumanStepKind;
  proofType: ProofType;
  why?: WhyPerson | string;
  slug?: string;
  phase?: number | null;
  /** A ledger item's record. */
  step?: StepFacts;
  /** A projected item's row. */
  row?: RowFacts;
  /**
   * The ledger step an errand row names when no open item stands behind it
   * (2026-10-20): its title, its guide and its options are the card's, each
   * option answered through the errand's own verb with the choice.
   */
  named?: StepFacts;
  /** When the first read showed a projected item (`turn/first-seen.ts`). */
  firstSeen?: string | null;
  now: number;
};

/** The words a person never reads (exit criterion 1): a ref's scheme, an HTTP route, phase 0, the old frames. */
export const MACHINE_WORDS = /\bcmd:|POST \/api|\bphase 0\b|\(the plan's own\)|— needs you/i;

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

/** A sentence with its first letter raised. */
function cap(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** One line of words, control characters folded, secrets redacted. */
function line(text: string | undefined | null, max = 600): string {
  return redactSecrets(String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);
}

/** A sentence ending in one full stop. */
function sentence(text: string): string {
  const t = text.trim();
  return !t ? t : /[.!?]$/.test(t) ? t : `${t}.`;
}

/** A plan's errands-table ref at the end of an act — "(E-4)", "(E-4, hub #105)" — its id captured. */
const ERRAND_REF = /\s*\((E-\d+)\b[^)]*\)\s*$/;

/** The act without the plan's errand ref a 7.0 title carried — "(E-4)", "(E-4, hub #105)" — which the meta says instead. */
export function actTitle(title: string): string {
  return line(title, 240).replace(ERRAND_REF, '').trim() || line(title, 240);
}

/** The errand ref an act ends on — "E-4" — or undefined. */
export function errandRefOf(title: string | undefined | null): string | undefined {
  return ERRAND_REF.exec(line(title, 600))?.[1];
}

/** A first word that is a name, not a word — a branch, a path, a slug with digits, a command in backticks. */
export const IDENTIFIER_LEAD = /^[^\s]*[/._@:\d`]/;

/** The longest title a card, a row or a push leads with (#377). */
export const TITLE_MAX = 80;

/**
 * Two or more paths in a row — "contracts/api/app.ts, docs/a.md" — the list a
 * title never carries (#377): it moves to the item's details.
 */
export const PATH_LIST = /(?:[\w.@~-]+\/)+[\w.@~-]+(?:\s*,\s*(?:[\w.@~-]+\/)*[\w.@~-]+\.[\w-]+)+/;

/**
 * Cut words to at most `limit` characters at a boundary: the last clause
 * break (" — ", "; ", ": ", ", ") past four tenths of the limit, else the last
 * space — never mid-word unless one word is longer than the limit.
 */
function atBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit + 1);
  const clause = Math.max(head.lastIndexOf(' — '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(', '));
  if (clause >= limit * 0.4) return text.slice(0, clause);
  const space = head.lastIndexOf(' ');
  return space > 0 ? text.slice(0, space) : text.slice(0, limit);
}

/**
 * The title rule (#377): the act in sentence case — its first letter raised,
 * unless it leads with a name (`IDENTIFIER_LEAD`) —
 * at most `max` characters, its errand ref taken out (`errandRef`), and never
 * a path list. Longer words are cut before a path list, then at a word
 * boundary, and end on an ellipsis; the whole words are then `headline`.
 * Pure: the composer, the inbox and the errand titles all say it this way.
 */
export function shortTitle(text: string, max: number = TITLE_MAX): { title: string; headline?: string; errandRef?: string } {
  const full = line(text, 600);
  const ref = ERRAND_REF.exec(full);
  const words = (ref ? full.slice(0, ref.index) : full).trim() || full;
  // Sentence case raises a word, never a name: a title that leads with a
  // branch, a path, a slug or a command ("pe/alpha × pe/beta …") says it as written.
  const said = IDENTIFIER_LEAD.test(words) ? words : cap(words);
  const errandRef = ref?.[1];
  let cut = said;
  const list = PATH_LIST.exec(cut);
  if (list && list.index > 0) cut = cut.slice(0, list.index);
  cut = atBoundary(cut.replace(/[\s,;:—–-]+$/, ''), max - 1).replace(/[\s,;:—–(-]+$/, '');
  // A code span the cut opened and never closed is dropped whole.
  if ((cut.match(/`/g) ?? []).length % 2) cut = cut.slice(0, cut.lastIndexOf('`')).replace(/[\s,;:—–(-]+$/, '');
  if (!cut) cut = said.slice(0, max - 1);
  if (cut === said) return { title: said, ...(errandRef ? { errandRef } : {}) };
  return { title: `${cut}…`, headline: said, ...(errandRef ? { errandRef } : {}) };
}

/**
 * Where an item belongs, in words: "Phase 3 of demo", or the plan's own act
 * — phase 0, an act under its `## Operator errands` — "the plan demo".
 */
export function scopeWords(slug: string | undefined, phase: number | null | undefined): string {
  if (!slug) return 'this console';
  return phase != null && phase > 0 ? `Phase ${phase} of ${slug}` : `the plan ${slug}`;
}

/** The meta line: the plan, the phase or the plan's own errand, the effort, what it unblocks. */
export function metaWords(facts: Pick<ComposeFacts, 'slug' | 'phase' | 'step'>): string {
  const parts: string[] = [];
  if (facts.slug) parts.push(facts.slug);
  if (facts.phase != null && facts.phase > 0) parts.push(`Phase ${facts.phase}`);
  else if (facts.slug) parts.push(facts.step?.eref ? `the plan's own errand ${facts.step.eref}` : "the plan's own errand");
  const effort = facts.step?.effortMin;
  if (typeof effort === 'number' && effort > 0) parts.push(effort >= 90 ? `about ${Math.round(effort / 60)} h` : `about ${effort} min`);
  const unblocks = facts.step?.unblocks ?? [];
  if (unblocks.length) {
    const said = unblocks.slice(0, 4).map((u) => (u.slug && u.slug !== facts.slug ? `Phase ${u.phase} of ${u.slug}` : `Phase ${u.phase}`));
    parts.push(`unblocks ${said.join(', ')}${unblocks.length > 4 ? ` and ${unblocks.length - 4} more` : ''}`);
  }
  return parts.join(' · ');
}

/**
 * How the item is checked, as a sentence — the proof said in words, never as
 * its ref. The label map is `CHECKED_BY_LABEL`'s; this is the sentence under it.
 */
export function checkWords(facts: {
  proofType: ProofType; proof?: string; proofWords?: string; hasOptions?: boolean;
  /** Where the press writes the answer its proof reads (`answeringOf`). */
  answering?: Answering | null;
}): string {
  const words = line(facts.proofWords, 300);
  switch (facts.proofType) {
    case 'probe':
      if (facts.answering) {
        const file = answerFileWords(facts.answering.file);
        return facts.answering.key
          ? `Your choice is written to ${file} as \`${facts.answering.key}: <your choice>\`, and the console checks the file holds it.`
          : `Your answer is written to ${file}, and the console checks the file is there.`;
      }
      // A proof no scheme reads is told by its label and words, never as
      // "the check the session named" (#368): that is the console's phrase
      // for a ref it cannot read, not a check a person can follow.
      return facts.proof && proofPartsOf(facts.proof)
        ? `The console checks that ${proofWords(facts.proof)}${facts.hasOptions ? ' once you send your decision' : ''}.`
        : `${CHECKED_BY_LABEL.probe}${words ? `: ${words}` : ''}.`;
    case 'judgement':
      return `${CHECKED_BY_LABEL.judgement}${words ? ` against this: ${words}` : ''}.`;
    case 'answer':
      return facts.hasOptions ? 'The option you choose is the result.' : `${CHECKED_BY_LABEL.answer}.`;
    case 'grant':
      return 'Your grant, or your denial, settles it.';
    case 'attest':
    default:
      return `${CHECKED_BY_LABEL.attest} is the check: when you say it is done, it is done.`;
  }
}

/** Where the act happens, in words. */
function whereWords(where: string | undefined): string {
  return where === 'host' ? 'At the machine this console runs on' : 'From any device';
}

/** A device code step, a link step, a command step — what the minimal guide opens. */
function openSteps(step: Pick<StepFacts, 'openUrl' | 'openCommand' | 'code' | 'title'>): ComposedStep[] {
  const out: ComposedStep[] = [];
  if (step.openUrl) out.push({ text: 'Open the page.', link: { label: step.openUrl, url: step.openUrl } });
  if (step.openCommand) out.push({ text: 'Run this command.', code: step.openCommand });
  if (step.code) out.push({ text: `Enter the code ${step.code} where it asks for one.` });
  return out;
}

/** The step every guide ends on when nothing else says what proves it. */
const PRESS_CHECK = "When it is done, press I've done this — check.";

/**
 * The last step, by how the item is answered: a gate-bound item by its gate's
 * Approve (#371), a choice sent (#368 — whatever proves it, a decision with
 * options is answered by *Send my decision*, which runs its check), a
 * permission granted or denied, an act checked. Never a button the card does
 * not show.
 */
function pressWords(proofType: ProofType, hasOptions: boolean, gatePhase?: number | null): string {
  if (gatePhase != null) return `Approve the gate on Phase ${gatePhase} — the item closes when the gate opens.`;
  if (hasOptions) return 'Choose one of the options and send your decision.';
  if (proofType === 'answer') return 'Give your answer.';
  if (proofType === 'grant') return 'Grant it at the scope you choose, or deny it.';
  return PRESS_CHECK;
}

/* ------------------------------------------------------------------ *
 * The title
 * ------------------------------------------------------------------ */

/** The first clause of a sentence — up to its dash or its full stop — as a title. */
function firstClause(text: string): string {
  const t = line(text, 240);
  const cut = t.search(/ — |\.\s|\.$|: /);
  return cap((cut > 0 ? t.slice(0, cut) : t).trim());
}

/**
 * What a person does for an escalation the supervisor would not settle itself
 * (turn-by-turn phase 4) — the act, in words, where the remedy's own sentence
 * leads with why rather than what. Any other situation says its remedy's first
 * clause.
 */
const ESCALATION_ACTS: Readonly<Record<string, (facts: { account?: string | null; phase?: number | null }) => string>> = Object.freeze({
  'stale-credential': (facts) => `Sign ${facts.account ? `the account ${facts.account}` : 'the account'} in again`,
  'hot-account': () => 'Give the run an account with room, or wait for the reset',
  'checkout-refused': (facts) => (facts.phase ? 'Prepare an errand tree for the phase' : 'Give the run a checkout of its own'),
  'streak-near-max': () => 'Clear the failure streak once its blocks are answered',
  'turn-returned': () => 'Decide what to do with an item that came back three times',
});

/** A remedy's act: its first clause, cut at a semicolon too. */
function remedyAct(remedy: string): string {
  return firstClause(line(remedy, 240).split(';')[0] ?? remedy);
}

/** What an in-app press of a supervisor's escalation is labelled — what the button says, by verb. */
const PRESS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  isolate: 'Give the run its own checkout',
  'isolate-phase': 'Give the phase its own checkout',
  'errand-tree': 'Prepare an errand tree',
});

/** An in-app press's label: the table's words, else the verb's own summary, raised. */
export function pressLabel(verb: string, summary?: string | null): string {
  return PRESS_LABELS[verb] ?? (summary ? cap(line(summary, 120)) : cap(verb.replace(/-/g, ' ')));
}

/**
 * An escalation's act in words — never `Supervisor: <situation> on …`: the
 * table's act for the situation, else the remedy's first clause, else why.
 */
export function escalationAct(situation: string, facts: { account?: string | null; phase?: number | null; remedy?: string | null; why?: string }): string {
  const act = ESCALATION_ACTS[situation];
  if (act) return act(facts);
  if (facts.remedy) return remedyAct(facts.remedy);
  return firstClause(facts.why || 'The supervisor needs a person here');
}

/**
 * A supervisor card's title — the act in words: what the supervisor would do
 * (its remedy, from the card's situation) or what a person must do for an
 * escalation, and where. `remedy` is the words the caller read from the
 * remedy table.
 */
export function supervisorTitle(card: NonNullable<RowFacts['supervisor']>, scope: string, remedy?: string | null): string {
  if (card.card === 'suggestion' && remedy) return `${remedyAct(remedy)} — ${scope}`;
  return `${escalationAct(card.situation, { remedy: remedy ?? null, why: card.why })} — ${scope}`;
}

/** The act a projected row asks for: the family view's title, else the row's own words — never its frame. */
function rowTitle(row: RowFacts, scope: string): string {
  if (row.ask?.title) return cap(line(row.ask.title, 240));
  if (row.humanStep?.title) return actTitle(row.humanStep.title);
  if (row.supervisor) return supervisorTitle(row.supervisor, scope);
  return actTitle(row.title);
}

/* ------------------------------------------------------------------ *
 * The steps — by precedence
 * ------------------------------------------------------------------ */

/** Where a decision's answer is written on the press: its file, and the key its line carries. */
export type Answering = { key: string | null; file: string };

/**
 * A decision with options whose proof reads a line the console WRITES on the
 * press (`answer-target.ts`, 2026-10-20) — every option's line accepted by the
 * proof's own pattern — or null, when a person's hands are still the way.
 */
export function answeringOf(step: Pick<StepFacts, 'options' | 'proof'> | undefined): Answering | null {
  if (!step?.options?.length) return null;
  const target = answerTargetOf(step.proof);
  if (!target) return null;
  if (!step.options.every((option) => answerLineFor(target, { option: option.id, label: option.label }) !== null)) return null;
  return { key: target.mode === 'append-line' ? target.key : null, file: target.file };
}

/** A guide's summary without the errands table's "Commands run from" clause, which a decision no longer needs. */
function decidedWhat(summary: string | undefined): string {
  return line(String(summary ?? '').replace(/\s*Commands run from `[^`]*`\.?\s*$/, ''), 400);
}

/**
 * A decision the console answers where its proof reads (2026-10-20): the
 * steps say what is decided, how to choose, and what the press writes — never
 * the `printf` an errands row tells a person to run, which the press does.
 * An authored guide keeps its steps, less any that writes the answer itself.
 */
function decisionSteps(step: StepFacts, answering: Answering): { steps: ComposedStep[]; from: StepsFrom; trouble: Composed['trouble'] } | null {
  const guide = step.guide;
  const trouble = (guide?.trouble ?? []).map((t) => ({ symptom: line(t.symptom), fix: line(t.fix) }));
  const file = answerFileWords(answering.file);
  const name = answering.file.slice(answering.file.lastIndexOf('/') + 1);
  const writes = (code?: string): boolean => Boolean(code && /(>>|\btee\b)/.test(code) && code.includes(name));
  const send = answering.key
    ? `Choose one and press Send my decision. The console writes \`${answering.key}: <your choice>\` to ${file}, then checks it.`
    : `Choose one and press Send my decision. The console writes your answer to ${file}, then checks it.`;
  const expect = [...(guide?.steps ?? [])].reverse().find((s) => s.expect)?.expect;
  if (guide?.steps?.length && step.guideFrom !== 'errands-table') {
    const kept = guide.steps.filter((s) => !writes(s.code));
    if (kept.length === guide.steps.length) return null;
    return {
      steps: [
        ...kept.map((s) => ({
          text: line(s.text), ...(s.code ? { code: s.code } : {}), ...(s.expect ? { expect: line(s.expect) } : {}),
          ...(s.warn ? { warn: line(s.warn) } : {}), ...(s.link ? { link: s.link } : {}),
        })),
        { text: send },
      ],
      from: 'guide', trouble,
    };
  }
  const what = decidedWhat(guide?.summary);
  return {
    steps: [
      ...(what ? [{ text: sentence(`What you decide: ${what}`) }] : []),
      { text: 'Read the options below — what each one does is written under it. Add a note if the AI should know something.' },
      { text: send, ...(expect ? { expect: line(expect) } : {}) },
    ],
    from: step.guideFrom === 'errands-table' ? 'errand' : guide ? 'guide' : 'minimal',
    trouble,
  };
}

function stepsOf(facts: ComposeFacts): { steps: ComposedStep[]; from: StepsFrom; trouble: Composed['trouble'] } {
  const step = facts.step;
  const press = pressWords(facts.proofType, Boolean(step?.options?.length), step && facts.slug ? stepGateOf(step)?.phase : null);
  // 0. A decision the press answers where its proof reads: the console's own steps.
  const answering = answeringOf(step);
  if (step && answering) {
    const decided = decisionSteps(step, answering);
    if (decided) return decided;
  }
  // 1–2. An authored guide, or the errands row read into one.
  if (step?.guide?.steps?.length) {
    return {
      steps: step.guide.steps.map((s) => ({
        text: line(s.text), ...(s.code ? { code: s.code } : {}), ...(s.expect ? { expect: line(s.expect) } : {}),
        ...(s.warn ? { warn: line(s.warn) } : {}), ...(s.link ? { link: s.link } : {}),
      })),
      from: step.guideFrom === 'errands-table' ? 'errand' : 'guide',
      trouble: (step.guide.trouble ?? []).map((t) => ({ symptom: line(t.symptom), fix: line(t.fix) })),
    };
  }
  // 3. The step's own numbered lines, with what it opens.
  if (step?.lines?.length) {
    return {
      steps: [...openSteps(step), ...step.lines.map((text) => ({ text: sentence(line(text)) })), { text: press }],
      from: 'lines', trouble: [],
    };
  }
  // The step an errand names (2026-10-20): the session's own guide, or its
  // lines, are the errand's steps — never "read its handoff".
  const named = !step ? facts.named : undefined;
  if (named?.guide?.steps?.length) return stepsOf({ ...facts, step: named, named: undefined });
  if (named?.lines?.length) {
    return { steps: [...openSteps(named), ...named.lines.map((text) => ({ text: sentence(line(text)) }))], from: 'lines', trouble: [] };
  }
  // 4. The situation's ASK: the ladder table's steps for an errand — after
  // what the phase asked for, in its session's own words — else a projected
  // row's own lines, else its how.
  const row = facts.row;
  if (!step && row?.ask?.steps.length) {
    const asked = row.asked ? [{ text: sentence(`What ${scopeWords(facts.slug, facts.phase)} asked for: ${line(row.asked, 400)}`) }] : [];
    return { steps: [...asked, ...row.ask.steps.map((text) => ({ text: sentence(line(text)) }))], from: 'ask', trouble: [] };
  }
  if (!step && row) {
    const view = row.humanStep;
    const lines = (view?.lines ?? []).map((text) => line(text)).filter(Boolean);
    const opens = openSteps({ title: '', ...(view?.openUrl ? { openUrl: view.openUrl } : {}), ...(view?.openCommand ? { openCommand: view.openCommand } : {}) });
    if (lines.length || opens.length) return { steps: [...opens, ...lines.map((text) => ({ text: sentence(text) }))], from: 'ask', trouble: [] };
    const how = line(row.how);
    if (how) return { steps: [{ text: sentence(how) }], from: 'ask', trouble: [] };
  }
  // 5. A minimal guide: what to open, then what proves it.
  const opens = step ? openSteps(step) : [];
  const title = actTitle(step?.title ?? row?.title ?? '');
  return {
    steps: [...(opens.length ? opens : [{ text: sentence(title || 'Do what the item names') }]), { text: press }],
    from: 'minimal', trouble: [],
  };
}

/* ------------------------------------------------------------------ *
 * The timing
 * ------------------------------------------------------------------ */

function iso(value: string | number | undefined | null): string | undefined {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** An item's clocks — a ledger item's from its record, a projected one's from the first-seen store. */
export function timingOf(facts: ComposeFacts): TurnTiming {
  const step = facts.step;
  const assignedAt = (step ? iso(step.dueAt) ?? iso(step.declaredAt) : undefined)
    ?? iso(facts.firstSeen) ?? iso(facts.row?.since) ?? new Date(facts.now).toISOString();
  const dueWhen = step?.dueWhen ?? facts.row?.humanStep?.dueWhen;
  const notYet = readinessOf({ state: step?.state ?? null, dueWhen: dueWhen ?? null, now: facts.now }) === 'not-yet';
  const startAt = notYet && dueWhen ? startAtOf(dueWhen) : null;
  const openUntil = iso(step?.until) ?? iso(facts.row?.openUntil) ?? iso(facts.row?.expiresAt);
  return {
    assignedAt,
    ...(notYet && dueWhen ? { startWhen: whenWords(dueWhen) } : {}),
    ...(startAt ? { startAt } : {}),
    ...(iso(step?.deadline) ? { deadline: iso(step?.deadline)! } : {}),
    ...(openUntil ? { openUntil } : {}),
    ...(iso(step?.checkedAt) ? { submittedAt: iso(step?.checkedAt)! } : {}),
    ...(iso(step?.verdict?.at) ? { checkedAt: iso(step?.verdict?.at)! } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The item
 * ------------------------------------------------------------------ */

/** Every word of one item. */
export function composeItem(facts: ComposeFacts): Composed {
  const scope = scopeWords(facts.slug, facts.phase);
  const step = facts.step;
  const row = facts.row;
  // The act's whole words, then its title by the one rule (#377): sentence
  // case, at most TITLE_MAX characters, the errand ref a chip of its own. An
  // errand that names a step says that step's act (2026-10-20).
  const named = !step ? facts.named : undefined;
  const act = step ? actTitle(step.title) : named ? actTitle(named.title) : row ? rowTitle(row, scope) : 'Something only you can do';
  const short = shortTitle(act);
  const title = short.title;
  const errandRef = step?.eref ?? errandRefOf(step?.title ?? row?.humanStep?.title ?? row?.title);
  const options = optionsOf(facts);
  const approval = approvalOf(row?.approval);
  const check = named?.options?.length ? checkWords({ proofType: 'answer', hasOptions: true })
    : row?.ask?.check ? sentence(line(row.ask.check, 300)) : checkWords({
    proofType: facts.proofType,
    ...(step?.proof ?? row?.humanStep?.proof ? { proof: step?.proof ?? row?.humanStep?.proof } : {}),
    ...(step?.proofWords ? { proofWords: step.proofWords } : {}),
    hasOptions: options.length > 0,
    answering: answeringOf(step),
  });
  const { steps, from, trouble } = stepsOf(facts);
  const timing = timingOf(facts);
  const reason = REASON_META[facts.why as WhyPerson];
  let need: string;
  let how: string;
  if (step) {
    const open = step.openUrl ? `open ${step.openUrl}` : step.openCommand ? `run \`${step.openCommand}\`` : '';
    const when = timing.startWhen ? `Not yet — it starts ${timing.startWhen}; then, ${whereWords(step.where).toLowerCase()}` : whereWords(step.where);
    need = [
      reason ? sentence(cap(reason.sentence)) : '',
      step.code ? `The code is ${step.code}.` : '',
      facts.phase != null && facts.phase > 0 ? `${scope} waits on it.` : '',
    ].filter(Boolean).join(' ');
    how = `${when}${open ? `: ${open}` : ''}. ${check} ${pressWords(facts.proofType, Boolean(step.options?.length), facts.slug ? stepGateOf(step)?.phase : null)}`;
  } else {
    need = line(row?.need) || (reason ? sentence(cap(reason.sentence)) : sentence(act));
    how = line(row?.how) || check;
  }
  return {
    title, ...(short.headline ? { headline: short.headline } : {}), ...(errandRef ? { errandRef } : {}),
    meta: metaWords(facts), need: line(need), how: line(how, 900), steps, stepsFrom: from, check, trouble, timing,
    options, approval,
  };
}

/**
 * The item's ways on, in words a person reads: a ledger decision's options
 * answered through its own `answer` verb, a projected row's as the row bound
 * them. At most one is recommended — the first that says so — and none is
 * made the primary by its place.
 */
export function optionsOf(
  facts: Pick<ComposeFacts, 'step' | 'row'> & Partial<Pick<ComposeFacts, 'slug' | 'phase' | 'named'>>,
): TurnOption[] {
  const step = facts.step;
  // A gate-bound item's one way on is the gate's own Approve (turn-by-turn
  // phase 5): an answer or a note would prove it while the gate stays shut.
  const gate = step && facts.slug ? stepGateOf(step) : null;
  // The step an errand names, its own options answered through the errand
  // (2026-10-20): the step no longer stands, the phase still waits on it.
  const named = !step && facts.slug && facts.phase != null && facts.phase > 0 && facts.named?.options?.length
    ? { slug: facts.slug, phase: facts.phase, options: facts.named.options }
    : null;
  const raw: TurnOption[] = gate?.phase != null && facts.slug
    ? [gateOption(facts.slug, gate.phase)]
    : step?.options?.length
    ? step.options.map((option) => ({
      id: option.id, label: option.label,
      ...(option.consequence ? { consequence: option.consequence } : {}),
      ...(option.recommended ? { recommended: true } : {}),
      verb: {
        method: 'POST' as const,
        endpoint: `/api/human-steps/${encodeURIComponent(step.id ?? '')}/answer`,
        body: { option: option.id },
      },
      says: { field: 'note', label: 'Note (optional)' },
    }))
    : named
    ? named.options.map((option) => ({
      id: option.id, label: option.label,
      ...(option.consequence ? { consequence: option.consequence } : {}),
      ...(option.recommended ? { recommended: true } : {}),
      verb: {
        method: 'POST' as const,
        endpoint: `/api/run/${encodeURIComponent(named.slug)}/phase/${named.phase}/errand-answered`,
        body: { choice: option.id },
      },
      says: { field: 'note', label: 'Note (optional)' },
    }))
    : [...(facts.row?.options ?? [])];
  let recommended = false;
  return raw.map((option) => {
    const out: TurnOption = {
      id: option.id, label: line(option.label, 120),
      ...(option.consequence ? { consequence: sentence(line(option.consequence, 300)) } : {}),
      verb: option.verb,
      ...(option.says ? { says: option.says } : {}),
      ...(option.flag ? { flag: option.flag } : {}),
    };
    if (option.recommended && !recommended) {
      recommended = true;
      out.recommended = true;
    }
    return out;
  });
}

/**
 * The gate an item waits on (turn-by-turn phase 5): an item whose proof reads
 * a gate's row is done when the gate opens. Its phase is the one the proof
 * names, else the one its title names ("Phase 11's Gate card"), else null —
 * still gate-bound, with no Approve to offer.
 */
export function stepGateOf(step: { proof?: string | undefined; title?: string | undefined }): { phase: number | null } | null {
  const gate = gateProofOf(step.proof);
  if (!gate) return null;
  if (gate.phase != null) return gate;
  const named = /\bphase\s+0*(\d+)/i.exec(step.title ?? '');
  return { phase: named ? Number(named[1]) : null };
}

/** The gate's own Approve, as an item's one option — through the person's door, and the run carries on. */
export function gateOption(slug: string, phase: number): TurnOption {
  return {
    id: 'approve-gate', label: `Approve the gate on Phase ${phase}`,
    consequence: `The gate opens, Phase ${phase} of ${slug} starts and the run carries on.`,
    recommended: true,
    verb: {
      method: 'POST', endpoint: `/api/plans/${encodeURIComponent(slug)}/gate/${phase}`,
      body: { approve: true, continueRun: true },
    },
  };
}

/**
 * A press on a run's own verb names the run it was raised for (turn-by-turn
 * phase 5, §Architecture 4): `expectRunId` rides its body, and the route
 * refuses it with a sentence when the plan's run is another one by then — a
 * card left open never presses the run that came after it. The gate's Approve
 * on an item of a run is bound the same way; a press on anything else is
 * left as it is.
 */
export function boundToRun<T extends { endpoint: string; body?: unknown }>(press: T, draft: { slug?: string | undefined; runId?: string | undefined }): T {
  if (!draft.slug || !draft.runId) return press;
  const slug = encodeURIComponent(draft.slug);
  const runs = press.endpoint.startsWith(`/api/run/${slug}/`) && !press.endpoint.endsWith('/start');
  const gate = press.endpoint.startsWith(`/api/plans/${slug}/gate/`);
  if (!runs && !gate) return press;
  const body = press.body;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) return press;
  return { ...press, body: { ...(body as Record<string, unknown> | undefined), expectRunId: draft.runId } };
}

/** An approval block in words — each part one sentence, never a route. */
export function approvalOf(block: ApprovalBlock | undefined | null): ApprovalBlock | null {
  if (!block) return null;
  return {
    what: line(block.what, 300),
    askedBy: line(block.askedBy, 160),
    ifApproved: sentence(line(block.ifApproved, 300)),
    ifDenied: sentence(line(block.ifDenied, 300)),
    ...(block.scopes?.length ? { scopes: [...block.scopes] } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The row, the errand and the push — the same words, shorter
 * ------------------------------------------------------------------ */

/** A ledger step as the composer reads it, from the fields every caller holds. */
export type LedgerFacts = StepFacts & {
  id?: string;
  kind: string;
  slug: string;
  phase: number;
  why?: string;
  proofType?: string;
};

function ledgerFacts(step: LedgerFacts, now: number): ComposeFacts {
  const kind = step.kind as HumanStepKind;
  return {
    source: 'session', record: 'ledger', kind,
    proofType: (step.proofType as ProofType | undefined) ?? (step.proof ? 'probe' : 'attest'),
    ...(step.why ? { why: step.why } : {}),
    slug: step.slug, phase: Number(step.phase), step, now,
  };
}

/** A human step's inbox row: its title is the act, its need why only the person fits it, its how where and how. */
export function composeStepRow(step: LedgerFacts, now: number = Date.now()): { title: string; need: string; how: string } {
  const composed = composeItem(ledgerFacts(step, now));
  return { title: composed.title, need: composed.need, how: composed.how };
}

/** The errand a step's park writes (`runner-attempt.ts`): the act and why, then where and how. */
export function composeStepErrand(step: LedgerFacts, now: number = Date.now()): { need: string; how: string } {
  const composed = composeItem(ledgerFacts(step, now));
  const label = KIND_META[step.kind as HumanStepKind]?.label ?? 'Your turn';
  const upcoming = composed.timing.startWhen ? ` It starts ${composed.timing.startWhen}.` : '';
  return {
    need: line(`${label}: ${composed.title}.${upcoming}`),
    how: composed.how,
  };
}

/**
 * A ladder errand no item stands behind, as a row title: the act its
 * situation's ASK names (turn-by-turn phase 4), else the first clause of its
 * need, and where.
 */
export function composeErrandTitle(
  errand: { need: string; title?: string; situation?: string },
  slug: string, phase: number | null | undefined, ask?: AskFacts | null,
): string {
  const scope = phase != null && phase > 0 ? scopeWords(slug, phase) : `the run of ${slug}`;
  // A reached spend cap names its account and window (one-pool phase 11): the errand's own
  // title is `composeCapWall`'s, which the card, the push and the Runs home say too.
  const capTitle = errand.situation === 'resource-wall:budget' && errand.title?.startsWith(CAP_TITLE_LEAD) ? errand.title : '';
  const act = capTitle || (ask?.title ? cap(line(ask.title, 240)) : firstClause(errand.need) || 'An answer');
  const said = `${act} (${scope})`;
  // The title rule (#377): an act too long for its scope keeps the scope.
  return said.length <= TITLE_MAX ? said : `${shortTitle(act, TITLE_MAX - scope.length - 3).title} (${scope})`;
}

/** One repository's landing proof, as the runner's `landingProofs` answers it (`runner/landing.ts` `LandingProof`). */
export type LandingProofFacts = {
  mount: string;
  branch: string;
  state: string;
  into: string;
  files: readonly string[];
  detail?: string | undefined;
};

/** "12 files in aws · 3 in web" — how much each repository holds, in words (#377). */
export function landingFilesWords(files: LandingFiles): string {
  return files
    .filter((group) => group.paths.length)
    .map((group, i) => `${group.paths.length}${i === 0 ? ` file${group.paths.length === 1 ? '' : 's'}` : ''} in ${group.repo}`)
    .join(' · ');
}

/**
 * The landing errand's words (#377, control-tower phase 112's `unlanded`
 * park): a short title that names the act — "Land demo on main: 2
 * repositories differ from origin/main", or for one repository "Land demo on
 * main: aws differs from origin/main" — a need that adds the branch and how
 * many files, and the files themselves grouped by repository for the card's
 * folded *Details*. Never a path in the title. `mounted` says whether the
 * run's root is one of several repositories ("the root repository").
 */
export function composeLanding(slug: string, proofs: readonly LandingProofFacts[], opts: { mounted?: boolean } = {}): {
  title: string; need: string; files: LandingFiles;
} {
  const repoOf = (proof: LandingProofFacts): string => (proof.mount ? proof.mount : opts.mounted ? 'the root repository' : 'the repository');
  const first = proofs[0];
  const into = first?.into || 'its trunk';
  const trunk = first?.into.replace(/^origin\//, '') || 'its trunk';
  const branch = first?.branch || `pe/${slug}`;
  const conflicted = proofs.filter((proof) => proof.state === 'conflicted').length;
  const what = proofs.length === 1 && first
    ? first.state === 'conflicted'
      ? `${repoOf(first)} conflicts with ${trunk}`
      : first.state === 'ahead'
        ? `${repoOf(first)} differs from ${into}`
        : `${repoOf(first)} could not be checked against ${into}`
    : `${proofs.length} repositories differ from ${into}${conflicted ? `, ${conflicted} in conflict` : ''}`;
  const title = shortTitle(`Land ${slug} on ${trunk}: ${what}`).title;
  const files: LandingFiles = proofs.map((proof) => ({ repo: repoOf(proof), paths: [...proof.files] }));
  const counted = landingFilesWords(files);
  const unknown = proofs.filter((proof) => proof.state !== 'conflicted' && proof.state !== 'ahead');
  const need = [
    `${title}.`,
    counted ? `The run branch ${branch} differs in ${counted}.` : `The run branch ${branch} holds commits of its own.`,
    ...unknown.map((proof) => `Git did not answer for ${repoOf(proof)}: ${line(proof.detail || 'no reason given', 200)}.`),
  ].join(' ');
  return { title, need, files };
}

/**
 * The identity park's words (turn-by-turn phase 4, §Architecture 3): the run's
 * account now answers another login, and the person chooses — continue on
 * the new one, or move the run to a profile of the one it started on. Both
 * options press `POST /api/run/<slug>/identity`; nothing else is offered, and
 * neither is recommended — whose login pays is the person's call.
 */
export function identityAsk(slug: string, was: string | null | undefined, now: string | null | undefined): {
  ask: AskFacts; options: TurnOption[];
} {
  const old = line(was || 'the login it started on', 120);
  const fresh = line(now || 'the new login', 120);
  const endpoint = `/api/run/${encodeURIComponent(slug)}/identity`;
  return {
    ask: {
      title: `Choose which login the run of ${slug} goes on with`,
      steps: [
        `The run started on ${old}; its account now answers ${fresh}, and nothing resumes on somebody else's login by itself.`,
        `To move it back, register and sign in that profile under Settings ▸ Accounts first, as ${old}.`,
        'Choose one of the two options and send it: either resumes the run.',
      ],
      check: 'The option you choose is the result: the run resumes on that login.',
    },
    options: [
      {
        id: 'continue', label: `Continue on ${fresh}`,
        consequence: `The run goes on, paid by ${fresh} from now on.`,
        verb: { method: 'POST', endpoint, body: { choice: 'continue' } },
      },
      {
        id: 'move', label: `Move the run to ${old}'s profile`,
        consequence: `The run resumes on the profile that signs in as ${old} — register and sign it in under Settings ▸ Accounts first.`,
        verb: { method: 'POST', endpoint, body: { choice: 'move' } },
      },
    ],
  };
}

/** A push's words: a title that names the act, a body that says where, never a command or a ref. */
export function composePush(step: LedgerFacts & { label?: string }, opts: { reminder?: number; now?: number } = {}): {
  title: string; body: string; detail: string;
} {
  const now = opts.now ?? Date.now();
  const composed = composeItem(ledgerFacts(step, now));
  const scope = scopeWords(step.slug, step.phase);
  const place = step.where === 'host' ? ' — at the machine this console runs on' : '';
  const lead = opts.reminder ? 'Still your turn' : step.kind === 'operator-act' ? 'Now' : 'Your turn';
  const title = line(`${lead}: ${composed.title}`, 160);
  const body = line(`${cap(scope)}${place}.${step.code ? ` The code is ${step.code}.` : ''} ${composed.check}${opts.reminder ? ` Reminder ${opts.reminder}.` : ''}`, 400);
  // `detail` is what a webhook and the out-of-band notice carry off the
  // machine: the act and where, never a code.
  const detail = line(`${composed.title} — ${scope}${place}.${opts.reminder ? ` Reminder ${opts.reminder}.` : ''}`, 400);
  return { title, body, detail };
}

/**
 * A halted run's push — the lock screen's title and body. A reached spend cap says the
 * composer's own words (`composeCapWall`, one-pool phase 11), the card's and the bell's.
 */
export function haltedPushWords(
  slug: string,
  halt: { reason?: string } | null | undefined,
): { title: string; body: string } {
  const said = { title: `${slug} halted`, body: halt?.reason ?? 'the run stopped and needs a person' };
  return said;
}

/** How every cap headline opens — what tells a cap errand's own title from any other. */
const CAP_TITLE_LEAD = 'Cap reached on ';


/* ------------------------------------------------------------------ *
 * The packs' words (measured-console phase 29, §Architecture 6 D7): what
 * gstack, a wizard and a session's closing questions ask a person, said in
 * the console's words. `turn/packs.ts` reads the shapes; these write them.
 * ------------------------------------------------------------------ */

/** One question a pack or a session put to a person — its choices, and the answer it recommended. */
export type PackQuestion = { question: string; recommended?: string; choices: { label: string; recommended?: boolean }[] };

/** A step offer for the one door (`raiseTurn` / `deps.humanStep`) — the declaration's own field names. */
export type PackStep = {
  kind: HumanStepKind;
  title: string;
  why: string;
  lines: string[];
  options: { id: string; label: string; consequence?: string }[];
  recommended?: string;
  source: { kind: string; ref?: string };
};

/** At most this many questions ride one Decision item — the ledger keeps twelve lines. */
export const PACK_QUESTIONS_MAX = 8;

const RESUMES = 'Your answer goes back to the same session, which carries on from it.';

/**
 * A session that ended on questions and declared no outcome (the prose-question
 * rule, §Architecture 6 D7): ONE Decision item carrying every question with the
 * answer the session recommended. One question with named choices offers those
 * choices; otherwise the options are the session's recommended answers, taken
 * together, and the person's own, written in the note.
 */
export function proseQuestionStep(questions: readonly PackQuestion[], ref: string): PackStep | null {
  const asked = questions.slice(0, PACK_QUESTIONS_MAX);
  if (!asked.length) return null;
  const one = asked.length === 1 ? asked[0]! : null;
  const title = one ? one.question : `Answer the ${asked.length} questions the session ended on`;
  const lines = [
    ...asked.map((q, i) => line(`${asked.length > 1 ? `${i + 1}. ` : ''}${q.question}${q.recommended ? ` — the session recommends: ${q.recommended}` : ' — the session recommended no answer'}`, 300)),
    RESUMES,
  ];
  if (one && one.choices.length >= 2) {
    const options = one.choices.slice(0, 8).map((choice, i) => ({ id: `c${i + 1}`, label: line(choice.label, 120) }));
    const marked = one.choices.findIndex((choice) => choice.recommended);
    return {
      kind: 'decision', title, why: 'decision', lines, options,
      ...(marked >= 0 ? { recommended: `c${marked + 1}` } : {}),
      source: { kind: 'prose-question', ref },
    };
  }
  const given = asked.filter((q) => q.recommended);
  const options = [
    ...(given.length ? [{
      id: 'recommended',
      label: given.length === asked.length ? 'Go with the recommended answers' : 'Go with the answers it recommended',
      consequence: line(`The session carries on with: ${given.map((q) => q.recommended).join('; ')}`, 300),
    }] : []),
    {
      id: 'my-answers', label: 'Answer them myself',
      consequence: 'Write your answers in the note; the session carries on with them.',
    },
  ];
  return {
    kind: 'decision', title, why: 'decision', lines, options,
    ...(given.length ? { recommended: 'recommended' } : {}),
    source: { kind: 'prose-question', ref },
  };
}

/** A gstack approval a run is stopped on — one pending `decisions.jsonl` row, its option texts from `gate.json`. */
export type GstackApprovalFacts = {
  skill: string;
  id: string;
  label?: string;
  title: string;
  options: readonly { key: string; text: string }[];
  recommended: string | null;
  pendingAfter: number;
};

/**
 * A gstack approval as an Approval item: what is asked, each option in gstack's
 * own words, the recommended one marked — and never approved for the owner;
 * the answer goes back to the session, which relays it as the owner's reply.
 */
export function gstackApprovalStep(facts: GstackApprovalFacts): PackStep {
  const options = facts.options.slice(0, 8).map((option) => ({
    id: option.key.toLowerCase(), label: cap(line(option.text, 120)),
  }));
  const recommended = facts.recommended && options.some((o) => o.id === facts.recommended!.toLowerCase())
    ? facts.recommended.toLowerCase() : undefined;
  return {
    kind: 'person-check',
    title: line(`Approve ${facts.label ? `${facts.label} of ` : ''}the ${facts.skill} run: ${facts.title}`, 300),
    why: 'decision',
    lines: [
      `gstack's ${facts.skill} run stopped at its gate and will not approve this for you.`,
      ...(facts.pendingAfter ? [`${facts.pendingAfter} more ${facts.pendingAfter === 1 ? 'approval waits' : 'approvals wait'} after this one, each asked in turn.`] : []),
      RESUMES,
    ],
    options, ...(recommended ? { recommended } : {}),
    source: { kind: 'pack', ref: `gstack:${facts.id}` },
  };
}

/**
 * A gstack run stopped at `gate_pending` with no approval row to read (no run
 * directory this console can open): a Decision on the gate as a whole —
 * gstack's own default, every recommendation, or the gate read item by item.
 */
export function gstackGateStep(facts: { skill: string; run: string }): PackStep {
  return {
    kind: 'decision',
    title: `Answer the gate the ${facts.skill} run stopped at`,
    why: 'decision',
    lines: [
      `gstack's ${facts.skill} run is waiting at its gate and will not answer it for you.`,
      `Its record is in ${line(facts.run, 200)}.`,
      RESUMES,
    ],
    options: [
      { id: 'rec', label: 'Take every recommendation', consequence: 'The session answers the gate with every recommendation, plan changes included.' },
      { id: 'walk', label: 'Walk me through each item', consequence: 'The session shows the gate item by item and asks again before it answers.' },
    ],
    recommended: 'rec',
    source: { kind: 'pack', ref: `gstack-gate:${line(facts.run, 200)}` },
  };
}

/** One stage of a wizard (mattpocock's `wizard/template.sh`), as `turn/packs.ts` read it. */
export type WizardStage = {
  name: string;
  /** What the stage says and the clicks it names, in order. */
  says: string[];
  opens: string[];
  asks: { key: string; prompt: string; secret: boolean }[];
  writesEnv: string[];
  secrets: string[];
  variables: string[];
  confirms: string[];
};

/** Where a captured secret goes, said as places and the commands that take it hidden — never a field. */
function secretPlace(key: string, stage: WizardStage, envFile: string): { text: string; codes: string[] } {
  const places: string[] = [];
  const codes: string[] = [];
  if (stage.writesEnv.includes(key)) places.push(`${envFile} as ${key}, which the wizard writes from its hidden prompt`);
  if (stage.secrets.includes(key)) {
    places.push(`the repository's GitHub secret ${key}, which \`gh secret set ${key}\` asks for hidden`);
    codes.push(`gh secret set ${key}`);
  }
  if (!places.length) {
    places.push(`the login keychain as ${key}, which \`security add-generic-password\` asks for hidden`);
    codes.push(`security add-generic-password -a "$USER" -s ${key} -w`);
  }
  return { text: `it goes to ${places.join(', and to ')}`, codes };
}

/**
 * A Task guide in the wizard's shape (§Architecture 6 D7): one step per stage,
 * "Stage 2 of 3 · <name>", each with its commands; a secret is entered hidden
 * where it goes — `gh secret set`, the keychain, the env file — and the guide
 * says so, never offering a field: Phase Console never takes the value. The
 * first step runs the wizard itself, which asks for every value hidden.
 */
export function wizardGuide(wizard: { title: string; file: string; envFile: string; stages: readonly WizardStage[] }, lang = 'en'): Guide {
  const total = wizard.stages.length;
  const kept = wizard.stages.slice(0, 19);
  const steps = kept.map((stage, i) => {
    const said = stage.says.map((s) => s.replace(/[.:]?\s*$/, '')).filter(Boolean);
    const secrets = stage.asks.filter((ask) => ask.secret);
    const plain = stage.asks.filter((ask) => !ask.secret);
    const places = secrets.map((ask) => ({ ask, place: secretPlace(ask.key, stage, wizard.envFile) }));
    const commands = [
      ...stage.opens.map((url) => `open ${url}`),
      ...places.flatMap((p) => p.place.codes),
      ...stage.variables.map((name) => `gh variable set ${name}`),
    ];
    const text = [
      `Stage ${i + 1} of ${total} · ${stage.name}`,
      ...said,
      ...plain.map((ask) => `${ask.prompt.replace(/:\s*$/, '')} — it is not secret${stage.writesEnv.includes(ask.key) ? `, and goes to ${wizard.envFile} as ${ask.key}` : ''}`),
      ...places.map((p) => `${p.ask.prompt.replace(/:\s*$/, '')} — a secret: ${p.place.text}`),
    ].join('. ');
    return {
      text: line(sentence(text), 600),
      ...(commands.length ? { code: commands.join('\n') } : {}),
      ...(secrets.length ? { warn: 'Enter the secret only at a hidden prompt — never in Phase Console, a chat or a note.' } : {}),
      ...(stage.confirms.length ? { expect: line(sentence(`Before it goes on, it asks: ${stage.confirms.join('; ')}`), 300) } : {}),
    };
  });
  return {
    lang, dir: guideDirection(lang), version: 1,
    summary: line(`${wizard.title}: ${total} ${total === 1 ? 'stage' : 'stages'} only you can do. The wizard asks for every value at a hidden prompt and writes it where it goes; Phase Console never sees it.`, 400),
    steps: [
      { text: `Run the wizard on your machine — it walks every stage below and shows how many are left.`, code: `bash ${wizard.file}` },
      ...steps,
    ],
    trouble: [
      { symptom: 'A stage needs a value you do not have yet', fix: 'Stop with Ctrl-C; run it again later — it keeps the values already saved.' },
      ...(total > kept.length ? [{ symptom: `The wizard has ${total} stages and this guide shows the first ${kept.length}`, fix: 'The wizard itself walks every stage.' }] : []),
    ],
  };
}
