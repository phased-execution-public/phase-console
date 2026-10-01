/**
 * Where this plan is up to, and what may still be done to each phase.
 *
 * ## The board decides, never the run record
 *
 * The old table was built from `run.phases` — the runner's own bookkeeping — and
 * presented that as the phase's status. On a real plan a phase this run had
 * skipped and another session then finished still read `skipped`, and the console
 * offered to run it again. A run record is a record of what THAT RUN did; it was
 * never the phase's state. `phase-graph.sh` is the only source of truth for
 * done/ready/waiting, so the board decides the status and gates every action, and
 * the run record is shown beside it as its own column.
 *
 * That rule lives in `shared/phase-model.js` (`mergePhases` / `boardCounts` /
 * `phaseActions`), imported unchanged — the same module `node --test` checks.
 *
 * ## One table, both pages (control-tower phase 23, #25 #26 #27)
 *
 * The plan page listed the same phases four times — a departures board, a card
 * list, a QA table and a handoffs table, each with a third of their facts —
 * and the run page drew a fifth, hand-rolled, with the rest. `PHASE_COLUMNS` is
 * ONE column array now, and both pages draw it through `DataTable`: the run page
 * as the `run` reading, the plan page's Phases tab as `plan`, `plan-qa` or
 * `plan-handoffs` (`PHASE_TABLE_CONTEXTS`). A reading is a `tableId` and the
 * columns it leads with; the operator's own column set, filters, grouping and
 * folded groups are remembered per reading (`lib/prefs.ts` `tables`), and a
 * hidden column is still in every row's detail.
 *
 * The rows group by NEED (the five `PHASE_GROUPS`, needs-you first, Done
 * folded), by plan order (no groups) or by scope. Past `PHASE_VIRTUAL_FROM`
 * rows only a window is drawn — against `<main>`, so the header still sticks.
 *
 * The cells that move while a lane works — the attempt clock, the silence, the
 * tasks, the spend — read the run query `run:progress` patches in place
 * (`lib/queries.ts` `patchProgress`) and tick on a clock of their own, so a
 * live table costs no request per frame on either page (#25).
 */

import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Empty } from '@/components/ui';
import { DataTable, type Column } from '@/components/data-table';
import { OpsBadge, PhaseStatusBadge, QaBadge, type WordOf } from '@/components/ui/status';
import {
  type HandoffRow,
  type LaneLiveness,
  type PhaseEta,
  type Ruling,
  type PhaseLock,
  type PhaseRecord,
  type PhaseScope,
  type PhaseView,
  type PlanReviewer,
  type QueueEntry,
  type RunState,
  type TerminalSession,
} from '@/lib/api';
import { countdown, duration, elapsed, money, pad2, relativeTime } from '@/lib/format';
import { PHASE_CLOCK_LABELS, PHASE_ROW_CLOCK, phaseClocks } from '@shared/phase-clocks.js';
import { SILENCE_LABELS } from '@shared/attention-model.js';
import { hintedPhases, type HintedPhase } from '@shared/run-lifecycle.js';
import { DepsCell, LockCell, SizeCell } from '@/features/plans/phase-cells';
import { InspectButton, PhaseProse } from '@/features/plans/phase-inspector';
import { plainText } from '@/components/markdown';
import { ForceReleaseButton } from '@/components/release-lock';
import { useNow } from '@/lib/clock';
import { useConsoleState } from '@/lib/queries';
import { phaseProgress } from './tiles';
import { MCP_REASON } from './defaults';
import { classifyBoardPhase, classifyPhase, liveRecovery } from '@/lib/recovery';
import { canQa, isVerdict, liveQa, phaseQaMode, qaReportHref } from '@/lib/qa';
import { QaButton } from '@/components/qa-launcher';
// The LAZY dialog: this table is on the plan page too, and the dialog is the
// whole run-setup surface, which `check-dist.mjs` keeps out of that chunk.
import { LaunchDialog } from '@/features/run-setup/lazy-launch-dialog';
import { RecoveryButton } from './status-strip';
import { PhaseDrawer } from './phase-drawer';
import { ContextChip, EvidenceLine, LivenessChip, PhaseStateChip, RulingsChip } from './phase-row';
import { BranchChip } from './git-card';
import { LandChip, LandingStateChip } from './landing-chips';
import { LastActivity } from './now-panel';
import { TaskLine } from './task-summary';
import { RecoveryActions } from '@/components/recovery-actions';
import { queueEntryFor, queueMarks, waitingLabel } from './queue-words';
import { handoffHref, phaseHref, planHref } from '@shared/routes.js';
import {
  BOARD_ORDER,
  boardCounts,
  fellOverToAnotherModel,
  mergePhases,
  phaseActions,
} from '@shared/phase-model.js';
import { Bot, Gauge } from 'lucide-react';

import { scopeOfRow } from '@shared/scope.js';
import { ScopeChips } from '@/components/scope-chips';
import { boardStateTitle, phaseStatusTitle, qaResultTitle } from '@/lib/status-vocab';
import { cn } from '@/lib/cn';
import { PHASE_GROUPS, displayState, groupOf, groupRows } from './phase-groups';
import type { GroupablePhase, PhaseGroupId } from './phase-groups';
import { TreeLine, verdictTree } from '@/components/verify-tree';

/** A plan phase joined to whatever this run recorded against it. */
interface MergedPhase extends PhaseView {
  record?: PhaseRecord;
  /** Finished, but not by this run — worth saying out loud beside a `skipped` record. */
  elsewhere: boolean;
}

interface Actions {
  runAlone: boolean;
  retry: boolean;
  skip: boolean;
  diagnose: boolean;
  /** The live claim stopping `runAlone`/`retry`, so a disabled button can name it. */
  heldBy: PhaseLock | null;
  /** A lapsed claim — worth tidying, never a reason to refuse. */
  staleLock: boolean;
}

const merge = mergePhases as (planPhases: PhaseView[], run: RunState | null) => MergedPhase[];
const counts = boardCounts as (rows: MergedPhase[]) => Record<string, number>;
const actionsFor = phaseActions as (phase: MergedPhase, ctx: { live: boolean; allowRun: boolean }) => Actions;
const fellOver = fellOverToAnotherModel as (record: PhaseRecord | undefined) => boolean;
/** Parked because its session started on another model than the one it is pinned to (#91). */
const modelMismatch = (record: PhaseRecord | undefined): boolean =>
  record?.status === 'parked' && Boolean(record.modelMismatch);
const ORDER = BOARD_ORDER as string[];
/** The Repos cell as scope tokens, never empty — a blank cell means `all`. */
const scopeOf = scopeOfRow as (cell: string | undefined) => string[];
const SILENCE_LABEL = SILENCE_LABELS as Readonly<Record<string, string>>;

/**
 * What this console can hand to a Claude session, and what is already on it.
 *
 * Threaded in rather than read here: the table is rendered in tests without a
 * query client, and a component that fetches its own sessions could not be.
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
  /** Where the plan orders its own reviewer — "Run only this one" advises from it. */
  planReviewers?: PlanReviewer[];
  /** Whether the console may turn QA on for the plan — a different flag from allowAgent. */
  allowWrites?: boolean;
};

