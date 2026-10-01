/**
 * What the run is doing right now, above everything that explains it.
 *
 * The line this replaces said "started 20 minutes ago" and then went on saying
 * it for the next forty, because nothing in the client had an interval in it:
 * every figure moved only when the server spoke. On a phase that thinks quietly
 * for four minutes that is indistinguishable from a page that has died — the
 * single most common reason someone reloads a console that was working
 * perfectly. So there are two clocks and they tick: how long this run has been
 * going, and how long the phase running *now* has been going.
 *
 * The exception is `frozen`. The child is stopped, so counting on would claim
 * work that is not happening; the clock holds where it stood and says so.
 */

import { Bot, Clock, Gauge } from 'lucide-react';
import { Badge, RelativeTime, Tile } from '@/components/ui';
import { clockWords, etaLabel, etaPoint, etaTitle, money } from '@/lib/format';
import { useAccounts } from '@/lib/queries';
import { useNow } from '@/lib/clock';
import { waitNote } from '@shared/status-model.js';
import type { EtaEstimate, LaneLiveness, PhaseEta, PhaseRecord, RunState } from '@/lib/api';

/**
 * The phases this run holds a live session on, lowest first.
 *
 * `children` is the pool's own record and the answer whenever it is there.
 * `child` is a mirror of one lane kept for every reader written before lanes
 * existed — including a run recorded by an older console, which is why it is the
 * fallback rather than dead weight.
 */
/**
 * What the run's model request resolved to (control-tower phase 54, #91) —
 * the sessions' own `init`, kept on the run as `resolvedModels`. A request
 * that moved within the run (an alias that now names another model) says
 * which model it moved from; a pinned run says it is pinned, because under
 * `pinned` a session on any other model parks rather than spends.
 */
export function ResolvedModel({ run }: { run: RunState }) {
  const seen = run.resolvedModels?.[run.model ?? 'default'];
  const pinned = run.modelPolicy === 'pinned';
  if (!seen && !pinned) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="resolved-model">
      {/* Muted, not the hint's faint ink: which model ran is evidence, and faint
          ink fails AA at this size in both themes (the e2e register). */}
      {seen ? <span className="text-ink-muted">resolves to {seen.resolved}</span> : null}
      {seen?.from ? (
        <Badge tone="accent" title={`earlier in this run the same request ran on ${seen.from}`}>
          moved from {seen.from}
        </Badge>
      ) : null}
      {pinned ? (
        <Badge tone="neutral" title="the run parks a phase whose session starts on any other model">
          pinned
        </Badge>
      ) : null}
    </span>
  );
}

export function livePhases(run: RunState): number[] {
  const lanes = run.children ? Object.values(run.children) : [];
  const phases = lanes.length ? lanes.map((lane) => lane.phase) : run.child ? [run.child.phase] : [];
  return [...new Set(phases)].sort((a, b) => a - b);
}

/**
 * How long the phase running now has been going, against how long it was
 * expected to take.
 *
 * Never a countdown to zero. Past the estimate it says so and keeps counting —
 * a clock that hits 0:00 and stops reads as "it is stuck", which is the one
 * thing an over-running phase most reliably is not.
 */
export function phaseProgress(ms: number, estMs: number | undefined): string | null {
  if (!estMs || estMs <= 0) return null;
  return ms > estMs ? 'over estimate' : etaPoint(estMs);
}

/**
 * The run's facts, under its strip (control-tower phase 24).
 *
 * The strip heads the page and carries the run's word, its ONE clock — the
 * attempt, labelled, with the phase's total beside it — the track, the cost
 * and the one action. What it does not carry lives here, one line of the
 * operator's side and one of the record's: what the run waits on, who pays,
 * which phases hold lanes and how the running one stands against its
 * estimate, the work branch; the run's id, its own clock, the ETA, the
 * completion promise and the failure streak. Every duration is a labelled
 * clock (`clockWords`, #28), never a bare figure.
 */
