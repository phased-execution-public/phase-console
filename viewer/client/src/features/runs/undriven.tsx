/**
 * Phases nothing is driving (control-tower phase 79, #114).
 *
 * The board reads them in progress — which reads as "someone is on it" — and
 * no lane, queue entry, scheduled resume or errand of their live run is. The
 * measured cost of not showing them: four phases sat like that for 13–23 hours
 * inside runs that were green on every surface, and this page listed them
 * nowhere, so the operator found out only because a board and a page
 * disagreed.
 *
 * Drawn from the runs list alone. `GET /api/runs` carries each run's
 * `undriven` list — `undrivenPhases`, the one reader the inbox row reads too —
 * so the card and the inbox cannot disagree about which phases these are.
 */

import { useState } from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import { PhaseStatusBadge } from '@/components/ui/status';
import { elapsed } from '@/lib/format';
import { runRecoverVerb } from '@/lib/run-recover';
import type { RunState } from '@/lib/api';

export interface UndrivenRow {
  runId: string;
  slug: string;
  phase: number;
  /** When the episode began (ISO). */
  since: string;
  /** The board's word: `in-progress` or `stuck`. */
  board: string;
  why: string;
  /** The rung the ladder deferred to the healer, when it did. */
  deferredTo: string | null;
}

/** Every live run's undriven phases, longest-undriven first. */
export function undrivenOf(runs: readonly RunState[]): UndrivenRow[] {
  const rows: UndrivenRow[] = [];
  for (const run of runs) {
    for (const row of run.undriven ?? []) {
      rows.push({
        runId: run.id,
        slug: run.slug,
        phase: row.phase,
        since: row.since,
        board: row.board,
        why: row.why,
        deferredTo: row.deferred?.next ?? null,
      });
    }
  }
  return rows.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.phase - b.phase);
}

export function UndrivenCard({
  runs,
  allowRun,
  now = Date.now(),
}: {
  runs: readonly RunState[];
  allowRun: boolean;
  /** The clock the durations are read against — a test seam. */
  now?: number;
}) {
  const rows = undrivenOf(runs);
  const [pressed, setPressed] = useState<string | null>(null);
  if (!rows.length) return null;

  const retry = (row: UndrivenRow) => {
    const key = `${row.runId}:${row.phase}`;
    setPressed(key);
    void runRecoverVerb('retry', { slug: row.slug, phase: row.phase }).finally(() => setPressed(null));
  };

  return (
    // Amber, like the approval queue above it: both are asks only a person
    // answers, and both are the reason to open this page.
    <Card className="border-accent/50">
      <CardHeader className="flex-wrap items-center">
        <CardTitle className="flex items-center gap-2">
          Nothing is driving {rows.length === 1 ? 'this phase' : 'these phases'}
          <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 font-mono text-sm text-accent">
            {rows.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="max-w-prose text-2xs text-ink-faint">
          The board says {rows.length === 1 ? 'it is' : 'they are'} in progress, but no session, queue entry
          or scheduled resume of the run is working on {rows.length === 1 ? 'it' : 'them'}. Retry boards a
          phase now.
        </p>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const key = `${row.runId}:${row.phase}`;
            const since = Date.parse(row.since);
            return (
              <li
                key={key}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-rule p-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {row.slug}
                      <span className="ml-1.5 text-ink-muted">phase {row.phase}</span>
                    </span>
                    {/* The stamp is only ever written for these two words. */}
                    <PhaseStatusBadge board={row.board === 'stuck' ? 'stuck' : 'in-progress'} />
                    {Number.isFinite(since) && (
                      <span className="font-mono text-2xs text-ink-faint tabular-nums">
                        for {elapsed(Math.max(0, now - since))}
                      </span>
                    )}
                  </div>
                  <p className="max-w-prose text-sm text-ink-muted">{row.why}</p>
                  {row.deferredTo && (
                    <p className="max-w-prose text-2xs text-ink-faint">
                      Its next recovery step, <code className="font-mono">{row.deferredTo}</code>, only runs
                      once a run has stopped — and this one has not.
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  disabled={!allowRun || pressed === key}
                  title={
                    allowRun ? undefined : 'Start the console with --allow-run to board phases from here.'
                  }
                  onClick={() => retry(row)}
                >
                  Retry phase {row.phase}
                </Button>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
