/**
 * The route registry: the one place a route head becomes a screen.
 *
 * Restructured for 3.0 from a flat `head → lazy(view)` object into a
 * declarative **`ROUTE_TABLE`**, because a head is no longer always a page. It
 * is either:
 *
 *   `{ kind: 'page',     lazy }`  — a chunk to render, or
 *   `{ kind: 'redirect', to   }`  — a URL to send you to instead.
 *
 * Making that a *value* rather than a branch inside the render is what lets one
 * test walk `ROUTE_HEADS` and assert every member of the shared vocabulary
 * resolves — pages and aliases alike — which is the guarantee the old registry
 * could only give for pages.
 *
 * Two rules survive from 2.x and still hold:
 *
 * 1. **The vocabulary is not ours.** `ROUTE_HEADS` lives in
 *    `shared/route-meta.js` because the *server* builds notification deep links
 *    from the same list (`server/push/catalogue.ts` → `routeFor`). A head
 *    renamed here and not there is a push notification that opens a blank page,
 *    which is why the Node suite asserts every `routeFor` destination is in that
 *    array and the client test below asserts every entry of that array resolves.
 *    Neither test can pass alone if the two drift.
 *
 * 2. **Every page is lazy.** A route costs its own chunk and nothing else. The
 *    plan surface (with `marked` and the DAG maths) must not be in the bundle a
 *    phone downloads to look at what needs it, and xterm — ~250 KB — must not be
 *    anywhere except the two heads that actually open a pty.
 *
 * The 6.0 shape (`app/routes.ts` holds the reasoning): seven destinations with
 * Runs the home, every older head still resolving — Now's among them, as a
 * redirect onto the Tower — and three overlays that ride the query string
 * rather than taking a head of their own.
 */

