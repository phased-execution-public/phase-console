/**
 * A press from a page an earlier release served (one-pool phase 18, #373).
 *
 * A navigation is answered from the service worker's cached shell, so the
 * first visit after an update can paint — and press — the release before
 * until the worker swaps. The page now checks its own build against the
 * server's before it mounts (`client/src/lib/pwa.ts` `staleShellCheck`), and
 * this is the server's half, for whatever slips past that check (a tab left
 * open across an update, a reload the one-shot declined): every request the
 * page makes carries the build it was built from as `x-build-rev`
 * (`client/src/data/http.ts`), and a write whose build is not the one this
 * console serves is refused with a 409 before any route — or the door check —
 * reads it. Nothing was done; the page says the sentence and offers a reload.
 *
 * Only a page sends the header, so the CLI, a session's scripts and the hooks
 * are never judged by it. A build either side cannot name (`unknown`, an
 * unstamped `dist`) is never stale: "cannot tell" is not "old".
 */

/** The header the page's every request carries: the commit its bundle was built from. */
export const BUILD_REV_HEADER = 'x-build-rev';

/** The refusal's sentence, said where the press was made. */
export const OUTDATED_WORDS = 'This page is from a previous release of the console — reload it, then press again.';

/** The 409's body: the sentence, the flag the page acts on, and the two builds. */
export interface OutdatedBody {
  error: string;
  outdated: true;
  build: { page: string; console: string };
}

const REV = /^[0-9a-f]{7,64}$/i;

/**
 * The refusal for a write from a page of another build, or null when the
 * write may go on: a read, no header, or a build either side cannot name.
 */
export function outdatedPress(
  method: string | undefined,
  header: string | string[] | undefined,
  served: string | null | undefined,
): OutdatedBody | null {
  if (!method || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const page = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
  const consoleRev = served?.trim() ?? '';
  if (!REV.test(page) || !REV.test(consoleRev)) return null;
  // `.build-rev` holds the whole sha; tolerate a page that sent a prefix.
  const same = page.length <= consoleRev.length ? consoleRev.startsWith(page) : page.startsWith(consoleRev);
  if (same) return null;
  return { error: OUTDATED_WORDS, outdated: true, build: { page, console: consoleRev } };
}
