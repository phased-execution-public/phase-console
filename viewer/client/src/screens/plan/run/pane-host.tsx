/**
 * What one lane draws (7.0, quiet-console phase 12; the 6.x pane host before it).
 *
 * A lane is in one of two states, and each wants a different pane:
 *
 *   - **queued** — admitted to nothing yet, waiting on a scope something else
 *     holds. There is no session, so no console; what there is, and the only
 *     thing worth showing, is who holds it and what overlaps.
 *   - **live** — a session, so its console, its ask box, its activity and its
 *     own Freeze and Stop.
 *
 * Phases waiting on their dependencies are not lanes; the sessions' fold draws
 * them as one list. Keeping every pane mounted is the caller's job: this draws
 * what it is given.
 */

import type { PhaseEta, QueueEntry, RunState } from '@/data/api';
import { queueEntryFor } from '@/data/queue-words';
import { PhaseStatus, SessionStatus } from '@/ui/status';
import { RunLaneControls, laneFrozen } from './lane-controls';
import { RunQueuedPane, RunSessionPanes, type SessionLane } from './session-panes';

export function RunLanePane({
  slug,
  run,
  lane,
  live,
  allowRun,
  enabled,
  entries,
  scopes,
  subtitle,
  title,
}: {
  slug: string;
  run: RunState;
  lane: SessionLane;
  live: boolean;
  allowRun: boolean;
  /** False on a stale server — the pane draws, the stream is never opened. */
  enabled: boolean;
  /** The admission queue, for a queued pane's "waiting on". */
  entries?: QueueEntry[] | undefined;
  /** Each phase's scope, so a queued pane says what it would collide with. */
  scopes?: { phase: number; scope: string[]; conflicts: string[] }[] | undefined;
  /** The lane's vitals in words, under its name. */
  subtitle?: string;
  /** The pane's name, when "Phase N console" is not enough. */
  title?: string;
  phaseEta?: PhaseEta[] | undefined;
}) {
  if (lane.queued) {
    return (
      <RunQueuedPane
        phase={lane.phase}
        entry={queueEntryFor(entries, slug, lane.phase)}
        scope={scopes?.find((s) => s.phase === lane.phase)?.scope}
        control={
          <RunLaneControls
            slug={slug}
            phase={lane.phase}
            live={live}
            allowRun={allowRun}
            frozen={null}
            queued
          />
        }
      />
    );
  }

  const frozen = laneFrozen(run, lane.phase);
  return (
    <RunSessionPanes
      slug={slug}
      runId={run.id}
      phase={lane.phase}
      live={live}
      allowRun={allowRun}
      enabled={enabled}
      {...(subtitle ? { subtitle } : {})}
      {...(title ? { title } : {})}
      status={
        frozen ? (
          // Frozen is the SESSION's word: its record still reads running.
          <SessionStatus vocab="terminal" word="frozen" />
        ) : (
          // A QA round is a session at work on a phase the board reads done.
          <PhaseStatus record={{ status: lane.qa ? 'running' : lane.status }} />
        )
      }
      control={
        <RunLaneControls
          slug={slug}
          phase={lane.phase}
          // The lane's OWN status, not the run's: a run with three lanes is
          // running while one of them has finished, and Freeze on a lane with
          // no process is a button that answers 404.
          live={live && lane.status === 'running'}
          allowRun={allowRun}
          frozen={frozen}
        />
      }
    />
  );
}
