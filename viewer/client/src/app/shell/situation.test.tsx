/**
 * The situation line in the header (control-tower phase 21).
 *
 * Phase 20 drew the Tower's one sentence under the Runs title; 6.0 moves it
 * into the shell's header, so "does anything need me?" is answered from every
 * page. What is pinned here: it says the same thing the bays count, each figure
 * on a desk is a link to the bay it counts, a phone gets it as plain words on a
 * row of its own (no target under the tap floor), and it says nothing at all
 * until the runs have answered — or on a server with no run endpoints.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ConsoleState, RunState } from '@/lib/api';
import { queryClientConfig } from '@/lib/queries';

const { runs, queue, plans, approvals, inbox, spend } = vi.hoisted(() => ({
  runs: vi.fn(),
  queue: vi.fn(),
  plans: vi.fn(),
  approvals: vi.fn(),
  inbox: vi.fn(),
  spend: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runs, queue, plans, approvals, inbox, spend } };
});

import HeaderSituation from './situation';

const STATE = { autopilot: true, allowRun: true, unread: 0 } as ConsoleState;

const run = (over: Partial<RunState>): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'running',
    autonomy: 'keep-going',
    model: 'opus',
    phaseBudgetUsd: null,
    runBudgetUsd: null,
    spentUsd: 1,
    maxConsecutiveFailures: 2,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activePhase: 3,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: { '3': { phase: 3, status: 'running', attempts: 1, costUsd: 0 } },
    ...over,
  }) as unknown as RunState;

function mount(node: ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  runs.mockResolvedValue([]);
  queue.mockResolvedValue({ entries: [], advice: [] });
  plans.mockResolvedValue([]);
  approvals.mockResolvedValue([]);
  inbox.mockResolvedValue({ items: [] });
  spend.mockResolvedValue({ today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] });
});

describe('the situation line in the header', () => {
  it('names what is running, on any page, and links each figure to the bay it counts', async () => {
    runs.mockResolvedValue([run({})]);
    spend.mockResolvedValue({
      today: { settledUsd: 12.5, ladderUsd: 0, capUsd: null },
      runs: [],
      series: [],
    });
    mount(<HeaderSituation state={STATE} phone={false} />);

    const line = await screen.findByTestId('situation-line');
    const live = await within(line).findByRole('link', { name: 'demo is running — phase 3' });
    expect(live.getAttribute('href')).toBe('#/runs?bay=live');
    // The day's money is answered on Insights, not on a bay.
    const money = await within(line).findByRole('link', { name: '$12.50 today' });
    expect(money.getAttribute('href')).toBe('#/insights');
  });

  it('names the phase a baseline holds the lane for — never `phase ?` (control-tower phase 105, #193)', async () => {
    // ai-builder-v7 P8, 2026-10-03 01:35Z: `activePhase` null, no session, the
    // record `pending`, and the console 9 lines into the phase's baseline.
    const at = new Date(Date.now() - 600_000).toISOString();
    runs.mockResolvedValue([
      run({
        activePhase: null,
        phases: { '8': { phase: 8, status: 'pending', attempts: 0, costUsd: 0 } } as never,
        verifying: {
          '8': {
            phase: 8,
            purpose: 'baseline',
            command: 'pytest tests/unit',
            index: 9,
            total: 10,
            startedAt: at,
            commandStartedAt: at,
            pid: 789,
          },
        },
      }),
    ]);
    mount(<HeaderSituation state={STATE} phone={false} />);
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: 'demo is running — P8 baseline 9/10' });
    expect(line.textContent).not.toContain('phase ?');
  });

  it('says only that a run is running when no lane names a phase — never `phase ?`', async () => {
    runs.mockResolvedValue([run({ activePhase: null, phases: {} as never })]);
    mount(<HeaderSituation state={STATE} phone={false} />);
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: 'demo is running' });
    expect(line.textContent).not.toContain('?');
  });

  /**
   * The desk header is ONE row of a fixed height. Its parts used to shrink past
   * their own words in a no-wrap row and paint over each other (measured on the
   * e2e tour at 1280 px: "10 need you" over "tower is running"). They keep their
   * width now, and a part the row cannot hold leaves WHOLE, to a clipped second
   * line — the money first, since the parts are ordered by what it costs to
   * miss them — and leaves the keyboard and the reading order with it.
   */
  it('keeps the desk line to one row: a part that does not fit leaves whole, and inert', async () => {
    runs.mockResolvedValue([run({})]);
    spend.mockResolvedValue({
      today: { settledUsd: 12.5, ladderUsd: 0, capUsd: null },
      runs: [],
      series: [],
    });
    // jsdom lays nothing out, so the row is measured here: the money wrapped.
    const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.part === 'spend' ? 24 : 0;
    });
    try {
      mount(<HeaderSituation state={STATE} phone={false} />);
      const line = await screen.findByTestId('situation-line');
      await within(line).findByText('$12.50 today');
      expect(line.className).toMatch(/\bh-6\b/);
      expect(line.className).toMatch(/\boverflow-hidden\b/);
      expect(line.className).not.toMatch(/\bflex-nowrap\b/);
      const spent = line.querySelector('[data-part="spend"]')!;
      const live = line.querySelector('[data-part="live"]')!;
      expect(live.className).toMatch(/\bshrink-0\b/);
      expect(spent).toHaveAttribute('inert');
      expect(live).not.toHaveAttribute('inert');
      // Still counted by name for everyone else: only the clipped part left.
      expect(within(line).getByRole('link', { name: 'demo is running — phase 3' })).toBeInTheDocument();
    } finally {
      top.mockRestore();
    }
  });

  it('counts a pending card as needing you, and sends that figure to the Needs-you bay', async () => {
    runs.mockResolvedValue([run({})]);
    approvals.mockResolvedValue([
      {
        id: 'a1',
        runId: 'r1',
        slug: 'demo',
        phase: 3,
        kind: 'permission',
        title: 'Bash: npm publish',
        detail: 'Phase 3 of demo asks to run npm publish.',
        evidence: [],
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    ]);
    mount(<HeaderSituation state={STATE} phone={false} />);

    const needs = await screen.findByRole('link', { name: '1 needs you' });
    expect(needs.getAttribute('href')).toBe('#/runs?bay=needs-you');
    expect(needs.className).toMatch(/font-medium/);
  });

  it('says so plainly when nothing is running', async () => {
    mount(<HeaderSituation state={STATE} phone={false} />);
    expect(await screen.findByRole('link', { name: 'Nothing running right now' })).toBeTruthy();
  });

  it('gives a phone plain words on a row of its own — no target under the tap floor', async () => {
    runs.mockResolvedValue([run({})]);
    mount(<HeaderSituation state={STATE} phone />);
    const line = await screen.findByTestId('situation-line');
    expect(line.textContent).toContain('demo is running — phase 3');
    expect(within(line).queryAllByRole('link')).toEqual([]);
  });

  it('says nothing before the runs have answered, and nothing on a server with no run endpoints', async () => {
    runs.mockImplementation(() => new Promise<RunState[]>(() => {}));
    const { container, unmount } = mount(<HeaderSituation state={STATE} phone={false} />);
    await Promise.resolve();
    expect(container.textContent).toBe('');
    unmount();

    const stale = mount(<HeaderSituation state={{ ...STATE, autopilot: false }} phone={false} />);
    await Promise.resolve();
    expect(stale.container.textContent).toBe('');
    expect(runs).toHaveBeenCalledTimes(1);
  });
});
