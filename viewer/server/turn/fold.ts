/**
 * The fold (control-tower phase 132, #209, §Architecture 19): which inbox row
 * is which ITEM of Your turn — its kind, why only a person fits it, how it is
 * proven, and which of the two records holds it.
 *
 *   - A LEDGER item is a human step (`human-steps.ndjson`), raised through the
 *     one door (`turn/index.ts` `raiseTurn`) and pressed through
 *     `/api/human-steps/:id/…`: a plan bullet, a session's step, a person
 *     errand, a credential or MCP preflight, a converted stall, an unanswerable
 *     relay question. Its view names the STEP's id, so the human-step row and
 *     the errand row that stand for one step are one item.
 *   - A PROJECTED item keeps the record and the routes it already has — the
 *     approval broker's card, a gate, a plan-approval hold, a QA ask, a live
 *     relay question, a person-check, a sign-in, a conflict — and its view
 *     names the inbox row's own id; nothing about it is written twice.
 *
 * Pure: a row and the open steps in, a view out. Rows nothing waits on (health,
 * lock, ruling, policy, message) have no view — they stay in the bell — and an
 * issue draft is not an item: the turn names how many wait, with a link.
 */

import { HUMAN_STEP_FOLDS, type HumanStepKind } from '../../shared/human-step-model.js';
import {
  CHECKED_BY_LABEL, defaultReason, groupOf, inferProofType, personStatusOf, readinessOf, reasonAllowed, routeOf, typeOf, TURN_SOURCES,
  type ItemType, type PersonStatus, type ProofType, type Readiness, type RouteTo, type TurnGroup, type TurnRecord,
  type TurnSource, type WhyPerson,
} from '../../shared/turn-model.js';
import { isPersonErrand } from '../../shared/recovery-model.js';
import { whenWords } from '../../shared/proof-words.js';
import type { PermissionDetail } from '../permissions/walls.ts';

/**
 * Where an item came from, and which record holds it — §Architecture 19's
 * sources, one word each. Owned by `shared/turn-model.js` since turn-by-turn
 * phase 1, whose card tables are keyed by them; re-exported here by identity.
 */
export { TURN_SOURCES };
export type { TurnRecord, TurnSource };

/** The `turn` view an inbox row carries when it asks a person for an act. */
export type TurnView = {
  /** The item this row IS: a ledger step's id, or the row's own id when the item is projected. */
  item: string;
  record: TurnRecord;
  source: TurnSource;
  kind: HumanStepKind;
  why: WhyPerson;
  proofType: ProofType;
  group: TurnGroup;
  /**
   * A permission item's record (control-tower phase 135, #212): the tool, the
   * rule, the command, why it was needed, the wall and its risk tier — the
   * ledger's for a raised wall, the card's for the broker's projected ask.
   */
  permission?: PermissionDetail;
  /**
   * The card's words a ROW carries (turn-by-turn phase 10): its type and
   * whether it is due, and NOT YET's *when* in words — so the Runs home, the
   * bell and the phone say what the card says. Set by `withRowWords`.
   */
  type?: ItemType;
  readiness?: Readiness;
  startWhen?: string;
};

/** The inbox kinds nothing waits on — they stay in the bell, never in the turn. */
export const BELL_KINDS = Object.freeze(['health', 'lock', 'ruling', 'policy', 'message'] as const);

/** What a ledger step's `source.kind` (or, on a line written before sources, its birth) says it came from. */
const STEP_SOURCES: Readonly<Record<string, TurnSource>> = Object.freeze({
  'plan-bullet': 'plan',
  plan: 'plan',
  declaration: 'session',
  session: 'session',
  errand: 'errand',
  preflight: 'preflight',
  relay: 'relay',
  supervisor: 'supervisor',
  stall: 'stall',
  // A wall the console recorded, and the act a person took over from one
  // (control-tower phase 135): the session's lane met it, so it is the session's.
  wall: 'session',
  convert: 'session',
  // A phase's run request (turn-by-turn phase 6): the run's to take.
  'run-request': 'run-request',
  // What a session's closing words asked a person (measured-console phase 29):
  // its prose questions, a pack's gate — the session's ask, read by the console.
  'prose-question': 'session',
  pack: 'session',
  // A console-raised step with no source of its own is a converted stall
  // reading — the one console birth before this phase.
  console: 'stall',
});

