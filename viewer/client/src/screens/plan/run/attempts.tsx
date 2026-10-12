/**
 * One phase's boardings, side by side (7.0, quiet-console phase 12; the 6.x
 * attempt comparison drawer). The Gantt opens it from a lane with two
 * attempts or more.
 *
 * ```
 * Phase 9's attempts                                                    ×
 * 3 attempts, comparing [Attempt 2 → 3 ▾]
 *                Attempt 2                 Attempt 3
 * Window         14:02 → 14:12             14:20 → 14:34
 * Took           10m                       14m (▲ 4m)
 * Outcome        failed                    done
 * Model          claude-sonnet-5           claude-opus-5
 * Spend          $0.75                     $2.50 (▲ $1.75)
 * Verification   ● Red                     ● Green
 *                on api · pe/x · 1d1911ee  on api · pe/x · 2e20a3c4
 * Commands whose result changed · 1 ran the same way
 * npm test       ● Red   ● Green   1 → 0   4s → 5s
 * Open phase 9
 * ```
 *
 * A phase that took four boardings leaves four of everything in the journal
 * and one row on the page. The question afterwards is never "how many
 * attempts" — the row already says — it is **what was different about the one
 * that worked**, so the sheet opens on the NEWEST pair and puts the two
 * attempts in two columns, each verdict beside the tree it ran against.
 *
 * The comparison is by COMMAND, not by position (`server/analysis/timeline.ts`
 * pairs them): a §Verification that gained or lost a command between attempts
 * would otherwise line `npm test` up against `npm run lint` and report both as
 * flipped. A command present on one side only flips to or from "not run",
 * which is a real change and usually the interesting one — it is what a
 * repaired §Verification looks like.
 *
 * Two numbers may be absent rather than zero. `costUsd` is `null` when a
 * boarding recorded no session (it parked at the gate, or died before the CLI
 * reported), and `$0.00` there would read as "this was free", which is the one
 * thing it certainly was not. Same for turns.
 */

import { useState, type ReactNode } from 'react';
import type { AttemptComparison, AttemptSummary, VerificationFlip } from '@/data/api';
import { useAttempts } from '@/data/runs';
import { clockTime, duration, money, plural } from '@/lib/format';
import { usePhone } from '@/lib/media';
import { Button, Empty, Mono, Spinner } from '@/ui';
import { TreeLine, verdictTree } from '@/cards/verify-tree';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import { NativeSelect } from '@/ui/native-select';
import { Sheet, SheetContent } from '@/ui/sheet';
import { OpsStatus } from '@/ui/status';
import { Table, TableWrap, TBody, TD, TH, THead } from '@/ui/table';
import { phaseHref } from '@/shell/routes';

/** A verification's result as the console's verification words: a run that passed, failed, or never ran. */
const VERDICT_WORD = { pass: 'green', fail: 'red', absent: 'none' } as const;

/** What `absent` means on one side of a flip, said on hover. */
const ABSENT_WHY = "This attempt's §Verification did not have this command";

/** A figure that may legitimately be unknown — never silently zero. */
function Figure({ value, render }: { value: number | null; render: (n: number) => string }) {
  return value === null ? (
    <span className="text-ink-faint" title="Nothing was recorded for this attempt — not the same as zero">
      not recorded
    </span>
  ) : (
    <span className="tnum">{render(value)}</span>
  );
}

/**
 * Which way it moved, in a glyph and in words — never in a hue alone: colour
 * as the only carrier of "worse" fails the reader who cannot tell the two
 * hues apart, and the arrow already says it.
 */
function Delta({ value, render }: { value: number | null; render: (n: number) => string }) {
  if (value === null) return null;
  if (value === 0) return <span className="text-ink-faint"> (no change)</span>;
  const up = value > 0;
  return (
    <span className="text-ink-muted tnum" title={up ? 'More than before' : 'Less than before'}>
      {' '}
      (<span aria-hidden>{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'up ' : 'down '}</span>
      {render(Math.abs(value))})
    </span>
  );
}

