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
 */

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  Empty,
  ListRow,
  StateChip,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
  StatusBadge,
  planColumns,
  trackOf,
  useTableFit,
  stickyHeadCell,
  stickyIdentityCell,
  type Column,
} from '@/components/ui';
import {
  type LaneLiveness,
  type PhaseEta,
  type Ruling,
  type PhaseLock,
  type PhaseRecord,
  type PhaseScope,
  type PhaseView,
  type QueueEntry,
  type RunState,
  type TerminalSession,
} from '@/lib/api';
import { countdown, duration, elapsed, money, pad2 } from '@/lib/format';
import { DepsCell, LockCell, PhaseDetails, SizeCell } from '@/features/plans/phase-cells';
import { ForceReleaseButton } from '@/components/release-lock';
import { useNow } from '@/lib/clock';
import { useConsoleState } from '@/lib/queries';
import { usePrefs } from '@/lib/prefs';
import { usePhone } from '@/lib/media';
import { phaseProgress } from './tiles';
import { MCP_REASON } from './defaults';
import { classifyBoardPhase, classifyPhase, liveRecovery } from '@/lib/recovery';
import { canQa, liveQa, phaseQaMode } from '@/lib/qa';
import { QaButton, QaVerdict } from '@/components/qa-launcher';
import { LaunchDialog } from '@/features/run-setup/launch-dialog';
import { RecoveryButton } from './status-strip';
import { PhaseDrawer } from './phase-drawer';
import { EvidenceLine, LivenessChip, PhaseActorLine, PhaseStateChip, RulingsChip } from './phase-row';
import { BranchChip } from './git-card';
import { TaskLine } from './task-summary';
import { RecoveryActions } from '@/components/recovery-actions';
import { queueEntryFor, waitingLabel } from './session-panes';
import { phaseHref, planHref } from '@shared/routes.js';
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
import { boardStateTitle, phaseStatusTitle, phaseUiState } from '@/lib/status-vocab';
import { cn } from '@/lib/cn';
import { PHASE_GROUPS, displayState, groupOf, groupRows } from './phase-groups';
import type { GroupablePhase, PhaseGroupId } from './phase-groups';

/**
 * `displayState` — the state to paint in the Status cell, which is not always
 * the board's — moved to `./phase-groups` with the grouping rule that uses it,
 * and is re-exported below. The reasoning for the rule itself travelled with
 * the code; the reason it MOVED is the chunk graph, and that note is on the
 * re-export.
 */

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
const ORDER = BOARD_ORDER as string[];
/** The Repos cell as scope tokens, never empty — a blank cell means `all`. */
const scopeOf = scopeOfRow as (cell: string | undefined) => string[];

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
  /** Whether the console may turn QA on for the plan — a different flag from allowAgent. */
  allowWrites?: boolean;
};

/**
 * The five groups a phase can be in, in the order they are worth reading.
 *
 * This is NOT `BOARD_ORDER`. The board's order is about the lifecycle; this is
 * about attention, and the two differ in exactly one way that matters: a
 * FAILED phase and a phase that needs a person outrank everything, including
 * the phase that is running. A fifteen-phase plan renders as fifteen rows in
 * board order, and the two that are asking for something sit wherever their
 * numbers put them — which on a phone is below the fold.
 *
 * `done` is last and collapsed, because a finished phase is the one thing here
 * nobody is looking for. The collapse is REMEMBERED (`prefs.runPhasesDone`):
 * a section that re-opens on every navigation is a section being re-collapsed
 * rather than read. The shipped default is `['done']` (`lib/prefs.ts`).
 */
/*
 * The five groups, `groupOf`, `groupRows` and `displayState` now live in
 * `./phase-groups` — a leaf module with no imports — and are re-exported here
 * so every existing caller and test keeps working.
 *
 * ⚠️ The plan page's Phases tab must import them from `./phase-groups`, NOT
 * through this re-export: an import of this file is an import of the whole
 * table, and the table reaches `run-setup` (77.6 KB) — which is how a form the
 * plan route cannot show ended up in the plan route's chunk. `check-dist.mjs`
 * asserts it stays out.
 */
export { PHASE_GROUPS, displayState, groupOf, groupRows };
export type { GroupablePhase, PhaseGroupId };

/**
 * The twelve columns, as data.
 *
 * `priority` is what a column is worth when the box is too small for all of
 * them: `1` never leaves, and the rest fold into the row's detail smallest-
 * first. The widths are the other half of the same fix — Phase was starved to
 * about 100px and wrapped four-line titles while Status held five hundred and
 * mostly nothing, because nothing had ever declared what either was worth.
 */