/** A projected row's fold, by inbox kind: the source it is, the item kind (the fold map's), the reason and the proof. */
const PROJECTED: Readonly<Record<string, { source: TurnSource; kind: HumanStepKind; why: WhyPerson; proofType: ProofType }>> =
  Object.freeze({
    approval: { source: 'approval', kind: HUMAN_STEP_FOLDS.approval, why: 'permission', proofType: 'grant' },
    gate: { source: 'gate', kind: HUMAN_STEP_FOLDS.gate, why: 'decision', proofType: 'answer' },
    qa: { source: 'qa', kind: HUMAN_STEP_FOLDS.qa, why: 'decision', proofType: 'answer' },
    question: { source: 'question', kind: HUMAN_STEP_FOLDS.question, why: 'decision', proofType: 'answer' },
    'session-ask': { source: 'session-ask', kind: HUMAN_STEP_FOLDS.question, why: 'decision', proofType: 'answer' },
    'sign-in': { source: 'sign-in', kind: HUMAN_STEP_FOLDS['sign-in'], why: 'identity', proofType: 'probe' },
    'mcp-auth': { source: 'mcp-auth', kind: HUMAN_STEP_FOLDS['mcp-auth'], why: 'identity', proofType: 'probe' },
    conflict: { source: 'conflict', kind: HUMAN_STEP_FOLDS.conflict, why: 'decision', proofType: 'answer' },
    supervisor: { source: 'supervisor', kind: HUMAN_STEP_FOLDS.supervisor, why: 'reserved', proofType: 'attest' },
    stall: { source: 'stall', kind: HUMAN_STEP_FOLDS.stall, why: 'decision', proofType: 'answer' },
    // An errand no step stands behind — the ladder's own ask, or one stored
    // before this phase: what to do next is the person's call.
    errand: { source: 'errand', kind: HUMAN_STEP_FOLDS.errand, why: 'decision', proofType: 'answer' },
  });

/** The facts of a ledger step the fold reads — the open steps the inbox is built from. */
export type FoldStep = {
  id: string;
  kind: string;
  state?: string;
  birth?: string;
  why?: string;
  proofType?: string;
  proof?: string;
  proofWords?: string;
  source?: { kind: string; ref?: string };
  permission?: { wall: string } & Partial<Omit<PermissionDetail, 'wall'>>;
};

/** The row the fold reads — a draft before its id is minted, or a minted item. */
export type FoldRow = {
  kind: string;
  severity?: string;
  subject?: string;
  humanStep?: { kind: string; fold?: string | null; stepId?: string | null; state?: string | null } | undefined;
  turn?: TurnView;
  /** A tool card's permission record (control-tower phase 135). */
  permission?: PermissionDetail;
};

/** A ledger step's view — the step's own kind, reason and proof type, its source, and its group. */
export function ledgerTurn(step: FoldStep): TurnView {
  const kind = step.kind as HumanStepKind;
  const why = typeof step.why === 'string' && reasonAllowed(kind, step.why) ? (step.why as WhyPerson) : defaultReason(kind);
  const proofType = (step.proofType as ProofType | undefined)
    ?? inferProofType({ kind, ...(step.proof ? { proof: step.proof } : {}), ...(step.proofWords ? { proofWords: step.proofWords } : {}) })
    ?? 'attest';
  const source = STEP_SOURCES[step.source?.kind ?? ''] ?? STEP_SOURCES[step.birth ?? ''] ?? 'stall';
  return {
    item: step.id, record: 'ledger', source, kind, why, proofType, group: groupOf({ state: step.state, kind, proofType, source, record: 'ledger' }),
    ...(kind === 'permission' && step.permission ? { permission: step.permission as PermissionDetail } : {}),
  };
}

/** A projected item's view: the row's own id, the fold's kind, reason and proof type. */
function projected(id: string, fold: { source: TurnSource; kind: HumanStepKind; why: WhyPerson; proofType: ProofType }, state?: string | null): TurnView {
  return {
    item: id, record: 'projected', source: fold.source, kind: fold.kind, why: fold.why, proofType: fold.proofType,
    group: groupOf({ ...(state ? { state } : {}), kind: fold.kind, proofType: fold.proofType, source: fold.source, record: 'projected' }),
  };
}

