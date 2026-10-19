/**
 * Your turn's one door and one read (control-tower phase 132, #209,
 * §Architecture 19).
 *
 *   - `raiseTurn` — the door every source of a person's turn passes: the only
 *     caller of `declareHumanStep` (a source scan holds it), so the guard, the
 *     ledger line and the ONE push happen in one place. A source the console
 *     raises names itself (`source: {kind, ref}`), and a second raise of the
 *     same source while its item is open answers that item — the errand
 *     announced again, the preflight run again on a retry, the relay refusing
 *     the same question twice — never a second item and never a second push.
 *   - `turnView` — the projection `GET /api/turn` answers: every inbox row that
 *     asks a person for an act, folded into ONE item per thing to do (an errand
 *     and the step it describes are one item), grouped by `groupOf`, with the
 *     ledger's detail. Pure: the inbox and the ledger's steps in, the answer out.
 *
 * The builders of a raise — `errandTurnInput`, `credentialTurnInput`,
 * `mcpTurnInput`, `questionTurnInput` — live here too, so each source's item is
 * spelled once and a test can read the exact declaration a source makes.
 */

import { isRunRequestOf, runRequestApproval } from './run-requests.ts';
import {
  coverLinks, declareHumanStep, sanitiseStep, type DeclareInput, type HumanStep, type HumanStepLedger, type StepLink, type TurnRefused,
} from '../human-steps.ts';
import { HUMAN_STEP_SETTLED_STATES } from '../../shared/human-step-model.js';
import { TURN_GROUPS, TURN_OPEN_GROUPS, groupOf, type TurnGroup } from '../../shared/turn-model.js';
import { recommendedOption } from '../../shared/relay-model.js';
import { cardWordsOf, ledgerTurn, type CardWords, type TurnView } from './fold.ts';
import type { InboxAction, InboxItem } from '../inbox.ts';
import { requestView, type AuthorityRequest, type AuthorityRequestView } from '../owner/requests.ts';
import type { HandledRow } from './handled.ts';
import type { RoundState } from './round.ts';
import type { HeadsUp, PlanGuideFrom, PlanItemWords } from './plan-items.ts';
import { headlineOf } from './headline.ts';
import {
  approvalOf, boundToRun, composeItem, type ApprovalBlock, type AskFacts, type ComposedStep, type LandingFiles, type StepFacts, type StepsFrom, type TurnOption,
  type TurnTiming,
} from './compose.ts';
import type { SeenEntry } from './first-seen.ts';
import type { SettledOutcome, SettledRecord } from './settled.ts';
import type { StepVerdict } from './verdict.ts';

export { cardWordsOf, errandIsItem, itemOfErrand, ledgerTurn, turnOf, TURN_SOURCES, BELL_KINDS } from './fold.ts';
export type { CardWords, TurnRecord, TurnSource, TurnView } from './fold.ts';
export { headlineOf, holdsWords, waitedWords, type HeadlineFacts } from './headline.ts';

/* ------------------------------------------------------------------ *
 * The door
 * ------------------------------------------------------------------ */

/** What the door writes through: the ledger, and the item's one announcement. */
export type TurnDoor = { ledger: HumanStepLedger; announce: (step: HumanStep) => boolean };

/** The source a console's raise names, if it names one. */
function sourceOf(step: unknown): { kind: string; ref?: string } | null {
  const source = (step as { source?: { kind?: unknown; ref?: unknown } } | null)?.source;
  return source && typeof source.kind === 'string'
    ? { kind: source.kind, ...(typeof source.ref === 'string' ? { ref: source.ref } : {}) }
    : null;
}

/**
 * The one door into Your turn. A session's declaration is guarded, a plan's
 * bullet is asked at the launch door, and a console's raise is ONE item per
 * source: while an item of the same source is open for the same run's phase,
 * the raise answers it and writes and pushes nothing.
 */
export function raiseTurn(door: TurnDoor, input: DeclareInput): HumanStep | TurnRefused | null {
  // The supervisor's raise (control-tower phase 136) names its source the
  // same way: one escalation is one item while it stands.
  const source = input.birth === 'console' || input.birth === 'supervisor' ? sourceOf(input.step) : null;
  if (source) {
    const open = door.ledger.open().find((step) => step.birth === input.birth && step.slug === input.slug
      && step.phase === input.phase && (step.runId ?? '') === (input.runId ?? '')
      && step.source?.kind === source.kind && (step.source?.ref ?? '') === (source.ref ?? ''));
    if (open) {
      if (open.title === sanitiseStep(input.step, input.birth)?.step.title) return open;
      // The same source asked again in other words — a re-declared errand: the
      // older item is superseded, so nobody is left holding a stale ask.
      door.ledger.move(open.id, 'dismissed', { by: 'console', verb: 'dismiss', note: 'superseded — the same source asked again, in other words' });
    }
  }
  return declareHumanStep(door, input);
}

