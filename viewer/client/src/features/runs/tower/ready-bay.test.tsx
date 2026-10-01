/**
 * Ready to start (control-tower phase 20, exit criterion 3): the bay is Now's
 * Next-up set — `toDepartures`, closed plans out — and Start opens the launch
 * dialog through its LAZY door, `run-setup/lazy-launch-dialog`, never the
 * 77.6 KB form itself.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanSummaryFull, RunState } from '@/lib/api';

const opened = vi.hoisted(() => [] as unknown[]);

// The door, and only the door: a launch that bypassed it would render the
// real dialog here and never reach this stand-in.
vi.mock('@/features/run-setup/lazy-launch-dialog', () => ({
  LaunchDialog: (props: { request: unknown }) => {
    opened.push(props.request);
    return <div data-testid="launch-door" />;
  },
}));

import { toDepartures } from '@/features/runs/lanes-model';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { ReadyBay } from './ready-bay';

const plan = (slug: string, ready: number[], over: Partial<PlanSummaryFull> = {}) =>
  ({ slug, title: slug, kind: 'plan', phases: 9, ready, locks: [], ...over }) as unknown as PlanSummaryFull;

const PLANS = [
  plan('alpha', [2, 3]),
  plan('beta', [7], {
    locks: [{ phase: 7, owner: 'someone/else', expired: false }],
  } as never),
  plan('closed', [1], { closed: true, status: 'abandoned' } as never),
  plan('idle', []),
];

const RUNS = [
  { id: 'old', slug: 'alpha', createdAt: '2026-09-01T00:00:00Z', status: 'finished', phases: {} },
  { id: 'new', slug: 'alpha', createdAt: '2026-09-20T00:00:00Z', status: 'finished', phases: {} },
] as unknown as RunState[];

function mount(allowRun = true) {
  const departures = toDepartures(PLANS, new Map());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReadyBay departures={departures} runs={RUNS} allowRun={allowRun} />
    </QueryClientProvider>,
  );
  return departures;
}

beforeEach(() => {
  cleanup();
  opened.length = 0;
  setPrefs({ readyRank: 'leverage' });
});

describe('Ready to start', () => {
  it('carries the order chooser Next up had, and keeps the choice (control-tower phase 21)', () => {
    // Now's Next up was the only place `prefs.readyRank` could be set; with Now
    // folded into the Tower, the bay that draws the order offers it.
    mount();
    const group = screen.getByRole('group', { name: 'Order the ready phases by' });
    const pressed = within(group).getByRole('button', { pressed: true });
    expect(pressed.textContent).toBe('Leverage');
    fireEvent.click(within(group).getByRole('button', { name: 'Quick wins' }));
    expect(getPrefs().readyRank).toBe('quick');
    expect(within(group).getByRole('button', { name: 'Quick wins' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('is Now’s Next-up set, and a closed plan’s ready phase is not in it', () => {
    const departures = mount();
    const rows = screen.getAllByTestId('ready-row').map((el) => `${el.dataset.slug}#${el.dataset.phase}`);
    expect(rows.sort()).toEqual(departures.map((d) => d.key).sort());
    expect(rows.sort()).toEqual(['alpha#2', 'alpha#3', 'beta#7']);
  });

  it('opens the launch dialog through the lazy door, on the plan’s newest run', () => {
    mount();
    const row = screen.getAllByTestId('ready-row').find((el) => el.dataset.phase === '2')!;
    fireEvent.click(within(row).getByTestId('ready-start'));
    expect(screen.getByTestId('launch-door')).toBeTruthy();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'phase', slug: 'alpha', phase: 2, run: { id: 'new' } });
  });

  it('offers a phase another session holds its page, not a Start — and so does a console that cannot run', () => {
    mount();
    const held = screen.getAllByTestId('ready-row').find((el) => el.dataset.slug === 'beta')!;
    expect(within(held).queryByTestId('ready-start')).toBeNull();
    expect(within(held).getByTestId('ready-open').getAttribute('href')).toBe('#/plan/beta/phase/7');

    cleanup();
    mount(false);
    expect(screen.queryAllByTestId('ready-start')).toHaveLength(0);
    expect(screen.getAllByTestId('ready-open')).toHaveLength(3);
  });
});
