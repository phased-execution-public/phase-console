/**
 * The sessions of a run and their consoles — the body of the Run view's
 * "Sessions and their consoles" fold (7.0, quiet-console phase 12; the 6.x
 * session panes and their tab strip before it).
 *
 * ```
 * Run 3   Phase 6   Phase 7, queued   Waiting 1          ← ?lane=run|p6|p7|waiting
 * ● Running  Phase 6 console  opus, worked 12m 03s, expected ~40 min of work   [Freeze|Stop]
 * ┌ the console and its ask box ┐
 * Task list, Tool calls, Verification, Subagents      ← what the session is doing
 * ```
 *
 * One pane per session, and one for the run itself. A run drives several
 * disjoint-scope phases at once, and a phase's console, task list and tool log
 * are about that phase: merged, two sessions' sentences splice into one
 * paragraph and the page is wrong in a way nothing on it can show. So each
 * `(runId, phase)` pane owns its own buffer and narrows the stream to its own
 * session; the run's pane keeps the runner's narration and leaves the text to
 * the lanes.
 *
 * Which pane shows is the address's (`?lane=`), so a pick survives a reload and
 * can be sent. A lane exists for twenty minutes, so a pick whose lane has gone
 * falls back — to the sole lane when there is exactly one (the session a person
 * came to watch), else to the run's own pane.
 *
 * Every pane stays mounted, the others `hidden`: a pane owns its line buffer and
 * its stream, and one that unmounts loses every line printed while it was away —
 * the replay is read once and cannot fill a gap newer than itself. The waiting
 * pane alone mounts only while shown; it holds no stream.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { phaseClocks } from '@shared/phase-clocks.js';
import { undrivenPhases } from '@shared/run-lifecycle.js';
import {
  api,
  type PhaseEta,
  type PhaseRecord,
  type PhaseStatus as PhaseWord,
  type PlanDetail,
  type QueueEntry,
  type QueueHolder,
  type RunState,
} from '@/data/api';
import { LANE_STATUSES, type NowLane } from '@/data/lanes';
import { holderEvidenceText, holderLabel, sessionHolderText } from '@/data/queue-words';
import { useRun, useTranscript } from '@/data/runs';
import { useNow } from '@/lib/clock';
import { clockTime, clockWords, etaPoint, plural } from '@/lib/format';
import { Button, Mono } from '@/ui';
import { RunStatus } from '@/ui/status';
import { useRoute } from '@/shell/router';
import { runPaneHref, runPaneOf, type RunPane } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { ActivityPanels } from './activity';
import { AskBox } from './ask';
import { RunConsole, linesForPhase, useLiveLines, useSessionStream } from './console';
import { RunLanePane } from './pane-host';
import { RunWaiting, waitingOf } from './waiting';

/* ------------------------------------------------------------------ *
 * The lanes
 * ------------------------------------------------------------------ */

/**
 * A lane as a pane needs it: which phase of which run, what its record says,
 * and whether a session stands behind it yet. A projection of `NowLane`, so
 * "the same fields, always" is the compiler's fact rather than a convention.
 */
export type SessionLane = Pick<NowLane, 'slug' | 'runId' | 'phase' | 'qa'> & {
  status: PhaseWord;
  /** No session to watch yet — the pane says what it waits on instead. */
  queued: boolean;
};

/**
 * Every lane of one run, lowest phase first — a pane list that reshuffles as
 * lanes come and go loses the one being read.
 *
 * Folded from the run's records rather than from the live-lane fold, which
 * drops a run that is no longer live: a halting run draining its last two
 * sessions is exactly when somebody is watching them. The STATUS SET is the
 * one every lane surface reads (`LANE_STATUSES`), plus a done phase with a QA
 * round in flight — the reviewer is a session the run is paying for.
 */
export function sessionLanesOf(run: RunState | null | undefined): SessionLane[] {
  if (!run) return [];
  const wanted = new Set<string>(LANE_STATUSES);
  return Object.values(run.phases ?? {})
    .filter((record) => wanted.has(record.status) || Boolean(record.qaSession))
    .sort((a, b) => a.phase - b.phase)
    .map((record) => ({
      slug: run.slug,
      runId: run.id,
      phase: record.phase,
      status: record.status,
      queued: record.status === 'queued',
      ...(record.qaSession ? { qa: { round: record.qaSession.round } } : {}),
    }));
}