/* ------------------------------------------------------------------ *
 * The sources' items, spelled once
 * ------------------------------------------------------------------ */

/** The reason a person errand's sub-kind gives its item — a credential is a secret, anything else is reserved for a person. */
function errandReason(situation: string): 'secret' | 'decision' | 'reserved' {
  const sub = situation.split(':')[1] ?? '';
  return sub === 'credential' ? 'secret' : sub === 'ambiguity' ? 'decision' : 'reserved';
}

/**
 * A person errand IS an `operator-act` item (§Architecture 19): the session's
 * own words as its title, the errand's how as its line, no proof — its
 * *I've done this — check* is the person's word, as "Done — continue" was.
 */
export function errandTurnInput(at: { slug: string; phase: number; runId: string; sessionId?: string }, errand: {
  situation: string; need: string; how?: string;
}): DeclareInput {
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'operator-act', title: errand.need, why: errandReason(errand.situation),
      ...(errand.how ? { lines: [errand.how] } : {}),
      source: { kind: 'errand', ref: errand.situation },
    },
  };
}

/** The proof a credential's item is given — presence by name, never the value. */
export function credentialProof(id: string): string {
  return `credential:${id}`;
}

/** Where a missing credential's value goes, told in words — the item never takes it. */
function credentialLines(id: string): { lines: string[]; openCommand?: string } {
  const [scheme, rest = ''] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : [id, ''];
  if (id === 'gh') return { lines: ['Sign the gh CLI in on the machine this console runs on.'], openCommand: 'gh auth login' };
  if (scheme === 'claude' || id === 'claude-login') {
    return { lines: ['Sign the machine\'s claude login in on the machine this console runs on.'], openCommand: 'claude auth login' };
  }
  if (scheme === 'keychain') return { lines: [`Store it in the login keychain as the generic password named ${rest} — it is read by name, never shown.`] };
  if (scheme === 'env') return { lines: [`Set $${rest} in the console's environment, then restart the console.`] };
  if (scheme === 'file') return { lines: [`Write it to ${rest} on the machine this console runs on.`] };
  return { lines: [`Make the credential ${id} available to this console.`] };
}

/**
 * A credential the preflight found missing (§Architecture 19, TS-4): a
 * `secret-entry` item whose proof is `credential:<id>` — presence by name — and
 * which never takes the value; the person stores it where the line says.
 */
export function credentialTurnInput(at: { slug: string; phase: number; runId: string }, id: string, reason: string): DeclareInput {
  const { lines, openCommand } = credentialLines(id);
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId,
    step: {
      kind: 'secret-entry', title: `Make the credential ${id} available to this console`, why: 'secret', where: 'host',
      proof: credentialProof(id), lines: [...lines, `The preflight read: ${reason}`],
      ...(openCommand ? { open_command: openCommand } : {}),
      source: { kind: 'preflight', ref: credentialProof(id) },
    },
  };
}

/** An MCP server the preflight found unreachable under `require`: an `mcp-login` item, the person's word its proof. */
export function mcpTurnInput(at: { slug: string; phase: number; runId: string }, server: { id: string; detail?: string }): DeclareInput {
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId,
    step: {
      kind: 'mcp-login', title: `Sign the MCP server ${server.id} in`, where: 'host',
      lines: [
        ...(server.detail ? [`The preflight read: ${server.detail}`] : []),
        'Open Phase Console ▸ MCP, sign it in, and check it reads connected.',
      ],
      source: { kind: 'preflight', ref: `mcp:${server.id}` },
    },
  };
}

/**
 * A relayed question the console will not answer by rule (TS-5): a `decision`
 * item that keeps the question's options, the one marked `(Recommended)`
 * recommended — never a prose errand with its options gone.
 */
