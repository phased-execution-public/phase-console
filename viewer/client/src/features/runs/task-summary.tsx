/**
 * `3/7 · Wiring the runner` — a session's task list, in one line.
 *
 * The full list is a panel on the run page; this is the same facts small enough
 * to sit on a row, and it is the answer to "what is it doing" for every surface
 * that draws a lane without room for the panel: the Now page's lane cards, the
 * Sessions list, and the run page's own phase rows.
 *
 * One component for the three of them on purpose. The count and the active
 * task are read out of `shared/task-model.js`'s `taskSummary`, so three
 * surfaces cannot come to three different views of one list — the same rule the
 * status vocabulary follows, and the reason `PhaseStateChip` exists.
 */

import { taskSummary } from '@shared/task-model.js';
import { cn } from '@/lib/cn';
import type { PhaseTask } from '@/lib/api';

export function TaskLine({
  tasks,
  className,
}: {
  tasks?: readonly PhaseTask[] | undefined;
  className?: string;
}) {
  const { total, done, active } = taskSummary(tasks as PhaseTask[] | undefined);
  // A session that published no list gets no row furniture saying so. Absence
  // here means "it did not say", which is not a fact worth a line.
  if (!total) return null;

  return (
    <span
      data-testid="task-summary"
      className={cn('inline-flex min-w-0 items-baseline gap-1 text-2xs text-ink-faint', className)}
      title={
        active
          ? `${done} of ${total} tasks done — the session says it is: ${active}`
          : `${done} of ${total} tasks done`
      }
    >
      <span className="font-mono tabular-nums">
        {done}/{total}
      </span>
      {active && <span className="min-w-0 truncate">· {active}</span>}
    </span>
  );
}
