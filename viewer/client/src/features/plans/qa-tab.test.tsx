/**
 * The QA tab — rows from the payload, actions gated by THIS phase's regime,
 * and the report rendered rather than pathed.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { QaTab } from './qa-tab';

const { qaReport, qaModeSet } = vi.hoisted(() => ({ qaReport: vi.fn(), qaModeSet: vi.fn() }));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, qaReport, qaModeSet } };
});

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConsoleState: () => ({
    data: { allowWrites: true, allowRun: true, allowAgent: false, scriptsDir: '/opt/pe/scripts' },
  }),
  useSessions: () => ({ data: undefined }),
  // A QA round in flight on phase 3 — the record reads `done` the whole time.
  useRun: () => ({
    data: {
      run: {
        id: 'run-1',
        phases: {
          '3': {
            status: 'done',
            qaSession: {
              round: 3,
              report: 'reports/phase-03-qa-round3.md',
              startedAt: '2026-09-07T10:00:00Z',
            },
          },
        },
      },
    },
  }),
  useSkills: () => ({ data: [] }),
}));

const phase = (over: Partial<PhaseView> & { phase: number }): PhaseView =>
  ({ title: `Phase ${over.phase}`, state: 'done', size: 'M', gated: false, ...over }) as unknown as PhaseView;

const detail = {
  summary: {
    slug: 'alpha',
    title: 'Alpha',
    qaMode: 'on',
    qaModeReason: 'plan directive: QA gate: on',
    phases: 5,
    ready: [4],
  },
  plan: { sessionBudget: { skills: [], mcpServers: [] } },
  phases: [
    phase({
      phase: 1,
      qa: { result: 'pass', report: 'reports/phase-01-qa.md' },
      qaMode: { mode: 'on', source: 'plan' },
    }),
    // Its own `- **QA:** off` under a plan-wide `on`: a fail here holds nothing.
    phase({
      phase: 2,
      qa: { result: 'fail', report: 'reports/phase-02-qa.md' },
      qaMode: { mode: 'off', source: 'phase' },
    }),
    phase({
      phase: 3,
      qa: { result: 'fail', report: 'reports/phase-03-qa-round2.md' },
      qaMode: { mode: 'on', source: 'phase' },
      qaRounds: { count: 2, latest: { round: 2, result: 'fail', report: 'reports/phase-03-qa-round2.md' } },
    }),
    phase({ phase: 4, state: 'ready', qaMode: { mode: 'on', source: 'plan' } }),
    phase({ phase: 5, state: 'waiting', qaMode: { mode: 'on', source: 'plan' } }),
  ],
  qa: [
    { phase: 1, result: 'pass', report: 'reports/phase-01-qa.md' },
    { phase: 2, result: 'fail', report: 'reports/phase-02-qa.md' },
    { phase: 3, result: 'fail', report: 'reports/phase-03-qa-round2.md' },
  ],
  qaHeld: { 3: [5] },
} as unknown as PlanDetail;

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const rowOf = (n: number) => screen.getByTestId(`qa-phase-${n}`).closest('tr')!;
/** The actions live under the row — open its fold and hand back the detail row. */
const detailOf = (n: number) => {
  const row = rowOf(n);
  fireEvent.click(within(row).getByRole('button', { name: /Show the rest of this row/ }));
  return row.nextElementSibling as HTMLElement;
};

describe('the QA tab', () => {
  it('puts the plan-level switch at the top, with the reason the engine gave', () => {
    mount(<QaTab detail={detail} />);
    expect(screen.getByText('QA gate · on (plan directive: QA gate: on)')).toBeInTheDocument();
    expect(screen.getByText('1 pass · 2 fail')).toBeInTheDocument();
  });

  it("judges 'held' by the PHASE's regime: a phase that opted out holds nothing, whatever its verdict", () => {
    mount(<QaTab detail={detail} />);
    const off = rowOf(2);
    expect(within(off).getByText('off')).toBeInTheDocument();
    expect(within(off).getByText('phase directive')).toBeInTheDocument();
    expect(within(detailOf(2)).queryByTestId('qa-recovery')).toBeNull();
    // …while the phase that opted in, with a fail, gets the recovery verbs —
    // and nobody else does.
    expect(within(detailOf(3)).getByTestId('qa-recovery')).toBeInTheDocument();
    expect(screen.getAllByTestId('qa-recovery')).toHaveLength(1);
  });

  it('shows the round, what the verdict holds, and the live round as a link to its lane', () => {
    mount(<QaTab detail={detail} />);
    const row = rowOf(3);
    expect(within(row).getByText('round 2')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'P5' })).toHaveAttribute('href', '#/plan/alpha/phase/5');
    expect(within(row).getByRole('link', { name: 'QA round 3 live' })).toHaveAttribute(
      'href',
      '#/plan/alpha/run?lane=p3',
    );
    // Under the row: the per-phase switch names where the regime came from,
    // and a report exists for the reviewed phase and not for one nobody reviewed.
    const actions = detailOf(3);
    expect(within(actions).getByText('QA for this phase · on (phase directive)')).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /Open report/ })).toBeInTheDocument();
    expect(within(detailOf(1)).getByText('QA for this phase · inherits the plan (on)')).toBeInTheDocument();
    expect(within(detailOf(4)).queryByRole('button', { name: /Open report/ })).toBeNull();
  });

  it('renders the report itself in the sheet the address names, with a round picker over the ledger', async () => {
    qaReport.mockResolvedValue({
      path: 'reports/phase-03-qa-round2.md',
      round: 2,
      text: '# Round 2\n\nfindings two',
    });
    mount(<QaTab detail={detail} report="3:2" />);
    expect(await screen.findByText('findings two')).toBeInTheDocument();
    expect(qaReport).toHaveBeenCalledWith('alpha', 3, 2);
    expect(screen.getByRole('button', { name: 'round 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'round 2' })).toHaveAttribute('aria-pressed', 'true');
  });
});
