/**
 * The plans library (7.0, quiet-console phase 9), mounted as the shell mounts
 * it — inside the router, over a client of the app's own config — against a
 * stubbed server.
 *
 * What is pinned (exit criteria 1 and 2): one line per plan with its five
 * facts — the mark, the name, the line, the work left, when it last moved;
 * the documents and the closed plans folded under the list with their counts
 * named, one press from every row; the toolbar's one grammar, whose order,
 * view and grouping persist in the 6.x preference keys. And what 6.2's page
 * pinned that is still true: it reads the SLIM runs, names a broken plan
 * once, says why a list is empty in the one sentence that is true, and links
 * a phase that could start to that phase.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSummaryFull } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import PlansLibrary from './index';

vi.setConfig({ testTimeout: 20_000 });

const NOW = Date.now();

const plan = (over: Partial<PlanSummaryFull> = {}): PlanSummaryFull => ({
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  status: 'active',
  activity: NOW - 3_600_000,
  phases: 4,
  done: 1,
  ready: [2],
  waiting: 1,
  inProgress: [],
  stuck: [],
  percent: 25,
  remainingWeight: 120_000,
  remainingSessions: 2,
  criticalPath: [2],
  criticalWeight: 40_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [],
  mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 1,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: true,
  ...over,
});

/** A slim run — one word per phase. */
const slimRun = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  slug: 'alpha',
  status: 'running',
  activePhase: 2,
  halt: null,
  children: {},
  verifying: {},
  liveness: [],
  phases: { '1': 'done', '2': 'running' },
  records: {},
  createdAt: new Date(NOW - 7_200_000).toISOString(),
  updatedAt: new Date(NOW - 60_000).toISOString(),
  resolved: false,
  spentUsd: 1,
  liveUsd: 0,
  runBudgetUsd: null,
  workedMs: 1000,
  model: 'opus',
  ...over,
});

let plans: PlanSummaryFull[] = [];
let runs: unknown[] = [];
let inbox: unknown[] = [];
let state: Record<string, unknown> = {};
let sent: string[] = [];

const answerFor = (url: string): unknown => {
  if (/^\/api\/state(\?|$)/.test(url)) return state;
  if (/^\/api\/plans(\?|$)/.test(url)) return plans;
  if (/^\/api\/runs(\?|$)/.test(url)) return runs;
  if (/^\/api\/inbox(\?|$)/.test(url)) return { items: inbox, generatedAt: new Date(NOW).toISOString() };
  if (/^\/api\/issues\/author(\?|$)/.test(url)) return { jobs: [] };
  return {};
};

