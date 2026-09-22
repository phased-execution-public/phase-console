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
 * The page comes back when the CONSOLE does (2026-09-18). It used to reload
 * four seconds after the press — right for an idle console, wrong for a drain
 * (up to two minutes), and wrong by a minute for a restart that updates and
 * builds first. The server names its process on `/api/state` (`bootedAt`); the
 * page reloads once a different one answers (`cameBack`), or after
 * `RELOAD_GIVE_UP_MS`, so a console that never returns is shown rather than
 * waited on for ever.
 *
 * Ported from `web/components/restart.js`, with the native `confirm()` replaced
 * by a focus-trapped `AlertDialog` — the same change Phase 4 made to Stop.
 */

import { useEffect, useRef, useState } from 'react';

import { api, type ConsoleState, type RestartReadiness } from '@/lib/api';
import { useApiMutation, useConsoleState, useRestartReadiness } from '@/lib/queries';
import { Button, ConfirmButton, Spinner } from '@/components/ui';
import { StopInventory, keepList, stopList } from './shutdown';

/** How often the page asks whether the console is back. */
const COMEBACK_POLL_MS = 1_000;
/** Past this, reload anyway: a console that never came back is shown, not waited on. */
const RELOAD_GIVE_UP_MS = 5 * 60_000;

/**
 * Is the restart over for this page? A different process answering is the
 * proof (`bootedAt`); a server too old to name itself is judged by the one
 * thing that still tells — it went away, and something answers again.
 */
export function cameBack(
  before: string | undefined,
  now: ConsoleState | undefined,
  sawDown: boolean,
): boolean {
  if (!now) return false;
  if (before && now.bootedAt) return now.bootedAt !== before;
  return sawDown;
}

/** Once a restart is under way, ask until the console is back as a new process, then reload. */
function useReloadWhenBack(awaiting: { before: string | undefined } | null) {
  useEffect(() => {
    if (!awaiting) return;
    let sawDown = false;
    let done = false;
    const giveUp = setTimeout(() => location.reload(), RELOAD_GIVE_UP_MS);
    const tick = setInterval(() => {
      api.state().then(
        (now) => {
          if (done || !cameBack(awaiting.before, now, sawDown)) return;
          done = true;
          location.reload();
        },
        () => {
          sawDown = true;
        },
      );
    }, COMEBACK_POLL_MS);
    return () => {
      done = true;
      clearInterval(tick);
      clearTimeout(giveUp);
    };
  }, [awaiting]);
}

/** What pressing it will do, said before it is pressed. */
function restartDescription(readiness: RestartReadiness): string {
  const exit = readiness.selfRestart
    ? 'Nothing is supervising this console, so it starts itself again with the arguments it was started with — every capability included — and then exits. A few seconds with no server; this page reloads itself afterwards.'
    : 'It exits and its supervisor starts it again — a few seconds with no server. This page reloads itself afterwards.';
  return exit;
}

export function RestartButton({ verbose = false }: { verbose?: boolean }) {
  const { data: state } = useConsoleState();
  const { data: readiness, refetch } = useRestartReadiness();
  // The process the press was made against — the page is back when another answers.
  const before = useRef<string | undefined>(undefined);
  const [awaiting, setAwaiting] = useState<{ before: string | undefined } | null>(null);
  useReloadWhenBack(awaiting);

  const restart = useApiMutation({
    fn: () => {
      before.current = state?.bootedAt;
      return api.restart();
    },
    say: (outcome) =>
      outcome?.updating
        ? 'Updating to the latest version first — the console restarts once the new build is in place.'
        : 'Restarting — this page reloads by itself once the console is back.',
    onDone: (outcome) => {
      // An update first: the card follows it (the `restart` event and a poll),
      // and the wait for the new process starts when the update has answered.
      if (outcome?.updating) void refetch();
      else setAwaiting({ before: before.current });
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


  if (awaiting) {
    return <Spinner className="text-2xs" label="Restarting — this page reloads once the console is back…" />;
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      {readiness.ok ? (
        <div className="flex flex-wrap items-baseline gap-2">
          <ConfirmButton
            size="sm"
            busy={restart.isPending}
            busyLabel="Restarting…"
            title="Restart the console?"
            description={restartDescription(readiness)}
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
      ) : (
        <>
          <span className="text-2xs text-ink-muted">Cannot restart from here — {readiness.reason}</span>
          <Button variant="ghost" size="sm" onClick={() => void refetch()}>
            Check again
          </Button>
        </>
      )}
    </div>
  );
}