const PHASE_COLUMNS: Column<never>[] = [
  { id: 'num', head: '#', cell: () => null, priority: 1, min: 48, identity: true },
  { id: 'phase', head: 'Phase', cell: () => null, priority: 1, min: 220, flex: true, card: 'title' },
  // Priority 2, not 1, and that is a phone decision. Four columns that never
  // leave adds up to 700px, which on a 390px screen is not a narrow table —
  // it is a 390px window onto a table twice as wide as the phone, and the page
  // itself starts scrolling sideways. Below the fold is a tap away; off the
  // right-hand edge is not.
  { id: 'status', head: 'Status', cell: () => null, priority: 2, min: 180, card: 'meta' },
  { id: 'deps', head: 'Deps', cell: () => null, priority: 3, min: 108 },
  { id: 'lock', head: 'Lock', cell: () => null, priority: 4, min: 112 },
  { id: 'repos', head: 'Repos', cell: () => null, priority: 4, min: 108 },
  { id: 'size', head: 'Size', cell: () => null, priority: 3, min: 72 },
  { id: 'thisRun', head: 'This run', cell: () => null, priority: 2, min: 128 },
  { id: 'cost', head: 'Cost', cell: () => null, priority: 2, min: 76, align: 'end' },
  { id: 'turns', head: 'Turns', cell: () => null, priority: 5, min: 68, align: 'end' },
  { id: 'took', head: 'Took', cell: () => null, priority: 2, min: 88, align: 'end' },
  // 252 is measured, not guessed — the widest single remedy this table can draw
  // is `Pick up with a new agent` with its mechanism badge, which measures 249px
  // on the hub's own run. It was 236, then 244 against a two-button group of
  // 240; the number that matters turned out to be one BUTTON, because the group
  // already wraps and an item cannot wrap inside itself.
  // It was 236, which is the same defect in miniature as the fleet table's
  // collapsed Plan track and cost far more than four pixels: the group
  // overflowed its cell, `useTableFit` read the table 4 px over its 1160 px box
  // and flipped the whole thing to scroll mode, so all twenty rows lost the
  // sticky header for want of a track four pixels wider.
  //
  // Priority 2 for the same reason as Status: on a phone the remedies move into
  // the row's own detail, which is one tap, rather than off the edge, which is
  // nowhere.
  { id: 'actions', head: 'Actions', cell: () => null, priority: 2, min: 252 },
];

/** Which attached servers a phase actually reached for, and how often. */
function mcpCallList(calls: Record<string, number>): string {
  return Object.entries(calls)
    .map(([id, count]) => `${id} ×${count}`)
    .join(' · ');
}

