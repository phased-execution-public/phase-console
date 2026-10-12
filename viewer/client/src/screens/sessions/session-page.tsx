/**
 * One session, open — the terminal, owning its height (7.0, quiet-console
 * phase 15; one address for both kinds since 3.0).
 *
 * ```
 * ‹ Sessions  ● Running  zsh  for 12:04                       Switch ⌄   Details
 * ────────────────────────────────────────────────────────────────────────────────
 * ┃ This session exited cleanly 2 minutes ago.                Resume here  Dismiss
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ $ npm test                                                                   │
 * └──────────────────────────────────────────────────────────────────────────────┘
 * [ composer … ]                                                    (an agent)
 * [ Esc  Tab  Ctrl  ↑  ↓  ←  →  …  A−  A+ ]                         (a phone)
 * ```
 *
 * One line of chrome and then the terminal: the session's mark, its name, how
 * long it has run, the other sessions one press away, and Details — the panel,
 * where the vitals, the facts, the controls and the record live (Inspect,
 * design.md principle 3). The page hands the panel this session on arrival
 * without opening it, so Details, ⌘I or the panel already standing all show
 * it. On a phone, while the keyboard is up, even that one line goes: every
 * row of glass belongs to the prompt.
 *
 * `#/sessions/<id>` names a pty of this console's; failing that, a pty already
 * resuming that CONVERSATION (how a foreign session is addressed, so the same
 * address keeps opening the terminal it produced); failing that, the presence
 * registry's record, which is the page that offers to resume it. The kind is
 * read off the record, never out of the address.
 *
 * ## Why the pane is `lazy()`
 *
 * xterm is ~250 KB and Sessions is a destination whose chunk is precached. A
 * static `import './pane'` would fold the emulator into it — downloaded on
 * install by every visitor, including those whose console opens no sessions.
 * The dynamic import keeps it in its own `pane-*` chunk, which `vite.config.ts`
 * leaves out of the precache and `scripts/check-dist.mjs` asserts by name and
 * by content. Nothing else in this folder may import `./pane`.
 */

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, PanelRight } from 'lucide-react';
import type { TerminalSession } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useAutoReadNotifications } from '@/data/inbox';
import { usePlans } from '@/data/plans';
import { useSessionActs, useSessionRegistry, useTerminals, useTerminalsRefresh } from '@/data/sessions';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { usePrefs } from '@/lib/prefs';
import { useKeyboardOpen } from '@/lib/viewport';
import { Banner, Button, Duration, Empty, RelativeTime, Spinner } from '@/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown';
import { SessionStatus } from '@/ui/status';
import { inspect, useInspected } from '@/shell/panel/inspector-host';
import { panelMode, togglePanel } from '@/shell/panel/modes';
import { useNavigate } from '@/shell/router';
import { planHref, sessionsHref, sessionsNewHref } from '@/shell/routes';
import { EndedBanner, SessionGone } from './ended';
import { ForeignSessionPage } from './foreign';
import { inspectSession } from './inspector';
import { NO_TERMINAL, useLaunch, useOpenShell } from './launcher';
import { sessionStateNote, terminalWord } from './model';
import { capOf, capWords } from './sections';

/** The emulator, and nothing else, behind the one dynamic import. */
const TerminalPane = lazy(() => import('./pane'));

