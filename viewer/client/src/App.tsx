import { Suspense, useEffect, useRef } from 'react';
import { Power, WifiOff } from 'lucide-react';
import { useOnline, useServiceWorker } from '@/lib/pwa';
import { rememberRoot } from '@/lib/persist';
import { usePhone } from '@/lib/media';
import { onSse, useSseStatus } from '@/lib/sse';
import { armTabNotifications } from '@/lib/tab-notify';
import { useConsoleStopped } from '@/lib/shutdown';
import {
  shellCounts,
  useAttentionInbox,
  useApprovals,
  useConsoleState,
  useLiveData,
  useMcp,
  usePlans,
  useSessions,
} from '@/lib/queries';
import { Banner, Skeleton, Spinner, Toaster, TooltipProvider, toast } from '@/components/ui';
import { installAppHeight } from '@/lib/viewport';
import { preloadView, resolveView, useNavigate, useRoute } from '@/app/router';
import { CHROMELESS_HEADS, FULL_HEIGHT_HEADS, openOverlay, redirectTarget } from '@/app/routes';
import { RouteFrame } from '@/app/shell/route-frame';
import { ShellLayout } from '@/app/shell/layout';
import { Palette } from '@/app/command/palette';
import { NotificationsDrawer } from '@/app/notifications/drawer';
import { HelpSheet } from '@/app/help/sheet';
import { ResumeAsk } from '@/app/shell/resume-ask';
import { Disconnected } from '@/app/shell/disconnected';
import { FleetFrozenBanner } from '@/components/fleet-freeze';

/**
 * The composition root.
 *
 * Everything that used to be *in* here is somewhere better now: the grid, the
 * rail, the tab bar and the one scroller are `app/shell/layout.tsx`; the route
 * table is `app/router.tsx`; the keyboard shortcuts belong to the palette that
 * implements them. What is left is the four things only a root can do — mount
 * the live data once, decide whether there is a console to talk to at all,
 * follow a redirect, and hang the three overlays where every page can reach them.
 */

/**
 * A recovery session's verdict, toasted as it lands.
 *
 * The `recovery-outcome` payload had no client consumer at all for a while —
 * the run was fixed on disk and every open tab kept its halt banner. The query
 * invalidation lives in `patchSessions`; this is only the sentence.
 */
function useRecoveryOutcomeToasts(): void {
  useEffect(
    () =>
      onSse('sessions', (data) => {
        const record = data as {
          type?: string;
          recovery?: { fixed?: boolean; headline?: string; detail?: string; synced?: boolean };
        };
        if (record.type !== 'recovery-outcome' || !record.recovery) return;
        const { fixed, noDefect, headline, detail, synced } = record.recovery as {
          fixed?: boolean;
          noDefect?: boolean;
          headline?: string;
          detail?: string;
          synced?: boolean;
        };
        if (fixed) {
          toast(`${headline ?? 'Recovery finished'}${synced ? ' — the run record moved with it' : ''}`, 'ok');
        } else if (noDefect) {
          // The recovery LOOKED and found nothing wrong — a verdict, not a
          // failure. This used to toast as a warning ("ended without moving the
          // board"), the exact inversion of what happened.
          toast(
            `${headline ?? 'Recovery verified'} — nothing was wrong; the halt is stood down and the board is unchanged.`,
            'ok',
          );
        } else {
          toast(
            headline
              ? `${headline} — ${detail ?? 'inspect the session'}`
              : 'Recovery ended without moving the board',
            'warn',
          );
        }
      }),
    [],
  );
}