/** A boarding's window on the clock: when it boarded, and when it ended — or that it has not. */
function Window({ attempt }: { attempt: AttemptSummary | undefined }) {
  if (!attempt) return <span className="text-ink-faint">—</span>;
  const start = Date.parse(attempt.startedAt);
  const end = attempt.endedAt ? Date.parse(attempt.endedAt) : Number.NaN;
  return (
    <span
      className="tnum"
      title={`${new Date(start).toLocaleString()} → ${Number.isFinite(end) ? new Date(end).toLocaleString() : 'still open'}`}
    >
      {clockTime(start)} → {Number.isFinite(end) ? clockTime(end) : 'still open'}
    </span>
  );
}

/** A verdict as the console's verification word, with the tree it ran against — or that it names none. */
function Verdict({
  ok,
  attempt,
  aside,
}: {
  ok: boolean | null;
  attempt: AttemptSummary | undefined;
  /** A fact beside the word — how many commands ran. */
  aside?: ReactNode;
}) {
  const tree = verdictTree(attempt?.verification);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        <OpsStatus vocab="verification" word={ok === null ? 'none' : ok ? 'green' : 'red'} />
        {aside}
      </span>
      {attempt?.verification &&
        (tree ? (
          <TreeLine tree={tree} className="text-meta" />
        ) : (
          <span className="text-meta text-ink-faint" data-testid="verify-tree-unknown">
            The verdict names no tree
          </span>
        ))}
    </span>
  );
}