import {
  createContext,
  lazy,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { ROUTE_HEADS } from '@shared/route-meta.js';
import {
  CHROMELESS_HEADS,
  DEFAULT_HEAD,
  DESTINATIONS,
  FULL_HEIGHT_HEADS,
  REDIRECTS,
  destinationFor,
  navigate as navigateTo,
  parseHash,
  redirectTarget,
  toHash,
  type Route,
} from './routes';

export type { Route };
export { CHROMELESS_HEADS, DEFAULT_HEAD, DESTINATIONS, FULL_HEIGHT_HEADS, destinationFor, redirectTarget };

/* ---------------- the table ---------------- */

export interface ViewProps {
  route: Route;
}

type View = LazyExoticComponent<ComponentType<ViewProps>>;

/** The dynamic import behind a page — held, not only handed to `lazy()`. See `preload`. */
type Loader = () => Promise<{ default: ComponentType<ViewProps> }>;

export interface PageRoute {
  kind: 'page';
  lazy: View;
  /**
   * Start this route's chunk downloading WITHOUT rendering it.
   *
   * `React.lazy` only calls its loader when the element is actually rendered,
   * and the shell used to hold every render behind `if (!state) return
   * <Spinner/>` — so on a cold `#/plan/<slug>` the plan chunk did not begin
   * downloading until `/api/state` had landed. Two serial waves where one
   * would do. Keeping the loader beside the lazy view lets the shell kick the
   * request off from an effect the moment it knows the head, and the bundler
   * dedupes: `preload()` and the eventual render share one module promise.
   *
   * Errors are swallowed on purpose — a preload that fails is not a failure,
   * it is a chunk the render will ask for again (and report properly).
   */
  preload: () => void;
}

export interface RedirectRoute {
  kind: 'redirect';
  /** Given the whole route, because the query and the deeper segments carry meaning. */
  to: (route: Route) => string;
}

export type RouteEntry = PageRoute | RedirectRoute;

const page = (load: Loader): PageRoute => ({
  kind: 'page',
  lazy: lazy(load),
  preload: () => {
    void load().catch(() => {
      /* see the note above: the render asks again and reports properly */
    });
  },
});
const redirect = (to: (route: Route) => string): RedirectRoute => ({ kind: 'redirect', to });

/**
 * One entry per `ROUTE_HEADS` member — the client test fails if that stops
 * being true in either direction.
 *
 * The order mirrors `ROUTE_HEADS`: the seven destinations, then the pages a
 * destination has not absorbed yet, then the aliases.
 */
export const ROUTE_TABLE: Record<string, RouteEntry> = {
  /* ---- the seven destinations ---- */
  // The Tower — every run in one bay, what needs you first — and, a switch
  // away, the ledger of every run there has been. The home since 6.0: Now's
  // four bands are its bays, and Now's address a redirect onto it.
  runs: page(() => import('@/features/runs')),
  plans: page(() => import('@/features/plans')),
  // One list and one pane for lanes, agent sessions, shells and the Claude
  // sessions the presence hook reports. xterm is ~250 KB and is NOT in this
  // chunk: `session-page.tsx` reaches the pane through a `lazy()` of its own,
  // because Sessions is a destination and destination chunks are precached.
  sessions: page(() => import('@/features/sessions')),
  // The tree the work changed: branch, commits, diff. Its own chunk because
  // Phase 9 puts a diff renderer behind it, and a diff renderer must not be in
  // the bundle a phone downloads to look at what needs it.
  repo: page(() => import('@/features/repo')),
  // Velocity, cost against the caps, the ETA and the portfolio — plan-scoped
  // with `?plan=`, which is the parameter `#/stats` always carried.
  insights: page(() => import('@/features/insights')),
  // Journals, logs and diagnostics. Also its own chunk: nothing on the four
  // pages an operator lives on should carry a log viewer.
  debug: page(() => import('@/features/debug')),
  // Eight addressed sections under `#/settings/:section`; the index is a real
  // page rather than a bounce to the first one, because on a phone the list IS
  // the screen.
  settings: page(() => import('@/features/settings')),

  /* ---- pages a destination has not absorbed yet ---- */
  plan: page(() => import('@/features/plans/detail')),
  // Your turn (control-tower phase 137) — every act only a person can do, and
  // where every step push lands. Its own chunk on purpose: it is opened cold
  // on a phone, over whatever signal is there at 2am, and it must not drag
  // the DAG maths or the rail's pages in behind it — nor ride in first paint.
  turn: page(() => import('@/features/turn')),
  // The whole queue (control-tower phase 99, #135) — its own chunk: the Tower
  // links to it, and nothing on the home page needs its table.
  queue: page(() => import('@/features/queue')),
  // The chromeless pre-open directory picker: it renders INSTEAD of the shell,
  // because there is nothing to navigate to until a root is open. Settings ▸
  // General is the door to it.
  source: page(() => import('@/features/settings/source')),

  /* ---- aliases: a head whose new home already exists ---- */
  // 6.2 (control-tower phase 137): the phone answer page became Your turn, so
  // its address — and a push's `?step=<id>` — lands on the page and the item.
  approve: redirect(REDIRECTS.approve),
  // 6.0 (control-tower phase 21): the Tower absorbed Now's bands, so Now's
  // address lands on it — each `?focus=` on the bay that took its question.
  now: redirect(REDIRECTS.now),
  dashboard: redirect(REDIRECTS.dashboard),
  stats: redirect(REDIRECTS.stats),
  search: redirect(REDIRECTS.search),
  guide: redirect(REDIRECTS.guide),
  // Phase 8 retired these into two sections of Now; 6.0 moved those sections
  // onto the Tower as bays, so each lands on its bay (`?bay=ready`, `live`).
  ready: redirect(REDIRECTS.ready),
  pulse: redirect(REDIRECTS.pulse),
  // Phase 10: the two terminal pages became `#/sessions/:id`. Both keep their
  // session id through the redirect; with no id each carries `?new=` so the
  // address still says which KIND it meant.
  terminal: redirect(REDIRECTS.terminal),
  agent: redirect(REDIRECTS.agent),
  // Phase 11: the last two pages Settings had not absorbed. `notifications` is
  // the only head with two destinations — bare goes to the bell drawer, and
  // `/settings` to Settings ▸ Notifications — which `redirectTarget` decides on depth.
  mcp: redirect(REDIRECTS.mcp),
  notifications: redirect(REDIRECTS.notifications),
};

/** `''` and anything unregistered land on the home (`DEFAULT_HEAD`, Runs) rather than nowhere. */
export function resolveHead(head: string | undefined): string {
  if (!head) return DEFAULT_HEAD;
  return head in ROUTE_TABLE ? head : DEFAULT_HEAD;
}

export function resolveEntry(head: string | undefined): RouteEntry {
  return ROUTE_TABLE[resolveHead(head)];
}

/**
 * The component for a head, or `null` when the head is an alias.
 *
 * A caller that gets `null` should have followed `redirectTarget` first; the
 * shell does, and this returns `null` rather than guessing so that a missed
 * redirect is a blank frame with a stack trace instead of a silently wrong page.
 */
export function resolveView(head: string | undefined): View | null {
  const entry = resolveEntry(head);
  return entry.kind === 'page' ? entry.lazy : null;
}

/**
 * Ask the network for a head's chunk now, without rendering it.
 *
 * The shell calls this the moment it knows the head — before `/api/state` has
 * landed, and therefore before anything can be rendered. An alias is a no-op:
 * the redirect fires in the same commit and the next render preloads the real
 * destination.
 */
export function preloadView(head: string | undefined): void {
  const entry = resolveEntry(head);
  if (entry.kind === 'page') entry.preload();
}

/* ---------------- the hook ---------------- */

function subscribe(notify: () => void): () => void {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

// `useSyncExternalStore` compares snapshots by identity, so parsing on every
// read would loop forever. The parse is memoised on the raw hash string.
let cachedHash: string | null = null;
let cachedRoute: Route = { segments: [], query: {}, path: '' };

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash) as Route;
  }
  return cachedRoute;
}

