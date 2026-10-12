/**
 * The second queue (7.0, quiet-console phase 11): phases whose turn has not
 * come yet.
 *
 * ```
 * ▌P10  the docs                                ● Waiting   expected ~30 min of work
 *  └ Waiting on P7 ● In progress, P9 ● Next up. Starts by itself the moment these finish: …
 * ```
 *
 * The lanes show what is running and what is admitted, so a plan whose next
 * phases were waiting on their dependencies looked as if it would end after
 * the current ones — an operator watching phases 7 and 9 run reasonably
 * concluded 10 and 11 would never start. So each waiting phase is a line
 * naming exactly what it waits on, and whether it starts by itself: a phase
 * held by a dependency's QA verdict does NOT, and a phase whose handoff reports
 * blocked needs a person.
 *
 * Derived entirely from the plan detail the page already holds — the board is
 * the engine's answer, and a second request for the same facts would one day
 * disagree with it.
 */

import { Fragment } from 'react';
import { describePhase } from '@shared/status-model.js';
import type { PhaseView, PlanDetail } from '@/data/api';
import { cn } from '@/lib/cn';
import { etaPoint } from '@/lib/format';
import { PhaseStatus, QaStatus, type WordOf } from '@/ui/status';

export interface WaitingRow {
  phase: number;
  title: string;
  /** The handoff reports blocked — a person, not a dependency, is the wait. */
  stuck: boolean;
  gated: boolean;
  gates?: string | undefined;
  /** Each unmet dependency with its own board word, or its QA verdict (`QA <verdict>`). */
  deps: { phase: number; state: string }[];
  estMs?: number | undefined;
}

/** How a dependency's QA verdict is written into its state — the one prefix `depState` writes and the line reads. */
const QA_PREFIX = 'QA ';

/** A dependency is unmet while not done — or done but held by the QA gate. */
function depState(view: PhaseView | undefined): string | null {
  if (!view) return 'unknown';
  if (view.state !== 'done') return view.state;
  const qa = view.qa?.result;
  if (qa && qa !== 'pass' && qa !== 'waived') return `${QA_PREFIX}${qa}`;
  return null;
}

/**
 * The waiting and stuck phases of a plan, each with what it waits on.
 *
 * `except` is the phases that already have a lane: the plan detail and the run
 * are separate snapshots, and a phase the scheduler admitted after the board
 * was read would otherwise show in both places at once.
 */
export function waitingOf(detail: PlanDetail, except: ReadonlySet<number> = new Set()): WaitingRow[] {
  const byPhase = new Map<number, PhaseView>(detail.phases.map((p) => [p.phase, p]));
  const eta = detail.eta?.perPhase ?? [];
  return detail.phases
    .filter((p) => (p.state === 'waiting' || p.state === 'stuck') && !except.has(p.phase))
    .map((p) => {
      const deps = (p.analysis?.dependsOn ?? [])
        .map((dep) => ({ phase: dep, state: depState(byPhase.get(dep)) }))
        .filter((dep): dep is { phase: number; state: string } => dep.state != null);
      const est = eta.find((e) => e.phase === p.phase)?.estMs;
      return {
        phase: p.phase,
        title: p.title,
        stuck: p.state === 'stuck',
        gated: p.gated,
        gates: p.gates,
        deps,
        ...(est != null ? { estMs: est } : {}),
      };
    });
}

/** Does a dependency's verdict hold it, though it is done? */
const heldByQa = (dep: { state: string }): boolean => dep.state.startsWith(QA_PREFIX);

/** One dependency's state, drawn by the family: its board word, or the verdict holding it. */
function DepWord({ state }: { state: string }) {
  if (heldByQa({ state })) return <QaStatus result={state.slice(QA_PREFIX.length) as WordOf<'qa-result'>} />;
  return <PhaseStatus board={state as WordOf<'board'>} />;
}

/** Why it has not started, and whether it will by itself — the one sentence each line exists to say. */
function whyWords(row: WaitingRow): string {
  if (row.stuck) return 'Its handoff reports blocked: this one needs a person before it can move.';
  if (row.deps.some(heldByQa)) {
    // "Starts by itself" is true of a dependency still running and false of
    // one that FINISHED and is held by its verdict: nothing dispatches QA on
    // its own, so the reassurance would be the opposite of the truth.
    return (
      'A dependency has finished but its QA verdict is holding it: nothing starts by itself until ' +
      'somebody records pass or waived, or runs QA again.'
    );
  }
  return 'Starts by itself the moment these finish: the autopilot is not stuck.';
}

/**
 * The waiting phases, one line each — the caller names the list. Draws
 * nothing when nothing waits.
 */
export function RunWaiting({ rows }: { rows: readonly WaitingRow[] }) {
  if (!rows.length) return null;
  return (
    <div data-testid="run-waiting" className="flex min-w-0 flex-col gap-2">
      <p className="max-w-prose text-meta text-ink-muted">
        The autopilot keeps going until the whole graph is done. These phases have not been skipped: what they
        wait on has not finished yet.
      </p>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {rows.map((row) => {
          const view = describePhase(null, { boardState: row.stuck ? 'stuck' : 'waiting' });
          return (
            <li
              key={row.phase}
              data-testid="waiting-phase"
              data-phase={row.phase}
              className={cn(
                `state-${view.paint}`,
                'flex min-w-0 flex-col gap-0.5 border-s-2 border-state py-1 ps-3 text-meta',
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-ink tnum">P{row.phase}</span>
                <span className="min-w-0 flex-1 break-words text-body text-ink">{row.title}</span>
                <PhaseStatus board={row.stuck ? 'stuck' : 'waiting'} />
                {row.estMs != null && (
                  <span className="text-ink-faint tnum" title="The plan's own estimate for this phase">
                    expected {etaPoint(row.estMs)}
                  </span>
                )}
              </div>
              <p className="min-w-0 break-words text-ink-muted">
                {row.deps.length > 0 && (
                  <>
                    Waiting on{' '}
                    {row.deps.map((dep, index) => (
                      <Fragment key={dep.phase}>
                        <span
                          data-testid="waiting-dep"
                          data-phase={dep.phase}
                          className="inline-flex items-center gap-1.5"
                        >
                          <span className="text-ink tnum">P{dep.phase}</span>
                          <DepWord state={dep.state} />
                        </span>
                        {index < row.deps.length - 1 ? ', ' : '. '}
                      </Fragment>
                    ))}
                  </>
                )}
                {row.gated && (
                  <span data-testid="waiting-gate">
                    Gated, checked again right before it would start{row.gates ? `: ${row.gates}` : ''}.{' '}
                  </span>
                )}
                <span data-testid="waiting-why">{whyWords(row)}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
