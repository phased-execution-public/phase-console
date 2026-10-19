/**
 * The Phases view — one grid, its readings (7.0, quiet-console phase 10;
 * ported from `features/plans/phases-tab.test.tsx`, control-tower phase 23,
 * #26 #27).
 *
 * What is pinned here is the VIEW's contract; the grid's own is in
 * `table.test.tsx`, and every datum of the tabs this one replaced is walked in
 * `../detail.datums.test.tsx`:
 *
 *   - the six readings are ADDRESSES — links, with the current one marked;
 *   - `table`, `qa` and `handoffs` are three readings of the ONE grid, and
 *     `map` draws the route and no grid;
 *   - Inspect opens a row's phase in the panel, and its prose is asked for
 *     only then;
 *   - the QA report sheet opens where `?report=` says, and closing it keeps
 *     the reading the person was on;
 *   - the foot folds what the plan owes beyond its rows, and a prompt — an
 *     engine shell-out — is asked for only when ITS fold opens.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseView, PlanDetail } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import type { Everything } from '@/ui/everything';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import type { PhasesViewId } from '../tabs';
import { PhasesView } from './view';

// The map is its own chunk and its own test (`map/map.test.tsx`); here it
// would only draw a network this contract does not read.
vi.mock('../map/map-view', () => ({ MapView: () => <div data-testid="route-map" /> }));

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

/** The same plan with its prose — what Inspect's own read answers. */
const PROSE = {
  ...DETAIL,
  phases: DETAIL.phases.map((p) => (p.phase === 2 ? { ...p, steps: '1. Build the **surface**.' } : p)),
} as unknown as PlanDetail;

let sent: string[] = [];

const text = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function answer(path: string): Response {
  if (/^\/api\/plans\/alpha\?include=/.test(path)) return json(PROSE);
  if (/^\/api\/plans\/alpha\/qa-report\/1\?round=2$/.test(path))
    return json({ path: 'reports/phase-01-qa-round2.md', round: 2, text: '# Round 2\n\nfindings two' });
  if (/^\/api\/plans\/alpha\/prompt\/2$/.test(path)) return text('/phased-execution\n\nStart phase 2.');
  if (/^\/api\/plans\/alpha\/next-prompt\/1$/.test(path)) return text('board + prompts after phase 1');
  if (/^\/api\/run\/alpha$/.test(path)) return json({ run: null, history: [], eta: null });
  return json({});
}

