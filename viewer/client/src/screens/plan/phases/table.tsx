/**
 * The phases grid — where a plan is up to, and what may still be done to each
 * phase (7.0, quiet-console phase 10).
 *
 * ONE column array (`PHASE_COLUMNS`) serves the plan's Phases view and the Run
 * view: a context only marks the columns it does not lead with as Everything
 * columns (`columnsFor`), so they fold into the row's detail at the glance and
 * stand as columns with the page's Everything on — never a second definition
 * of a column (`table.test.tsx` holds every context to this array).
 *
 * A row is one line at the glance (design.md principle 2): the phase on its
 * station — the line's spine runs down the identity column — its state as a
 * dot and a word with the overlays said in words, what holds it in the
 * engine's own words, its scope, size and estimate, the lane on its labelled
 * clock, QA, the handoff, the gate, the spend and ONE action. Everything else
 * is a press away: the row opens in place onto its drawer (why it is not done,
 * its QA, its clocks, every verb), and Inspect puts the phase in the panel
 * with its eight sections.
 *
 * The rows group by NEED (needs-you first, Done folded), by plan order or by
 * scope; past `PHASE_VIRTUAL_FROM` rows only a window is drawn. The cells that
 * move while a lane works read the run query `run:progress` patches in place
 * and tick on a clock of their own — no request per frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PHASE_CLOCK_LABELS, PHASE_ROW_CLOCK, phaseClocks } from '@shared/phase-clocks.js';
import { SILENCE_LABELS } from '@shared/attention-model.js';
import type {
  HandoffRow,
  LaneLiveness,
  PhaseEta,
  PhaseScope,
  PhaseView,
  QueueEntry,
  Ruling,
  RunState,
} from '@/data/api';
import { queueEntryFor, queueMarks, waitingLabel } from '@/data/queue-words';
import { useLockRelease } from '@/data/plans';
import { cn } from '@/lib/cn';
import { useNow } from '@/lib/clock';
import { countdown, duration, elapsed, pad2, plural } from '@/lib/format';
import { canQa, isVerdict, liveQa, phaseQaMode, qaReportHref } from '@/lib/qa';
import { classifyBoardPhase, classifyPhase, liveRecovery } from '@/lib/recovery';
import { boardStateTitle, phaseStatusTitle, qaResultTitle } from '@/lib/status-vocab';
import { Button, Empty, Money } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import type { Everything } from '@/ui/everything';
import { OpsStatus, PhaseStatus, QaStatus, type WordOf } from '@/ui/status';
import { plainText } from '@/ui/markdown';
import { RecoveryActions } from '@/cards/recovery-actions';
import { TreeLine, verdictTree } from '@/cards/verify-tree';
import { LaunchDoor } from '@/screens/launch/door';
import { useInspected } from '@/shell/panel/inspector-host';
import { handoffHref, phaseHref, planHref } from '@/shell/routes';
import { ACCOUNT_RECOVERY_PARTS } from '@/screens/settings/account-row';
import { RecoveryButton } from './recovery-button';
import { LastActivity } from '../run/activity';
import { DepsCell, LockCell, ScopeWords, SizeCell, scopeTokens } from './cells';
import { PhaseDrawer } from './drawer';
import {
  BOARD_WORDS,
  DONE_FOLDED,
  NEED_LABEL,
  NEED_RANK,
  PHASE_GROUPS,
  PHASE_TABLE_CONTEXTS,
  PHASE_VIRTUAL_FROM,
  actionsOf,
  countBoard,
  displayState,
  fellOver,
  hintedOf,
  mcpCallWords,
  mergeBoard,
  modelMismatch,
  needOf,
  qaWordOf,
  runningOf,
  spendOf,
  type MergedPhase,
  type PhaseRecovery,
  type PhaseTableContext,
  type PhaseTableRow,
  type PhaseTableScope,
} from './model';
import { inspectPhase, phaseInspectKey } from './inspector';
import { QaButton } from './qa-launcher';
import {
  BranchWords,
  ContextWords,
  EvidenceWords,
  LandWords,
  LandingWords,
  LivenessWords,
  PhaseMark,
  RulingsCount,
  TaskWords,
} from './row';
import './phases.css';

const SILENCE_LABEL = SILENCE_LABELS as Readonly<Record<string, string>>;

/* ------------------------------------------------------------------------- *
 * The columns — ONE array, for both pages
 * ------------------------------------------------------------------------- */

/**
 * Every column a phase has, as data. `min` is measured against the widest
 * real content; `priority` is what a column is worth when the box is too small
 * (`1` never leaves); `value` is what the column MEANS — what its filter
 * tests, its facet counts and its group heading names.
 */
