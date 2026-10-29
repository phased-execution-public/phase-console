/**
 * What each lane of a run is doing — the glance's working part (7.0,
 * quiet-console phase 11).
 *
 * ```
 * Lanes  3
 * ▌P7  the api   pe/demo-p7   heard 11m 2s ago   running 14m 03s, expected ~40 min of work   $1.10   opus at max effort   [Freeze|Stop]
 *  └ Slow: the machine is loaded.
 *  └ Edit — src/runner.ts                                                                    4s ago
 * ▌P8  ● Verifying   npm test                                                       verifying 3m 00s
 *  └ baseline, command 1 of 2, the console's own check with no session
 * ┃ Needs you   Nothing is driving this phase …
 * Waiting on other phases  2
 * ▌P10  the docs                                          ● Waiting   expected ~30 min of work
 * ```
 *
 * One line per lane, worst first — the fold every lane surface reads
 * (`nowLanes`), so a silent lane leads however long a healthy one has run —
 * with the console's own checks placed against them (`withChecks`). A lane
 * line says its phase, what it is, its branch, when it was last heard from (in
 * the failed hue once silent past the stall floor, the same clock the order and
 * the push read), its clock LABELLED with the estimate beside it, what it cost
 * so far, who works it, and its own controls. A moving lane adds ONE line of
 * what it is doing now — the phase report's reading, the same one the Runs
 * home's row says — and the newest thing its session did.
 *
 * While the run is live, the phases nothing drives follow (a summons), then
 * the second queue: the phases waiting on their dependencies, each saying
 * whether it starts by itself. The run and the plan are two snapshots that
 * skew, so the lists are cut against each other and a phase is in one place.
 *
 * `laneAsked` is the address's `?lane=pN`: that lane is marked current and
 * brought into view once, by moving the shell's one scroller — never every
 * scrollable ancestor.
 */

import { useEffect, useRef, useState } from 'react';
import { describePhase, describeWord, type StatusView } from '@shared/status-model.js';
import type { PhaseEta, PhaseReport, PlanDetail, RunState } from '@/data/api';
import { isLiveRun, laneSilent, nowLanes, type NowLane } from '@/data/lanes';
import { usePhaseReport } from '@/data/runs';
import { useNow } from '@/ui/clock';
import { cn } from '@/lib/cn';
import { clockTime, clockWords, etaPoint, money } from '@/lib/format';
import { scrollBehavior } from '@/lib/media';
import { Money, Mono, SectionHeading } from '@/ui';
import { PhaseStatus, type PhaseStatusProps } from '@/ui/status';
import { laneClock, recordClocks } from '@/screens/runs/model';
import { RunLaneControls, laneFrozen } from './lane-controls';
import { LastActivity } from './activity';
import { UndrivenCard, undrivenOf } from './undriven';
import { VerifyingLaneRow, verifyingLanes, withChecks, type LaneListRow } from './verifying';
import { RunWaiting, waitingOf } from './waiting';

/* ------------------------------------------------------------------ *
 * The model — pure
 * ------------------------------------------------------------------ */

/**
 * A run's lane lines, worst first, each console check placed against its lane
 * — what `RunLanes` draws. Only a live run has either: a run no loop is behind
 * runs no check, whatever a record a dead console left still says.
 */
export function runLaneRows(run: RunState, detail: PlanDetail, now: number): LaneListRow[] {
  if (!isLiveRun(run)) return [];
  return withChecks(nowLanes([run], new Map([[run.slug, detail]]), now), verifyingLanes(run));
}

/** The phase a line is about. */
const rowPhase = (row: LaneListRow): number => (row.kind === 'lane' ? row.lane.phase : row.check.phase);

/** A sentence's words without its closing stop, so a line can add its own. */
const bare = (text: string): string => text.trim().replace(/[.!]+$/, '');

