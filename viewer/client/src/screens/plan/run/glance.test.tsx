/**
 * The Run view's head reads which phases hold a live session from the run's
 * own record (quiet-console phase 11; carried from the 6.2 run page's tiles).
 */

import { describe, expect, it } from 'vitest';
import type { RunState } from '@/data/api';
import { livePhases } from './glance';

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    status: 'running',
    phases: {},
    child: null,
    activePhase: null,
    ...over,
  }) as unknown as RunState;

describe('livePhases', () => {
  it('reads every lane from children when the pool wrote them', () => {
    const child = (phase: number) => ({ pid: phase, phase, sessionId: `s${phase}`, startedAt: '' });
    expect(livePhases(run({ children: { 7: child(7), 3: child(3) } }))).toEqual([3, 7]);
  });

  it('falls back to the mirror for a run recorded before lanes existed', () => {
    const state = run({ child: { pid: 1, phase: 2, sessionId: 's', startedAt: '' } });
    expect(livePhases(state)).toEqual([2]);
    expect(livePhases(run())).toEqual([]);
  });
});
