/**
 * Restarting the console from the console (7.0's since quiet-console phase 23).
 *
 * ```
 * Restart
 * Node reads server/ once, at startup — a fix on disk does nothing until this
 * process is replaced. Restart brings it back with every flag it started with.
 * [Restart the console]  [Restart without updating]
 * ```
 *
 * A browser cannot relaunch a process; a supervisor can. Under launchd
 * `KeepAlive` a clean exit comes straight back; where nothing is watching, the
 * server starts its own successor with its own argv before it exits — so the
 * button asks the server first (`GET /api/restart`) and says which it is.
 *
 * Three forms beside the plain press, each a field of `POST /api/restart`:
 *
 *   - **without updating** (`update: false`) — a press that can update the copy
 *     does so first; this one restarts on what is installed;
 *   - **when the live sessions finish** (`whenIdle`) — mid-run a restart is
 *     refused, because it aborts every session a run drives; this one holds new
 *     phases, lets the live ones finish, then updates and restarts;
 *   - **anyway** (`force`) — past a refusal that is NOT a run in flight: no
 *     supervisor to bring it back, or a launch unit whose arguments drifted —
 *     it restarts as it is. A run in flight is never forced.
 *
 * The page comes back when the CONSOLE does: the server names its process on
 * `/api/state` (`bootedAt`), and the page reloads once a different one answers
 * (`cameBack`), or after `RELOAD_GIVE_UP_MS`, so a console that never returns
 * is shown rather than waited on for ever.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ConsoleState, type RestartReadiness } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { keys } from '@/data/keys';
import { useRestartReadiness } from '@/data/machine';
import { Button, Mono, Skeleton, Spinner, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { SettingsGroup, failureWords, readFailureClause } from './setting';
import { StopInventory, keepList, stopList } from './shutdown';

/** How often the page asks whether the console is back. */
const COMEBACK_POLL_MS = 1_000;
/** Past this, reload anyway: a console that never came back is shown, not waited on. */
const RELOAD_GIVE_UP_MS = 5 * 60_000;

/** The forms of a restart — the fields `POST /api/restart` takes besides the bare press. */
export interface RestartForm {
  update?: boolean;
  whenIdle?: boolean;
  force?: boolean;
}

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

/** How the process comes back, said before any press. */
export function exitSentence(readiness: Pick<RestartReadiness, 'selfRestart'>): string {
  return readiness.selfRestart
    ? 'Nothing is supervising this console, so it starts itself again with the arguments it was started with — every capability included — and then exits. A few seconds with no server; this page reloads itself afterwards.'
    : 'It exits and its supervisor starts it again — a few seconds with no server. This page reloads itself afterwards.';
}

/** What the plain press will do: the update it makes first where it can, then the exit. */
export function restartDescription(readiness: RestartReadiness): string {
  const exit = exitSentence(readiness);
  return exit;
}

/** A refusal the press came back with, and the one command that moves it, when there is one. */
interface Refusal {
  reason: string;
  command?: string | undefined;
}

