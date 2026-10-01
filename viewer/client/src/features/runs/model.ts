/**
 * The fleet — every run the autopilot has made, as a record you can read.
 *
 * ## What the old table left on the wire
 *
 * `/api/runs` returns the **complete** `RunState` for every run of every plan:
 * the model and effort it ran on, its autonomy and permission profile, its
 * budgets, its consecutive failures, and a full `PhaseRecord` for every phase it
 * touched — status, attempts, cost, turns, duration, the session's own closing
 * words. There is no thinner list shape; all of that arrives whether you read it
 * or not.
 *
 * The table that stood here showed six of those fields, and not the one that
 * matters most: **why the run stopped**. A row said `halted` and nothing else, so
 * the only way to learn what had gone wrong was to leave the page. Meanwhile
 * every run of every plan for all time rendered at once, unsorted and
 * unfilterable, so the halted run was somewhere in two hundred finished ones.
 *
 * ## What a row is
 *
 * A `RunRow` is that state resolved into the things a fleet reader asks: what it
 * is doing, how far it got, what it cost against what it was allowed, how long
 * it actually worked, and — always — a sentence saying why it is where it is.
 *
 * ⚠️ `RunState.phases` is a `Record<string, PhaseRecord>`. The keys are phase
 * numbers **as strings**; `Object.values` and a numeric sort are the only safe
 * way through it.
 */

import { haltSentence } from '@shared/halt-categories.js';
import { isLive } from './defaults';
import { runStatusWord, waitReasonOf } from '@/lib/status-vocab';
import type { PhaseRecord, RunResolution, RunState } from '@/lib/api';
import { heldStopReason } from '@shared/orchestration-model.js';
import { describeRun, waitNote, type StatusView } from '@shared/status-model.js';
import type { FleetHoldView } from '@/components/fleet-freeze';
import { defineSorts } from '@/lib/list-model';

export interface RunRow {
  /** The plan's issue drafts waiting on a person (#118) — on the plan's newest run only. */
  pendingDrafts?: number;
  /** The raw halt — kind included, for the shared recovery model. */
  halt?: RunState['halt'] | null;
  id: string;
  slug: string;
  status: string;
  /**
   * The word the row PRINTS — `status`, except a `paused` run asleep on a clock
   * nobody paused, which reads `waiting` (`runStatusWord`, #148). `status` stays
   * the stored word for everything that acts on it.
   */
  word: string;
  /**
   * What a waiting run waits on and when it resumes — "on phase 28 · gh:… ·
   * resumes 08:57Z" (`waitNote`, #148) — printed beside the word; absent for
   * a run that is not waiting.
   */
  waitNote?: string;
  /**
   * The run as the status model reads it (`describeRun`) — what the row is
   * painted as, what its badge says, and whether it still asks for attention
   * (a stale stop settles as dormant, a person's wait is amber).
   */
  view: StatusView;
  live: boolean;
  /** Something is frozen — the whole run, or one lane of it. */
  frozen: boolean;

  activePhase: number | null;
  /** Every phase this run touched, in phase order. */
  phases: PhaseRecord[];
  phasesDone: number;
  /** Retries across the whole run — attempts beyond the first. */
  retries: number;

  spentUsd: number;
  budgetUsd: number | null;
  /** 0–1, clamped for drawing. Null when the run has no budget to be a fraction of. */
  spendFraction: number | null;
  overBudget: boolean;

  /** Wall-clock the phases actually ran for, freezes already subtracted. */
  workedMs: number | null;
  createdAt: number;
  updatedAt: number;

  model: string;
  effort?: string;
  autonomy: string;
  /** Absent on the wire means `guarded`, never "unknown". */
  profile: string;
  failures: number;
  maxFailures: number;

  /** Why this run is where it is. Never empty. */
  reason: string;
  /**
   * Set once this run stopped asking for a person — by the board overtaking it
   * or by someone dismissing it. The fleet is the one page that still shows
   * resolved runs, in full: the dashboard drops them, and nothing deletes them.
   */
  resolution: RunResolution | null;
}

/** Has this stopped run stopped demanding attention? */
export function isResolved(run: RunState): boolean {
  return Boolean(run.resolved);
}

