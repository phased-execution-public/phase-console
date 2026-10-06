/**
 * CI GitHub will not start, one line per repository (control-tower phase 111,
 * #166, CI-3): three phases of two plans waiting behind one repository's
 * spent Actions budget are ONE line naming the budget and every waiter, and a
 * second repository is a second line — never one diagnosis per phase.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunState } from '@/lib/api';
import { CiRefusedLines } from './ci-refused';
import { towerModel, filterTower } from './tower-model';

const NOT_STARTED =
  'The job was not started because recent account payments have failed or your spending limit needs to be increased.';

function row(repo: string, run: string) {
  return {
    ref: `gh:${repo}#run/${run}`,
    scheme: 'gh-run',
    state: 'pending' as const,
    checkedAt: '2026-09-26T09:05:00Z',
    notRun: {
      cause: 'billing',
      repo,
      run,
      jobs: 1,
      annotation: NOT_STARTED,
      budgets: [{ scope: 'repository' as const, name: repo, amount: 10, consumed: 10, stops: true }],
      headroom: false,
    },
  };
}

function run(id: string, slug: string, phases: Record<string, unknown>): RunState {
  return { id, slug, status: 'waiting', phases, updatedAt: '2026-09-26T09:05:00Z' } as unknown as RunState;
}

const RUNS = [
  run('r1', 'vca-refactor', {
    11: { phase: 11, status: 'waiting', watchState: { at: 'x', refs: [row('acme/app', '1')] } },
    12: { phase: 12, status: 'waiting', watchState: { at: 'x', refs: [row('acme/app', '2')] } },
  }),
  run('r2', 'hub-tidy', {
    3: {
      phase: 3,
      status: 'waiting',
      watchState: { at: 'x', refs: [row('acme/app', '3'), row('acme/aws', '9')] },
    },
  }),
];

afterEach(cleanup);

describe('CI refused (billing) on the Tower', () => {
  it('draws one line per repository, naming the budget and every phase waiting on it', () => {
    const model = towerModel({ runs: RUNS, lanes: [], now: Date.parse('2026-09-26T10:00:00Z') });
    render(<CiRefusedLines items={model.ciRefused} />);
    const lines = screen.getAllByTestId('ci-refused-repo');
    expect(lines.map((line) => line.dataset.repo)).toEqual(['acme/app', 'acme/aws']);
    expect(lines[0].textContent).toContain('CI refused (billing)');
    expect(lines[0].textContent).toContain('$10.00 of $10.00 used');
    expect(lines[0].textContent).toContain('hub-tidy P3, vca-refactor P11 and P12 wait on it.');
    expect(lines[1].textContent).toContain('hub-tidy P3 waits on it.');
  });

  it('narrows with the plan filter, and says nothing when no repository is refused', () => {
    const model = towerModel({ runs: RUNS, lanes: [], now: Date.parse('2026-09-26T10:00:00Z') });
    const narrowed = filterTower(model, { query: 'vca' });
    expect(narrowed.ciRefused.map((item) => item.repo)).toEqual(['acme/app']);
    expect(narrowed.ciRefused[0].phases.map((p) => p.phase)).toEqual([11, 12]);
    const { container } = render(<CiRefusedLines items={[]} />);
    expect(container.textContent).toBe('');
  });
});