/**
 * Is this errand a person's errand that IS an `operator-act` item — one a
 * session declared, which no other record answers? A gate and a held plan are
 * their own records (projected), a protected path is its own kind, a
 * permission wall is phase 135's `permission` item, and a lock or an external
 * wait is answered by the world.
 */
export function errandIsItem(situation: string | null | undefined): boolean {
  if (!isPersonErrand(situation)) return false;
  const sub = String(situation ?? '').split(':')[1] ?? '';
  return sub !== 'gate' && sub !== 'protected-path' && sub !== 'permission' && sub !== 'run';
}

/** Is this errand a permission wall's — the item the lane's recorded wall raised (control-tower phase 135)? */
export function wallErrand(situation: string | null | undefined): boolean {
  return situation === 'blocked-declared:permission';
}

/**
 * The open ledger item a person errand IS (control-tower phase 132, #209): the
 * one it names (`stepId`), the step its phase is parked on, or the
 * `operator-act` item the console raised for it — one item, one done path.
 * The inbox's errand row and `answerErrand` ask this one question.
 */
export function itemOfErrand<T extends FoldStep & { slug: string; phase: number | string; runId?: string }>(
  open: readonly T[],
  at: { slug: string; runId: string; phase: number; errand?: { situation: string; stepId?: string } | null; parkedOn?: string | null },
): T | undefined {
  for (const id of [at.errand?.stepId, at.parkedOn]) {
    const hit = id ? open.find((step) => step.id === id && step.slug === at.slug) : undefined;
    if (hit) return hit;
  }
  if (!at.errand) return undefined;
  // A permission errand IS the permission item its lane's recorded wall raised
  // (control-tower phase 135, #212): one item, its Grant, Deny, I'll do it myself.
  if (wallErrand(at.errand.situation)) {
    return open.find((step) => step.birth === 'console' && step.kind === 'permission' && step.source?.kind === 'wall'
      && step.slug === at.slug && Number(step.phase) === at.phase && step.runId === at.runId);
  }
  // A run request's errand IS the one approval per run and act its phase
  // asked for or joined as a waiter (turn-by-turn phase 6).
  if (at.errand.situation === 'blocked-declared:run') {
    return open.find((step) => step.birth === 'console' && step.source?.kind === 'run-request' && step.slug === at.slug
      && step.runId === at.runId
      && [{ phase: step.phase }, ...((step as { waiters?: readonly { phase: number | string }[] }).waiters ?? [])]
        .some((w) => Number(w.phase) === at.phase));
  }
  if (!errandIsItem(at.errand.situation)) return undefined;
  return open.find((step) => step.birth === 'console' && step.source?.kind === 'errand' && step.slug === at.slug
    && Number(step.phase) === at.phase && step.runId === at.runId);
}

/**
 * The view on one row, or undefined when the row asks nobody for an act. A
 * row that already carries one (an errand row linked to its step) keeps it.
 */
export function turnOf(
  row: FoldRow, id: string, stepOf: (stepId: string) => FoldStep | undefined,
  /** The open permission item whose Grant presses this card (control-tower phase 135), if one does. */
  itemOfCard?: (cardId: string) => FoldStep | undefined,
): TurnView | undefined {
  if (row.turn) return row.turn;
  if ((BELL_KINDS as readonly string[]).includes(row.kind) || row.kind === 'issue-draft') return undefined;
  if (row.kind === 'human-step') {
    const step = row.subject ? stepOf(row.subject) : undefined;
    return step ? ledgerTurn(step) : undefined;
  }
  // The widen rung's card is its permission item's Grant, not an item of its
  // own: the card's row folds into the ledger item (one thing to do).
  if (row.kind === 'approval' && row.subject && itemOfCard) {
    const step = itemOfCard(row.subject);
    if (step) return ledgerTurn(step);
  }
  const view = row.humanStep;
  // The verification card is a person-check; the plan a plan-mode phase
  // presented is a decision of its own record; a protected path is its kind.
  if (row.kind === 'approval' && view?.fold === 'person-check') {
    return projected(id, { source: 'person-check', kind: HUMAN_STEP_FOLDS['person-check'], why: 'decision', proofType: 'answer' });
  }
  if (row.kind === 'errand' && view?.fold === 'plan-approval') {
    return projected(id, { source: 'plan-approval', kind: HUMAN_STEP_FOLDS['plan-approval'], why: 'decision', proofType: 'answer' });
  }
  if (row.kind === 'errand' && view?.fold === 'protected-path') {
    return projected(id, { source: 'errand', kind: HUMAN_STEP_FOLDS['protected-path'], why: 'reserved', proofType: 'attest' });
  }
  // A silent lane's suspected turn is drawn as the kind it reads as.
  if (row.kind === 'stall' && view?.kind) {
    const kind = view.kind as HumanStepKind;
    return projected(id, { source: 'stall', kind, why: defaultReason(kind), proofType: 'attest' });
  }
  const fold = PROJECTED[row.kind];
  if (!fold) return undefined;
  const item = projected(id, fold);
  return row.kind === 'approval' && row.permission ? { ...item, permission: row.permission } : item;
}

