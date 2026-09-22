/**
 * One phase being worked on right now.
 *
 * ## Why a LANE and not a run
 *
 * The strip this replaces drew one line per run with one clock on it. A run
 * can drive several disjoint-scope phases at once, so "three phases in flight,
 * one of them silent for forty minutes" was rendered as a single calm line
 * with the wrong elapsed time and no way to see the silence at all. The unit
 * on this page is the lane, because the lane is the thing that is working, the
 * thing that is spending, and the thing that stalls.
 *
 * ## What the row promises
 *
 * State, heartbeat, cost, elapsed, ETA and model — and each of them says "I
 * cannot tell you" rather than guessing when the fact is missing:
 *
 *  - the **heartbeat** stops pulsing once the silence passes the stall
 *    threshold and writes the silence out instead. A dot that keeps beating
 *    over a wedged session is the lie this console exists not to tell;
 *  - the **ETA** is the SERVER's `PhaseEta` for this phase, never arithmetic
 *    done here. The estimate is a rate reading over the plan's own history and
 *    a bucketing rule; a second implementation in the browser would disagree
 *    with the plan page the first time either changed;
 *  - the **tail** is the live stream, bounded. It is collapsed by default
 *    because a home page that prints eight lines per lane is a log viewer.
 */

import { useState } from 'react';
import { ChevronRight, FolderGit2, Lock, Snowflake, Users } from 'lucide-react';
import {
  Badge,
  Button,
  Chip,
  Heartbeat,
  Inspector,
  InspectorSection,
  KeyValue,
  MonoId,
  RelativeTime,
  StatusBadge,
} from '@/components/ui';
import { ContextChip, LivenessChip } from '@/features/runs/phase-row';
import { BranchChip } from '@/features/runs/git-card';
import { TaskLine } from '@/features/runs/task-summary';
import { AskBox } from '@/features/runs/ask-box';
import type { ConsoleLine } from '@/features/runs/console-model';
import { useNow } from '@/lib/clock';
import { elapsed, money } from '@/lib/format';
import { phaseStatusTitle, phaseUiState } from '@/lib/status-vocab';
import { plainText } from '@/lib/plain-text';
import { cn } from '@/lib/cn';
import { planHref } from '@shared/routes.js';
import { STALL_DEFAULTS } from '@shared/attention-model.js';
import type { QueueEntry } from '@/lib/api';
import type { NowLane } from './model';
import { laneClaim, waitSummary } from './ops-model';

/** The stall detector's own floor, so the dot and the runner agree on "silent". */
const SILENT_AFTER_MS: number = STALL_DEFAULTS.stallSilentMs;

