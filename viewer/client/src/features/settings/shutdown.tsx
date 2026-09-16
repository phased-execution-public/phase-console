/**
 * The off switch — at the strength asked for (zero-touch phase 16, SHD-1/2/5).
 *
 * Two presses now, because one verb was doing two jobs and promising a third:
 * **Shut down** exits (under launchd `KeepAlive` it comes straight back, and
 * the dialog says so), and **Stay off…** unloads and DISABLES the unit and
 * leaves a stop marker a boot honours, naming the command that undoes it. Both
 * dialogs render the server's inventory — lanes, clocks, runs on disk, live
 * sessions, cards, unread inboxes — and confirming acknowledges it; the server
 * refuses a bare press over a non-empty one. The old caption promised "The
 * launchd job is unloaded, so it stays off" over a bootout the next login
 * undid; each sentence here is now what its press achieves.
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
import type { ShutdownMode } from '@shared/ops-vocab.js';
import {
  api,
  type SessionInventory,
  type ShutdownInventory,
  type ShutdownOutcome,
  type StopPlanView,
} from '@/lib/api';
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
  acknowledging = false,
}: {
  items: string[];
  keeps?: string[];
  hint?: string;
  /**
   * The list is the SERVER's inventory, and confirming acknowledges it (SHD-1):
   * the empty state may then say that nothing at all is in flight, armed, owed,
   * live, pending or unread — because it was measured, not assumed.
   */
  acknowledging?: boolean;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 text-sm">
      {items.length ? (
        <>
          <span className="text-ink">
            {acknowledging ? 'This console is holding — confirming stops all of it:' : 'This stops:'}
          </span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-muted">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : (
        !keeps.length && (
          <span className="text-ink-muted">
            {acknowledging
              ? 'Nothing is running, armed, waiting or unread — no lane, no clock, no run, no session, no card.'
              : 'Nothing is running — no session, no run.'}
          </span>
        )
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

/**
 * The inventory as sentences a person can check (SHD-1): every lane, the
 * soonest clock the exit breaks, the runs on disk the next boot picks up, the
 * live sessions it stops watching, the cards still pending and what is written
 * and not yet read. Empty only when all of that is.
 */
export function inventoryItems(inventory: ShutdownInventory | undefined): string[] {
  if (!inventory) return [];
  const items: string[] = [];
  for (const lane of inventory.lanes) {
    items.push(
      `${lane.slug} phase ${lane.phase}${lane.pid ? ` (pid ${lane.pid})` : ''} — its session is ended and the phase checkpoints`,
    );
  }
  // The soonest WORK clock first — an inbox debounce a few hundred milliseconds
  // out is listed by the count, never named in front of the resume due in an hour.
  const byTime = [...inventory.clocks].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const soonest =
    byTime.find((c) => c.source !== 'outcome-inbox' && c.source !== 'session-inbox') ?? byTime[0];
  if (soonest) {
    const whose = soonest.slug
      ? ` for ${soonest.slug}${soonest.phase != null ? ` phase ${soonest.phase}` : ''}`
      : '';
    const more = inventory.clocks.length - 1;
    items.push(
      `the ${soonest.source} clock${whose} due ${new Date(soonest.at).toLocaleString()}` +
        (more > 0 ? ` and ${plural(more, 'more clock')}` : '') +
        ' — nothing fires while the console is off; the next boot rules on each one',
    );
  }
  for (const run of inventory.runs.filter((r) => !r.live)) {
    items.push(
      `the ${run.slug} run (${run.status}${run.waitUntil ? `, until ${new Date(run.waitUntil).toLocaleString()}` : ''}) — picked back up at the next boot`,
    );
  }
  if (inventory.liveSessions.length) {
    items.push(
      `${plural(inventory.liveSessions.length, 'live Claude session')} this console is watching (${inventory.liveSessions
        .slice(0, 3)
        .map((session) => session.sessionId.slice(0, 8))
        .join(', ')}) — they keep running, unwatched`,
    );
  }
  if (inventory.pendingApprovals.length) {
    items.push(
      `${plural(inventory.pendingApprovals.length, 'pending approval')} — answerable again after the restart, or said to be not`,
    );
  }
  const { sessions, outcomes } = inventory.inboxDepth;
  if (sessions || outcomes) {
    items.push(
      [sessions ? plural(sessions, 'presence event') : '', outcomes ? plural(outcomes, 'declaration') : '']
        .filter(Boolean)
        .join(' and ') + ' not yet read',
    );
  }
  return items;
}

/** What a strength achieves, said before the press (SHD-5) — the one promise each dialog makes. */
export function durabilitySentence(plan: StopPlanView | null | undefined, hint?: string | null): string {
  if (!plan) return '';
  switch (plan.durability) {
    case 'returns':
      return 'Its supervisor starts it again within seconds: every run checkpoints and resumes.';
    case 'until-login':
      return 'Nothing brings it back now; the next login starts the unit again.';
    case 'disabled':
      return `The unit is unloaded and disabled and a stop marker holds its automation, so it stays off — a login does not bring it back.${plan.resurrect ? ` To start it again: ${plan.resurrect}` : ''}`;
    default:
      return `Nothing brings it back.${hint ? ` To start it again: ${hint}` : ''}`;
  }
}

export function ShutdownButton() {
  const { data: readiness } = useShutdownReadiness();

  const stop = useApiMutation<ShutdownMode, ShutdownOutcome>({
    fn: (mode) => api.shutdown({ mode, acknowledge: true }),
    say: (_result, mode) =>
      mode === 'unload'
        ? 'Shutting down to stay off — this is the last thing this console will say.'
        : 'Shutting down — this is the last thing this console will say.',
    onDone: (_result, mode) => {
      const plan = mode === 'unload' ? readiness?.modes?.unload : (readiness?.modes?.exit ?? readiness?.stop);
      // Recorded before the socket dies: from here on, a stream that stops is
      // this, and the shell must say so rather than "Reconnecting…". A console
      // whose supervisor brings it straight back IS reconnecting, and says so.
      if (plan?.durability === 'returns') return;
      markConsoleStopped({
        hint:
          mode === 'unload'
            ? (plan?.resurrect ?? readiness?.unloadHint ?? '')
            : (readiness?.restartHint ?? 'start it again from a terminal'),
        via: plan?.via ?? 'exit',
      });
    },
  });

  if (!readiness) return null;
  const exitPlan = readiness.modes?.exit ?? readiness.stop;
  const unloadPlan = readiness.modes?.unload ?? null;

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmButton
          size="sm"
          variant="danger"
          busy={stop.isPending && stop.variables !== 'unload'}
          busyLabel="Shutting down…"
          title="Shut the console down?"
          description={`${exitPlan.detail}. ${durabilitySentence(exitPlan, readiness.restartHint)}`}
          confirmLabel="Shut down"
          destructive
          details={<FreshInventory mode="exit" />}
          onConfirm={() => stop.mutate('exit')}
        >
          <Power size={14} aria-hidden /> Shut down
        </ConfirmButton>
        {unloadPlan && (
          <ConfirmButton
            size="sm"
            variant="danger"
            busy={stop.isPending && stop.variables === 'unload'}
            busyLabel="Shutting down…"
            title="Shut the console down and keep it off?"
            description={`${unloadPlan.detail}. ${durabilitySentence(unloadPlan)}`}
            confirmLabel="Stay off"
            destructive
            details={<FreshInventory mode="unload" />}
            onConfirm={() => stop.mutate('unload')}
          >
            <Power size={14} aria-hidden /> Stay off…
          </ConfirmButton>
        )}
      </div>
      <span className="text-2xs text-ink-faint">
        {exitPlan.durability === 'returns'
          ? 'Shut down stops this process and its work checkpoints; its supervisor brings it straight back.'
          : 'Shut down stops this process and the work it is driving.'}
        {keepList(readiness.sessions).length > 0
          ? ' Terminals and agent sessions are held by a separate process and keep running.'
          : ' Every session it owns goes with it.'}
        {unloadPlan &&
          ' Stay off unloads and disables the unit and leaves a stop marker, so not even a login brings the work back until it is started again.'}
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
function FreshInventory({ mode }: { mode: ShutdownMode }) {
  const { data: readiness, refetch } = useShutdownReadiness();
  useEffect(() => {
    void refetch();
  }, [refetch]);
  if (!readiness) return null;
  // An older server has no inventory: fall back to what it can say.
  const items = readiness.inventory
    ? inventoryItems(readiness.inventory)
    : stopList(readiness.sessions, readiness.run);
  const hint =
    mode === 'unload'
      ? (readiness.modes?.unload?.resurrect ?? readiness.unloadHint ?? undefined)
      : readiness.restartHint;
  return (
    <StopInventory
      items={items}
      keeps={keepList(readiness.sessions)}
      {...(hint ? { hint } : {})}
      {...(readiness.inventory ? { acknowledging: true } : {})}
    />
  );
}
