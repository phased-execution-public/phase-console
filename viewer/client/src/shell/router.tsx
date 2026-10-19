/**
 * The route registry: the one place a route head becomes a screen.
 *
 * `app/router.tsx` until 7.0 (quiet-console phase 3). A head is one of two
 * things in **`ROUTE_TABLE`**:
 *
 *   `{ kind: 'page',     lazy }`  — a chunk to render, or
 *   `{ kind: 'redirect', to   }`  — an address to send you to instead.
 *
 * Making that a *value* rather than a branch inside the render is what lets one
 * test walk `ROUTE_HEADS` and assert every member of the shared vocabulary
 * resolves — pages and aliases alike.
 *
 * Two rules hold:
 *
 * 1. **The vocabulary is not ours.** `ROUTE_HEADS` lives in
 *    `shared/route-meta.js` because the *server* builds notification deep links
 *    from the same list (`server/push/catalogue.ts` → `routeFor`). A head
 *    renamed here and not there is a push notification that opens a blank page,
 *    which is why the Node suite asserts every `routeFor` destination is in that
 *    array and the client test asserts every entry of that array resolves.
 *
 * 2. **Every page is lazy.** A route costs its own chunk and nothing else, and
 *    every chunk is a 7.0 screen's: the last old page left with Settings
 *    (quiet-console phase 21). The shell's own static graph imports none.
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
import { queueRedirect, REDIRECTS, redirectTarget } from './redirects';
import {
  CHROMELESS_HEADS,
  DEFAULT_HEAD,
  DESTINATIONS,
  FULL_HEIGHT_HEADS,
  destinationFor,
  navigate as navigateTo,
  parseHash,
  runsHref,
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

export interface PageRoute {
  kind: 'page';
  lazy: View;
  /**
   * Start this route's chunk downloading WITHOUT rendering it.
   *
   * `React.lazy` only calls its loader when the element is actually rendered,
   * and the shell holds the render until `/api/state` has answered — so on a
   * cold `#/plan/<slug>` the chunk would not begin downloading until then. The
   * shell kicks the request off from an effect the moment it knows the head,
   * and the bundler dedupes: `preload()` and the render share one promise.
   * Errors are swallowed on purpose — the render asks again and reports.
   */
  preload: () => void;
}

export interface RedirectRoute {
  kind: 'redirect';
  /** Given the whole route, because the query and the deeper segments carry meaning. */
  to: (route: Route) => string;
}

export type RouteEntry = PageRoute | RedirectRoute;

/** A page's dynamic import — the shape `React.lazy` takes, and `preload` reuses. */
type PageLoader = () => Promise<{ default: ComponentType<{ route: Route }> }>;

const page = (load: PageLoader): PageRoute => ({
  kind: 'page',
  lazy: lazy(load),
  preload: () => {
    void load().catch(() => {
      /* the render asks again and reports properly */
    });
  },
});
const redirect = (to: (route: Route) => string): RedirectRoute => ({ kind: 'redirect', to });

/**
 * One entry per `ROUTE_HEADS` member — the client test fails if that stops
 * being true in either direction. The order mirrors `ROUTE_HEADS`: the seven
 * destinations, then the pages a destination has not absorbed, then the
 * redirects. A page's loader is its screen's chunk; a redirect is
 * `shell/redirects.ts`'s.
 */
export const ROUTE_TABLE: Record<string, RouteEntry> = {
  /* ---- the seven destinations ---- */
  // The home — 7.0's own screen (quiet-console phase 7).
  runs: page(() => import('@/screens/runs')),
  // The library — 7.0's own screen (quiet-console phase 9).
  plans: page(() => import('@/screens/plans')),
  sessions: page(() => import('@/screens/sessions')),
  repo: page(() => import('@/screens/repo')),
  // The record's numbers, as questions — 7.0's own screen (quiet-console phase 19).
  insights: page(() => import('@/screens/insights')),
  // What the console saw, in seven sections — 7.0's own screen (quiet-console phase 20).
  logs: page(() => import('@/screens/logs')),
  // Every setting, searchable, and every key in Everything — 7.0's own screen (quiet-console phase 21).
  settings: page(() => import('@/screens/settings')),

  /* ---- pages a destination has not absorbed yet ---- */
  // A plan — 7.0's own screen (quiet-console phase 10), its Run view included.
  plan: page(() => import('@/screens/plan')),
  // Your turn — 7.0's own screen (quiet-console phase 8).
  turn: page(() => import('@/screens/turn')),
  // The chromeless directory picker, drawn instead of the shell (quiet-console phase 21).
  source: page(() => import('@/screens/settings/source')),

  /* ---- redirects: a head whose new home already exists ---- */
  debug: redirect(REDIRECTS.debug!),
  // 7.0 (quiet-console phase 7): the queue is the Queued group of the home —
  // in Free still; in Pro it is a page again (below).
  queue: redirect(queueRedirect),
  approve: redirect(REDIRECTS.approve!),
  now: redirect(REDIRECTS.now!),
  dashboard: redirect(REDIRECTS.dashboard!),
  stats: redirect(REDIRECTS.stats!),
  search: redirect(REDIRECTS.search!),
  guide: redirect(REDIRECTS.guide!),
  ready: redirect(REDIRECTS.ready!),
  pulse: redirect(REDIRECTS.pulse!),
  terminal: redirect(REDIRECTS.terminal!),
  agent: redirect(REDIRECTS.agent!),
  mcp: redirect(REDIRECTS.mcp!),
  notifications: redirect(REDIRECTS.notifications!),
};


/** `''` and anything unregistered land on the home (`DEFAULT_HEAD`, Runs) rather than nowhere. */
export function resolveHead(head: string | undefined): string {
  if (!head) return DEFAULT_HEAD;
  return head in ROUTE_TABLE ? head : DEFAULT_HEAD;
}

export function resolveEntry(head: string | undefined): RouteEntry {
  return ROUTE_TABLE[resolveHead(head)]!;
}

/**
 * The component for a head, or `null` when the head is an alias. A caller that
 * gets `null` should have followed `redirectTarget` first; the shell does, and
 * this returns `null` rather than guessing so that a missed redirect is a blank
 * frame with a stack trace instead of a silently wrong page.
 */
export function resolveView(head: string | undefined): View | null {
  const entry = resolveEntry(head);
  return entry.kind === 'page' ? entry.lazy : null;
}

/** Ask the network for a head's chunk now, without rendering it. An alias is a no-op. */
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
 * The test harness's route, when one is mounted. `null` — the default — means
 * "read the address bar", which is what the app itself always does.
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
 * `navigate`, aware of a memory router. The bare `navigate` export still
 * writes to `location.hash` and is what nearly every caller wants; this hook
 * is for the shell and for anything rendered inside the test harness.
 */
export function useNavigate(): (path: string, options?: { replace?: boolean }) => void {
  const memory = useContext(MemoryRouterContext);
  return memory ? memory.navigate : navigateTo;
}

/**
 * A router in memory, for tests: renders its children against `initial` and
 * moves when something navigates, with no `window.location` involved at all.
 */
export function MemoryRouterProvider({
  initial = runsHref(),
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
