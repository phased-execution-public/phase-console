/**
 * The Run view's head (7.0, quiet-console phase 11; design.md principle 2).
 *
 * The run's row, exactly as the Runs home draws it — the mark and its word,
 * the plan, the track, ONE labelled clock, how far, what it cost and the ONE
 * action, the halt view first (#278) — so the home and the run's own page can
 * never offer different moves for one run. Here the row is a header: the page
 * below is its expansion, so it neither folds nor links to itself, and its
 * last cell is Inspect.
 *
 * Under it, the facts the row does not carry, as words on two quiet lines: the
 * operator's side (what it waits on, who pays, which phases hold lanes, the
 * phase's total against its estimate, the branch) and the record's (the run
 * id, its own clock, the ETA, the promise to run to completion, the failure
 * streak, the spend, the model). Every duration is a labelled clock (#28).
 *
 * The row is placed from the WHOLE record this page already holds — through
 * the home's own fold (`groupRuns`), never a second reading of it — so the
 * head moves with every `run:*` event the view is re-read on.
 */

import { useMemo } from 'react';
import { PHASE_CLOCK_LABELS } from '@shared/phase-clocks.js';
import { waitNote } from '@shared/status-model.js';
import type { ConsoleState, EtaEstimate, LaneLiveness, PhaseEta, PlanDetail, RunState } from '@/data/api';
import { useAccounts } from '@/data/accounts';
import { useAttentionInbox } from '@/data/inbox';
import { lanesOf } from '@/data/lanes';
import { useQueue } from '@/data/queue';
import { groupRuns, type PlacedRun } from '@/data/run-groups';
import { clockWords, etaLabel, etaPoint, etaTitle, money } from '@/lib/format';
import { Mono, RelativeTime } from '@/ui';
import { recordClocks } from '@/screens/runs/model';
import { RunRow } from '@/screens/runs/run-row';

/** This run, placed by the home's fold — the row's input — from the record the view holds. */
function usePlacedHere(run: RunState, detail: PlanDetail, now: number): PlacedRun | null {
  const queued = Object.values(run.children ?? {}).length === 0 && run.status === 'queued';
  const lanesQueued = lanesOf([run], new Map([[detail.summary.slug, detail]]), now).some(
    (lane) => lane.status === 'queued',
  );
  const { data: queue } = useQueue(queued || lanesQueued);
  const { data: inbox } = useAttentionInbox(false);
  return useMemo(() => {
    const details = new Map([[detail.summary.slug, detail]]);
    const model = groupRuns({
      runs: [run],
      lanes: lanesOf([run], details, now),
      entries: queue?.entries,
      inbox: inbox?.items,
      closedSlugs: detail.summary.closed ? new Set([detail.summary.slug]) : new Set(),
      now,
    });
    return model.runs[0] ?? null;
  }, [run, detail, now, queue?.entries, inbox?.items]);
}

/** The phases holding a live session, lowest first — the pool's own record, else the one-lane mirror. */
export function livePhases(run: RunState): number[] {
  const lanes = Object.values(run.children ?? {});
  const phases = lanes.length ? lanes.map((lane) => lane.phase) : run.child ? [run.child.phase] : [];
  return [...new Set(phases)].sort((a, b) => a - b);
}

export function RunGlance({
  run,
  detail,
  state,
  allowRun,
  live,
  now,
  eta,
  phaseEta = [],
  liveness = [],
  onInspect,
  onAct,
}: {
  run: RunState;
  detail: PlanDetail;
  state: ConsoleState | undefined;
  allowRun: boolean;
  live: boolean;
  now: number;
  eta: EtaEstimate | null;
  phaseEta?: PhaseEta[];
  liveness?: LaneLiveness[];
  onInspect: () => void;
  /** A verb that needs words or a dialog: the view takes it to the halt card, where they are asked. */
  onAct: () => void;
}) {
  const placed = usePlacedHere(run, detail, now);
  return (
    <header className="flex min-w-0 flex-col gap-2" data-testid="run-head">
      {placed && (
        <RunRow
          placed={placed}
          allowRun={allowRun}
          state={state}
          record={run}
          variant="header"
          onInspect={onInspect}
          onAct={onAct}
        />
      )}
      <RunFacts run={run} live={live} now={now} eta={eta} phaseEta={phaseEta} liveness={liveness} />
    </header>
  );
}

/**
 * The facts the row does not carry, as words. How far the run has got is the
 * row's own (done of the run's phases), and how far the plan has is the plan's
 * glance above: a third count here, of this run's records against the plan's
 * total, said neither.
 */
