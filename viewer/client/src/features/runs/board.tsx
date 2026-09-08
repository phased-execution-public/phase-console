/**
 * The orchestration board — the fleet at a glance, and under the thumb.
 *
 * ## The question the table could not answer
 *
 * `#/runs`'s fleet table is a record: every run there has ever been, sorted and
 * filtered, one row each. It is the right shape for "what happened" and the
 * wrong one for "what is happening" — a row cannot say that this run is queued
 * behind that one, and a table sorted by `updated` interleaves the two runs
 * actually moving with two hundred that finished last month. Every control the
 * operator wanted was on some other page: priority on the launch form, hold and
 * bump on an endpoint with no button, Freeze all in Settings, isolation in a
 * settings sheet.
 *
 * The board is the other reading of the same fleet: four columns —
 * **running · queued · waiting · frozen** — a card per live run, and every verb
 * that changes what happens next inline on the card that it acts on. It is a
 * VIEW of the fleet section, never a second section beside the table: the two
 * are one toggle apart (`prefs.runsView`) because drawing both is how a page
 * comes to say two things about one run.
 *
 * ## Composed, not rebuilt
 *
 * Nothing here is a new primitive, and that is the design. The columns are
 * `stripBuckets` (phase 18's one lane-status fold, via `nowLanes`); the lane
 * rows are `LaneFactRow`/`laneFacts` (the C2 vocabulary); the holder facts are
 * `waitingLabel`/`holderLabel` from the queued pane; the branch chip is phase
 * 10's `BranchChip`; the spend meter and the phase strip are `LoadMeter` and
 * `RunStrip`; the repair verbs are `RecoveryActions`; and **every** lifecycle
 * verb — the seven per-run ones and the two fleet-wide ones — goes through
 * `lib/run-lifecycle.ts`. `single-source.test.ts` fails the moment this file
 * mentions `api.runFreeze`, which is the point: phase 18 unified three copies
 * of those doors precisely so that this board would not be the fourth.
 *
 * What is genuinely new is the FOLD (`boardCards`) and the advisory
 * (`suggestedOrder`), both pure functions with no React in them.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ExternalLink, Hand, Pause, Play, Snowflake, Square } from 'lucide-react';

import { planHref } from '@shared/routes.js';
import {
  PRIORITY_LABELS,
  RUN_PRIORITIES,
  runPriority,
  type RunPriority,
} from '@shared/orchestration-model.js';
import { api, type ConsoleState, type QueueAdvice, type QueueEntry, type RunState } from '@/lib/api';
import { keys } from '@/lib/queries';
import { useRunLifecycle } from '@/lib/run-lifecycle';
import { FleetFreezeControl } from '@/components/fleet-freeze';
import { elapsed, money, plural, relativeTime, weight } from '@/lib/format';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { runStatusTitle, runUiState, type UiState } from '@/lib/status-vocab';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Button,
  Chip,
  Empty,
  Inspector,
  InspectorSection,
  KeyValue,
  MonoId,
  StatusBadge,
  StatusDot,
  field,
  toast,
} from '@/components/ui';
import { LoadMeter, RunStrip } from '@/components/charts';
import { LaneFactRow, laneFacts } from '@/components/lane-facts';
import { RecoveryActions } from '@/components/recovery-actions';
import { nowLanes, type NowLane } from '@/features/now/model';
import { BranchChip } from './git-card';
import { stripBuckets } from './live-strip';
import { holderLabel, queueEntryFor, waitingLabel } from './session-panes';
import { toRows, type RunRow } from './model';

/* ================================================================== *
 * The fold
 * ================================================================== */

/**
 * The four columns, and the dot each is painted with — ONE declaration.
 *
 * Deliberately four rather than `stripBuckets`'s six: the strip answers "how
 * bad is it" and needs `needs-you` and `failed` apart, while a board column is
 * a place a card SITS and an operator can only do four different things to a
 * run. `needs-you`, `failed` and `waiting` all mean "this one is not moving and
 * will not move by itself", which is one column with the reason on the card.
 *
 * The VALUE is the `UiState` the column's dot is painted with, never a hue —
 * `StatusDot` and `toneVar` own every colour in this app. `frozen` is not a UI
 * state (it is a lane fact laid over one), so it borrows `waiting`, which is
 * what a frozen run is from the fleet's point of view: not moving, and not
 * going to until somebody acts.
 *
 * ⚠️ **The column list is DERIVED from this map rather than written beside
 * it**, and that is not a style choice. Four of these words are also run
 * statuses, so a hand-written `['running', 'queued', 'waiting', 'frozen']`
 * reads — to `sweep.test.ts`'s guard and to the next person — as a fourth copy
 * of `LIVE_RUN_STATUSES`, the exact defect that guard exists for. Deriving
 * leaves one list, so the columns and their paint cannot disagree either.
 */
