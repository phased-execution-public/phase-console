/**
 * When a restart is over, for the page that asked for it.
 *
 * The dialog used to reload four seconds after the press — a guess that was
 * right for an idle console and wrong for everything else: a drain takes up to
 * two minutes, and a restart that updates and builds first takes one more. A
 * reload that lands early shows the old process (or a half-swapped client);
 * one that lands late is a page sitting there. So the page now asks: the
 * server names its process on every `/api/state` (`bootedAt`), and the restart
 * is over when a DIFFERENT one answers. A server too old to say is judged by
 * the one thing that still tells: it went away, and something came back.
 */

import { describe, expect, it } from 'vitest';

import type { ConsoleState, RestartReadiness } from '@/lib/api';
import { EVENT_EFFECTS, keys, restartPollMs } from '@/lib/queries';
import { SSE_EVENTS } from '@/lib/sse';
import { cameBack } from './restart';

const state = (over: Partial<ConsoleState> = {}): ConsoleState => ({ ...over });

describe('a restart is over when a different process answers', () => {
  it('reloads once the console answers as a new process', () => {
    expect(cameBack('2026-09-18T10:00:00.000Z', state({ bootedAt: '2026-09-18T10:02:13.000Z' }), false)).toBe(
      true,
    );
  });

  it('keeps waiting while the old process is still the one answering', () => {
    // A drain can hold the old process up for a while after the press — and a
    // restart that updates first keeps it serving the whole time it builds.
    expect(cameBack('2026-09-18T10:00:00.000Z', state({ bootedAt: '2026-09-18T10:00:00.000Z' }), true)).toBe(
      false,
    );
  });

  it('judges a server too old to name itself by its going away and coming back', () => {
    expect(cameBack(undefined, state({}), false)).toBe(false);
    expect(cameBack(undefined, state({}), true)).toBe(true);
  });

  it('keeps waiting while nothing answers at all', () => {
    expect(cameBack('2026-09-18T10:00:00.000Z', undefined, true)).toBe(false);
  });
});

describe('the Restart card follows an update without being asked to', () => {
  const readiness = (run: NonNullable<RestartReadiness['update']>['run']): RestartReadiness => ({
    ok: true,
    supervisor: { detail: 'launchd' },
    busy: false,
    run: null,
    update: { available: true, run },
  });
  const update = (state: 'waiting' | 'running' | 'restarting' | 'stopped') => ({
    state,
    startedAt: '2026-09-18T10:00:00.000Z',
    by: 'operator',
    detail: 'updating',
  });

  it('polls while the update runs, while the process is on its way out, and — gently — while it waits', () => {
    expect(restartPollMs(readiness(update('running')))).toBeGreaterThan(0);
    expect(restartPollMs(readiness(update('restarting')))).toBeGreaterThan(0);
    // A wait can last as long as a phase does: the event carries the change,
    // so the poll is only the belt, and slow.
    expect(restartPollMs(readiness(update('waiting')))).toBeGreaterThanOrEqual(10_000);
  });

  it('stops polling once there is nothing in flight', () => {
    expect(restartPollMs(readiness(update('stopped')))).toBe(false);
    expect(restartPollMs(readiness(null))).toBe(false);
    expect(restartPollMs(undefined)).toBe(false);
  });

  it('hears the server say so: a restart event refreshes the card and the state', () => {
    expect(SSE_EVENTS).toContain('restart');
    expect(EVENT_EFFECTS.restart.invalidate).toContainEqual(keys.restart());
    expect(EVENT_EFFECTS.restart.invalidate).toContainEqual(keys.state());
  });
});