/** The phases of a run, in phase order. */
export function phasesOf(run: RunState): PhaseRecord[] {
  return Object.values(run.phases ?? {}).sort((a, b) => a.phase - b.phase);
}

/**
 * Why a run is where it is, in one sentence.
 *
 * The runner already writes this down — `halt.reason` when it stopped on
 * something that must not be automated past, `finishedReason` in the words the
 * operator needs — and the old table showed neither. Everything below those two
 * is derived from state the run is carrying anyway, because a row that says only
 * `interrupted` has told you the least useful true thing about itself.
 *
 * `hold` is the hold binding the console now (`bindingHoldOf`): a stored
 * "it continues by itself" is read through it, so a frozen console's runs name
 * the freeze instead of promising what the freeze prevents (#93).
 */
export function stopReason(run: RunState, hold?: FleetHoldView | null): string {
  // A halt reads in the halt card's one sentence (control-tower phase 17); the
  // runner's own words are the card's, one press away.
  const sentence = haltSentence(run.halt);
  if (sentence) return run.halt?.phase != null ? `${sentence} (phase ${run.halt.phase})` : sentence;
  if (run.finishedReason) return heldStopReason(run.finishedReason, hold);

  if (run.freeze) {
    const where = run.freeze.phase != null ? `phase ${run.freeze.phase}` : 'mid-phase';
    return `frozen at ${where} by ${run.freeze.by}`;
  }
  if (run.pause) {
    const where = run.pause.afterPhase != null ? ` after phase ${run.pause.afterPhase}` : '';
    return run.status === 'paused'
      ? `paused${where} by ${run.pause.by}`
      : `pausing${where}, asked by ${run.pause.by}`;
  }
  // Which wait — the clock alone never said, and this line called all of them
  // a usage window. See `WAIT_REASONS`: a person's card is a wait too (WAI-10).
  if (run.waitUntil) {
    const reason = waitReasonOf(run);
    if (reason === 'external') return `waiting on external work until ${run.waitUntil}`;
    if (reason === 'person') return `waiting for a person to answer a card, until ${run.waitUntil}`;
    if (reason === 'connectivity') return `waiting for the network until ${run.waitUntil}`;
    // The machine, not the plan (#104): the engine timed out reading it.
    if (reason === 'engine-busy')
      return `the machine is too busy to read the plan — reading it again at ${run.waitUntil}`;
    return `waiting for the usage window until ${run.waitUntil}`;
  }

  switch (run.status) {
    case 'running':
      return run.activePhase != null ? `phase ${run.activePhase} is running` : 'starting';
    case 'stopping':
      return 'winding the session down';
    case 'parked':
      return 'every remaining phase needs a person';
    case 'finished':
      return 'nothing left to do on this plan';
    case 'interrupted':
      return 'nothing is driving it, and nothing recorded why';
    default:
      return run.status;
  }
}

