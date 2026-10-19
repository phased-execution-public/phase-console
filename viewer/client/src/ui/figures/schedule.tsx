/**
 * The plan's schedule (one-pool phase 16, #376) — a Gantt of every phase:
 * what ran, from the run record, and when each phase still to run is expected
 * to start and end, from its estimate and its dependencies, with the chain
 * that sets the finish outlined and a *now* line.
 *
 * ```
 * Schedule                                       Expected to finish Oct 18 14:20
 *        Oct 17 09:00     12:00      15:00      18:00
 * P1     ██████▬▬                                        done (expected ▬)
 * P2           ██████████▨▨▨▨┊░░░░                       running, then expected
 * P3                          ┊   ░░░░░░░                expected, critical ▢
 * Critical chain P2 → P3 → P5, finishing Oct 18 14:20
 * › The schedule (5)
 * ```
 *
 * The arithmetic is `scheduleOf`, pure and tested without drawing: a phase
 * still to run starts at the later of *now* and the expected end of every
 * phase it waits on, and takes its estimate. Lanes are unbounded — the engine's
 * batches, not this picture, decide what may run beside what — so the figure
 * answers "when, if nothing waits for a seat", and says so.
 *
 * The drawing is the run's own swimlane (`./swimlane`): a done bar painted
 * done, an open one hatched, an expected one queued, and a thin rail beside a
 * finished bar for what it was expected to take.
 */

import { useId, useMemo } from 'react';

import { cn } from '@/lib/cn';
import { clockTime, duration, plural } from '@/lib/format';

import { FigureNumbers } from './numbers';
import { Swimlane, type SwimlaneBar, type SwimlaneRow } from './swimlane';

/** One phase as the schedule reads it. */
export interface SchedulePhase {
  phase: number;
  title: string;
  /** The board's word. */
  state: string;
}

export interface ScheduleInput {
  phases: readonly SchedulePhase[];
  edges: readonly { from: number; to: number }[];
  /** Each phase's own estimate, in working ms (`PlanDetail.eta.perPhase`). */
  estimates: ReadonlyMap<number, number>;
  /** What the run record says each phase did. */
  records: ReadonlyMap<number, { startedAt?: string | undefined; endedAt?: string | undefined }>;
  now: number;
}

export interface ScheduleRow {
  phase: number;
  title: string;
  state: string;
  /** What ran: from the run record. `open` while it still runs. */
  actual?: { start: number; end: number; open: boolean };
  /** What is expected: a phase still to run, or the rest of one running. */
  expected?: { start: number; end: number };
  /** The estimate it was planned at, when one exists. */
  estimateMs?: number;
  /** On the chain that sets the plan's expected finish. */
  critical: boolean;
}

export interface Schedule {
  rows: ScheduleRow[];
  t0: number;
  t1: number;
  /** The chain that sets the finish, first to last. */
  criticalPath: number[];
  /** When the last phase is expected to end; absent when nothing is left. */
  finishAt?: number;
}

/** What a phase with no estimate is expected to take: the median of the plan's own estimates, else an hour. */
function fallbackEstimate(estimates: ReadonlyMap<number, number>): number {
  const known = [...estimates.values()].filter((ms) => ms > 0).sort((a, b) => a - b);
  return known.length ? known[Math.floor(known.length / 2)]! : 3_600_000;
}

