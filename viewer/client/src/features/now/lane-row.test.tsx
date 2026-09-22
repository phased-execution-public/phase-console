/**
 * The lane row's checkout facts (many-plans-one-repo phase 15): the lock the
 * runner fastened on the lane's tree, and the base the lane's branch was cut
 * from — both on the row, because the row is where "which of these two
 * identical sentences is the other repository" gets answered.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import { LaneRow } from './lane-row';
import type { NowLane } from './model';

const lane = (over: Partial<NowLane> = {}): NowLane => ({
  key: 'r1#4',
  slug: 'demo',
  planTitle: 'Demo plan',
  runId: 'r1',
  phase: 4,
  title: 'Wire the ingest',
  status: 'running',
  runStatus: 'running',
  model: 'opus',
  effort: 'max',
  startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  costUsd: 2.5,
  attempts: 1,
  frozen: false,
  enriched: true,
  ...over,
});

function mount(one: NowLane) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/now">
        <TooltipProvider>
          <LaneRow lane={one} allowRun />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const CHILD = {
  pid: 41,
  phase: 4,
  sessionId: 's4',
  startedAt: '2026-09-21T09:30:00.000Z',
  worktree: '/repo/.worktrees/runs/demo/r1/p4',
  branch: 'pe/demo-p4',
};

describe('a lane row’s checkout facts', () => {
  it('says the tree is locked, in the runner’s own reason, when the child record carries one', () => {
    mount(lane({ child: { ...CHILD, locked: 'phase-console lane demo p4 r1 2026-09-21T09:30:00.000Z' } }));
    const chip = screen.getByTestId('locked-chip');
    expect(chip).toHaveTextContent('locked');
    expect(chip.getAttribute('title')).toMatch(/git worktree lock/);
    expect(chip.getAttribute('title')).toMatch(/phase-console lane demo p4 r1/);
  });

  it('says nothing about a lock the runner never fastened — absent is "not locked by this console"', () => {
    mount(lane({ child: CHILD }));
    expect(screen.queryByTestId('locked-chip')).toBeNull();
  });

  it('names the base the lane’s branch was cut from on the branch chip', () => {
    mount(
      lane({
        child: CHILD,
        base: { ref: 'release/5.1', sha: 'abcdef1234567890', source: 'ref', declaredBy: 'plan' },
      }),
    );
    const chip = screen.getByTestId('branch-chip');
    expect(chip).toHaveTextContent('pe/demo-p4');
    expect(chip.getAttribute('title')).toMatch(
      /Cut from release\/5\.1 at abcdef123456 \(a ref named by hand; the plan’s `Base branch:` line\)\./,
    );
  });

  it('keeps the branch chip’s plain sentence when the run never resolved a base', () => {
    mount(lane({ child: CHILD }));
    expect(screen.getByTestId('branch-chip').getAttribute('title')).not.toMatch(/Cut from/);
  });
});
