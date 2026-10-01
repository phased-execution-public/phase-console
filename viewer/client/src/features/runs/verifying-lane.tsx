/**
 * The console's own lane (control-tower phase 89, #68's 2026-09-25 05:44Z
 * comment): a check the runner is running for a phase itself, with no session.
 *
 * ## Why a run mid-verification looked idle
 *
 * A phase's §Verification, its baseline at boarding and a context wrap-up's
 * fast gate are run by the CONSOLE, under the phase's grant, once the session
 * has gone. `run.children` holds only sessions, so it read `{}`, and the Runs
 * page drew nothing working for a run that was twelve minutes into a
 * `pnpm verify:local` with five phases queued behind its grant. The server
 * sends the pass as `run.verifying` — the live console's own, nothing a dead
 * one left — and this is its row.
 *
 * ## Beside the fold, never inside it
 *
 * A check is not a phase status, so it is not a member of `LANE_STATUSES` and
 * the `nowLanes` fold every lane surface reads is left alone. The board places
 * each check against its card's lanes instead (`withChecks`): in place of a
 * lane with no session — that lane IS the check, and its row would otherwise
 * show a session's heartbeat going silent — and beside one that has a session
 * (rare; both are real, so both are drawn). A check whose phase has no lane in
 * the fold is drawn all the same: the run is working, whatever its records say.
 */

import { Duration } from '@/components/ui';
import { PhaseStatusBadge } from '@/components/ui/status';
import type { NowLane } from '@/features/runs/lanes-model';
import type { RunState, VerifyingLane } from '@/lib/api';
import { clockTime } from '@/lib/format';

/** The one phase word a check is drawn as — `shared/status-model.js` owns its label, icon and paint. */
const CHECK_RECORD = { status: 'verifying' } as const;

/** What each pass is called on its row. */
export const CHECK_PURPOSE_WORDS: Readonly<Record<VerifyingLane['purpose'], string>> = {
  verify: '§Verification',
  baseline: 'baseline',
  'wip-gate': 'wrap-up gate',
};

/** The run's own checks, in phase order — `[]` when nothing is verifying, or the server predates the field. */
export function verifyingLanes(run: Pick<RunState, 'verifying'>): VerifyingLane[] {
  return Object.values(run.verifying ?? {})
    .filter((check) => check != null && Number.isFinite(check.phase))
    .sort((a, b) => a.phase - b.phase);
}

/** One row of a card's lane list: a lane of the fold, or the console's own check. */
export type LaneListRow = { kind: 'lane'; lane: NowLane } | { kind: 'check'; check: VerifyingLane };

/**
 * A card's rows in the fold's order, each check placed against its lane: in
 * place of a lane with no session, right after one that has a session, and
 * after every lane when its phase has none. A QA round counts as a session
 * whether or not the run holds its process yet.
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
 * The row, in the board lane row's own shape — the `P<n>` cell, the border and
 * the ground — told apart by its badge and by saying whose check it is. Two
 * lines: the command and its clock (the pass's, ticking like a lane's elapsed),
 * then the pass, where it is in it, and why no session is named.
 *
 * An `<li>`: it sits in the card's lane `<ul>`, beside the lanes.
 */
export function VerifyingLaneRow({ check }: { check: VerifyingLane }) {
  const purpose = CHECK_PURPOSE_WORDS[check.purpose] ?? check.purpose;
  const started = Date.parse(check.startedAt);
  const caption = `${purpose} · command ${check.index} of ${check.total} · the console's own check — no session`;
  return (
    <li
      data-testid="verifying-lane"
      data-phase={check.phase}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border-l-4 border-running bg-ground-deep/50 px-2 py-1.5"
    >
      <span className="font-mono text-2xs tabular-nums text-ink">P{check.phase}</span>
      <PhaseStatusBadge
        record={CHECK_RECORD}
        title={`The console is running this phase's ${purpose} itself: no session is behind it, and the phase's grant is held until the pass ends.`}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink" title={check.command}>
        {check.command}
      </span>
      <Duration
        since={Number.isFinite(started) ? started : null}
        live
        className="ml-auto text-2xs text-ink-muted"
        title={`The pass started at ${clockTime(started)}; this command at ${clockTime(Date.parse(check.commandStartedAt))}.`}
      />
      <span className="basis-full text-2xs text-ink-faint">
        {caption}
        {check.exported && (
          <>
            {' · '}
            <span title="It runs in a clean checkout of the phase's HEAD, not the working tree.">
              clean checkout
            </span>
          </>
        )}
      </span>
    </li>
  );
}