/** A lane's pane, as the address names it. */
export const paneIdOf = (lane: Pick<SessionLane, 'phase'>): RunPane => `p${lane.phase}`;

/**
 * The pane that shows: the address's pick while it still exists, else the sole
 * lane, else the run's own. `waiting` stands only while phases wait on others.
 */
export function pickPane(
  asked: RunPane | null | undefined,
  lanes: readonly SessionLane[],
  waiting = false,
): RunPane {
  if (asked === 'waiting') {
    if (waiting) return asked;
  } else if (asked === 'run' || (asked && lanes.some((lane) => paneIdOf(lane) === asked))) {
    return asked;
  }
  return lanes.length === 1 ? paneIdOf(lanes[0]!) : 'run';
}

/** A lane's name in the section list. */
function laneLabel(lane: SessionLane): string {
  return `Phase ${lane.phase}${lane.queued ? ', queued' : ''}${lane.qa ? `, QA round ${lane.qa.round}` : ''}`;
}

/**
 * A lane pane's vitals, in words: who works it and its clock against the
 * estimate — what the phases table says, repeated where a person is looking
 * while the session runs. The clock is WORKED time, the one the estimate is
 * fitted on: a resumed phase's queue and park time is not work.
 */
function laneVitals(lane: SessionLane, run: RunState, now: number, phaseEta?: readonly PhaseEta[]): string {
  const record = run.phases?.[String(lane.phase)];
  const eta = phaseEta?.find((estimate) => estimate.phase === lane.phase);
  const worked: number | null = record ? (phaseClocks(record, now).workedMs ?? null) : null;
  const started = record?.startedAt ? Date.parse(record.startedAt) : Number.NaN;
  const ran = Number.isFinite(started) ? Math.max(0, now - started) : null;
  const clock =
    worked != null
      ? clockWords({ verb: 'worked', ms: worked, tense: 'for' })
      : ran != null
        ? clockWords({ verb: 'running', ms: ran, tense: 'for' })
        : null;
  const measured = worked ?? ran;
  const estimate =
    clock && eta
      ? measured != null && measured > eta.estMs
        ? `over its estimate of ${etaPoint(eta.estMs)}`
        : `expected ${etaPoint(eta.estMs)}`
      : null;
  return [record?.model ?? run.model, clock, estimate].filter(Boolean).join(', ');
}

/* ------------------------------------------------------------------ *
 * The fold's body
 * ------------------------------------------------------------------ */

