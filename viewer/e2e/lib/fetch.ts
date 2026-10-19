/**
 * The one way a spec's `page.route` handler passes a request through to the
 * fixture console: `passThrough(route)`, never `route.fetch()` by hand.
 *
 * Under the full tour's load (six workers, load 30+) the pass-through's socket
 * is sometimes reset before the answer arrives — `route.fetch: read
 * ECONNRESET` — and a test about Your turn, a figure or the supervisor went red
 * over a dropped connection (#294, #312, #344: three specs, one class). The
 * rule, fixed once here:
 *
 *   - a TRANSPORT failure (`ECONNRESET`, `EPIPE`, `ECONNREFUSED`, `socket hang
 *     up`, `other side closed`) is asked again, up to `TRIES` times in all,
 *     waiting 150 ms × the attempt between;
 *   - only for a request that may be asked twice — GET and HEAD; any other
 *     method is fetched once, because a press must never land twice;
 *   - and anything else — an HTTP error status, "Test ended", a closed page —
 *     is thrown at once, as the first answer: a retry must never hide a
 *     defect, only a dropped socket.
 *
 * `test/e2e-fetch.test.ts` holds every spec to it: a bare `route.fetch(`
 * outside this file fails the server suite.
 */
import type { APIResponse, Route } from '@playwright/test';

export const TRIES = 3;

const TRANSPORT = /ECONNRESET|EPIPE|ECONNREFUSED|socket hang up|other side closed/i;
const IDEMPOTENT = new Set(['GET', 'HEAD']);

/** Was this a dropped connection — worth asking again — rather than an answer? */
export function transient(error: unknown): boolean {
  return TRANSPORT.test(error instanceof Error ? error.message : String(error));
}

/** `route.fetch()`, asked again on a dropped connection (the rule above). */
export async function passThrough(
  route: Route,
  options?: Parameters<Route['fetch']>[0],
): Promise<APIResponse> {
  const tries = IDEMPOTENT.has(route.request().method()) ? TRIES : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await route.fetch(options);
    } catch (error) {
      if (attempt >= tries || !transient(error)) throw error;
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
}
