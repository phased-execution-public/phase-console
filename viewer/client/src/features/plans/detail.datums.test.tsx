/**
 * No datum removed — every fact of the tabs that folded is within TWO
 * interactions of the plan page (control-tower phase 23, exit criterion 3;
 * `docs/design.md` §5: "No datum removed · every datum within 2 interactions").
 *
 * Route, QA and Handoffs were three lists of the same phases and are views of
 * the one phase table now. This walks what each of them showed, from where a
 * plan OPENS (the Phases tab, the table view, header above it), and counts the
 * presses it takes to reach each fact: a view switch, a folded group, a row's
 * detail. A fact that needs a third press, or that is not on the page at all,
 * fails here by name.
 *
 * The header's own facts (#28's start and span, #27's QA card, #17's "could
 * not run") are reached with none.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { loadEngine } from '@/components/data-table';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { PlanHeader } from './header';
import { PhasesTab } from './phases-tab';
import type { PhasesViewId } from './tabs';

const { plan } = vi.hoisted(() => ({ plan: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, plan } };
});
vi.mock('@/lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConsoleState: () => ({
    data: {
      allowRun: true,
      allowAgent: false,
      allowWrites: true,
      autopilot: true,
      scriptsDir: '/opt/pe/scripts',
    },
  }),
  useRun: () => ({ data: undefined }),
  useSessions: () => ({ data: undefined }),
  // The drawer's diagnosis and its neighbours fetch on open; none of them is a
  // datum of a tab that folded.
  useDiagnosis: () => ({ data: undefined, error: null, isFetching: false }),
  useRulings: () => ({ data: { rulings: [] } }),
  useIssues: () => ({ data: undefined }),
}));
vi.mock('./health-panel', () => ({
  HealthPanel: ({ part }: { part?: string }) => <div data-testid={`health-${part ?? 'whole'}`} />,
}));
vi.mock('./map-view', () => ({
  MapView: () => <div data-testid="route-map" />,
  PlanCards: () => <div data-testid="plan-cards" />,
}));
vi.mock('./notes-section', () => ({ NotesSection: () => null }));
vi.mock('@/features/runs/now-panel', () => ({ LastActivity: () => null, NowPanel: () => null }));

const phase = (over: Partial<PhaseView>): PhaseView =>
  ({ size: 'M', weight: 1, gated: false, ...over }) as PhaseView;

const PHASES: PhaseView[] = [
  phase({
    phase: 1,
    title: 'Foundations',
    state: 'done',
    goal: 'lay the floor',
    qa: { result: 'pass' },
    qaMode: { mode: 'on', source: 'plan' },
    handoff: {
      file: 'phase-01-foundations.md',
      status: 'complete',
      completed: '2026-09-01',
      title: 'Foundations',
      skillsUsed: ['superpowers:test-driven-development'],
      prompts: 1,
    },
  }),
  phase({
    phase: 2,
    title: 'Surface',
    state: 'done',
    goal: 'draw the surface',
    qa: { result: 'fail', report: 'reports/phase-02-qa-round2.md' },
    qaMode: { mode: 'on', source: 'phase' },
    qaRounds: { count: 2, latest: { round: 2, result: 'fail' } },
    qaHeld: [3],
    handoff: {
      file: 'phase-02-surface.md',
      status: 'complete',
      title: 'Surface',
      skillsUsed: [],
      prompts: 1,
    },
  }),
  phase({
    phase: 3,
    title: 'Cutover',
    state: 'waiting',
    size: 'L',
    goal: 'retire the old client',
    gated: true,
    gateKind: 'human',
    gateCheck: 'manual: operator sign-off',
    blockedBy: [{ phase: 2, why: 'qa:fail' }],
    lock: { owner: 'autopilot/abc123', expired: false },
    row: {
      phase: 3,
      title: 'Cutover',
      dependsOn: [2],
      parallelSafe: '—',
      repos: 'web',
      exitCriteria: 'gone',
    },
  }),
];

const DETAIL = {
  summary: {
    slug: 'alpha',
    title: 'Alpha',
    kind: 'plan',
    status: 'active',
    phases: 3,
    done: 2,
    ready: [],
    inProgress: [],
    stuck: [],
    qaMode: 'on',
    qaModeReason: 'plan directive: QA gate: on',
    startedAt: '2026-09-22T06:40:19.000Z',
    spanMs: 7_200_000,
  },
  plan: { sessionBudget: { skills: [] } },
  phases: PHASES,
  handoffs: [
    {
      phase: 1,
      file: 'phase-01-foundations.md',
      title: 'Foundations handoff',
      status: 'complete',
      completed: '2026-09-01',
      bytes: 4096,
      mtime: 0,
      prompts: 1,
      skillsUsed: ['superpowers:test-driven-development'],
    },
    {
      phase: 2,
      file: 'phase-02-surface.md',
      title: 'Surface handoff',
      status: 'complete',
      bytes: 2048,
      mtime: 0,
      prompts: 1,
      skillsUsed: [],
    },
  ],
  // Phase 2's handoff has no INDEX row — the Handoffs tab said `missing`.
  index: [{ phase: 1, title: 'Foundations', status: 'complete' }],
  qa: [
    { phase: 1, result: 'pass' },
    { phase: 2, result: 'fail' },
  ],
  qaHeld: { 2: [3] },
  eta: { plan: null, perPhase: [{ phase: 3, estMs: 3 * 3_600_000, label: '~3h', basis: 'measured' }] },
  lint: {
    ok: true,
    crashed: true,
    issues: [],
    summary: 'validation could not run: the engine died on SIGSEGV',
  },
  git: {},
  route: { nodes: [], edges: [], layers: 0, rows: 0 },
} as unknown as PlanDetail;

beforeAll(async () => {
  await loadEngine();
}, 30_000);

beforeEach(() => {
  setPrefs({ tables: {} });
  plan.mockResolvedValue(DETAIL);
});

/** The plan page as it opens: the header, then the Phases tab on the view asked for. */
function openPlan(view: PhasesViewId = 'table') {
  const client = new QueryClient({ ...queryClientConfig, defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PlanHeader detail={DETAIL} />
        <PhasesTab detail={DETAIL} view={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Every press is counted; a datum's budget is two. */
let presses = 0;
const press = (el: Element) => {
  presses += 1;
  fireEvent.click(el);
};
const onPage = (text: string) => (document.body.textContent ?? '').includes(text);
const rowOf = (title: string) => screen.getByRole('link', { name: title }).closest('tr') as HTMLElement;
/** Open a row's detail — one press. */
const openRow = (title: string) =>
  press(within(rowOf(title)).getByRole('button', { name: /Show the rest of this row/ }));

async function expectWithinTwo(facts: readonly string[]) {
  for (const fact of facts) {
    await waitFor(() => expect(onPage(fact), `"${fact}" is not on the page`).toBe(true));
  }
  expect(presses, `reached in ${presses} presses`).toBeLessThanOrEqual(2);
}

describe('every datum of the folded tabs is within two interactions', () => {
  beforeEach(() => {
    presses = 0;
  });

  it('the plan header — #28, #27 and #17 — with none', async () => {
    openPlan();
    await expectWithinTwo([
      '2026-09-22 06:40Z',
      'QA gate · on (plan directive: QA gate: on)',
      '1 failing, 1 passed',
      'holding P3 (by P2)',
      'Plan health could not run',
    ]);
    expect(presses).toBe(0);
  });

  it('Route: a waiting phase — its name, goal, state, what holds it, scope, size, ETA, gate, lock, deps', async () => {
    openPlan();
    await screen.findByRole('link', { name: 'Cutover' });
    // On the row itself, or — for a column the window folded or the reading
    // hides — in the row's detail: one press.
    const visible = ['03', 'Cutover', 'retire the old client', 'qa:fail', 'held by its QA verdict'];
    await expectWithinTwo(visible);
    openRow('Cutover');
    await expectWithinTwo(['web', 'L', '~3h', 'human gate', 'manual: operator sign-off', 'autopilot/abc123']);
    // The L2 sheet is a press from the row too.
    expect(screen.getByRole('button', { name: 'Inspect phase 3' })).toBeInTheDocument();
  });

  it('QA: the regime and its level, the verdict and its round, what it holds, the actions — on the QA view', async () => {
    openPlan('qa'); // the view switch is the first press
    presses += 1;
    await screen.findByRole('table', { name: 'QA by phase' });
    await expectWithinTwo(['round 2', 'holds P3', 'on · phase directive', 'on · plan']);
    expect(screen.getByRole('link', { name: /QA fail — open the report/ })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa&report=2:2',
    );
    openRow('Surface');
    await expectWithinTwo([
      'decided by the phase’s own QA bullet',
      'round 2 of 2',
      'P3 — until this verdict changes',
    ]);
    expect(screen.getByRole('link', { name: 'Open report' })).toBeInTheDocument();
  });

  it('QA: the same facts from the table view — unfold Done, open the row', async () => {
    openPlan();
    const done = await screen.findByRole('button', { name: /Need:\s*Done/ });
    press(done);
    await screen.findByRole('link', { name: 'Surface' });
    openRow('Surface');
    await expectWithinTwo(['decided by the phase’s own QA bullet', 'round 2 of 2']);
  });

  it('Handoffs: status, completed, title, size, skills and the INDEX row — on the Handoffs view', async () => {
    openPlan('handoffs');
    presses += 1;
    await screen.findByRole('table', { name: 'Handoffs by phase' });
    await expectWithinTwo(['2026-09-01', 'no index row']);
    expect(document.querySelectorAll('[data-status="complete"]').length).toBeGreaterThanOrEqual(2);
    openRow('Foundations');
    await expectWithinTwo([
      'Foundations handoff',
      '4K',
      'superpowers:test-driven-development',
      'INDEX.md reads complete',
    ]);
    expect(screen.getAllByRole('link', { name: /Read the handoff|Handoff complete/ })[0]).toHaveAttribute(
      'href',
      '#/plan/alpha/handoff/1',
    );
  });

  it('the plan’s own cards and its health are under every view, with no press', async () => {
    for (const view of ['table', 'map', 'qa', 'handoffs'] as const) {
      const { unmount } = openPlan(view);
      // In two parts: what is wrong above the table, the rest of it below.
      expect(screen.getByTestId('health-trouble')).toBeInTheDocument();
      expect(screen.getByTestId('health-context')).toBeInTheDocument();
      expect(screen.getByTestId('plan-cards')).toBeInTheDocument();
      unmount();
    }
    await act(async () => {});
  });
});