/**
 * What a moving lane is doing, as one line: why it is slow when it is, else
 * its task, its operation and the minutes left — the phase report read the
 * way the Runs home's row reads it. Null for a report of no live session.
 */
export function laneReportLine(report: PhaseReport): { kind: 'slow' | 'doing'; text: string } | null {
  if (!report.live) return null;
  const [slow, ...more] = report.whySlow ?? [];
  if (slow) {
    const others = more.length ? ` (and ${more.length} more)` : '';
    return { kind: 'slow', text: `Slow: ${bare(slow.text)}${others}.` };
  }
  const task = report.doing?.task;
  const operation = report.doing?.operation;
  const parts = [task ? `On ${bare(task.text)}` : `Phase ${report.phase} is ${report.status}`];
  if (operation) parts.push(`${operation.label} ${operation.done} of ${operation.of}`);
  const minutes = report.eta?.minutes;
  if (minutes) {
    parts.push(
      minutes.high <= 0
        ? 'about to finish'
        : minutes.low === minutes.high
          ? `about ${minutes.high} min left`
          : `about ${minutes.low}–${minutes.high} min left`,
    );
  }
  return { kind: 'doing', text: `${parts.join(', ')}.` };
}

/** What a lane IS, by the status model: a QA round is a session at work on a done phase, a freeze the run's word. */
function laneView(lane: NowLane): StatusView {
  if (lane.frozen) return describeWord('run', 'frozen');
  return describePhase(
    {
      status: lane.qa ? 'running' : lane.status,
      ...(lane.stop ? { lifecycle: { stop: lane.stop } } : {}),
    } as Parameters<typeof describePhase>[0],
    {},
  );
}

/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

