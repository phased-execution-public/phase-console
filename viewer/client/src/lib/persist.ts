/**
 * The query cache, across a reload.
 *
 * A reload used to be four cold waves: the document, then `/api/state`, then —
 * only once that had landed, because the shell held every render behind it —
 * the route's chunk, and then that route's own data. Nothing in those four is
 * news. The console is a tool somebody keeps open and reloads, and on the
 * overwhelming majority of reloads every answer is the same answer.
 *
 * So the cache is written to `localStorage` and read back before the first
 * paint, and then immediately marked stale so every visible query revalidates
 * in the background. Stale-while-revalidate, with the store as the "while".
 *
 * Three rules keep that from being a way to show somebody the wrong thing:
 *
 * 1. **An allowlist, never a denylist.** Only the keys named in
 *    `PERSISTED_KEYS` survive a reload. A query added tomorrow is NOT persisted
 *    until somebody decides it should be — the failure mode of the other
 *    direction is a live process fact (a session list, a usage meter) painted
 *    from yesterday, which reads as true and is not.
 * 2. **The build and the ROOT are the buster.** A client built from a different
 *    commit, or a console pointed at a different project since this cache was
 *    written, throws the whole thing away rather than reasoning about it.
 * 3. **Everything restored is invalidated on arrival.** `staleTime: Infinity`
 *    means a restored answer would otherwise never be re-asked; the whole
 *    scheme depends on `invalidateQueries` overriding that on the next mount.
 */

import type { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { removeOldestQuery } from '@tanstack/react-query-persist-client';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { CACHE_GC_TIME } from './queries';

/** One entry, so a second console on another port cannot read this one's. */
const CACHE_KEY = 'pc-query-cache';
/** The root the LAST session was looking at — half of the buster. See below. */
const ROOT_KEY = 'pc-query-root';

/**
 * The whole-cache keys that survive a reload.
 *
 * What is deliberately absent is the more interesting half:
 *
 * - `terminal` / `sessions` — lists of processes. Painting yesterday's sessions
 *   as though they were running is worse than painting nothing, and unlike a
 *   stale board there is no revalidation that makes it briefly-wrong rather
 *   than wrong.
 * - `accounts` — usage meters. A stale number against a cap is a wrong number.
 * - `search` — an unbounded key space; persisting it is persisting typing.
 * - `restart` / `shutdown` / `browse` / `root-check` — probes of the machine as
 *   it is right now.
 * - `inbox` — the needs-a-person list. Derived from files like the board is,
 *   but it is a call to ACTION, and a badge that says "3 need you" about
 *   nothing is a worse first impression than a badge that arrives a moment
 *   late.
 */
export const PERSISTED_ROOTS: readonly string[] = ['state', 'plans', 'stats'];

/**
 * Which queries survive a reload.
 *
 * ⚠️ **`'plan'` cannot be a root**, and a test exists because the first version
 * of this made it one. EVERY plan-scoped key hangs off the `['plan', slug]`
 * prefix — the raw markdown, each boot prompt, the gate, the landing packet,
 * the verify preflight — so an allowlist that matched on the key's first
 * element persisted a dozen engine shell-outs along with the board. The two
 * shapes worth keeping are the board itself and its projections, and they are
 * the only two named here.
 */
export function shouldPersistQuery(key: readonly unknown[]): boolean {
  const head = key[0];
  if (typeof head !== 'string') return false;
  if (PERSISTED_ROOTS.includes(head)) return true;
  if (head !== 'plan') return false;
  // `['plan', slug]` — the board — and `['plan', slug, 'include', param]` —
  // one projection of it. Nothing else under the prefix.
  return key.length === 2 || (key.length === 4 && key[2] === 'include');
}

function storage(): Storage | null {
  try {
    // A private window, or a browser with storage disabled: `localStorage` may
    // exist and throw on ACCESS, so the probe has to be a real read.
    if (typeof window === 'undefined' || !window.localStorage) return null;
    window.localStorage.getItem(CACHE_KEY);
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Remember which project this console is open on.
 *
 * Called by the shell whenever `/api/state` answers. It is written for the NEXT
 * page load rather than this one: a switch to another root updates it now, and
 * the reload after that reads a buster the persisted cache does not match, so
 * the other project's plans are dropped rather than painted under this one's
 * name for the half-second before revalidation replaces them.
 */
export function rememberRoot(path: string | undefined): void {
  const store = storage();
  if (!store) return;
  try {
    if (path) store.setItem(ROOT_KEY, path);
    else store.removeItem(ROOT_KEY);
  } catch {
    /* full or refused — the buster falls back to the build alone */
  }
}

/**
 * The cache is only reused by a client that agrees about both of these.
 *
 * The build rev catches a shape change (a field renamed, a projection group
 * added) without anyone having to remember that the cache exists. The root
 * catches the console being pointed somewhere else.
 */
export function persistenceBuster(): string {
  const store = storage();
  let root = '';
  try {
    root = store?.getItem(ROOT_KEY) ?? '';
  } catch {
    /* unreadable is the same as absent */
  }
  return `${__BUILD_REV__}:${root}`;
}

/**
 * The options for `PersistQueryClientProvider`, or `null` when there is no
 * store to use — in which case the app runs exactly as it did before, cold.
 */
export function persistOptions(): Omit<PersistQueryClientOptions, 'queryClient'> | null {
  const store = storage();
  if (!store) return null;
  return {
    persister: createSyncStoragePersister({
      storage: store,
      key: CACHE_KEY,
      // `localStorage` is a ~5 MB budget shared with everything else on this
      // origin, and a console that has visited a hundred plans will reach it.
      // The library's own strategy is the right one: drop the oldest query and
      // try again, until it fits. Without it, the FIRST write that overflows
      // throws and persistence silently stops for good.
      retry: removeOldestQuery,
    }),
    maxAge: CACHE_GC_TIME,
    buster: persistenceBuster(),
    dehydrateOptions: {
      shouldDehydrateQuery: (query) => query.state.status === 'success' && shouldPersistQuery(query.queryKey),
    },
  };
}

/**
 * What to do the moment a cache comes back from the store.
 *
 * Everything restored is marked stale — `refetchType: 'none'`, so nothing is
 * fetched HERE — and each query then refetches when a component mounts and
 * observes it. That ordering is the whole feature: the page paints from the
 * store, and the network catches up under it.
 *
 * ⚠️ Without this the app defaults would win and a restored answer would be
 * treated as fresh forever (`staleTime: Infinity`), so a reload would show a
 * board that never updated until something invalidated it. The silent-wrong
 * failure, not the loud one.
 */
export function revalidateRestored(client: QueryClient): void {
  void client.invalidateQueries({ refetchType: 'none' });
}
