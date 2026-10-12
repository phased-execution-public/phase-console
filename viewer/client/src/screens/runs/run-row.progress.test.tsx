/**
 * A `run:progress` frame moves the run's row with no refetch (control-tower
 * phase 19, #25): the clock re-anchors on the attempt the frame names, the
 * session's in-flight spend joins what the run has settled, and the word
 * follows the session's hand-over to the console's check.
 *
 * The frame is folded into the cached WHOLE record (`['runs']`, the cache
 * `patchProgress` writes), and the row is handed that record, so what is
 * pinned is the patch and the row together: a row that re-asked for the run
 * on every frame would be a request per second per live lane.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleState, RunState } from '@/data/api';
import { keys } from '@/data/keys';
import { lanesOf } from '@/data/lanes';
import { EVENT_EFFECTS } from '@/data/live';
import { groupRuns } from '@/data/run-groups';
import { useRuns } from '@/data/runs';
import { TooltipProvider } from '@/ui/tooltip';
import { RunRow } from './run-row';

/** The runs list from the cache, never fetched — folded to lanes, placed, one row per run with its record. */
function Board() {
  const { data } = useRuns(false);
  const runs = data ?? [];
  const placed = groupRuns({ runs, lanes: lanesOf(runs, new Map(), Date.now()), now: Date.now() }).runs;
  return (
    <div>
      {placed.map((one) => (
        <RunRow
          key={one.run.id}
          placed={one}
          allowRun
          state={{ allowRun: true } as ConsoleState}
          record={runs.find((r) => r.id === one.run.id)}
        />
      ))}
    </div>
  );
}

describe('a run:progress frame patches the run’s row, with no refetch', () => {
  it('moves the row’s clock, its word and its in-flight spend from the frame alone', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const run = {
      id: 'run-strip01',
      slug: 'console-speed',
      root: '/repo',
      status: 'running',
      model: 'opus',
      autonomy: 'keep-going',
      spentUsd: 4.2,
      runBudgetUsd: 25,
      createdAt: iso(now - 3_600_000),
      updatedAt: iso(now - 60_000),
      activePhase: 6,
      children: { 6: { pid: 106, phase: 6, sessionId: 's6', startedAt: iso(now - 14 * 60_000) } },
      phases: {
        6: {
          phase: 6,
          status: 'running',
          attempts: 1,
          costUsd: 0,
          attemptStartedAt: iso(now - 14 * 60_000),
          startedAt: iso(now - 14 * 60_000),
          liveness: {
            phase: 6,
            lastOutputAt: iso(now - 5_000),
            turnsSinceLastTool: 0,
            commitsSinceStart: 0,
            treeDirty: false,
          },
        },
      },
    } as unknown as RunState;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.state(), { allowRun: true });
    client.setQueryData(keys.runs(), [run]);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ events: [], untrusted: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );

    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <Board />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('strip-clock').textContent).toMatch(/^running 14m/);
    expect(screen.getByTestId('strip-cost').textContent).toBe('$4.20');
    expect(screen.getByTestId('strip-cost').title).toMatch(/of a \$25\.00 run budget/);

    // A new attempt boards; this session has spent $2.50 so far.
    // (The cache notifies its observers on the next tick — hence `waitFor`.)
    const frame = (status: string) => ({
      slug: 'console-speed',
      runId: 'run-strip01',
      phase: 6,
      status,
      attempt: 2,
      attemptStartedAt: iso(now - 30_000),
      spentUsd: 2.5,
      phaseClocks: {
        sinceFirstBoardedMs: 14 * 60_000,
        sinceThisAttemptMs: 30_000,
        workedMs: 14 * 60_000,
        queuedMs: null,
        attemptWindows: [
          { attempt: 1, startedAt: iso(now - 14 * 60_000), endedAt: iso(now - 60_000) },
          { attempt: 2, startedAt: iso(now - 30_000) },
        ],
        timeToFirstToolMs: null,
      },
    });
    await act(async () => EVENT_EFFECTS['run:progress'].patch!(client, frame('running')));
    // The frame's window is the clock's anchor: the new attempt, not the old one's 14 minutes.
    await waitFor(() => expect(screen.getByTestId('strip-clock').textContent).toMatch(/^running 3\ds$/));
    expect(screen.getByTestId('strip-cost').textContent).toBe('$6.70');

    // The session hands over to the console's check: the word on the glance moves with it.
    await act(async () => EVENT_EFFECTS['run:progress'].patch!(client, frame('verifying')));
    await waitFor(() => expect(screen.getByTestId('strip-clock').textContent).toMatch(/^verifying /));

    expect(invalidate).not.toHaveBeenCalled();
    // Nothing asked for the run again — the only requests a row may make are its lane's activity
    // line and its why line's sources (control-tower phase 102): the phase's own report and, in
    // the Pro tree, the supervisor's read. None of them is the run.
    const allowed = (url: string) =>
      url.includes('/activity') ||
      url.endsWith('/report') ||
      false;
    const asked = fetch.mock.calls.map(([url]) => String(url)).filter((url) => !allowed(url));
    expect(asked).toEqual([]);
    fetch.mockRestore();
  });
});
