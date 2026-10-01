/**
 * The Phases tab — one table, four views (control-tower phase 23, #26 #27).
 *
 * What is pinned here is the TAB's contract; the table's own is in
 * `features/runs/phase-table.test.tsx`, and every datum of the tabs this one
 * replaced is walked in `detail.datums.test.tsx`:
 *
 *   - the four views are ADDRESSES — links, with the current one marked;
 *   - `table`, `qa` and `handoffs` are three readings of the ONE table, and
 *     `map` draws the route and no table;
 *   - the phase sheet (L2) opens from a row and fetches the prose only then;
 *   - the QA report sheet opens where `?report=` says, and closing it keeps
 *     the view the reader was on.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { loadEngine } from '@/components/data-table';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { PhasesTab } from './phases-tab';

const { plan, qaReport, navigate } = vi.hoisted(() => ({
  plan: vi.fn(),
  qaReport: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, plan, qaReport } };
});
vi.mock('@/lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConsoleState: () => ({
    data: { allowRun: true, allowAgent: false, allowWrites: false, autopilot: true },
  }),
  useRun: () => ({ data: undefined }),
  useSessions: () => ({ data: undefined }),
}));
vi.mock('@shared/routes.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  navigate,
}));
// The plan's own cards and its health are tested where they live; here they
// would only add queries this contract does not read.
vi.mock('./health-panel', () => ({
  HealthPanel: ({ part }: { part?: string }) => <div data-testid={`health-${part ?? 'whole'}`} />,
}));
vi.mock('./map-view', () => ({
  MapView: () => <div data-testid="route-map" />,
  PlanCards: () => <div data-testid="plan-cards" />,
}));

const phase = (over: Partial<PhaseView>): PhaseView =>
  ({
    phase: 1,
    title: 'Foundations',
    state: 'ready',
    size: 'M',
    weight: 1,
    gated: false,
    ...over,
  }) as PhaseView;

const DETAIL = {
  summary: { slug: 'alpha', title: 'Alpha', qaMode: 'on', phases: 2, ready: [2] },
  plan: { sessionBudget: { skills: [] } },
  phases: [
    phase({
      phase: 1,
      title: 'Foundations',
      state: 'done',
      qa: { result: 'fail' },
      qaRounds: { count: 2, latest: { round: 2, result: 'fail' } },
    }),
    phase({ phase: 2, title: 'Surface', state: 'ready' }),
  ],
  handoffs: [],
  index: [],
  qa: [{ phase: 1, result: 'fail' }],
} as unknown as PlanDetail;

beforeAll(async () => {
  await loadEngine();
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ tables: {} });
  plan.mockResolvedValue(DETAIL);
});

function mount(node: React.ReactElement) {
  const client = new QueryClient({ ...queryClientConfig, defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the Phases tab', () => {
  it('opens on the table, and offers its four views as addresses', async () => {
    mount(<PhasesTab detail={DETAIL} />);
    expect(await screen.findByRole('table', { name: 'Phases' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Views of the phases' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Table', '#/plan/alpha/phases'],
      ['Map', '#/plan/alpha/phases?view=map'],
      ['QA', '#/plan/alpha/phases?view=qa'],
      ['Handoffs', '#/plan/alpha/phases?view=handoffs'],
    ]);
    expect(within(nav).getByRole('link', { name: 'Table' })).toHaveAttribute('aria-current', 'page');
    // The plan's health and its own cards are under every view.
    expect(screen.getByTestId('health-trouble')).toBeInTheDocument();
    expect(screen.getByTestId('health-context')).toBeInTheDocument();
    expect(screen.getByTestId('plan-cards')).toBeInTheDocument();
  });

  it('puts what is wrong above the table and the rest of the plan’s health below it', async () => {
    mount(<PhasesTab detail={DETAIL} />);
    const table = await screen.findByRole('table', { name: 'Phases' });
    const order = [
      screen.getByTestId('health-trouble'),
      screen.getByRole('navigation', { name: 'Views of the phases' }),
      table,
      screen.getByTestId('health-context'),
      screen.getByTestId('plan-cards'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('reads QA and Handoffs as readings of the one table, and the map as no table at all', async () => {
    const { unmount } = mount(<PhasesTab detail={DETAIL} view="qa" />);
    expect(await screen.findByRole('table', { name: 'QA by phase' })).toBeInTheDocument();
    unmount();
    const second = mount(<PhasesTab detail={DETAIL} view="handoffs" />);
    expect(await screen.findByRole('table', { name: 'Handoffs by phase' })).toBeInTheDocument();
    second.unmount();
    mount(<PhasesTab detail={DETAIL} view="map" />);
    expect(screen.getByTestId('route-map')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('link', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens the phase sheet from a row, and asks for the prose only then', async () => {
    mount(<PhasesTab detail={DETAIL} />);
    const inspect = await screen.findByRole('button', { name: 'Inspect phase 2' });
    expect(plan, 'the table asks for nothing beyond the board it was given').not.toHaveBeenCalled();
    fireEvent.click(inspect);
    expect(await screen.findByRole('dialog', { name: /Phase 02 — Surface/ })).toBeInTheDocument();
    await waitFor(() => expect(plan).toHaveBeenCalled());
  });

  it('opens the report sheet the address names, and closing it keeps the view', async () => {
    qaReport.mockResolvedValue({
      path: 'reports/phase-01-qa-round2.md',
      round: 2,
      text: '# Round 2\n\nfindings two',
    });
    mount(<PhasesTab detail={DETAIL} view="qa" report="1:2" />);
    expect(await screen.findByText('findings two')).toBeInTheDocument();
    expect(qaReport).toHaveBeenCalledWith('alpha', 1, 2);
    // A round picker over the ledger — both rounds, the addressed one pressed.
    expect(screen.getByRole('button', { name: 'round 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'round 2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/plan/alpha/phases?view=qa'));
  });
});