/** "Cost", "Cost and Turns", "Cost, Turns and Took" — never "Cost, Turns". */
function listOf(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Per-cell classes the column array does not carry, keyed the same way.
 *
 * TYPOGRAPHY only — never alignment. `align` is declared on the column and read
 * by the header and the body from that one place: this map carried `text-right`
 * for the three numeric cells while `c.align === 'end'` painted the header, so
 * the two halves of one column agreed only for as long as nobody added a fourth
 * numeric column. The `align`-less half is the one that would have been missed.
 */
const CELL_CLASS: Record<string, string> = {
  num: 'font-mono tabular-nums',
  thisRun: 'text-2xs',
  cost: 'font-mono tabular-nums',
  turns: 'font-mono tabular-nums',
  took: 'font-mono tabular-nums',
};

/** One column's alignment, wherever it is drawn. */
const alignClass = (c: Column<never>): string | false => c.align === 'end' && 'text-right';

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
}) {
  // "Run only this" opens the launch dialog on the row's phase; one dialog for
  // the table, keyed by which phase asked. Before the early return — a hook.
  const [launchPhase, setLaunchPhase] = useState<number | null>(null);
  const [prefs, setPrefs] = usePrefs();
  const collapsed = prefs.runPhasesCollapsed;
  // Twelve columns do not become a phone table by folding nine of them away:
  // what is left is three columns and a disclosure triangle, and the remedies
  // — the reason anybody opens this page on a phone — are behind the triangle.
  // Below the shell breakpoint the same rows are cards instead.
  const phone = usePhone();

  // Measured, not assumed: the cards above this table grow as their queries
  // land and the rail comes and goes at 900px, so the cut is recomputed rather
  // than decided once at mount.
  const { wrapRef, tableRef, width, overflows, measured } = useTableFit();
  const { shown, folded } = useMemo(() => planColumns(PHASE_COLUMNS, width), [width]);

  const rulingCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const ruling of rulings ?? []) counts[ruling.phase] = (counts[ruling.phase] ?? 0) + 1;
    return counts;
  }, [rulings]);

  if (!planPhases.length) {
    return (
      <Empty
        title="This plan has no phase graph"
        body="The autopilot drives phases from the plan's own graph table, so there is nothing here to run."
        action={
          <Button size="sm" variant="default" asChild>
            <a href={planHref(slug)}>Read the plan</a>
          </Button>
        }
      />
    );
  }

  const rows = merge(planPhases, run);
  const board = counts(rows);
  const asked = run?.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  const spent = rows.reduce((sum, r) => sum + (r.record?.costUsd ?? 0), 0);

  return (
    <Card>
      <CardHeader className="flex-wrap items-center">
        <CardTitle>Phases</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {ORDER.filter((state) => board[state]).map((state) => (
            <span key={state} className="flex items-center gap-1">
              <StateChip state={state} board />
              <b className="font-mono text-2xs tabular-nums">{board[state]}</b>
            </span>
          ))}
        </div>
      </CardHeader>

      <CardBody className="p-0">
        <p className="max-w-prose px-4 py-2 text-2xs text-ink-faint">
          Status is the plan's own board, so a phase finished by any other session reads as finished here.
          {/* Said once, in words, rather than as a "+2" repeated on every row.
              A column that leaves the screen without saying so is the defect;
              saying so twenty-one times is a different one. */}
          {!phone &&
            folded.length > 0 &&
            ` ${listOf(folded.map((c) => c.head))} ${folded.length === 1 ? 'does' : 'do'} not fit this window — open a row to read ${folded.length === 1 ? 'it' : 'them'}.`}
          {asked &&
            ` This run was asked for phase${asked.size === 1 ? '' : 's'} ${[...asked].join(', ')} only.`}
        </p>

        {/* Unmeasured is not "it fits": until the box has answered, the
            wrapper scrolls, because a full-width table inside a wrapper that
            does not is a table with columns off the edge and no scrollbar
            anywhere to reach them. */}
        {phone ? (
          <PhaseCards
            groups={groupRows(rows)}
            collapsed={collapsed}
            onCollapsed={(next) => setPrefs({ runPhasesCollapsed: next })}
            slug={slug}
            run={run}
            live={live}
            allowRun={allowRun}
            {...(recovery ? { recovery } : {})}
            onRunAlone={setLaunchPhase}
            {...(queue ? { queue } : {})}
            {...(phaseEta ? { phaseEta } : {})}
            {...(liveness ? { liveness } : {})}
            rulingCounts={rulingCounts}
          />
        ) : (
          <TableWrap ref={wrapRef} scrolls={overflows || !measured}>
            {/* hand-rolled because: collapsible groups. Each group is its own
                `<tbody>` with a heading row that names it, so `aria-expanded`
                on the heading has something to control — and the rows a group
                holds come and go without the table re-cutting its columns.
                `DataTable` renders one flat body. Everything else here IS the
                primitive: `planColumns` for the cut, `trackOf` for the layout,
                `useTableFit` for the wrapper and the sticky header. */}
            <Table ref={tableRef} aria-label="Phases in this run" fixed>
              <THead>
                <TR>
                  {shown.map((c) => (
                    <TH
                      key={c.id}
                      className={cn(
                        alignClass(c),
                        // Sticky only on the branch where the wrapper is not a
                        // scroll container — then it binds to <main> and pins for
                        // real. Thirty-four rows used to scroll the headings away.
                        // `measured` is the other half of the same decision: the
                        // wrapper above scrolls until the box has answered, and a
                        // header stuck to a box that never scrolls vertically is
                        // paint nobody sees.
                        !overflows && measured && stickyHeadCell,
                        // The header end of the identity rail. `bg-ground`, not
                        // the row-hover token it used to carry: this cell sits in
                        // the header band and has to be painted in the band's own
                        // colour, or the pinned corner reads as a hovered row.
                        overflows &&
                          c.identity &&
                          'sticky left-0 z-(--z-base) bg-ground shadow-[1px_0_0_0_var(--rule)]',
                      )}
                      // `trackOf`, not `c.min`: the cut budgets `trackOf` and a
                      // layout that reads a different number is how the two came
                      // to disagree by 360 px once already. They are equal for
                      // every column here today, and the point is that they stay
                      // equal when one grows a `width`.
                      {...(c.flex ? {} : { style: { width: trackOf(c) } })}
                    >
                      {c.id === 'actions' ? <span className="sr-only">Actions</span> : c.head}
                    </TH>
                  ))}
                </TR>
              </THead>
              {groupRows(rows).map((group) => {
                const shut = collapsed.includes(group.id);
                // The rows are their own `<tbody>` so the heading can NAME them:
                // `aria-expanded` alone tells a screen reader that something
                // opened and not what. Two bodies per group is valid — and the
                // rows' body is rendered whether or not it is shut, so the
                // reference never dangles.
                const bodyId = `phase-group-${group.id}`;
                return (
                  <Fragment key={group.id}>
                    <TBody>
                      <TR>
                        {/* The section head is a row of the same table, so the
                          columns stay aligned across every group — a separate
                          table per group is how a phone ends up with five
                          different column widths. */}
                        <TD colSpan={shown.length} className="bg-ground-deep/60 py-1">
                          <button
                            type="button"
                            aria-expanded={!shut}
                            aria-controls={bodyId}
                            className="flex w-full cursor-pointer items-baseline gap-2 text-left"
                            onClick={() =>
                              setPrefs({
                                runPhasesCollapsed: shut
                                  ? collapsed.filter((id) => id !== group.id)
                                  : [...collapsed, group.id],
                              })
                            }
                          >
                            <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">
                              {shut ? '▸' : '▾'}
                            </span>
                            <strong className="text-2xs">{group.label}</strong>
                            <span className="font-mono text-2xs text-ink-faint tabular-nums">
                              {group.rows.length}
                            </span>
                            <span className="truncate text-2xs text-ink-faint">{group.hint}</span>
                          </button>
                        </TD>
                      </TR>
                    </TBody>
                    <TBody id={bodyId}>
                      {!shut &&
                        group.rows.map((p) => (
                          <PhaseRows
                            key={p.phase}
                            shown={shown}
                            folded={folded}
                            pinIdentity={overflows}
                            phase={p}
                            slug={slug}
                            run={run}
                            live={live}
                            allowRun={allowRun}
                            recovery={recovery}
                            onRunAlone={setLaunchPhase}
                            entry={queueEntryFor(queue, slug, p.phase)}
                            conflicts={scopes?.find((s) => s.phase === p.phase)?.conflicts}
                            eta={phaseEta?.find((e) => e.phase === p.phase)}
                            liveness={liveness?.find((l) => l.phase === p.phase)}
                            rulings={rulingCounts[p.phase] ?? 0}
                          />
                        ))}
                    </TBody>
                  </Fragment>
                );
              })}
            </Table>
          </TableWrap>
        )}

        {spent > 0 && (
          <p className="px-4 py-2 text-2xs text-ink-faint">
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
          }}
          onClose={() => setLaunchPhase(null)}
        />
      )}
    </Card>
  );
}

