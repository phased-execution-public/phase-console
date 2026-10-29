import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { BP_WIDE, useMediaQuery, useNarrow } from '@/lib/media';
import { usePrefs } from '@/lib/prefs';
import { useKeyboardOpen } from '@/lib/viewport';
import type { ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { ownsHeight, type Route } from './routes';
import { Header } from './header';
import { Rail } from './rail';
import { TabBar } from './tab-bar';
import { panelStands } from './panel/modes';

/* The More sheet and the panel load when first opened: both stand on the
   sheet primitive, and first paint carries no dialog it is not showing. */
const MoreSheet = lazy(() => import('./more-sheet'));
const Panel = lazy(() => import('./panel/frame'));

/**
 * The shell (7.0): a rail or a tab bar, one header, exactly one scroller, and
 * the right panel beside the page where there is room for it.
 *
 * Phone (under 900): header / main / tab bar, as rows. Desk: rail / main /
 * panel, as columns — the panel's column is `auto`, so a closed panel is zero
 * wide and a page is one calm column by default. The rules a phone breaks
 * first, all kept from 6.0:
 *
 * - **`h-(--app-height)`, never `h-dvh`.** `dvh` ignores the software keyboard
 *   on iOS; the token follows `visualViewport` and falls back to `100dvh`.
 * - **One scroller.** `<main>` is the only scrolling region, a PERSISTENT node
 *   whose `scrollTop` is reset on the PATH, never the query, and never on a
 *   full-height head, which has no `scrollTop` to reset.
 * - **One scrolling AXIS.** `overflow-x` is pinned `hidden`, so an over-wide
 *   child is CLIPPED and a table's own box is the only place to scroll sideways.
 * - **`overscroll-none`, not `contain`**: no rubber band above the tab bar.
 * - **The tab bar is a grid ROW**, hidden only while a software keyboard is up.
 */
export function ShellLayout({
  state,
  counts,
  route,
  phone,
  banners,
  children,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
  phone: boolean;
  /** The console's own banners — stale server, offline, stopped, frozen. */
  banners?: ReactNode;
  children: ReactNode;
}) {
  const head = route.segments[0];
  const fullHeight = ownsHeight(route);
  const keyboardOpen = useKeyboardOpen();
  const [moreOpen, setMoreOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const [prefs] = usePrefs();
  const wide = useMediaQuery(`(min-width: ${BP_WIDE}px)`);
  // Below 640 the panel is a bottom sheet; from 640 an end drawer, so a tablet
  // held upright reads a record beside the page's edge (2026-10-20).
  const narrow = useNarrow();
  // The panel stands only where its mode has something to show: Details once
  // something is inspected, the Supervisor where a server offers one.
  const panel = panelStands(prefs.panel, state, head, phone);

  useEffect(() => {
    if (!fullHeight) main.current?.scrollTo(0, 0);
  }, [route.path, fullHeight]);

  // Going anywhere closes the sheet — including "back", which is the gesture a
  // sheet is most often dismissed with.
  useEffect(() => {
    setMoreOpen(false);
  }, [route.path]);
  useEffect(() => {
    if (!phone) setMoreOpen(false);
  }, [phone]);

  const header = <Header state={state} counts={counts} route={route} phone={phone} />;

  const content = (
    <main
      ref={main}
      id="main"
      // Focusable only programmatically: `route-frame.tsx` focuses it after a
      // navigation. `-1` keeps it out of the tab order.
      tabIndex={-1}
      className={
        fullHeight
          ? 'flex min-w-0 flex-col overflow-hidden'
          : 'min-w-0 overflow-x-hidden overflow-y-auto overscroll-none'
      }
    >
      {banners != null && (
        <div className="flex shrink-0 flex-col gap-2 px-(--pad-x) pt-(--pad-y) empty:hidden">{banners}</div>
      )}
      {children}
    </main>
  );

  // The panel beside the page at 1200 and up; a sheet below, in either shape.
  const panelNode = panel ? (
    <Suspense fallback={null}>
      <Panel state={state} route={route} host={wide && !phone ? 'column' : narrow ? 'bottom' : 'end'} />
    </Suspense>
  ) : null;

  return (
    <>
      {/* The first focusable thing on the page, and invisible until it is
          focused. Rendered OUTSIDE the grid on purpose: inside, it would be a
          grid item and would claim a row. */}
      <a
        href="#main"
        onClick={(event) => {
          // The href is what makes it a real link; the focus is what actually
          // moves, because `#main` in a hash router would be parsed as a route.
          event.preventDefault();
          main.current?.focus({ preventScroll: true });
        }}
        className="sr-only rounded bg-surface px-3 py-2 text-body text-ink outline-2 outline-focus
          focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-(--z-toast)"
      >
        Skip to content
      </a>
      <div
        // `.is-phone` is the shell contract: the class the layout, the tests
        // and the browser checks all agree means "header + tab bar, no rail".
        className={cn(
          // A container, so the panel's column can leave the page a desk's room (`frame.tsx`).
          '@container/shell',
          'grid h-(--app-height) overflow-hidden bg-ground',
          phone ? 'is-phone grid-rows-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)_auto]',
        )}
      >
        {phone ? (
          <>
            {header}
            {content}
            {/* Hidden while a SOFTWARE keyboard is up: typing is never a
                navigation moment, and those 60px keep a terminal's prompt and
                key bar visible. */}
            {!keyboardOpen && (
              <TabBar
                state={state}
                counts={counts}
                head={head}
                moreOpen={moreOpen}
                onMore={() => setMoreOpen((open) => !open)}
              />
            )}
          </>
        ) : (
          <>
            <Rail state={state} counts={counts} route={route} />
            <div className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
              {header}
              {content}
            </div>
            {wide ? panelNode : null}
          </>
        )}
      </div>

      {phone || !wide ? panelNode : null}

      {phone && moreOpen && (
        <Suspense fallback={null}>
          <MoreSheet
            open
            onOpenChange={setMoreOpen}
            state={state}
            counts={counts}
            route={route}
            head={head}
          />
        </Suspense>
      )}
    </>
  );
}