export const PHASE_COLUMNS: readonly Column<PhaseTableRow>[] = [
  {
    // The identity: the phase on its station, its name — the row's link, to
    // the phase's page — and the way into the panel. 260 holds "07" and a
    // two-word title beside Inspect before the title wraps.
    id: 'phase',
    head: 'Phase',
    priority: 1,
    min: 260,
    flex: true,
    identity: true,
    card: 'title',
    filter: 'text',
    value: (row) => `${row.p.phase} ${plainText(row.p.title)}`,
    cell: (row) => <IdentityCell row={row} />,
  },
  {
    id: 'state',
    head: 'State',
    priority: 1,
    min: 216,
    card: 'meta',
    filter: 'facet',
    value: (row) => displayState(row.p.state, { running: runningOf(row) }),
    cell: (row) => <StateCell row={row} />,
  },
  {
    // The need: the five groups both pages always had, as a column a person
    // can group by, filter on, or read in a row's detail.
    id: 'need',
    head: 'Need',
    priority: 5,
    min: 104,
    everything: true,
    filter: 'facet',
    groupable: true,
    value: needOf,
    groupLabel: (value) => NEED_LABEL[String(value)] ?? String(value),
    groupOrder: (value) => NEED_RANK[String(value)] ?? PHASE_GROUPS.length,
    cell: (row) => <span className="text-meta text-ink">{NEED_LABEL[needOf(row)]}</span>,
  },
  {
    id: 'blockedBy',
    head: 'Blocked by',
    priority: 3,
    min: 176,
    value: (row) => (row.p.blockedBy ?? []).map((b) => `P${b.phase} ${b.why}`).join(', ') || null,
    cell: (row) => <BlockedByCell row={row} />,
  },
  {
    id: 'scope',
    head: 'Scope',
    priority: 4,
    min: 136,
    filter: 'facet',
    groupable: true,
    value: (row) => scopeTokens(row.p.row?.repos).join(' + '),
    cell: (row) => <ScopeWords tokens={scopeTokens(row.p.row?.repos)} conflicts={row.conflicts} />,
  },
  {
    id: 'deps',
    head: 'Depends on',
    priority: 4,
    min: 128,
    cell: (row) => <DepsCell slug={row.scope.slug} phase={row.p} max={3} />,
  },
  {
    id: 'lock',
    head: 'Claim',
    priority: 5,
    min: 132,
    cell: (row) => <LockCell lock={row.p.lock} compact />,
  },
  {
    id: 'size',
    head: 'Size',
    priority: 3,
    min: 88,
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
    min: 196,
    card: 'meta',
    cell: (row) => <LaneCell row={row} />,
  },
  {
    id: 'run',
    head: 'This run',
    priority: 3,
    min: 156,
    value: (row) => row.p.record?.status ?? null,
    cell: (row) => <RunRecordCell row={row} />,
  },
  {
    id: 'qa',
    head: 'QA',
    priority: 3,
    min: 176,
    filter: 'facet',
    value: (row) => qaWordOf(row.p),
    cell: (row) => <QaCell row={row} />,
  },
  {
    id: 'handoff',
    head: 'Handoff',
    priority: 4,
    min: 148,
    filter: 'facet',
    value: (row) => row.p.handoff?.status ?? row.handoff?.status ?? 'none',
    cell: (row) => <HandoffCell row={row} />,
  },
  {
    id: 'gate',
    head: 'Gate',
    priority: 4,
    min: 128,
    filter: 'facet',
    value: (row) => (row.p.gated ? (row.p.gateKind ?? 'gated') : 'none'),
    cell: (row) => <GateCell row={row} />,
  },
  {
    id: 'spend',
    head: 'Spend',
    priority: 3,
    min: 88,
    align: 'end',
    filter: 'range',
    value: (row) => spendOf(row.p.record) ?? null,
    cell: (row) => <SpendCell row={row} />,
  },
  {
    id: 'turns',
    head: 'Turns',
    priority: 5,
    min: 72,
    align: 'end',
    value: (row) => row.p.record?.turns ?? null,
    cell: (row) => <span className="text-meta tabular-nums">{row.p.record?.turns ?? '—'}</span>,
  },
  {
    // The row's ONE act — the recommended way forward, or Run only this. Every
    // other verb is in the row's detail and the panel's Actions. 232 holds the
    // widest single verb ("Run only this" beside a disabled reason, a remedy
    // with its mechanism word).
    id: 'actions',
    head: 'Action',
    priority: 2,
    // The widest single remedy, `Pick up with a new agent` with its mechanism
    // badge, measures 249px; the group wraps, one item cannot.
    min: 252,
    card: 'action',
    cell: (row) => <ActionCell row={row} />,
  },
];

/**
 * A context's columns: the ONE array, with the columns this reading does not
 * lead with marked as Everything columns — folded into the row's detail at the
 * glance, columns again with Everything on. Never a column of its own.
 */
export function columnsFor(context: PhaseTableContext): Column<PhaseTableRow>[] {
  const hidden = new Set(PHASE_TABLE_CONTEXTS[context].hidden);
  return PHASE_COLUMNS.map((column) =>
    hidden.has(column.id) && !column.identity ? { ...column, everything: true as const } : column,
  );
}

const COLUMNS_BY_CONTEXT: Record<PhaseTableContext, Column<PhaseTableRow>[]> = {
  run: columnsFor('run'),
  plan: columnsFor('plan'),
  'plan-qa': columnsFor('plan-qa'),
  'plan-handoffs': columnsFor('plan-handoffs'),
};