const COLUMN_STATES = {
  running: 'running',
  queued: 'queued',
  waiting: 'waiting',
  frozen: 'waiting',
} as const satisfies Record<string, UiState>;

export type BoardColumn = keyof typeof COLUMN_STATES;

export const BOARD_COLUMNS = Object.keys(COLUMN_STATES) as BoardColumn[];

export const COLUMN_LABELS: Record<BoardColumn, string> = {
  running: 'Running',
  queued: 'Queued',
  waiting: 'Waiting',
  frozen: 'Frozen',
};

export const COLUMN_BLURBS: Record<BoardColumn, string> = {
  running: 'A session is working right now.',
  queued: 'Admitted to the line, waiting for a scope or a slot.',
  waiting: 'Not moving, and not moving by itself — parked, gated, held or asking.',
  frozen: 'Stopped where it stood. Thawing continues mid-token.',
};

/** One run on the board: the run, its rows worth of figures, and its lanes. */
export interface BoardCard {
  run: RunState;
  /** The fleet table's own derivation — spend fraction, phases, retries. */
  row: RunRow;
  /** Every lane of this run, from the ONE `nowLanes` fold the page drew. */
  lanes: NowLane[];
  /** The admission entry for a queued lane, when the queue snapshot has one. */
  entry?: QueueEntry;
  column: BoardColumn;
}

/**
 * Which column a run sits in.
 *
 * Frozen first, and that ordering is the whole rule: a frozen run's lanes keep
 * whatever status they had when the operator stopped them, so asking "is
 * anything running" first would file a frozen run under Running and offer it a
 * Stop where it wants a Thaw. After that the columns are `stripBuckets` read
 * worst-last: a run with anything actually moving is Running however much else
 * of it is waiting, because that is the run whose clock is spending money.
 *
 * ⚠️ **A frozen LANE does not freeze the run.** A three-lane run with one lane
 * under SIGSTOP is still running — it is the run-level slot, or every lane
 * being frozen, that puts a card in the Frozen column. The per-lane fact still
 * shows on the lane row, which is where it belongs.
 */
export function columnOf(run: RunState, lanes: readonly NowLane[]): BoardColumn {
  const frozen = run.status === 'frozen' || Boolean(run.freeze);
  if (frozen || (lanes.length > 0 && lanes.every((lane) => lane.frozen))) return 'frozen';
  const buckets = stripBuckets(lanes);
  if (buckets.running.length || buckets.verifying.length) return 'running';
  if (buckets.queued.length) return 'queued';
  return 'waiting';
}

/**
 * Every run the board draws, with its lanes and its queue entry attached.
 *
 * The lane list is a PARAMETER rather than something this recomputes, for the
 * reason phase 18 made `LANE_STATUSES` one list: the page already folded
 * `nowLanes(runs)` for its strip, and a board that folded again could draw a
 * lane the strip above it does not, on the same screen. `isLiveRun` is not
 * re-tested here either — a run with no lane in that fold is one `nowLanes`
 * dropped, and it gets no card.
 */
export function boardCards(
  runs: readonly RunState[],
  lanes: readonly NowLane[],
  entries?: readonly QueueEntry[],
): BoardCard[] {
  const byRun = new Map<string, NowLane[]>();
  for (const lane of lanes) {
    const list = byRun.get(lane.runId);
    if (list) list.push(lane);
    else byRun.set(lane.runId, [lane]);
  }

  const cards: BoardCard[] = [];
  for (const run of runs) {
    const mine = byRun.get(run.id);
    if (!mine?.length) continue;
    const row = toRows([run])[0];
    if (!row) continue;
    const queued = mine.find((lane) => lane.status === 'queued');
    const entry = queued ? queueEntryFor(entries, run.slug, queued.phase) : undefined;
    cards.push({
      run,
      row,
      lanes: mine,
      ...(entry ? { entry } : {}),
      column: columnOf(run, mine),
    });
  }
  return cards;
}