function RunFacts({
  run,
  live,
  now,
  eta,
  phaseEta,
  liveness,
}: {
  run: RunState;
  live: boolean;
  now: number;
  eta: EtaEstimate | null;
  phaseEta: PhaseEta[];
  liveness: LaneLiveness[];
}) {
  const ticking = live && run.status !== 'frozen';
  const { data: accountsState } = useAccounts();
  const account = run.accountId
    ? (() => {
        const view = accountsState?.accounts.find((candidate) => candidate.id === run.accountId);
        return view ? (view.name ?? view.email ?? view.id) : run.accountId;
      })()
    : (() => {
        const login = accountsState?.accounts.find((candidate) => candidate.id === 'default');
        return login?.email ? `the machine login, ${login.email}` : 'the machine login';
      })();

  const runMs = (ticking ? now : Date.parse(run.updatedAt)) - Date.parse(run.createdAt);
  const lanes = livePhases(run);
  // The phase the row's clock is about — the lane moving now, else the stop,
  // else the active one — and its total over every attempt beside it (#28).
  const totalPhase = lanes[0] ?? run.halt?.phase ?? run.activePhase ?? undefined;
  const totalRecord = totalPhase != null ? run.phases?.[String(totalPhase)] : undefined;
  const worked = totalRecord && (live || run.halt) ? recordClocks(totalRecord, now).workedMs : null;
  const estimate = totalPhase != null ? phaseEta.find((p) => p.phase === totalPhase) : undefined;
  const records = Object.values(run.phases ?? {});
  const liveUsd = liveness.reduce((sum, lane) => sum + (lane.spentUsd ?? 0), 0);
  const lost = records.filter((record) => record?.costUnknown).map((record) => record!.phase);
  const waiting = waitNote(run as Parameters<typeof waitNote>[0]);
  const resolved = run.resolvedModels?.[run.model ?? 'default'];
  const limits = run.limits;

  return (
    <div className="flex min-w-0 flex-col gap-1 text-meta" data-testid="run-facts">
      {waiting && (
        <p className="min-w-0 break-words text-ink-muted" data-testid="run-wait-note">
          {waiting}
        </p>
      )}
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-ink-muted">
        <span data-testid="run-spent">
          Spent <span className="tnum text-ink">{money(run.spentUsd)}</span>
          {run.runBudgetUsd ? ` of ${money(run.runBudgetUsd)}` : ', no run budget'}
          {liveUsd > 0 && `, ${money(liveUsd)} more in flight`}
          {lost.length > 0 && `, at least: phase ${lost.join(', ')} never reported its spend`}
        </span>
        <span data-testid="run-model" title={`${run.autonomy}, ${run.modelPolicy ?? 'ladder'} model policy`}>
          {run.model}
          {run.effort ? ` at ${run.effort} effort` : ''}
          {resolved ? `, resolves to ${resolved.resolved}` : ''}
          {resolved?.from ? `, moved from ${resolved.from}` : ''}
          {run.modelPolicy === 'pinned' ? ', pinned' : ''}
        </span>
        <span data-testid="run-account" title="Which account this run's sessions spend">
          Pays: {account}
        </span>
        {lanes.length > 1 ? (
          <span>
            {lanes.length} lanes, phases {lanes.join(', ')}
          </span>
        ) : (
          run.activePhase != null && <span>phase {run.activePhase}</span>
        )}
        {worked != null && (
          <span className="tnum" data-testid="run-phase-total">
            phase total{' '}
            {clockWords({ verb: 'worked', ms: worked, tense: 'for', label: PHASE_CLOCK_LABELS.workedMs })}
            {estimate?.estMs
              ? worked > estimate.estMs
                ? ', over estimate'
                : `, expected ${etaPoint(estimate.estMs)}`
              : ''}
          </span>
        )}
        {run.gitMode === 'new-branch' && (
          <span title="This run works on its own branch; unless turned off, the final phase opens a pull request after one approval.">
            its own branch{run.openPr === false ? '' : ', a pull request at the end'}
          </span>
        )}
      </p>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-ink-faint">
        <span className="inline-flex min-w-0 items-baseline gap-1">
          run <Mono value={run.id} chars={16} copyable />
        </span>
        <span
          className="tnum"
          data-testid="run-clock"
          title={`The run's own clock — started ${new Date(run.createdAt).toLocaleString()}`}
        >
          {clockWords({
            verb: ticking ? 'running' : 'ran',
            ms: Math.max(0, runMs),
            tense: 'for',
            label: 'the run',
          })}
        </span>
        {eta && <span title={etaTitle(eta)}>{etaLabel(eta.lowMs, eta.highMs, eta.basis)}</span>}
        {live && run.autonomy === 'keep-going' && !run.onlyPhases?.length && (
          <span title="Each finished phase re-reads the board and the phases it unlocks start by themselves; the run ends when the plan does, or when something needs a person.">
            runs to plan completion
          </span>
        )}
        {live && run.maxConsecutiveFailures > 0 && run.consecutiveFailures > 0 && (
          <span
            className="text-failed"
            title={`At ${run.maxConsecutiveFailures} in a row the run halts; a clean phase or Continue resets it.`}
          >
            failures {run.consecutiveFailures} of {run.maxConsecutiveFailures}
          </span>
        )}
        {limits?.utilization != null ? (
          <span className="tnum">
            {(limits.window ?? 'usage').replace(/_/g, ' ')} window {Math.round(limits.utilization * 100)}%
            used
            {limits.resetsAt ? `, resets ${new Date(limits.resetsAt * 1000).toLocaleString()}` : ''}
          </span>
        ) : (
          <span>
            updated <RelativeTime at={run.updatedAt} />
          </span>
        )}
      </p>
    </div>
  );
}
