/**
 * Freeze / Continue / Stop for ONE lane of a run.
 *
 * The run-level controls act on every session at once; watching one phase go
 * wrong in a three-lane run, the control that matters is the one scoped to
 * that session alone.
 *
 * The ACT is `useRunLifecycle(slug, phase)` — the same hook the whole-run
 * controls and the fleet banner use, differing only in whether a phase is
 * named. This module owned its own busy string, its own toasts and its own
 * invalidation set until phase 18; so did two other files, over the same three
 * endpoints, and no two of the three refreshed the same queries.
 */

import { useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Button, ButtonGroup } from '@/components/ui';
import { useRunLifecycle } from '@/lib/run-lifecycle';
import type { ChildRef, RunState } from '@/lib/api';

/**
 * THIS lane's freeze, wherever the run recorded it. `children` first — the
 * per-lane truth — with the single-slot `freeze` as the fallback for a run
 * written by a console from before lanes carried their own.
 */
export function laneFrozen(run: RunState | null | undefined, phase: number): ChildRef['frozen'] | null {
  if (!run) return null;
  const child = run.children?.[String(phase)];
  if (child?.frozen) return child.frozen;
  if (run.freeze && run.freeze.phase === phase) {
    return { at: run.freeze.at, by: run.freeze.by, escalateAt: run.freeze.escalateAt };
  }
  return null;
}

export function LaneControls({
  slug,
  phase,
  live,
  allowRun,
  frozen,
  queued = false,
}: {
  slug: string;
  phase: number;
  /** The lane holds (or is about to hold) a session; controls act on nothing otherwise. */
  live: boolean;
  allowRun: boolean;
  frozen: ChildRef['frozen'] | null;
  /** No session yet — only Stop makes sense, and it dequeues rather than kills. */
  queued?: boolean;
}) {
  const lifecycle = useRunLifecycle(slug, phase, { queued });
  const [confirming, setConfirming] = useState(false);
  const busy = lifecycle.busy;

  if (!live) return null;
  const disabled = !allowRun || busy != null;
  const offTitle = allowRun ? null : 'Needs --allow-run';

  return (
    <ButtonGroup aria-label={`Phase ${phase} session controls`}>
      {queued ? null : frozen ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          title={offTitle ?? 'Continues mid-token, in the same process'}
          onClick={() => void lifecycle.thaw()}
        >
          {busy === 'thaw' ? 'Continuing…' : 'Continue'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          title={
            offTitle ??
            `Stops phase ${phase}'s session where it stands, losing nothing. The other lanes keep working.`
          }
          onClick={() => void lifecycle.freeze()}
        >
          {busy === 'freeze' ? 'Freezing…' : 'Freeze'}
        </Button>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="danger" disabled={disabled} title={offTitle ?? undefined}>
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          title={queued ? `Take phase ${phase} out of the line?` : `Stop phase ${phase}'s session?`}
          confirmLabel="Stop this phase"
          cancelLabel={queued ? 'Leave it queued' : 'Keep running'}
          destructive
          onConfirm={() => {
            setConfirming(false);
            void lifecycle.stop();
          }}
        >
          {queued ? (
            <p className="mt-2 text-sm text-ink-muted">
              Nothing has been spawned yet — stopping takes this phase out of the admission line. The rest of
              the run carries on, and Retry can put it back later.
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              Only this phase&rsquo;s session ends — the other lanes keep working and the run carries on
              scheduling. The session gets SIGTERM, so its own end-of-session hooks still run, and anything
              already written to the repository stays written.
            </p>
          )}
          <p className="mt-2 text-2xs text-ink-faint">
            The phase is recorded as <strong>interrupted</strong> rather than failed
            {queued ? '.' : ', its session id kept — Retry can resume it instead of starting over.'} Phases
            that depend on it stay waiting until it is finished properly.
          </p>
        </AlertDialogContent>
      </AlertDialog>
    </ButtonGroup>
  );
}