/*
 * The five groups, `groupOf`, `groupRows` and `displayState` live in
 * `./phase-groups` — a leaf module with no imports — and are re-exported here
 * so every existing caller and test keeps working.
 *
 * ⚠️ This table is mounted by the plan page since control-tower phase 23, so
 * everything it imports is in the plan route's chunk: the launch dialog comes
 * through `run-setup/lazy-launch-dialog`, the queue's words through
 * `./queue-words`, and `check-dist.mjs` asserts run-setup stays out.
 */
export { PHASE_GROUPS, displayState, groupOf, groupRows };
export type { GroupablePhase, PhaseGroupId };

/* ------------------------------------------------------------------------- *
 * The row, and what every row of one render shares
 * ------------------------------------------------------------------------- */

/** Which page the table is drawn on, and which reading of it. */
export type PhaseTableContext = 'run' | 'plan' | 'plan-qa' | 'plan-handoffs';

/** What every cell of one render shares — one object, handed to every row. */
interface TableScope {
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  /** The plan's own QA word — what a phase with no bullet of its own inherits. */
  planQaMode?: string;
  onRunAlone: (phase: number) => void;
  /** Opens the phase's L2 sheet, where the page mounts one (the plan page). */
  onInspect?: (phase: number) => void;
}

/** One row: a phase, and every fact this render knows about it. */
export interface PhaseTableRow {
  p: MergedPhase;
  scope: TableScope;
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
  /** INDEX.md's word for this phase — `missing` when a handoff exists and the index has no row. */
  index?: string | undefined;
}

/** A session of THIS run is open on the phase — the record's account AND the console's. */
const runningOf = (row: PhaseTableRow): boolean => {
  const r = row.p.record;
  return (
    row.scope.live &&
    Boolean(r?.startedAt) &&
    !r?.endedAt &&
    (r?.status === 'running' || r?.status === 'verifying')
  );
};

/** What the run has spent on the phase: the booked sessions plus the one in flight. */
const spendOf = (r: PhaseRecord | undefined): number | undefined => {
  if (!r) return undefined;
  const inflight = r.status === 'running' ? (r.live?.spentUsd ?? 0) : 0;
  const total = (r.costUsd ?? 0) + inflight;
  return total > 0 ? total : undefined;
};

/** The verdict word a QA filter tests: a recorded verdict, `pending`, or `none`. */
const qaWordOf = (p: PhaseView): string => {
  const result = p.qa?.result;
  return isVerdict(result) || result === 'pending' ? (result as string) : 'none';
};

const NEED_LABEL: Record<string, string> = Object.fromEntries(PHASE_GROUPS.map((g) => [g.id, g.label]));
const NEED_RANK: Record<string, number> = Object.fromEntries(PHASE_GROUPS.map((g, i) => [g.id, i]));
const needOf = (row: PhaseTableRow): PhaseGroupId =>
  groupOf({ phase: row.p.phase, state: row.p.state, ...(row.p.record ? { record: row.p.record } : {}) });

/* ------------------------------------------------------------------------- *
 * The columns — ONE array, for both pages
 * ------------------------------------------------------------------------- */

/**
 * Every column a phase has, as data.
 *
 * `priority` is what a column is worth when the box is too small for all of
 * them: `1` never leaves, and the rest fold into the row's detail smallest-
 * first. `value` is what a column MEANS — what its filter tests, its facet
 * counts and its group heading names; `cell` only draws it.
 *
 * ⚠️ One array serves the run page and every reading of the plan page — a
 * reading may HIDE columns (`PHASE_TABLE_CONTEXTS`), never define its own.
 * `phase-table.test.tsx` holds both pages to this array.
 */
export const PHASE_COLUMNS: Column<PhaseTableRow>[] = [
  // 68 holds the row's toggle and a three-digit number (this plan has 104
  // phases); the grid adds the room it reserved for the `+N` when columns fold.
  // A number never wraps: at 64 px, beside `+12`, `47` read as a 4 over a 7.
  {
    id: 'num',
    head: '#',
    priority: 1,
    min: 68,
    identity: true,
    card: 'hide',
    value: (row) => row.p.phase,
    cell: (row) => <span className="font-mono whitespace-nowrap tabular-nums">{pad2(row.p.phase)}</span>,
  },
  {
    id: 'phase',
    head: 'Phase',
    priority: 1,
    min: 220,
    flex: true,
    card: 'title',
    filter: 'text',
    value: (row) => `${row.p.phase} ${plainText(row.p.title)}`,
    cell: (row) => <TitleCell row={row} />,
  },
  {
    id: 'state',
    head: 'State',
    priority: 2,
    min: 184,
    card: 'meta',
    filter: 'facet',
    value: (row) => displayState(row.p.state, { running: runningOf(row) }),
    cell: (row) => <StateCell row={row} />,
  },
  {
    // The grouping by NEED — the five sections both pages always had, now a
    // column a person can group by, filter on, or read in a row's detail.
    id: 'need',
    head: 'Need',
    priority: 5,
    min: 104,
    card: 'hide',
    filter: 'facet',
    groupable: true,
    value: needOf,
    groupLabel: (value) => NEED_LABEL[String(value)] ?? String(value),
    groupOrder: (value) => NEED_RANK[String(value)] ?? PHASE_GROUPS.length,
    cell: (row) => NEED_LABEL[needOf(row)],
  },
  {
    id: 'blockedBy',
    head: 'Blocked by',
    priority: 3,
    min: 152,
    value: (row) => (row.p.blockedBy ?? []).map((b) => `P${b.phase} ${b.why}`).join(', ') || null,
    cell: (row) => <BlockedByCell row={row} />,
  },
  {
    id: 'scope',
    head: 'Scope',
    priority: 4,
    min: 124,
    filter: 'facet',
    groupable: true,
    value: (row) => scopeOf(row.p.row?.repos).join(' + '),
    cell: (row) => <ScopeChips tokens={scopeOf(row.p.row?.repos)} conflicts={row.conflicts} />,
  },
  {
    id: 'deps',
    head: 'Deps',
    priority: 4,
    min: 108,
    cell: (row) => <DepsCell slug={row.scope.slug} phase={row.p} max={3} />,
  },
  {
    id: 'lock',
    head: 'Lock',
    priority: 5,
    min: 112,
    cell: (row) => <LockCell lock={row.p.lock} compact />,
  },
  {
    id: 'size',
    head: 'Size',
    priority: 3,
    min: 92,
    filter: 'facet',
    value: (row) => row.p.size || null,
    cell: (row) => <SizeCell phase={row.p} eta={row.eta} />,
  },
  {
    // The lane and its attempt, on the labelled clock (#28) — never a bare
    // elapsed figure, and never `now - startedAt`, which counts parks as work.
    id: 'lane',
    head: 'Lane',
    priority: 2,
    min: 184,
    cell: (row) => <LaneCell row={row} />,
  },
  {
    id: 'run',
    head: 'This run',
    priority: 3,
    min: 136,
    value: (row) => row.p.record?.status ?? null,
    cell: (row) => <RunRecordCell row={row} />,
  },
  {
    id: 'qa',
    head: 'QA',
    priority: 3,
    min: 168,
    filter: 'facet',
    value: (row) => qaWordOf(row.p),
    cell: (row) => <QaCell row={row} />,
  },
  {
    id: 'handoff',
    head: 'Handoff',
    priority: 4,
    min: 132,
    filter: 'facet',
    value: (row) => row.p.handoff?.status ?? row.handoff?.status ?? 'none',
    cell: (row) => <HandoffCell row={row} />,
  },
  {
    id: 'gate',
    head: 'Gate',
    priority: 4,
    min: 108,
    filter: 'facet',
    value: (row) => (row.p.gated ? (row.p.gateKind ?? 'gated') : 'none'),
    cell: (row) => <GateCell row={row} />,
  },
  {
    id: 'spend',
    head: 'Spend',
    priority: 3,
    min: 84,
    align: 'end',
    filter: 'range',
    value: (row) => spendOf(row.p.record) ?? null,
    cell: (row) => <SpendCell row={row} />,
  },
  {
    id: 'turns',
    head: 'Turns',
    priority: 5,
    min: 68,
    align: 'end',
    value: (row) => row.p.record?.turns ?? null,
    cell: (row) => row.p.record?.turns ?? '—',
  },
  // 252 is measured, not guessed — the widest single remedy this table can draw
  // is `Pick up with a new agent` with its mechanism badge, which measures 249px.
  // Priority 2: on a phone the remedies move into the row's own detail, which
  // is one tap, rather than off the edge, which is nowhere.
  {
    id: 'actions',
    head: 'Actions',
    priority: 2,
    min: 252,
    cell: (row) => (
      <PhaseActions
        phase={row.p}
        slug={row.scope.slug}
        run={row.scope.run}
        live={row.scope.live}
        allowRun={row.scope.allowRun}
        onRunAlone={row.scope.onRunAlone}
        {...(row.scope.recovery ? { recovery: row.scope.recovery } : {})}
      />
    ),
  },
];

