/**
 * The errors no boundary can catch.
 *
 * `app/shell/error-boundary.tsx` contains anything thrown while RENDERING a
 * destination. Two large classes never reach it: an exception raised from an
 * event handler, a timer or a `requestAnimationFrame`, and a rejected promise
 * nobody awaited. Both are reported by the browser to `window` and, until now,
 * to nobody else — so a failed mutation whose `.catch` was forgotten, or a
 * throw inside an `onClick`, left absolutely no trace on a console that
 * routinely runs unattended for hours.
 *
 * This does not try to be error tracking. It puts the error where a person
 * looking at a stuck console will find it: the devtools console, and one toast
 * so they know to look.
 */

import { toast } from '@/components/ui';

/** So a storm of identical failures is one line, not a thousand. */
const seen = new Map<string, number>();

/** At most one toast per distinct message per this many ms. */
const QUIET_MS = 30_000;

/** Never let the dedupe map be the leak it is guarding against. */
const MAX_SEEN = 50;

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

/** Report once, quietly, and say where the detail is. */
export function reportError(kind: 'error' | 'unhandledrejection', reason: unknown, now = Date.now()): void {
  const message = describe(reason);
  console.error(`[console] uncaught ${kind}`, reason);

  const last = seen.get(message);
  if (last !== undefined && now - last < QUIET_MS) return;
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.set(message, now);

  toast(
    kind === 'unhandledrejection'
      ? `Something failed in the background: ${message}`
      : `Something went wrong: ${message}`,
    'error',
    6000,
  );
}

/** For tests, and for a hot reload that would otherwise keep the old state. */
export function resetErrorReporting(): void {
  seen.clear();
}

let installed = false;

/**
 * Install the two listeners. Idempotent: React 18+ mounts the root twice in
 * StrictMode, and a second set of listeners would double every toast.
 */
export function installErrorReporting(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  if (installed) return () => {};
  installed = true;

  const onError = (event: Event) => {
    const detail = event as ErrorEvent;
    reportError('error', detail.error ?? detail.message ?? 'unknown error');
  };
  const onRejection = (event: Event) => {
    reportError('unhandledrejection', (event as PromiseRejectionEvent).reason);
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);

  return () => {
    installed = false;
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
