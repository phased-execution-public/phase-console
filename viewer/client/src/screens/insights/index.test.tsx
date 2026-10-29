/**
 * Insights, the page (quiet-console phase 19): the questions in their one
 * order, two of them asked only of one plan; a question that keeps its place
 * while its answer is read; a portfolio that could not be read saying why,
 * with a way to ask again; the lead; and the scope — one combobox, on the
 * desk's bar, and in the View sheet on a phone.
 *
 * Mounted as the router mounts it, with the server answering by path, so what
 * is asserted is what the page does with real answers — the panels' own facts
 * are their tests' (`insights.datums.test.tsx`, `model.test.ts`).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); a function answers each ask itself. */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { ConsoleState, LedgerSummary, PlanDetail, PlanSummary, Portfolio, SpendView } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { relativeTime } from '@/lib/format';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { insightsHref, parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import Insights from './index';
import { sizingAnswer, weekAnswer } from './test-answers';

/**
 * Below the shell breakpoint while `media.phone` is set. `lib/media` caches
 * each query's list the first time it is asked, for the whole module, so the
 * list's `matches` is read live rather than fixed when the list is made.
 */
const media = { phone: false };
window.matchMedia = (query: string) =>
  ({
    media: query,
    get matches() {
      return media.phone && /max-width: 899px/.test(query);
    },
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

/* ---------------- the server's answers ---------------- */

/** `/api/stats`, read five minutes ago. */
const portfolio = (): Portfolio => ({
  generatedAt: Date.now() - 5 * 60_000,
  totals: {
    plans: 4,
    documents: 0,
    orphans: 0,
    closed: 1,
    open: 3,
    phases: 20,
    done: 12,
    ready: 2,
    waiting: 4,
    inProgress: 1,
    stuck: 1,
    percent: 60,
    remainingWeight: 320_000,
    remainingSessions: 3,
  },
  byStatus: [
    { status: 'active', count: 3, closed: false },
    { status: 'complete', count: 1, closed: true },
  ],
  activeLocks: [],
  issues: [],
  velocity: [
    { week: '2026-W40', count: 2 },
    { week: '2026-W41', count: 3 },
  ],
  calendar: [{ date: '2026-10-09', count: 1 }],
  medianCycleDays: 1,
  sizeMix: [
    { size: 'S', count: 5 },
    { size: 'M', count: 9 },
  ],
  repos: [{ repo: 'phased-execution', count: 12 }],
  skills: [{ skill: 'phased-execution', count: 4 }],
  models: [{ model: 'opus', count: 3 }],
  stalled: [],
  busiest: [{ slug: 'demo', completions: 7 }],
  rate: {
    ratePerWeight: 61,
    floorMs: 600_000,
    slopeMsPerWeight: 45,
    basis: 'portfolio',
    samples: 12,
    spread: 0.6,
    missing: 0,
    clock: 'working',
    mediumMs: 2_700_000,
  },
});

const STATE = {
  allowWrites: false,
  approvals: { raised: 2, autoGranted: 5, since: '2026-09-01T00:00:00Z', lastRaisedAt: null, pending: 0 },
  sizing: { S: 15_000, M: 40_000, L: 90_000 },
} as unknown as ConsoleState;

const SPEND: SpendView = {
  today: { settledUsd: 18.25, ladderUsd: 2.5, capUsd: 40, ladderLeftUsd: 37.5 },
  runs: [{ runId: 'r1', slug: 'demo', spentUsd: 61.5, budgetUsd: 100 }],
  series: [
    { day: '2026-10-09', settledUsd: 0, ladderUsd: 0, usd: 0 },
    { day: '2026-10-10', settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 },
  ],
  total: { settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 },
};

/** The plan list, in the server's order: two open plans, then a closed one. */
const PLANS: PlanSummary[] = [
  { slug: 'demo', title: 'The demo plan', phases: 5, ready: [3], status: 'active' },
  { slug: 'quiet', title: 'A quiet plan', phases: 3, ready: [], status: 'active' },
  { slug: 'old', title: 'An old plan', phases: 4, ready: [], status: 'complete', closed: true },
];

/** `demo`, read whole: its summary, estimate, cost and QA record. */
const DETAIL = {
  summary: {
    slug: 'demo',
    title: 'The demo plan',
    ready: [3],
    inProgress: [],
    minimumSessions: 2,
    remainingSessions: 4,
  },
  eta: {
    plan: {
      ratePerWeight: 61,
      floorMs: 600_000,
      slopeMsPerWeight: 45,
      samples: 6,
      missing: 0,
      basis: 'plan',
      remainingWeight: 120_000,
      remainingPhases: 2,
      lowMs: 3_600_000,
      highMs: 7_200_000,
      clock: 'working',
      label: '≈ 1h–2h of work left',
    },
    perPhase: [],
  },
  cost: {
    slug: 'demo',
    totalUsd: 61.5,
    attributedUsd: 61.5,
    residualUsd: 0,
    ladderUsd: 12,
    partialPhases: [],
    phases: [
      {
        phase: 1,
        usd: 61.5,
        attempts: 2,
        partial: false,
        durationMs: 3_600_000,
        model: 'claude-opus-5',
        runs: 1,
      },
    ],
    byModel: [],
    byDay: [],
    byDayTruncated: false,
    runs: [{ runId: 'run-1', spentUsd: 61.5, budgetUsd: 100, status: 'done' }],
  },
  forecast: null,
  qa: [{ phase: 1, result: 'pass' }],
} as unknown as PlanDetail;

const LEDGER: LedgerSummary = {
  plans: [{ key: 'demo', runs: 2, sessions: 5, costUsd: 61.5, unknownCost: 0, turns: 80, ms: 3_600_000 }],
  accounts: [
    { key: 'default', runs: 2, sessions: 5, costUsd: 61.5, unknownCost: 0, turns: 80, ms: 3_600_000 },
  ],
  truncatedRuns: 0,
  unknownSessions: 0,
};

/* ---------------- the page ---------------- */

/** The questions every plan answers, in the page's order. */
const UNSCOPED = [
  'How long is left',
  'What it costs',
  'What each session cost',
  'What a session may spend',
  'How fast',
  'This week',
  'Who was asked',
  'What shape the work is in',
  'On what',
];

/** Every question, a plan’s own two after what each session cost. */
const SCOPED = [...UNSCOPED.slice(0, 3), 'What this plan cost', 'This plan’s record', ...UNSCOPED.slice(3)];

/** Each question's id (`data-insight`), in the same order. */
const IDS = [
  'eta',
  'cost',
  'ledger',
  'plan-cost',
  'plan-record',
  'sizing',
  'velocity',
  'week',
  'approvals',
  'shape',
  'mix',
];

/** Insights at its address, as the router hands it its route. */
function mount(plan?: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const address = insightsHref(plan);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <Insights route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const questions = () =>
  within(screen.getByTestId('insights-questions'))
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);

const section = (id: string) => document.querySelector<HTMLElement>(`section[data-insight="${id}"]`)!;

/** The line under the page's title. */
const lead = () =>
  screen.getByRole('heading', { level: 1, name: 'Insights' }).nextElementSibling?.textContent;

/** An option's words: its label, then its hint when it has one. */
const optionWords = (option: HTMLElement) =>
  [...option.querySelectorAll('span')].map((span) => span.textContent);

const scopeBox = () => screen.getByRole('combobox', { name: 'Scope the page to a plan' });

let stats: Portfolio;

beforeEach(() => {
  media.phone = false;
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  window.location.hash = '';
  stats = portfolio();
  server.reads = {
    '/api/stats': stats,
    '/api/state': STATE,
    '/api/spend': SPEND,
    '/api/plans': PLANS,
    '/api/plans/demo': DETAIL,
    '/api/ledger': LEDGER,
    '/api/sizing': sizingAnswer(),
    '/api/report': weekAnswer(),
  };
});

describe('the questions', () => {
  it('unscoped: the questions every plan answers, in their order, and neither of one plan’s', async () => {
    mount();
    expect(questions()).toEqual(UNSCOPED);
    expect(
      [...document.querySelectorAll('[data-insight]')].map((el) => el.getAttribute('data-insight')),
    ).toEqual(IDS.filter((id) => !id.startsWith('plan-')));
    expect(screen.queryByRole('heading', { name: 'What this plan cost' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'This plan’s record' })).toBeNull();
    // Each question is a region named by itself.
    for (const title of UNSCOPED) expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    // Nothing is narrowed, so nothing says so.
    expect(screen.queryByRole('link', { name: 'Show every plan' })).toBeNull();
    await screen.findByTestId('insights-mix');
  });

  it('scoped: every question — the plan’s cost and record after what each session cost — and the note names the plan', async () => {
    mount('demo');
    expect(questions()).toEqual(SCOPED);
    expect(
      [...document.querySelectorAll('[data-insight]')].map((el) => el.getAttribute('data-insight')),
    ).toEqual(IDS);
    const toolbar = document.querySelector<HTMLElement>('[data-toolbar]')!;
    expect(toolbar).toHaveTextContent(
      'The estimate, the runs, the cost and the record are demo’s; the rest is every plan’s.',
    );
    expect(within(toolbar).getByRole('link', { name: 'Show every plan' })).toHaveAttribute(
      'href',
      '#/insights',
    );
    // The plan's own two answer from the plan's own read.
    expect(await screen.findByTestId('insights-plan-cost')).toBeInTheDocument();
    expect(await screen.findByTestId('insights-plan-record')).toBeInTheDocument();
  });
});


describe('a question keeps its place while it is read', () => {
  it('one whose answer has not arrived holds an aria-busy placeholder; the others answer', async () => {
    server.reads['/api/spend'] = () => new Promise(() => {});
    mount();
    for (const id of ['eta', 'ledger', 'sizing', 'velocity', 'approvals', 'shape', 'mix']) {
      expect(await within(section(id)).findByTestId(`insights-${id}`)).toBeInTheDocument();
      expect(section(id).querySelector('[aria-busy]'), id).toBeNull();
    }
    expect(section('cost').querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByTestId('insights-cost')).toBeNull();
  });

  it('the session caps and the week hold their places too, each at its own read', async () => {
    server.reads['/api/sizing'] = () => new Promise(() => {});
    server.reads['/api/report'] = () => new Promise(() => {});
    mount();
    expect(await within(section('mix')).findByTestId('insights-mix')).toBeInTheDocument();
    expect(section('sizing').querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByTestId('insights-sizing')).toBeNull();
    // The week reads its own answer: its window and replay are drawn, and the answer under them is held.
    const week = section('week');
    expect(within(week).getByRole('combobox', { name: 'The week to report on' })).toBeInTheDocument();
    expect(week.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('once every read has answered, no question is busy', async () => {
    mount('demo');
    for (const id of IDS)
      expect(await within(section(id)).findByTestId(`insights-${id}`)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('insights-questions').querySelectorAll('[aria-busy]')).toHaveLength(0),
    );
  });
});

describe('when the portfolio cannot be read', () => {
  it('says so in the error’s own words, and Try again asks again', async () => {
    let asks = 0;
    server.reads['/api/stats'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the engine timed out after 30 s', 503, '/api/stats');
      return stats;
    };
    mount();
    expect(
      await screen.findByText('The portfolio could not be read: the engine timed out after 30 s'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('insights-questions')).toBeNull();
    expect(asks).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(asks).toBe(2));
    expect(await screen.findByTestId('insights-questions')).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});

describe('the lead', () => {
  it('unscoped: across how many plans, and as of when', async () => {
    mount();
    await waitFor(() => expect(lead()).toBe(`Across 4 plans, as of ${relativeTime(stats.generatedAt)}.`));
  });

  it('scoped: the plan, one of how many, and as of when', async () => {
    mount('demo');
    await waitFor(() =>
      expect(lead()).toBe(`demo, one of 4 plans, as of ${relativeTime(stats.generatedAt)}.`),
    );
  });
});

describe('the scope', () => {
  it('is one combobox on the bar: Every plan first, then each plan, a closed one said so', async () => {
    mount();
    expect(scopeBox()).toHaveTextContent('Every plan');
    fireEvent.click(scopeBox());
    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(4));
    expect(within(list).getAllByRole('option').map(optionWords)).toEqual([
      ['Every plan'],
      ['demo'],
      ['quiet'],
      ['old', 'closed'],
    ]);
  });

  it('choosing a plan moves the address to that plan', async () => {
    mount();
    fireEvent.click(scopeBox());
    const list = await screen.findByRole('listbox');
    fireEvent.click(await within(list).findByText('quiet'));
    expect(window.location.hash).toBe('#/insights?plan=quiet');
  });

  it('scoped, it names the plan, and Every plan moves the address back', async () => {
    mount('demo');
    expect(scopeBox()).toHaveTextContent('demo');
    fireEvent.click(scopeBox());
    fireEvent.click(within(await screen.findByRole('listbox')).getByText('Every plan'));
    expect(window.location.hash).toBe('#/insights');
  });
});

describe('on a phone', () => {
  beforeEach(() => {
    media.phone = true;
  });
  afterEach(() => {
    media.phone = false;
  });

  it('the scope sits in the View sheet, under its word, and not on the bar', async () => {
    mount('demo');
    expect(screen.queryByRole('combobox', { name: 'Scope the page to a plan' })).toBeNull();
    // The sheet's button counts the scope as a setting in force.
    fireEvent.click(screen.getByRole('button', { name: 'View, 1 in use' }));
    const sheet = await screen.findByRole('dialog', { name: 'View' });
    const slot = within(sheet).getByRole('region', { name: 'Plan' });
    const scope = within(slot).getByRole('combobox', { name: 'Scope the page to a plan' });
    expect(scope).toHaveTextContent('demo');
    // And it is the same control there: a pick moves the address.
    fireEvent.click(scope);
    fireEvent.click(await within(await screen.findByRole('listbox')).findByText('quiet'));
    expect(window.location.hash).toBe('#/insights?plan=quiet');
  });
});