/**
 * The readings — one per page, three on the plan page — and the columns each
 * leads with. Everything a reading hides is still in each row's detail, and
 * the operator's own choice (the View sheet), stored under `tableId`, wins.
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
  // The QA and Handoffs readings open in PLAN ORDER: their subject is mostly
  // finished phases, which grouping by need would fold away under Done.
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
 * Past this many phases only a window of rows is drawn. Lower than the grid's
 * default because a phase row is a dozen chips, not a line of text: #26
 * measured a 72-phase plan, and every row of it was in the DOM twice over.
 */
export const PHASE_VIRTUAL_FROM = 40;

/** Done is folded until someone opens it — the one group nobody is looking for. */
const DONE_FOLDED: readonly string[] = ['need:done'];

const rowKey = (row: PhaseTableRow): string => String(row.p.phase);
const rowTint = (row: PhaseTableRow): string | undefined =>
  cn(runningOf(row) && 'bg-running/8', row.p.state === 'done' && 'text-ink-faint') || undefined;

export function PhaseTable({
  slug,
  run,
  planPhases,
  live,
  allowRun,
  recovery,
  queue,
  scopes,
  phaseEta,
  liveness,
  rulings,
  context = 'run',
  qaHeld,
  handoffs,
  index,
  onInspect,
}: {
  slug: string;
  run: RunState | null;
  planPhases: PhaseView[];
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  /** The admission queue, for the phases of this plan that are in it. */
  queue?: QueueEntry[] | undefined;
  /** Per-phase scope + what it would collide with if started now. */
  scopes?: PhaseScope[] | undefined;
  /** What each phase was expected to take. Absent on a source with no plan detail. */
  phaseEta?: PhaseEta[] | undefined;
  /** One entry per live lane (`RunDetail.liveness`). Absent on an older server. */
  liveness?: LaneLiveness[] | undefined;
  /** The plan's whole ruling ledger — counted per phase for the row badge. */
  rulings?: readonly Ruling[] | undefined;
  /** Which page, and which reading of it. */
  context?: PhaseTableContext;
  /** Which phases each recorded verdict holds (`PlanDetail.qaHeld`). */
  qaHeld?: Record<number, number[]> | undefined;
  /** The handoff files (`PlanDetail.handoffs`). */
  handoffs?: readonly HandoffRow[] | undefined;
  /** INDEX.md's rows (`PlanDetail.index`) — a handoff with no row here is `missing`. */
  index?: readonly { phase: number; status: string }[] | undefined;
  /** Opens the phase's L2 sheet, where the page mounts one. */
  onInspect?: (phase: number) => void;
}) {
  // "Run only this" opens the launch dialog on the row's phase; one dialog for
  // the table, keyed by which phase asked.
  const [launchPhase, setLaunchPhase] = useState<number | null>(null);
  // Written HERE, as JSX, so the render-tree guard (`plans/tabs.test.ts`) walks
  // into the detail from the table — a module-level arrow is invisible to it.
  const rowDetail = useCallback((row: PhaseTableRow): ReactNode => <PhaseRowDetail row={row} />, []);

  const rulingCounts = useMemo(() => {
    const out: Record<number, number> = {};
    for (const ruling of rulings ?? []) out[ruling.phase] = (out[ruling.phase] ?? 0) + 1;
    return out;
  }, [rulings]);

  const rows = useMemo(() => merge(planPhases, run), [planPhases, run]);
  const scope = useMemo<TableScope>(
    () => ({
      slug,
      run,
      live,
      allowRun,
      onRunAlone: setLaunchPhase,
      ...(recovery ? { recovery } : {}),
      ...(recovery?.qaMode ? { planQaMode: recovery.qaMode } : {}),
      ...(onInspect ? { onInspect } : {}),
    }),
    [slug, run, live, allowRun, recovery, onInspect],
  );
  const tableRows = useMemo<PhaseTableRow[]>(() => {
    const files = new Map((handoffs ?? []).map((h) => [h.phase, h]));
    const indexed = index ? new Map(index.map((r) => [r.phase, r.status])) : null;
    return rows.map((p) => {
      const file = files.get(p.phase);
      return {
        p,
        scope,
        entry: queueEntryFor(queue, slug, p.phase),
        conflicts: scopes?.find((s) => s.phase === p.phase)?.conflicts,
        eta: phaseEta?.find((e) => e.phase === p.phase),
        liveness: liveness?.find((l) => l.phase === p.phase),
        rulings: rulingCounts[p.phase] ?? 0,
        holds: qaHeld?.[p.phase] ?? p.qaHeld ?? [],
        handoff: file,
        index: indexed && file ? (indexed.get(p.phase) ?? 'missing') : undefined,
      };
    });
  }, [rows, scope, queue, slug, scopes, phaseEta, liveness, rulingCounts, qaHeld, handoffs, index]);

  if (!planPhases.length) {
    return (
      <Empty
        title="This plan has no phase graph"
        body="The autopilot drives phases from the plan's own graph table, so there is nothing here to run."
        action={
          <Button size="sm" variant="default" asChild>
            <a href={planHref(slug, 'source')}>Read the plan</a>
          </Button>
        }
      />
    );
  }

  const board = counts(rows);
  const asked = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const spent = rows.reduce((sum, r) => sum + (r.record?.costUsd ?? 0), 0);
  const reading = PHASE_TABLE_CONTEXTS[context];

  return (
    <Card>
      <CardHeader className="flex-wrap items-center">
        <CardTitle>Phases</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {ORDER.filter((state) => board[state]).map((state) => (
            <span key={state} className="flex items-center gap-1">
              <PhaseStatusBadge board={state as WordOf<'board'>} title={boardStateTitle(state)} />
              <b className="font-mono text-2xs tabular-nums">{board[state]}</b>
            </span>
          ))}
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-2 px-3 pt-2 pb-3">
        <p className="max-w-prose text-2xs text-ink-muted">
          Status is the plan’s own board, so a phase finished by any other session reads as finished here.
          {asked &&
            ` This run was asked for phase${asked.size === 1 ? '' : 's'} ${[...asked].join(', ')} only.`}
        </p>
        <DataTable
          label={reading.label}
          columns={PHASE_COLUMNS}
          rows={tableRows}
          getRowKey={rowKey}
          detail={rowDetail}
          rowClassName={rowTint}
          tableId={reading.tableId}
          toolbar
          {...(reading.groupBy ? { groupBy: reading.groupBy } : {})}
          defaultHidden={reading.hidden}
          defaultCollapsed={DONE_FOLDED}
          ungroupedLabel="Plan order"
          virtual
          virtualFrom={PHASE_VIRTUAL_FROM}
        />
        {spent > 0 && (
          <p className="text-2xs text-ink-faint">
            This run has spent <b className="font-mono tabular-nums">{money(spent)}</b> across{' '}
            {rows.filter((r) => r.record).length} phase(s) it touched.
          </p>
        )}
      </CardBody>

      {launchPhase != null && (
        <LaunchDialog
          request={{
            kind: 'phase',
            slug,
            phase: launchPhase,
            run,
            // The claim, so the dialog refuses rather than submitting into a
            // 409 the server would answer anyway.
            ...(() => {
              const lock = rows.find((r) => r.phase === launchPhase)?.lock;
              return lock ? { lock } : {};
            })(),
            ...(recovery?.qaMode ? { qaMode: recovery.qaMode } : {}),
            ...(recovery?.allowWrites !== undefined ? { allowWrites: recovery.allowWrites } : {}),
            ...(recovery?.planSkills?.length ? { planSkills: recovery.planSkills } : {}),
            ...(recovery?.planReviewers?.length ? { planReviewers: recovery.planReviewers } : {}),
          }}
          onClose={() => setLaunchPhase(null)}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------------- *
 * The cells
 * ------------------------------------------------------------------------- */

/** The phase's name, what it is for, and the two ways in: its page and its sheet. */
function TitleCell({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const title = plainText(p.title);
  const goal = p.goal ? plainText(p.goal) : '';
  return (
    <div className="min-w-0">
      <span className="flex min-w-0 items-baseline gap-2">
        <a
          className="min-w-0 truncate underline-offset-2 hover:underline"
          href={phaseHref(scope.slug, p.phase)}
          title={title}
        >
          {title}
        </a>
        {scope.onInspect && (
          <InspectButton onClick={() => scope.onInspect?.(p.phase)} label={`Inspect phase ${p.phase}`} />
        )}
      </span>
      {goal && (
        <span className="block truncate text-2xs text-ink-muted" title={goal}>
          {goal}
        </span>
      )}
      {(runningOf(row) || p.elsewhere) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {/* The row's own record, not the mirror pointer: with two lanes
              live, `activePhase` names only the lowest one. */}
          {runningOf(row) && <Badge tone="live">running now</Badge>}
          {p.elsewhere && (
            <span
              className="text-2xs text-ink-muted"
              title="The run record beside this is what this run did; the board is what is true now."
            >
              finished outside this run
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The state, with its two overlays — `gated` (a flag orthogonal to the bucket)
 * and `blocked` (a handoff that says so, or a review holding it) — and every
 * live fact about the lane on it.
 */
function StateCell({ row }: { row: PhaseTableRow }) {
  const { p, scope, liveness, entry, rulings } = row;
  const r = p.record;
  const showing = displayState(p.state, { running: runningOf(row) });
  // The record is what THIS run is doing; the entry is the scheduler's own view.
  const queued = r?.status === 'queued' || Boolean(entry);
  const hinted = hintedOf(scope.run, p.phase);
  const reviewHold = p.reviewHold ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {/* `p.live` decides the pulse and the link — the SERVER's one answer
            from the run record, the lock and the session registry, so two
            pages cannot disagree about whether a phase is running. */}
        <PhaseStateChip
          slug={scope.slug}
          phase={p.phase}
          state={showing}
          live={p.live}
          title={
            showing !== p.state
              ? `This run is working on phase ${p.phase} now. The board still reads ` +
                `"${p.state}" and catches up when the phase's handoff lands.`
              : undefined
          }
        />
        {p.gated && (
          // A gate is a wait the plan reserved for a person — the waiting tone;
          // the inbox, not the word, is what summons them (6.0).
          <Badge tone="wait" title={boardStateTitle('gated')}>
            gated
          </Badge>
        )}
        {(p.state === 'stuck' || reviewHold.length > 0) && (
          <Badge
            tone="bad"
            title={
              reviewHold.length
                ? `Changes were requested on P${reviewHold.join(', P')} — this console will not board the phase until that review is answered.`
                : 'Its handoff says blocked: a session stopped and asked for something only a person can settle.'
            }
          >
            blocked
          </Badge>
        )}
        {p.proof && <EvidenceLine proof={p.proof} />}
        <LivenessChip liveness={liveness} />
        <ContextChip liveness={liveness} />
        <RulingsChip count={rulings} />
        {/* Which branch THIS row's session commits on; absent means the run's own. */}
        <BranchChip branch={scope.run?.children?.[String(p.phase)]?.branch} base={scope.run?.base} />
        <LandChip land={p.land} />
        <LandingStateChip landing={r?.landing} />
        {/* What the SESSION says it is doing — moved by `run:progress`. */}
        <TaskLine tasks={r?.tasks} live={r?.live?.tasks} />
        {liveness && <LastActivity slug={scope.slug} phase={p.phase} />}
      </div>
      {/* "Queued" alone is a non-answer: what makes a wait bearable is WHAT it
          is behind. */}
      {queued && (
        <div className="mt-0.5">
          // Queued is a place in line: the queued paint's own quiet tone.
          <Badge
            tone="neutral"
            title={
              entry?.waitingOn.length
                ? entry.waitingOn
                    .map(
                      (h) =>
                        `${h.slug}${h.phase != null ? ` P${h.phase}` : ''}` +
                        (h.overlaps.length ? ` — overlaps ${h.overlaps.join(', ')}` : '') +
                        (h.unqualified ? ` — ${h.unqualified.reason}` : ''),
                    )
                    .join('\n')
                : 'Waiting on the scheduler for a scope something else is holding'
            }
          >
            {waitingLabel(entry)}
          </Badge>
        </div>
      )}
      {!queued && r?.serialBehind != null && (
        <div className="mt-0.5">
          <SerialChip behind={r.serialBehind} />
        </div>
      )}
      {!queued && hinted && (
        <div className="mt-0.5">
          <HintedChip hinted={hinted} />
        </div>
      )}
      {/* An operator's word on its place in the queue (control-tower phase 99,
          #135): read off the RECORD, so a bump or a hold shows whether or not
          the phase is queued right now — the whole sentence on hover. */}
      <QueueMarkChips marks={queueMarks(r?.queueControl)} />
      {/* The runner's last word, on the row: a verification failure or an MCP
          warning is not something to go looking for. The whole of it is in
          the row's detail. */}
      {(r?.verification && !r.verification.ok) || r?.note ? (
        <p
          className={cn(
            'mt-0.5 truncate text-2xs',
            r?.verification && !r.verification.ok ? 'text-failed' : 'text-ink-faint',
          )}
          title={r?.verification && !r.verification.ok ? r.verification.reason : r?.note}
        >
          {r?.verification && !r.verification.ok ? r.verification.reason : r?.note}
        </p>
      ) : null}
      {/* A red verdict says which tree it judged (#41, phase 24). */}
      {r?.verification && !r.verification.ok && verdictTree(r.verification) ? (
        <TreeLine tree={verdictTree(r.verification)!} className="truncate text-2xs" />
      ) : null}
    </>
  );
}

/** What holds the phase, in the engine's own words (`blockedBy`): `not-done`, `qa:<verdict>`. */
function BlockedByCell({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const by = p.blockedBy ?? [];
  if (!by.length) return <span className="text-ink-faint">—</span>;
  return (
    <ul className="flex flex-col gap-0.5 text-2xs">
      {by.map((b) => {
        const verdict = b.why.startsWith('qa:') ? b.why.slice(3) : null;
        return (
          <li key={`${b.phase}:${b.why}`} className="flex flex-wrap items-baseline gap-1">
            <a href={phaseHref(scope.slug, b.phase)} className="font-mono hover:underline">
              P{b.phase}
            </a>
            <code className="font-mono text-ink-muted">{b.why}</code>
            {/* HELD, not merely waiting: the dependency is done and its QA
                verdict is what stops this one (#27). */}
            {verdict && <span className="text-warn">held by its QA verdict</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The lane and its attempt, on the labelled clock (#28): the attempt clock the
 * row prints (`PHASE_ROW_CLOCK`), worked time once it has ended, and — while a
 * lane is live — which SILENCE it is in, for how long, against which
 * threshold. It ticks on its own clock; the anchors come from the record that
 * `run:progress` patches, so it asks the server for nothing.
 */
function LaneCell({ row }: { row: PhaseTableRow }) {
  const r = row.p.record;
  const running = runningOf(row);
  const now = useNow(running);
  if (!r) {
    return row.eta ? (
      <span
        className="text-2xs text-ink-muted"
        title={`An estimate for phase ${row.p.phase}, not a measurement.`}
      >
        {row.eta.label}
      </span>
    ) : (
      <span className="text-ink-faint">—</span>
    );
  }
  // The frame's windows when a frame has arrived — they know about an attempt
  // the last full read of the run did not.
  const windows = r.live?.phaseClocks?.attemptWindows;
  const clocks = phaseClocks(windows?.length ? { ...r, attemptWindows: windows } : r, now);
  const attemptMs = clocks[PHASE_ROW_CLOCK];
  return (
    <div className="flex flex-col gap-0.5 text-2xs" data-testid={`lane-${row.p.phase}`}>
      <span className="text-ink-muted">attempt {Math.max(1, r.attempts ?? 1)}</span>
      {attemptMs != null && (
        <span title="From the start of the latest attempt — every other clock is in the phase's drawer.">
          {PHASE_CLOCK_LABELS[PHASE_ROW_CLOCK]}{' '}
          <b className="font-mono font-normal tabular-nums">
            {running ? elapsed(attemptMs) : duration(attemptMs)}
          </b>
          {running && row.eta && clocks.workedMs != null && (
            <span className="text-ink-muted"> · {phaseProgress(clocks.workedMs, row.eta.estMs)}</span>
          )}
        </span>
      )}
      {!running && clocks.workedMs != null && clocks.workedMs !== attemptMs && (
        <span className="text-ink-muted">
          {PHASE_CLOCK_LABELS.workedMs} {duration(clocks.workedMs)}
        </span>
      )}
      <SilenceLine liveness={row.liveness} now={now} />
    </div>
  );
}

/** Which silence a live lane is in, since when, and what it is measured against. */
function SilenceLine({ liveness, now }: { liveness: LaneLiveness | undefined; now: number }) {
  const silence = liveness?.silence;
  if (!silence) return null;
  const quietMs = Math.max(0, now - silence.sinceMs);
  const over = quietMs >= silence.thresholdMs;
  return (
    <span
      className={over ? 'text-warn' : 'text-ink-muted'}
      data-testid="lane-silence"
      title={
        `${SILENCE_LABEL[silence.kind] ?? silence.kind} for ${duration(quietMs)}. ` +
        `The stall detector raises a card for this lane at ${duration(silence.thresholdMs)}` +
        (silence.graceMs ? `, and nudges it after a ${duration(silence.graceMs)} grace.` : '.')
      }
    >
      {SILENCE_LABEL[silence.kind] ?? silence.kind} {elapsed(quietMs)} · flagged at{' '}
      {duration(silence.thresholdMs)}
      {silence.graceMs ? ` (grace ${duration(silence.graceMs)})` : ''}
    </span>
  );
}

/** What THIS run recorded against the phase — its word, its model, its tries. */
function RunRecordCell({ row }: { row: PhaseTableRow }) {
  const r = row.p.record;
  if (!r) return <span className="text-2xs text-ink-faint">not attempted</span>;
  return (
    <div className="text-2xs">
      <PhaseStatusBadge
        record={r}
        title={phaseStatusTitle(r.status, r.lifecycle?.stop)}
        pulse={r.status === 'running'}
      />
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink-faint">
        <span className="inline-flex items-center gap-1 font-medium text-ink-muted">
          <Bot size={11} aria-hidden className="shrink-0" />
          {r.model ?? '—'}
        </span>
        {r.effort && (
          <span className="inline-flex items-center gap-1">
            <Gauge size={11} aria-hidden className="shrink-0" />
            {r.effort}
          </span>
        )}
        {r.attempts > 1 && <span>{r.attempts} tries</span>}
      </div>
      {fellOver(r) && (
        <div className="text-ink-faint" title="the session fell over to another model without restarting">
          ran on {r.actualModel}
        </div>
      )}
      {modelMismatch(r) && (
        <Badge
          tone="bad"
          className="mt-0.5"
          title="the phase is pinned to its model and the session started on another — it parked before spending"
        >
          model mismatch
        </Badge>
      )}
      {r.mcpCalls && Object.keys(r.mcpCalls).length > 0 && (
        <div className="truncate text-ink-faint" title={mcpCallList(r.mcpCalls)}>
          mcp {mcpCallList(r.mcpCalls)}
        </div>
      )}
    </div>
  );
}

/**
 * QA in one cell (#27): the verdict and its ROUND, linked to the report; what
 * the verdict holds; and the regime with the level that decided it — the
 * phase's own `QA:` bullet or the plan's line. Three states, never a bare word.
 */
function QaCell({ row }: { row: PhaseTableRow }) {
  const { p, scope, holds } = row;
  const mode = phaseQaMode(p, scope.planQaMode);
  const result = p.qa?.result;
  const rounds = p.qaRounds;
  return (
    <div className="flex flex-col gap-0.5 text-2xs" data-testid={`qa-${p.phase}`}>
      <span className="flex flex-wrap items-center gap-1">
        {isVerdict(result) ? (
          <a
            href={qaReportHref(scope.slug, p.phase, rounds?.latest.round)}
            className="rounded-sm"
            aria-label={`QA ${result} — open the report`}
          >
            <QaBadge result={result as WordOf<'qa-result'>} title={qaResultTitle(result!)} />
          </a>
        ) : (
          <span className="text-ink-muted">{result === 'pending' ? 'pending' : 'no verdict'}</span>
        )}
        {rounds && (
          <span
            className="font-mono text-ink-muted"
            title={`${rounds.count} round${rounds.count === 1 ? '' : 's'} on file — the latest is round ${rounds.latest.round} (${rounds.latest.result})`}
          >
            round {rounds.latest.round}
          </span>
        )}
        {holds.length > 0 && (
          <span className="text-warn" title={`This verdict holds P${holds.join(', P')} until it changes.`}>
            holds P{holds.join(', P')}
          </span>
        )}
      </span>
      <span className="text-ink-faint">
        <span className="font-mono">{mode ?? '—'}</span> ·{' '}
        {p.qaMode?.source === 'phase' ? 'phase directive' : 'plan'}
      </span>
    </div>
  );
}

/** The handoff: its word, when, and whether INDEX.md knows about it. */
function HandoffCell({ row }: { row: PhaseTableRow }) {
  const { p, scope, handoff, index } = row;
  const status = p.handoff?.status ?? handoff?.status;
  if (!status) return <span className="text-2xs text-ink-faint">none yet</span>;
  const completed = p.handoff?.completed ?? handoff?.completed;
  return (
    <div className="flex flex-col items-start gap-0.5 text-2xs">
      <a
        href={handoffHref(scope.slug, p.phase)}
        className="rounded-sm"
        aria-label={`Handoff ${status} — read it`}
      >
        <OpsBadge vocab="handoff" word={status as WordOf<'handoff'>} />
      </a>
      {completed && <span className="font-mono text-ink-faint">{completed}</span>}
      {index === 'missing' && (
        <Badge
          tone="neutral"
          title="INDEX.md has no row for this handoff. Re-running new-handoff.sh for the phase rebuilds it — or Repair with AI."
        >
          no index row
        </Badge>
      )}
    </div>
  );
}

/** Who can clear the phase's gate, and what it checks. */
function GateCell({ row }: { row: PhaseTableRow }) {
  const { p } = row;
  if (!p.gated) return <span className="text-ink-faint">—</span>;
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5 text-2xs">
      <Badge tone="wait" title={p.gates ?? boardStateTitle('gated')}>
        {p.gateKind && p.gateKind !== 'none' ? `${p.gateKind} gate` : 'gated'}
      </Badge>
      {p.gateCheck && (
        <span className="max-w-full truncate text-ink-faint" title={p.gateCheck}>
          {p.gateCheck}
        </span>
      )}
    </span>
  );
}

/** Dollars, the session in flight included — `run:progress` moves it. */
function SpendCell({ row }: { row: PhaseTableRow }) {
  const r = row.p.record;
  const spend = spendOf(r);
  if (spend == null) return <span className="text-ink-faint">—</span>;
  const inflight = r?.status === 'running' ? r.live?.spentUsd : undefined;
  return (
    <span
      className="font-mono tabular-nums"
      title={
        inflight ? `Includes ${money(inflight)} for the session in flight — booked when it ends.` : undefined
      }
    >
      {money(spend)}
    </span>
  );
}

/** Which attached servers a phase actually reached for, and how often. */
function mcpCallList(calls: Record<string, number>): string {
  return Object.entries(calls)
    .map(([id, count]) => `${id} ×${count}`)
    .join(' · ');
}

/* ------------------------------------------------------------------------- *
 * The row's detail — one press from the row
 * ------------------------------------------------------------------------- */

/**
 * Everything about one phase that a column does not carry: the runner's own
 * notes in full, the drawer (why it is not done, its QA, its gate, its
 * rulings), the handoff's facts, and the phase's prose — which is fetched
 * here, on open, by `PhaseProse`, so no view of the table pays for it.
 */
function PhaseRowDetail({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const r = p.record;
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {r?.note && <div className="text-2xs text-ink-faint">{r.note}</div>}
      {r?.status === 'waiting' && <WaitDetail r={r} />}
      {r?.verification && (
        <div className={cn('text-2xs', r.verification.ok ? 'text-done' : 'text-failed')}>
          {r.verification.reason}
          {verdictTree(r.verification) && <TreeLine tree={verdictTree(r.verification)!} />}
        </div>
      )}
      {r?.verification?.notRun?.length ? (
        <details>
          <summary className="cursor-pointer text-2xs">
            {r.verification.notRun.length} step(s) a person must check
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
            {r.verification.notRun.map((n, i) => (
              <li key={i}>
                <code className="font-mono">{n.text}</code> — {n.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {r?.preflight?.length ? (
        <details>
          <summary className="cursor-pointer text-2xs text-needs-you">
            {r.preflight.length} verification warning{r.preflight.length === 1 ? '' : 's'} from boarding
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
            {r.preflight.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {r?.mcpDegraded?.length ? (
        <p className="text-2xs text-needs-you">
          Ran without {r.mcpDegraded.map((d) => `${d.id} (${d.detail ?? MCP_REASON[d.reason]})`).join(', ')}
          {' — '}the session was told to record what it could not do.
        </p>
      ) : null}
      {r?.mcpPark && r.status === 'parked' ? <McpParkNote park={r.mcpPark} /> : null}
      <PhaseDrawer
        slug={scope.slug}
        phase={p.phase}
        run={scope.run}
        view={p}
        holds={row.holds}
        {...(scope.planQaMode ? { planQaMode: scope.planQaMode } : {})}
        {...(scope.recovery?.planSkills ? { planSkills: scope.recovery.planSkills } : {})}
      />
      <HandoffFacts row={row} />
      <div className="max-w-prose">
        <PhaseProse slug={scope.slug} phase={p} eta={row.eta} />
      </div>
    </div>
  );
}

/** The handoff file's own facts — what the Handoffs tab's row carried. */
function HandoffFacts({ row }: { row: PhaseTableRow }) {
  const { p, scope, handoff, index } = row;
  if (!handoff && !p.handoff) return null;
  const skills = handoff?.skillsUsed ?? p.handoff?.skillsUsed ?? [];
  return (
    <p className="text-2xs text-ink-muted" data-testid={`handoff-facts-${p.phase}`}>
      <a href={handoffHref(scope.slug, p.phase)} className="text-action hover:underline">
        Read the handoff
      </a>
      {handoff?.title ? ` — ${handoff.title}` : ''}
      {handoff ? ` · ${Math.round(handoff.bytes / 1024)}K` : ''}
      {skills.length ? ` · skills ${skills.join(', ')}` : ''}
      {index ? ` · INDEX.md ${index === 'missing' ? 'has no row' : `reads ${index}`}` : ''}
    </p>
  );
}

/**
 * Every remedy this row offers, in one renderer.
 *
 * Its own component because the row is drawn twice: as a table cell on a
 * desktop and inside a card on a phone. The buttons are the whole point of both
 * — a phone rendering that folded the Actions column away would be a list of
 * phases you can read and not act on — so the arrangement lives here rather
 * than in either shape.
 */
function PhaseActions({
  phase: p,
  slug,
  run,
  live,
  allowRun,
  recovery,
  onRunAlone,
}: {
  phase: MergedPhase;
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  onRunAlone: (phase: number) => void;
}) {
  const r = p.record;
  // Gated on the BOARD, never on the run record. Offering to run a phase the
  // board calls done is the defect this table was rebuilt for.
  const can = actionsFor(p, { live, allowRun });

  // What the two start-work buttons would have offered if nothing held the
  // phase — so they can be rendered disabled rather than disappearing.
  const blockedRunAlone = Boolean(can.heldBy) && !live && p.state === 'ready' && allowRun;
  const blockedRetry =
    Boolean(can.heldBy) && !live && ['failed', 'interrupted', 'parked', 'gated'].includes(r?.status ?? '');
  const heldTitle = can.heldBy
    ? `Phase ${p.phase} is claimed by ${can.heldBy.owner}` +
      (can.heldBy.host ? ` on ${can.heldBy.host}` : '') +
      `${can.heldBy.leaseUntil ? ` — the lease runs ${countdown(can.heldBy.leaseUntil)} more` : ''}.` +
      ' Release the claim to start a session here.'
    : undefined;

  // A recovery is offered for a phase that is genuinely stuck — never for one
  // the BOARD calls done, however this run's record reads, and never while the
  // run is live (the autopilot owns the tree, and the server refuses anyway).
  // A stuck phase (its handoff says blocked) often has NO record on this run —
  // the work happened in another session — so the board state is the fallback
  // fact when the record has nothing to say.
  const recoveryClass =
    recovery && !live && p.state !== 'done'
      ? ((r ? classifyPhase(r.status, run, { authFailure: recovery.authFailure ?? false }) : undefined) ??
        classifyBoardPhase(p.state))
      : undefined;
  const recovering = liveRecovery(recovery?.sessions, { slug, phase: p.phase });
  const reviewing = liveQa(recovery?.sessions, { slug, phase: p.phase });

  // `min-w-0` on the wrapper AND on what it wraps: a nested flex row whose
  // parent has an auto min-width cannot shrink below its widest child, so the
  // buttons refused to wrap and left the column.
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 [&_*]:min-w-0">
      {/* The one thing a failed-HERE-finished-ELSEWHERE row still owes:
            the statement that nothing needs fixing. A red chip beside an
            empty actions cell read as a dead end (reported live). */}
      {p.elsewhere && r && ['failed', 'interrupted', 'parked', 'gated'].includes(r.status) && (
        <span
          className="text-2xs text-ink-faint"
          title={
            "This run's own attempt stopped" +
            (r.note ? ` (${r.note.slice(0, 160)})` : '') +
            ' — but the phase was finished and verified outside it, and the board reads done.' +
            ' There is nothing to fix; Why? opens what failed here.'
          }
        >
          nothing to fix — done elsewhere
        </span>
      )}
      {/* Every remedy on this row comes from the ONE renderer. It used to
            hand-roll Retry and Skip beside a diagnosis panel that offered
            the same two under different words, disabled by different rules
            — which is how a claimed phase could show a live Retry here and
            a greyed one there. `recoveryActionsFor` decides; the lock is
            passed in so the model can disable-with-reason rather than hide,
            the rule this table's Lock column exists for. */}
      {(can.retry || can.skip || (blockedRetry && allowRun)) && (
        <RecoveryActions
          target={{ slug, phase: p.phase, ...(run?.id ? { runId: run.id } : {}) }}
          ctx={{
            boardState: p.state,
            ...(run ? { run } : {}),
            // `resumable` here means "there is a checkpointed session to
            // pick up", which on a RECORD is exactly `resumeSessionId`.
            ...(r ? { record: { status: r.status, resumable: Boolean(r.resumeSessionId) } } : {}),
            ...(can.heldBy
              ? { lock: { holder: can.heldBy.owner, expired: Boolean(can.heldBy.expired) } }
              : {}),
          }}
          max={2}
        />
      )}
      {(can.runAlone || blockedRunAlone) && (
        <Button
          size="sm"
          disabled={!can.runAlone}
          title={
            can.runAlone
              ? 'Run this phase on its own, then stop — the loop does not carry on into the rest of the plan'
              : heldTitle
          }
          onClick={() => onRunAlone(p.phase)}
        >
          Run only this
        </Button>
      )}
      {/* The way out, right where the refusal is. Releasing a live claim
            is the operator's decision and asks for it explicitly. */}
      {can.heldBy && allowRun && <ForceReleaseButton slug={slug} phase={p.phase} lock={can.heldBy} />}
      {/* Last, and only when a rule cannot settle it. Retry re-runs the
            phase unchanged and Skip abandons it; this is the middle that
            was missing — read the evidence, fix the cause, finish. */}
      {recoveryClass && recovery && (
        <RecoveryButton
          kind={recoveryClass}
          allowAgent={recovery.allowAgent}
          {...(recovering ? { runningSessionId: recovering.id } : {})}
          target={{ slug, phase: p.phase, ...(run?.id ? { runId: run.id } : {}) }}
        />
      )}
      {/* Reviewing is not recovering: it is offered for a phase that is
            FINE, which is why it survives the `p.state !== 'done'` gate
            above. Never while the run is live — the autopilot owns the tree
            and the server refuses anyway. */}
      {recovery && !live && canQa(p.state) && (
        <QaButton
          label="QA"
          target={{
            slug,
            phase: p.phase,
            title: p.title,
            model: p.model,
            effort: p.effort,
            // THIS phase's regime where the server says it, the plan's otherwise.
            ...(phaseQaMode(p, recovery.qaMode) ? { qaMode: phaseQaMode(p, recovery.qaMode) } : {}),
            ...(p.qa ? { qa: p.qa } : {}),
            planSkills: recovery.planSkills ?? [],
          }}
          allowAgent={recovery.allowAgent}
          allowWrites={recovery.allowWrites}
          {...(reviewing ? { runningSessionId: reviewing.id } : {})}
        />
      )}
    </div>
  );
}

/**
 * A waiting phase's park, on its row: whose park it is, why, when the runner
 * resumes it — as a countdown that moves — and what each watched ref's last
 * probe found and when (control-tower phase 88, #148). The bare list of refs
 * could not say whether anything was still looking, and a clock time with no
 * day and no countdown read as a pause.
 *
 * It ticks on its own, every 30 s: a waiting run has no live lane, so the
 * table's own clock stands still.
 */
function WaitDetail({ r }: { r: PhaseRecord }) {
  useNow(true, 30_000);
  const until = r.parkedUntil ? Date.parse(r.parkedUntil) : NaN;
  const clock = Number.isFinite(until)
    ? new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const rows = r.watchState?.refs ?? [];
  // The declared refs first, in their order; a ref the console minted beside
  // them is shown too, and marked, so it is never read as the session's.
  const refs = [
    ...(r.watch ?? []),
    ...rows.filter((row) => row.minted && !(r.watch ?? []).includes(row.ref)).map((row) => row.ref),
  ];
  const probe = (ref: string): string => {
    const row = rows.find((w) => w.ref === ref);
    if (!row) return 'not checked yet';
    const found = row.state === 'refused' && row.detail ? `refused: ${row.detail}` : row.state;
    return `${found} · checked ${relativeTime(Date.parse(row.checkedAt))}${row.minted ? ' · the console’s' : ''}`;
  };
  return (
    <div className="text-2xs text-ink-faint">
      {/* Whose park it is, first: the console's own inference is never drawn
          as the session's testimony. */}
      {r.declared?.by === 'watchdog'
        ? 'Parked by the console — it was waiting inside its turn'
        : 'Waiting on external work'}
      {r.parkReason ? `: ${r.parkReason}` : ''}
      {clock
        ? until > Date.now()
          ? ` — resumes ${clock} (${countdown(until)})`
          : ` — was due to resume at ${clock}`
        : ''}
      {r.declared?.by === 'watchdog'
        ? r.watchdogParks
          ? ` (automatic park ${r.watchdogParks})`
          : ''
        : r.waits
          ? ` (wait ${r.waits})`
          : ''}
      {r.resumeRefused
        ? ` · resume held: session ${r.resumeRefused.sessionId.slice(0, 8)} is still running`
        : ''}
      {refs.length ? (
        <>
          {' '}
          · watching{' '}
          {refs.map((ref, i) => (
            <Fragment key={ref}>
              {i > 0 ? ', ' : null}
              {/* Paths, and a watch list is as long as the phase made it.
                  `inline-block` gives a `truncate` a box to truncate against
                  inside a sentence. */}
              <code className="inline-block max-w-full truncate align-bottom font-mono" title={ref}>
                {ref}
              </code>{' '}
              ({probe(ref)})
            </Fragment>
          ))}
        </>
      ) : null}
      {/* A ref nothing will ever probe is named beside the ones that will be,
          never dropped in silence (WAI-11). */}
      {r.watchUnpollable?.length ? (
        <>
          {' '}
          · not watchable{' '}
          <code
            className="inline-block max-w-full truncate align-bottom font-mono"
            title={r.watchUnpollable.map((u) => `${u.ref} — ${u.reason}`).join('\n')}
          >
            {r.watchUnpollable.map((u) => u.ref).join(', ')}
          </code>
        </>
      ) : null}
    </div>
  );
}

/**
 * A `require` MCP park on its clock: when it parked, on which servers, and
 * when the phase continues without them (`mcpRequireTimeoutMs`, a console
 * preference; 0 means it waits for the server to heal, however long).
 */
function McpParkNote({ park }: { park: NonNullable<PhaseRecord['mcpPark']> }) {
  const { data: state } = useConsoleState();
  const timeoutMs =
    typeof state?.prefs?.mcpRequireTimeoutMs === 'number' ? state.prefs.mcpRequireTimeoutMs : 1_800_000;
  const since = Date.parse(park.at);
  const servers = park.degraded.map((d) => d.id).join(', ') || 'an MCP server';
  const due = timeoutMs > 0 && Number.isFinite(since) ? new Date(since + timeoutMs) : null;
  return (
    <p className="mt-1 text-2xs text-needs-you" data-testid="mcp-park">
      Parked on {servers} since {Number.isFinite(since) ? new Date(since).toLocaleTimeString() : park.at}
      {due
        ? ` — continues without ${park.degraded.length === 1 ? 'it' : 'them'} at ${due.toLocaleTimeString()} unless the server heals first (an errand is recorded then).`
        : ' — waits for the server to heal; no timeout is set (Settings ▸ Automation).'}
    </p>
  );
}

/**
 * A phase a re-board asked for that no lane or queue entry holds yet
 * (control-tower phase 86, #128 #114) — with the hint's time, because that
 * time IS its seniority: it boards at the next free lane ahead of every phase
 * that never started. Read through `hintedPhases`, the reader `/api/queue`
 * uses, so a stopped run — which boards nothing — names none.
 */
function HintedChip({ hinted }: { hinted: HintedPhase }) {
  return (
    <Badge
      tone="wait"
      title={`A re-board (${hinted.rung}${hinted.by ? `, by ${hinted.by}` : ''}) asked for this phase at ${hinted.since}. It boards at the next free lane, by seniority — ahead of phases that never started.`}
    >
      hinted since {hinted.since.slice(11, 16)}Z
    </Badge>
  );
}

/**
 * The marks an operator left on this phase's place in the queue — moved ahead,
 * held, deferred, withdrawn (control-tower phase 99, #135). The chip is the
 * word; its title is who said it, and why.
 */
function QueueMarkChips({ marks }: { marks: ReturnType<typeof queueMarks> }) {
  if (!marks.length) return null;
  return (
    <div className="mt-0.5 flex flex-wrap gap-1">
      {marks.map((mark) => (
        // An operator's mark on the queue, never a summons: moved ahead reads
        // live, the rest (held, deferred, withdrawn) wait.
        <Badge
          key={mark.key}
          tone={mark.key === 'bump' ? 'live' : 'wait'}
          title={mark.text}
          data-testid={`queue-mark-${mark.key}`}
        >
          {mark.label}
        </Badge>
      ))}
    </div>
  );
}

/** This phase's row in `hintedPhases(run)`, or undefined. */
function hintedOf(run: RunState | null, phase: number): HintedPhase | undefined {
  return hintedPhases(run).find((row) => row.phase === phase);
}

/**
 * A ready phase behind a live lane of its OWN run in the same checkout
 * (control-tower phase 60, #64): serial work, not a queue — it never waits on
 * anybody else, and boards the moment that lane ends.
 */
function SerialChip({ behind }: { behind: number }) {
  return (
    <Badge
      tone="wait"
      title={`Phase ${behind} of this run is working in the same checkout. This phase starts when it ends — it is not waiting on anyone else.`}
    >
      behind this run’s P{behind}
    </Badge>
  );
}
