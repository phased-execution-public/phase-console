/**
 * The plan health panel (parallel-repaint P2, coverage hole N4).
 *
 * Four questions, four pins: an idle plan says so and raises no alarm; a
 * halted run puts "Something's wrong" and a way forward on screen; the
 * preflight renders one badge per finding with the certain one loudest; and
 * "What is left" reads the engine's numbers. The heavy neighbours — the pulse
 * and the recovery buttons — are stubbed: they have suites of their own.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  run: vi.fn(),
  converge: vi.fn(),
  auth: vi.fn(),
  state: vi.fn(),
  preflight: vi.fn(),
}));

vi.mock('@/lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries')>();
  return {
    ...actual,
    useRun: hooks.run,
    useConverge: hooks.converge,
    useAuth: hooks.auth,
    useConsoleState: hooks.state,
    useVerifyPreflight: hooks.preflight,
  };
});

vi.mock('@/components/pulse', () => ({ PlanPulse: () => <div data-testid="pulse" /> }));
vi.mock('@/components/recovery-actions', () => ({
  RecoveryActions: ({ target }: { target: { slug: string; phase?: number } }) => (
    <button type="button">
      recover {target.slug}
      {target.phase != null ? ` P${target.phase}` : ''}
    </button>
  ),
}));

import { HealthPanel } from './health-panel';

function detail(over: Record<string, unknown> = {}, summary: Record<string, unknown> = {}) {
  return {
    summary: {
      slug: 'demo',
      status: 'active',
      remainingWeight: 120,
      remainingSessions: 2,
      minimumSessions: 1,
      budget: 200,
      criticalPath: [2, 3],
      ready: [2],
      bottleneck: { phase: 2, blocks: 3 },
      nextBest: { phase: 2, unblocks: 3 },
      ...summary,
    },
    phases: [
      { phase: 1, title: 'one', state: 'done' },
      { phase: 2, title: 'two', state: 'ready' },
      { phase: 3, title: 'three', state: 'waiting' },
    ],
    lint: { ok: true, summary: '' },
    batches: { groups: [{ index: 1, phases: [2, 3], weight: 120, gated: false }] },
    ...over,
  } as never;
}

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.state.mockReturnValue({ data: { autopilot: true } });
  hooks.run.mockReturnValue({ data: { run: null } });
  hooks.converge.mockReturnValue({ data: { reports: [] } });
  hooks.auth.mockReturnValue({ data: undefined });
  hooks.preflight.mockReturnValue({ data: undefined });
});

describe('HealthPanel', () => {
  it('says nothing is wrong with an idle plan, and reads the work left', () => {
    mount(<HealthPanel detail={detail()} />);
    expect(screen.getByText(/Nothing has been run for this plan yet/)).toBeTruthy();
    expect(screen.queryByText("Something's wrong")).toBeNull();
    expect(screen.queryByTestId('pulse')).toBeNull();
    expect(screen.getByText('What is left')).toBeTruthy();
    expect(screen.getByText('Critical path')).toBeTruthy();
    expect(screen.getByText(/P2 → P3/)).toBeTruthy();
    expect(screen.getByText(/holds up 3 phases/)).toBeTruthy();
    expect(screen.getByText(/best next: P2/)).toBeTruthy();
  });

  it('a halted run is something wrong, with a way forward', () => {
    hooks.run.mockReturnValue({
      data: {
        run: {
          id: 'run-1',
          slug: 'demo',
          status: 'halted',
          model: 'opus',
          spentUsd: 1.5,
          halt: { phase: 2, reason: 'verification red on phase 2' },
          phases: { 2: { status: 'failed' } },
        },
      },
    });
    mount(<HealthPanel detail={detail()} />);
    expect(screen.getByTestId('pulse')).toBeTruthy();
    expect(screen.getByText("Something's wrong")).toBeTruthy();
    expect(screen.getByText(/Run halted\./)).toBeTruthy();
    // The reason reads in the Autopilot card AND the banner — both are right.
    expect(screen.getAllByText(/verification red on phase 2/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /recover demo/ }).length).toBeGreaterThan(0);
  });

  it('a stuck phase is named, once, with its own way forward', () => {
    mount(
      <HealthPanel
        detail={detail({
          phases: [
            { phase: 1, title: 'one', state: 'done' },
            { phase: 3, title: 'three', state: 'stuck' },
          ],
        })}
      />,
    );
    expect(screen.getByText(/Phase 3 is stuck — its handoff reads blocked/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'recover demo P3' })).toBeTruthy();
  });

  it('a closed plan silences the stuck banner but keeps the run cards', () => {
    hooks.run.mockReturnValue({
      data: {
        run: {
          id: 'run-1',
          slug: 'demo',
          status: 'halted',
          model: 'opus',
          spentUsd: 0,
          halt: { reason: 'x' },
          phases: {},
        },
      },
    });
    mount(
      <HealthPanel
        detail={detail({ phases: [{ phase: 3, title: 'three', state: 'stuck' }] }, { status: 'abandoned' })}
      />,
    );
    expect(screen.queryByText(/is stuck/)).toBeNull();
    expect(screen.getByText("Something's wrong")).toBeTruthy();
    expect(screen.queryByText('What is left')).toBeNull();
  });

  it('renders the preflight per phase, loudest for the phase that will park', () => {
    hooks.preflight.mockReturnValue({
      data: {
        phases: [
          {
            phase: 2,
            warnings: [{ kind: 'nothing-runnable', message: 'no runnable command in §Verification' }],
          },
          { phase: 3, warnings: [{ kind: 'missing-lead', message: 'rg is not on PATH' }] },
        ],
      },
    });
    mount(<HealthPanel detail={detail()} />);
    expect(screen.getByText('Before it boards')).toBeTruthy();
    expect(screen.getByText('1 phase will park at boarding')).toBeTruthy();
    expect(screen.getByText('will park')).toBeTruthy();
    expect(screen.getByText('missing lead')).toBeTruthy();
    expect(screen.getByText('rg is not on PATH')).toBeTruthy();
  });

  it('renders nothing for the preflight when the endpoint found nothing', () => {
    hooks.preflight.mockReturnValue({ data: { phases: [] } });
    mount(<HealthPanel detail={detail()} />);
    expect(screen.queryByText('Before it boards')).toBeNull();
  });
});