/** The cards of one column, in the order `nowLanes` already ranked them. */
export function columnCards(cards: readonly BoardCard[], column: BoardColumn): BoardCard[] {
  return cards.filter((card) => card.column === column);
}

/* ================================================================== *
 * The advisory
 * ================================================================== */

/**
 * Which queued plan it would cost least to let go first — advice, never an act.
 *
 * The scheduler does not reorder itself and this does not ask it to. It reads
 * `/api/queue`'s own `advice[]` (remaining weight per queued plan, measured
 * from what that plan has already spent) and names the LIGHTEST one, because
 * finishing the short plan first is the ordering that leaves every other plan
 * waiting the least. Applying it is the operator raising that plan's priority
 * class, which is an input to the same first-fit scan as ever.
 *
 * Three ways it declines to say anything, all deliberate:
 *  - fewer than two queued plans — there is no order to suggest;
 *  - no measured weight for the leader — an estimate exists only once
 *    something of that plan has finished, and a made-up number on this line
 *    would be indistinguishable from a measured one;
 *  - the lightest plan is ALREADY at the head of the scan — suggesting the
 *    order that already holds is how an advisory becomes noise.
 */
export interface OrderAdvice {
  /** The plan to let go first. */
  slug: string;
  /** Its measured remaining weight, in tokens. */
  remainingWeight: number;
  /** The plan currently at the head of the scan, which this would move behind. */
  ahead: string;
  /** Every other queued plan — the ones an apply would put back to `normal`. */
  demote: string[];
}

export function suggestedOrder(
  entries: readonly QueueEntry[] | undefined,
  advice: readonly QueueAdvice[] | undefined,
): OrderAdvice | null {
  const order: string[] = [];
  for (const entry of entries ?? []) if (!order.includes(entry.slug)) order.push(entry.slug);
  if (order.length < 2) return null;

  const weights = new Map<string, number>();
  for (const row of advice ?? []) {
    if (row.remainingWeight != null && row.remainingWeight > 0) weights.set(row.slug, row.remainingWeight);
  }

  // Ties keep the scan's own order, so a suggestion is never a coin toss the
  // operator cannot see the reason for.
  const ranked = order.filter((slug) => weights.has(slug));
  if (ranked.length < 2) return null;
  const lightest = ranked.reduce((best, slug) => (weights.get(slug)! < weights.get(best)! ? slug : best));
  if (lightest === order[0]) return null;

  return {
    slug: lightest,
    remainingWeight: weights.get(lightest)!,
    ahead: order[0],
    demote: order.filter((slug) => slug !== lightest),
  };
}

/* ================================================================== *
 * The header
 * ================================================================== */

/**
 * How full the console is, whether it is switched off, and the switch.
 *
 * `state.concurrency` has been on `/api/state` since the pool existed and
 * NOTHING has ever drawn it: the one figure that says whether a queue is a
 * queue or a cap. It is here because this is the surface where the answer
 * changes what you do — three of three lanes in use and four queued is a
 * different day from one of three.
 */
