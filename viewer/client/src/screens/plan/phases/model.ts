/**
 * The phases grid's model — what a row IS, before anything draws it.
 *
 * ## The board decides, never the run record
 *
 * A run record is what THAT run did; `phase-graph.sh` is the only source of
 * done/ready/waiting. So the board decides a row's state and gates every
 * action, and the run's record rides beside it as its own facts — a phase this
 * run skipped and another session finished reads done, with "finished outside
 * this run" beside it, never `skipped` with a Run button. The rule lives in
 * `shared/phase-model.js` (`mergePhases`, `boardCounts`, `phaseActions`),
 * imported unchanged — the module `node --test` checks.
 *
 * ## One column array, both contexts
 *
 * The plan's Phases view and the Run view draw the SAME columns
 * (`table.tsx` `PHASE_COLUMNS`); a context only chooses which it leads with
 * and how it groups (`PHASE_TABLE_CONTEXTS`). A column a context hides is
 * still in every row's detail, one press away.
 */

import {
  BOARD_ORDER,
  boardCounts,
  fellOverToAnotherModel,
  mergePhases,
  phaseActions,
} from '@shared/phase-model.js';
import { hintedPhases, type HintedPhase } from '@shared/run-lifecycle.js';
import type {
  HandoffRow,
  LaneLiveness,
  PhaseEta,
  PhaseLock,
  PhaseRecord,
  PhaseView,
  PlanReviewer,
  QueueEntry,
  RunState,
  TerminalSession,
} from '@/data/api';
import { isVerdict } from '@/lib/qa';

/** A plan phase joined to whatever this run recorded against it. */
export interface MergedPhase extends PhaseView {
  record?: PhaseRecord;
  /** Finished, but not by this run — worth saying beside a `skipped` record. */
  elsewhere: boolean;
}

/** What may be done to one phase now — `phaseActions`' answer. */
export interface PhaseActionSet {
  runAlone: boolean;
  retry: boolean;
  skip: boolean;
  diagnose: boolean;
  /** The live claim stopping `runAlone`/`retry`, so a disabled button can name it. */
  heldBy: PhaseLock | null;
  /** A lapsed claim — worth tidying, never a reason to refuse. */
  staleLock: boolean;
}

export const mergeBoard = mergePhases as (planPhases: PhaseView[], run: RunState | null) => MergedPhase[];
export const countBoard = boardCounts as (rows: MergedPhase[]) => Record<string, number>;
export const actionsOf = phaseActions as (
  phase: MergedPhase,
  ctx: { live: boolean; allowRun: boolean },
) => PhaseActionSet;
export const fellOver = fellOverToAnotherModel as (record: PhaseRecord | undefined) => boolean;
/** The five board words in the operator's order. */
export const BOARD_WORDS = BOARD_ORDER as readonly string[];

/** Parked because its session started on another model than the one it is pinned to (#91). */
export const modelMismatch = (record: PhaseRecord | undefined): boolean =>
  record?.status === 'parked' && Boolean(record.modelMismatch);

/* ---------------- the five needs ---------------- */

/**
 * The board word a row shows: `in-progress` while this run is working the
 * phase, whatever the board still says (it catches up when the handoff lands).
 */
export function displayState(boardState: string, { running }: { running: boolean }): string {
  return running && boardState !== 'done' ? 'in-progress' : boardState;
}

/**
 * The five groups by NEED, needs-you first — what the Phases view groups by
 * until a person chooses plan order or scope. Done is folded by default
 * (`DONE_FOLDED`): the one group nobody is looking for.
 */
export const PHASE_GROUPS = [
  {
    id: 'needs-you',
    label: 'Needs you',
    hint: 'A gate, an errand or a claim only a person can settle.',
    // Every word the shared table calls `needs-you`, not only `stuck`: without
    // `gated` and `blocked` the two states that most need a person filed
    // themselves under Waiting, the group a reader scrolls past.
    states: ['stuck', 'gated', 'blocked'],
  },
  {
    id: 'running',
    label: 'Running',
    hint: 'Live lanes, and what is queued behind a scope.',
    states: ['in-progress'],
  },
  { id: 'ready', label: 'Ready', hint: 'Every dependency is done.', states: ['ready'] },
  { id: 'waiting', label: 'Waiting', hint: 'Blocked on a phase that is not finished.', states: ['waiting'] },
  { id: 'done', label: 'Done', hint: 'Finished — by this run or any other session.', states: ['done'] },
] as const;

export type PhaseGroupId = (typeof PHASE_GROUPS)[number]['id'];

export interface GroupablePhase {
  phase: number;
  state: string;
  record?: { status?: string };
}

/** Which need a phase is in. A word no group claims is Waiting — never dropped. */
export function phaseGroupOf(row: GroupablePhase): PhaseGroupId {
  const showing = displayState(row.state, { running: row.record?.status === 'running' });
  return PHASE_GROUPS.find((g) => (g.states as readonly string[]).includes(showing))?.id ?? 'waiting';
}

/** The rows by need, in need order, empty groups dropped. */
export function groupPhases<Row extends GroupablePhase>(
  rows: readonly Row[],
): { id: PhaseGroupId; label: string; hint: string; rows: Row[] }[] {
  return PHASE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    hint: group.hint,
    rows: rows.filter((row) => phaseGroupOf(row) === group.id),
  })).filter((group) => group.rows.length > 0);
}

export const NEED_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  PHASE_GROUPS.map((g) => [g.id, g.label]),
);
export const NEED_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  PHASE_GROUPS.map((g, i) => [g.id, i]),
);

/* ---------------- the row ---------------- */