const rowKey = (row: PhaseTableRow): string => String(row.p.phase);
// No `rowHref`: the identity cell carries the phase's link AND Inspect, and the
// grid would wrap both in a second `<a>` — a link inside a link, a button
// inside a link.
const rowProps = (row: PhaseTableRow): Record<string, unknown> => ({
  'data-phase': row.p.phase,
  'data-state': displayState(row.p.state, { running: runningOf(row) }),
});
const rowTint = (row: PhaseTableRow): string | undefined =>
  row.p.state === 'done' && !runningOf(row) ? 'text-ink-muted' : undefined;

/* ------------------------------------------------------------------------- *
 * The grid
 * ------------------------------------------------------------------------- */

export interface PhaseTableProps {
  slug: string;
  run: RunState | null;
  planPhases: PhaseView[];
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  /** The admission queue, for the phases of this plan that are in it. */
  queue?: QueueEntry[] | undefined;
  /** Per-phase scope and what it would collide with if started now. */
  scopes?: PhaseScope[] | undefined;
  /** What each phase was expected to take. */
  phaseEta?: PhaseEta[] | undefined;
  /** One entry per live lane (`RunDetail.liveness`). */
  liveness?: LaneLiveness[] | undefined;
  /** The plan's whole ruling ledger — counted per phase. */
  rulings?: readonly Ruling[] | undefined;
  /** Which page, and which reading of it. */
  context?: PhaseTableContext;
  /** Which phases each recorded verdict holds (`PlanDetail.qaHeld`). */
  qaHeld?: Record<number, number[]> | undefined;
  /** The handoff files (`PlanDetail.handoffs`). */
  handoffs?: readonly HandoffRow[] | undefined;
  /** INDEX.md's rows — a handoff with no row here is `missing`. */
  index?: readonly { phase: number; status: string }[] | undefined;
  /** Offer Inspect on every row — the plan page's panel; the phase on show stays live there. */
  inspectable?: boolean;
  /** The page's Everything — its switch draws in the grid's toolbar. */
  everything?: Everything | boolean;
}

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
  inspectable = false,
  everything,
}: PhaseTableProps) {
  // "Run only this" opens the launch form on the row's phase; one form for the
  // grid, keyed by which phase asked.
  const [launchPhase, setLaunchPhase] = useState<number | null>(null);
  // Written HERE, as JSX, so the render-tree guard (`tabs.test.ts`) walks into
  // the detail from the grid — a module-level arrow is invisible to it.
  const rowDetail = useCallback((row: PhaseTableRow): ReactNode => <PhaseRowDetail row={row} />, []);

  const rulingCounts = useMemo(() => {
    const out: Record<number, number> = {};
    for (const ruling of rulings ?? []) out[ruling.phase] = (out[ruling.phase] ?? 0) + 1;
    return out;
  }, [rulings]);

  const rows = useMemo(() => mergeBoard(planPhases, run), [planPhases, run]);
  // Inspect reads the row as it stands at the press, through a ref the rows
  // below refresh — so the scope every row shares does not change per tick.
  const byPhaseRef = useRef<Map<number, PhaseTableRow>>(new Map());
  const onInspect = useCallback((phase: number) => {
    const row = byPhaseRef.current.get(phase);
    if (row) inspectPhase(row);
  }, []);
  const scope = useMemo<PhaseTableScope>(
    () => ({
      slug,
      run,
      live,
      allowRun,
      onRunAlone: setLaunchPhase,
      ...(recovery ? { recovery } : {}),
      ...(recovery?.qaMode ? { planQaMode: recovery.qaMode } : {}),
      ...(inspectable ? { onInspect } : {}),
    }),
    [slug, run, live, allowRun, recovery, inspectable, onInspect],
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
  const byPhase = useMemo(() => new Map(tableRows.map((row) => [row.p.phase, row])), [tableRows]);
  useEffect(() => {
    byPhaseRef.current = byPhase;
  }, [byPhase]);
  useLiveInspection(inspectable ? byPhase : null, slug);

  if (!planPhases.length) {
    return (
      <Empty
        title="This plan has no phase graph, so the autopilot has nothing to run."
        action={
          <Button size="sm" asChild>
            <a href={planHref(slug, 'source')}>Read the plan</a>
          </Button>
        }
      />
    );
  }

  const reading = PHASE_TABLE_CONTEXTS[context];
  const asked = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const spent = rows.reduce((sum, r) => sum + (r.record?.costUsd ?? 0), 0);
  const launching = launchPhase == null ? undefined : rows.find((r) => r.phase === launchPhase);

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={reading.label} data-testid="phase-table">
      <Grid
        label={reading.label}
        columns={COLUMNS_BY_CONTEXT[context]}
        rows={tableRows}
        getRowKey={rowKey}
        rowProps={rowProps}
        rowClassName={rowTint}
        detail={rowDetail}
        tableId={reading.tableId}
        toolbar
        {...(everything !== undefined ? { everything } : {})}
        {...(reading.groupBy ? { groupBy: reading.groupBy } : {})}
        defaultCollapsed={DONE_FOLDED}
        ungroupedLabel="Plan order"
        virtual
        virtualFrom={PHASE_VIRTUAL_FROM}
        summary={() => <BoardSentence rows={rows} asked={asked} />}
      />
      {spent > 0 && (
        <p className="text-meta text-ink-muted">
          This run has spent <Money usd={spent} /> across{' '}
          {plural(rows.filter((r) => r.record).length, 'phase')} it touched.
        </p>
      )}
      {launching && (
        <LaunchDoor
          request={{
            kind: 'phase',
            slug,
            phase: launching.phase,
            run,
            ...(launching.lock ? { lock: launching.lock } : {}),
            ...(recovery?.qaMode ? { qaMode: recovery.qaMode } : {}),
            ...(recovery?.allowWrites !== undefined ? { allowWrites: recovery.allowWrites } : {}),
            ...(recovery?.planSkills?.length ? { planSkills: recovery.planSkills } : {}),
            ...(recovery?.planReviewers?.length ? { planReviewers: recovery.planReviewers } : {}),
          }}
          onClose={() => setLaunchPhase(null)}
        />
      )}
    </section>
  );
}

