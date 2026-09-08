/**
 * One session, open: the strip, the pane, the composer and the key bar.
 *
 * ## Two pages became one
 *
 * `#/terminal/:id` and `#/agent/:id` were the same page twice — explicit
 * sessions, the id in the URL, the `isFetching`-gated fallback, the cache
 * seeded from the ticket, the same strip, the same pane — differing in which
 * half of ONE registry they filtered to and in three chips. Keeping them apart
 * meant the cap ("8 across shells and agents") had to be explained on both,
 * and a person driving a shell and a Claude session had to know which page
 * each lived on. `#/sessions/:id` resolves the kind from the record, so the
 * address is the session rather than the category.
 *
 * ## What it is NOT
 *
 * It is not the run console. `features/runs/console.tsx` is a read-only,
 * folding view of what an autopilot lane printed; it has no input and is not
 * supposed to gain one. This is the opposite object — an unsupervised process
 * with no policy in front of it — and merging them would mean either giving
 * the run log a prompt or putting the shell behind the approval queue.
 *
 * ## Why the pane is `lazy()` and not a plain import
 *
 * xterm is ~250 KB, and Sessions is one of the eight destinations: its chunk is
 * precached as part of the offline shell like Now's and Plans' are. A static
 * `import './pane'` would put the emulator inside that precached chunk — 89 KB
 * gz downloaded on install by every visitor, including the ones whose console
 * runs with neither `--allow-terminal` nor `--allow-agent`. The dynamic import
 * is what keeps the emulator in its own `pane-*` chunk, which `vite.config.ts`
 * excludes from the precache and `check-dist.mjs` asserts — by NAME, and again
 * by asking which chunk actually contains xterm.
 *
 * Nothing else in this file may import `./pane`, and the light siblings the
 * pane used to re-export (`ended`, `vitals`, `session-controls`) are imported
 * from their own modules here for exactly that reason.
 */

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Sparkles, TerminalSquare, X } from 'lucide-react';
import { planHref } from '@shared/routes.js';
import { api, type TerminalState, type TerminalTicket } from '@/lib/api';
import { usePhone } from '@/lib/media';
import {
  keys,
  useApiMutation,
  useAutoReadNotifications,
  useConsoleState,
  usePlans,
  useSessionRegistry,
  useTerminals,
} from '@/lib/queries';
import { estimateTerminalSize } from '@/lib/terminal';
import { navigate, type Route } from '@/app/router';
import { Button, Chip, Empty, Spinner, toast } from '@/components/ui';
import { EndedBanner, SessionGone } from './ended';
import { SessionVitals } from './vitals';
import { SessionControls, sessionStateNote } from './session-controls';
import { SESSION_HINTS, SessionStrip } from './list';
import { ForeignSessionPage } from './foreign';
import { Launcher, type LaunchBody } from './launcher';
import { MODE_TITLE, modeName } from './modes';
import { NewPlanWizardButton } from './wizard';

/** The emulator, and nothing else, behind the one dynamic import. */
const TerminalPane = lazy(() => import('./pane'));

export interface SessionPageProps {
  route: Route;
  /** The pty id from the address, when there is one. */
  sessionId?: string | undefined;
  /** `?new=agent|shell` — the launcher, with no session open. */
  starting?: 'agent' | 'shell' | undefined;
  /** Rendered above the strip on the phone sheet — lanes and foreign rows. */
  extra?: React.ReactNode;
}

