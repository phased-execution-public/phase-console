/**
 * A surface that moves while a phase is working — and costs nothing to move.
 *
 * The effect table describes itself as "a set of claims about what an arriving
 * event costs", and every claim in it was about cost. None of them said a
 * surface MOVES at all, which is how the Runs list and the plan's Run tab came
 * to be correct at boot and then again up to an hour later while two lanes
 * worked: the only event arriving between phase boundaries was the firehose,
 * and the firehose invalidates nothing on purpose.
 *
 * So this file asserts the two halves of the fix together, because either alone
 * is a different bug. The patch WRITES what a summary row reads — `0/3` becomes
 * `2/3`, the dollars move — and `fetch` is never called while it does, because
 * a round trip every three seconds per lane is the cost the whole shape exists
 * to avoid.
 */

import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EVENT_EFFECTS, keys } from '@/lib/queries';
import { TaskLine } from './task-summary';
import type { PhaseRecord, RunState } from '@/lib/api';

const RUN_ID = 'run-1a2b3c4d';

function runWithPhase(over: Partial<PhaseRecord> = {}): RunState {
  return {
    id: RUN_ID,
    slug: 'control-tower',
    status: 'running',
    phases: {
      7: {
        phase: 7,
        status: 'running',
        attempts: 1,
        costUsd: 0,
        tasks: [
          { id: 'p7.task1', content: 'read the snapshots', status: 'completed' },
          { id: 'p7.task2', content: 'cap the writer', status: 'pending' },
          { id: 'p7.task3', content: 'cache the parse', status: 'pending' },
        ],
        ...over,
      } as PhaseRecord,
    },
  } as unknown as RunState;
}

const frame = (over: Record<string, unknown> = {}) => ({
  slug: 'control-tower',
  runId: RUN_ID,
  phase: 7,
  status: 'running',
  attempt: 1,
  attemptStartedAt: '2026-09-22T11:00:00.000Z',
  tasks: { total: 3, done: 1, active: 'cap the writer' },
  spentUsd: 0.5,
  contextTokens: 42_000,
  stall: null,
  ...over,
});

describe('run:progress moves a surface, and asks for nothing', () => {
  let client: QueryClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchSpy = vi.fn(() => Promise.reject(new Error('a patch must never reach the network')));
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('folds two frames into the cached run and never fetches', () => {
    client.setQueryData(keys.run('control-tower'), { run: runWithPhase(), history: [], eta: null });
    client.setQueryData(keys.runs(), [runWithPhase()]);

    const patch = EVENT_EFFECTS['run:progress'].patch;
    expect(patch, 'run:progress is a patch, never an invalidate').toBeTypeOf('function');

    patch!(client, frame());
    patch!(client, frame({ tasks: { total: 3, done: 2, active: 'cache the parse' }, spentUsd: 1.75 }));

    const detail = client.getQueryData(keys.run('control-tower')) as { run: RunState };
    const live = detail.run.phases['7'].live;
    expect(live?.tasks).toEqual({ total: 3, done: 2, active: 'cache the parse' });
    expect(live?.spentUsd).toBe(1.75);
    expect(live?.contextTokens).toBe(42_000);

    // The list is the other view of the same fact; a patch that reached only
    // one of them would leave the other stale in exactly the way this closes.
    const list = client.getQueryData(keys.runs()) as RunState[];
    expect(list[0].phases['7'].live?.tasks?.done).toBe(2);

    expect(fetchSpy, 'not one round trip for two frames across two caches').not.toHaveBeenCalled();
  });

  it('a frame for another run leaves this one alone', () => {
    client.setQueryData(keys.run('control-tower'), { run: runWithPhase(), history: [], eta: null });
    EVENT_EFFECTS['run:progress'].patch!(client, frame({ runId: 'run-99999999' }));

    const detail = client.getQueryData(keys.run('control-tower')) as { run: RunState };
    expect(
      detail.run.phases['7'].live,
      'a stale run id is a frame about a run this cache is not showing',
    ).toBeUndefined();
  });

  it('the summary row prints what the lane reported, not what the record remembers', () => {
    const record = runWithPhase().phases['7'];
    const { rerender } = render(<TaskLine tasks={record.tasks} />);
    expect(screen.getByTestId('task-summary')).toHaveTextContent('1/3');

    rerender(<TaskLine tasks={record.tasks} live={{ total: 3, done: 2, active: 'cache the parse' }} />);
    const row = screen.getByTestId('task-summary');
    expect(row).toHaveTextContent('2/3');
    expect(row).toHaveTextContent('cache the parse');
  });
});