function PhaseRows({
  shown,
  folded,
  pinIdentity,
  phase: p,
  slug,
  run,
  live,
  allowRun,
  recovery,
  onRunAlone,
  entry,
  conflicts,
  eta,
  liveness,
  rulings = 0,
}: {
  shown: Column<never>[];
  folded: Column<never>[];
  pinIdentity: boolean;
  phase: MergedPhase;
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  /** Opens the launch dialog scoped to this phase. */
  onRunAlone: (phase: number) => void;
  entry?: QueueEntry | undefined;
  conflicts?: string[] | undefined;
  eta?: PhaseEta | undefined;
  /** This phase's live lane, when it has one. Absent on an older server. */
  liveness?: LaneLiveness | undefined;
  /** How many rulings this phase's sessions recorded. */
  rulings?: number;
}) {
  const r = p.record;
  // Gated on the BOARD, never on the run record. Offering to run a phase the
  // board calls done is the defect this table was rebuilt for.
  const can = actionsFor(p, { live, allowRun });
  const detoured = fellOver(r);
  const hasNote = Boolean(
    r?.note ||
    r?.status === 'waiting' ||
    r?.verification ||
    r?.preflight?.length ||
    r?.mcpDegraded?.length ||
    r?.mcpPark ||
    can.diagnose,
  );
  /*
   * The detail row used to be unconditional, because the "Everything about
   * phase N" disclosure lived in it and was always there. On a 21-phase plan
   * that is 21 full-width bands carrying one collapsed summary each — close to
   * half the table's height, holding nothing. The disclosure moved onto the
   * row's own number, so this row appears when it has something to say.
   */
  const [open, setOpen] = useState(false);

  // A session of THIS run is open on this phase. `startedAt` with no `endedAt`
  // is the record's own account; `live` is the console's, and both have to hold
  // — a checkpoint left by a killed console has the first and not the second.
  const running =
    live && Boolean(r?.startedAt) && !r?.endedAt && (r?.status === 'running' || r?.status === 'verifying');
  const showing = displayState(p.state, { running });
  // The record is what THIS run is doing; the entry is the scheduler's own view.
  // Either alone is enough to say the phase is in a line.
  const queued = r?.status === 'queued' || Boolean(entry);
  const now = useNow(running);
  const runningMs = running && r?.startedAt ? now - Date.parse(r.startedAt) : 0;

  /*
   * Every cell addressed by name.
   *
   * All twelve columns is `PHASE_COLUMNS.reduce((n, c) => n + trackOf(c), 0)`
   * of table — the same accumulator the cut and the layout read, named here
   * rather than written out as a figure, because the figure that used to sit in
   * this sentence had drifted 200px from the declarations and was then cited in
   * a review as evidence about a layout it no longer described. The box it sits
   * in is 1232px on a 1512px laptop. So Cost, Turns, Took and Actions left the screen
   * with no scrollbar, no header to scroll back to and nothing saying they were
   * gone. Naming the cells lets the layout keep what fits and put the rest
   * in the row's own detail, which this row already had.
   */
  const cells: Record<string, ReactNode> = {
    num: pad2(p.phase),
    phase: (
      <>
        <a className="underline-offset-2 hover:underline" href={phaseHref(slug, p.phase)}>
          {p.title}
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {p.gated && (
            <Chip tone="gate" title={boardStateTitle('gated')}>
              gated
            </Chip>
          )}
          {/* The row's own record, not the mirror pointer: with two lanes
              live, `activePhase` names only the lowest one. */}
          {running && <Chip tone="busy">running now</Chip>}
          {p.elsewhere && (
            <span
              className="text-2xs text-ink-faint"
              title="The run record beside this is what this run did; the board is what is true now."
            >
              finished outside this run
            </span>
          )}
        </div>
      </>
    ),
    status: (
      <>
        <div className="flex flex-wrap items-center gap-1">
          {/* `live` and not `running` decides the pulse and the link. Both
              are live facts, but `p.live` is the SERVER's — one answer from
              the run record, the lock and the session registry — and the
              plan page reads the same field. Two pages disagreeing about
              whether a phase is running is the failure this vocabulary
              exists to prevent. `running` keeps its own jobs below: the row
              tint, the promoted `showing` word and the elapsed clock, which
              are claims about THIS run rather than about the phase. */}
          <PhaseStateChip
            slug={slug}
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
          <QaVerdict qa={p.qa} />
          {/* Three facts the client has carried since Phases 4 and 5 and
              rendered nowhere: whether a `done` claim is backed, what a
              lane that has not stopped is actually doing, and how many
              decisions the plan did not make for this phase. Each renders
              nothing when its fact is absent. */}
          {p.proof && <EvidenceLine proof={p.proof} />}
          <LivenessChip liveness={liveness} />
          <RulingsChip count={rulings} />
          {/* …and a fifth, once a run can drive lanes on branches of their
              own: which branch THIS row's session is committing on. Read off
              the run's live children, keyed by phase like `phases` is —
              absent means the lane is on the run's own branch, which is every
              lane that did not take a worktree. */}
          <BranchChip branch={run?.children?.[String(p.phase)]?.branch} />
          {/* …and a fourth: what the SESSION says it is doing. The panel
              below carries the whole list for the open lane; a run with
              three lanes needs the one-line version on each row. */}
          <TaskLine tasks={r?.tasks} />
        </div>
        {/* "Queued" alone is the same non-answer `pausing` used to be. What
            makes the wait bearable is WHAT it is behind, and that is the one
            thing the payload exists to carry. */}
        {queued && (
          <div className="mt-0.5">
            <Chip
              tone="busy"
              title={
                entry?.waitingOn.length
                  ? entry.waitingOn
                      .map(
                        (h) =>
                          `${h.slug}${h.phase != null ? ` P${h.phase}` : ''}` +
                          (h.overlaps.length ? ` — overlaps ${h.overlaps.join(', ')}` : ''),
                      )
                      .join('\n')
                  : 'Waiting on the scheduler for a scope something else is holding'
              }
            >
              {waitingLabel(entry)}
            </Chip>
          </div>
        )}
      </>
    ),
    deps: (
      <>
        <DepsCell slug={slug} phase={p} max={3} />
      </>
    ),
    lock: (
      <>
        <LockCell lock={p.lock} compact />
      </>
    ),
    repos: (
      <>
        <ScopeChips tokens={scopeOf(p.row?.repos)} conflicts={conflicts} />
      </>
    ),
    size: (
      <>
        <SizeCell phase={p} eta={eta} />
      </>
    ),
    thisRun: (
      <>
        {r ? (
          <>
            <StatusBadge
              state={phaseUiState(r.status, r.lifecycle?.stop)}
              label={r.status}
              mono
              title={phaseStatusTitle(r.status, r.lifecycle?.stop)}
              pulse={r.status === 'running'}
            />
            {/* Same icon vocabulary as the header's Model tile — what a row
                ran as should not be the smallest, least-scannable text on it. */}
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
            {detoured && (
              <div
                className="text-ink-faint"
                title="the session fell over to another model without restarting"
              >
                ran on {r.actualModel}
              </div>
            )}
            {/* Which attached servers this phase actually reached for — the
                only honest answer to "was attaching that worth it". A zero is
                the interesting number: it was paid for on every turn and
                never used. */}
            {r.mcpCalls && Object.keys(r.mcpCalls).length > 0 && (
              // One line, however many servers were attached. A join has no
              // width of its own, and this column's track is 128px — six
              // servers wrapped it into six lines and pushed the row's own
              // remedies below the fold. The whole list is the hover.
              <div className="truncate text-2xs text-ink-faint" title={mcpCallList(r.mcpCalls)}>
                mcp {mcpCallList(r.mcpCalls)}
              </div>
            )}
          </>
        ) : (
          <span className="text-ink-faint">not attempted</span>
        )}
      </>
    ),
    cost: r?.costUsd ? money(r.costUsd) : '—',
    turns: r?.turns ?? '—',
    took: (
      <>
        {r?.durationMs ? (
          duration(r.durationMs)
        ) : running ? (
          <span
            title={
              eta ? `Phase ${p.phase} was expected to take about ${eta.label.replace('~', '')}.` : undefined
            }
          >
            {elapsed(runningMs)}
            {eta && <span className="text-ink-faint"> / {phaseProgress(runningMs, eta.estMs)}</span>}
          </span>
        ) : eta ? (
          <span className="text-ink-faint" title={`An estimate for phase ${p.phase}, not a measurement.`}>
            {eta.label}
          </span>
        ) : (
          '—'
        )}
      </>
    ),
    actions: (
      <PhaseActions
        phase={p}
        slug={slug}
        run={run}
        live={live}
        allowRun={allowRun}
        onRunAlone={onRunAlone}
        {...(recovery ? { recovery } : {})}
      />
    ),
  };

  return (
    <>
      <TR className={cn(running && 'bg-progress/8', p.state === 'done' && 'text-ink-faint')}>
        {shown.map((c) => (
          <TD
            key={c.id}
            className={cn(
              CELL_CLASS[c.id],
              alignClass(c),
              // The identity rail. When the table does scroll sideways this is
              // the one cell that does not go with it, so the twelfth column
              // still has a phase number attached to it.
              pinIdentity && c.identity && cn(stickyIdentityCell, 'shadow-[1px_0_0_0_var(--rule)]'),
            )}
          >
            {c.identity ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`phase-${p.phase}-detail`}
                  onClick={() => setOpen((v) => !v)}
                  className="inline-flex items-center text-ink-faint hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
                >
                  <span aria-hidden className="font-mono text-2xs">
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="sr-only">
                    {open ? 'Hide' : 'Show'} everything about phase {p.phase}
                    {folded.length ? ` — and ${folded.length} more column(s)` : ''}
                  </span>
                </button>
                {cells[c.id]}
              </span>
            ) : (
              cells[c.id]
            )}
          </TD>
        ))}
      </TR>

      {/*
       * The detail row, now that it has a reason to exist.
       *
       * The notes half is unchanged and still unconditional-when-present: a
       * verification failure or an MCP warning is not something to go looking
       * for. What moved is the disclosure — it hangs off the row's number, so
       * a phase with nothing to say costs no row at all.
       */}
      {(hasNote || open) && (
        <TR className="hover:bg-surface">
          <TD className={cn(pinIdentity && stickyIdentityCell)} />
          <TD colSpan={Math.max(1, shown.length - 1)} id={`phase-${p.phase}-detail`}>
            <>
              {r?.note && <div className="text-2xs text-ink-faint">{r.note}</div>}
              {r?.status === 'waiting' && (
                // A declared external wait: what it waits on, when the runner
                // resumes the phase's own session, and which round of waiting
                // this is (the runner caps them).
                <div className="text-2xs text-ink-faint">
                  {/* Whose park it is, first: the console's own inference is never
                      drawn as the session's testimony. */}
                  {r.declared?.by === 'watchdog'
                    ? 'Parked by the console — it was waiting inside its turn'
                    : 'Waiting on external work'}
                  {r.parkReason ? `: ${r.parkReason}` : ''}
                  {r.parkedUntil ? ` — resumes ${new Date(r.parkedUntil).toLocaleTimeString()}` : ''}
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
                  {r.watch?.length ? (
                    <>
                      {' '}
                      · watching{' '}
                      {/* Paths, and a watch list is as long as the phase made
                          it. `inline-block` is what gives a `truncate` a box to
                          truncate against inside a sentence. */}
                      <code
                        className="inline-block max-w-full truncate align-bottom font-mono"
                        title={r.watch.join(', ')}
                      >
                        {r.watch.join(', ')}
                      </code>
                    </>
                  ) : null}
                  {/* A ref nothing will ever probe is named beside the ones that
                      will be, never dropped in silence (WAI-11). */}
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
              )}
              {r?.verification && (
                <div className={cn('text-2xs', r.verification.ok ? 'text-done' : 'text-blocked')}>
                  {r.verification.reason}
                </div>
              )}
              {r?.verification?.notRun?.length ? (
                <details className="mt-1">
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
                <details className="mt-1">
                  <summary className="cursor-pointer text-2xs text-gated">
                    {r.preflight.length} verification warning{r.preflight.length === 1 ? '' : 's'} from
                    boarding
                  </summary>
                  <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
                    {r.preflight.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {r?.mcpDegraded?.length ? (
                // Not a `<details>`: a phase that quietly did without half its
                // tools and a phase that had all of them look identical in the
                // handoff afterwards, so this one stays open. The errand is the
                // operator's, and it is the same errand every time.
                <p className="mt-1 text-2xs text-gated">
                  Ran without{' '}
                  {r.mcpDegraded.map((d) => `${d.id} (${d.detail ?? MCP_REASON[d.reason]})`).join(', ')}
                  {' — '}the session was told to record what it could not do.
                </p>
              ) : null}
              {r?.mcpPark && r.status === 'parked' ? <McpParkNote park={r.mcpPark} /> : null}
              {can.diagnose && <PhaseDrawer slug={slug} phase={p.phase} run={run} />}
              {/* Whatever did not fit, named and valued — never dropped in
                silence. This is the other end of the "+3" on the row. */}
              {open && folded.length > 0 && (
                <dl
                  className={cn(
                    'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs',
                    hasNote && 'mt-1.5',
                  )}
                >
                  {folded.map((c) => (
                    <div key={c.id} className="contents">
                      <dt className="uppercase tracking-wide text-ink-muted">{c.head}</dt>
                      <dd className="min-w-0">{cells[c.id]}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {open && (
                <div className={cn('max-w-prose', (hasNote || folded.length > 0) && 'mt-2')}>
                  <PhaseDetails slug={slug} phase={p} eta={eta} />
                </div>
              )}
            </>
          </TD>
        </TR>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * The phone shape — the same rows, as cards
 * ------------------------------------------------------------------------- */

/**
 * What survives when there is no room for twelve columns.
 *
 * The cut (`planColumns`) is honest on a laptop and useless at 390px: nine of
 * the twelve fold, so the phone got a three-column table whose remedies —
 * Retry, Recover, Run only this, QA, the whole reason the page is open on a
 * phone at 11pm — were behind a disclosure triangle on every row.
 *
 * A card instead, and the choice of facts is the point: the state, the name,
 * what this run has spent on it, who is on it, and the buttons. Everything the
 * table's other columns carry (deps, repos, size, turns, the notes, the whole
 * §Phase detail) is one tap away on the phase's own page, which the title
 * links to — so nothing is hidden, only deferred.
 *
 * The group headings stay, and stay collapsible, because the same preference
 * drives both shapes: an operator who folded Done away on a laptop has folded
 * it away here.
 */
function PhaseCards({
  groups,
  collapsed,
  onCollapsed,
  slug,
  run,
  live,
  allowRun,
  recovery,
  onRunAlone,
  queue,
  phaseEta,
  liveness,
  rulingCounts,
}: {
  groups: { id: string; label: string; hint: string; rows: MergedPhase[] }[];
  collapsed: string[];
  onCollapsed: (next: string[]) => void;
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  onRunAlone: (phase: number) => void;
  queue?: QueueEntry[] | undefined;
  phaseEta?: PhaseEta[] | undefined;
  liveness?: LaneLiveness[] | undefined;
  rulingCounts: Record<number, number>;
}) {
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      {groups.map((group) => {
        const shut = collapsed.includes(group.id);
        const listId = `phase-cards-${group.id}`;
        return (
          <section key={group.id}>
            <button
              type="button"
              aria-expanded={!shut}
              aria-controls={listId}
              className="flex w-full min-h-(--tap-min) cursor-pointer items-center gap-2 text-left"
              onClick={() =>
                onCollapsed(shut ? collapsed.filter((id) => id !== group.id) : [...collapsed, group.id])
              }
            >
              <span aria-hidden className="font-mono text-2xs text-ink-faint">
                {shut ? '▸' : '▾'}
              </span>
              <strong className="text-2xs uppercase tracking-wide">{group.label}</strong>
              <span className="font-mono text-2xs tabular-nums text-ink-faint">{group.rows.length}</span>
              <span className="min-w-0 truncate text-2xs text-ink-faint">{group.hint}</span>
            </button>
            <ul id={listId} className="flex flex-col gap-2">
              {!shut &&
                group.rows.map((p) => (
                  <PhaseCard
                    key={p.phase}
                    phase={p}
                    slug={slug}
                    run={run}
                    live={live}
                    allowRun={allowRun}
                    {...(recovery ? { recovery } : {})}
                    onRunAlone={onRunAlone}
                    entry={queueEntryFor(queue, slug, p.phase)}
                    eta={phaseEta?.find((e) => e.phase === p.phase)}
                    liveness={liveness?.find((l) => l.phase === p.phase)}
                    rulings={rulingCounts[p.phase] ?? 0}
                  />
                ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** One phase, at arm's length. */
function PhaseCard({
  phase: p,
  slug,
  run,
  live,
  allowRun,
  recovery,
  onRunAlone,
  entry,
  eta,
  liveness,
  rulings = 0,
}: {
  phase: MergedPhase;
  slug: string;
  run: RunState | null;
  live: boolean;
  allowRun: boolean;
  recovery?: PhaseRecovery;
  onRunAlone: (phase: number) => void;
  entry?: QueueEntry | undefined;
  eta?: PhaseEta | undefined;
  liveness?: LaneLiveness | undefined;
  rulings?: number;
}) {
  const r = p.record;
  const running =
    live && Boolean(r?.startedAt) && !r?.endedAt && (r?.status === 'running' || r?.status === 'verifying');
  const now = useNow(running);
  const showing = displayState(p.state, { running });
  const queued = r?.status === 'queued' || Boolean(entry);
  const took = r?.durationMs
    ? duration(r.durationMs)
    : running && r?.startedAt
      ? elapsed(now - Date.parse(r.startedAt))
      : (eta?.label ?? null);

  return (
    <ListRow
      lead={<PhaseStateChip slug={slug} phase={p.phase} state={showing} live={p.live} />}
      title={p.title}
      href={phaseHref(slug, p.phase)}
      hint={p.title}
      subtitle={
        <>
          P{pad2(p.phase)}
          {r ? ` · ${r.status}` : ' · not attempted'}
          {p.elsewhere ? ' · finished outside this run' : ''}
        </>
      }
      aside={
        <>
          {p.gated && (
            <Chip tone="gate" title={boardStateTitle('gated')}>
              gated
            </Chip>
          )}
          {queued && (
            <Chip tone="busy" title="Waiting on the scheduler for a scope something else is holding">
              {waitingLabel(entry)}
            </Chip>
          )}
          <QaVerdict qa={p.qa} />
          {p.proof && <EvidenceLine proof={p.proof} />}
          <LivenessChip liveness={liveness} />
          <RulingsChip count={rulings} />
          {/* …and a fifth, once a run can drive lanes on branches of their
              own: which branch THIS row's session is committing on. Read off
              the run's live children, keyed by phase like `phases` is —
              absent means the lane is on the run's own branch, which is every
              lane that did not take a worktree. */}
          <BranchChip branch={run?.children?.[String(p.phase)]?.branch} />
        </>
      }
      facts={
        <>
          {/* Money first: it is the one number nobody can recover after the
              fact, and the one an operator opens this page at midnight for. */}
          {r?.costUsd ? <span>{money(r.costUsd)}</span> : null}
          {r?.turns ? <span>{r.turns} turns</span> : null}
          {took ? <span>{took}</span> : null}
          <PhaseActorLine live={p.live} {...(p.lock ? { lock: p.lock } : {})} />
        </>
      }
      actions={
        <PhaseActions
          phase={p}
          slug={slug}
          run={run}
          live={live}
          allowRun={allowRun}
          onRunAlone={onRunAlone}
          {...(recovery ? { recovery } : {})}
        />
      }
    >
      {/* The runner's own last word about this phase, in full — it is the
          reason a card is red, and a title attribute is not reachable here. */}
      {r?.note && <p className="text-2xs text-ink-faint">{r.note}</p>}
    </ListRow>
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
    <p className="mt-1 text-2xs text-gated" data-testid="mcp-park">
      Parked on {servers} since {Number.isFinite(since) ? new Date(since).toLocaleTimeString() : park.at}
      {due
        ? ` — continues without ${park.degraded.length === 1 ? 'it' : 'them'} at ${due.toLocaleTimeString()} unless the server heals first (an errand is recorded then).`
        : ' — waits for the server to heal; no timeout is set (Settings ▸ Automation).'}
    </p>
  );
}
