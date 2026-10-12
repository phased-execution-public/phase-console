/**
 * The console's own lane (7.0, quiet-console phase 11; control-tower phase 89,
 * #68): a check the runner is running for a phase itself, with no session
 * behind it — the phase's §Verification, its baseline at boarding, or a
 * context wrap-up's fast gate.
 *
 * ```
 * ▌P56  ● Verifying   pnpm verify:local                  verifying 12m 03s
 *  └ §Verification, command 3 of 5, the console's own check with no session
 * ```
 *
 * `run.children` holds only sessions, so a run twelve minutes into a
 * `pnpm verify:local`, with five phases queued behind its grant, read as idle.
 * The server sends the pass as `run.verifying` — the live console's own — and
 * this is its line.
 *
 * A check is not a phase status, so the lane fold every surface reads
 * (`nowLanes`) is left alone and each check is placed against the lanes
 * instead (`withChecks`): in place of a lane with no session — that lane IS
 * the check, and its line would otherwise show a session's heartbeat going
 * silent — and beside one that has a session (rare; both are real, so both are
 * drawn). A check whose phase has no lane is drawn all the same: the run is
 * working, whatever its records say.
 */

import type { VerifyingLane } from '@/data/api';
import { CHECK_PURPOSE_WORDS } from '@/data/check-words';
import { checksOf, type NowLane, type RunLike } from '@/data/lanes';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { clockTime, clockWords } from '@/lib/format';
import { Mono, isoDuration } from '@/ui';
import { PhaseStatus } from '@/ui/status';

/** The one phase word a check is drawn as — `shared/status-model.js` owns its label, icon and paint. */
const CHECK_RECORD = { status: 'verifying' } as const;

/** The run's own checks, in phase order — none while nothing is verifying, or from a server that predates the field. */
export function verifyingLanes(run: Pick<RunLike, 'verifying'>): VerifyingLane[] {
  return checksOf(run);
}

/** One line of a run's lane list: a lane of the fold, or the console's own check. */
export type LaneListRow = { kind: 'lane'; lane: NowLane } | { kind: 'check'; check: VerifyingLane };

/**
 * The lanes in the fold's order, each check placed against its lane: in place
 * of a lane with no session, right after one that has a session, and after
 * every lane when its phase has none. A QA round counts as a session whether
 * or not the run holds its process yet.
 */
export function withChecks(lanes: readonly NowLane[], checks: readonly VerifyingLane[]): LaneListRow[] {
  const pending = new Map(checks.map((check) => [check.phase, check]));
  const rows: LaneListRow[] = [];
  for (const lane of lanes) {
    const check = pending.get(lane.phase);
    if (!check || lane.child || lane.qa) rows.push({ kind: 'lane', lane });
    if (!check) continue;
    rows.push({ kind: 'check', check });
    pending.delete(lane.phase);
  }
  for (const check of pending.values()) rows.push({ kind: 'check', check });
  return rows;
}

/**
 * The check's line, in a lane line's own shape — the phase, the edge, the
 * clock — told apart by its mark and by saying whose check it is. The clock is
 * the PASS's; it ticks by itself unless the list hands it the one it reads.
 *
 * An `<li>`: it sits in a lane list, beside the lanes.
 */
export function VerifyingLaneRow({
  check,
  now,
  current = false,
}: {
  check: VerifyingLane;
  /** The list's clock, epoch ms; absent, the line keeps its own. */
  now?: number;
  /** The lane the address asked for (`?lane=pN`). */
  current?: boolean;
}) {
  const ticked = useNow(now == null, 1000);
  const at = now ?? ticked;
  const purpose = CHECK_PURPOSE_WORDS[check.purpose] ?? check.purpose;
  const started = Date.parse(check.startedAt);
  const ms = Number.isFinite(started) ? Math.max(0, at - started) : null;
  return (
    <li
      data-testid="verifying-lane"
      data-phase={check.phase}
      data-current={current ? '' : undefined}
      aria-current={current || undefined}
      className={cn(
        'state-verifying flex min-w-0 flex-col gap-0.5 border-s-2 border-state py-1 ps-3 text-meta',
        current && 'bg-surface-raised',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-ink tnum">P{check.phase}</span>
        <PhaseStatus
          record={CHECK_RECORD}
          title={`The console is running this phase's ${purpose} itself: no session is behind it, and the phase's grant is held until the pass ends.`}
        />
        {/* The command whole on hover, however narrow the line cuts it. */}
        <Mono value={check.command} title={check.command} className="min-w-0 flex-1 truncate" />
        <time
          data-testid="check-clock"
          dateTime={ms != null ? isoDuration(ms) : undefined}
          className="text-ink-muted tnum"
          title={`The pass started at ${clockTime(started)}; this command at ${clockTime(Date.parse(check.commandStartedAt))}.`}
        >
          {clockWords({ verb: 'verifying', ms, tense: 'for' })}
        </time>
      </div>
      <p className="min-w-0 break-words text-ink-faint">
        {purpose}
        {check.stage === 'setup' ? ' setup' : ''}, command {check.index} of {check.total}, the console&rsquo;s
        own check with no session
        {check.exported && (
          <span title="It runs in a clean checkout of the phase's HEAD, not the working tree.">
            , in a clean checkout
          </span>
        )}
      </p>
    </li>
  );
}
