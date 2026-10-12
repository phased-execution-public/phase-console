/**
 * Freeze, Continue and Stop for ONE lane of a run (7.0, quiet-console phase 11).
 *
 * The run's own verbs act on every session at once; watching one phase go
 * wrong in a three-lane run, the control that matters is the one scoped to
 * that session alone. The act is `useLifecycle(slug, phase)` — the door the
 * whole-run verbs press, differing only in naming a phase — so the busy word,
 * the toasts and what is re-read afterwards are the run's own, never a second
 * copy of them.
 *
 * Stop always asks first, and says the one thing that tells it from the run's
 * Stop: the rest of the run carries on. A queued lane has no process, so it
 * offers only Stop, which takes it out of the line rather than ending
 * anything. Without `--allow-run` the controls stay, disabled, with the reason
 * on them.
 */

import type { ChildRef, RunState } from '@/data/api';
import { useLifecycle } from '@/data/lifecycle';
import { Button, ButtonGroup } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';

/**
 * THIS lane's freeze, wherever the run recorded it: `children` first — the
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

export function RunLaneControls({
  slug,
  phase,
  live,
  allowRun,
  frozen,
  queued = false,
}: {
  slug: string;
  phase: number;
  /** The lane holds (or is about to hold) a session; the controls act on nothing otherwise. */
  live: boolean;
  allowRun: boolean;
  frozen: ChildRef['frozen'] | null;
  /** No session yet — only Stop applies, and it takes the phase out of the line rather than ending it. */
  queued?: boolean;
}) {
  const lifecycle = useLifecycle(slug, phase, { queued });
  if (!live) return null;
  const busy = lifecycle.busy;
  const disabled = !allowRun || busy != null;
  const off = allowRun
    ? null
    : 'This console was started without --allow-run, so it cannot act on a session.';

  return (
    <ButtonGroup aria-label={`Phase ${phase} session controls`}>
      {queued ? null : frozen ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          title={off ?? 'Continues mid-token, in the same process'}
          onClick={() => void lifecycle.act('thaw')}
        >
          {busy === 'thaw' ? 'Continuing…' : 'Continue'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          title={
            off ??
            `Stops phase ${phase}'s session where it stands, losing nothing. The other lanes keep working.`
          }
          onClick={() => void lifecycle.act('freeze')}
        >
          {busy === 'freeze' ? 'Freezing…' : 'Freeze'}
        </Button>
      )}
      <ConfirmButton
        size="sm"
        variant="danger"
        destructive
        disabled={disabled}
        title={queued ? `Take phase ${phase} out of the line?` : `Stop phase ${phase}'s session?`}
        description={
          queued
            ? 'Nothing has been spawned yet: stopping takes this phase out of the admission line. The rest of the run carries on, and Retry can put it back later.'
            : 'Only this phase’s session ends: the other lanes keep working and the run carries on scheduling. The session gets SIGTERM, so its own end-of-session hooks still run, and anything already written to the repository stays written.'
        }
        details={
          <p className="max-w-prose text-meta text-ink-muted">
            The phase is recorded as interrupted rather than failed
            {queued ? '.' : ', its session id kept, so Retry can resume it instead of starting over.'} Phases
            that depend on it stay waiting until it is finished properly.
          </p>
        }
        confirmLabel="Stop this phase"
        cancelLabel={queued ? 'Leave it queued' : 'Keep running'}
        onConfirm={() => void lifecycle.act('stop')}
      >
        {busy === 'stop' ? 'Stopping…' : 'Stop'}
      </ConfirmButton>
    </ButtonGroup>
  );
}