/** One fact of the comparison: its name, and one cell per attempt. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr className="align-top">
      <TH scope="row" className="text-start text-meta font-normal text-ink-muted">
        {label}
      </TH>
      {children}
    </tr>
  );
}

const FLIP_COLUMNS: Column<VerificationFlip>[] = [
  {
    id: 'command',
    head: 'Command',
    identity: true,
    flex: true,
    priority: 1,
    min: 160,
    card: 'title',
    value: (flip) => flip.command,
    cell: (flip) => <Mono value={flip.command} className="wrap-anywhere text-ink" />,
  },
  {
    id: 'was',
    head: 'Was',
    priority: 1,
    min: 104,
    card: 'meta',
    value: (flip) => flip.from,
    cell: (flip) => (
      <OpsStatus
        vocab="verification"
        word={VERDICT_WORD[flip.from]}
        {...(flip.from === 'absent' ? { title: ABSENT_WHY } : {})}
      />
    ),
  },
  {
    id: 'now',
    head: 'Now',
    priority: 1,
    min: 104,
    card: 'meta',
    value: (flip) => flip.to,
    cell: (flip) => (
      <OpsStatus
        vocab="verification"
        word={VERDICT_WORD[flip.to]}
        {...(flip.to === 'absent' ? { title: ABSENT_WHY } : {})}
      />
    ),
  },
  {
    id: 'exit',
    head: 'Exit code',
    priority: 2,
    min: 88,
    align: 'end',
    value: (flip) => `${flip.fromCode ?? '—'} → ${flip.toCode ?? '—'}`,
    cell: (flip) => (
      <span className="tnum">
        {flip.fromCode ?? '—'} → {flip.toCode ?? '—'}
      </span>
    ),
  },
  {
    id: 'time',
    head: 'Took',
    priority: 2,
    min: 112,
    align: 'end',
    value: (flip) => flip.toMs,
    cell: (flip) => (
      <span className="tnum">
        {flip.fromMs === null ? '—' : duration(flip.fromMs)} →{' '}
        {flip.toMs === null ? '—' : duration(flip.toMs)}
      </span>
    ),
  },
];

function Comparison({ diff, attempts }: { diff: AttemptComparison; attempts: readonly AttemptSummary[] }) {
  const from = attempts.find((attempt) => attempt.attempt === diff.from);
  const to = attempts.find((attempt) => attempt.attempt === diff.to);
  const { verification } = diff;
  const changed = (yes: boolean) => (yes ? 'text-ink' : 'text-ink-muted');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* The sheet's body is the one scroller, so this wrapper never is one. */}
      <TableWrap scrolls={false}>
        {/* hand-rolled because: a label/value table, one row per fact and one
            column per attempt — no record to name, nothing to fold, and two
            columns that must stay side by side at every width, which is the
            comparison itself. */}
        <Table fixed aria-label="What changed between the two attempts" className="text-body">
          <THead>
            <tr>
              <th scope="col" className="w-28">
                <span className="sr-only">Fact</span>
              </th>
              <TH className="text-start">Attempt {diff.from}</TH>
              <TH className="text-start">Attempt {diff.to}</TH>
            </tr>
          </THead>
          <TBody>
            <Fact label="Window">
              <TD>
                <Window attempt={from} />
              </TD>
              <TD>
                <Window attempt={to} />
              </TD>
            </Fact>
            <Fact label="Took">
              <TD>
                <Figure value={diff.durationMs.from} render={duration} />
              </TD>
              <TD>
                <Figure value={diff.durationMs.to} render={duration} />
                <Delta value={diff.durationMs.deltaMs} render={duration} />
              </TD>
            </Fact>
            <Fact label="Outcome">
              <TD className={changed(diff.outcome.changed)}>{diff.outcome.from}</TD>
              <TD className={changed(diff.outcome.changed)}>{diff.outcome.to}</TD>
            </Fact>
            <Fact label="Model">
              <TD className={changed(diff.model.changed)}>{diff.model.from ?? 'unrecorded'}</TD>
              <TD className={changed(diff.model.changed)}>{diff.model.to ?? 'unrecorded'}</TD>
            </Fact>
            <Fact label="Spend">
              <TD>
                <Figure value={diff.costUsd.from} render={money} />
              </TD>
              <TD>
                <Figure value={diff.costUsd.to} render={money} />
                <Delta value={diff.costUsd.deltaUsd} render={money} />
              </TD>
            </Fact>
            <Fact label="Turns">
              <TD>
                <Figure value={diff.turns.from} render={String} />
              </TD>
              <TD>
                <Figure value={diff.turns.to} render={String} />
              </TD>
            </Fact>
            <Fact label="Ladder rungs">
              <TD className="break-words">{diff.rungs.from.join(', ') || 'none'}</TD>
              <TD className="break-words">{diff.rungs.to.join(', ') || 'none'}</TD>
            </Fact>
            <Fact label="Verification">
              <TD>
                <Verdict ok={verification.from} attempt={from} />
              </TD>
              <TD>
                <Verdict ok={verification.to} attempt={to} />
              </TD>
            </Fact>
          </TBody>
        </Table>
      </TableWrap>

      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-meta font-medium text-ink">
          Commands whose result changed
          {verification.unchanged ? (
            <span className="font-normal text-ink-muted"> · {verification.unchanged} ran the same way</span>
          ) : null}
        </h4>
        {verification.flips.length ? (
          <Grid
            columns={FLIP_COLUMNS}
            rows={verification.flips}
            getRowKey={(flip) => flip.command}
            label="Commands whose result changed"
          />
        ) : (
          <p className="text-meta text-ink-muted">
            No command changed its result between these two attempts
            {verification.unchanged ? ` — all ${verification.unchanged} ran the same way.` : '.'}
          </p>
        )}
      </div>
    </div>
  );
}

