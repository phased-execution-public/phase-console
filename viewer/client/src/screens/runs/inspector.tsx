/**
 * A run in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 7; design.md principle 3).
 *
 * The row hands the shell ONE record: its name, its identity row, the facts
 * the old card's header carried (where it works, what it is spending), every
 * verb the registry knows for it, and the record as the machine holds it. The
 * shell draws it where the width calls for — the column at 1200 and up, a
 * sheet below — and `useInspected` lets the row mark itself as the one on show.
 */

import { Mono, KeyValue } from '@/ui';
import { RunStatus } from '@/ui/status';
import type { ConsoleState, RunState } from '@/data/api';
import { asRunLike, glanceOf, type RunLike } from '@/data/lanes';
import type { PlacedRun } from '@/data/run-groups';
import { money } from '@/lib/format';
import { ActionsTab } from '@/shell/panel/actions-tab';
import { inspect } from '@/shell/panel/inspector-host';

/** The whole record's facts where the row holds it; a slim row says what it knows. */
function overviewOf(run: RunLike, record: RunState | undefined) {
  const glance = glanceOf(record ?? run);
  const whole = record;
  return (
    <KeyValue
      items={[
        whole && (['Root', whole.root] as const),
        whole &&
          ([
            'Checkout',
            whole.checkout === 'worktree'
              ? (whole.workRoot ?? 'a console-managed checkout')
              : whole.checkout === 'refused'
                ? `shared — ${whole.isolationRefusal ?? 'isolation was refused'}`
                : 'the shared root',
          ] as const),
        Boolean(whole?.gitMode) && (['Git mode', String(whole!.gitMode)] as const),
        Boolean(whole?.startAfter) && (['Chained after', String(whole!.startAfter)] as const),
        ['Spent', money(glance.spentUsd)],
        glance.liveUsd > 0 && (['In flight', `${money(glance.liveUsd)} not yet booked`] as const),
        Boolean(whole?.creditUsd) &&
          (['On credit', `${money(whole!.creditUsd ?? 0)} of it past plan limits`] as const),
        whole &&
          ([
            'Phase budget',
            whole.phaseBudgetUsd == null ? 'no ceiling' : money(whole.phaseBudgetUsd),
          ] as const),
        ['Run budget', glance.budgetUsd == null ? 'no ceiling' : money(glance.budgetUsd)],
        ['Consecutive failures', `${run.consecutiveFailures ?? 0} of ${run.maxConsecutiveFailures ?? '—'}`],
        Boolean(glance.model) &&
          (['Model', `${glance.model}${glance.effort ? ` at ${glance.effort}` : ''}`] as const),
      ]}
    />
  );
}

/** Show the run in the panel. */
export function inspectRun({
  placed,
  record,
  state,
}: {
  placed: PlacedRun;
  /** The whole record, when the opened row holds it. */
  record: RunState | undefined;
  state: ConsoleState | undefined;
}): void {
  const { run, ctx } = placed;
  const total = glanceOf(record ?? run).phases.length;
  inspect({
    key: run.id,
    title: run.slug,
    description: `Run ${run.id} — ${total} phase${total === 1 ? '' : 's'} on record.`,
    meta: (
      <>
        <RunStatus run={asRunLike(run) as Parameters<typeof RunStatus>[0]['run']} ctx={ctx} />
        <Mono value={run.id} chars={12} copyable />
        {run.model && <span className="text-meta text-ink-muted">{run.model}</span>}
      </>
    ),
    overview: overviewOf(run, record),
    actions: (
      <ActionsTab
        kind="run"
        args={{ slug: run.slug, runId: run.id }}
        capabilities={state as Parameters<typeof ActionsTab>[0]['capabilities']}
      />
    ),
    raw: JSON.stringify(record ?? run, null, 2),
  });
}
