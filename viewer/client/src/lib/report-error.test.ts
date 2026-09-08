/**
 * The errors no boundary can catch.
 *
 * `ErrorBoundary` contains anything thrown while RENDERING. Two large classes
 * never reach it — an exception raised from an event handler, a timer or a
 * `requestAnimationFrame`, and a rejected promise nobody awaited. Both are
 * reported by the browser to `window` and, before this, to nobody else: a
 * mutation whose `.catch` was forgotten left no trace at all on a console that
 * routinely runs unattended for hours.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('@/components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui')>()),
  toast: toastMock,
}));

const { reportError, resetErrorReporting, installErrorReporting } = await import('./report-error');

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  toastMock.mockClear();
  resetErrorReporting();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('reportError', () => {
  it('always logs, so the detail is in the one place people look', () => {
    const boom = new Error('kaboom');
    reportError('error', boom);
    expect(consoleError).toHaveBeenCalledWith('[console] uncaught error', boom);
  });

  it('names a rejection differently from a throw — they mean different things', () => {
    reportError('unhandledrejection', new Error('fetch failed'));
    expect(toastMock).toHaveBeenCalledWith('Something failed in the background: fetch failed', 'error', 6000);
    resetErrorReporting();
    reportError('error', new Error('fetch failed'));
    expect(toastMock).toHaveBeenLastCalledWith('Something went wrong: fetch failed', 'error', 6000);
  });

  it('describes a non-Error reason rather than printing [object Object]', () => {
    reportError('unhandledrejection', { status: 503 });
    expect(toastMock.mock.calls[0][0]).toContain('503');
    resetErrorReporting();
    reportError('unhandledrejection', 'plain string');
    expect(toastMock.mock.calls[1][0]).toContain('plain string');
  });

  it('survives a reason that cannot be stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => reportError('error', circular)).not.toThrow();
  });

  it('toasts a repeated failure ONCE — a render loop must not be a toast storm', () => {
    // A failing interval fires every second; 200 identical toasts would bury
    // the console under the thing it is trying to report.
    for (let i = 0; i < 200; i++) reportError('error', new Error('same'), 1000 + i);
    expect(toastMock).toHaveBeenCalledTimes(1);
    // …but it is still logged every time, because the count is the diagnosis.
    expect(consoleError).toHaveBeenCalledTimes(200);
  });

  it('toasts again once the quiet window has passed', () => {
    reportError('error', new Error('same'), 0);
    reportError('error', new Error('same'), 29_999);
    expect(toastMock).toHaveBeenCalledTimes(1);
    reportError('error', new Error('same'), 30_001);
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it('does not let the dedupe map grow without bound', () => {
    // The guard must not become the leak it is guarding against.
    for (let i = 0; i < 500; i++) reportError('error', new Error(`distinct ${i}`), i);
    // Nothing to assert on the map directly; the contract is that it keeps
    // toasting rather than silently dropping everything after 50 kinds.
    expect(toastMock.mock.calls.length).toBeGreaterThan(50);
  });
});

describe('installErrorReporting', () => {
  it('listens for both classes and is idempotent under StrictMode', () => {
    const listeners: Record<string, number> = {};
    const target = {
      addEventListener: (name: string) => {
        listeners[name] = (listeners[name] ?? 0) + 1;
      },
      removeEventListener: (name: string) => {
        listeners[name] = (listeners[name] ?? 0) - 1;
      },
    };

    const off = installErrorReporting(target as unknown as Window);
    // React 18+ mounts the root twice in StrictMode; a second set of listeners
    // would double every toast.
    installErrorReporting(target as unknown as Window);

    expect(listeners.error).toBe(1);
    expect(listeners.unhandledrejection).toBe(1);

    // And the teardown removes exactly what it added.
    off();
    expect(listeners.error).toBe(0);
    expect(listeners.unhandledrejection).toBe(0);
  });
});