export function RunSessions({
  slug,
  run,
  detail,
  live,
  allowRun,
  enabled,
  entries,
  scopes,
  phaseEta,
}: {
  slug: string;
  run: RunState;
  detail: PlanDetail;
  live: boolean;
  allowRun: boolean;
  /** False on a stale server — the panes draw, and open no stream. */
  enabled: boolean;
  /** The admission queue, for a queued pane's "waiting on". */
  entries?: QueueEntry[] | undefined;
  /** Each phase's scope, so a queued pane can say what it wants before the queue answers. */
  scopes?: { phase: number; scope: string[]; conflicts: string[] }[] | undefined;
  phaseEta?: PhaseEta[] | undefined;
}) {
  const asked = runPaneOf(useRoute());
  const lanes = sessionLanesOf(run);
  // One clock for every lane's vitals, ticking only while a session works.
  const now = useNow(live && lanes.some((lane) => !lane.queued));
  // The second queue: phases waiting on their dependencies — only while the
  // run is live, never a phase that already has a pane (the run and the plan
  // are two snapshots that skew), and never one nothing drives: "starts by
  // itself" is exactly what is not true of that one.
  const waiting = live
    ? waitingOf(
        detail,
        new Set([...lanes.map((lane) => lane.phase), ...undrivenPhases(run).map((row) => row.phase)]),
      )
    : [];
  const current = pickPane(asked, lanes, waiting.length > 0);
  const runModel = run.activePhase != null ? `phase ${run.activePhase} on ${run.model}` : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="run-sessions">
      <SectionNav
        label="Sessions of this run"
        current={current}
        sections={[
          {
            id: 'run',
            label: 'Run',
            href: runPaneHref(slug, 'run'),
            ...(lanes.length > 1 ? { count: lanes.length } : {}),
          },
          ...lanes.map((lane) => ({
            id: paneIdOf(lane),
            label: laneLabel(lane),
            href: runPaneHref(slug, paneIdOf(lane)),
          })),
          ...(waiting.length > 0
            ? [{ id: 'waiting', label: 'Waiting', href: runPaneHref(slug, 'waiting'), count: waiting.length }]
            : []),
        ]}
      />

      <div data-pane="run" hidden={current !== 'run'}>
        <RunSessionPanes
          slug={slug}
          runId={run.id}
          live={live}
          allowRun={allowRun}
          enabled={enabled}
          runLevel
          title="Run console"
          {...(runModel ? { subtitle: runModel } : {})}
          askPhase={run.activePhase}
          status={<RunStatus run={run as Parameters<typeof RunStatus>[0]['run']} />}
        />
      </div>
      {lanes.map((lane) => (
        <div key={paneIdOf(lane)} data-pane={paneIdOf(lane)} hidden={current !== paneIdOf(lane)}>
          <RunLanePane
            slug={slug}
            run={run}
            lane={lane}
            live={live}
            allowRun={allowRun}
            enabled={enabled}
            entries={entries}
            scopes={scopes}
            {...(lane.queued ? {} : { subtitle: laneVitals(lane, run, now, phaseEta) })}
          />
        </div>
      ))}
      {current === 'waiting' && (
        <div data-pane="waiting">
          <RunWaiting rows={waiting} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One session's pane
 * ------------------------------------------------------------------ */

/**
 * The console, the ask box and the activity for exactly one `(runId, phase)`
 * pair — its own buffer, so two of them cannot share one. With no `phase` it
 * reads the whole run: the run's own pane (`runLevel`: the narration and no
 * session text), or a finished run's replay read whole.
 */
export function RunSessionPanes({
  slug,
  runId,
  phase,
  live,
  allowRun,
  enabled = true,
  title,
  subtitle,
  askPhase,
  runLevel = false,
  control,
  status,
}: {
  slug: string;
  runId: string;
  /** Absent for a pane that reads the whole run. */
  phase?: number | undefined;
  live: boolean;
  allowRun: boolean;
  enabled?: boolean;
  title?: string;
  subtitle?: string;
  /**
   * Which phase the ask box talks to, when that is not this pane's own — the
   * run's pane has no phase and still reaches whatever is running.
   */
  askPhase?: number | null;
  /**
   * The run's own pane: the runner's narration (phases starting and settling,
   * verify commands) and none of the sessions' text, task lists or tool calls,
   * which the lanes own — so no lane starting can wipe another's list here.
   */
  runLevel?: boolean;
  /** The session's own controls (freeze, stop), at the end of the head line. */
  control?: ReactNode;
  /** The session's status mark, leading the head line. */
  status?: ReactNode;
}) {
  const { lines, activity, record, clear, hydrate, seedTasks } = useLiveLines();

  // A lane reads its OWN phase's replay — one capped file per phase, so a long
  // run's later lanes are never starved by an earlier one. The run's pane and a
  // whole-run replay read the run's files merged; `linesForPhase` guards a
  // replay written before the split, whose one file held every lane.
  const { data: transcript } = useTranscript(slug, runId, enabled, runLevel ? undefined : phase);
  useEffect(() => {
    hydrate(
      runLevel
        ? (transcript ?? []).filter((entry) => entry.event !== 'stream')
        : linesForPhase(transcript, phase),
    );
  }, [transcript, phase, hydrate, runLevel]);

  // The task list comes from the RECORD (see `seedTasks`), of THIS run — a
  // replay of an older run must not be seeded with the live one's list. The run
  // is in the cache already: the view that draws this pane read it.
  const { data: detail } = useRun(slug, enabled);
  const shown = [detail?.run, ...(detail?.history ?? [])].find((state) => state?.id === runId);
  const own = !runLevel && phase != null ? shown?.phases?.[String(phase)] : undefined;
  const seedable = own?.tasks;
  useEffect(() => {
    seedTasks(seedable);
  }, [seedable, seedTasks]);

  useSessionStream(record, enabled, { runId, phase, omitStream: runLevel });

  const target = askPhase === undefined ? phase : askPhase;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="session-pane">
      <RunConsole
        lines={lines}
        onClear={clear}
        title={title ?? (phase != null ? `Phase ${phase} console` : 'Session console')}
        {...(subtitle ? { subtitle } : {})}
        {...(control ? { actions: control } : {})}
        {...(status ? { status } : {})}
        footer={
          <AskBox
            slug={slug}
            enabled={Boolean(allowRun && live && target != null)}
            allowRun={allowRun}
            phase={target}
          />
        }
      />
      {own?.replay && phase != null ? <ReplayNote phase={phase} replay={own.replay} /> : null}
      {runLevel ? (
        <p className="text-meta text-ink-muted">
          A lane’s own text, task list and tool calls are in its pane.
        </p>
      ) : (
        <ActivityPanels activity={activity} live={live} />
      )}
    </div>
  );
}

/**
 * How much of a lane's replay is left. The runner records it on the phase once
 * a file passes 80 % of its cap and again at the cap; it is said here because
 * this pane is what a reload rebuilds from the replay, and someone watching a
 * long phase should learn that before the lines stop, not after.
 */
export function ReplayNote({ phase, replay }: { phase: number; replay: NonNullable<PhaseRecord['replay']> }) {
  // One decimal: "14 MB of 16 MB" beside "84 %" reads as a sum that does not add up.
  const size = (n: number) => `${Number((n / (1024 * 1024)).toFixed(1))} MB`;
  return (
    <p role="status" className="text-meta text-ink-muted">
      {replay.state === 'full'
        ? `Phase ${phase}’s replay is full at ${size(replay.cap)}, so a reload shows it only up to that point. The live view keeps streaming, and the journal keeps everything after it.`
        : `Phase ${phase}’s replay is ${Math.floor((replay.bytes / replay.cap) * 100)} % full (${size(replay.bytes)} of ${size(replay.cap)}). Once it fills, a reload shows it only up to that point; the live view keeps streaming.`}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * A lane with no session yet
 * ------------------------------------------------------------------ */

/**
 * A queued lane, and why. "Queued" alone names the state and withholds the one
 * fact that makes it bearable — what it is behind and for how long — so every
 * holder is named with the tokens that collided, and the wait is attributable to
 * a phase of a plan rather than to the console being slow.
 */
export function RunQueuedPane({
  phase,
  entry,
  scope,
  control,
}: {
  phase: number;
  entry?: QueueEntry | undefined;
  /** The phase's declared scope — what it wants before the scheduler answers. */
  scope?: readonly string[] | undefined;
  /** The lane's own control: Stop, which takes it out of the line. */
  control?: ReactNode;
}) {
  // The clock ticks: a wait that reads a frozen "2m" looks like a page that died,
  // and this is the screen somebody stares at wondering exactly that.
  const now = useNow(true);
  const wanted = entry?.scope ?? scope ?? [];
  const holders = entry?.waitingOn ?? [];

  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-testid="queued-pane"
      aria-label={`Phase ${phase} is queued`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h3
          className="min-w-24 text-body font-semibold text-ink"
          title="Nothing has been spawned and no lock is held: this phase is in a line for a scope something else is working in, and it starts itself the moment that clears."
        >
          Phase {phase} is queued
        </h3>
        {entry && (
          <span data-testid="queued-clock" className="text-meta text-ink-muted tnum">
            {clockWords({ verb: 'queued', ms: Math.max(0, now - entry.since), tense: 'for' })}
          </span>
        )}
        {control && <div className="ms-auto flex items-center">{control}</div>}
      </div>

      {wanted.length > 0 && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-meta text-ink-muted">
          <span>Wants</span>
          {wanted.map((token) => (
            <Mono key={token} value={token} className="wrap-anywhere text-ink" />
          ))}
        </p>
      )}

      {holders.length ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-meta text-ink-muted">Waiting on</p>
          <ul className="flex min-w-0 flex-col gap-1.5">
            {holders.map((holder, i) => (
              <HolderLine key={`${holder.slug}-${holder.phase}-${i}`} holder={holder} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-meta text-ink-muted">
          {entry
            ? 'Admitted, and the scheduler has named no holder: it is next.'
            : 'The scheduler has not answered yet.'}
        </p>
      )}

      {entry?.bypassed ? (
        <p className="text-meta text-ink-muted">
          Passed over {plural(entry.bypassed, 'time')} by a phase that could run; after enough of those it
          reserves its tokens and nothing else may take them.
        </p>
      ) : null}
      {entry?.reserving ? (
        <p className="text-meta text-ink-muted">
          Now reserving its scope: nothing new may take these tokens until this phase has had them.
        </p>
      ) : null}
    </section>
  );
}

/** One holder, in words: who, what collided, and — for a terminal — its release. */
function HolderLine({ holder }: { holder: QueueHolder }) {
  const evidence = holder.kind === 'session' ? holderEvidenceText(holder) : null;
  return (
    <li className="flex min-w-0 flex-col gap-0.5 text-body">
      <p className="min-w-0 break-words text-ink-muted">
        <span className="text-ink">{holderLabel(holder.kind, holder.slug, holder.phase)}</span>
        {holder.owner && (
          <>
            , <Mono value={holder.owner} className="wrap-anywhere" />
          </>
        )}
        {holder.overlaps.length > 0 && (
          <span>
            , overlaps <Mono value={holder.overlaps.join(', ')} className="wrap-anywhere" />
          </span>
        )}
        {holder.unqualified && <span>, {holder.unqualified.reason}</span>}
        {/* The wait read in reverse: branch-disjoint claims are carved out of
            admission, so a holder that names a branch here is one whose branch
            was NOT disjoint from this phase's. */}
        {holder.branch && (
          <span data-testid="holder-branch">
            , on <Mono value={holder.branch} className="wrap-anywhere" />
          </span>
        )}
        {/* A lock's lease is its promise to lapse: how long this can possibly block. */}
        {holder.kind === 'lock' && holder.leaseUntil != null && (
          <span>, lease ends {clockTime(holder.leaseUntil)}</span>
        )}
      </p>
      {holder.kind === 'session' && (
        // A terminal in the repository holds no lock: the wait ends when it stops
        // touching the scope, ends, or is released here.
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p data-testid="holder-session" className="min-w-0 break-words text-meta text-ink-muted">
            {sessionHolderText(holder)}
            {holder.cwd && (
              <>
                {' '}
                in <Mono value={holder.cwd} className="wrap-anywhere" />
              </>
            )}
            {holder.leaseUntil != null && <>, holds until {clockTime(holder.leaseUntil)}</>}
          </p>
          {holder.session ? <ReleaseHold sessionId={holder.session} /> : null}
        </div>
      )}
      {/* What the hold rests on, so a wrong reading is visible before anyone releases it. */}
      {evidence && (
        <p data-testid="holder-evidence" className="min-w-0 break-words text-meta text-ink-muted">
          {evidence}
        </p>
      )}
    </li>
  );
}

/**
 * Tell the queue a terminal is not working here — for two hours, or for as long
 * as it lives. The person's word against the console's reading of a transcript,
 * offered wherever that reading holds a run.
 */
export function ReleaseHold({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | { error: string }>('idle');
  const release = (hours?: number) => {
    setState('busy');
    api.releaseSessionHold(sessionId, hours).then(
      () => setState('done'),
      (error: unknown) =>
        setState({
          error:
            (error as Error | undefined)?.message || 'releasing needs a console started with --allow-run',
        }),
    );
  };
  if (state === 'done') {
    return <span className="text-meta text-ink-muted">Released: the queue no longer waits on it.</span>;
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <Button size="sm" variant="ghost" disabled={state === 'busy'} onClick={() => release(2)}>
        Release for 2 h
      </Button>
      <Button size="sm" variant="ghost" disabled={state === 'busy'} onClick={() => release()}>
        Not working here
      </Button>
      {typeof state === 'object' && (
        <span role="alert" className="state-failed text-meta text-state">
          Not released: {state.error}
        </span>
      )}
    </span>
  );
}