export function BoardHeader({
  state,
  queued,
}: {
  state: ConsoleState | undefined;
  /** Cards in the Queued column — what the operator can actually see waiting. */
  queued: number;
}) {
  // No `allowRun` prop: the only thing it gated here was the freeze pair, and
  // that now lives in `FleetFreezeControl`, which reads the flag off the state
  // itself. Passing it in as well would be a second copy of one fact — and the
  // copy is the half that goes stale.
  const fleet = state?.fleet ?? { frozen: false, at: null, by: null };
  const concurrency = state?.concurrency;
  const live = concurrency?.live ?? 0;
  const max = concurrency?.max ?? 0;
  const schedule = concurrency?.schedule;
  const at = fleet.at ? Date.parse(fleet.at) : NaN;

  return (
    <div
      data-testid="board-header"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-rule bg-surface px-3 py-2"
    >
      <span className="flex items-center gap-1.5 text-2xs text-ink-muted">
        <StatusDot state="running" pulse={live > 0 && !fleet.frozen} />
        <span>lanes</span>
        <span className="font-mono tabular-nums text-ink" data-testid="board-lanes">
          {max ? `${live}/${max}` : String(live)}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-2xs text-ink-muted">
        <StatusDot state="queued" />
        <span>queued</span>
        <span className="font-mono tabular-nums text-ink">{concurrency?.queued ?? queued}</span>
      </span>
      {/* The boarding schedule, reported even when OPEN — a header that only
          speaks up once a phase has failed to start is a header that tells you
          after it mattered. */}
      {schedule && (
        <span className="text-2xs text-ink-muted" data-testid="board-schedule">
          {schedule.open
            ? 'boarding open'
            : `boarding closed${
                schedule.opensAt ? ` — opens ${relativeTime(schedule.opensAt)}` : ''
              }${schedule.reason ? ` (${schedule.reason})` : ''}`}
        </span>
      )}
      {concurrency?.throttledUntil != null && (
        <span className="text-2xs text-attention" data-testid="board-throttle">
          usage window until {relativeTime(concurrency.throttledUntil)}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2">
        {fleet.frozen && (
          <Chip tone="gate" dot data-testid="board-frozen-chip">
            <Snowflake size={11} aria-hidden /> frozen
            {Number.isFinite(at) ? ` ${relativeTime(at)}` : ''}
            {fleet.by ? ` by ${fleet.by}` : ''}
          </Chip>
        )}
        {/* The shared control, not a second implementation of the act.
            `components/fleet-freeze.tsx` named this header as its real home and
            this header then grew its own copy over the same hook — three render
            sites, two behaviours, and a comment promising one. `confirm` is the
            only thing the two ever disagreed about. `allowRun` is checked
            inside it, so the guard is not duplicated either. */}
        <FleetFreezeControl confirm />
      </span>
    </div>
  );
}

/* ================================================================== *
 * The card
 * ================================================================== */

/** A lifecycle verb's button, so seven of them are one shape. */
function VerbButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  destructive,
  title,
}: {
  label: string;
  icon: typeof Snowflake;
  onClick: () => void;
  disabled: boolean;
  destructive?: boolean;
  title: string;
}) {
  return (
    <Button
      size="sm"
      variant={destructive ? 'danger' : 'ghost'}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      <Icon size={13} aria-hidden /> {label}
    </Button>
  );
}

/**
 * One run.
 *
 * The queue entry is read off the CARD, never re-looked-up from the snapshot:
 * `boardCards` already attached the one that belongs to this run's queued lane,
 * and a second lookup here is the shape that lets a card's chips and its column
 * disagree about which entry they are talking about.
 */
