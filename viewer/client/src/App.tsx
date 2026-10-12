import { lazy, Suspense, useEffect, useRef } from 'react';
import { useOnline, useServiceWorker } from '@/lib/pwa';
import { rememberRoot } from '@/lib/persist';
import { usePhone } from '@/lib/media';
import { armTabNotifications } from '@/lib/tab-notify';
import { useConsoleStopped } from '@/lib/shutdown';
import { installAppHeight } from '@/lib/viewport';
import { Skeleton, Spinner, Toaster, toast } from '@/ui';
import { onSse, port, useLiveData, useSseStatus } from '@/data/live';
import { shellCounts, useConsoleState } from '@/data/console';
import { usePlans } from '@/data/plans';
import { useApprovals } from '@/data/runs';
import { useSessions } from '@/data/sessions';
import { useMcp } from '@/data/mcp';
import { useAttentionInbox } from '@/data/inbox';
import { preloadView, resolveView, useNavigate, useRoute } from '@/shell/router';
import { CHROMELESS_HEADS, openOverlay, ownsHeight } from '@/shell/routes';
import { redirectTarget } from '@/shell/redirects';
import { RouteFrame } from '@/shell/route-frame';
import { ShellLayout } from '@/shell/layout';
import { ConsoleBanners } from '@/shell/banners';
import { Disconnected } from '@/shell/disconnected';
import { usePaletteShortcut } from '@/shell/palette/shortcut';
import { usePanelShortcuts } from '@/shell/panel/shortcuts';

/* What first paint never carries: the palette (cmdk), the bell, the help
   sheet (the guide's prose and `marked`) and the boot question (a dialog).
   Each loads when the address, or the server, asks for it. */
const Palette = lazy(() => import('@/shell/palette/palette'));
const Bell = lazy(() => import('@/shell/bell/drawer'));
const Help = lazy(() => import('@/shell/help/sheet').then((m) => ({ default: m.HelpSheet })));
const ResumeAsk = lazy(() => import('@/shell/resume-ask'));

/**
 * The composition root (7.0, quiet-console phase 3).
 *
 * Everything that used to be in here is somewhere better: the grid, the rail,
 * the tab bar, the panel and the one scroller are `shell/layout.tsx`; the
 * route table is `shell/router.tsx`; the chords belong to the surfaces that
 * answer them. What is left is what only a root can do — mount the live data
 * once, decide whether there is a console to talk to at all, follow a
 * redirect, and hang the overlays where every page can reach them. Its static
 * graph imports no page and no overlay: each is a lazy chunk.
 */

