/**
 * Plan health (7.0, quiet-console phase 10; ported from
 * `features/plans/health-panel.test.tsx`).
 *
 * The 6.2 panel answered four questions in two parts around the phase table;
 * 7.0 draws each where it is asked. What is pinned, as before: an idle plan
 * raises no alarm; a halted run is "something wrong" with its way forward; a
 * stuck phase is named once with its own way forward; a closed plan silences
 * the stuck banner but never the run; the preflight renders per phase with the
 * certain finding loudest, and nothing when nothing was found; "what is left"
 * reads the engine's numbers; the lint is asked again only on a press; the
 * forecast reads the work endpoint. And, new: a halted run's verbs appear
 * ONCE — the halt row carries them, so the ways forward leave the run out.
 *
 * The recovery buttons are stubbed at `cards/recovery-actions` (the halt row
 * draws the card family's, which reads the same module), and the lent account
 * row at `screens/settings/account-row`: both have suites of their own.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDetail } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';

const { state, run, auth, verifyPreflight, planLint, planWork } = vi.hoisted(() => ({
  state: vi.fn(),
  run: vi.fn(),
  auth: vi.fn(),
  verifyPreflight: vi.fn(),
  planLint: vi.fn(),
  planWork: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, state, run, auth, verifyPreflight, planLint, planWork } };
});

vi.mock('@/cards/recovery-actions', () => ({
  RecoveryActions: ({ target }: { target: { slug: string; phase?: number } }) => (
    <button type="button">
      recover {target.slug}
      {target.phase != null ? ` P${target.phase}` : ''}
    </button>
  ),
}));
vi.mock('@/screens/settings/account-row', () => ({ ACCOUNT_RECOVERY_PARTS: {} }));

import { BeforeItBoards, LintAgain, PlanTrouble, WorkForecast, WorkLeft } from './health';

function detail(over: Record<string, unknown> = {}, summary: Record<string, unknown> = {}): PlanDetail {
  return {
    summary: {
      slug: 'demo',
      status: 'active',
      remainingWeight: 120_000,
      remainingSessions: 2,
      minimumSessions: 1,
      budget: 200_000,
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
    lint: { ok: true, issues: [], summary: '' },
    batches: { groups: [{ index: 1, kind: 'session', phases: [2, 3], weight: '120K', gated: false }] },
    ...over,
  } as unknown as PlanDetail;
}

const HALTED = {
  id: 'run-1',
  slug: 'demo',
  status: 'halted',
  model: 'opus',
  spentUsd: 1.5,
  halt: { phase: 2, reason: 'verification red on phase 2' },
  phases: { 2: { phase: 2, status: 'failed' } },
};

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.mockReset().mockResolvedValue({ autopilot: true });
  run.mockReset().mockResolvedValue({ run: null, history: [], eta: null });
  auth.mockReset().mockResolvedValue({ loggedIn: true });
  verifyPreflight.mockReset().mockResolvedValue({ phases: [], computedAt: '2026-10-10T00:00:00Z' });
  planWork.mockReset().mockResolvedValue(null);
  planLint
    .mockReset()
    .mockResolvedValue({ ok: true, issues: [], summary: 'LINT OK', timedOut: false, crashed: false });
});

describe('PlanTrouble', () => {
  it('says nothing at all about a healthy, idle plan', async () => {
    const { container } = mount(<PlanTrouble detail={detail()} />);
    await waitFor(() => expect(run).toHaveBeenCalledWith('demo'));
    expect(container.textContent).toBe('');
    expect(screen.queryByText("Something's wrong")).toBeNull();
  });

  it('a halted run is something wrong, with a way forward — and its verbs appear once', async () => {
    run.mockResolvedValue({ run: HALTED, history: [], eta: null });
    mount(<PlanTrouble detail={detail()} />);
    expect(await screen.findByText("Something's wrong")).toBeTruthy();
    const line = screen.getByTestId('trouble-run');
    // The run's own word, from the typed family…
    expect(within(line).getByText('Halted').closest('[data-status]')).toHaveAttribute(
      'data-status',
      'halted',
    );
    // …and the stop in the halt card's family, in one sentence.
    expect(within(line).getByTestId('halt-row')).toBeTruthy();
    expect(within(line).getByText(/verification red on phase 2/)).toBeTruthy();
    // The halt row carries the run's recommended verb; the ways forward do
    // not offer the run a second time.
    expect(screen.getAllByRole('button', { name: /recover demo/ })).toHaveLength(1);
    expect(screen.queryByTestId('ways-forward')).toBeNull();
  });

  it('a stuck phase is named, once, with its own way forward', async () => {
    mount(
      <PlanTrouble
        detail={detail({
          phases: [
            { phase: 1, title: 'one', state: 'done' },
            { phase: 3, title: 'three', state: 'stuck' },
          ],
        })}
      />,
    );
    expect(await screen.findByText(/Phase 3 is stuck: its handoff reads blocked/)).toBeTruthy();
    expect(screen.getAllByText(/is stuck/)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open phase 3' })).toHaveAttribute('href', '#/plan/demo/phase/3');
    expect(screen.getByRole('button', { name: 'recover demo P3' })).toBeTruthy();
  });

  it('a closed plan silences the stuck banner but keeps the run', async () => {
    run.mockResolvedValue({ run: { ...HALTED, halt: { reason: 'x' }, phases: {} }, history: [], eta: null });
    const closed = detail(
      { phases: [{ phase: 3, title: 'three', state: 'stuck' }] },
      { status: 'abandoned' },
    );
    mount(<PlanTrouble detail={closed} />);
    expect(await screen.findByText("Something's wrong")).toBeTruthy();
    expect(screen.queryByText(/is stuck/)).toBeNull();
  });

  it('a parked run with no halt is trouble too, and the ways forward offer the run', async () => {
    run.mockResolvedValue({
      run: {
        id: 'run-2',
        slug: 'demo',
        status: 'parked',
        finishedReason: 'every ready phase parked on MCP',
        phases: {},
      },
      history: [],
      eta: null,
    });
    mount(<PlanTrouble detail={detail()} />);
    expect(await screen.findByText('every ready phase parked on MCP')).toBeTruthy();
    expect(within(screen.getByTestId('trouble-run')).getByText('Parked')).toBeTruthy();
    const ways = screen.getByTestId('ways-forward');
    expect(within(ways).getByText('The run')).toBeTruthy();
    expect(within(ways).getByRole('button', { name: 'recover demo' })).toBeTruthy();
  });

  it('offers each target once: two stuck phases and a failing lint are three ways forward, not more', async () => {
    mount(
      <PlanTrouble
        detail={detail({
          phases: [
            { phase: 3, title: 'three', state: 'stuck' },
            { phase: 4, title: 'four', state: 'stuck' },
          ],
          lint: { ok: false, issues: ['F2'], summary: 'F2 undefined dependency' },
        })}
      />,
    );
    expect(await screen.findByText(/2 phases are stuck: their handoffs read blocked/)).toBeTruthy();
    const ways = screen.getByTestId('ways-forward');
    expect(within(ways).getAllByRole('button', { name: /recover demo/ })).toHaveLength(3);
    expect(within(ways).getByText('The plan')).toBeTruthy();
  });
});

describe('what boarding will find', () => {
  it('renders the preflight per phase, loudest for the phase that will park', async () => {
    verifyPreflight.mockResolvedValue({
      phases: [
        {
          phase: 2,
          warnings: [{ kind: 'nothing-runnable', message: 'no runnable command in §Verification' }],
        },
        { phase: 3, warnings: [{ kind: 'missing-lead', message: 'rg is not on PATH' }] },
      ],
      computedAt: '2026-10-10T00:00:00Z',
    });
    mount(<BeforeItBoards detail={detail()} />);
    expect(await screen.findByText('Before it boards')).toBeTruthy();
    expect(verifyPreflight).toHaveBeenCalledWith('demo');
    expect(screen.getByText('1 phase will park at boarding')).toBeTruthy();
    const certain = screen.getByText('will park');
    const predicted = screen.getByText('missing lead');
    expect(certain).toHaveAttribute('data-certain');
    expect(certain.className).toContain('text-ink');
    expect(predicted).not.toHaveAttribute('data-certain');
    expect(predicted.className).toContain('text-ink-muted');
    expect(screen.getByText('rg is not on PATH')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Phase 2' })).toHaveAttribute('href', '#/plan/demo/phase/2');
  });

  it('counts what it found when nothing will park', async () => {
    verifyPreflight.mockResolvedValue({
      phases: [{ phase: 3, warnings: [{ kind: 'cwd-unpinned', message: 'runs at the repository root' }] }],
      computedAt: '2026-10-10T00:00:00Z',
    });
    mount(<BeforeItBoards detail={detail()} />);
    expect(await screen.findByText('1 phase with something to know')).toBeTruthy();
  });

  it('renders nothing when the endpoint found nothing, and nothing when it did not answer', async () => {
    const { container, unmount } = mount(<BeforeItBoards detail={detail()} />);
    await waitFor(() => expect(verifyPreflight).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();

    verifyPreflight.mockRejectedValue(new Error('404'));
    const again = mount(<BeforeItBoards detail={detail()} />);
    await waitFor(() => expect(verifyPreflight).toHaveBeenCalledTimes(2));
    expect(again.container.textContent).toBe('');
  });

  it('is its own piece: the trouble above the page never draws it', async () => {
    verifyPreflight.mockResolvedValue({
      phases: [{ phase: 2, warnings: [{ kind: 'nothing-runnable', message: 'nothing to run' }] }],
      computedAt: '2026-10-10T00:00:00Z',
    });
    const { container } = mount(<PlanTrouble detail={detail()} />);
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    expect(verifyPreflight).not.toHaveBeenCalled();
  });
});

describe('what is left', () => {
  it('reads the engine’s numbers: the work, the path, the bottleneck, the best next phase', () => {
    mount(<WorkLeft detail={detail()} />);
    const left = screen.getByTestId('work-left');
    expect(within(left).getByText('Critical path')).toBeTruthy();
    expect(within(left).getByText(/P2 → P3/)).toBeTruthy();
    expect(within(left).getByText(/holds up 3 phases/)).toBeTruthy();
    expect(within(left).getByText(/best next P2 \(unblocks 3\)/)).toBeTruthy();
    expect(within(left).getByText(/about 2 sessions, measured per phase/)).toBeTruthy();
    // The unit first, and how a person would batch the rest.
    expect(within(left).getByTestId('work-unit')).toHaveTextContent('1 phase ≥ 1 session');
    expect(within(left).getByText(/Session 1: P2 \+ P3/)).toBeTruthy();
    expect(within(left).getByText('--session-plan')).toBeTruthy();
  });

  it('a closed plan has stopped claiming work, and draws nothing', () => {
    const { container } = mount(<WorkLeft detail={detail({}, { status: 'abandoned' })} />);
    expect(container.textContent).toBe('');
  });

  it('a finished plan has nothing to describe', () => {
    const { container } = mount(
      <WorkLeft detail={detail({ batches: null }, { remainingWeight: 0, criticalPath: [] })} />,
    );
    expect(container.textContent).toBe('');
  });

  it('forecasts what is left in sessions from GET /api/plans/<slug>/work', async () => {
    planWork.mockResolvedValue({ weight: 120, sessions: 2.4, phases: 2 });
    mount(<WorkForecast slug="demo" />);
    expect(await screen.findByTestId('work-forecast')).toHaveTextContent(
      '2 phases left, about 2 sessions at this plan’s measured size.',
    );
    expect(planWork).toHaveBeenCalledWith('demo');
  });

  it('says nothing when the work endpoint has nothing left to forecast', async () => {
    planWork.mockResolvedValue({ weight: 0, sessions: 0, phases: 0 });
    const { container } = mount(<WorkForecast slug="demo" />);
    await waitFor(() => expect(planWork).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('the lint, asked again (phase 25)', () => {
  it('lints a failing plan again on a press — GET /api/plans/<slug>/lint — and says what it found', async () => {
    planLint.mockResolvedValue({
      ok: false,
      issues: ['F2: phase 4 depends on phase 9, which does not exist'],
      summary: '1 error',
      timedOut: false,
      crashed: false,
    });
    mount(
      <PlanTrouble
        detail={detail({ lint: { ok: false, issues: [], summary: 'F2 undefined dependency' } })}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Lint the plan again' });
    expect(planLint).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(planLint).toHaveBeenCalledWith('demo'));
    expect(await screen.findByText('Still failing: 1 error')).toBeTruthy();
    expect(screen.getByText('F2: phase 4 depends on phase 9, which does not exist')).toBeTruthy();
  });

  it('says the lint passes now, or that a crashed engine proves nothing', async () => {
    const { unmount } = mount(<LintAgain slug="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Lint the plan again' }));
    expect(await screen.findByText('The lint passes now.')).toBeTruthy();
    unmount();

    planLint.mockResolvedValue({ ok: true, issues: [], summary: 'engine timed out', crashed: true });
    mount(<LintAgain slug="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Lint the plan again' }));
    expect(await screen.findByText(/could not run the lint, so this proves nothing/)).toBeTruthy();
  });

  it('folds a long lint past its first eight issues, counted', async () => {
    const issues = Array.from({ length: 11 }, (_, i) => `F2: issue ${i + 1}`);
    planLint.mockResolvedValue({ ok: false, issues, summary: '11 errors', crashed: false });
    mount(<LintAgain slug="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Lint the plan again' }));
    expect(await screen.findByText('F2: issue 8')).toBeTruthy();
    expect(screen.queryByText('F2: issue 9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /The rest of the lint/ }));
    expect(screen.getByText('F2: issue 11')).toBeTruthy();
  });
});