/**
 * What this console can hand to a Claude session, and what is already on it.
 * Threaded in rather than read by the table, so the table renders in a test
 * with no query client.
 */
export type PhaseRecovery = {
  allowAgent: boolean;
  sessions?: readonly TerminalSession[];
  /** The run's halt looks like an authentication failure — one class overrides all. */
  authFailure?: boolean;
  /** The plan's qa-mode, so a row can offer to turn it on with the review. */
  qaMode?: string;
  /** Skills the plan asks every session to invoke. */
  planSkills?: string[];
  /** Where the plan orders its own reviewer — "Run only this" advises from it. */
  planReviewers?: PlanReviewer[];
  /** Whether the console may turn QA on for the plan — a different flag from allowAgent. */
  allowWrites?: boolean;
};

/** Which page the grid is drawn on, and which reading of it. */
export type PhaseTableContext = 'run' | 'plan' | 'plan-qa' | 'plan-handoffs';

/** What every cell of one render shares — one object, handed to every row. */
export interface PhaseTableScope {
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  /** The plan's own QA word — what a phase with no bullet of its own inherits. */
  planQaMode?: string;
  onRunAlone: (phase: number) => void;
  /** Opens the phase in the panel (the plan page's inspector). */
  onInspect?: (phase: number) => void;
}

/** One row: a phase, and every fact this render knows about it. */
export interface PhaseTableRow {
  p: MergedPhase;
  scope: PhaseTableScope;
  entry?: QueueEntry | undefined;
  conflicts?: string[] | undefined;
  eta?: PhaseEta | undefined;
  /** This phase's live lane, when it has one. */
  liveness?: LaneLiveness | undefined;
  /** How many rulings this phase's sessions recorded. */
  rulings: number;
  /** The phases this phase's recorded QA verdict holds — the HELD state. */
  holds: number[];
  /** The handoff file's own row, when one was written. */
  handoff?: HandoffRow | undefined;
  /** INDEX.md's word — `missing` when a handoff exists and the index has no row. */
  index?: string | undefined;
}

/** A session of THIS run is open on the phase. */
export const runningOf = (row: PhaseTableRow): boolean => {
  const r = row.p.record;
  return (
    row.scope.live &&
    Boolean(r?.startedAt) &&
    !r?.endedAt &&
    (r?.status === 'running' || r?.status === 'verifying')
  );
};

/** The need a row is in. */
export const needOf = (row: PhaseTableRow): PhaseGroupId =>
  phaseGroupOf({ phase: row.p.phase, state: row.p.state, ...(row.p.record ? { record: row.p.record } : {}) });

/** What the run has spent on the phase: the booked sessions plus the one in flight. */
export function spendOf(record: PhaseRecord | undefined): number | undefined {
  if (!record) return undefined;
  const inflight = record.status === 'running' ? (record.live?.spentUsd ?? 0) : 0;
  const total = (record.costUsd ?? 0) + inflight;
  return total > 0 ? total : undefined;
}

/** The verdict word a QA filter tests: a recorded verdict, `pending`, or `none`. */
export function qaWordOf(phase: PhaseView): string {
  const result = phase.qa?.result;
  return isVerdict(result) || result === 'pending' ? (result as string) : 'none';
}

/** This phase's row in `hintedPhases(run)` — a re-board asked for it and nothing holds it yet. */
export function hintedOf(run: RunState | null, phase: number): HintedPhase | undefined {
  return hintedPhases(run).find((row) => row.phase === phase);
}

/** Which attached servers a phase reached for, and how often — in words. */
export function mcpCallWords(calls: Record<string, number>): string {
  return Object.entries(calls)
    .map(([id, count]) => `${id} ${count} time${count === 1 ? '' : 's'}`)
    .join(', ');
}

/* ---------------- the readings ---------------- */

/**
 * The readings — one on the run page, three on the plan page — and the
 * columns each leads with. A hidden column is still in every row's detail, and
 * the operator's own choice (the toolbar's columns), stored under `tableId`,
 * wins. The QA and Handoffs readings open in PLAN ORDER: their subject is
 * mostly finished phases, which grouping by need would fold away under Done.
 */
export const PHASE_TABLE_CONTEXTS: Record<
  PhaseTableContext,
  { tableId: string; label: string; hidden: readonly string[]; groupBy?: string }
> = {
  run: {
    tableId: 'phases.run',
    label: 'Phases in this run',
    hidden: ['need', 'handoff', 'gate'],
    groupBy: 'need',
  },
  plan: {
    tableId: 'phases.plan',
    label: 'Phases',
    hidden: ['need', 'deps', 'lock', 'run', 'turns'],
    groupBy: 'need',
  },
  'plan-qa': {
    tableId: 'phases.plan-qa',
    label: 'QA by phase',
    hidden: ['need', 'scope', 'deps', 'lock', 'size', 'run', 'handoff', 'gate', 'spend', 'turns'],
  },
  'plan-handoffs': {
    tableId: 'phases.plan-handoffs',
    label: 'Handoffs by phase',
    hidden: [
      'need',
      'scope',
      'deps',
      'lock',
      'size',
      'lane',
      'run',
      'qa',
      'gate',
      'spend',
      'turns',
      'actions',
    ],
  },
};

/**
 * Past this many phases only a window of rows is drawn — lower than the
 * grid's default, because a phase row carries more than a line of text: a
 * 72-phase plan once had every row in the DOM twice over (#26).
 */
export const PHASE_VIRTUAL_FROM = 40;

/** Done is folded until someone opens it. */
export const DONE_FOLDED: readonly string[] = ['need:done'];
