/**
 * Restarting the console from the console.
 *
 * The stale-code banner has said "restart it" since the day it was written and
 * could never do it, because the one thing a browser cannot do is relaunch a
 * process. What makes it possible is the supervisor: under launchd `KeepAlive`
 * a clean exit comes straight back within seconds, and under `./run` or the
 * desktop launcher nothing does. So the button asks the server first and says
 * which it is. Where nothing is watching the server no longer refuses: it
 * starts its own successor with its own argv before it exits (`selfRestart`),
 * so the button restarts the console with every flag it was started with.
 *
 * Refused outright while a run is in flight, and that refusal is not overridable
 * from here: a restart aborts the child mid-phase and expires every pending
 * approval unanswerably.
 *
 * Ported from `web/components/restart.js`, with the native `confirm()` replaced
 * by a focus-trapped `AlertDialog` — the same change Phase 4 made to Stop.
 */

import { api } from '@/lib/api';
import { useApiMutation, useConsoleState, useRestartReadiness } from '@/lib/queries';
import { Button, ConfirmButton } from '@/components/ui';
import { StopInventory, keepList, stopList } from './shutdown';

/** How long to wait before reloading. The server's own drain budget is 120s,
 *  but an idle console has nothing registered and comes back almost at once. */
const RELOAD_AFTER_MS = 4_000;

export function RestartButton({ verbose = false }: { verbose?: boolean }) {
  const { data: state } = useConsoleState();
  const { data: readiness, refetch } = useRestartReadiness();

  const restart = useApiMutation({
    fn: () => api.restart(),
    say: 'Restarting — this page reloads by itself in a moment.',
    onDone: () => {
      // Nothing here can await the server coming back: the socket this request
      // arrived on is about to close. A reload after the drain is the honest
      // way to return.
      setTimeout(() => location.reload(), RELOAD_AFTER_MS);
    },
  });

  if (!readiness) return null;

  if (!state?.allowRun) {
    return (
      <span className="text-2xs text-ink-muted">
        Restarting is a run-class action — this console was started without <code>--allow-run</code>.
      </span>
    );
  }

  if (!readiness.ok) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="text-2xs text-ink-muted">Cannot restart from here — {readiness.reason}</span>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          Check again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <ConfirmButton
        size="sm"
        busy={restart.isPending}
        busyLabel="Restarting…"
        title="Restart the console?"
        description={
          readiness.selfRestart
            ? 'Nothing is supervising this console, so it starts itself again with the arguments it was started with — every capability included — and then exits. A few seconds with no server; this page reloads itself afterwards.'
            : 'It exits and its supervisor starts it again — a few seconds with no server. This page reloads itself afterwards.'
        }
        confirmLabel="Restart"
        details={
          /* A restart used to kill every pty on its way out — `shutdown()`
             calls `service.close()` — and never said so, which is the same
             defect the Shut-down dialog was written to avoid. The pty broker
             made it untrue; both dialogs render the same inventory from the
             same two functions so neither can drift back to claiming it. */
          <StopInventory
            items={stopList(readiness.sessions, readiness.run)}
            keeps={keepList(readiness.sessions)}
          />
        }
        onConfirm={() => restart.mutate()}
      >
        Restart the console
      </ConfirmButton>
      {verbose && <span className="text-2xs text-ink-muted">{readiness.supervisor?.detail}</span>}
    </div>
  );
}
