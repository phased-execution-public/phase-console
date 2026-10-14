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
import { gateProofOf, proofWords, startAtOf, whenWords } from '../../shared/proof-words.js';
import type { Guide } from '../../shared/guide-grammar.js';
import type { StepVerdict } from './verdict.ts';

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

/** Every word the composer writes for one item. */
export type Composed = {
  /** The act, as a person would say it: "Sign the gh CLI in", never "Your turn — …". */
  title: string;
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

/** The act without the plan's errand ref a 7.0 title carried — "(E-4)", "(E-4, hub #105)" — which the meta says instead. */
export function actTitle(title: string): string {
  return line(title, 240).replace(/\s*\(E-\d+\b[^)]*\)\s*$/, '').trim() || line(title, 240);
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
export function checkWords(facts: { proofType: ProofType; proof?: string; proofWords?: string; hasOptions?: boolean }): string {
  const words = line(facts.proofWords, 300);
  switch (facts.proofType) {
    case 'probe':
      return facts.proof
        ? `The console checks that ${proofWords(facts.proof)}.`
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

/** The last step, by how the item is answered: a choice is sent, a permission granted or denied, an act checked. */
function pressWords(proofType: ProofType, hasOptions: boolean): string {
  if (proofType === 'answer') return hasOptions ? 'Choose one of the options and send your decision.' : 'Give your answer.';
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

function stepsOf(facts: ComposeFacts): { steps: ComposedStep[]; from: StepsFrom; trouble: Composed['trouble'] } {
  const step = facts.step;
  const press = pressWords(facts.proofType, Boolean(step?.options?.length));
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
  // 4. The situation's ASK: the ladder table's steps for an errand, else a
  // projected row's own lines, else its how.
  const row = facts.row;
  if (!step && row?.ask?.steps.length) {
    return { steps: row.ask.steps.map((text) => ({ text: sentence(line(text)) })), from: 'ask', trouble: [] };
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
  const title = step ? actTitle(step.title) : row ? rowTitle(row, scope) : 'Something only you can do';
  const options = optionsOf(facts);
  const approval = approvalOf(row?.approval);
  const check = row?.ask?.check ? sentence(line(row.ask.check, 300)) : checkWords({
    proofType: facts.proofType,
    ...(step?.proof ?? row?.humanStep?.proof ? { proof: step?.proof ?? row?.humanStep?.proof } : {}),
    ...(step?.proofWords ? { proofWords: step.proofWords } : {}),
    hasOptions: options.length > 0,
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
    how = `${when}${open ? `: ${open}` : ''}. ${check} ${pressWords(facts.proofType, Boolean(step.options?.length))}`;
  } else {
    need = line(row?.need) || (reason ? sentence(cap(reason.sentence)) : sentence(title));
    how = line(row?.how) || check;
  }
  return {
    title, meta: metaWords(facts), need: line(need), how: line(how, 900), steps, stepsFrom: from, check, trouble, timing,
    options, approval,
  };
}

/**
 * The item's ways on, in words a person reads: a ledger decision's options
 * answered through its own `answer` verb, a projected row's as the row bound
 * them. At most one is recommended — the first that says so — and none is
 * made the primary by its place.
 */
export function optionsOf(facts: Pick<ComposeFacts, 'step' | 'row'> & Partial<Pick<ComposeFacts, 'slug'>>): TurnOption[] {
  const step = facts.step;
  // A gate-bound item's one way on is the gate's own Approve (turn-by-turn
  // phase 5): an answer or a note would prove it while the gate stays shut.
  const gate = step && facts.slug ? stepGateOf(step) : null;
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
export function composeErrandTitle(errand: { need: string }, slug: string, phase: number | null | undefined, ask?: AskFacts | null): string {
  const scope = phase != null && phase > 0 ? scopeWords(slug, phase) : `the run of ${slug}`;
  const act = ask?.title ? cap(line(ask.title, 240)) : firstClause(errand.need) || 'An answer';
  return `${act} (${scope})`;
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