export function RunLanes({
  slug,
  run,
  detail,
  live,
  allowRun,
  phaseEta,
  laneAsked,
}: {
  slug: string;
  run: RunState;
  detail: PlanDetail;
  live: boolean;
  allowRun: boolean;
  /** The run's per-phase estimates; a lane falls back to the plan detail's own. */
  phaseEta?: PhaseEta[];
  /** The lane the address asked for — `?lane=pN`. */
  laneAsked?: number;
}) {
  // Each second while a session or a check works — the heartbeats and the
  // clocks are read against it — and each half-minute otherwise.
  const working =
    run.child != null ||
    Object.keys(run.children ?? {}).length > 0 ||
    Object.keys(run.verifying ?? {}).length > 0;
  const now = useNow(live, working ? 1000 : 30_000);
  const rows = runLaneRows(run, detail, now);
  const undriven = live ? undrivenOf([run]) : [];
  const waiting = live
    ? waitingOf(detail, new Set([...rows.map(rowPhase), ...undriven.map((row) => row.phase)]))
    : [];
  const list = useRef<HTMLUListElement>(null);
  // Only the address the page ARRIVED with: a lane picked later in the sessions
  // fold below writes the same `?lane=`, and must not pull the page up to here.
  const [arrivedAsking] = useState(laneAsked != null);
  useRevealOnce(list, arrivedAsking && laneAsked != null && rows.some((row) => rowPhase(row) === laneAsked));

  if (!rows.length && !waiting.length && !undriven.length) return null;

  return (
    <section aria-label="Lanes" data-testid="run-lanes" className="flex min-w-0 flex-col gap-3">
      <SectionHeading count={rows.length || undefined}>Lanes</SectionHeading>
      {rows.length > 0 ? (
        <ul ref={list} className="flex min-w-0 flex-col gap-1.5">
          {rows.map((row) =>
            row.kind === 'check' ? (
              <VerifyingLaneRow
                key={`check#${row.check.phase}`}
                check={row.check}
                now={now}
                current={laneAsked === row.check.phase}
              />
            ) : (
              <LaneLine
                key={row.lane.key}
                slug={slug}
                run={run}
                lane={row.lane}
                live={live}
                allowRun={allowRun}
                now={now}
                estimate={phaseEta?.find((eta) => eta.phase === row.lane.phase) ?? row.lane.eta}
                current={laneAsked === row.lane.phase}
              />
            ),
          )}
        </ul>
      ) : (
        <p className="text-meta text-ink-muted">No phase holds a lane right now.</p>
      )}
      {undriven.length > 0 && <UndrivenCard runs={[run]} allowRun={allowRun} now={now} />}
      {waiting.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2 border-t border-rule pt-3">
          <SectionHeading as="h3" count={waiting.length}>
            Waiting on other phases
          </SectionHeading>
          <RunWaiting rows={waiting} />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * One lane
 * ------------------------------------------------------------------ */

function LaneLine({
  slug,
  run,
  lane,
  live,
  allowRun,
  now,
  estimate,
  current,
}: {
  slug: string;
  run: RunState;
  lane: NowLane;
  live: boolean;
  allowRun: boolean;
  now: number;
  estimate: PhaseEta | undefined;
  current: boolean;
}) {
  const record = run.phases?.[String(lane.phase)];
  const view = laneView(lane);
  const working = lane.status === 'running' || lane.status === 'verifying';
  const moving = working && !lane.frozen;
  const beat = Date.parse(lane.liveness?.lastOutputAt ?? '');
  const silent = laneSilent(lane, now);
  const clock = laneClock(lane, record, now);
  // The estimate is fitted on WORKED time, so that is what it is held to.
  const worked = record ? recordClocks(record, now).workedMs : null;
  const over = estimate != null && (worked ?? clock.ms ?? 0) > estimate.estMs;
  const frozen = lane.frozen ? laneFrozen(run, lane.phase) : null;
  const inFlight = moving ? (record?.live?.spentUsd ?? 0) : 0;
  const spent = lane.costUsd + inFlight;
  const wake = Date.parse(lane.parkedUntil ?? '');
  const note = moving ? null : (lane.note ?? lane.parkReason ?? null);
  const queued = lane.status === 'queued';
  const controllable = allowRun && live && (queued || lane.status === 'running');
  const workedSoFar =
    worked != null ? `, ${clockWords({ verb: 'worked', ms: worked, tense: 'for' })} so far` : '';
  const clockTitle =
    [
      clock.label ? `The phase's ${clock.label} clock` : null,
      estimate ? `estimated ${etaPoint(estimate.estMs)}${workedSoFar}` : null,
    ]
      .filter(Boolean)
      .join('; ') || undefined;

  return (
    <li
      data-testid="run-lane"
      data-phase={lane.phase}
      data-current={current ? '' : undefined}
      aria-current={current || undefined}
      className={cn(
        `state-${view.paint}`,
        'flex min-w-0 flex-col gap-0.5 border-s-2 border-state py-1 ps-3 text-meta',
        current && 'bg-surface-raised',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-ink tnum">P{lane.phase}</span>
        {!lane.frozen && (
          <PhaseStatus
            chrome="badge"
            withNote={false}
            live={lane.status === 'running'}
            record={
              {
                status: lane.qa ? 'running' : lane.status,
                ...(lane.stop ? { lifecycle: { stop: lane.stop } } : {}),
              } as PhaseStatusProps['record']
            }
          />
        )}
        <span className="min-w-0 flex-1 break-words text-body text-ink">{lane.title ?? view.label}</span>
        {lane.qa && <span className="text-ink-muted tnum">QA round {lane.qa.round}</span>}
        {lane.child?.branch && (
          <Mono value={lane.child.branch} chars={32} className="min-w-0 wrap-anywhere" />
        )}
        {Number.isFinite(beat) && (
          <span
            data-testid="lane-beat"
            data-silent={silent ? '' : undefined}
            className={cn('tnum', silent ? 'state-failed text-state' : 'text-ink-muted')}
            title={
              silent
                ? 'Silent past the stall floor: its session has printed nothing in that long'
                : 'When its session last printed anything'
            }
          >
            {clockWords({ verb: 'heard', ms: Math.max(0, now - beat), tense: 'ago' })}
          </span>
        )}
        <span data-testid="lane-clock" className="text-ink-muted tnum" title={clockTitle}>
          {clockWords(clock)}
          {working && estimate ? (over ? ', over estimate' : `, expected ${etaPoint(estimate.estMs)}`) : ''}
        </span>
        {Number.isFinite(wake) && wake > now && (
          <span className="text-ink-muted tnum" title={`It wakes by itself at ${clockTime(wake)}`}>
            {clockWords({ verb: 'wakes in', ms: wake - now, tense: 'for' })}
          </span>
        )}
        {spent > 0 && (
          <Money
            usd={spent}
            className="text-ink-muted"
            title={`${money(lane.costUsd)} booked${inFlight > 0 ? `, ${money(inFlight)} in flight, booked when the session ends` : ''}`}
          />
        )}
        {(lane.model || lane.effort) && (
          <span className="text-ink-muted">
            {lane.model ?? 'the run’s model'}
            {lane.effort ? ` at ${lane.effort} effort` : ''}
          </span>
        )}
        {lane.frozen && (
          <span
            data-testid="lane-frozen"
            className="text-ink"
            title={
              frozen?.escalateAt
                ? `It checkpoints by itself at ${clockTime(Date.parse(frozen.escalateAt))} unless it is continued first.`
                : 'A standing freeze: it waits until somebody continues it.'
            }
          >
            frozen{frozen?.by ? ` by ${frozen.by}` : ''}
          </span>
        )}
        {controllable && (
          <span className="ms-auto flex items-center">
            <RunLaneControls
              slug={slug}
              phase={lane.phase}
              live
              allowRun
              frozen={queued ? null : frozen}
              queued={queued}
            />
          </span>
        )}
      </div>
      {note && <p className="min-w-0 break-words text-ink-muted">{note}</p>}
      {moving && <LaneReport slug={slug} phase={lane.phase} />}
      {moving && (
        <div className="flex min-w-0 flex-wrap">
          <LastActivity slug={slug} phase={lane.phase} />
        </div>
      )}
    </li>
  );
}

/** One line of what a moving lane is doing now — fetched for that lane alone, refreshed with the report. */
function LaneReport({ slug, phase }: { slug: string; phase: number }) {
  const { data } = usePhaseReport(slug, phase);
  const line = data ? laneReportLine(data) : null;
  if (!line) return null;
  return (
    <p
      data-testid="lane-report"
      data-why={line.kind}
      title={data?.summary}
      className="min-w-0 break-words text-ink-muted"
    >
      {line.text}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * The asked lane, brought into view
 * ------------------------------------------------------------------ */

/** How far below the scroller's top edge the asked lane lands. */
const REVEAL_MARGIN_PX = 24;

/**
 * Bring the asked lane into view ONCE — when it is first there — by moving the
 * shell's one scroller (`<main>`), and only when it is not already in view.
 * After the commit, not in it: the shell resets that scroller on a new address
 * in an effect of its own, which runs after this one.
 */
function useRevealOnce(list: { current: HTMLElement | null }, asked: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!asked || done.current) return undefined;
    const timer = window.setTimeout(() => {
      done.current = true;
      const lane = list.current?.querySelector<HTMLElement>('[data-current]');
      if (lane) reveal(lane);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [asked, list]);
}

function reveal(lane: HTMLElement): void {
  const box = lane.closest('main');
  if (!box) return;
  const at = lane.getBoundingClientRect();
  const frame = box.getBoundingClientRect();
  if (at.top >= frame.top && at.bottom <= frame.bottom) return;
  box.scrollTo({
    top: at.top - frame.top + box.scrollTop - REVEAL_MARGIN_PX,
    behavior: scrollBehavior(),
  });
}