beforeEach(() => {
  sent = [];
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  history.replaceState(null, '', '#/plan/alpha/phases');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = String(input);
      sent.push(path);
      return answer(path);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const OFF: Everything = { on: false, toggle: () => undefined };

function mount(view: PhasesViewId = 'table', extra: { report?: string; everything?: Everything } = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), {
    allowRun: true,
    allowAgent: false,
    allowWrites: false,
    autopilot: true,
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PhasesView detail={DETAIL} view={view} report={extra.report} everything={extra.everything ?? OFF} />
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The reads that cost an engine run or a prose payload — none of them is the grid's. */
const costly = () => sent.filter((path) => /\?include=|\/prompt\/|\/next-prompt\/|\/qa-prompt\//.test(path));

describe('the Phases view', () => {
  it('opens on the grid, and offers its six readings as addresses', async () => {
    mount();
    expect(await screen.findByRole('table', { name: 'Phases' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Readings of the phases' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Table', '#/plan/alpha/phases'],
      ['Map', '#/plan/alpha/phases?view=map'],
      ['QA', '#/plan/alpha/phases?view=qa'],
      ['Handoffs', '#/plan/alpha/phases?view=handoffs'],
      ['Schedule', '#/plan/alpha/phases?view=schedule'],
      ['Burn-up', '#/plan/alpha/phases?view=burnup'],
    ]);
    expect(within(nav).getByRole('link', { name: 'Table' })).toHaveAttribute('aria-current', 'page');
    // The plan's own folds are under the grid: what is left and the landing.
    const foot = screen.getByTestId('phases-foot');
    expect(within(foot).getByTestId('foot-left')).toBeInTheDocument();
    expect(within(foot).getByTestId('landing-card')).toBeInTheDocument();
  });

  it('puts the readings above the grid and the rest of the plan below it', async () => {
    mount();
    const table = await screen.findByRole('table', { name: 'Phases' });
    const order = [
      screen.getByRole('navigation', { name: 'Readings of the phases' }),
      table,
      screen.getByTestId('foot-left'),
      screen.getByTestId('landing-card'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('reads QA and Handoffs as readings of the one grid, and the map as no grid at all', async () => {
    const { unmount } = mount('qa');
    expect(await screen.findByRole('table', { name: 'QA by phase' })).toBeInTheDocument();
    unmount();
    const second = mount('handoffs');
    expect(await screen.findByRole('table', { name: 'Handoffs by phase' })).toBeInTheDocument();
    second.unmount();
    mount('map');
    expect(await screen.findByTestId('route-map')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('link', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
    // The foot is under every reading, the map's included.
    expect(screen.getByTestId('phases-foot')).toBeInTheDocument();
  });

  it('opens a phase in the panel from its row, and asks for the prose only then', async () => {
    mount();
    const inspect = await screen.findByRole('button', { name: 'Inspect phase 2' });
    expect(costly(), 'the grid asks for nothing beyond the board it was given').toEqual([]);
    fireEvent.click(inspect);
    const panel = document.querySelector<HTMLElement>('[data-inspector]');
    expect(panel, 'Inspect drew nothing in the panel').not.toBeNull();
    expect(panel).toHaveAttribute('aria-label', 'Surface');
    expect(within(panel!).getByText('Phase 02 of alpha')).toBeInTheDocument();
    await waitFor(() =>
      expect(costly().some((path) => path.startsWith('/api/plans/alpha?include='))).toBe(true),
    );
    // …and the prose it asked for lands in the panel.
    expect(await within(panel!).findByText(/Build the surface/)).toBeInTheDocument();
  });

  it('opens the report sheet the address names, and closing it keeps the reading', async () => {
    mount('qa', { report: '1:2' });
    expect(await screen.findByText('findings two')).toBeInTheDocument();
    expect(sent).toContain('/api/plans/alpha/qa-report/1?round=2');
    // A round picker over the ledger — both rounds, the addressed one pressed.
    expect(screen.getByRole('button', { name: 'Round 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Round 2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(location.hash).toBe('#/plan/alpha/phases?view=qa'));
  });
});

describe('the foot — what the plan owes beyond its rows', () => {
  it('folds the boot prompts with their count, and asks for a prompt only when ITS fold opens', async () => {
    mount();
    await screen.findByRole('table', { name: 'Phases' });
    const prompts = screen.getByTestId('foot-prompts');
    expect(prompts).toHaveTextContent('Boot prompts(1)');
    fireEvent.click(prompts);
    // The fold names each ready phase's prompt; opening it is still not a read.
    expect(
      within(screen.getByTestId('prompt-boot-2')).getByText('Boot prompt for phase 2'),
    ).toBeInTheDocument();
    expect(costly()).toEqual([]);
    fireEvent.click(
      within(screen.getByTestId('prompt-boot-2')).getByRole('button', { name: 'Show the prompt' }),
    );
    expect(await screen.findByText(/Start phase 2\./)).toBeInTheDocument();
    expect(costly()).toEqual(['/api/plans/alpha/prompt/2']);
  });

  it('folds the end-of-phase banner after the last finished phase, read on the same terms', async () => {
    mount();
    await screen.findByRole('table', { name: 'Phases' });
    fireEvent.click(screen.getByTestId('foot-banner'));
    const fold = screen.getByTestId('prompt-next-1');
    expect(fold).toHaveTextContent('After phase 1');
    expect(costly()).toEqual([]);
    fireEvent.click(within(fold).getByRole('button', { name: 'Show the prompt' }));
    expect(await screen.findByText('board + prompts after phase 1')).toBeInTheDocument();
    expect(costly()).toEqual(['/api/plans/alpha/next-prompt/1']);
  });

  it('opens every fold with Everything on — and still spends no prompt', async () => {
    mount('table', { everything: { on: true, toggle: () => undefined } });
    await screen.findByRole('table', { name: 'Phases' });
    for (const id of ['foot-prompts', 'foot-banner', 'foot-left']) {
      expect(screen.getByTestId(id), id).toHaveAttribute('aria-expanded', 'true');
    }
    // Each prompt keeps its own fold: open is a read, and Everything is not a read.
    expect(screen.getByText('Boot prompt for phase 2')).toBeInTheDocument();
    expect(costly()).toEqual([]);
  });
});