export function LaneRow({
  lane,
  tail,
  waiters,
  allowRun,
}: {
  lane: NowLane;
  /** The last few lines of this lane's stream, newest last. */
  tail?: readonly ConsoleLine[];
  /**
   * Admissions queued behind THIS lane's grant — the "who waits on whom" edge,
   * drawn from the holding end. A lane that is making three other plans wait is
   * a different thing to look at from one that is making none, and until this
   * the only way to learn it was to read the queue and join it by hand.
   */
  waiters?: readonly QueueEntry[];
  allowRun: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const claim = laneClaim(lane);
  const running = lane.status === 'running' && !lane.frozen;
  const now = useNow(running);
  const started = lane.startedAt ? Date.parse(lane.startedAt) : NaN;
  const beat = lane.liveness?.lastOutputAt ? Date.parse(lane.liveness.lastOutputAt) : null;

  return (
    <li
      data-testid="lane-row"
      data-phase={lane.phase}
      data-slug={lane.slug}
      className={cn(
        'flex flex-col rounded-lg border bg-surface',
        lane.liveness?.stall ? 'border-accent/50' : 'border-rule',
      )}
    >
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          {/* `pulse={running}`, not a bare `pulse`. This was unconditional, so
              a FROZEN lane — whose status is still `running` because a freeze
              is a SIGSTOP and not a status change — breathed while the kernel
              was not scheduling it. The predicate was already computed two
              lines up for the clock and simply not used here; `components/
              pulse.tsx` has always had it right (`!lane.frozen`). */}
          {/* 🔴 `state` is a UI STATE, not a phase status. Passing the raw
              word meant `asUiState` did not recognise it and fell back to
              `UNKNOWN_STATE` — which is `waiting` — so EVERY park, gate and
              awaiting-verification lane read "Waiting" on the Now row while the
              fleet table below said `needs-you` about the same record. The
              honest fallback for an unknown word became a lie for a known one,
              and it hid the asks on the destination whose whole question is
              "does anything need me". Folded properly, with the reason axis, so
              this row and the tables cannot disagree. */}
          <StatusBadge
            state={phaseUiState(lane.status, lane.stop)}
            label={lane.status}
            pulse={running}
            title={phaseStatusTitle(lane.status, lane.stop)}
          />
          <a
            href={planHref(lane.slug, 'run')}
            className="min-w-0 flex-1 truncate font-display text-lg leading-tight hover:text-action"
            title={plainText(lane.planTitle)}
          >
            {lane.slug}
          </a>
          {lane.frozen && (
            <Badge tone="wait">
              <Snowflake size={11} aria-hidden />
              frozen
            </Badge>
          )}
        </div>

        <p className="min-w-0 truncate text-2xs text-ink-muted">
          phase {lane.phase}
          {lane.title ? ` — ${plainText(lane.title)}` : ''}
          {lane.attempts > 1 ? ` · attempt ${lane.attempts}` : ''}
        </p>

        {/* The session's OWN account of what it is doing, directly under the
            plan's. The two answer different questions — the phase title is what
            was asked for, the task line is what is being worked on right now —
            and until this row carried the second, the only way to get it was to
            open the run page and read the panel. */}
        <TaskLine tasks={lane.tasks} className="max-w-full" />

        {/* The facts, in one wrapping row: on a phone they stack, and every one
            of them is short enough that stacking is legible rather than a list
            of orphaned numbers. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Heartbeat lastBeatAt={beat} staleAfterMs={SILENT_AFTER_MS} live={running} label="lane" />
          <LivenessChip liveness={lane.liveness} />
          <ContextChip liveness={lane.liveness} />
          {/* Which branch this lane's commits land on — only when it has one of
              its own. With two runs of one repository live, "phase 10 of ccp"
              and "phase 10 of ccp" are the same sentence on two different
              branches, and this is the only thing on the row that tells them
              apart. */}
          <BranchChip branch={lane.child?.branch} base={lane.base} />
          {/* The OTHER half of the claim. A branch alone never proved two
              sessions were not in one checkout — both dimensions must differ
              for the scan to carve them apart (P1's W3) — so a row that draws
              the branch and hides the tree is showing half of the only fact
              that makes two lanes of one plan genuinely parallel. */}
          {claim.tree && (
            <Chip tone="neutral" mono title={`This lane's own checkout: ${claim.tree}`}>
              <FolderGit2 size={11} aria-hidden />
              {claim.tree.split('/').pop()}
            </Chip>
          )}
          {/* …and the lock on that tree (phase 7, said here since phase 15):
              `git worktree remove` refuses it and `prune` skips it while the
              lane lives, which is what protects the lane from a sweep in the
              wrong terminal. Drawn only from the runner's own word — absent
              means no lock this console fastened, never "probably locked". */}
          {claim.locked && (
            <Chip
              tone="neutral"
              data-testid="locked-chip"
              title={`git worktree lock — ${claim.locked}. Removed and pruned by nothing while the lane lives; the runner unlocks it when the lane settles.`}
            >
              <Lock size={11} aria-hidden />
              locked
            </Chip>
          )}
          {claim.shared && (
            <Chip
              tone="neutral"
              title="No checkout of its own: this session edits the run's root, as every run did before worktree lanes existed."
            >
              shared root
            </Chip>
          )}
          {Number.isFinite(started) && (
            <Badge tone="neutral" mono title={`started ${new Date(started).toLocaleString()}`}>
              {elapsed(now - started)}
            </Badge>
          )}
          <Badge tone="neutral" mono title="what this lane has spent so far">
            {money(lane.costUsd)}
          </Badge>
          {lane.eta ? (
            <Badge
              tone="neutral"
              mono
              title={`The server's estimate for a phase this size, from a ${lane.eta.basis} rate reading. A range, never a promise.`}
            >
              {/* `PhaseEta.label` carries its own hedge — it arrives as `~45 min`.
                  Prefixing a second one printed `~~45 min` on the live page,
                  which reads as a typo rather than as an estimate. */}
              {lane.eta.label}
            </Badge>
          ) : (
            <span className="text-2xs text-ink-faint" title="No estimate: this plan has no rate reading yet.">
              no ETA
            </span>
          )}
          {lane.model && (
            <Badge tone="neutral" mono>
              {lane.model}
              {lane.effort ? ` · ${lane.effort}` : ''}
            </Badge>
          )}
        </div>

        {/* A lane that is NOT running says what it is waiting for. The three
            reasons want three different sentences, and "queued" with no
            explanation is the one an operator reads as "stuck". */}
        {/* A `parked` lane said nothing at all here before. The admission
            cap's two-hour park writes its whole account to `note` and sets
            `stop.kind` to `scope-cap`, so the one park an operator most needs
            explained rendered as the bare word "parked". */}
        {lane.status === 'parked' && lane.note && (
          <p className="text-2xs text-waiting" data-testid="park-note">
            {lane.note}
          </p>
        )}
        {lane.status === 'waiting' && lane.parkedUntil && (
          <p className="text-2xs text-waiting">
            Parked until {new Date(lane.parkedUntil).toLocaleString()}
            {lane.parkReason ? ` — ${lane.parkReason}` : ''}
            {lane.watch?.length ? ` · watching ${lane.watch.join(', ')}` : ''}
          </p>
        )}
        {lane.status === 'queued' && (
          <p className="text-2xs text-ink-muted">
            {lane.lockWaitSince ? (
              // A live element rather than a baked string: the whole point of
              // this line is how LONG the wait has been, and a queue that says
              // "since 2 minutes ago" an hour later is worse than silent.
              <>
                Queued behind another owner&rsquo;s claim since{' '}
                <RelativeTime at={lane.lockWaitSince} className="text-2xs" />.
              </>
            ) : (
              'Queued for a scope something else is holding.'
            )}
          </p>
        )}

        {waiters && waiters.length > 0 && (
          <p
            className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted"
            data-testid="lane-waiters"
          >
            <Users size={11} aria-hidden className="text-ink-faint" />
            {waiters.length === 1 ? '1 admission is' : `${waiters.length} admissions are`} waiting on this
            lane
            <span className="text-ink-faint">
              ({waiters.map((w) => `${w.slug}${w.phase == null ? '' : ` P${w.phase}`}`).join(', ')})
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" asChild>
            <a href={planHref(lane.slug, 'run')}>Watch</a>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setInspecting(true)}>
            Inspect
          </Button>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
          >
            <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
            {open ? 'Hide the tail' : 'Tail & steer'}
          </button>
        </div>
      </div>

      <Inspector
        open={inspecting}
        onOpenChange={setInspecting}
        title={`${lane.slug} — phase ${lane.phase}`}
        {...(lane.title ? { description: plainText(lane.title) } : {})}
        meta={
          <>
            <StatusBadge
              state={phaseUiState(lane.status, lane.stop)}
              label={lane.status}
              title={phaseStatusTitle(lane.status, lane.stop)}
            />
            <MonoId id={lane.runId} />
            {claim.session && <MonoId id={claim.session} className="text-ink-faint" />}
          </>
        }
        raw={<pre className="font-mono text-2xs whitespace-pre-wrap">{JSON.stringify(lane, null, 2)}</pre>}
      >
        <InspectorSection heading="Where it is working">
          <KeyValue
            items={[
              ['Run', lane.runId],
              // Every one of the three has a reading for absent, and none of
              // them is a blank: absent means the run's own ground, and a
              // queued lane has no ground at all yet.
              [
                'Branch',
                claim.branch ?? (claim.pending ? 'nothing checked out yet' : "the run's own branch"),
              ],
              ['Checkout', claim.tree ?? (claim.pending ? 'nothing checked out yet' : "the run's own root")],
              ['Session', claim.session ?? 'no live session'],
              ['Attempt', String(lane.attempts)],
              Boolean(lane.model) &&
                (['Model', `${lane.model}${lane.effort ? ` · ${lane.effort}` : ''}`] as const),
            ]}
          />
        </InspectorSection>

        {lane.note && (
          <InspectorSection heading="What it said">
            <p className="text-2xs text-ink-muted">{lane.note}</p>
          </InspectorSection>
        )}

        {waiters && waiters.length > 0 && (
          <InspectorSection heading={`Waiting on this lane (${waiters.length})`}>
            <ul className="flex flex-col gap-1">
              {waiters.map((w) => (
                <li key={w.id} className="text-2xs text-ink-muted">
                  <span className="font-mono">
                    {w.slug}
                    {w.phase == null ? '' : ` P${w.phase}`}
                  </span>{' '}
                  — {waitSummary(w)}
                </li>
              ))}
            </ul>
          </InspectorSection>
        )}
      </Inspector>

      {open && (
        <div className="border-t border-rule">
          {tail?.length ? (
            <ol
              data-testid="lane-tail"
              className="max-h-40 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-2xs leading-relaxed text-ink-muted"
            >
              {tail.map((line) => (
                <li key={line.id} className="truncate">
                  {line.text}
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-3 py-2 text-2xs text-ink-faint">
              Nothing has come through since this page opened. The run page replays what came before.
            </p>
          )}
          {/* Ask and Steer are the same two verbs the run page offers, from the
              same component — the console has ONE way to speak to a session. */}
          <AskBox slug={lane.slug} enabled={running} allowRun={allowRun} phase={lane.phase} />
        </div>
      )}
    </li>
  );
}
