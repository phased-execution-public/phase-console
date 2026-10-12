/**
 * Phases nothing is driving (7.0, quiet-console phase 11; control-tower phase
 * 79, #114) — a summons, on the Runs home and on a run's own page.
 *
 * ```
 * ┃ Needs you   Nothing is driving these phases  2
 * ┃ ● Stuck        beta phase 2    undriven 2h 00m      [ Retry phase 2 ]
 * ┃   The ladder deferred it to the healer.
 * ```
 *
 * The board reads them in progress — which reads as "someone is on it" — and
 * no lane, queue entry, scheduled resume or errand of their live run is. Four
 * phases once sat like that for 13–23 hours inside runs that were green on
 * every surface, found only because a board and a page disagreed.
 *
 * The list is the server's: `GET /api/runs` carries each run's `undriven`, and
 * a run read alone (`GET /api/run/:slug`) carries the stamps it is folded from,
 * which `undrivenPhases` — the one reader the inbox reads too — folds the same
 * way. So this card, the inbox row and the home cannot disagree about which
 * phases these are.
 */

import { useState } from 'react';
import { Hand } from 'lucide-react';
import { undrivenPhases } from '@shared/run-lifecycle.js';
import { runRecoverVerb } from '@/cards/recover';
import type { RunState } from '@/data/api';
import { clockWords } from '@/lib/format';
import { Button, Mono, SectionHeading } from '@/ui';
import { PhaseStatus } from '@/ui/status';

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
    for (const row of run.undriven ?? undrivenPhases(run)) {
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
  /** The clock the durations are read against, epoch ms. */
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
  const one = rows.length === 1;

  return (
    <section
      aria-label="Phases nothing is driving"
      data-testid="undriven"
      data-summons=""
      className="state-needs-you flex min-w-0 flex-col gap-2 rounded-lg border border-rule border-s-2 border-s-state bg-surface px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-meta font-medium text-state">
          <Hand size={13} aria-hidden className="shrink-0" />
          Needs you
        </span>
        <SectionHeading as="h3" count={rows.length} className="min-w-0 flex-1">
          Nothing is driving {one ? 'this phase' : 'these phases'}
        </SectionHeading>
      </div>
      <p className="max-w-prose text-meta text-ink-muted">
        The board says {one ? 'it is' : 'they are'} in progress, but no session, queue entry or scheduled
        resume of the run is working on {one ? 'it' : 'them'}. Retry boards a phase now.
      </p>
      <ul className="flex min-w-0 flex-col gap-2">
        {rows.map((row) => {
          const key = `${row.runId}:${row.phase}`;
          const since = Date.parse(row.since);
          return (
            <li
              key={key}
              data-testid="undriven-phase"
              data-phase={row.phase}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
            >
              {/* The stamp is only ever written for these two words. */}
              <PhaseStatus board={row.board === 'stuck' ? 'stuck' : 'in-progress'} />
              <span className="min-w-0 break-words text-body text-ink">
                {row.slug} phase {row.phase}
              </span>
              {Number.isFinite(since) && (
                <span
                  className="text-meta text-ink-faint tnum"
                  title={`Since ${new Date(since).toLocaleString()}`}
                >
                  {clockWords({ verb: 'undriven', ms: Math.max(0, now - since), tense: 'for' })}
                </span>
              )}
              <Button
                size="sm"
                className="ms-auto"
                disabled={!allowRun || pressed === key}
                title={allowRun ? undefined : 'Start the console with --allow-run to board phases from here.'}
                onClick={() => retry(row)}
              >
                Retry phase {row.phase}
              </Button>
              <p className="min-w-0 basis-full break-words text-body text-ink-muted">{row.why}</p>
              {row.deferredTo && (
                <p className="min-w-0 basis-full break-words text-meta text-ink-muted">
                  Its next recovery step, <Mono value={row.deferredTo} />, only runs once a run has stopped,
                  and this one has not.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