export default function SessionPage({ sessionId, starting, extra }: SessionPageProps) {
  const client = useQueryClient();
  const phone = usePhone();
  const [size, setSize] = useState<{ cols: number; rows: number }>();
  const { data: state } = useConsoleState();
  const allowAgent = state?.allowAgent === true;
  const allowTerminal = state?.allowTerminal === true;
  const { data: terminals, isPending, isFetching } = useTerminals(allowAgent || allowTerminal);
  // Reading who else is on this machine needs no flag (`GET /api/sessions/
  // registry` is display), and this page needs it to answer an address that
  // names a CONVERSATION rather than a pty.
  const { data: registry, isPending: registryPending } = useSessionRegistry();

  // ONE registry, one list — the split into two pages is what this phase
  // removed. The cap has always been on the unfiltered total, and now the list
  // that shows it is the same one it counts.
  const sessions = terminals?.sessions ?? [];
  // Live processes only: ended records stay listed (that is where the
  // `--resume` id lives) and must not hold a slot. `live` is the server's own
  // number; the filter is the fallback for a server that predates it.
  const atCap =
    (terminals?.live ?? sessions.filter((session) => !session.exited).length) >= (terminals?.limit ?? 8);
  /**
   * What the address names, in three tries.
   *
   * 1. A pty of this console's — the ordinary case, and the only one there was.
   * 2. A pty ALREADY RESUMING that conversation. `#/sessions/<conversation id>`
   *    is how a foreign session is addressed (below), and once it has been
   *    resumed that same address must keep opening the terminal it produced
   *    rather than offering to start a third one. It survives a console restart
   *    for free: the broker hands `meta` back with the session it adopts.
   * 3. Neither — see `foreign` below.
   */
  const open =
    sessions.find((session) => session.id === sessionId) ??
    (sessionId ? sessions.find((session) => session.meta?.claudeSessionId === sessionId) : undefined);
  const claude = open ? open.kind === 'claude' : starting === 'agent';
  /** A conversation the presence hook reported and no pty of ours is running. */
  const foreign =
    !open && sessionId ? registry?.sessions.find((session) => session.sessionId === sessionId) : undefined;

  // `void`, never `await`: awaiting an invalidation resolves only when the
  // refetch settles, and awaiting one inside a render path is how P3 deadlocked
  // a whole test file.
  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.terminal() });
  };

  /**
   * A URL naming a session this console does not have used to bounce silently —
   * defensible when sessions timed out while a phone slept, and the wrong answer
   * now that they do not: a session ends when you close it or the console does,
   * so a URL that names nothing means the record was dismissed or retired.
   *
   * ⚠️ `isFetching` is still load-bearing. Without it this renders against a
   * list that has been invalidated but not yet refetched and flashes "gone" over
   * the session that was just created.
   */
  // The registry is part of "settled" now: an address that names a foreign
  // session must not flash "gone" in the window before the registry answers.
  const settled = (allowAgent || allowTerminal) && !isPending && !isFetching && !registryPending;
  const gone = Boolean(settled && sessionId && !open && !foreign);

  // Opening the session a notification is about is reading it. The record
  // carries the id (`server/notifications.ts`), so the count drops by exactly
  // the endings of this session.
  useAutoReadNotifications({ sessionId }, Boolean(sessionId));

  function seed(ticket: TerminalTicket) {
    // Seeded from the response rather than waited for, so the strip and the
    // pane are right on the very next render — the ticket carries the record.
    if (!ticket.session) return;
    client.setQueryData(keys.terminal(), (prev: typeof terminals) =>
      prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] } : prev,
    );
  }

  // The size the pane will settle on, so nothing is born at 80×24 and laid out
  // for a window it is not in; the pane corrects it on open.
  const openShell = useApiMutation<void, TerminalTicket>({
    fn: () => api.terminalTicket(estimateTerminalSize(phone)),
    invalidates: [keys.terminal()],
    onDone: (ticket) => {
      seed(ticket);
      navigate(`sessions/${ticket.sessionId}`);
    },
  });

  const launcher = useApiMutation<LaunchBody, TerminalTicket>({
    fn: (body) => api.agentTicket({ ...body, ...estimateTerminalSize(phone) }),
    invalidates: [keys.terminal()],
    onDone: (ticket) => {
      seed(ticket);
      navigate(`sessions/${ticket.sessionId}`);
    },
  });
  const launch = (body: LaunchBody) => launcher.mutate(body);

  /** Where the address goes when the session at it is no longer there. */
  const nextAfter = (id: string) => {
    const rest = sessions.filter((session) => session.id !== id);
    return rest.length ? `sessions/${rest[0].id}` : 'sessions';
  };

  const close = useApiMutation<string, { closed: boolean; state: TerminalState }>({
    fn: (id) => api.terminalClose(id),
    // Not invalidated: the DELETE answers with the list as it now is, which is
    // authoritative — a refetch behind it would only be a slower second answer.
    onDone: (result, id) => {
      if (result.state) client.setQueryData(keys.terminal(), result.state);
      navigate(nextAfter(id));
    },
  });

  /** Drop an ended record. A live session is closed, never dismissed. */
  const dismiss = useApiMutation<string, { ok: boolean; reason?: string; state: TerminalState }>({
    fn: (id) => api.sessionDismiss(id),
    onDone: (result, id) => {
      // A refusal is an answered request, not a thrown one: the server says why
      // and the record stays, so this is the error leg for a 200 that said no.
      if (!result.ok) {
        toast(String(result.reason ?? 'refused'), 'error');
        return;
      }
      if (result.state) client.setQueryData(keys.terminal(), result.state);
      navigate(nextAfter(id));
    },
  });

  const capNote = atCap
    ? `The limit is ${terminals?.limit ?? 8} running sessions across shells and agents — ` +
      'close one first (ended ones do not count).'
    : undefined;

  /* ---------------- a session this console does not own ---------------- */

  /**
   * Answered BEFORE the three "this console starts no sessions" gates below,
   * because reading the registry is display and needs no flag — a console
   * started with neither flag can still see who else is in the repository, and
   * saying "this console starts no sessions of its own" over a page whose whole
   * subject is somebody else's session would be answering a question nobody
   * asked. What may be DONE about it is `--allow-agent`'s business, and the
   * page itself carries that refusal.
   */
  if (foreign) {
    return (
      <Frame>
        <ForeignSessionPage
          session={foreign}
          allowAgent={allowAgent}
          busy={launcher.isPending}
          capNote={capNote}
          // The directories this console has any reason to trust. A registry
          // record is written by the hook, which is deliberately unauthenticated
          // — so the cwd it names decides where a resume runs and the page must
          // be able to tell "the repository you are working in" from "somewhere
          // else entirely". See `unfamiliarDirectory`.
          roots={[state?.root?.path, ...(state?.recentRoots ?? []).map((entry) => entry.path)].filter(
            (path): path is string => Boolean(path),
          )}
          onResume={() => launch({ resume: foreign.sessionId })}
        />
      </Frame>
    );
  }

  /* ---------------- the ways there is no session ---------------- */

  if (!allowAgent && !allowTerminal) {
    return (
      <Frame>
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title="This console starts no sessions of its own"
          body={
            <>
              A session runs as you, with nothing between it and the machine, so it is a separate decision
              from the autopilot. Restart the console with{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">--allow-terminal</code> for shells or{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">--allow-agent</code> for Claude
              sessions.
            </>
          }
        />
      </Frame>
    );
  }

  if (terminals?.available === 'no') {
    return (
      <Frame>
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title="No terminal available"
          body={
            <>
              <code className="rounded bg-surface-raised px-1 font-mono">node-pty</code> did not load, so this
              console cannot open a pty. Run{' '}
              <code className="rounded bg-surface-raised px-1 font-mono">npm install</code> in the viewer
              directory and restart. Everything else on the console is unaffected.
            </>
          }
        />
      </Frame>
    );
  }

  if (isPending) {
    return (
      <Frame>
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      </Frame>
    );
  }

  /* ---------------- the page ---------------- */

  return (
    <Frame>
      {/* The strip: tabs on a desktop, the open session + a chevron on a phone
          (the sheet behind it lists every session, and carries the controls,
          the lanes this console cannot pane, and the wizard). */}
      <SessionStrip
        sessions={sessions.map((session) => ({
          id: session.id,
          label: session.label,
          note: sessionStateNote(session),
        }))}
        {...(open ? { activeId: open.id } : {})}
        onSelect={(id) => navigate(`sessions/${id}`)}
        onClose={(id) => close.mutate(id)}
        {...(capNote ? { note: capNote } : {})}
        {...(extra ? { extra } : {})}
        actions={
          <>
            {allowAgent && (
              <Button
                size="sm"
                className="ml-1 min-h-(--tap-min) shrink-0"
                disabled={atCap}
                title={capNote ?? 'Configure and start a new Claude session'}
                onClick={() => navigate('sessions?new=agent')}
              >
                <Bot size={14} aria-hidden /> New
              </Button>
            )}
            {allowTerminal && (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-(--tap-min) shrink-0"
                disabled={atCap}
                title={capNote ?? 'Open a new shell in the source directory'}
                onClick={() => openShell.mutate()}
              >
                <Plus size={14} aria-hidden /> New shell
              </Button>
            )}
          </>
        }
        more={
          allowAgent ? (
            <span className="shrink-0">
              <NewPlanWizardButton allowAgent={allowAgent} />
            </span>
          ) : undefined
        }
        details={
          open && (
            <>
              {/* Freeze / Continue / Stop — the lane verbs, for THIS session. */}
              <SessionControls session={open} />
              {/* Plan · phase · elapsed · ETA — the four facts that say what this
                session IS, before the mode chip says how it was launched. */}
              <SessionVitals session={open} />
              {open.kind === 'claude' && (
                <>
                  {/* What the process was STARTED under. ⇧Tab changes the mode
                    inside the session and tells nothing out here, so the chip is
                    a record of the launch and the title says exactly that — a
                    label that silently went stale would be worse than none. */}
                  <Chip mono title={MODE_TITLE}>
                    launched in {modeName(open.meta?.permissionMode)}
                  </Chip>
                  <span className="hidden items-center gap-1.5 text-2xs text-ink-faint md:flex">
                    <kbd className="rounded border border-rule bg-surface-raised px-1 py-0.5 font-mono text-2xs">
                      ⇧Tab
                    </kbd>
                    cycles permission modes
                  </span>
                </>
              )}
              <Chip mono className="hidden shrink-0 md:inline-flex" title={open.cwd}>
                {(size ?? open).cols}×{(size ?? open).rows}
              </Chip>
            </>
          )
        }
        hints={claude ? [...SESSION_HINTS, MODE_TITLE] : SESSION_HINTS}
      />

      {gone ? (
        <SessionGone kind={claude ? 'claude' : 'shell'} />
      ) : open ? (
        <>
          {open.meta?.intent === 'plan' && <PlanWatcher key={open.id} />}
          {open.exited && (
            <EndedBanner
              session={open}
              atCap={atCap}
              {...(open.kind === 'claude' ? { onResume: (resume: string) => launch({ resume }) } : {})}
              onDismiss={(id) => dismiss.mutate(id)}
            />
          )}
          {/* Keyed by session: switching must build a new xterm bound to the new
              pty, not reuse one and replay someone else's scrollback into it. */}
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center">
                <Spinner />
              </div>
            }
          >
            <TerminalPane
              key={open.id}
              sessionId={open.id}
              onSession={refresh}
              onSize={setSize}
              onEnded={refresh}
              composer={open.kind === 'claude'}
            />
          </Suspense>
        </>
      ) : starting === 'agent' && allowAgent ? (
        <Launcher
          {...(state?.root?.path ? { root: state.root.path } : {})}
          disabled={atCap}
          skillsEnabled={Boolean(state?.root?.path)}
          onLaunch={launch}
        />
      ) : (
        // `?new=shell` asked for a shell by name; anything else reached this
        // with no kind in the address at all.
        <Empty
          icon={<TerminalSquare size={28} className="text-ink-faint" aria-hidden />}
          title={starting === 'shell' ? 'No shell open' : 'No session open'}
          body={
            state?.root?.path
              ? `A new shell starts in ${state.root.path}.`
              : 'A new shell starts in your home directory.'
          }
          action={
            allowTerminal ? (
              <Button variant="action" onClick={() => openShell.mutate()}>
                <Plus size={15} aria-hidden /> Open a shell
              </Button>
            ) : undefined
          }
        />
      )}
    </Frame>
  );
}

