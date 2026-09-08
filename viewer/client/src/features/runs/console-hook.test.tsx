/**
 * `useLiveLines` — the two readings of one event stream, and the one fact it
 * must not invent.
 *
 * The hook had no test at all, and the gap showed: `seedTasks` stamped
 * `todosAt: Date.now()`, so the task card's "Written at" read *the moment the
 * page was opened* — on precisely the long runs that path exists for, since the
 * record is the authoritative source exactly when the 400-entry replay window
 * has missed the creates. A fact on screen that is not true, in the panel this
 * phase was fixing for putting facts on screen (QA round 1, M1).
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLiveLines } from './console';
import type { TranscriptEntry } from '@/lib/api';

describe('useLiveLines — seeding the task list from the record', () => {
  it('does not invent a write time the record does not carry', () => {
    const { result } = renderHook(() => useLiveLines());

    act(() => {
      result.current.seedTasks([
        { id: 'p3.task1', content: 'merge the branch', status: 'completed' },
        { id: 'p3.task2', content: 'write the handoff', status: 'pending' },
      ] as never);
    });

    expect(result.current.activity.todos).toHaveLength(2);
    // `0`, not `Date.now()`. `writtenAt()` renders nothing for `0`, which is the
    // honest answer: `PhaseRecord.tasks` carries the rows and not the moment
    // they were written.
    expect(result.current.activity.todosAt).toBe(0);
  });

  it('keeps the REAL write time a replay established', () => {
    const { result } = renderHook(() => useLiveLines());
    const wrote = Date.parse('2026-09-02T11:04:00Z');
    const entries: TranscriptEntry[] = [
      {
        at: new Date(wrote).toISOString(),
        event: 'stream',
        data: { kind: 'todos', items: [{ content: 'wire the endpoint', status: 'in_progress' }] },
      } as never,
    ];

    act(() => {
      result.current.hydrate(entries);
    });
    expect(result.current.activity.todosAt).toBe(wrote);

    // The record then seeds MORE rows than the replay saw — the case the seed
    // exists for — and the established time survives it.
    act(() => {
      result.current.seedTasks([
        { id: 'a', content: 'wire the endpoint', status: 'in_progress' },
        { id: 'b', content: 'write the handoff', status: 'pending' },
      ] as never);
    });
    expect(result.current.activity.todos).toHaveLength(2);
    expect(result.current.activity.todosAt).toBe(wrote);
  });

  it('seeds once, and never over a panel the live stream has carried further', () => {
    const { result } = renderHook(() => useLiveLines());
    act(() => {
      result.current.record('stream', {
        kind: 'todos',
        items: [
          { content: 'a', status: 'pending' },
          { content: 'b', status: 'pending' },
        ],
      });
    });
    act(() => {
      result.current.seedTasks([{ id: 'x', content: 'stale', status: 'pending' }] as never);
    });
    expect(result.current.activity.todos.map((t) => t.content)).toEqual(['a', 'b']);
  });
});

describe('useLiveLines — the verification checklist', () => {
  it('a replay of a transcript that predates the settled events leaves no row running', () => {
    // The regression QA found (M4): older transcripts carry only START events,
    // so every row opened and nothing ever closed one — a finished run's pane
    // claimed both commands were still going, permanently.
    const { result } = renderHook(() => useLiveLines());
    const entries: TranscriptEntry[] = [
      {
        at: '2026-09-02T11:00:00Z',
        event: 'verify',
        data: { phase: 3, command: 'npm test', index: 0, total: 2 },
      },
      {
        at: '2026-09-02T11:00:01Z',
        event: 'verify',
        data: { phase: 3, command: 'npm run lint', index: 1, total: 2 },
      },
      { at: '2026-09-02T11:40:00Z', event: 'phase', data: { phase: 3, status: 'done' } },
    ] as never;

    act(() => {
      result.current.hydrate(entries);
    });

    expect(result.current.activity.verify.commands.map((c) => c.state)).toEqual(['unknown', 'unknown']);
  });
});