/** One attempt's own facts, for a phase boarded once. */
function Single({ attempt }: { attempt: AttemptSummary }) {
  return (
    <TableWrap scrolls={false}>
      {/* hand-rolled because: a label/value table — one row per fact of one
          attempt, the comparison's shape with one column. */}
      <Table aria-label="What this attempt did" className="text-body">
        <TBody>
          <Fact label="Window">
            <TD>
              <Window attempt={attempt} />
            </TD>
          </Fact>
          <Fact label="Took">
            <TD>
              <Figure value={attempt.durationMs} render={duration} />
            </TD>
          </Fact>
          <Fact label="Outcome">
            <TD>{attempt.outcome}</TD>
          </Fact>
          <Fact label="Model">
            <TD>{attempt.model ?? 'unrecorded'}</TD>
          </Fact>
          <Fact label="Spend">
            <TD>
              <Figure value={attempt.costUsd} render={money} />
            </TD>
          </Fact>
          <Fact label="Turns">
            <TD>
              <Figure value={attempt.turns} render={String} />
            </TD>
          </Fact>
          <Fact label="Verification">
            <TD>
              {attempt.verification ? (
                <Verdict
                  ok={attempt.verification.ok}
                  attempt={attempt}
                  aside={
                    <span className="text-meta text-ink-muted tnum">
                      {plural(attempt.verification.ran.length, 'command')} ran
                    </span>
                  }
                />
              ) : (
                <span className="text-ink-muted">Never reached verification</span>
              )}
            </TD>
          </Fact>
        </TBody>
      </Table>
    </TableWrap>
  );
}

export function RunAttempts({
  slug,
  phase,
  runId,
  onClose,
}: {
  slug: string;
  /** `null` closes the sheet. */
  phase: number | null;
  /** A past run's attempts; absent, the plan's current run. */
  runId?: string;
  onClose: () => void;
}) {
  const phone = usePhone();
  const { data, isLoading } = useAttempts(slug, phase ?? undefined, runId, phase !== null);
  const comparisons = data?.comparisons ?? [];
  // The NEWEST pair unless the reader picked another for this phase: the
  // question is almost always "what did the last attempt do differently".
  const [picked, setPicked] = useState<{ phase: number | null; index: number } | null>(null);
  const index = Math.min(
    picked && picked.phase === phase ? picked.index : comparisons.length - 1,
    comparisons.length - 1,
  );
  const diff = index >= 0 ? comparisons[index] : undefined;
  const attempts = data?.attempts ?? [];

  return (
    <Sheet
      open={phase !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side={phone ? 'bottom' : 'end'}
        title={phase === null ? 'Attempts' : `Phase ${phase}'s attempts`}
        showTitle
        description="Read from this run's journal: one boarding is one attempt, its inner session retries counted inside it."
        data-testid="run-attempts"
        {...(phone ? {} : { className: 'w-[min(42rem,calc(100%-2rem))]' })}
        subheader={
          comparisons.length ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2 text-meta text-ink-muted">
              <span className="tnum">{attempts.length} attempts, comparing</span>
              <NativeSelect
                aria-label="Which pair of attempts to compare"
                value={index}
                onChange={(event) => setPicked({ phase, index: Number(event.currentTarget.value) })}
              >
                {comparisons.map((option, i) => (
                  <option key={`${option.from}-${option.to}`} value={i}>
                    Attempt {option.from} → {option.to}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : undefined
        }
        footer={
          phase === null ? undefined : (
            <Button asChild size="sm" variant="ghost" className="self-start">
              <a href={phaseHref(slug, phase)}>Open phase {phase}</a>
            </Button>
          )
        }
      >
        {isLoading ? (
          <Spinner label="Reading the attempts" />
        ) : !data || attempts.length === 0 ? (
          <Empty
            data-testid="attempts-empty"
            title={`No attempts recorded: this run's journal holds no boarding of phase ${phase}.`}
          />
        ) : !diff ? (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-meta text-ink-muted">One boarding, so there is nothing to compare yet.</p>
            <Single attempt={attempts[0]!} />
          </div>
        ) : (
          <Comparison diff={diff} attempts={attempts} />
        )}
      </SheetContent>
    </Sheet>
  );
}