export function RunHeader({
  run,
  live,
  eta,
  phaseEta = [],
}: {
  run: RunState;
  live: boolean;
  eta: EtaEstimate | null;
  phaseEta?: PhaseEta[];
}) {
  const ticking = live && run.status !== 'frozen';
  const now = useNow(ticking);
  const { data: accountsState } = useAccounts();
  const accountLabel = run.accountId
    ? (() => {
        const view = accountsState?.accounts.find((candidate) => candidate.id === run.accountId);
        return view ? (view.name ?? view.email ?? view.id) : run.accountId;
      })()
    : (() => {
        const login = accountsState?.accounts.find((candidate) => candidate.id === 'default');
        return login?.email ? `machine login · ${login.email}` : 'machine login';
      })();

  const runMs = ticking
    ? now - Date.parse(run.createdAt)
    : Date.parse(run.updatedAt) - Date.parse(run.createdAt);

  const startedAt = run.child?.startedAt ? Date.parse(run.child.startedAt) : null;
  const frozenAt = run.freeze?.at ? Date.parse(run.freeze.at) : null;
  const phaseMs =
    startedAt == null ? null : (frozenAt ?? (ticking ? now : Date.parse(run.updatedAt))) - startedAt;

  const lanes = livePhases(run);
  const mirrorEta = phaseEta.find((p) => p.phase === run.child?.phase);
  const waiting = waitNote(run as Parameters<typeof waitNote>[0]);

  return (
    <div className="flex flex-col gap-1" data-testid="run-facts">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
        {/* What a waiting run waits on and when it resumes (control-tower
            phase 88, #148) — the watch ref or the park's reason, and the
            clock, in the words the Runs list and the pushes use. */}
        {waiting ? (
          <span className="text-ink-faint" data-testid="run-wait-note">
            {waiting}
          </span>
        ) : null}
        {accountLabel ? (
          <Badge title="Which Claude account this run's sessions spend — the machine login when the run names none.">
            {accountLabel}
          </Badge>
        ) : null}
        {lanes.length > 1 ? (
          <>
            <span>phases {lanes.join(', ')}</span>
            <Badge tone="live" title="This run is driving several phases whose scopes do not overlap">
              {lanes.length} sessions
            </Badge>
          </>
        ) : (
          run.activePhase != null && <span>phase {run.activePhase}</span>
        )}
        {/* Against the estimate for the lane the strip's clock counts — the
            mirror — so the two figures are about one phase. */}
        {phaseMs != null && mirrorEta && (
          <span
            data-testid="run-phase-estimate"
            title={`Phase ${mirrorEta.phase} was expected to take about ${mirrorEta.label.replace('~', '')}.`}
          >
            {phaseMs > (mirrorEta.estMs ?? Infinity) ? '' : 'expected '}
            {phaseProgress(phaseMs, mirrorEta.estMs)}
          </span>
        )}
        {/* The run's own record, never a preference fallback — a header states
            what this run IS, and an older server that echoes nothing gets
            nothing rendered. */}
        {run.gitMode === 'new-branch' && (
          <Badge title="This run works on its own branch and, unless turned off, the final phase opens a PR after one approval tap.">
            work branch{run.openPr === false ? '' : ' · PR'}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint">
        <span>
          run <code className="font-mono">{run.id}</code>
        </span>
        {/* The whole run, visibly secondary to the attempt the strip counts:
            on a plan that has been going for days the attempt is what moved. */}
        <span
          className="inline-flex items-center gap-1"
          data-testid="run-clock"
          title={`The run's own clock — started ${new Date(run.createdAt).toLocaleString()}`}
        >
          <Clock size={11} aria-hidden />
          {clockWords({
            verb: ticking ? 'running' : 'ran',
            ms: Math.max(0, runMs),
            tense: 'for',
            label: 'the run',
          })}
        </span>
        {/* A range rather than a countdown, and hedged by where the rate came
            from. `etaLabel` already ends in "left" — do not append a second. */}
        {eta && <span title={etaTitle(eta)}>{etaLabel(eta.lowMs, eta.highMs, eta.basis)}</span>}
        {/* The promise people came to this page doubting: the queue only shows
            what can run NOW. Scoped and halt-on-everything runs make no such
            promise, so they say nothing. */}
        {live && run.autonomy === 'keep-going' && !run.onlyPhases?.length && (
          <span title="Every time a phase finishes the board is re-read, and newly unlocked phases start themselves. The run ends when the whole graph is done — or when something needs a person.">
            runs to plan completion
          </span>
        )}
        {live && run.maxConsecutiveFailures > 0 && run.consecutiveFailures > 0 && (
          <span
            className="text-failed"
            title={`${run.consecutiveFailures} phase(s) have failed in a row; at ${run.maxConsecutiveFailures} the run halts. A phase finishing cleanly — or you pressing Continue — resets it.`}
          >
            failures {run.consecutiveFailures}/{run.maxConsecutiveFailures}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The four figures worth having above the fold.
 *
 * The usage window replaces "Updated" when the account has reported one, because
 * a window nearly spent is the fact most likely to change what you do next; with
 * no window reported there is nothing to say and the slot goes back to being a
 * freshness stamp.
 */
export function RunTiles({
  run,
  phases,
  total,
  liveness,
}: {
  run: RunState;
  phases: PhaseRecord[];
  total?: number;
  /** The run's live lanes (`GET /api/run/:slug` `liveness[]`) — what the sessions in flight have cost. */
  liveness?: LaneLiveness[];
}) {
  const done = phases.filter((p) => p.status === 'done').length;
  // The unbooked half of the spend. A session is booked into `spentUsd` only
  // when it ends, so a tile showing that alone once read $266.34 while $111.87
  // was running (autopilot-token-drain H7). Shown BESIDE the booked figure,
  // never summed into it: the live half is a running total that can still grow.
  const liveUsd = (liveness ?? []).reduce((sum, lane) => sum + (lane.spentUsd ?? 0), 0);
  // The denominator is the PLAN's phase count, not this run's record count. A
  // run holds a record only for phases it boarded, so a plan wedged after two
  // of eight read "2 / 2" in the tile above the fold — indistinguishable from a
  // finished run — while the board said 2/8 and six phases were held. `total`
  // is absent only until the plan detail loads, and then the old count is the
  // honest thing to show.
  const denominator = total ?? phases.length;
  // Phases that really ran and reported nothing (see `PhaseRecord.costUnknown`).
  const lostSpend = phases
    .filter((p) => p.costUnknown)
    .map((p) => p.phase)
    .join(', ');
  const limits = run.limits;

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Tile
        label="Spent"
        value={
          <>
            {money(run.spentUsd)}
            {liveUsd > 0 && (
              <span
                className="ml-2 font-sans text-sm text-ink-muted"
                title="What the sessions still running have cost so far. Each is added to Spent when it ends."
              >
                + {money(liveUsd)} live
              </span>
            )}
          </>
        }
        // A phase whose session was lost before the CLI reported its spend
        // books $0, and $0 reads as "this was free" — which is the one thing it
        // certainly was not. Named rather than guessed at.
        hint={
          lostSpend
            ? `at least — phase ${lostSpend} ran and its spend was never reported`
            : run.runBudgetUsd
              ? `of $${run.runBudgetUsd}`
              : 'no run budget set'
        }
      />
      <Tile
        label="Phases done"
        value={
          <>
            {done}
            <span className="text-lg text-ink-faint"> / {denominator || '—'}</span>
          </>
        }
      />
      {/* The only tile whose value is a word rather than a number, so it read as
          the quiet one in a row of figures — while being the setting most worth
          noticing before you decide anything about the run. The icons give the
          word the weight the digits get for free. */}
      <Tile
        label="Model"
        value={
          <span className="inline-flex items-center gap-2">
            <Bot size={20} className="shrink-0 text-ink-faint" aria-hidden />
            {run.model}
          </span>
        }
        hint={
          <span className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1">
              <Gauge size={11} className="shrink-0" aria-hidden />
              {`${run.effort ?? 'default'} effort · ${run.autonomy}`}
            </span>
            <ResolvedModel run={run} />
          </span>
        }
      />
      {limits?.utilization != null ? (
        <Tile
          label={`${(limits.window ?? 'usage').replace(/_/g, ' ')} window`}
          value={`${Math.round(limits.utilization * 100)}%`}
          hint={
            limits.resetsAt ? `used · resets ${new Date(limits.resetsAt * 1000).toLocaleString()}` : 'used'
          }
        />
      ) : (
        // Live: this is the header of the run in front of you, and a clock
        // painted once goes stale while it is being read.
        <Tile label="Updated" value={<RelativeTime at={run.updatedAt} />} />
      )}
    </div>
  );
}