/**
 * The test harness's route, when one is mounted.
 *
 * `null` — the default — means "read the address bar", which is what the app
 * itself always does. A provider is the only way a test can render a page at a
 * route without mutating `window.location` and leaking it into the next test.
 */
interface MemoryRouter {
  route: Route;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}

const MemoryRouterContext = createContext<MemoryRouter | null>(null);

export function useRoute(): Route {
  const memory = useContext(MemoryRouterContext);
  const live = useSyncExternalStore(subscribe, snapshot, () => cachedRoute);
  return memory ? memory.route : live;
}

/**
 * `navigate`, aware of a memory router.
 *
 * The bare `navigate` export below still writes to `location.hash` and is what
 * nearly every caller wants. This hook is for the ones rendered inside the test
 * harness, and for the shell itself — which must not push the app out of a
 * `MemoryRouterProvider` the moment someone taps a nav item in a test.
 */
export function useNavigate(): (path: string, options?: { replace?: boolean }) => void {
  const memory = useContext(MemoryRouterContext);
  return memory ? memory.navigate : navigateTo;
}

/**
 * A router in memory, for tests.
 *
 * Renders its children against `initial` and moves when something navigates,
 * with no `window.location` involved at all — so a suite can mount the shell at
 * `#/plan/x/run?bell=1`, assert, and leave the address bar exactly as it found
 * it. `onNavigate` is there for the tests whose whole subject is "did this link
 * go to the right place".
 */
export function MemoryRouterProvider({
  initial = '#/runs',
  onNavigate,
  children,
}: {
  initial?: string;
  onNavigate?: (path: string) => void;
  children: ReactNode;
}) {
  const [hash, setHash] = useState(() => toHash(initial));
  const go = useCallback(
    (path: string) => {
      const next = toHash(path);
      onNavigate?.(next);
      setHash(next);
    },
    [onNavigate],
  );
  const value = useMemo<MemoryRouter>(() => ({ route: parseHash(hash) as Route, navigate: go }), [hash, go]);
  return <MemoryRouterContext.Provider value={value}>{children}</MemoryRouterContext.Provider>;
}

export { navigateTo as navigate, toHash };
export { ROUTE_HEADS };
