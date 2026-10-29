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
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
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
/** A plan's detail by slug — what the drawer reads once it opens. */
let details: Record<string, unknown> = {};

const answerFor = (url: string): unknown => {
  if (/^\/api\/state(\?|$)/.test(url)) return state;
  if (/^\/api\/plans(\?|$)/.test(url)) return plans;
  const detail = /^\/api\/plans\/([^/?]+)(\?|$)/.exec(url);
  if (detail) return details[decodeURIComponent(detail[1]!)] ?? {};
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
  details = {};
  __resetInspectorForTests();
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

function mount(address = '#/plans', { panel = false }: { panel?: boolean } = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <PlansLibrary route={parseHash(address) as Route} />
        {/* The shell's panel, as the app hosts it beside the page: where Inspect puts a record. */}
        {panel && (
          <aside data-testid="panel">
            <InspectorHost />
          </aside>
        )}
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
/** The legend's badges, as the words they say. */
const badgeWords = (legend: HTMLElement) =>
  [...legend.querySelectorAll('[data-share]')].map((badge) => badge.textContent);

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
    // 1 — the mark: the plan's own status as a badge (#361), and beside it —
    // never instead of it — the live run's word. The list is drawn from the
    // plans alone; the runs and the inbox join it when they answer.
    await waitFor(() =>
      expect(within(rowOf('alpha')).getByTestId('plan-run-mark')).toHaveTextContent('Running'),
    );
    const alpha = rowOf('alpha');
    const badge = within(alpha).getByTestId('plan-mark');
    expect(badge).toHaveAttribute('data-chrome', 'badge');
    expect(badge).toHaveAttribute('data-vocab', 'plan');
    expect(badge).toHaveTextContent('Active');
    // 2 — the name, through plainText, and the row's way in.
    expect(within(alpha).getByRole('link', { name: 'Alpha plan' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases',
    );
    // 3 — the line, drawn in proportion (#360): every bucket a segment the
    // length of its share, the counts in words beside it and in its name.
    const track = within(alpha).getByRole('img', {
      name: 'Alpha plan, 6 phases: 2 done, 1 in progress, 1 next up, 1 waiting, 1 left, 25 %',
    });
    const segments = [...track.querySelectorAll<HTMLElement>('[data-segment]')];
    expect(segments.map((s) => [s.dataset.segment, Number(s.dataset.count)])).toEqual([
      ['done', 2],
      ['in-progress', 1],
      ['ready', 1],
      ['waiting', 1],
      ['rest', 1],
    ]);
    // Every share a badge of the family, the rest in words, the percentage a badge of its own.
    const legend = within(alpha).getByTestId('plan-legend');
    expect(badgeWords(legend)).toEqual(['2 done', '1 in progress', '1 next up', '1 waiting']);
    for (const badge of legend.querySelectorAll('[data-share]')) {
      expect(badge).toHaveAttribute('data-chrome', 'badge');
    }
    expect(within(legend).getByTestId('plan-rest')).toHaveTextContent('1 left');
    expect(within(alpha).getByTestId('plan-percent')).toHaveTextContent('25 %');
    expect(within(alpha).getByTestId('plan-percent')).toHaveAttribute('data-chrome', 'badge');
    // 4 — the work left, in sessions.
    expect(alpha).toHaveTextContent('2 sessions');
    // 5 — when it last moved.
    expect(within(alpha).getByText(/ago$/)).toBeInTheDocument();

    // A person waited on leads the other row's mark — amber, the one summons —
    // and the plan's own badge still stands beside it.
    const beta = rowOf('beta');
    const summons = await within(beta).findByTestId('plan-attention');
    expect(summons).toHaveTextContent('Needs you');
    expect(summons).toHaveAttribute('data-attention', 'needs-you');
    expect(within(beta).getByTestId('plan-mark')).toHaveAttribute('data-chrome', 'badge');
    expect(beta).toHaveTextContent('5 sessions');
  });

  it('draws a card with the plan’s badge beside the run’s word, and the same track (#360, #361)', async () => {
    setPrefs({ plansLayout: 'cards' });
    plans = [plan({ phases: 8, done: 3, stuck: [4], ready: [5], waiting: 2, qaFailures: [2], percent: 38 })];
    runs = [slimRun({ phases: { '1': 'done', '2': 'running' } })];
    mount();
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-plan-card="alpha"]');
      if (!found) throw new Error('no card yet');
      return found;
    });
    await waitFor(() => expect(within(card).getByTestId('plan-run-mark')).toHaveTextContent('Running'));
    expect(within(card).getByTestId('plan-mark')).toHaveAttribute('data-chrome', 'badge');
    expect(within(card).getByTestId('plan-mark')).toHaveTextContent('Active');
    const track = within(card).getByRole('img', { name: /^Alpha plan, 8 phases: / });
    const counts = [...track.querySelectorAll<HTMLElement>('[data-segment]')].map((s) =>
      Number(s.dataset.count),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
    expect(badgeWords(within(card).getByTestId('plan-legend'))).toEqual([
      '2 done',
      '1 held by QA',
      '1 stuck',
      '1 next up',
      '2 waiting',
    ]);
    expect(within(card).getByTestId('plan-percent')).toHaveTextContent('38 %');
    // The card's status is the same button the list's is.
    expect(
      within(card).getByRole('button', { name: 'Why Alpha plan says Running and Active' }),
    ).toBeInTheDocument();
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
    // Fold strips: each name, and its count in a pill — heard as "Closed plans (2)".
    expect(closed).toHaveTextContent('Closed plans (2)');
    expect(documents).toHaveTextContent('Documents (1)');
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
    // The plan-status column draws the badge too (#361).
    const cell = within(rowOf('b-recent')).getByTestId('plan-status');
    expect(cell).toHaveAttribute('data-chrome', 'badge');
    expect(cell).toHaveAttribute('data-status', 'active');
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

/* ------------------------------------------------------------------ *
 * Every status says why — its button, and the drawer it opens
 * ------------------------------------------------------------------ */

const errandRow = (over: Record<string, unknown> = {}) => ({
  id: 'errand:alpha:3:r1:human-acts',
  kind: 'errand',
  severity: 'needs-you',
  slug: 'alpha',
  phase: 3,
  runId: 'r1',
  title: 'Decide whether the fix release goes first',
  need: 'Make a decision: add a fix release before Release B?',
  how: 'Choose one of the options and send your decision.',
  since: new Date(NOW - 600_000).toISOString(),
  actions: [],
  href: '',
  turn: {
    item: 'errand:alpha:3:r1:human-acts',
    record: 'projected',
    source: 'errand',
    kind: 'operator-act',
    why: 'decision',
    proofType: 'answer',
    group: 'decide',
    type: 'decide',
    readiness: 'now',
  },
  ...over,
});

const statusButton = (slug: string) => within(rowOf(slug)).getByTestId('plan-status-why');
const panel = () => screen.getByTestId('panel');

describe('every status says why — a button, and the panel on its reasons (ask 1)', () => {
  beforeEach(() => {
    setPrefs({ showClosed: true, showDocuments: true });
    plans = [
      plan({ slug: 'asks', title: 'Asks you' }),
      plan({ slug: 'runs', title: 'Runs now', inProgress: [2], ready: [] }),
      plan({ slug: 'waits', title: 'Waits out a wall', ready: [] }),
      plan({ slug: 'parked', title: 'Parked on a gate', ready: [9] }),
      plan({ slug: 'idle', title: 'Nobody runs it', ready: [2, 3] }),
      plan({
        slug: 'shipped',
        title: 'Shipped',
        status: 'complete',
        closed: true,
        closedOn: '2026-10-19',
        phases: 3,
        done: 3,
        ready: [],
        waiting: 0,
      }),
      plan({ slug: 'notes', title: 'Notes', kind: 'document', phases: 0, ready: [] }),
    ];
    runs = [
      slimRun({
        id: 'r-runs',
        slug: 'runs',
        activePhase: 2,
        children: { '2': { pid: 1, phase: 2, startedAt: new Date(NOW - 1_200_000).toISOString() } },
        phases: { '1': 'done', '2': 'running' },
      }),
      slimRun({
        id: 'r-waits',
        slug: 'waits',
        status: 'waiting',
        lifecycle: undefined,
        waitReason: 'usage-limit',
        waitUntil: new Date(NOW + 3_600_000).toISOString(),
        activePhase: null,
        phases: { '1': 'done' },
      }),
      slimRun({
        id: 'r-parked',
        slug: 'parked',
        status: 'parked',
        lifecycle: { state: 'parked' },
        activePhase: null,
        phases: { '9': 'gated' },
        halt: {
          at: new Date(NOW - 60_000).toISOString(),
          reason: 'nothing left to run on its own',
          kind: 'nothing-ready',
          holders: [
            {
              phase: 9,
              kind: 'gate',
              verb: 'approve-gate',
              why: 'gate not clear: blocked — beta phase(s) 14 not verified',
              gate: 'beta phase(s) 14 not verified',
              gateKind: 'blocked',
            },
          ],
        },
      }),
    ];
    inbox = [errandRow({ slug: 'asks', runId: undefined })];
  });

  it('draws the status of every row — every word a row can lead with — as a button that says what it opens', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toHaveLength(7));
    const names: Record<string, string> = {
      asks: 'Why Asks you says Needs you and Active',
      runs: 'Why Runs now says Running and Active',
      waits: 'Why Waits out a wall says Waiting and Active',
      parked: 'Why Parked on a gate says Parked and Active',
      idle: 'Why Nobody runs it says Active',
      shipped: 'Why Shipped says Complete',
      notes: 'Why Notes says Document',
    };
    await waitFor(() => expect(statusButton('runs')).toHaveAccessibleName(names.runs!));
    for (const [slug, name] of Object.entries(names)) {
      const button = statusButton(slug);
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAccessibleName(name);
      expect(button).toHaveTextContent(/Why$/);
      // The marks inside it are the button's, never tab stops of their own.
      for (const mark of button.querySelectorAll<HTMLElement>('[data-status]')) {
        expect(mark.hasAttribute('tabindex')).toBe(false);
      }
    }
  });

  it('Needs you: opens the panel on what exactly needs you, with the way to it on Your turn', async () => {
    mount('#/plans', { panel: true });
    await waitFor(() => expect(statusButton('asks')).toHaveAccessibleName(/Needs you/));
    fireEvent.click(statusButton('asks'));
    const why = await within(panel()).findByTestId('plan-why');
    expect(why).toHaveAttribute('data-word', 'Needs you');
    expect(within(why).getByRole('heading', { name: 'Why it says Needs you' })).toBeInTheDocument();
    expect(within(why).getByTestId('plan-why-headline')).toHaveTextContent(
      'It needs you: Decide whether the fix release goes first.',
    );
    const needs = why.querySelector<HTMLElement>('[data-why="you"]')!;
    expect(within(needs).getByText('Decide whether the fix release goes first')).toBeInTheDocument();
    expect(
      within(needs).getByText('Make a decision: add a fix release before Release B?'),
    ).toBeInTheDocument();
    // The item leads with the card's own words — NOW and its type.
    expect(within(needs).getByTestId('turn-row-words')).toHaveAttribute('data-type', 'decide');
    expect(within(needs).getByRole('link', { name: 'Open it on Your turn' })).toHaveAttribute(
      'href',
      '#/turn/errand%3Aalpha%3A3%3Ar1%3Ahuman-acts',
    );
    expect(statusButton('asks')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Running: names the phase a session is on, and since when', async () => {
    mount('#/plans', { panel: true });
    await waitFor(() => expect(statusButton('runs')).toHaveAccessibleName(/Running/));
    fireEvent.click(statusButton('runs'));
    const why = await within(panel()).findByTestId('plan-why');
    expect(within(why).getByTestId('plan-why-headline')).toHaveTextContent(
      'Its run is working: phase 2 is running.',
    );
    const live = why.querySelector<HTMLElement>('[data-why="live"]')!;
    expect(within(live).getByText('Phase 2')).toBeInTheDocument();
    expect(within(live).getByText(/^started/)).toHaveTextContent(/20 minutes ago/);
    expect(within(live).getByRole('link', { name: 'Open phase 2' })).toHaveAttribute(
      'href',
      '#/plan/runs/phase/2',
    );
  });

  it('Waiting: says what the run waits on and when it resets', async () => {
    mount('#/plans', { panel: true });
    await waitFor(() => expect(statusButton('waits')).toHaveAccessibleName(/Waiting/));
    fireEvent.click(statusButton('waits'));
    const why = await within(panel()).findByTestId('plan-why');
    expect(within(why).getByTestId('plan-why-headline')).toHaveTextContent(
      // The reset is an hour off: past 23:00Z it is tomorrow's, and the clock says the day too.
      /^Its run is waiting on .+ resets (?:[A-Z][a-z]{2} \d{1,2} )?\d\d:\d\dZ\.$/,
    );
    const waits = why.querySelector<HTMLElement>('[data-why="waits"]')!;
    expect(within(waits).getByText(/^resets/)).toHaveTextContent(/in 1 hour|in 60 minutes/);
  });

  it('Parked: draws the halt card — what stopped it and its one recommended recovery', async () => {
    mount('#/plans', { panel: true });
    await waitFor(() => expect(statusButton('parked')).toHaveAccessibleName(/Parked/));
    fireEvent.click(statusButton('parked'));
    const why = await within(panel()).findByTestId('plan-why');
    const card = within(why).getByTestId('halt-card');
    expect(within(card).getByTestId('halt-sentence')).toHaveTextContent(
      'Nothing is ready to run: every phase that is left is held by one of the things below.',
    );
    expect(within(card).getByTestId('halt-holder')).toHaveTextContent('Phase 9');
    // The row says the same holder in a few words.
    expect(within(rowOf('parked')).getByTestId('plan-waits')).toHaveTextContent('Phase 9’s gate');
  });

  it('Active with nothing running: says what can start, and where to start it', async () => {
    mount('#/plans', { panel: true });
    await waitFor(() => expect(listedSlugs()).toContain('idle'));
    fireEvent.click(statusButton('idle'));
    const why = await within(panel()).findByTestId('plan-why');
    expect(within(why).getByTestId('plan-why-headline')).toHaveTextContent(
      'Nothing is running it, and 2 phases can start: 2 and 3.',
    );
    expect(within(why).getByRole('link', { name: 'Open its Run view' })).toHaveAttribute(
      'href',
      '#/plan/idle/run',
    );
  });

  it('Complete: says how it ended', async () => {
    mount('#/plans', { panel: true });
    await waitFor(() => expect(listedSlugs()).toContain('shipped'));
    fireEvent.click(statusButton('shipped'));
    const why = await within(panel()).findByTestId('plan-why');
    expect(within(why).getByTestId('plan-why-headline')).toHaveTextContent(
      'Every phase is done and the plan was closed out.',
    );
    const ended = why.querySelector<HTMLElement>('[data-why="ended"]')!;
    expect(ended).toHaveTextContent('Closed on 2026-10-19.');
    expect(ended).toHaveTextContent('All 3 phases done.');
  });

  it('draws the plan’s phases in the panel as the pipeline in their own order, once its detail is read', async () => {
    details = {
      idle: {
        summary: plans.find((p) => p.slug === 'idle'),
        phases: [
          { phase: 1, title: 'Lay the floor', state: 'done', gated: false },
          { phase: 2, title: 'Wire it', state: 'ready', gated: false },
          { phase: 3, title: 'Ship it', state: 'ready', gated: true, gateKind: 'ai' },
          {
            phase: 4,
            title: 'Close',
            state: 'waiting',
            gated: false,
            blockedBy: [{ phase: 3, why: 'not-done' }],
          },
        ],
        locks: [],
      },
    };
    mount('#/plans', { panel: true });
    await waitFor(() => expect(listedSlugs()).toContain('idle'));
    fireEvent.click(statusButton('idle'));
    const why = await within(panel()).findByTestId('plan-why');
    await waitFor(() => expect(why.querySelector('[data-pipeline="ordered"]')).not.toBeNull());
    const cells = [...why.querySelectorAll<HTMLElement>('[data-pipeline="ordered"] [data-cell]')];
    expect(cells.map((cell) => cell.dataset.phase)).toEqual(['1', '2', '3', '4']);
    expect(cells[2]!.querySelector('[data-gated]')).not.toBeNull();
    // …and the detail's facts join the reasons: the gate, the dependency.
    const waits = why.querySelector<HTMLElement>('[data-why="waits"]')!;
    expect(waits).toHaveTextContent('Phase 3, Ship it has a gate, which a session checks before it starts.');
    expect(waits).toHaveTextContent('Phase 4, Close waits on phase 3 (next up).');
  });
});

/* ------------------------------------------------------------------ *
 * The richer table, scrolling sideways with the status and name pinned
 * ------------------------------------------------------------------ */

describe('the table carries the plan’s live facts, and scrolls rather than folds them (ask 2)', () => {
  const GLANCE = [
    'Status',
    'Plan',
    'Phases',
    'Now',
    'Waiting on',
    'Next up',
    'Your turn',
    'Left',
    'Spent',
    'Account',
    'Model',
    'Moved',
  ];

  beforeEach(() => {
    plans = [
      plan({
        phases: 6,
        done: 2,
        inProgress: [4],
        ready: [5],
        waiting: 1,
        eta: { lowMs: 2 * 3_600_000, highMs: 4 * 3_600_000, basis: 'plan', samples: 3, missing: 0 } as never,
      }),
    ];
    runs = [
      slimRun({
        activePhase: 4,
        children: { '4': { pid: 7, phase: 4, startedAt: new Date(NOW - 600_000).toISOString() } },
        phases: { '1': 'done', '2': 'done', '3': 'parked', '4': 'running' },
        spentUsd: 12.5,
        model: 'claude-opus-5-5',
        effort: 'high',
        accountId: 'default',
      }),
      slimRun({
        id: 'r0',
        createdAt: new Date(NOW - 9 * 86_400_000).toISOString(),
        status: 'finished',
        spentUsd: 7.5,
      }),
    ];
    inbox = [
      errandRow(),
      {
        id: 'step:later',
        kind: 'human-step',
        severity: 'fyi',
        slug: 'alpha',
        title: 'Pick the clock',
        need: '',
        how: '',
        since: new Date(NOW).toISOString(),
        actions: [],
        href: '',
        turn: {
          item: 'step:later',
          record: 'ledger',
          group: 'upcoming',
          type: 'decide',
          readiness: 'not-yet',
        },
      },
    ];
  });

  it('draws every glance column at the glance, with Everything off', async () => {
    mount();
    await waitFor(() => expect(listedSlugs()).toEqual(['alpha']));
    const heads = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(heads).toEqual(GLANCE);
  });

  it('says what is live, what it waits on, its Your turn, the work left, the spend, who pays and on what', async () => {
    mount();
    await waitFor(() => expect(within(rowOf('alpha')).getByTestId('plan-now')).toHaveTextContent('P4'));
    const row = rowOf('alpha');
    const now = within(row).getByTestId('plan-now');
    expect(within(now).getByRole('link', { name: 'P4' })).toHaveAttribute('href', '#/plan/alpha/phase/4');
    expect(within(now).getByText('Running')).toBeInTheDocument();
    expect(within(row).getByTestId('plan-waits')).toHaveTextContent('You, on phase 3');
    expect(within(row).getByTestId('plan-waits')).toHaveTextContent(
      'Decide whether the fix release goes first',
    );
    const turn = within(row).getByTestId('plan-turn');
    expect(within(turn).getByRole('link', { name: '2 open' })).toHaveAttribute('href', '#/plan/alpha/turn');
    expect(turn).toHaveTextContent('1 to do now');
    expect(row).toHaveTextContent('2 sessions');
    expect(row).toHaveTextContent(/~2 h–4 h of work left/);
    // Both runs' spend, booked.
    expect(row).toHaveTextContent('$20.00');
    expect(row).toHaveTextContent('machine login');
    expect(row).toHaveTextContent('Claude');
    expect(row).toHaveTextContent('effort high');
    expect(within(row).getByRole('link', { name: 'P5 next up' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phase/5',
    );
  });

  describe('on a desk narrower than the columns', () => {
    let box = 1000;
    let need = 2200;
    beforeEach(() => {
      box = 1000;
      need = 2200;
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
        return this.firstElementChild?.tagName === 'TABLE' ? box : 0;
      });
      vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
        return this.tagName === 'TABLE' ? need : 0;
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it('scrolls inside its own box with the status and the name pinned, and folds no glance column', async () => {
      mount();
      await waitFor(() => expect(listedSlugs()).toEqual(['alpha']));
      const table = screen.getByRole('table', { name: 'Plans' });
      const wrapper = table.parentElement!;
      await waitFor(() => expect(wrapper).toHaveAttribute('data-scrolls'));
      expect(wrapper.className).toContain('overflow-x-auto');
      // Every glance column is drawn — none folded into the row's count.
      expect(screen.getAllByRole('columnheader').map((th) => th.textContent?.trim())).toEqual(GLANCE);
      // The header stays put: no sticky header inside a sideways scroller.
      for (const th of screen.getAllByRole('columnheader')) expect(th.className).not.toContain('top-0');
      // The status and the name travel together at the start.
      const cells = [...rowOf('alpha').querySelectorAll<HTMLElement>('td')];
      expect(cells[0]!.className).toContain('sticky');
      expect(cells[1]!.className).toContain('sticky');
      expect(cells[1]!.style.insetInlineStart).toBe('176px');
      expect(cells[2]!.className).not.toContain('sticky');
      // What the row folds is Everything's alone, counted.
      expect(within(rowOf('alpha')).getByRole('button', { name: /the rest of this row/ })).toHaveTextContent(
        /10 more columns/,
      );
    });
  });
});