export function App() {
  const route = useRoute();
  const navigate = useNavigate();
  const head = route.segments[0];
  const phone = usePhone();
  const sse = useSseStatus();
  const online = useOnline();
  const stopped = useConsoleStopped();

  // ⚠️ THE FIRST REQUEST OF THE PAGE, and it must stay above every early
  // return in this function.
  //
  // `React.lazy` starts a chunk downloading when its element is RENDERED, and
  // the two returns below (`!state`, `target`) meant nothing was rendered until
  // `/api/state` had come back. On a cold `#/plan/<slug>` that made the route
  // chunk wait for a response it does not depend on — a serial wave for free.
  // The head is known from the address bar before React has done anything, so
  // the request goes out now and the render finds the module already in flight.
  useEffect(() => preloadView(head), [head]);

  // Every server event, wired to what it makes stale. Mounted once, here.
  useLiveData();
  // `--app-height` follows the visual viewport (the keyboard, mostly) — the
  // shell's height token. Once, for the app's life.
  useEffect(() => installAppHeight(), []);
  // Registers the worker and offers an update when one is waiting. Also once.
  useServiceWorker();
  // The "in this tab" leg: a page-raised Notification off the `notification`
  // event, for a hidden tab in a browser with no push subscription. Armed
  // once for the app's life; `lib/tab-notify.ts` holds the three gates.
  useEffect(() => armTabNotifications(), []);
  // The recovery verdict, said where the person is looking. The notification
  // leg announces it too; this is the in-page echo of the same event the run
  // queries re-read themselves off (`patchSessions`).
  useRecoveryOutcomeToasts();

  // An alias resolves before anything renders, and it REPLACES rather than
  // pushes: `#/dashboard` in the history is a bookmark someone followed, not a
  // page they should have to press Back through twice to leave.
  const target = redirectTarget(route);
  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target, navigate]);

  const {
    data: state,
    error: stateError,
    isFetching: stateFetching,
    refetch: refetchState,
  } = useConsoleState();
  const rootOk = Boolean(state?.root?.ok);
  const { data: plans } = usePlans(rootOk);
  // Nothing to poll on a server that predates the runner — asking anyway just
  // fills the browser console with 404s.
  const { data: approvals } = useApprovals(Boolean(state?.autopilot));
  // Sessions outlive the page that opened them, so the badge has to be shell-wide
  // rather than something the Sessions page knows while you are on it.
  const { data: sessions } = useSessions(state);
  const { data: mcp } = useMcp();
  // The badge's own source since Phase 8: one deduped list of everything that
  // needs a person, rather than the approvals count standing in for it. Held
  // at the SHELL because the number is on the rail and the tab bar, which are
  // on screen whatever page you are on — and because the bell drawer renders
  // the same rows over any of them.
  const { data: inbox } = useAttentionInbox(false, Boolean(state) && state?.autopilot !== false);

  const counts = shellCounts(
    plans,
    approvals,
    state?.unread ?? 0,
    sessions?.sessions,
    mcp?.servers,
    inbox?.items,
  );

  // The queries are invalidated by the stream, not by a timer, so nothing
  // retries on its own once this one has failed. Coming back onto a network is
  // the one moment it is worth asking again unprompted.
  //
  // ⚠️ On the *transition*, never on "online && errored". Every failure is a new
  // Error object, so an effect that depends on the error refetches, fails,
  // produces a different error, and refetches again — a request every
  // millisecond, and a permanent spinner instead of the offline screen, because
  // the query is always mid-retry and never settled. Found in a browser; the
  // regression test is `app.test.tsx`.
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack) void refetchState();
  }, [online, refetchState]);

  // With several consoles open, every tab is called "Phase Console" and the tab
  // strip becomes a guessing game. The instance name goes first because that is
  // what survives truncation — a browser given ten tabs shows about twelve
  // characters, and "hub · Phase…" identifies the tab where "Phase Cons…" does
  // not. A server too old to report an instance keeps the plain title.
  const instanceName = state?.instance?.name;
  useEffect(() => {
    document.title = instanceName ? `${instanceName} · Phase Console` : 'Phase Console';
  }, [instanceName]);

  // For the NEXT page load, not this one: which project the persisted cache is
  // about. Pointing the console somewhere else writes the new root here, and
  // the reload after that finds a buster the stored cache does not match — so
  // another project's plans are dropped rather than painted under this one's
  // name. `lib/persist.ts` holds the reasoning.
  const rootPath = state?.root?.path;
  useEffect(() => rememberRoot(rootPath), [rootPath]);

  if (stateError) {
    return (
      <Disconnected
        online={online}
        detail={String((stateError as Error).message ?? stateError)}
        onRetry={() => {
          void refetchState();
        }}
        retrying={stateFetching}
      />
    );
  }

  // `/api/state` has not answered yet.
  //
  // This used to be a page-wide spinner, which is the most expensive thing a
  // shell can render: it says nothing, it replaces itself entirely a moment
  // later, and — because it is a `return` — it kept the route's own chunk from
  // being asked for at all (see the preload above, which is the half of this
  // that no longer waits).
  //
  // What renders instead is the real chrome with an empty state, and the
  // loading confined to the panel that is actually loading. The route is NOT
  // mounted here on purpose: until `root.ok` is known, a page that fetches
  // would be firing at a console that may have no root open, and the answer
  // would be an error banner that resolves itself half a second later. With
  // the persisted cache (`lib/persist.ts`) a returning visitor never sees this
  // branch — `state` is restored before the first paint.
  if (!state) {
    return (
      <TooltipProvider delayDuration={300}>
        <ShellLayout state={undefined} counts={counts} route={route} phone={phone}>
          <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-4 w-96" />
            <Skeleton className="h-64 w-full" />
          </div>
        </ShellLayout>
        <Toaster />
      </TooltipProvider>
    );
  }

  // Mid-redirect: the effect above has fired and the hash is about to change.
  // Rendering the alias's (nonexistent) page for one frame would flash the
  // fallback at everyone who followed an old link.
  if (target) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }

  // The help sheet is what you read before you have set anything up, so an
  // unconfigured console still opens it rather than sending you to the picker.
  // Via `openOverlay` and not a literal `query.help`: OVERLAY_KEYS says on its
  // own line that it exists because the question is asked in four places and
  // "spelling it out four times is how one of them ends up spelling it
  // differently". This was the fourth place.
  const askingForHelp = openOverlay(route) === 'help';
  const needsSource = (!rootOk || CHROMELESS_HEADS.has(head ?? '')) && !askingForHelp;

  if (needsSource) {
    const SourceView = resolveView('source')!;
    return (
      <TooltipProvider delayDuration={300}>
        <Suspense
          fallback={
            <div className="grid min-h-dvh place-items-center">
              <Spinner />
            </div>
          }
        >
          <SourceView route={route} />
        </Suspense>
        <Toaster />
      </TooltipProvider>
    );
  }

  const View = resolveView(head)!;
  const fullHeight = FULL_HEIGHT_HEADS.has(head ?? '');

  return (
    <TooltipProvider delayDuration={300}>
      <ShellLayout
        state={state}
        counts={counts}
        route={route}
        phone={phone}
        banners={
          (state.fleet?.frozen || state.serverStale || stopped || !online || sse !== 'live') && (
            <>
              {/* First, above everything else. A frozen console EXPLAINS every
                  other symptom on the page — the queue that is not moving, the
                  run that has not spoken — and none of them explains it. */}
              <FleetFrozenBanner />
              {state.serverStale && (
                <Banner severity="warn">
                  <div className="min-w-0">
                    <strong>This console is running older code than is on disk.</strong> Node loads the server
                    once, at startup — the page reloads from disk but the process cannot. Restart it, or a fix
                    you already have will look like it did not work.
                  </div>
                </Banner>
              )}
              {/* A console you stopped on purpose outranks every other reading
                  of a dead stream: "Reconnecting…" would be a promise nothing
                  is going to keep. */}
              {stopped ? (
                <Banner severity="warn">
                  <Power size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <strong>
                      {sse === 'live' ? 'This console is shutting down.' : 'This console is off.'}
                    </strong>{' '}
                    {stopped.via === 'exit'
                      ? 'The process has ended.'
                      : 'Its unit was unloaded and disabled, and a stop marker holds its work — not even a login brings it back.'}{' '}
                    Start it again with <code className="font-mono text-2xs">{stopped.hint}</code>.
                  </div>
                </Banner>
              ) : (
                (!online || sse !== 'live') && (
                  <Banner severity={!online || sse === 'offline' ? 'error' : 'info'}>
                    <WifiOff size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <div className="min-w-0">
                      {/* Being offline outranks whatever the stream thinks: it
                        explains the stream, and it is the one the reader can
                        actually do something about. */}
                      {!online
                        ? 'This device is offline. Everything below was loaded before that and is no longer updating.'
                        : sse === 'offline'
                          ? 'Live updates stopped. Reload to reconnect.'
                          : 'Reconnecting to the console — the board may be a moment behind.'}
                    </div>
                  </Banner>
                )
              )}
            </>
          )
        }
      >
        <RouteFrame view={View} route={route} fullHeight={fullHeight} />
      </ShellLayout>

      {/* The three overlays. Each is open exactly when the URL says so, which is
          why none of them needs the shell to hold a flag for it. */}
      <Palette route={route} state={state} counts={counts} />
      <NotificationsDrawer route={route} />
      <HelpSheet route={route} />
      {/* The boot question, over everything: a console restart that silently
          resumed spending is the thing this asks about, so it must be answered
          before the operator does anything else — and it is state over the
          shell rather than a route, because it has to be answerable from
          wherever they landed. */}
      <ResumeAsk />

      <Toaster />
    </TooltipProvider>
  );
}
