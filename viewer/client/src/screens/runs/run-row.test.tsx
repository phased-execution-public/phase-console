/**
 * The run's row in its two places (quiet-console phase 11): on the Runs home
 * it says what the first live phase is doing; as the Run view's head it leaves
 * that line to the phase's own lane below it, so the page never says one
 * sentence twice.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConsoleState, PhaseReport, RunState } from '@/data/api';

const REPORT = {
  phase: 3,
  live: true,
  status: 'running',
  whySlow: [],
  doing: { task: { text: 'wire the endpoint' }, operation: null },
  eta: { minutes: { low: 4, high: 6 } },
  summary: 'Phase 3 is running.',
} as unknown as PhaseReport;

vi.mock('@/data/runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/runs')>();
  return {
    ...actual,
    useRun: vi.fn(() => ({ data: undefined })),
    usePhaseReport: vi.fn(() => ({ data: REPORT })),
    usePhaseActivity: vi.fn(() => ({ data: undefined })),
  };
});

import { keys, queryClientConfig } from '@/data/keys';
import { lanesOf } from '@/data/lanes';
import { groupRuns } from '@/data/run-groups';
import { TooltipProvider } from '@/ui/tooltip';
import { RunRow } from './run-row';

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const STATE = {
  autopilot: true,
  allowRun: true,
  root: { ok: true, path: '/repo' },
} as unknown as ConsoleState;

const RUN = {
  id: 'r-live',
  slug: 'storefront',
  root: '/repo',
  status: 'running',
  model: 'opus',
  autonomy: 'keep-going',
  spentUsd: 1.1,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 2,
  createdAt: iso(NOW - 30 * 60_000),
  updatedAt: iso(NOW - 60_000),
  activePhase: 3,
  children: { 3: { pid: 103, phase: 3, sessionId: 's3', startedAt: iso(NOW - 14 * 60_000) } },
  phases: {
    3: {
      phase: 3,
      status: 'running',
      attempts: 1,
      costUsd: 1.1,
      attemptStartedAt: iso(NOW - 14 * 60_000),
      startedAt: iso(NOW - 14 * 60_000),
    },
  },
} as unknown as RunState;

function mount(variant: 'row' | 'header') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), STATE);
  const placed = groupRuns({ runs: [RUN], lanes: lanesOf([RUN], new Map(), NOW), now: NOW }).runs[0]!;
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RunRow placed={placed} allowRun state={STATE} record={RUN} variant={variant} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return screen.getByRole('article');
}

describe('the run row, at home and as the Run view’s head', () => {
  it('says what the first live phase is doing on the Runs home', () => {
    const row = mount('row');
    expect(row.querySelector('[data-testid="strip-why"]')?.textContent).toBe(
      'On wire the endpoint — about 4–6 min left.',
    );
  });

  it('leaves the phase’s line to its lane when it heads the Run view', () => {
    const row = mount('header');
    expect(row.getAttribute('data-variant')).toBe('header');
    expect(row.querySelector('[data-testid="strip-why"]')).toBeNull();
    expect(row.querySelector('[data-testid="strip-inspect"]')).not.toBeNull();
  });

  it('keeps the tablet’s two lines at desk widths as the head — the panel narrows its column', () => {
    // On the home a desk draws one line; beside the open panel that line
    // squeezed the track to a letter a line, so the head never takes it.
    expect(mount('row').className).toMatch(/\blg:grid-cols-/);
    cleanup();
    const head = mount('header');
    expect(head.className).not.toMatch(/\blg:grid-cols-/);
    expect(head.querySelector('[data-testid="strip-clock"]')!.parentElement!.className).toMatch(
      /\bsm:order-3\b/,
    );
  });
});
