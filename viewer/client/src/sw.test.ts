/**
 * The service worker's fetch handler — specifically, what it must NEVER answer
 * for (coverage-9).
 *
 * The worker's own docstring states the rule: `/api/*`, `/events`, `/hooks/*`
 * and `/ws/*` "are not intercepted at all — no cache, no fallback, no clever
 * staleness window." Nothing enforced it. The rule is one regex, and each of
 * the four paths fails differently and silently if it stops holding:
 *
 *  - `/api` cached — the board renders numbers from a previous build's run and
 *    looks completely normal doing it.
 *  - `/events` intercepted — the SSE stream never opens, so the console stops
 *    updating and never says why.
 *  - `/hooks` replayed — an approval a person did not give is delivered to a
 *    session that asked for one. This is the one that can actually decide
 *    something.
 *  - `/ws` intercepted — a service worker cannot proxy a protocol upgrade at
 *    all; the terminal simply stops connecting.
 *
 * The worker is loaded into a fabricated `ServiceWorkerGlobalScope` — the same
 * technique `test/fallback-sw.test.ts` uses on the emergency worker — and its
 * real listener is driven with real `Request`-shaped events. `respondWith`
 * being called at all IS the interception, so that is what is asserted, not
 * what would have come back.
 */

import { beforeAll, describe, expect, test, vi } from 'vitest';

const ORIGIN = 'https://console.test';
const SW_URL = `${ORIGIN}/sw.js`;

const MANIFEST = [
  { url: '/index.html', revision: null },
  { url: '/assets/app-abc123.js', revision: null },
  { url: '/assets/app-abc123.css', revision: null },
];

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener>();

/** What the worker called `respondWith` with, or `undefined` if it stood aside. */
function dispatchFetch(url: string, init: { method?: string; mode?: string } = {}): unknown {
  const handler = listeners.get('fetch');
  if (!handler) throw new Error('the worker registered no fetch listener');
  let responded: unknown;
  let responseCount = 0;
  handler({
    request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'no-cors' },
    respondWith(value: unknown) {
      responded = value;
      responseCount += 1;
    },
  });
  expect(responseCount, 'respondWith must be called at most once').toBeLessThanOrEqual(1);
  return responded;
}

function intercepted(url: string, init?: { method?: string; mode?: string }): boolean {
  return dispatchFetch(url, init) !== undefined;
}

beforeAll(async () => {
  const cache = {
    addAll: vi.fn(async () => undefined),
    match: vi.fn(async () => new Response('cached', { status: 200 })),
  };
  const scope = {
    __WB_MANIFEST: MANIFEST,
    location: { href: SW_URL, origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, fn);
    },
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    registration: { showNotification: vi.fn(async () => undefined), getNotifications: vi.fn(async () => []) },
    skipWaiting: vi.fn(async () => undefined),
  };

  Object.defineProperty(globalThis, 'self', { value: scope, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', {
    value: { open: vi.fn(async () => cache), keys: vi.fn(async () => []), delete: vi.fn(async () => true) },
    configurable: true,
    writable: true,
  });

  vi.resetModules();
  await import('./sw.ts');
  expect(listeners.has('fetch'), 'the worker must register a fetch listener').toBe(true);
});

describe('the live surfaces are never intercepted', () => {
  // One case per surface, each named for what breaks if the worker answers.
  const live: Array<[string, string]> = [
    ['/api/plans', 'a cached board is a lie'],
    ['/api/plans/demo/phases/12', 'and so is a cached phase'],
    ['/api', 'the bare prefix is live too — the regex ends with (/|$)'],
    ['/events', 'intercepting SSE stops the console updating, silently'],
    ['/events/stream', 'including anything under it'],
    ['/hooks/approve', 'a replayed approval decides something nobody decided'],
    ['/hooks', 'bare, as well'],
    ['/ws/terminal', 'a worker cannot proxy a protocol upgrade at all'],
    ['/ws', 'bare, as well'],
  ];

  test.each(live)('%s is left to the network (%s)', (path) => {
    expect(intercepted(`${ORIGIN}${path}`)).toBe(false);
  });

  test('a live path is not intercepted even as a navigation', () => {
    // The navigate branch answers with the app shell for every route, and it
    // sits BELOW the live check for exactly this reason: a link to /api/plans
    // opened in a tab must reach the server, not be handed an HTML shell.
    for (const [path] of live) {
      expect(intercepted(`${ORIGIN}${path}`, { mode: 'navigate' }), `${path} as a navigation`).toBe(false);
    }
  });

  test('a live path is not intercepted even when it collides with a precached URL', () => {
    // Belt and braces: the live check runs before the manifest lookup, so even
    // a build that somehow precached /api/plans could not serve it from cache.
    expect(intercepted(`${ORIGIN}/api/plans?refresh=1`)).toBe(false);
  });
});

describe('the prefixes are path segments, not string prefixes', () => {
  // `/apidocs` is not `/api`. If the regex lost its `(\/|$)` these would start
  // reaching the network instead of the shell — the inverse failure, and just
  // as invisible.
  test.each(['/apidocs', '/eventsource', '/hooksmith', '/wsl-guide'])(
    '%s is an ordinary route and gets the shell',
    (path) => {
      expect(intercepted(`${ORIGIN}${path}`, { mode: 'navigate' })).toBe(true);
    },
  );
});

describe('what the worker does answer for', () => {
  test('a navigation gets the app shell — every route is the same document', () => {
    expect(intercepted(`${ORIGIN}/plans/demo`, { mode: 'navigate' })).toBe(true);
    expect(intercepted(`${ORIGIN}/`, { mode: 'navigate' })).toBe(true);
  });

  test('a precached asset is served from the cache', () => {
    expect(intercepted(`${ORIGIN}/assets/app-abc123.js`)).toBe(true);
    expect(intercepted(`${ORIGIN}/assets/app-abc123.css`)).toBe(true);
  });

  test('anything else same-origin is left to the browser', () => {
    // "Not caching something is always a safe answer here; caching the wrong
    // thing is not." An asset that is not in the manifest is not ours.
    expect(intercepted(`${ORIGIN}/assets/terminal-xterm.js`)).toBe(false);
    expect(intercepted(`${ORIGIN}/favicon-not-in-manifest.png`)).toBe(false);
  });
});

describe('the guards above the routing', () => {
  test('a non-GET request is never intercepted, whatever its path', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(intercepted(`${ORIGIN}/index.html`, { method }), method).toBe(false);
      expect(intercepted(`${ORIGIN}/plans/demo`, { method, mode: 'navigate' }), method).toBe(false);
    }
  });

  test('a cross-origin request is never intercepted', () => {
    expect(intercepted('https://elsewhere.test/assets/app-abc123.js')).toBe(false);
    expect(intercepted('https://elsewhere.test/', { mode: 'navigate' })).toBe(false);
    // An extension asking for something is the common real case.
    expect(intercepted('chrome-extension://abc/panel.js')).toBe(false);
  });

  test('an unparseable URL is stood aside from, not thrown on', () => {
    expect(() => dispatchFetch('not a url at all')).not.toThrow();
    expect(intercepted('not a url at all')).toBe(false);
  });
});