export function questionTurnInput(at: { slug: string; phase: number; runId: string; sessionId?: string }, question: {
  key: string; question: string; options: readonly { label: string; description?: string }[];
}, why: string): DeclareInput {
  const options = question.options.slice(0, 8).map((option, i) => ({
    id: `o${i + 1}`, label: option.label, ...(option.description ? { consequence: option.description } : {}),
  }));
  const marked = recommendedOption(question.options);
  const recommended = options.find((option) => option.label === marked)?.id;
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'decision', title: question.question, why: 'decision',
      lines: [`The console will not answer it by rule: ${why}.`],
      options, ...(recommended ? { recommended } : {}),
      source: { kind: 'relay', ref: question.key },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The read
 * ------------------------------------------------------------------ */

/** The ledger's record of a ledger item, as the page reads it — never a value. */
export type TurnStepDetail = Pick<HumanStep, 'id' | 'kind' | 'title' | 'state' | 'why' | 'whySource' | 'proofType' | 'attempts' | 'waiters' | 'declaredAt' | 'birth'>
  & Partial<Pick<HumanStep, 'proof' | 'proofWords' | 'guide' | 'options' | 'allowDecline' | 'effortMin' | 'unblocks' | 'until' | 'source' | 'read' | 'note'
    | 'permission' | 'deadline' | 'verdict' | 'verdicts' | 'notes'>>
  & {
    /*
     * A plan item's words from the CURRENT plan (turn-by-turn phase 2,
     * `turn/plan-items.ts`): the `## Operator errands` ref that binds it,
     * where its guide came from, and the table row's facts phase 3 composes from.
     */
    eref?: string;
    guideFrom?: PlanGuideFrom;
    errand?: PlanItemWords['errand'];
    /*
     * Linked, never merged (turn-by-turn phase 7, `coverLinks`): the session
     * item that covers this plan item, and the plan items a session item covers.
     */
    coveredBy?: StepLink;
    covers?: StepLink[];
  };

/**
 * One thing to do — however many inbox rows stand for it — with the card's
 * four words (turn-by-turn phase 1): its type, the person's status, its
 * readiness and where a press goes.
 */
export type TurnItem = TurnView & CardWords & Words & {
  /** Every inbox row this item stands for: an errand row and its step's row are ONE item. */
  rows: string[];
  /** A pressed projected item's end (turn-by-turn phase 5, `turn/settled.ts`) — Done's Passed or Closed, by whom, when. */
  settled?: { outcome: SettledOutcome; by: string; at: string; what: string };
  /** The act, in the composer's words (turn-by-turn phase 3) — what the bell, the Runs home and push say too. */
  title: string;
  need: string;
  how: string;
  severity: string;
  slug?: string;
  phase?: number;
  runId?: string;
  since: string;
  expiresAt?: string;
  /** A human step's window end (#341) — when the act stops being open. */
  openUntil?: string;
  href: string;
  /** The endpoints that press it: a ledger item's `/api/human-steps/:id/…`, a projected item's own. */
  actions: InboxAction[];
  humanStep?: InboxItem['humanStep'];
  category?: InboxItem['category'];
  /** A supervisor card's own facts (control-tower phase 139): the page draws the card in the item. */
  supervisor?: InboxItem['supervisor'];
  /** A ledger item's record — its reason, proof, options, waiters and attempts. */
  step?: TurnStepDetail;
  /**
   * The presses another door asked the owner for ON this item (control-tower
   * phase 148): "asked by <label> — confirm?", each confirmed or refused by the
   * owner in one press (`/api/owner/requests/:id/…`).
   */
  requests?: AuthorityRequestView[];
  /** A request that is about no item is an item of its own — a `decision` — and this is it. */
  request?: AuthorityRequestView;
  /** The situation's ASK words, on an errand's item (turn-by-turn phase 4) — read by the composer. */
  ask?: AskFacts;
  /**
   * The act's whole words when `title` had to be cut to the title rule (#377,
   * `turn/compose.ts` `shortTitle`): the title is sentence case and at most 80
   * characters; this is what it shortened, which the card shows beneath it.
   */
  headline?: string;
  /** The plan's errands-table ref the act carries — "E-4" — a chip beside the title, never in it (#377). */
  errandRef?: string;
  /** The landing errand's files, grouped by repository — the card's folded *Details* (#377). */
  files?: LandingFiles;
};

/**
 * The card's words (turn-by-turn phase 3, `turn/compose.ts`): the meta in
 * words, the steps by precedence and where they came from, the check in words,
 * what to do if it goes wrong, the clocks, and the check's verdicts — the last
 * one, and every one, oldest first; none on an item no check has answered.
 */
export type Words = {
  meta: string;
  steps: ComposedStep[];
  stepsFrom: StepsFrom;
  check: string;
  trouble: { symptom: string; fix: string }[];
  timing: TurnTiming;
  verdict: StepVerdict | null;
  verdicts: StepVerdict[];
  /**
   * The ways on, each bound to its verb, at most one recommended (turn-by-turn
   * phase 4): a decision's options, a conflict's, a QA verdict's, a relayed
   * question's, a session's ask, an errand's from its situation's ASK.
   */
  options: TurnOption[];
  /** What a yes or a no is about, who asked, and what each answer does — null on an item that is no approval. */
  approval: ApprovalBlock | null;
};

/** `GET /api/turn`. */
export type TurnAnswer = {
  /**
   * When this was read, and the console's own round (control-tower phase 136):
   * `n` rises only when a round changed the turn, `ranAt` is the last round,
   * `changedAt` the last one that changed something.
   */
  round: { at: string; n: number; ranAt: string | null; changedAt: string | null };
  /** One sentence, composed by RULES from the state (`headlineOf`) — never by a model. */
  headline: string;
  groups: Record<TurnGroup, TurnItem[]>;
  /** What the AI handled instead of asking, newest first (`turn/handled.ts`). */
  handled: HandledRow[];
  /**
   * How many of each group, the open total, and how many things were handled
   * since `seen` — the person's last look — or, with none, in the last day.
   */
  counts: Record<TurnGroup, number> & { total: number; handled: number };
  /** The last look the handled count is taken from — echoed, or null for the last day. */
  seen: string | null;
  /** Issue drafts wait on Repo ▸ Issues, not here: how many, and the link. */
  issues: { count: number; href: string } | null;
  /**
   * The plans' heads-ups (turn-by-turn phase 4): a `## Operator errands` row
   * no bullet names, with its steps — nothing checks it or waits on it, so it
   * is in no group and never counted. Each is a `know` item.
   */
  headsUp: TurnItem[];
  /**
   * The page's strip (turn-by-turn phase 9): how many are the person's to do
   * now (*Approve*, *Do now*, *Decide*), how many are being checked, how many
   * passed in the last day, and the nearest deadline an open item carries —
   * overdue or ahead, with the item it is on; null when none declares one.
   */
  strip: TurnStrip;
};

/** The strip's numbers and its *Next deadline* — `TurnAnswer.strip`. */
export type TurnStrip = {
  todo: number;
  checking: number;
  passedToday: number;
  nextDeadline: { at: string; item: string; title: string } | null;
};

/**
 * The strip, read off the groups: the open groups' count, the checks in
 * flight, Done's passed items, and the earliest `timing.deadline` of every
 * item not yet done (a deadline already past is the nearest of all). Pure.
 */
export function stripOf(groups: Record<TurnGroup, readonly TurnItem[]>): TurnStrip {
  let next: TurnStrip['nextDeadline'] = null;
  for (const group of TURN_GROUPS) {
    if (group === 'done') continue;
    for (const item of groups[group]) {
      const at = item.timing?.deadline;
      const ms = at ? Date.parse(at) : NaN;
      if (!Number.isFinite(ms)) continue;
      if (!next || ms < Date.parse(next.at)) next = { at: at!, item: item.item, title: item.title };
    }
  }
  return {
    todo: TURN_OPEN_GROUPS.reduce((n, group) => n + groups[group].length, 0),
    checking: groups.checking.length,
    passedToday: groups.done.filter((item) => item.personStatus === 'passed').length,
    nextDeadline: next,
  };
}

/** How long a settled item stays under *Done*. */
export const TURN_DONE_MS = 24 * 60 * 60_000;

const SETTLED = new Set<string>(HUMAN_STEP_SETTLED_STATES as readonly string[]);

/**
 * A ledger item's record — a plan item's merged with what its plan says now
 * (turn-by-turn phase 2): the plan's guide, options, effort, unblocks and
 * deadline where the ledger holds none, and the bullet's declared reason over
 * an inferred one, so an item the 7.0 door raised bare reads whole.
 */
function detailOf(step: HumanStep, plan?: PlanItemWords): TurnStepDetail {
  const own = ownDetailOf(step);
  if (!plan) return own;
  return {
    ...own,
    ...(plan.guide ? { guide: plan.guide, ...(plan.guideFrom ? { guideFrom: plan.guideFrom } : {}) } : {}),
    ...(!own.options && plan.options ? { options: plan.options } : {}),
    ...(own.effortMin === undefined && plan.effortMin !== undefined ? { effortMin: plan.effortMin } : {}),
    ...(!own.unblocks && plan.unblocks ? { unblocks: plan.unblocks } : {}),
    ...(!own.deadline && plan.deadline ? { deadline: plan.deadline } : {}),
    ...(own.whySource === 'inferred' && plan.why ? { why: plan.why, whySource: 'declared' as const } : {}),
    ...(plan.eref ? { eref: plan.eref } : {}),
    ...(plan.errand ? { errand: plan.errand } : {}),
  };
}

function ownDetailOf(step: HumanStep): TurnStepDetail {
  return {
    id: step.id, kind: step.kind, title: step.title, state: step.state, why: step.why, whySource: step.whySource,
    proofType: step.proofType, attempts: step.attempts, waiters: step.waiters, declaredAt: step.declaredAt, birth: step.birth,
    ...(step.proof ? { proof: step.proof } : {}),
    ...(step.proofWords ? { proofWords: step.proofWords } : {}),
    ...(step.guide ? { guide: step.guide } : {}),
    ...(step.options ? { options: step.options } : {}),
    ...(step.allowDecline ? { allowDecline: step.allowDecline } : {}),
    ...(step.effortMin ? { effortMin: step.effortMin } : {}),
    ...(step.unblocks ? { unblocks: step.unblocks } : {}),
    ...(step.until ? { until: step.until } : {}),
    ...(step.source ? { source: step.source } : {}),
    ...(step.read ? { read: step.read } : {}),
    ...(step.note ? { note: step.note } : {}),
    ...(step.permission ? { permission: step.permission } : {}),
    ...(step.deadline ? { deadline: step.deadline } : {}),
    ...(step.verdict ? { verdict: step.verdict } : {}),
    ...(step.verdicts?.length ? { verdicts: step.verdicts } : {}),
    // What the person wrote with each check (turn-by-turn phase 5), every proof type.
    ...(step.notes?.length ? { notes: step.notes } : {}),
  };
}

/**
 * The turn, projected from the inbox (every person-facing row, acknowledged
 * or not — an ack is "seen", never "done") and the ledger (each ledger item's
 * record; the steps settled in the last day as *Done*).
 */
export function turnView(
  inbox: { items: readonly InboxItem[]; generatedAt: string },
  ledger: {
    steps?: readonly HumanStep[]; now?: number; requests?: readonly AuthorityRequest[];
    /** What the AI handled (phase 136): the newest rows, and how many since the last look. */
    handled?: { rows: readonly HandledRow[]; since: number; seen: string | null };
    round?: RoundState;
    /** The console's edition — whether *Goes to* may say the supervisor (turn-by-turn phase 1). Free unless told. */
    edition?: 'free' | 'pro';
    /** A plan item's words from its plan NOW (turn-by-turn phase 2) — `PlanItems.wordsFor`. */
    planItem?: (step: HumanStep) => PlanItemWords | undefined;
    /** The open plans' heads-ups (turn-by-turn phase 4) — `PlanItems.headsUp`. */
    headsUp?: readonly HeadsUp[];
    /**
     * What a person pressed on a projected item (turn-by-turn phase 5,
     * `turn/settled.ts`) — Done shows each of the last day as Passed or Closed.
     */
    settled?: readonly SettledRecord[];
    /**
     * When each projected item was first seen (turn-by-turn phase 3,
     * `turn/first-seen.ts`) — stamped once per read; absent, a projected
     * item is assigned at its row's own clock.
     */
    firstSeen?: (entries: readonly SeenEntry[]) => ReadonlyMap<string, string>;
  } = {},
): TurnAnswer {
  const now = ledger.now ?? Date.parse(inbox.generatedAt);
  const byId = new Map((ledger.steps ?? []).map((step) => [step.id, step]));
  const links = coverLinks(ledger.steps ?? []);
  const items = new Map<string, Draft>();
  const settled = new Map((ledger.settled ?? [])
    .filter((record) => now - Date.parse(record.at) <= TURN_DONE_MS).map((record) => [record.item, record]));
  for (const row of inbox.items) {
    const turn = row.turn;
    if (!turn) continue;
    // A row that does not ask yet is shown only as what is coming up.
    if (row.severity === 'fyi' && turn.group !== 'upcoming') continue;
    // An ack-bound option answered it (turn-by-turn phase 5): the row stands,
    // seen, and the item is Done — until it asks again (a newer `since`).
    const pressed = settled.get(turn.item);
    if (row.ack && pressed && Date.parse(pressed.at) >= (Date.parse(row.since) || 0)) continue;
    const held = items.get(turn.item);
    if (held) {
      held.rows.push(row.id);
      // The step's own row leads: its verbs are the item's — and none of the
      // other row's options, approval or ASK words ride along.
      if (row.kind === 'human-step') {
        delete held.options;
        delete held.approval;
        delete held.ask;
        Object.assign(held, leadOf(row, turn), { rows: held.rows });
      }
      continue;
    }
    items.set(turn.item, leadOf(row, turn));
  }
  for (const item of items.values()) {
    const step = item.record === 'ledger' ? byId.get(item.item) : undefined;
    if (step) {
      const coveredBy = links.coveredBy.get(step.id);
      const covers = links.covers.get(step.id);
      item.step = { ...detailOf(step, planWords(ledger.planItem, step)), ...(coveredBy ? { coveredBy } : {}), ...(covers ? { covers } : {}) };
    }
    // A run request (turn-by-turn phase 6) is a yes or a no: its approval block
    // names the act and every phase that asked.
    const approval = step ? runRequestBlock(step) : null;
    if (approval) item.approval = approval;
  }
  // A request the owner has not answered (phase 148): on its item when the turn
  // shows that item, else a `decision` item of its own.
  for (const request of ledger.requests ?? []) {
    if (request.state !== 'open') continue;
    const view = requestView(request);
    const home = requestHome([...items.values()], request);
    if (home) (home.requests ??= []).push(view);
    else items.set(`request:${request.id}`, requestItem(view));
  }
  // *Done*: the ledger's items settled in the last day, nothing to press.
  for (const step of ledger.steps ?? []) {
    if (!SETTLED.has(step.state) || items.has(step.id) || now - Date.parse(step.at) > TURN_DONE_MS) continue;
    const turn = ledgerTurn(step);
    items.set(step.id, {
      ...turn, rows: [], title: step.title, need: step.title, how: step.note ?? '', severity: 'fyi',
      slug: step.slug, phase: step.phase, ...(step.runId ? { runId: step.runId } : {}),
      since: step.at, href: '', actions: [], step: detailOf(step, planWords(ledger.planItem, step)),
      // A settled run request is still the approval it was (turn-by-turn phase 11).
      ...(runRequestBlock(step) ? { approval: runRequestBlock(step)! } : {}),
    });
  }
  // …and the projected items a person pressed in the last day, from their
  // settled records (turn-by-turn phase 5): Passed or Closed, by whom, when.
  for (const record of settled.values()) {
    if (items.has(record.item)) continue;
    items.set(record.item, settledItem(record));
  }
  const groups = Object.fromEntries(TURN_GROUPS.map((group) => [group, [] as TurnItem[]])) as Record<TurnGroup, TurnItem[]>;
  const edition = ledger.edition ?? 'free';
  let seenAt: ReadonlyMap<string, string> = new Map();
  try {
    seenAt = ledger.firstSeen?.([...items.values()].filter((item) => item.record !== 'ledger').map((item) => ({ id: item.item, since: item.since })))
      ?? new Map();
  } catch { /* a store that cannot answer costs the clock, never the page */ }
  for (const item of items.values()) {
    const step = byId.get(item.item);
    const worded = withWords(withCardWords(item, step, edition, now), step, seenAt.get(item.item) ?? null, now);
    // A settled record says how it ended — the person's status is its outcome.
    const final = item.settled ? { ...worded, personStatus: item.settled.outcome } : worded;
    // The groups v2 (turn-by-turn phase 9): what the state already placed
    // (coming up, being checked, done) stays; an open item goes by its type
    // and readiness — an approval to Approve, a decision to Decide, NOT YET to
    // Coming up, every other act to Do now.
    const group = item.group === 'upcoming' || item.group === 'checking' || item.group === 'done'
      ? item.group
      : groupOf({ state: step?.state ?? null, type: final.type, readiness: final.readiness, personStatus: final.personStatus });
    groups[group].push(group === final.group ? final : { ...final, group });
  }
  const counts = Object.fromEntries(TURN_GROUPS.map((group) => [group, groups[group].length])) as TurnAnswer['counts'];
  counts.total = TURN_OPEN_GROUPS.reduce((n, group) => n + counts[group], 0) + counts.checking + counts.upcoming;
  counts.handled = ledger.handled?.since ?? 0;
  const drafts = inbox.items.filter((row) => row.kind === 'issue-draft');
  const seen = ledger.handled?.seen ?? null;
  return {
    round: {
      at: inbox.generatedAt, n: ledger.round?.n ?? 0, ranAt: ledger.round?.at ?? null, changedAt: ledger.round?.changedAt ?? null,
    },
    headline: headlineOf({
      open: TURN_OPEN_GROUPS.reduce((n, group) => n + counts[group], 0), checking: counts.checking, upcoming: counts.upcoming,
      done: counts.done, handled: counts.handled, handledSince: seen ? 'seen' : 'day',
    }),
    groups,
    handled: [...(ledger.handled?.rows ?? [])],
    counts,
    seen,
    issues: drafts.length ? { count: drafts.length, href: drafts[0]!.href } : null,
    headsUp: (ledger.headsUp ?? []).map((row) => headsUpItem(row, edition, now)),
    strip: stripOf(groups),
  };
}

/** A run request's approval block (turn-by-turn phase 6) — the act and every phase that asked — or null for any other step. */
function runRequestBlock(step: HumanStep): ApprovalBlock | null {
  const act = isRunRequestOf(step);
  if (!act) return null;
  return runRequestApproval(act, [step.phase, ...step.waiters.filter((w) => w.slug === step.slug).map((w) => Number(w.phase))]);
}

/**
 * A pressed projected item, as Done shows it (turn-by-turn phase 5): its
 * title, what the press did and who pressed it when — nothing to press.
 */
function settledItem(record: SettledRecord): Draft {
  return {
    item: record.item, record: 'projected', source: record.source, kind: 'decision', why: 'decision', proofType: 'answer',
    group: 'done', rows: [], title: record.title, need: `${record.what}.`,
    how: `${record.outcome === 'passed' ? 'Passed' : 'Closed'} — ${record.what.charAt(0).toLowerCase()}${record.what.slice(1)} by ${record.by}.`,
    severity: 'fyi', ...(record.slug ? { slug: record.slug } : {}), ...(record.phase !== undefined ? { phase: record.phase } : {}),
    ...(record.runId ? { runId: record.runId } : {}), since: record.at, href: '', actions: [],
    settled: { outcome: record.outcome, by: record.by, at: record.at, what: record.what },
  };
}

/** What a heads-up says it is: nothing checks it, nothing waits on it. */
const HEADS_UP_CHECK = 'Nothing checks it or waits on it — it is here so you know.';

/**
 * A plan's heads-up as an item (turn-by-turn phase 4, §Architecture 6): the
 * row's act as its title, its steps as the guide, a `know` — never counted,
 * nothing to press.
 */
function headsUpItem(row: HeadsUp, edition: 'free' | 'pro', now: number): TurnItem {
  const draft: Draft = {
    item: `heads-up:${row.slug}:${row.id}`, record: 'projected', source: 'plan', kind: 'operator-act', why: 'reserved', proofType: 'attest',
    group: 'upcoming', rows: [], title: row.what, need: '', how: '', severity: 'fyi', slug: row.slug, phase: 0, since: '', href: '', actions: [],
  };
  const words = cardWordsOf(draft, { phase: 0, bound: false, edition, now });
  const composed = composeItem({
    source: 'plan', record: 'projected', kind: 'operator-act', proofType: 'attest', why: 'reserved', slug: row.slug, phase: 0,
    step: { title: row.what, eref: row.id, ...(row.guide ? { guide: row.guide, guideFrom: 'errands-table' } : {}) },
    now,
  });
  return {
    ...draft, ...words,
    // A table row is written as the plan wrote it; the title is the act, raised.
    title: composed.title.charAt(0).toUpperCase() + composed.title.slice(1),
    ...(composed.headline ? { headline: composed.headline } : {}),
    ...(composed.errandRef ? { errandRef: composed.errandRef } : {}),
    need: `A heads-up from the plan ${row.slug}.`,
    how: HEADS_UP_CHECK,
    meta: composed.meta, steps: composed.steps, stepsFrom: composed.stepsFrom, check: HEADS_UP_CHECK, trouble: composed.trouble,
    timing: composed.timing, verdict: null, verdicts: [], options: [], approval: null,
  };
}

/** A plan item's words, or none — a composer that throws costs the item its plan words, never the page. */
function planWords(compose: ((step: HumanStep) => PlanItemWords | undefined) | undefined, step: HumanStep): PlanItemWords | undefined {
  if (!compose || step.birth !== 'plan') return undefined;
  try { return compose(step); } catch { return undefined; }
}

/** An item before its card's four words are derived — every source builds one, and `withCardWords` finishes it. */
type Draft = Omit<TurnItem, keyof CardWords | keyof Words> & { options?: TurnOption[]; approval?: ApprovalBlock };

/**
 * The item with its card's four words (turn-by-turn phase 1): a ledger item's
 * from its record — its state, birth, waiters and last verdict — a projected
 * one's from its row, which holds no ledger state.
 */
function withCardWords(item: Draft, step: HumanStep | undefined, edition: 'free' | 'pro', now: number): Omit<TurnItem, keyof Words> & Pick<Draft, 'options' | 'approval'> {
  return {
    ...item,
    ...cardWordsOf(item, {
      state: step?.state ?? null,
      birth: step?.birth ?? null,
      waiters: step?.waiters ?? null,
      phase: step?.phase ?? item.phase ?? null,
      dueWhen: step?.dueWhen ?? item.humanStep?.dueWhen ?? null,
      verdict: step?.verdict?.state ?? null,
      hasOptions: Boolean(item.step?.options?.length ?? step?.options?.length) || Boolean(item.options?.length),
      hasApproval: Boolean(item.approval),
      edition,
      now,
    }),
  };
}

/**
 * The item in the composer's words (turn-by-turn phase 3): a ledger item's
 * from its record merged with what its plan says now, a projected one's from
 * its row — the title, need and how replaced, the card's words added.
 */
function withWords(item: Omit<TurnItem, keyof Words> & Pick<Draft, 'options' | 'approval'>, step: HumanStep | undefined, firstSeen: string | null, now: number): TurnItem {
  const facts: StepFacts | undefined = step ? { ...step, ...item.step, title: step.title } as StepFacts : undefined;
  // The row's whole words, when its title was cut to the rule (#377) — the composer cuts them once more, the same way.
  const { headline: rowHeadline, ...rest } = item;
  const composed = composeItem({
    source: item.source, record: item.record, kind: item.kind, proofType: item.proofType, why: item.why,
    ...(item.slug ? { slug: item.slug } : {}), phase: item.phase ?? null,
    ...(facts ? { step: facts } : {
      row: {
        title: rowHeadline ?? item.title, need: item.need, how: item.how, since: item.since,
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        ...(item.openUntil ? { openUntil: item.openUntil } : {}),
        humanStep: item.humanStep,
        supervisor: item.supervisor,
        ask: item.ask,
        options: item.options,
        approval: item.approval,
      },
    }),
    firstSeen, now,
  });
  return {
    ...rest,
    title: composed.title,
    ...(composed.headline ? { headline: composed.headline } : {}),
    ...(composed.errandRef ? { errandRef: composed.errandRef } : {}),
    need: composed.need,
    how: composed.how,
    meta: composed.meta,
    steps: composed.steps,
    stepsFrom: composed.stepsFrom,
    check: composed.check,
    trouble: composed.trouble,
    timing: composed.timing,
    verdict: step?.verdict ?? null,
    verdicts: step?.verdicts ?? [],
    // A gate's Approve the composer offered names the item's run (turn-by-turn phase 5).
    options: composed.options.map((option) => ({ ...option, verb: boundToRun(option.verb, item) })),
    approval: composed.approval ?? approvalOf(item.approval),
  };
}

/** The item a request is about, among the ones the turn shows — or none. */
function requestHome(items: readonly Draft[], request: AuthorityRequest): Draft | undefined {
  const about = request.item;
  if (!about) return undefined;
  if (about.kind === 'human-step') return items.find((item) => item.item === about.id);
  if (about.kind === 'approval') {
    return items.find((item) => item.source === 'approval' && item.actions.some((action) => action.endpoint.startsWith(`/api/approvals/${about.id}`)));
  }
  if (about.kind === 'gate') return items.find((item) => item.source === 'gate' && item.slug === about.slug && item.phase === about.phase);
  return items.find((item) => item.source === about.kind && item.slug === about.slug);
}

/** A request about no item the turn shows: a `decision` only the owner answers. */
function requestItem(view: AuthorityRequestView): Draft {
  const sentence = view.ask.charAt(0).toUpperCase() + view.ask.slice(1);
  const answer = (verb: 'confirm' | 'refuse', label: string): InboxAction => ({
    verb, label, endpoint: `/api/owner/requests/${encodeURIComponent(view.id)}/${verb}`, method: 'POST',
  });
  return {
    item: `request:${view.id}`, record: 'request', source: 'request', kind: 'decision', why: 'decision', proofType: 'answer',
    group: 'decide', rows: [], title: sentence, need: view.summary,
    how: 'Confirm presses it now, as the owner; Refuse drops it. Only the owner answers it — sign in with your owner key.',
    severity: 'needs-you', since: view.at, href: '', actions: [answer('confirm', 'Confirm'), answer('refuse', 'Refuse')], request: view,
    // A request is a yes or a no only the owner gives (turn-by-turn phase 4).
    approval: {
      what: view.summary.split(' — ')[0] || sentence,
      askedBy: view.label,
      ifApproved: 'Confirm presses it now, as the owner',
      ifDenied: 'Refuse drops it, and nothing is pressed',
    },
  };
}

function leadOf(row: InboxItem, turn: TurnView): Draft {
  return {
    ...turn, rows: [row.id], title: row.title, need: row.need, how: row.how, severity: row.severity,
    ...(row.slug ? { slug: row.slug } : {}),
    ...(row.phase != null ? { phase: row.phase } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    since: row.since, ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.openUntil ? { openUntil: row.openUntil } : {}), href: row.href,
    actions: row.actions,
    ...(row.humanStep ? { humanStep: row.humanStep } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.supervisor ? { supervisor: row.supervisor } : {}),
    ...(row.ask ? { ask: row.ask } : {}),
    ...(row.options?.length ? { options: row.options } : {}),
    ...(row.approval ? { approval: row.approval } : {}),
    ...(row.headline ? { headline: row.headline } : {}),
    ...(row.files?.length ? { files: row.files } : {}),
  };
}