/** The phases in dependency order (Kahn), the plan's own order breaking ties; a cycle's leftovers last. */
function ordered(phases: readonly SchedulePhase[], edges: ScheduleInput['edges']): SchedulePhase[] {
  const known = new Set(phases.map((p) => p.phase));
  const indegree = new Map(phases.map((p) => [p.phase, 0]));
  for (const edge of edges) {
    if (known.has(edge.from) && known.has(edge.to)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = phases.filter((p) => !indegree.get(p.phase)).map((p) => p.phase);
  const out: number[] = [];
  while (queue.length) {
    queue.sort((a, b) => a - b);
    const next = queue.shift()!;
    out.push(next);
    for (const edge of edges) {
      if (edge.from !== next || !known.has(edge.to)) continue;
      const left = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }
  const byPhase = new Map(phases.map((p) => [p.phase, p]));
  const rest = phases.filter((p) => !out.includes(p.phase)).map((p) => p.phase);
  return [...out, ...rest].map((phase) => byPhase.get(phase)!);
}

/** The schedule, as arithmetic. */
export function scheduleOf(input: ScheduleInput): Schedule {
  const { now } = input;
  const fallback = fallbackEstimate(input.estimates);
  const deps = new Map<number, number[]>();
  for (const edge of input.edges) deps.set(edge.to, [...(deps.get(edge.to) ?? []), edge.from]);
  const finish = new Map<number, number>();
  /** Which dependency set each phase's start — the chain's way back. */
  const setBy = new Map<number, number>();
  const rows: ScheduleRow[] = [];
  for (const p of ordered(input.phases, input.edges)) {
    const record = input.records.get(p.phase);
    const started = record?.startedAt ? Date.parse(record.startedAt) : Number.NaN;
    const ended = record?.endedAt ? Date.parse(record.endedAt) : Number.NaN;
    const estimate = input.estimates.get(p.phase);
    const est = estimate && estimate > 0 ? estimate : fallback;
    const row: ScheduleRow = {
      phase: p.phase,
      title: p.title,
      state: p.state,
      critical: false,
      ...(estimate && estimate > 0 ? { estimateMs: estimate } : {}),
    };
    if (p.state === 'done') {
      if (Number.isFinite(started) && Number.isFinite(ended)) {
        row.actual = { start: started, end: ended, open: false };
        finish.set(p.phase, ended);
      }
    } else if (Number.isFinite(started) && !Number.isFinite(ended)) {
      // Running: what ran so far, then what its estimate says is left.
      row.actual = { start: started, end: now, open: true };
      const end = Math.max(now, started + est);
      if (end > now) row.expected = { start: now, end };
      finish.set(p.phase, end);
    } else {
      let start = now;
      for (const dep of deps.get(p.phase) ?? []) {
        const at = finish.get(dep);
        if (at !== undefined && at > start) {
          start = at;
          setBy.set(p.phase, dep);
        }
      }
      row.expected = { start, end: start + est };
      finish.set(p.phase, start + est);
    }
    rows.push(row);
  }

  // The chain that sets the finish: from the latest expected end, back along what set each start.
  const open = rows.filter((row) => row.expected);
  const last = open.reduce<ScheduleRow | null>(
    (best, row) => (!best || row.expected!.end > best.expected!.end ? row : best),
    null,
  );
  const criticalPath: number[] = [];
  for (let at: number | undefined = last?.phase; at !== undefined; at = setBy.get(at))
    criticalPath.unshift(at);
  const onPath = new Set(criticalPath);
  for (const row of rows) row.critical = onPath.has(row.phase);

  const moments = rows.flatMap((row) => [
    row.actual?.start,
    row.actual?.end,
    row.expected?.start,
    row.expected?.end,
  ]);
  const known = moments.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
  const t0 = Math.min(now, ...known);
  const t1 = Math.max(now, ...known);
  return {
    rows: rows.sort((a, b) => a.phase - b.phase),
    t0,
    t1,
    criticalPath,
    ...(last ? { finishAt: last.expected!.end } : {}),
  };
}

/** A moment as the axis writes it: the clock, with the day once the axis spans more than one. */
export function stampOf(ms: number, withDay: boolean): string {
  if (!withDay) return clockTime(ms);
  const at = new Date(ms);
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clockTime(ms)}`;
}

const DAY = 86_400_000;

/** A row's bars, in drawing order: the rail of what it was expected to take, what ran, what is expected. */
function barsOf(row: ScheduleRow, t0: number, words: (ms: number) => string): SwimlaneBar[] {
  const bars: SwimlaneBar[] = [];
  if (row.actual && !row.actual.open && row.estimateMs) {
    bars.push({
      key: 'planned',
      startMs: row.actual.start - t0,
      endMs: row.actual.start + row.estimateMs - t0,
      state: 'state-skipped',
      rail: true,
      title: `P${row.phase} was expected to take ${duration(row.estimateMs)}`,
    });
  }
  if (row.actual) {
    bars.push({
      key: 'actual',
      startMs: row.actual.start - t0,
      endMs: row.actual.end - t0,
      state: row.actual.open ? 'state-running' : 'state-done',
      open: row.actual.open,
      title: `P${row.phase} ${row.actual.open ? 'running since' : 'ran'} ${words(row.actual.start)}${
        row.actual.open ? '' : ` to ${words(row.actual.end)}, ${duration(row.actual.end - row.actual.start)}`
      }`,
    });
  }
  if (row.expected) {
    bars.push({
      key: 'expected',
      startMs: row.expected.start - t0,
      endMs: row.expected.end - t0,
      state: 'state-queued',
      outlined: row.critical,
      title: `P${row.phase} expected ${words(row.expected.start)} to ${words(row.expected.end)}${
        row.critical ? ', on the critical chain' : ''
      }`,
    });
  }
  return bars;
}

/** A row in words — its accessible name and the numbers table's reading. */
function rowWords(row: ScheduleRow, words: (ms: number) => string): string {
  const parts = [`phase ${row.phase}`];
  if (row.actual) {
    parts.push(
      row.actual.open
        ? `running since ${words(row.actual.start)}`
        : `ran ${duration(row.actual.end - row.actual.start)}`,
    );
  }
  if (row.expected) parts.push(`expected to end ${words(row.expected.end)}`);
  if (!row.actual && !row.expected) parts.push('done, with no record of when');
  if (row.critical) parts.push('on the critical chain');
  return parts.join(', ');
}

export function ScheduleFigure({ input, className }: { input: ScheduleInput; className?: string }) {
  const heading = useId();
  const schedule = useMemo(() => scheduleOf(input), [input]);
  const { rows, t0, t1, criticalPath, finishAt } = schedule;
  const spanMs = Math.max(1, t1 - t0);
  const withDay = spanMs > DAY / 2 || new Date(t0).toDateString() !== new Date(t1).toDateString();
  const words = (ms: number) => stampOf(ms, withDay);
  const drawn = rows.filter((row) => row.actual || row.expected);

  const lanes: SwimlaneRow[] = drawn.map((row) => ({
    key: String(row.phase),
    label: <span className="px-1 text-meta text-ink-muted tnum">P{row.phase}</span>,
    ariaLabel: rowWords(row, words),
    emphasis: row.critical,
    bars: barsOf(row, t0, words),
  }));

  return (
    <section
      data-testid="plan-schedule"
      aria-labelledby={heading}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <h3 id={heading} className="text-section text-ink">
        Schedule
      </h3>
      <p className="text-meta text-ink-muted tnum" data-testid="schedule-finish">
        {finishAt
          ? `Expected to finish ${words(finishAt)}, if nothing waits for a seat: each phase still to run starts once everything it waits on is expected to end, and takes its estimate.`
          : 'Nothing is left to schedule: every phase is done.'}
      </p>
      {lanes.length ? (
        <Swimlane
          rows={lanes}
          spanMs={spanMs}
          nowMs={input.now - t0}
          hatchId="pe-plan-schedule-open"
          tickLabel={(ms) => words(t0 + ms)}
          labelWidth="3.5rem"
          ariaLabel={`The plan's schedule, ${plural(lanes.length, 'phase')}, from ${words(t0)} to ${words(t1)}`}
        />
      ) : null}
      <ul
        data-slot="legend"
        aria-label="Key"
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted"
      >
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-done h-2 w-3 shrink-0 rounded-sm bg-state" />
          Ran
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-running h-2 w-3 shrink-0 rounded-sm bg-state" />
          Running
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-queued h-2 w-3 shrink-0 rounded-sm bg-state" />
          Expected
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="state-skipped h-0.5 w-3 shrink-0 rounded-full bg-state" />
          What it was expected to take
        </li>
        <li className="flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 shrink-0 rounded-sm border border-action" />
          Critical chain
        </li>
      </ul>
      {criticalPath.length ? (
        <p className="text-meta text-ink-muted tnum" data-testid="schedule-critical">
          <span className="text-ink">Critical chain</span>{' '}
          {criticalPath.map((phase) => `P${phase}`).join(' → ')}
          {finishAt ? `, finishing ${words(finishAt)}` : ''}
        </p>
      ) : null}
      <FigureNumbers
        label="schedule"
        caption="Each phase: what ran, from the run record, and when what is left is expected to start and end"
        rows={rows}
        getRowKey={(row) => String(row.phase)}
        columns={[
          { head: 'Phase', cell: (row) => `P${row.phase}${row.critical ? ', critical' : ''}` },
          {
            head: 'Ran',
            cell: (row) =>
              row.actual
                ? `${words(row.actual.start)} → ${row.actual.open ? 'now' : words(row.actual.end)}`
                : '—',
          },
          {
            head: 'Expected',
            cell: (row) => (row.expected ? `${words(row.expected.start)} → ${words(row.expected.end)}` : '—'),
          },
          {
            head: 'Estimate',
            cell: (row) => (row.estimateMs ? duration(row.estimateMs) : '—'),
            align: 'end',
          },
          {
            head: 'Took',
            cell: (row) =>
              row.actual && !row.actual.open ? duration(row.actual.end - row.actual.start) : '—',
            align: 'end',
          },
        ]}
      />
    </section>
  );
}

export default ScheduleFigure;
