/**
 * The off switch.
 *
 * The console has always had a Restart button and never a Stop one, and the
 * reason is the same fact that makes Restart possible: under launchd
 * `KeepAlive`, exiting IS restarting. There was no way to say "stop" from a page
 * whose server's every exit is a comeback — so the only way to end a console was
 * a terminal and `launchctl`, which is exactly the situation a browser UI is
 * supposed to remove.
 *
 * Two things make this honest rather than a button that hopes:
 *
 *  - **The server does the right thing per supervisor** — `bootout` under
 *    launchd, a graceful exit anywhere else (`server/lifecycle.ts`).
 *  - **The dialog is an inventory, not a warning.** It lists what will stop —
 *    the run (checkpointed) — and, separately, what will not: since the pty
 *    broker landed, terminals and agent sessions outlive the console and come
 *    back with their scrollback. "Are you sure?" is not a question anyone can
 *    answer; "this stops the demo run and keeps 2 agent sessions" is. Which
 *    half a session falls in is READ from the inventory (`survives`), never
 *    assumed — assuming it was the original defect.
 *
 * And it is deliberately not behind `--allow-run`, unlike Restart: a read-only
 * console is the common case, and the one thing every console must be able to do
 * is stop.
 */

import { useEffect } from 'react';
import { Power } from 'lucide-react';
import { api, type SessionInventory } from '@/lib/api';
import { useApiMutation, useShutdownReadiness } from '@/lib/queries';
import { markConsoleStopped } from '@/lib/shutdown';
import { plural } from '@/lib/format';
import { ConfirmButton } from '@/components/ui';

/**
 * Everything this button is about to end, in a sentence a person can check
 * against what they believe is running.
 *
 * Exported because Restart shows the same list: it used to kill every pty on
 * its way through `shutdown()` and never said so, which is the same defect in
 * a different dialog.
 *
 * Sessions appear here only while `survives` is false. Once the ptys belong to
 * the broker they are not stopped by this button at all, and listing them
 * would be the same lie the other way round — so they move to `keepList`.
 */
export function stopList(
  sessions: SessionInventory | undefined,
  run: { slug: string; status: string } | null | undefined,
): string[] {
  const items: string[] = [];
  if (run)
    items.push(
      `the ${run.slug} run (${run.status}) — checkpointed first, and it resumes when the console comes back`,
    );
  if (sessions?.survives) return items;
  if (sessions?.agent) items.push(`${plural(sessions.agent, 'agent session')}`);
  if (sessions?.terminal) items.push(`${plural(sessions.terminal, 'terminal')}`);
  return items;
}

/**
 * What carries on regardless — the other half of the same honesty.
 *
 * A person about to restart wants to know their hour-old `claude` session is
 * safe just as much as they wanted to know it was about to die.
 */
export function keepList(sessions: SessionInventory | undefined): string[] {
  if (!sessions?.survives) return [];
  const items: string[] = [];
  if (sessions.agent) items.push(`${plural(sessions.agent, 'agent session')}`);
  if (sessions.terminal) items.push(`${plural(sessions.terminal, 'terminal')}`);
  return items;
}

/**
 * The list itself, shared by both dialogs so they cannot drift into telling
 * different stories about the same act.
 */
export function StopInventory({
  items,
  keeps = [],
  hint,
}: {
  items: string[];
  keeps?: string[];
  hint?: string;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 text-sm">
      {items.length ? (
        <>
          <span className="text-ink">This stops:</span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-muted">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : (
        !keeps.length && <span className="text-ink-muted">Nothing is running — no session, no run.</span>
      )}
      {keeps.length > 0 && (
        <>
          <span className="text-ink">This keeps running:</span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-muted">
            {keeps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="text-2xs text-ink-faint">
            Terminals are held by a separate process, so they survive this and are still there — with their
            scrollback — when the console comes back.
          </p>
        </>
      )}
      {hint && (
        <p className="text-2xs text-ink-faint">
          To start it again: <code className="font-mono">{hint}</code>
        </p>
      )}
    </div>
  );
}

export function ShutdownButton() {
  const { data: readiness } = useShutdownReadiness();

  const stop = useApiMutation({
    fn: () => api.shutdown(),
    say: 'Shutting down — this is the last thing this console will say.',
    onDone: () => {
      // Recorded before the socket dies: from here on, a stream that stops is
      // this, and the shell must say so rather than "Reconnecting…".
      markConsoleStopped({
        hint: readiness?.restartHint ?? 'start it again from a terminal',
        via: readiness?.stop.via ?? 'exit',
      });
    },
  });

  if (!readiness) return null;

  return (
    <div className="flex flex-col items-start gap-1">
      <ConfirmButton
        size="sm"
        variant="danger"
        busy={stop.isPending}
        busyLabel="Shutting down…"
        title="Shut the console down?"
        description={readiness.stop.detail}
        confirmLabel="Shut down"
        destructive
        details={<FreshInventory />}
        onConfirm={() => stop.mutate()}
      >
        <Power size={14} aria-hidden /> Shut down
      </ConfirmButton>
      <span className="text-2xs text-ink-faint">
        Stops this process and the run it is driving.
        {keepList(readiness.sessions).length > 0
          ? ' Terminals and agent sessions are held by a separate process and keep running.'
          : ' Every session it owns goes with it.'}
        {readiness.stop.via === 'launchctl' && ' The launchd job is unloaded, so it stays off.'}
      </span>
    </div>
  );
}

/**
 * The inventory, re-read as the dialog opens.
 *
 * The trigger used to carry `onClick={() => refetch()}` — which fired for a
 * mouse and for a finger and NOT for the keyboard, and which `ConfirmButton`
 * has no room for anyway. The dialog's body is portalled and mounts on open,
 * so mounting IS the open: this reads on every route in, and the answer it
 * renders is the inventory as of now rather than as of when the page loaded.
 */
function FreshInventory() {
  const { data: readiness, refetch } = useShutdownReadiness();
  useEffect(() => {
    void refetch();
  }, [refetch]);
  if (!readiness) return null;
  return (
    <StopInventory
      items={stopList(readiness.sessions, readiness.run)}
      keeps={keepList(readiness.sessions)}
      hint={readiness.restartHint}
    />
  );
}