/**
 * The phase on show in the panel moves as the board moves: every tick that
 * redraws the grid hands the panel the row's new reading, in place — the
 * panel's tab and scroll stay put, and a panel somebody closed stays closed.
 */
function useLiveInspection(rows: Map<number, PhaseTableRow> | null, slug: string): void {
  const key = useInspected()?.key;
  useEffect(() => {
    if (!rows || !key) return;
    for (const [phase, row] of rows) {
      if (phaseInspectKey(slug, phase) === key) {
        inspectPhase(row, { open: false });
        return;
      }
    }
  }, [rows, key, slug]);
}

/**
 * The board in one sentence above the rows: how many phases are in each word,
 * in the operator's order. The status is the plan's own board, so a phase any
 * other session finished reads as finished here.
 */
function BoardSentence({ rows, asked }: { rows: MergedPhase[]; asked: Set<number> | null }) {
  const board = countBoard(rows);
  const parts = BOARD_WORDS.filter((word) => board[word]).map((word) => (
    <span key={word} className="inline-flex items-center gap-1.5" data-board-count={word}>
      <PhaseStatus board={word as WordOf<'board'>} withNote={false} title={boardStateTitle(word)} />
      <span className="tabular-nums text-ink">{board[word]}</span>
    </span>
  ));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta" data-testid="board-counts">
      {parts}
      {asked && (
        <span className="text-ink-muted">
          This run was asked for {asked.size === 1 ? 'phase' : 'phases'} {[...asked].join(', ')} only.
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * The cells
 * ------------------------------------------------------------------------- */

/**
 * The phase on its station: the line's spine (a leg through the cell, the
 * dot in the phase's paint) beside its number, its name — the row's link —
 * and Inspect. The spine is decoration; the State column says the word.
 */
function IdentityCell({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const title = plainText(p.title);
  const goal = p.goal ? plainText(p.goal) : '';
  const showing = displayState(p.state, { running: runningOf(row) });
  // The hue comes from the status family's paint words (the ratchet reads `paint`).
  const paint = spinePaint(showing);
  return (
    <div className="phase-spine flex min-w-0 items-start gap-2" data-spine={showing}>
      <span aria-hidden className={cn('phase-spine-station', `state-${paint}`)} />
      <span className="mt-px shrink-0 text-meta text-ink-muted tabular-nums">{pad2(p.phase)}</span>
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <a
            className="min-w-0 break-words text-body text-ink underline-offset-2 hover:underline"
            href={phaseHref(scope.slug, p.phase)}
            title={title}
          >
            {title}
          </a>
          {scope.onInspect && (
            <Button
              size="sm"
              variant="ghost"
              className="h-auto shrink px-1 py-0 text-meta text-ink-muted"
              onClick={() => scope.onInspect?.(p.phase)}
              aria-label={`Inspect phase ${p.phase}`}
              title={`Inspect phase ${p.phase}`}
            >
              Inspect
            </Button>
          )}
        </span>
        {goal && (
          <span className="block truncate text-meta text-ink-muted" title={goal}>
            {goal}
          </span>
        )}
        {(runningOf(row) || p.elsewhere) && (
          <span className="block text-meta text-ink-muted">
            {runningOf(row) ? 'running now' : null}
            {p.elsewhere ? (
              <span title="The run record is what this run did; the board is what is true now.">
                finished outside this run
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}

/** The paint a spine station wears — the board word's own, with the two overlays. */
function spinePaint(state: string): string {
  switch (state) {
    case 'done':
      return 'done';
    case 'in-progress':
      return 'running';
    case 'stuck':
      return 'needs-you';
    case 'ready':
      return 'queued';
    default:
      return 'waiting';
  }
}

/**
 * The state as a dot and its word, the overlays in words — `gated` (a flag
 * beside the bucket) and `blocked` (a handoff that says so, or a review
 * holding it) — and, on a second line, what the lane is doing now. The
 * runner's last word stays on the row: a verification failure is not
 * something to go looking for.
 */
function StateCell({ row }: { row: PhaseTableRow }) {
  const { p, scope, liveness, entry, rulings } = row;
  const r = p.record;
  const showing = displayState(p.state, { running: runningOf(row) });
  const queued = r?.status === 'queued' || Boolean(entry);
  const hinted = hintedOf(scope.run, p.phase);
  const reviewHold = p.reviewHold ?? [];
  const marks = queueMarks(r?.queueControl);
  const failed = r?.verification && !r.verification.ok;
  const tree = failed ? verdictTree(r!.verification) : null;
  // The row's OWN lane — never `run.child`, which names only the lowest live one.
  const branch = scope.run?.children?.[String(p.phase)]?.branch;
  const laneFacts =
    liveness ||
    queued ||
    r?.serialBehind != null ||
    hinted ||
    marks.length > 0 ||
    r?.tasks?.length ||
    r?.live?.tasks?.total ||
    branch ||
    (p.land && p.land.source !== 'default') ||
    r?.landing;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <PhaseMark
          slug={scope.slug}
          phase={p.phase}
          state={showing}
          live={p.live}
          title={
            showing !== p.state
              ? `This run is working on phase ${p.phase} now. The board still reads "${p.state}" and catches up when the phase's handoff lands.`
              : undefined
          }
        />
        {p.gated && (
          <span className="text-meta text-ink" title={boardStateTitle('gated')}>
            gated
          </span>
        )}
        {(p.state === 'stuck' || reviewHold.length > 0) && (
          <span
            className="text-meta text-ink"
            title={
              reviewHold.length
                ? `Changes were requested on P${reviewHold.join(', P')} — this console will not board the phase until that review is answered.`
                : 'Its handoff says blocked: a session stopped and asked for something only a person can settle.'
            }
          >
            blocked
          </span>
        )}
        {p.proof && <EvidenceWords proof={p.proof} />}
        <RulingsCount count={rulings} />
      </span>
      {laneFacts ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-meta text-ink-muted">
          <LivenessWords liveness={liveness} />
          <ContextWords liveness={liveness} />
          {/* What the SESSION says it is doing — moved by `run:progress`. */}
          <TaskWords tasks={r?.tasks} live={r?.live?.tasks} />
          {queued && (
            <span
              title={
                entry?.waitingOn.length
                  ? entry.waitingOn
                      .map(
                        (h) =>
                          `${h.slug}${h.phase != null ? ` P${h.phase}` : ''}` +
                          (h.overlaps.length ? `, overlaps ${h.overlaps.join(', ')}` : '') +
                          (h.unqualified ? `, ${h.unqualified.reason}` : ''),
                      )
                      .join('\n')
                  : 'Waiting on the scheduler for a scope something else is holding'
              }
            >
              {waitingLabel(entry)}
            </span>
          )}
          {!queued && r?.serialBehind != null && (
            <span
              title={`Phase ${r.serialBehind} of this run is working in the same checkout. This phase starts when it ends — it is not waiting on anyone else.`}
            >
              behind this run’s P{r.serialBehind}
            </span>
          )}
          {!queued && hinted && (
            <span
              title={`A re-board (${hinted.rung}${hinted.by ? `, by ${hinted.by}` : ''}) asked for this phase at ${hinted.since}. It boards at the next free lane, ahead of phases that never started.`}
            >
              hinted since {hinted.since.slice(11, 16)}Z
            </span>
          )}
          {marks.map((mark) => (
            <span key={mark.key} title={mark.text} data-testid={`queue-mark-${mark.key}`}>
              {mark.label}
            </span>
          ))}
          <BranchWords branch={branch} base={scope.run?.base} />
          <LandWords land={p.land} />
          <LandingWords landing={r?.landing} />
        </span>
      ) : null}
      {/* What a live lane did last, from its session's own log (#138). */}
      {liveness ? <LastActivity slug={scope.slug} phase={p.phase} /> : null}
      {failed || r?.note ? (
        <span
          className={cn('block truncate text-meta', failed ? 'state-failed text-state' : 'text-ink-muted')}
          title={failed ? r!.verification!.reason : r?.note}
        >
          {failed ? r!.verification!.reason : r?.note}
        </span>
      ) : null}
      {tree ? <TreeLine tree={tree} className="truncate text-meta" /> : null}
    </div>
  );
}

/** What holds the phase, in the engine's own words (`blockedBy`): `not-done`, `qa:<verdict>`. */
function BlockedByCell({ row }: { row: PhaseTableRow }) {
  const by = row.p.blockedBy ?? [];
  if (!by.length) return <span className="text-meta text-ink-faint">—</span>;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5 text-meta">
      {by.map((b) => {
        const verdict = b.why.startsWith('qa:') ? b.why.slice(3) : null;
        return (
          <li key={`${b.phase}:${b.why}`} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <a
              href={phaseHref(row.scope.slug, b.phase)}
              className="tabular-nums text-ink underline-offset-2 hover:underline"
            >
              P{b.phase}
            </a>
            <span className="font-mono text-ink-muted">{b.why}</span>
            {/* HELD, not merely waiting: the dependency is done and its QA
                verdict is what stops this one (#27). */}
            {verdict && <span className="text-ink">held by its QA verdict</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The lane and its attempt on the labelled clock (#28): the attempt clock the
 * row prints, worked time once it ended, and — while a lane is live — which
 * silence it is in, for how long, against which threshold.
 */
function LaneCell({ row }: { row: PhaseTableRow }) {
  const r = row.p.record;
  const running = runningOf(row);
  const now = useNow(running);
  if (!r) {
    return row.eta ? (
      <span
        className="text-meta text-ink-muted"
        title={`An estimate for phase ${row.p.phase}, not a measurement.`}
      >
        about {row.eta.label.replace(/^~/, '')}
      </span>
    ) : (
      <span className="text-meta text-ink-faint">—</span>
    );
  }
  const windows = r.live?.phaseClocks?.attemptWindows;
  const clocks = phaseClocks(windows?.length ? { ...r, attemptWindows: windows } : r, now);
  const attemptMs = clocks[PHASE_ROW_CLOCK] as number | undefined;
  const workedMs = clocks.workedMs as number | undefined;
  const progress =
    running && row.eta && workedMs != null && row.eta.estMs > 0
      ? workedMs > row.eta.estMs
        ? 'over the estimate'
        : `${Math.round((workedMs / row.eta.estMs) * 100)} % of the estimate`
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-meta" data-testid={`lane-${row.p.phase}`}>
      <span className="text-ink-muted">attempt {Math.max(1, r.attempts ?? 1)}</span>
      {attemptMs != null && (
        <span title="From the start of the latest attempt — every other clock is in the phase's detail.">
          {PHASE_CLOCK_LABELS[PHASE_ROW_CLOCK]}{' '}
          <span className="tabular-nums text-ink">{running ? elapsed(attemptMs) : duration(attemptMs)}</span>
          {progress && <span className="text-ink-muted">, {progress}</span>}
        </span>
      )}
      {!running && workedMs != null && workedMs !== attemptMs && (
        <span className="text-ink-muted">
          {PHASE_CLOCK_LABELS.workedMs} {duration(workedMs)}
        </span>
      )}
      <SilenceWords liveness={row.liveness} now={now} />
    </div>
  );
}

/** Which silence a live lane is in, since when, and what it is measured against. */
function SilenceWords({ liveness, now }: { liveness: LaneLiveness | undefined; now: number }) {
  const silence = liveness?.silence;
  if (!silence) return null;
  const quietMs = Math.max(0, now - silence.sinceMs);
  const over = quietMs >= silence.thresholdMs;
  return (
    <span
      className={over ? 'text-ink' : 'text-ink-muted'}
      data-testid="lane-silence"
      title={
        `${SILENCE_LABEL[silence.kind] ?? silence.kind} for ${duration(quietMs)}. ` +
        `The stall detector raises a card for this lane at ${duration(silence.thresholdMs)}` +
        (silence.graceMs ? `, and nudges it after a ${duration(silence.graceMs)} grace.` : '.')
      }
    >
      {SILENCE_LABEL[silence.kind] ?? silence.kind} {elapsed(quietMs)}, flagged at{' '}
      {duration(silence.thresholdMs)}
      {silence.graceMs ? ` (grace ${duration(silence.graceMs)})` : ''}
    </span>
  );
}

/** What THIS run recorded against the phase — its word, its model, its tries. */
function RunRecordCell({ row }: { row: PhaseTableRow }) {
  const r = row.p.record;
  if (!r) return <span className="text-meta text-ink-faint">not attempted</span>;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-meta">
      <PhaseStatus
        record={r as Parameters<typeof PhaseStatus>[0]['record']}
        live={r.status === 'running'}
        title={phaseStatusTitle(r.status, r.lifecycle?.stop)}
      />
      <span className="min-w-0 break-words text-ink-muted">
        <span className="font-mono">{r.model ?? '—'}</span>
        {r.effort ? `, effort ${r.effort}` : ''}
        {r.attempts > 1 ? `, ${r.attempts} tries` : ''}
      </span>
      {fellOver(r) && (
        <span className="text-ink-muted" title="The session fell over to another model without restarting.">
          ran on <span className="font-mono">{r.actualModel}</span>
        </span>
      )}
      {modelMismatch(r) && (
        <span
          className="text-ink"
          title="The phase is pinned to its model and the session started on another — it parked before spending."
        >
          model mismatch
        </span>
      )}
      {r.mcpCalls && Object.keys(r.mcpCalls).length > 0 && (
        <span className="truncate text-ink-muted" title={mcpCallWords(r.mcpCalls)}>
          MCP: {mcpCallWords(r.mcpCalls)}
        </span>
      )}
    </div>
  );
}

/**
 * QA in one cell (#27): the verdict and its ROUND, linked to the report; what
 * the verdict holds; and the regime with the level that decided it — the
 * phase's own `QA:` bullet or the plan's line. Never a bare word.
 */
function QaCell({ row }: { row: PhaseTableRow }) {
  const { p, scope, holds } = row;
  const mode = phaseQaMode(p, scope.planQaMode);
  const result = p.qa?.result;
  const rounds = p.qaRounds;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-meta" data-testid={`qa-${p.phase}`}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        {isVerdict(result) ? (
          <a
            href={qaReportHref(scope.slug, p.phase, rounds?.latest.round)}
            className="rounded-sm"
            aria-label={`QA ${result} — open the report`}
          >
            <QaStatus result={result as WordOf<'qa-result'>} title={qaResultTitle(result!)} />
          </a>
        ) : (
          <span className="text-ink-muted">{result === 'pending' ? 'pending' : 'no verdict'}</span>
        )}
        {rounds && (
          <span
            className="tabular-nums text-ink-muted"
            title={`${plural(rounds.count, 'round')} on file — the latest is round ${rounds.latest.round} (${rounds.latest.result})`}
          >
            round {rounds.latest.round}
          </span>
        )}
        {holds.length > 0 && (
          <span className="text-ink" title={`This verdict holds P${holds.join(', P')} until it changes.`}>
            holds P{holds.join(', P')}
          </span>
        )}
      </span>
      <span className="text-ink-muted">
        {mode ?? '—'}, {p.qaMode?.source === 'phase' ? 'phase directive' : 'plan'}
      </span>
    </div>
  );
}

/** The handoff: its word, when, and whether INDEX.md knows about it. */
function HandoffCell({ row }: { row: PhaseTableRow }) {
  const { p, scope, handoff, index } = row;
  const status = p.handoff?.status ?? handoff?.status;
  if (!status) return <span className="text-meta text-ink-faint">none yet</span>;
  const completed = p.handoff?.completed ?? handoff?.completed;
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5 text-meta">
      <a
        href={handoffHref(scope.slug, p.phase)}
        className="rounded-sm"
        aria-label={`Handoff ${status} — read it`}
      >
        <OpsStatus vocab="handoff" word={status as WordOf<'handoff'>} />
      </a>
      {completed && <span className="tabular-nums text-ink-muted">{completed}</span>}
      {index === 'missing' && (
        <span
          className="text-ink"
          title="INDEX.md has no row for this handoff. Re-running new-handoff.sh for the phase rebuilds it."
        >
          no index row
        </span>
      )}
    </div>
  );
}

/** Who can clear the phase's gate, and what it checks. */
function GateCell({ row }: { row: PhaseTableRow }) {
  const { p } = row;
  if (!p.gated) return <span className="text-meta text-ink-faint">—</span>;
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5 text-meta">
      <span className="text-ink" title={p.gates ?? boardStateTitle('gated')}>
        {p.gateKind && p.gateKind !== 'none' ? `${p.gateKind} gate` : 'gated'}
      </span>
      {p.gateCheck && (
        <span className="max-w-full truncate text-ink-muted" title={p.gateCheck}>
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
  if (spend == null) return <span className="text-meta text-ink-faint">—</span>;
  const inflight = r?.status === 'running' ? r.live?.spentUsd : undefined;
  return (
    <Money
      usd={spend}
      className="text-meta"
      title={inflight ? 'Includes the session in flight — booked when it ends.' : undefined}
    />
  );
}

/* ------------------------------------------------------------------------- *
 * The verbs
 * ------------------------------------------------------------------------- */

/** The facts every verb decision reads, computed once per row. */
function verbFacts(row: PhaseTableRow) {
  const { p, scope } = row;
  const r = p.record;
  const can = actionsOf(p, { live: scope.live, allowRun: scope.allowRun });
  const blockedRunAlone = Boolean(can.heldBy) && !scope.live && p.state === 'ready' && scope.allowRun;
  const blockedRetry =
    Boolean(can.heldBy) &&
    !scope.live &&
    ['failed', 'interrupted', 'parked', 'gated'].includes(r?.status ?? '');
  const heldTitle = can.heldBy
    ? `Phase ${p.phase} is claimed by ${can.heldBy.owner}` +
      (can.heldBy.host ? ` on ${can.heldBy.host}` : '') +
      `${can.heldBy.leaseUntil ? ` — the lease has ${countdown(can.heldBy.leaseUntil)}` : ''}.` +
      ' Release the claim to start a session here.'
    : undefined;
  return { can, blockedRunAlone, blockedRetry, heldTitle };
}

/** The recovery ctx the shared renderer reads — the board's word, the record, the claim. */
function recoveryCtx(row: PhaseTableRow) {
  const { p, scope } = row;
  const r = p.record;
  const { can } = verbFacts(row);
  return {
    boardState: p.state,
    ...(scope.run ? { run: scope.run } : {}),
    // `resumable` means "a checkpointed session to pick up" — on a record, `resumeSessionId`.
    ...(r ? { record: { status: r.status, resumable: Boolean(r.resumeSessionId) } } : {}),
    ...(can.heldBy ? { lock: { holder: can.heldBy.owner, expired: Boolean(can.heldBy.expired) } } : {}),
  };
}

/**
 * The row's ONE act at the glance: the recommended way forward when the phase
 * needs one, else Run only this (disabled with the claim that stops it).
 * Every other verb is in the row's detail and the panel's Actions.
 */
function ActionCell({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const { can, blockedRunAlone, blockedRetry, heldTitle } = verbFacts(row);
  if (can.retry || can.skip || (blockedRetry && scope.allowRun)) {
    return (
      <RecoveryActions
        target={{ slug: scope.slug, phase: p.phase, ...(scope.run?.id ? { runId: scope.run.id } : {}) }}
        ctx={recoveryCtx(row)}
        max={1}
        bare
        parts={ACCOUNT_RECOVERY_PARTS}
      />
    );
  }
  if (can.runAlone || blockedRunAlone) {
    return (
      <Button
        size="sm"
        variant="default"
        className="shrink whitespace-normal h-auto"
        disabled={!can.runAlone}
        title={
          can.runAlone
            ? 'Run this phase on its own, then stop — the loop does not carry on into the plan'
            : heldTitle
        }
        onClick={() => scope.onRunAlone(p.phase)}
      >
        Run only this
      </Button>
    );
  }
  return null;
}

/**
 * Every verb a phase offers, in one renderer — the row's detail draws it and
 * the panel's Actions tab draws it, so the two cannot disagree. Gated on the
 * BOARD, never the run record: offering to run a phase the board calls done is
 * the defect this table was rebuilt for.
 */
export function PhaseVerbs({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  const r = p.record;
  const { can, blockedRunAlone, blockedRetry, heldTitle } = verbFacts(row);
  const recovery = scope.recovery;
  const target = { slug: scope.slug, phase: p.phase, ...(scope.run?.id ? { runId: scope.run.id } : {}) };
  // A recovery for a phase that is genuinely stuck — never one the BOARD calls
  // done, and never while the run is live (the autopilot owns the tree).
  const recoveryClass =
    recovery && !scope.live && p.state !== 'done'
      ? ((r
          ? classifyPhase(r.status, scope.run, { authFailure: recovery.authFailure ?? false })
          : undefined) ?? classifyBoardPhase(p.state))
      : undefined;
  const recovering = liveRecovery(recovery?.sessions, { slug: scope.slug, phase: p.phase });
  const reviewing = liveQa(recovery?.sessions, { slug: scope.slug, phase: p.phase });
  const anything =
    can.retry ||
    can.skip ||
    blockedRetry ||
    can.runAlone ||
    blockedRunAlone ||
    can.heldBy ||
    recoveryClass ||
    (recovery && !scope.live && canQa(p.state)) ||
    (p.elsewhere && r && ['failed', 'interrupted', 'parked', 'gated'].includes(r.status));
  if (!anything) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={`phase-verbs-${p.phase}`}>
      {p.elsewhere && r && ['failed', 'interrupted', 'parked', 'gated'].includes(r.status) && (
        <p className="text-meta text-ink-muted">
          This run’s own attempt stopped, but the phase was finished and verified outside it and the board
          reads done. There is nothing to fix.
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {(can.retry || can.skip || (blockedRetry && scope.allowRun)) && (
          <RecoveryActions target={target} ctx={recoveryCtx(row)} max={2} parts={ACCOUNT_RECOVERY_PARTS} />
        )}
        {(can.runAlone || blockedRunAlone) && (
          <Button
            size="sm"
            className="shrink whitespace-normal h-auto"
            disabled={!can.runAlone}
            title={
              can.runAlone
                ? 'Run this phase on its own, then stop — the loop does not carry on into the plan'
                : heldTitle
            }
            onClick={() => scope.onRunAlone(p.phase)}
          >
            Run only this
          </Button>
        )}
        {can.heldBy && scope.allowRun && (
          <ReleaseClaim slug={scope.slug} phase={p.phase} owner={can.heldBy.owner} />
        )}
        {recoveryClass && recovery && (
          <RecoveryButton
            kind={recoveryClass}
            allowAgent={recovery.allowAgent}
            {...(recovering ? { runningSessionId: recovering.id } : {})}
            target={target}
          />
        )}
        {recovery && !scope.live && canQa(p.state) && (
          <QaButton
            label="Run QA"
            target={{
              slug: scope.slug,
              phase: p.phase,
              title: p.title,
              model: p.model,
              effort: p.effort,
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
    </div>
  );
}

/** Release a live claim — the operator deciding another session is gone, asked for explicitly. */
function ReleaseClaim({ slug, phase, owner }: { slug: string; phase: number; owner: string }) {
  const { release, busy } = useLockRelease();
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      busy={busy}
      destructive
      title={`Release ${owner}'s claim on phase ${phase}?`}
      description="Only when that session is gone: its work stays, and the next session may start here."
      confirmLabel="Release the claim"
      onConfirm={() => void release(slug, phase, true)}
    >
      Release the claim
    </ConfirmButton>
  );
}

/* ------------------------------------------------------------------------- *
 * The row's detail — one press from the row
 * ------------------------------------------------------------------------- */

/**
 * Everything about one phase a column does not carry: what can be done, the
 * runner's notes in full, the drawer (why it is not done, its QA, its clocks,
 * its rulings), the handoff's facts and the phase's prose — fetched on open.
 */
function PhaseRowDetail({ row }: { row: PhaseTableRow }) {
  const { p, scope } = row;
  return (
    <div className="flex min-w-0 flex-col gap-3 py-1">
      <PhaseVerbs row={row} />
      <PhaseDrawer
        slug={scope.slug}
        phase={p.phase}
        run={scope.run}
        view={p}
        record={p.record}
        holds={row.holds}
        eta={row.eta}
        handoff={row.handoff}
        index={row.index}
        {...(scope.planQaMode ? { planQaMode: scope.planQaMode } : {})}
        {...(scope.recovery?.planSkills ? { planSkills: scope.recovery.planSkills } : {})}
      />
    </div>
  );
}