/**
 * The card's words (turn-by-turn phase 1, §Architecture 2) — what every `GET
 * /api/turn` item carries: its type, the person's status, its readiness, where
 * a press goes and — since phase 5 — *Checked by*, in words, from the one label
 * map over the proof types (`CHECKED_BY_LABEL`).
 */
export type CardWords = { type: ItemType; personStatus: PersonStatus; readiness: Readiness; route: RouteTo; checkedBy: string };

/**
 * The four words of one item, each derived once by `shared/turn-model.js`
 * from what the item already carries — its view, and a ledger item's record —
 * in the console's edition. Pure.
 */
export function cardWordsOf(view: Pick<TurnView, 'kind' | 'source' | 'record' | 'proofType'>, facts: {
  state?: string | null;
  birth?: string | null;
  waiters?: readonly { phase?: number | string }[] | null;
  phase?: number | null;
  dueWhen?: string | null;
  startAt?: string | null;
  verdict?: string | null;
  hasOptions?: boolean;
  /** The item carries an approval block (turn-by-turn phase 4) — a yes or a no. */
  hasApproval?: boolean;
  /** A plan's errands row no bullet names (turn-by-turn phase 4) — a heads-up. */
  bound?: boolean;
  edition: 'free' | 'pro';
  now: number;
}): CardWords {
  return {
    type: typeOf({
      kind: view.kind, source: view.source, record: view.record, proofType: view.proofType, hasOptions: Boolean(facts.hasOptions),
      hasApproval: Boolean(facts.hasApproval), ...(facts.bound === false ? { bound: false } : {}),
    }),
    personStatus: personStatusOf({ state: facts.state ?? null, verdict: facts.verdict ?? null, record: view.record }),
    readiness: readinessOf({ state: facts.state ?? null, dueWhen: facts.dueWhen ?? null, startAt: facts.startAt ?? null, now: facts.now }),
    route: routeOf({
      birth: facts.birth ?? null, source: view.source, record: view.record, waiters: facts.waiters ?? null,
      phase: facts.phase ?? null, edition: facts.edition,
    }),
    checkedBy: CHECKED_BY_LABEL[view.proofType],
  };
}

/**
 * A row's view with the card's words (turn-by-turn phase 10): the type, the
 * readiness and NOT YET's *when* — derived by the same rules `GET /api/turn`
 * uses (`typeOf`, `readinessOf`, `whenWords`) — and the group the page puts it
 * in, re-placed the way `turnView` re-places it (an approval to Approve, a
 * decision to Decide, NOT YET to Coming up), so a row and its card never sit in
 * two groups. Coming up, Being checked and Done stand as the fold placed them.
 * Pure.
 */
export function withRowWords(view: TurnView, facts: {
  state?: string | null;
  dueWhen?: string | null;
  hasOptions?: boolean;
  hasApproval?: boolean;
  now: number;
}): TurnView {
  const type = typeOf({
    kind: view.kind, source: view.source, record: view.record, proofType: view.proofType,
    hasOptions: Boolean(facts.hasOptions), hasApproval: Boolean(facts.hasApproval),
  });
  const readiness = readinessOf({ state: facts.state ?? null, dueWhen: facts.dueWhen ?? null, now: facts.now });
  const group = view.group === 'upcoming' || view.group === 'checking' || view.group === 'done'
    ? view.group
    : groupOf({ state: facts.state ?? null, type, readiness });
  return {
    ...view, type, readiness, group,
    ...(readiness === 'not-yet' && facts.dueWhen ? { startWhen: whenWords(facts.dueWhen) } : {}),
  };
}