export function BoardCardView({ card, allowRun }: { card: BoardCard; allowRun: boolean }) {
  const { run, row, lanes, entry } = card;
  const client = useQueryClient();
  const lifecycle = useRunLifecycle(run.slug, undefined, {
    queued: card.column === 'queued',
  });
  const [pending, setPending] = useState<string | null>(null);
  const anyLive = lanes.some(
    (lane) => !lane.frozen && (lane.status === 'running' || lane.status === 'verifying'),
  );
  const now = useNow(anyLive);
  const held = Boolean(run.hold);
  const priority = runPriority(run.priority);
  const busy = lifecycle.busy != null || pending != null;
  const [inspecting, setInspecting] = useState(false);

  /**
   * The three settings verbs — priority, isolation, and the bump — are NOT
   * lifecycle doors, so they do not go through `useRunLifecycle`. They share
   * its shape deliberately: one busy word, one toast, and the same invalidation
   * the hook performs, because a card that changed a setting and did not
   * re-read would show the operator their old answer.
   */
  const settings = useCallback(
    async (what: string, act: () => Promise<unknown>, sentence: string) => {
      setPending(what);
      try {
        await act();
        toast(sentence, 'ok');
      } catch (error) {
        toast(String((error as Error)?.message ?? error), 'error');
      } finally {
        setPending(null);
        void client.invalidateQueries({ queryKey: keys.runs() });
        void client.invalidateQueries({ queryKey: keys.run(run.slug) });
        void client.invalidateQueries({ queryKey: keys.queue() });
        void client.invalidateQueries({ queryKey: keys.state() });
      }
    },
    [client, run.slug],
  );

  return (
    <article
      data-testid="board-card"
      data-slug={run.slug}
      data-column={card.column}
      className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-3 shadow-card"
    >
      <header className="flex flex-wrap items-center gap-2">
        <a
          href={planHref(run.slug, 'run')}
          className="min-w-0 truncate font-mono text-sm hover:underline"
          title={`Open ${run.slug}'s autopilot`}
        >
          {run.slug}
        </a>
        <StatusBadge
          state={runUiState(run.status)}
          label={run.status}
          mono
          pulse={row.live && !row.frozen}
          title={runStatusTitle(run.status)}
        />
        {held && (
          <Chip
            tone="gate"
            dot
            data-testid="hold-chip"
            title={`Held${run.hold?.by ? ` by ${run.hold.by}` : ''} — nothing new is admitted`}
          >
            <Hand size={11} aria-hidden /> held
          </Chip>
        )}
        {priority !== 'normal' && (
          <Chip tone={priority === 'high' ? 'busy' : 'neutral'} data-testid="priority-chip">
            {priority} priority
          </Chip>
        )}
        {entry?.bumped && (
          <Chip tone="busy" data-testid="bumped-chip">
            bumped
          </Chip>
        )}
        {run.startAfter && (
          <Chip
            tone="neutral"
            data-testid="after-chip"
            title={`This run boards after ${run.startAfter} settles`}
          >
            after {run.startAfter}
          </Chip>
        )}
        {/* What it GOT, never what it asked for. `checkout` alone is not "a
            tree exists right now" (phase 6): the path is `workRoot`, and the
            BRANCH is a lane's fact, drawn on the lane row below where it is
            true. Inventing `pe/<slug>` here would be a chip that is right most
            of the time, which is the worst kind. */}
        {run.checkout === 'worktree' && (
          <Chip
            tone="neutral"
            data-testid="checkout-chip"
            title={
              run.mountedRepos?.length
                ? `${run.workRoot ?? 'a console-managed mirror'} — ${run.mountedRepos.join(', ')}`
                : (run.workRoot ?? 'a console-managed checkout')
            }
          >
            {run.mountedRepos?.length ? `own checkout · ${run.mountedRepos.length} repos` : 'own checkout'}
          </Chip>
        )}
        {run.checkout === 'refused' && (
          <Chip
            tone="warn"
            data-testid="refused-chip"
            title={run.isolationRefusal ?? 'isolation was refused'}
          >
            shared checkout
          </Chip>
        )}
        {/* L2, then L3. The `Inspector` primitive and its `raw` slot shipped in
            phase 3 with the disclosure ladder and had NO consumer anywhere in
            the client — so "an L3 raw view exists" was true of the kit and
            false of every page. A run card is where it is most owed: the card
            shows the eight facts that decide whether to care, and the record
            behind it has forty. */}
        <button
          type="button"
          onClick={() => setInspecting(true)}
          className="ml-auto shrink-0 text-2xs text-ink-faint hover:text-action [@media(hover:none)]:min-h-(--tap-min)"
          title="Everything this console knows about this run"
        >
          inspect
        </button>
        <a
          href={planHref(run.slug, 'run')}
          className="shrink-0 text-2xs text-ink-faint hover:text-action"
          title="Open the run page"
        >
          <ExternalLink size={13} aria-hidden /> open
        </a>
      </header>

      <Inspector
        open={inspecting}
        onOpenChange={setInspecting}
        title={run.slug}
        description={`Run ${run.id} — ${row.phases.length} phase${row.phases.length === 1 ? '' : 's'} on record.`}
        meta={
          <>
            <StatusBadge state={runUiState(run.status)} label={run.status} />
            <MonoId id={run.id} />
            {run.model && (
              <Chip tone="neutral" mono>
                {run.model}
              </Chip>
            )}
          </>
        }
        raw={<pre className="font-mono text-2xs whitespace-pre-wrap">{JSON.stringify(run, null, 2)}</pre>}
      >
        <InspectorSection heading="Where it works">
          <KeyValue
            items={[
              ['Root', run.root],
              // `checkout` is what it GOT, never what it asked for — and the
              // refusal reason is the half an operator actually needs.
              [
                'Checkout',
                run.checkout === 'worktree'
                  ? (run.workRoot ?? 'a console-managed checkout')
                  : run.checkout === 'refused'
                    ? `shared — ${run.isolationRefusal ?? 'isolation was refused'}`
                    : 'the shared root',
              ],
              Boolean(run.gitMode) && (['Git mode', String(run.gitMode)] as const),
              Boolean(run.startAfter) && (['Chained after', String(run.startAfter)] as const),
            ]}
          />
        </InspectorSection>
        <InspectorSection heading="What it is spending">
          <KeyValue
            items={[
              ['Spent', money(run.spentUsd ?? 0)],
              ['Phase budget', run.phaseBudgetUsd == null ? 'no ceiling' : money(run.phaseBudgetUsd)],
              ['Run budget', run.runBudgetUsd == null ? 'no ceiling' : money(run.runBudgetUsd)],
              [
                'Consecutive failures',
                `${run.consecutiveFailures ?? 0} of ${run.maxConsecutiveFailures ?? '—'}`,
              ],
            ]}
          />
        </InspectorSection>
      </Inspector>

      {row.phases.length > 0 && (
        <RunStrip
          phases={row.phases.map((p) => ({
            phase: p.phase,
            status: p.status,
            ...(p.lifecycle?.stop ? { stop: p.lifecycle.stop } : {}),
          }))}
        />
      )}

      <ul className="flex flex-col gap-1">
        {lanes.map((lane) => (
          <li
            key={lane.key}
            data-testid="board-lane"
            className={cn(
              'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border-l-4 bg-ground-deep/50 px-2 py-1.5',
              lane.frozen ? 'border-gated' : 'border-progress',
            )}
          >
            <span className="font-mono text-2xs tabular-nums text-ink">P{lane.phase}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted">
              {lane.title ?? lane.status}
            </span>
            {/* Phase 10's rule, unchanged: sourced from the LANE's child, where
                absent means "the run's own branch" — so the chip appears
                exactly when there is something to tell apart. */}
            <BranchChip branch={lane.child?.branch} />
            {/* The lane fact row, in the one order — never re-picked here. */}
            <LaneFactRow facts={laneFacts(lane)} live={!lane.frozen} className="ml-auto" />
          </li>
        ))}
      </ul>

      {/* Why it is not moving, in the queue's own words — the same
          `waitingLabel` the fleet table's cell and the queued pane read, so a
          card and a pane never disagree about who is holding what. */}
      {card.column === 'queued' && (
        <p className="text-2xs text-ink-faint" data-testid="board-holder">
          {waitingLabel(entry)}
          {entry ? ` · ${elapsed(Math.max(0, now - entry.since))}` : ''}
          {/* Both halves when both are known — "you: pe/x · them: pe/y" is the
              first question once two trees are in play (D-E). */}
          {entry?.branch && entry?.waitingOn?.[0]?.branch
            ? ` · you ${entry.branch} · them ${entry.waitingOn[0].branch}`
            : entry?.waitingOn?.[0]?.branch
              ? ` · on ${entry.waitingOn[0].branch}`
              : ''}
          {/* …and HOW LONG the holder has left, when its plan has enough
              history to say. Absent is a real answer and stays silent: a plan
              with nothing finished has no measurable rate, and a number
              invented here would read exactly like a measured one. */}
          {entry?.waitingOn?.[0]?.eta?.label ? ` · they have ${entry.waitingOn[0].eta.label}` : ''}
        </p>
      )}
      {card.column === 'queued' && entry && entry.waitingOn.length > 1 && (
        <p className="text-2xs text-ink-faint">
          Also behind{' '}
          {entry.waitingOn
            .slice(1)
            .map((h) => holderLabel(h.kind, h.slug, h.phase))
            .join(', ')}
          .
        </p>
      )}
      {entry?.held && (
        <p className="text-2xs text-ink-faint" data-testid="board-held-note">
          Held since {relativeTime(Date.parse(entry.held.at))}
          {entry.held.by ? ` by ${entry.held.by}` : ''} — release it to let this line move.
        </p>
      )}
      {entry?.after && (
        <p className="text-2xs text-ink-faint">Chained behind {entry.after}, which has not settled.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <LoadMeter
          className="min-w-24 max-w-40 flex-1"
          fraction={row.spendFraction}
          label={money(row.spentUsd)}
          description={
            row.budgetUsd
              ? `${money(row.spentUsd)} of a ${money(row.budgetUsd)} run budget`
              : `${money(row.spentUsd)}, no run budget set`
          }
          tone={row.overBudget ? 'failed' : 'running'}
        />
        <span className="font-mono text-2xs tabular-nums text-ink-faint">
          {row.phasesDone}/{row.phases.length} phases
        </span>
      </div>

      {allowRun && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-rule pt-2">
          {card.column === 'frozen' ? (
            <VerbButton
              label="Thaw"
              icon={Play}
              disabled={busy}
              onClick={() => void lifecycle.thaw()}
              title="Continue — the session picks up mid-token"
            />
          ) : (
            <VerbButton
              label="Freeze"
              icon={Snowflake}
              disabled={busy}
              onClick={() => void lifecycle.freeze()}
              title="Stop every session of this run where it stands"
            />
          )}
          {run.status === 'pausing' ? (
            <VerbButton
              label="Cancel pause"
              icon={Play}
              disabled={busy}
              onClick={() => void lifecycle.resume()}
              title="Carry on past the next phase boundary"
            />
          ) : (
            <VerbButton
              label="Pause"
              icon={Pause}
              disabled={busy}
              onClick={() => void lifecycle.pause()}
              title="Stop at the next phase boundary"
            />
          )}
          {held ? (
            <VerbButton
              label="Release"
              icon={Play}
              disabled={busy}
              onClick={() => void lifecycle.release()}
              title="Let this run be admitted again"
            />
          ) : (
            <VerbButton
              label="Hold"
              icon={Hand}
              disabled={busy}
              onClick={() => void lifecycle.hold()}
              title="The running phases finish; nothing new is admitted"
            />
          )}
          {entry && !entry.bumped && (
            <VerbButton
              label="Bump"
              icon={ArrowUp}
              disabled={busy}
              onClick={() =>
                void settings(
                  'bump',
                  () => api.queueBump(entry.id),
                  `${run.slug} moved to the front of its class`,
                )
              }
              title="To the front of its own priority class — never across one"
            />
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="danger" disabled={busy}>
                <Square size={13} aria-hidden /> Stop
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent
              title={`Stop ${run.slug}?`}
              description={
                card.column === 'queued'
                  ? 'This takes it out of the line. Nothing is killed — Retry can put the phase back.'
                  : 'Its sessions get SIGTERM and the run winds down. Work already committed stays committed.'
              }
              confirmLabel="Stop the run"
              destructive
              onConfirm={() => void lifecycle.stop()}
            />
          </AlertDialog>

          <label className="ml-auto flex items-center gap-1.5 text-2xs text-ink-faint">
            <span>priority</span>
            <select
              aria-label={`Queue priority for ${run.slug}`}
              className={cn(field, 'h-7 py-0 text-2xs')}
              disabled={busy}
              value={priority}
              onChange={(event) => {
                const next = event.target.value as RunPriority;
                void settings(
                  'priority',
                  () => api.runSettings(run.slug, { priority: next }),
                  `${run.slug} is ${next} priority`,
                );
              }}
            >
              {RUN_PRIORITIES.map((value) => (
                <option key={value} value={value} title={PRIORITY_LABELS[value]}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          {/* Isolation is ONE WAY mid-run (phase 5): a raise is ignored by
              `applySettings` and 409s at the route, so the card offers the drop
              and never the raise — a control that can only fail is worse than
              no control. */}
          {run.checkout === 'worktree' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Give up this run's own checkout — its next phase works in the shared tree, queued"
              onClick={() =>
                void settings(
                  'isolation',
                  () => api.runSettings(run.slug, { isolation: 'queue' }),
                  `${run.slug} will use the shared checkout from its next phase`,
                )
              }
            >
              Drop isolation
            </Button>
          )}
        </div>
      )}

      {/* The repair verbs, exactly where the classes apply — never re-derived:
          `RecoveryActions` decides which of them this run's state offers, and
          renders nothing when none of them does. No `perform` is passed: the
          surface-owned verbs (dismiss, force-release) belong to the run page,
          which has the room to explain them. */}
      {(card.column === 'waiting' || row.halt) && (
        <RecoveryActions target={{ slug: run.slug, runId: run.id }} ctx={{ run }} max={2} />
      )}
    </article>
  );
}

/* ================================================================== *
 * The board
 * ================================================================== */

export function RunsBoard({
  runs,
  state,
  entries,
  advice,
  allowRun,
  onShowTable,
  totalRuns,
}: {
  runs: readonly RunState[];
  state: ConsoleState | undefined;
  entries?: readonly QueueEntry[];
  advice?: readonly QueueAdvice[];
  allowRun: boolean;
  /** The board's empty state points at the table rather than at nothing. */
  /** Absent where there is no table to show — the free tree has only the board. */
  onShowTable?: () => void;
  /** How many runs the table would show — the empty state's one honest number. */
  totalRuns: number;
}) {
  const client = useQueryClient();
  const [applying, setApplying] = useState(false);
  const lanes = useMemo(() => nowLanes(runs), [runs]);
  const cards = useMemo(() => boardCards(runs, lanes, entries), [runs, lanes, entries]);
  const order = useMemo(() => suggestedOrder(entries, advice), [entries, advice]);
  const queued = columnCards(cards, 'queued').length;

  /**
   * Apply the advisory: raise the suggested plan, put the other queued plans
   * back to `normal`.
   *
   * Three classes cannot express an N-way ordering, and pretending otherwise is
   * the failure this avoids — it raises ONE plan and levels the rest, which is
   * exactly what the sentence beside the button says it does. Nothing is
   * reordered by the console: the scan runs as it always did, with one class
   * changed.
   */
  const apply = useCallback(async () => {
    if (!order) return;
    setApplying(true);
    try {
      await api.runSettings(order.slug, { priority: 'high' });
      for (const slug of order.demote) await api.runSettings(slug, { priority: 'normal' });
      toast(`${order.slug} raised to high — the other queued plans are normal`, 'ok');
    } catch (error) {
      toast(String((error as Error)?.message ?? error), 'error');
    } finally {
      setApplying(false);
      void client.invalidateQueries({ queryKey: keys.runs() });
      void client.invalidateQueries({ queryKey: keys.queue() });
      void client.invalidateQueries({ queryKey: keys.state() });
    }
  }, [client, order]);

  return (
    <div className="flex flex-col gap-3" data-testid="runs-board">
      <BoardHeader state={state} queued={queued} />

      {order && (
        <div
          data-testid="board-advice"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface-raised px-3 py-2 text-2xs text-ink-muted"
        >
          <span className="min-w-0 flex-1">
            Suggested order: let <b className="font-mono">{order.slug}</b> go first —{' '}
            {weight(order.remainingWeight)} of work left, against <b className="font-mono">{order.ahead}</b>{' '}
            at the head of the scan. Applying raises it to <b>high</b> and puts the other{' '}
            {plural(order.demote.length, 'queued plan')} back to <b>normal</b>; nothing is reordered.
          </span>
          {allowRun && (
            <Button size="sm" variant="ghost" disabled={applying} onClick={() => void apply()}>
              Apply
            </Button>
          )}
        </div>
      )}

      {cards.length === 0 ? (
        <Empty
          title="Nothing is live"
          body={
            totalRuns
              ? `The board draws the runs a session is behind right now. ${plural(totalRuns, 'run')} ${totalRuns === 1 ? 'is' : 'are'} on record${onShowTable ? ' — the table has all of them' : ''}.`
              : 'The board draws the runs a session is behind right now. Nothing has run in this source yet.'
          }
          action={
            onShowTable ? (
              <button
                type="button"
                className="tap-line text-sm text-action hover:underline"
                onClick={onShowTable}
              >
                Show the table
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {BOARD_COLUMNS.map((column) => {
            const mine = columnCards(cards, column);
            return (
              <section
                key={column}
                aria-label={COLUMN_LABELS[column]}
                data-testid="board-column"
                data-column={column}
                className="flex min-w-0 flex-col gap-2"
              >
                <header className="flex items-center gap-1.5 px-1">
                  <StatusDot state={COLUMN_STATES[column]} pulse={column === 'running' && mine.length > 0} />
                  <span className="text-2xs font-medium text-ink">{COLUMN_LABELS[column]}</span>
                  <span className="font-mono text-2xs tabular-nums text-ink-faint">{mine.length}</span>
                </header>
                {mine.length === 0 ? (
                  <p className="px-1 text-2xs text-ink-faint">{COLUMN_BLURBS[column]}</p>
                ) : (
                  mine.map((card) => <BoardCardView key={card.run.id} card={card} allowRun={allowRun} />)
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The board / table switch, shown in both shapes so neither is a dead end. */
export function BoardToggle({
  view,
  onView,
}: {
  view: 'board' | 'table';
  onView: (next: 'board' | 'table') => void;
}) {
  // The table compares many runs side by side, which IS the fleet — Pro. With
  // one destination there is nothing to switch to, so this draws nothing rather
  // than a control that cannot move.
  const VIEWS: Array<'board' | 'table'> = [
    'board',
  ];
  if (VIEWS.length < 2) return null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Fleet view">
      {VIEWS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onView(value)}
          className={cn(
            'rounded-md px-2 py-1 text-2xs [@media(hover:none)]:min-h-(--tap-min)',
            view === value ? 'bg-surface-raised text-ink' : 'text-ink-faint hover:text-action',
          )}
        >
          {value === 'board' ? 'Board' : 'Table'}
        </button>
      ))}
    </div>
  );
}
