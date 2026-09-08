import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useKeyboardOpen } from '@/lib/viewport';
import { FULL_HEIGHT_HEADS, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { Header } from './header';
import { MoreSheet } from './more-sheet';
import { Rail } from './rail';
import { TabBar } from './tab-bar';

/* ---------------- the grid ---------------- */

/**
 * The shell: a rail or a tab bar, one header, and exactly one scroller.
 *
 * Moved out of `App.tsx` in 3.0 so that file can go back to being a composition
 * root. The rules it enforces are the ones a phone breaks first:
 *
 * - **`h-(--app-height)`, never `h-dvh`.** `dvh` ignores the software keyboard
 *   on iOS; the token follows `visualViewport` and falls back to `100dvh`.
 * - **One scroller.** `<main>` is the only scrolling region, and it is a
 *   PERSISTENT node — React swaps its children, so its `scrollTop` survives a
 *   route change unless something resets it. Reset on the PATH, never the query
 *   (typing into `?k=` must not jump), and never on a full-height head, which
 *   has no `scrollTop` to reset.
 * - **One scrolling AXIS.** `overflow-y: auto` computes `overflow-x` to `auto`
 *   as well, which made `<main>` a sideways scroller nobody asked for: one
 *   mis-measured table, one row that could not shrink, and the whole app slid
 *   left — taking the rail with it and leaving no way back on a trackpad. `x`
 *   is pinned `hidden`, so an over-wide child is CLIPPED and the table
 *   primitive's rule ("scroll inside your own box") is the only way to be read.
 *   `components/ui/table.tsx` documents the other half of this pair.
 * - **`overscroll-none`, not `contain`.** `contain` stops the scroll *chaining*
 *   to the document but leaves the rubber band, so a flick past the last card
 *   still bounces a strip of empty ground above the tab bar.
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
  /** The console's own banners — stale server, offline, stopped. */
  banners?: ReactNode;
  children: ReactNode;
}) {
  const head = route.segments[0];
  const fullHeight = FULL_HEIGHT_HEADS.has(head ?? '');
  const keyboardOpen = useKeyboardOpen();
  const [moreOpen, setMoreOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

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
      // Focusable only programmatically: `app/shell/route-frame.tsx` focuses it
      // after a navigation, because a hash change moves focus nowhere and a
      // keyboard user who has just chosen a destination is still inside the nav.
      // `-1` keeps it out of the tab order, so nothing has to be tabbed THROUGH.
      tabIndex={-1}
      className={
        fullHeight
          ? // Terminal/agent own their height: banners stay in flow and the
            // frame gets the definite remainder — never a second scroller.
            'flex min-w-0 flex-col overflow-hidden'
          : 'min-w-0 overflow-x-hidden overflow-y-auto overscroll-none'
      }
    >
      {banners != null && (
        <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 empty:hidden md:px-5">{banners}</div>
      )}
      {children}
    </main>
  );

  return (
    <>
      {/* The first focusable thing on the page, and invisible until it is
          focused. Without it a keyboard user starts every page inside the rail
          or the header and tabs past a dozen destinations, a project switcher,
          a spend meter and a bell before reaching what they came for. It is
          rendered OUTSIDE the grid on purpose: inside, it would be a grid item
          and would claim a row. */}
      <a
        href="#main"
        onClick={(event) => {
          // The href is what makes it a real link (and what a screen reader
          // reads); the focus is what actually moves, because `#main` in a hash
          // router would otherwise be parsed as a route.
          event.preventDefault();
          main.current?.focus({ preventScroll: true });
        }}
        className="sr-only rounded bg-surface px-3 py-2 text-sm text-ink outline-2 outline-accent
          focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-(--z-toast)"
      >
        Skip to content
      </a>
      <div
        // `.is-phone` is the shell contract: the class the layout, the tests and
        // the browser checks all agree means "header + tab bar, no rail".
        className={cn(
          'grid h-(--app-height) overflow-hidden bg-ground',
          phone
            ? // rows: header · the only scrolling region · tab bar
              'is-phone grid-rows-[auto_minmax(0,1fr)_auto]'
            : 'grid-cols-[auto_minmax(0,1fr)]',
        )}
      >
        {phone ? (
          <>
            {header}
            {content}
            {/* Hidden while a SOFTWARE keyboard is up: typing is never a
                navigation moment, and those 60px keep the terminal's prompt and
                key bar visible. Focus alone is a hardware keyboard and does not
                count — that distinction is `useKeyboardOpen`'s whole job. */}
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
            <Rail state={state} counts={counts} head={head} />
            <div className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
              {header}
              {content}
            </div>
          </>
        )}
      </div>

      {phone && (
        <MoreSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          state={state}
          counts={counts}
          route={route}
          head={head}
        />
      )}
    </>
  );
}