/** A recovery session's verdict, toasted as it lands — the in-page echo of the event the queries re-read off. */
function useRecoveryOutcomeToasts(): void {
  useEffect(
    () =>
      onSse('sessions', (data) => {
        const record = data as {
          type?: string;
          recovery?: {
            fixed?: boolean;
            noDefect?: boolean;
            headline?: string;
            detail?: string;
            synced?: boolean;
          };
        };
        if (record.type !== 'recovery-outcome' || !record.recovery) return;
        const { fixed, noDefect, headline, detail, synced } = record.recovery;
        if (fixed) {
          toast(`${headline ?? 'Recovery finished'}${synced ? ' — the run record moved with it' : ''}`, 'ok');
        } else if (noDefect) {
          // The recovery LOOKED and found nothing wrong — a verdict, not a failure.
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
  // return in this function: the head is known from the address bar before
  // React has done anything, so the route's chunk goes out now and the render
  // finds the module already in flight — never behind `/api/state`.
  useEffect(() => preloadView(head), [head]);

  // Every server event, wired to what it makes stale. Mounted once, here.
  useLiveData();
  // One stream per browser (#236): once the shell has rendered, this tab
  // shares its stream with the console's other tabs, or follows the one that
  // holds it. Fetched, not carried — first paint does not wait on an election.
  useEffect(() => {
    void import('@/data/live-share').then((live) => live.share(port));
  }, []);
  // `--app-height` follows the visual viewport (the keyboard, mostly).
  useEffect(() => installAppHeight(), []);
  // A page-raised Notification for a hidden tab with no push subscription.
  useEffect(() => armTabNotifications(), []);
  useRecoveryOutcomeToasts();

  // The chords that work from the first paint: ⌘K, ⌘I and (Pro) ⌘.
  usePaletteShortcut(route, navigate);

  // An alias resolves before anything renders, and it REPLACES rather than
  // pushes: `#/debug/health` in the history is a bookmark someone followed, not
  // a page they should have to press Back through twice to leave.
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
  // Registers the worker after first paint, offers an update when one is
  // waiting, and asks again when the server's build moves under this tab.
  useServiceWorker(state?.distRev);
  const rootOk = Boolean(state?.root?.ok);
  const { data: plans } = usePlans(rootOk);
  // Nothing to poll on a server that predates the runner.
  const { data: approvals } = useApprovals(Boolean(state?.autopilot));
  // Sessions outlive the page that opened them, so the badge is shell-wide.
  const { data: sessions } = useSessions(state);
  const { data: mcp } = useMcp();
  // The badge's own source: one deduped list of everything that needs a person.
  const { data: inbox } = useAttentionInbox(false, Boolean(state) && state?.autopilot !== false);

  const counts = shellCounts(
    plans,
    approvals,
    state?.unread ?? 0,
    sessions?.sessions,
    mcp?.servers,
    inbox?.items,
  );

  usePanelShortcuts(state, phone, navigate);

  // The queries are invalidated by the stream, not by a timer, so nothing
  // retries on its own once this one has failed. Coming back onto a network is
  // the one moment it is worth asking again unprompted — on the TRANSITION,
  // never on "online && errored" (`app.test.tsx` holds the regression).
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack) void refetchState();
  }, [online, refetchState]);

  // With several consoles open, every tab is called "Phase Console": the
  // instance name goes first because that is what survives truncation.
  const instanceName = state?.instance?.name;
  useEffect(() => {
    document.title = instanceName ? `${instanceName} · Phase Console` : 'Phase Console';
  }, [instanceName]);

  // For the NEXT page load: which project the persisted cache is about.
  const rootPath = state?.root?.path;
  useEffect(() => rememberRoot(rootPath), [rootPath]);

  if (stateError) {
    return (
      <>
        <Disconnected
          online={online}
          detail={String((stateError as Error).message ?? stateError)}
          onRetry={() => {
            void refetchState();
          }}
          retrying={stateFetching}
        />
        <Toaster />
      </>
    );
  }

  // `/api/state` has not answered yet: the real chrome with an empty state, and
  // the loading confined to the page that is loading. The route is NOT mounted
  // here on purpose — until `root.ok` is known, a page that fetches would be
  // firing at a console that may have no root open. With the persisted cache a
  // returning visitor never sees this branch.
  if (!state) {
    return (
      <>
        <ShellLayout state={undefined} counts={counts} route={route} phone={phone}>
          <div
            className="flex flex-col gap-3 px-(--pad-x) py-(--pad-y)"
            aria-busy="true"
            aria-label="Loading"
          >
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-4 w-96" />
            <Skeleton className="h-64 w-full" />
          </div>
        </ShellLayout>
        <Toaster />
      </>
    );
  }

  // Mid-redirect: the effect above has fired and the hash is about to change.
  if (target) {
    return (
      <div className="grid min-h-(--app-height) place-items-center">
        <Spinner />
      </div>
    );
  }

  // The help sheet is what you read before you have set anything up, so an
  // unconfigured console still opens it rather than sending you to the picker.
  const overlay = openOverlay(route);
  const needsSource = (!rootOk || CHROMELESS_HEADS.has(head ?? '')) && overlay !== 'help';

  if (needsSource) {
    const SourceView = resolveView('source')!;
    return (
      <>
        <Suspense
          fallback={
            <div className="grid min-h-(--app-height) place-items-center">
              <Spinner />
            </div>
          }
        >
          <SourceView route={route} />
        </Suspense>
        <Toaster />
      </>
    );
  }

  const View = resolveView(head)!;
  const fullHeight = ownsHeight(route);

  return (
    <>
      <ShellLayout
        state={state}
        counts={counts}
        route={route}
        phone={phone}
        banners={<ConsoleBanners state={state} online={online} sse={sse} stopped={stopped} />}
      >
        <RouteFrame view={View} route={route} fullHeight={fullHeight} />
      </ShellLayout>

      {/* The overlays: each is open exactly when the address says so, which is
          why none of them needs the shell to hold a flag for it, and each loads
          only then. */}
      {overlay === 'palette' && (
        <Suspense fallback={null}>
          <Palette route={route} state={state} counts={counts} />
        </Suspense>
      )}
      {overlay === 'bell' && (
        <Suspense fallback={null}>
          <Bell route={route} />
        </Suspense>
      )}
      {overlay === 'help' && (
        <Suspense fallback={null}>
          <Help route={route} />
        </Suspense>
      )}
      {/* The boot question, over everything: a console restart that silently
          resumed spending is the thing this asks about, so it must be answered
          before the operator does anything else, from wherever they landed. */}
      {(state.resumeAsk?.length ?? 0) > 0 && (
        <Suspense fallback={null}>
          <ResumeAsk />
        </Suspense>
      )}

      <Toaster />
    </>
  );
}