beforeEach(() => {
  sent = [];
  localStorage.clear();
  // The shipped defaults, so every case opens on what an operator opens on.
  setPrefs({
    sort: 'activity',
    showDocuments: false,
    showClosed: false,
    plansLayout: 'list',
    plansGroup: 'none',
    everything: {},
    tables: {},
  });
  plans = [plan()];
  runs = [];
  inbox = [];
  state = {
    autopilot: true,
    allowRun: true,
    allowWrites: true,
    allowAgent: true,
    root: { path: '/repo', ok: true },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = String(input);
      sent.push(path);
      return new Response(JSON.stringify(answerFor(path)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function mount(address = '#/plans') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <PlansLibrary route={parseHash(address) as Route} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (slug: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-plan-row="${slug}"]`);
  if (!row) throw new Error(`no row for ${slug}`);
  return row;
};
const listedSlugs = () =>
  [...document.querySelectorAll('[data-plan-row]')].map((row) => row.getAttribute('data-plan-row'));

describe('one line per plan (criterion 1)', () => {
  it('draws the five facts: the mark, the name, the line, the work left, when it moved', async () => {
    plans = [
      plan({ slug: 'alpha', title: '**Alpha** plan', phases: 6, done: 2, inProgress: [3], ready: [4] }),
      plan({ slug: 'beta', title: 'Beta plan', activity: NOW - 3 * 86_400_000, remainingSessions: 5 }),
    ];
    runs = [slimRun({ slug: 'alpha', phases: { '1': 'done', '2': 'done', '3': 'running' }, activePhase: 3 })];
    inbox = [{ id: 'i1', slug: 'beta', severity: 'needs-you', kind: 'gate', title: 'Approve the gate' }];
    mount();

    await waitFor(() => expect(listedSlugs()).toEqual(['alpha', 'beta']));
    // 1 — the mark: the live run's word, a dot and a word. The list is drawn
    // from the plans alone; the runs and the inbox join it when they answer.
    await waitFor(() => expect(within(rowOf('alpha')).getByTestId('plan-mark')).toHaveTextContent('Running'));
    const alpha = rowOf('alpha');
    // 2 — the name, through plainText, and the row's way in.
    expect(within(alpha).getByRole('link', { name: 'Alpha plan' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases',
    );
    // 3 — the line, as labelled stations.
    const line = within(alpha).getByRole('list', { name: /Alpha plan: 2 of 6 phases done/ });
    expect(
      within(line)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['2 done', 'P3 in progress', 'P4 next up', '2 left']);
    // 4 — the work left, in sessions.
    expect(alpha).toHaveTextContent('2 sessions');
    // 5 — when it last moved.
    expect(within(alpha).getByText(/ago$/)).toBeInTheDocument();

    // A person waited on leads the other row's mark — amber, the one summons.
    const beta = rowOf('beta');
    const mark = within(beta).getByTestId('plan-mark');
    await waitFor(() => expect(mark).toHaveTextContent('Needs you'));
    expect(mark).toHaveAttribute('data-attention', 'needs-you');
    expect(beta).toHaveTextContent('5 sessions');
  });

  it('reads the slim runs, never the whole list (#234)', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['alpha']));
    expect(sent).toContain('/api/runs?view=slim');
    expect(sent).not.toContain('/api/runs');
  });

  it('opens a row in place onto the phases that could start, each linking to its phase', async () => {
    plans = [plan({ ready: [2, 3] })];
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['alpha']));
    fireEvent.click(within(rowOf('alpha')).getByRole('button', { name: /the rest of this row/ }));
    const detail = await screen.findByTestId('plan-row-detail');
    expect(within(detail).getByRole('link', { name: 'P2 next up' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phase/2',
    );
    expect(within(detail).getByRole('link', { name: 'Open the plan' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases',
    );
  });

  it('names a broken open plan once at the top, and not a closed one', async () => {
    plans = [
      plan({ slug: 'broken', title: 'Broken', engineError: 'open plan will not parse' }),
      plan({
        slug: 'gone',
        title: 'Walked away',
        status: 'abandoned',
        engineError: 'closed plan will not parse',
      }),
    ];
    mount();
    const banner = await screen.findByTestId('plans-broken');
    expect(banner).toHaveTextContent('open plan will not parse');
    expect(banner).not.toHaveTextContent('closed plan will not parse');
  });
});

describe('the folds (criterion 1)', () => {
  beforeEach(() => {
    plans = [
      plan({ slug: 'live', title: 'Still going' }),
      plan({ slug: 'shipped', title: 'Shipped', status: 'complete', phases: 3, done: 3, ready: [] }),
      plan({ slug: 'gone', title: 'Walked away', status: 'abandoned', phases: 4, done: 1, ready: [2, 3] }),
      plan({ slug: 'notes', title: 'Notes', kind: 'document', phases: 0, ready: [] }),
    ];
  });

  it('folds the closed plans and the documents under the list, each with its count named', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['live']));
    const closed = screen.getByTestId('plans-closed-fold');
    const documents = screen.getByTestId('plans-documents-fold');
    expect(closed).toHaveTextContent('Closed plans(2)');
    expect(documents).toHaveTextContent('Documents(1)');
    expect(closed).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(closed);
    await waitFor(() => expect(listedSlugs()).toEqual(['live', 'shipped', 'gone']));
    // A closed plan's line says what never ran, and it offers no phase to start.
    const gone = rowOf('gone');
    expect(within(gone).getByTestId('plan-mark')).toHaveTextContent('Abandoned');
    expect(gone).toHaveTextContent('3 never ran');
    expect(within(gone).queryByText(/next up/)).toBeNull();

    fireEvent.click(documents);
    await waitFor(() => expect(listedSlugs()).toContain('notes'));
    expect(within(rowOf('notes')).getByText('Document')).toBeInTheDocument();
  });

  it('narrows a fold with the same search that narrows the list', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['live']));
    fireEvent.change(screen.getByRole('searchbox', { name: /find a plan/i }), {
      target: { value: 'walked' },
    });
    expect(await screen.findByText(/Every match is a closed plan: 1 plan, folded below/)).toBeInTheDocument();
    expect(screen.getByTestId('plans-closed-fold')).toHaveTextContent('(1)');
    expect(screen.queryByTestId('plans-documents-fold')).toBeNull();
  });

  it('puts the closed plans in the list on request, and folds nothing twice', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['live']));
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Closed plans in the list/ }));
    // In the list, they take the list's order: the three moved at the same
    // moment, so Recent falls back to the name.
    await waitFor(() => expect(listedSlugs()).toEqual(['shipped', 'live', 'gone']));
    expect(getPrefs().showClosed).toBe(true);
    expect(screen.queryByTestId('plans-closed-fold')).toBeNull();
    expect(screen.getByTestId('plans-documents-fold')).toBeInTheDocument();
  });

  it('says every plan is closed rather than that nothing is there, and still folds them', async () => {
    plans = plans.filter((p) => p.status !== 'active');
    mount();
    expect(await screen.findByText(/Every plan here is closed/)).toBeInTheDocument();
    expect(screen.getByTestId('plans-closed-fold')).toHaveTextContent('(2)');
  });
});

describe('the toolbar — one grammar, kept in the 6.x keys (criterion 2)', () => {
  beforeEach(() => {
    plans = [
      plan({ slug: 'b-recent', title: 'Beta', activity: NOW - 60_000, repos: ['hub'] }),
      plan({ slug: 'a-old', title: 'Alpha', activity: NOW - 9 * 86_400_000, repos: ['shop'] }),
    ];
  });

  it('keeps the order in `sort`', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['b-recent', 'a-old']));
    fireEvent.click(screen.getByRole('button', { name: 'Sort, Recent' }));
    fireEvent.click(await screen.findByRole('radio', { name: /^Name/ }));
    await waitFor(() => expect(listedSlugs()).toEqual(['a-old', 'b-recent']));
    expect(getPrefs().sort).toBe('name');
  });

  it('keeps the view in `plansLayout`: cards, then the list again', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    await waitFor(() => expect(document.querySelectorAll('[data-plan-card]')).toHaveLength(2));
    expect(getPrefs().plansLayout).toBe('cards');
    expect(listedSlugs()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    expect(getPrefs().plansLayout).toBe('list');
  });

  it('reads a 6.x layout as the list', async () => {
    setPrefs({ plansLayout: 'board' });
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the grouping in `plansGroup`', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Group, One list' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Repository' }));
    expect(await screen.findByRole('heading', { name: /^hub/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^shop/ })).toBeInTheDocument();
    expect(getPrefs().plansGroup).toBe('repo');
  });

  it('filters by repository for this visit only, and says what the filter left out', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.change(await screen.findByTestId('plans-filter-repo'), { target: { value: 'shop' } });
    await waitFor(() => expect(listedSlugs()).toEqual(['a-old']));
    expect(screen.getByTestId('plans-filtered')).toHaveTextContent('1 plan matches. 1 left out.');
    expect(getPrefs()).not.toHaveProperty('repo');
  });

  it('says nothing matched rather than drawing an empty page', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    fireEvent.change(screen.getByRole('searchbox', { name: /find a plan/i }), { target: { value: 'zzzz' } });
    expect(await screen.findByText('Nothing matches the filters.')).toBeInTheDocument();
  });

  it('turns Everything on per page, and draws every column', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(2));
    expect(screen.queryByRole('columnheader', { name: /Slug/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /everything/i }));
    expect(await screen.findByRole('columnheader', { name: /Slug/ })).toBeInTheDocument();
    expect(getPrefs().everything.plans).toBe(true);
  });
});

describe('the ways a plan begins', () => {
  it('offers the three, and says which capability a refused one lacks', async () => {
    state = { ...state, allowAgent: false };
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(1));
    fireEvent.pointerDown(screen.getByTestId('new-plan'), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    const wizard = within(menu).getByTestId('new-plan-wizard');
    expect(wizard).toHaveAttribute('data-disabled');
    expect(wizard).toHaveTextContent('--allow-agent');
    expect(within(menu).getByTestId('new-plan-scaffold')).not.toHaveAttribute('data-disabled');
    // Plan from issues is the Issues desk, on the issues no plan has taken.
    expect(within(menu).getByTestId('new-plan-from-issues')).toHaveAttribute(
      'href',
      '#/repo/issues?plan=needs-plan',
    );
  });

  it('says the source is empty rather than drawing a blank list', async () => {
    plans = [];
    mount();
    expect(await screen.findByText(/No plans in this source yet/)).toBeInTheDocument();
  });
});