export function toRows(runs: readonly RunState[], hold?: FleetHoldView | null): RunRow[] {
  return runs.map((run) => {
    const phases = phasesOf(run);
    const worked = phases.reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
    const budget = run.runBudgetUsd ?? null;
    const spent = run.spentUsd ?? 0;

    const waiting = waitNote(run as Parameters<typeof waitNote>[0]);
    const view = describeRun(run as Parameters<typeof describeRun>[0]);
    return {
      ...(run.pendingDrafts ? { pendingDrafts: run.pendingDrafts } : {}),
      ...(waiting ? { waitNote: waiting } : {}),
      id: run.id,
      slug: run.slug,
      status: run.status,
      word: runStatusWord(run),
      view,
      live: isLive(run.status),
      frozen: run.status === 'frozen' || Boolean(run.freeze),

      activePhase: run.activePhase ?? null,
      phases,
      phasesDone: phases.filter((p) => p.status === 'done').length,
      retries: phases.reduce((sum, p) => sum + Math.max(0, (p.attempts ?? 1) - 1), 0),

      spentUsd: spent,
      budgetUsd: budget,
      // Clamped here rather than in the meter: `LoadMeter` draws the fraction it
      // is given, and 140% of a budget would draw a bar past its own track.
      spendFraction: budget ? Math.min(1, spent / budget) : null,
      overBudget: Boolean(budget) && spent > budget!,

      workedMs: worked || null,
      createdAt: Date.parse(run.createdAt) || 0,
      updatedAt: Date.parse(run.updatedAt) || 0,

      model: run.model,
      effort: run.effort,
      autonomy: run.autonomy,
      profile: run.permissionProfile ?? 'guarded',
      failures: run.consecutiveFailures ?? 0,
      maxFailures: run.maxConsecutiveFailures ?? 0,

      reason: stopReason(run, hold),
      resolution: run.resolved ?? null,
      halt: run.halt ?? null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

const byRecency = (a: RunRow, b: RunRow) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/**
 * The fleet's orders.
 *
 * The mechanism is `lib/list-model.ts` — the copy-then-sort, the pin, the guard
 * and the control's own list were the same code in three feature files. What
 * stays here is the VOCABULARY: which orders exist, what each leads with, and
 * which rows are pinned.
 *
 * A live run is pinned to the top of EVERY order (`pin` below, applied before
 * the chosen comparator). Whatever you sorted by, the thing currently spending
 * money on your behalf is the row you came to see, and an ordering that buries
 * it under two hundred finished runs answers the wrong question.
 *
 * Declaration order is the default order: an id read off a browser that
 * predates a rename falls back to the first spec rather than emptying the list.
 */
const orders = defineSorts<RunRow, 'updated' | 'cost' | 'worked' | 'plan'>(
  {
    updated: { label: 'Latest', hint: 'most recent first', compare: byRecency },
    cost: {
      label: 'Cost',
      hint: 'most expensive first',
      compare: (a, b) => b.spentUsd - a.spentUsd || byRecency(a, b),
    },
    worked: {
      label: 'Longest',
      hint: 'most time on task',
      compare: (a, b) => (b.workedMs ?? 0) - (a.workedMs ?? 0) || byRecency(a, b),
    },
    plan: {
      label: 'Plan',
      hint: 'grouped by name',
      compare: (a, b) => a.slug.localeCompare(b.slug) || byRecency(a, b),
    },
  },
  { pin: (row) => row.live },
);

export const { SORTS, isSortId, sortRows } = orders;
export type SortId = (typeof SORTS)[number]['id'];

/* ------------------------------------------------------------------ *
 * The closure cut
 * ------------------------------------------------------------------ */

/**
 * Split the fleet by its plan's closure — the view gate ABOVE the filters, so
 * counts, chips, tiles and grouping all sit downstream of one cut and cannot
 * disagree about what the table holds.
 *
 * Closure only (`isClosed`: the server's `closed` flag, else a terminal status
 * word) — deliberately NOT "all phases done": closing is the operator's
 * explicit quieting signal, the plans page's identically-worded toggle hides
 * by closure only, and a run someone just watched finish must not vanish the
 * moment its last phase lands. A slug the plan list does not name is OPEN —
 * hiding is the lossy direction, and the plans query may still be loading.
 */
export function partitionClosed(
  rows: readonly RunRow[],
  closedSlugs: ReadonlySet<string>,
): { open: RunRow[]; closed: RunRow[] } {
  const open: RunRow[] = [];
  const closed: RunRow[] = [];
  for (const row of rows) (closedSlugs.has(row.slug) ? closed : open).push(row);
  return { open, closed };
}

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

/**
 * What the visible fleet adds up to.
 *
 * `spent` is the sum across what is on screen, not across everything the
 * autopilot has ever done — a total that ignored the filter would sit above a
 * list it does not describe.
 */
export function fleetTotals(rows: readonly RunRow[]) {
  let live = 0;
  let attention = 0;
  let spent = 0;
  let worked = 0;
  for (const row of rows) {
    if (row.live) live++;
    // Anything the model says still asks for a look — a stop, a person's wait,
    // a summons — and not a stop gone dormant, a pause you took, or a live loop.
    if (row.view.attention !== 'none') attention++;
    spent += row.spentUsd;
    worked += row.workedMs ?? 0;
  }
  return { shown: rows.length, live, attention, spent, worked };
}