export function RestartGroup() {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const { data: readiness, refetch, isPending, error: readinessError } = useRestartReadiness();
  // The process the press was made against — the page is back when another answers.
  const before = useRef<string | undefined>(undefined);
  const [awaiting, setAwaiting] = useState<{ before: string | undefined } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  useReloadWhenBack(awaiting);


  const press = async (which: string, form: RestartForm & { cancel?: boolean }) => {
    setBusy(which);
    setRefused(null);
    before.current = state?.bootedAt;
    try {
      const outcome = await api.restart(form);
      if (form.cancel) toast('The waiting restart is called off — new phases start again.', 'ok');
      else if (outcome.waiting)
        toast('The console restarts once the live sessions finish — no new phase starts meanwhile.', 'ok');
      else if (outcome.updating)
        toast(
          'Updating to the latest version first — the console restarts once the new build is in place.',
          'ok',
        );
      else {
        toast('Restarting — this page reloads by itself once the console is back.', 'ok');
        setAwaiting({ before: before.current });
      }
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as Partial<Refusal> | undefined) : undefined;
      if (error instanceof ApiError && error.status === 409 && typeof body?.reason === 'string') {
        setRefused({
          reason: body.reason,
          command: typeof body.command === 'string' ? body.command : undefined,
        });
      } else toast(failureWords(error), 'error');
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.restart() });
    }
  };

  const lead =
    'Node reads server/ once, at startup: a fix on disk does nothing until this process is replaced, and a reload of the page reloads only the page. Restart brings it back with every flag it was started with.';

  let body: ReactNode;
  if (isPending || (readiness && !state)) {
    // Both reads, before any sentence: the flags come with the state, and a
    // readiness that answered first must not say "needs --allow-run" meanwhile.
    body = <Skeleton className="h-10" aria-busy="true" />;
  } else if (!readiness) {
    body = (
      <div className="flex min-w-0 flex-col items-start gap-2" data-testid="restart-unread">
        <p className="max-w-(--measure) text-meta text-ink-muted">
          The console did not say whether it can restart from here
          {readFailureClause(readinessError)}.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void refetch()}>
          Check again
        </Button>
      </div>
    );
  } else if (!state?.allowRun) {
    body = (
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Restarting needs <code className="font-mono">--allow-run</code>: it ends a process that may be driving
        sessions. Shut down, below, needs nothing.
      </p>
    );
  } else if (awaiting) {
    body = <Spinner label="Restarting — this page reloads once the console is back…" />;
  } else {
    body = (
      <RestartActs
        readiness={readiness}
        busy={busy}
        refused={refused}
        onPress={(which, form) => void press(which, form)}
        // A refusal is the answer to one press: asking again starts from the server's word.
        onCheck={() => {
          setRefused(null);
          void refetch();
        }}
      />
    );
  }

  return (
    <SettingsGroup id="restart" title="Restart" lead={lead}>
      <div className="flex min-w-0 flex-col gap-3" data-testid="restart-acts">
        {body}
      </div>
    </SettingsGroup>
  );
}

function RestartActs({
  readiness,
  busy,
  refused,
  onPress,
  onCheck,
}: {
  readiness: RestartReadiness;
  busy: string | null;
  refused: Refusal | null;
  onPress: (which: string, form: RestartForm) => void;
  onCheck: () => void;
}) {
  const inventory = (
    <StopInventory items={stopList(readiness.sessions, readiness.run)} keeps={keepList(readiness.sessions)} />
  );
  const anyway = (why: string) => (
    <ConfirmButton
      size="sm"
      busy={busy !== null}
      title="Restart the console anyway?"
      description={`${why} It restarts as it is, and this page reloads once it is back — or says it did not come back.`}
      confirmLabel="Restart anyway"
      details={inventory}
      onConfirm={() => onPress('force', { force: true })}
    >
      {busy === 'force' ? 'Restarting…' : 'Restart anyway'}
    </ConfirmButton>
  );

  if (refused) {
    return (
      <div className="flex min-w-0 flex-col items-start gap-2" role="status">
        <p className="max-w-(--measure) text-body text-ink">Refused: {refused.reason}</p>
        {refused.command && <Mono value={refused.command} copyable className="min-w-0 wrap-anywhere" />}
        <span className="flex flex-wrap gap-2">
          {anyway('The refusal above stands until its command runs.')}
          <Button size="sm" variant="ghost" onClick={onCheck}>
            Check again
          </Button>
        </span>
      </div>
    );
  }

  if (readiness.ok) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ConfirmButton
          size="sm"
          busy={busy !== null}
          title="Restart the console?"
          description={restartDescription(readiness)}
          confirmLabel="Restart"
          details={inventory}
          onConfirm={() => onPress('restart', {})}
        >
          {busy === 'restart' ? 'Restarting…' : 'Restart the console'}
        </ConfirmButton>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <p className="max-w-(--measure) text-body text-ink">
        {readiness.busy ? 'Not now' : 'Not from here'}: {readiness.reason}
      </p>
      <span className="flex flex-wrap gap-2">
        {!readiness.busy && anyway(`${readiness.reason}.`)}
        <Button size="sm" variant="ghost" onClick={onCheck}>
          Check again
        </Button>
      </span>
    </div>
  );
}
