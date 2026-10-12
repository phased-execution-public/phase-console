/**
 * The page frame: the Suspense boundary, and the three things a hash router has
 * to do by hand that a browser does for free on a real navigation.
 *
 * It keeps the header, the rail and the tab bar painted while the next chunk
 * loads, instead of blanking the app on every tap, and it borrows three jobs
 * the browser performs on a real page load and none of which happen when only
 * `location.hash` changes:
 *
 * 1. **Focus goes to the new page.** `<main>` takes `tabIndex={-1}` and is
 *    focused on every PATH change (never on a query change: typing into `?k=`
 *    must not steal focus from the palette). Programmatically, so
 *    `:focus-visible` never paints a ring around the whole page.
 * 2. **The change is announced.** A screen reader says nothing when a hash
 *    changes, so the place's name is written into a polite live region — only
 *    the name: an assertive region would interrupt whatever is being read.
 * 3. **The skip link has somewhere to go.** `#main` is the target
 *    `shell/layout.tsx` renders as the first focusable thing on the page.
 */

import { Suspense, useEffect, useRef, type ComponentType, type LazyExoticComponent } from 'react';
import { Spinner } from '@/ui';
import { destinationFor, type Route } from './routes';
import { ErrorBoundary } from './error-boundary';

/**
 * Every destination and every head a person can stand on, by its spoken name
 * — the header's title word and the announcer's. Complete over `ROUTE_HEADS`'
 * pages (`shell/a11y.test.tsx` holds it); a redirect head announces where it
 * lands, through `destinationFor`.
 */
export const SPOKEN: Readonly<Record<string, string>> = {
  runs: 'Runs',
  plans: 'Plans',
  sessions: 'Sessions',
  repo: 'Repo',
  insights: 'Insights',
  logs: 'Logs',
  settings: 'Settings',
  plan: 'Plan',
  turn: 'Your turn',
  source: 'Source',
};

/** The word for a head: its own, else its destination's. */
export function spokenHead(head: string | undefined): string {
  if (head && SPOKEN[head]) return SPOKEN[head];
  return SPOKEN[destinationFor(head) ?? 'runs'] ?? 'Runs';
}

/** What a screen reader is told after a navigation: the place, and where in it. */
export function routeAnnouncement(route: Route): string {
  const head = route.segments[0];
  const place = spokenHead(head);
  const detail = route.segments.slice(1).filter(Boolean).join(' ');
  return detail ? `${place}, ${detail}` : place;
}

export function RouteFrame({
  view: View,
  route,
  fullHeight = false,
}: {
  view: LazyExoticComponent<ComponentType<{ route: Route }>>;
  route: Route;
  /** Sessions owns its height; the shell hands it the remainder. */
  fullHeight?: boolean;
}) {
  const announcement = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  // Computed on every render and READ inside the effect, so the effect depends
  // on the path alone and stays silent while a query changes.
  const sentence = routeAnnouncement(route);

  useEffect(() => {
    // Not on the first paint: nothing was navigated FROM, and moving focus or
    // announcing on load is noise on top of the page the reader just opened.
    if (first.current) {
      first.current = false;
      return;
    }
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) main.focus({ preventScroll: true });
    if (announcement.current) announcement.current.textContent = sentence;
    // `route.path` — the PATH, never the query. `sentence` derives from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.path]);

  // The boundary is OUTSIDE the Suspense boundary on purpose: a lazy chunk that
  // fails to load throws from the Suspense boundary itself. `resetKey` is the
  // path, so navigating away from a broken place and back gives it a fresh try.
  const body = (
    <ErrorBoundary label={sentence} resetKey={route.path}>
      <Suspense
        fallback={
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        }
      >
        <View route={route} />
      </Suspense>
    </ErrorBoundary>
  );

  return (
    <>
      {/* Written to imperatively rather than rendered from state: a live region
          announces what CHANGES inside it, so it has to exist and be empty
          before the text lands in it. */}
      <p ref={announcement} aria-live="polite" aria-atomic="true" className="sr-only" />
      {fullHeight ? <div className="min-h-0 flex-1">{body}</div> : body}
    </>
  );
}
