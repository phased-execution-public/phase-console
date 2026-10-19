/**
 * Which build this page is, said to the server (one-pool phase 18, #373).
 *
 * A navigation is answered from the service worker's cached shell, so a tab
 * can run the release before an update against the server after it. Two
 * checks close that: before mounting, the page compares its own build with the
 * one the server serves (`lib/pwa.ts` `staleShellCheck`), and every request
 * carries the page's build in `x-build-rev`, so a write from an older page is
 * refused with a 409 the server words (`server/api/build-check.ts`). The 409
 * is announced on the window as `OUTDATED_EVENT`, which the shell turns into a
 * reload prompt (`useServiceWorker`).
 *
 * Never in dev: Vite's page and the console's `dist` are two builds by design.
 */

/** The commit this bundle was built from, as Vite baked it; `unknown` when it cannot say. */
export const BUILD_REV: string = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'unknown';

/** The server's header name — `BUILD_REV_HEADER` in `server/api/build-check.ts`. */
export const BUILD_REV_HEADER = 'x-build-rev';

/** A build either side can name: a commit, never `unknown` or an unstamped `dist`. */
export const isRev = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value.trim());

/** Two builds are the same build when one names the other (a sha and its prefix). */
export function sameBuild(a: string, b: string): boolean {
  const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/** The header every request carries — empty in dev, or when the build has no name. */
export function buildRevHeader(
  rev: string = BUILD_REV,
  dev: boolean = import.meta.env.DEV,
): Record<string, string> {
  return !dev && isRev(rev) ? { [BUILD_REV_HEADER]: rev } : {};
}

/** Dispatched on `window` when the server refused a write from this older page. */
export const OUTDATED_EVENT = 'phase-console:outdated';

/** A response body that is the server's outdated-page refusal. */
export const isOutdatedBody = (status: number, body: unknown): boolean =>
  status === 409 && (body as { outdated?: unknown } | null | undefined)?.outdated === true;
