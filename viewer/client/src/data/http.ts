/**
 * Server access — the transport every `data/api/*` domain module speaks through.
 *
 * There is no request cache here, unlike `web/api.js`. TanStack Query is the
 * cache now, and two caches that invalidate on different signals is how a board
 * ends up showing yesterday's state confidently. This module only knows how to
 * make a request; the query hooks beside it in `data/`, on the defaults in
 * `keys.ts`, decide when it is stale.
 *
 * `request`, `post` and `q` were private to the one-file `lib/api.ts`. They are
 * exported here so the domain modules (`./api/state`, `./api/plans`,
 * `./api/runs`, …) share one fetch path, one CSRF header and one error shape;
 * views import `api` from `@/data/api` and never call these directly.
 */

import { consolePath } from '@/lib/base';
import { OUTDATED_EVENT, buildRevHeader, isOutdatedBody } from '@/lib/build';

/** Every request carries this; non-GETs additionally need a same-origin Origin,
 *  which the dev proxy rewrites (see vite.config.ts). */
const CSRF = { 'x-phase-console': '1' } as const;

/** The console header and this page's build (#373) — what every request carries. */
const sent = (): Record<string, string> => ({ ...CSRF, ...buildRevHeader() });

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    /**
     * The parsed error body, when there was one.
     *
     * A refusal often carries more than a sentence — the recovery mint's 409
     * names the session already working on that phase, so the caller can offer
     * it instead of only saying no. Optional and untyped: every existing
     * handler reads `message` and is unaffected.
     */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(consolePath(path), {
    ...options,
    headers: { ...sent(), ...(options.headers ?? {}) },
  });
  const type = res.headers.get('content-type') ?? '';
  const body: unknown = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    // A write from a page an earlier release served (#373): nothing was done,
    // and the shell offers the reload (`useServiceWorker`). The refusal still
    // throws below, so the press that met it says the server's sentence.
    if (isOutdatedBody(res.status, body) && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(OUTDATED_EVENT, { detail: body }));
    }
    const message =
      typeof body === 'string' && body
        ? body
        : ((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
    throw new ApiError(message, res.status, path, body);
  }
  return body as T;
}

/**
 * A press sent as the page goes away (one-pool phase 13, #368): a held press
 * the person did not take back is still theirs when the tab closes or
 * reloads. A `keepalive` fetch outlives the page and, unlike `sendBeacon`, can
 * carry the console header the server's request guard asks of every call — a
 * beacon would be refused at the door. Never awaited: nobody is left to read
 * the answer. True when it was handed to the browser.
 */
export function sendOnLeave(path: string, body?: unknown, method: string = 'POST'): boolean {
  try {
    void fetch(consolePath(path), {
      method,
      keepalive: true,
      headers: { ...sent(), 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const q = encodeURIComponent;