/**
 * The session fills its region rather than flowing in the page: xterm scrolls
 * itself, and a page that also scrolled would give a phone two scrollbars and
 * no way to reach the prompt.
 */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}

/**
 * Watches the plans list while a plan-authoring session runs, and says so the
 * moment a NEW slug appears.
 *
 * The mechanism is the console's ordinary plumbing: `new-plan.sh` writes the
 * file → the docs watcher emits `changed` → `EVENT_EFFECTS` invalidates
 * `keys.plans()` → this refetch diffs against the baseline taken on mount.
 * Keyed by session id, so each authoring session gets its own baseline.
 *
 * Known limit, accepted: the baseline is per-mount — open the page for the
 * first time AFTER the plan was written and there is no banner, because the
 * plan is already on the Plans page by then.
 */
function PlanWatcher() {
  const { data: plans } = usePlans(true);
  const baseline = useRef<Set<string> | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!plans) return;
    const seen = baseline.current;
    if (!seen) {
      baseline.current = new Set(plans.map((plan) => plan.slug));
      return;
    }
    const fresh = plans.find((plan) => !seen.has(plan.slug));
    if (fresh) setCreated((current) => current ?? fresh.slug);
  }, [plans]);

  if (!created || dismissed) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-surface px-3 py-2 text-sm">
      <Sparkles size={14} className="shrink-0 text-action" aria-hidden />
      <span>
        Plan <code className="rounded bg-surface-raised px-1 font-mono">{created}</code> was created —{' '}
        <a className="text-action underline underline-offset-2" href={planHref(created)}>
          open it
        </a>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="ml-auto flex size-(--tap-min) shrink-0 items-center justify-center text-ink-faint hover:text-ink"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