export default function SessionPage({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const { data: state } = useConsoleState();
  const allowAgent = state?.allowAgent === true;
  const allowTerminal = state?.allowTerminal === true;
  const terminals = useTerminals(allowAgent || allowTerminal);
  // Who else is on this machine needs no flag (`GET /api/sessions/registry`
  // is display), and this page needs it to answer an address that names a
  // CONVERSATION rather than a pty.
  const registry = useSessionRegistry();
  const refresh = useTerminalsRefresh();
  const { launch, busy: launching } = useLaunch();
  const acts = useSessionActs();
  const [size, setSize] = useState<{ cols: number; rows: number }>();

  const sessions = terminals.data?.sessions ?? [];
  const { atCap, limit } = capOf(terminals.data);
  const open =
    sessions.find((session) => session.id === sessionId) ??
    sessions.find((session) => session.meta?.claudeSessionId === sessionId);
  /** A conversation the presence hook reported and no pty of ours is running. */
  const foreign = open
    ? undefined
    : registry.data?.sessions.find((session) => session.sessionId === sessionId);

  /**
   * An address naming nothing says so — dismissed, or retired after a day —
   * rather than bouncing in a way that reads as a tap that did nothing.
   * ⚠️ `isFetching` is load-bearing: without it the page renders against a
   * list invalidated but not yet re-read, and flashes "gone" over the session
   * that was just created. The registry is part of "settled" too: an address
   * naming a foreign session must not flash "gone" before it answers.
   */
  const settled =
    (allowAgent || allowTerminal) && !terminals.isPending && !terminals.isFetching && !registry.isPending;
  const gone = Boolean(settled && !open && !foreign);

  // Opening the session a notification is about is reading it: the record
  // carries the id (`server/notifications.ts`), so the count drops by exactly
  // this session's endings.
  useAutoReadNotifications({ sessionId }, true);

  /** Where the address goes once the session at it is no longer there. */
  const nextAfter = (id: string): string => {
    const rest = sessions.filter((session) => session.id !== id);
    return rest.length ? sessionsHref(rest[0]!.id) : sessionsHref();
  };
  // The panel's record outlives a render: its verbs read the newest list.
  const latest = useRef({ nextAfter, launch });
  latest.current = { nextAfter, launch };

  // Hand the panel this session — without opening it — and take it back when
  // the page goes, if nobody has put anything else there since.
  const inspected = useInspected();
  const inspectedKey = useRef<string | undefined>(undefined);
  inspectedKey.current = inspected?.key;
  const openId = open?.id;
  const openClaude = open?.kind === 'claude';
  useEffect(() => {
    if (!open) return;
    inspectSession(open, {
      onGone: (id) => navigate(latest.current.nextAfter(id)),
      ...(openClaude ? { onResume: (resume: string) => latest.current.launch({ resume }) } : {}),
      ...(size ? { size } : {}),
      open: false,
    });
    // `open` is read for its id and kind alone; the panel reads the session live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, openClaude, size?.cols, size?.rows, navigate]);
  useEffect(
    () => () => {
      if (inspectedKey.current?.startsWith('session:pty:')) inspect(null);
    },
    [],
  );

  /* ---------------- a session this console does not own ---------------- */

  // Before the flag gates: reading the registry is display, and a console
  // with neither flag can still see who else is on the machine. What may be
  // DONE about it is `--allow-agent`'s business, and the page says so.
  if (foreign) {
    return (
      <Frame>
        <ForeignSessionPage
          session={foreign}
          allowAgent={allowAgent}
          busy={launching}
          capNote={atCap ? capWords(limit) : undefined}
          // The directories this console has any reason to trust: the hook's
          // record is unauthenticated, so the cwd it names decides where a
          // resume runs (`unfamiliarDirectory`).
          roots={[state?.root?.path, ...(state?.recentRoots ?? []).map((entry) => entry.path)].filter(
            (path): path is string => Boolean(path),
          )}
          onResume={() => launch({ resume: foreign.sessionId })}
        />
      </Frame>
    );
  }

  /* ---------------- the ways there is no terminal ---------------- */

  if (!allowAgent && !allowTerminal) {
    return (
      <Frame>
        <Padded>
          <Empty title="This console opens no sessions of its own: a session runs as you, with nothing between it and the machine. Restart the console with --allow-terminal for shells or --allow-agent for Claude sessions." />
        </Padded>
      </Frame>
    );
  }

  if (terminals.data?.available === 'no') {
    return (
      <Frame>
        <Padded>
          <Empty title={NO_TERMINAL} />
        </Padded>
      </Frame>
    );
  }

  if (terminals.isPending || (!open && !gone)) {
    return (
      <Frame>
        <div className="grid flex-1 place-items-center">
          <Spinner label="Opening the session" />
        </div>
      </Frame>
    );
  }

  if (!open) {
    return (
      <Frame>
        {/* The way on is whichever kind this console can start — a shell first, as it always was. */}
        <SessionGone kind={allowTerminal ? 'shell' : 'claude'} />
      </Frame>
    );
  }

  const claude = open.kind === 'claude';
  return (
    <Frame>
      <SessionHead
        session={open}
        others={sessions.filter((one) => one.id !== open.id)}
        allowAgent={allowAgent}
        allowTerminal={allowTerminal}
        cap={atCap ? capWords(limit) : undefined}
      />
      {open.meta?.intent === 'plan' && <PlanWatcher key={open.id} />}
      {open.exited && (
        <EndedBanner
          session={open}
          atCap={atCap}
          busy={launching || acts.busy != null}
          {...(claude ? { onResume: (resume: string) => launch({ resume }) } : {})}
          onDismiss={() =>
            void acts.act('dismiss', open).then((done) => {
              if (done) navigate(nextAfter(open.id));
            })
          }
        />
      )}
      {/* Keyed by session: switching must build a new xterm bound to the new
          pty, never reuse one and replay someone else's scrollback into it. */}
      <Suspense
        fallback={
          <div className="grid flex-1 place-items-center">
            <Spinner label="Loading the terminal" />
          </div>
        }
      >
        <TerminalPane
          key={open.id}
          sessionId={open.id}
          onSession={refresh}
          onSize={setSize}
          onEnded={refresh}
          composer={claude}
        />
      </Suspense>
    </Frame>
  );
}

/**
 * The session fills its region rather than flowing in a page: xterm scrolls
 * itself, and a page that scrolled as well would give a phone two scrollers
 * and no way to the prompt (`shell/routes.ts` `ownsHeight`).
 */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-page">
      {children}
    </div>
  );
}

function Padded({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-(--pad-x) py-(--pad-y)">{children}</div>;
}

/**
 * The one line above the terminal. The way back, the session's mark and name,
 * its clock, the other sessions, and Details. On a phone the clock goes and
 * the two controls are their glyphs (named for a screen reader), so the name
 * keeps what is left; while the keyboard is up the line goes entirely.
 */
function SessionHead({
  session,
  others,
  allowAgent,
  allowTerminal,
  cap,
}: {
  session: TerminalSession;
  others: readonly TerminalSession[];
  allowAgent: boolean;
  allowTerminal: boolean;
  /** Why a new session cannot start now — the cap, said. */
  cap: string | undefined;
}) {
  const phone = usePhone();
  const keyboard = useKeyboardOpen();
  const [prefs] = usePrefs();
  const shell = useOpenShell();
  const navigate = useNavigate();
  if (phone && keyboard) return null;
  const details = prefs.panel.open && panelMode(prefs.panel) === 'details';
  const note = sessionStateNote(session);
  return (
    <div
      data-testid="session-head"
      className="flex min-h-11 min-w-0 shrink-0 items-center gap-2 border-b border-rule px-(--pad-x) py-1"
    >
      <Button size="sm" variant="ghost" asChild className="-ms-2 shrink-0">
        <a href={sessionsHref()} aria-label="Every session">
          <ChevronLeft size={14} aria-hidden />
          <span className="hidden sm:inline">Sessions</span>
        </a>
      </Button>
      <SessionStatus
        vocab="terminal"
        word={terminalWord(session)}
        live={!session.exited}
        className="shrink-0"
      />
      <h1 className="min-w-20 truncate text-body font-semibold text-ink" title={session.cwd}>
        {session.label}
      </h1>
      <span className="hidden shrink-0 text-meta text-ink-muted sm:inline">
        {session.exited ? (
          session.exitedAt ? (
            <>
              ended <RelativeTime at={session.exitedAt} />
            </>
          ) : null
        ) : (
          <>
            {note ? `${note}, ` : ''}for <Duration since={session.createdAt} live />
          </>
        )}
      </span>
      <div className="ms-auto flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Switch to another session"
              data-testid="session-switch"
            >
              <ArrowLeftRight size={14} aria-hidden />
              <span className="hidden sm:inline">Switch</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            {others.length ? (
              <>
                <DropdownMenuLabel>Open another</DropdownMenuLabel>
                {others.map((one) => (
                  <DropdownMenuItem key={one.id} onSelect={() => navigate(sessionsHref(one.id))}>
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span className="min-w-0 truncate">{one.label}</span>
                      <SessionStatus vocab="terminal" word={terminalWord(one)} className="shrink-0" />
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            {allowAgent && (
              <DropdownMenuItem
                disabled={Boolean(cap)}
                onSelect={() => navigate(sessionsNewHref('agent'))}
                className="flex-col items-start gap-0"
              >
                <span>New session</span>
                {cap && <span className="text-meta text-ink-muted">{cap}</span>}
              </DropdownMenuItem>
            )}
            {allowTerminal && (
              <DropdownMenuItem
                disabled={Boolean(cap) || shell.busy}
                onSelect={shell.open}
                className="flex-col items-start gap-0"
              >
                <span>New shell</span>
                {cap && <span className="text-meta text-ink-muted">{cap}</span>}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => navigate(sessionsHref())}>Every session</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={details}
          aria-label="Details"
          data-testid="session-details"
          onClick={() => togglePanel('details')}
          className={cn(details && 'text-ink')}
        >
          <PanelRight size={14} aria-hidden />
          <span className="hidden sm:inline">Details</span>
        </Button>
      </div>
    </div>
  );
}

/**
 * While a plan-writing session runs, say so the moment a NEW plan appears.
 *
 * The console's ordinary plumbing does the work: `new-plan.sh` writes the
 * file, the docs watcher emits `changed`, the plans are read again, and this
 * diffs them against the set it saw on arrival. Keyed by session, so each
 * writing session has its own baseline. Arrive after the plan was written and
 * nothing is said — by then it is on the Plans page already.
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
    <Banner
      severity="ok"
      data-testid="plan-created"
      className="mx-(--pad-x) mt-2 shrink-0"
      action={
        <>
          <Button size="sm" asChild>
            <a href={planHref(created)}>Open the plan</a>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </>
      }
    >
      The plan <span className="font-mono">{created}</span> was written.
    </Banner>
  );
}
