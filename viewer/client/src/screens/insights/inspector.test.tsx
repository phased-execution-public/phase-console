/**
 * A run's spend in the panel (quiet-console phase 27) — Insights' second door,
 * from "Each run against its budget".
 *
 * What is pinned:
 *
 * - **The way in is the line's own fold**: the row's expansion on a desk, the
 *   record's Details on a phone, each holding Inspect, which marks the line
 *   whose run is on show.
 * - **The record is the row, whole**: its plan, its id, what it spent against
 *   its budget, when the figures were read — and Raw, the row as the server
 *   sent it. Overview and Raw only.
 * - **The server's figures, never the browser's**: spent and budget side by
 *   side, never a difference, and the panel follows the one spend answer the
 *   page reads.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path; nothing but `/api/spend` is asked here, and that is already read. */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { SpendView } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { MemoryRouterProvider } from '@/shell/router';
import { insightsHref } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import { CostVsCapsPanel } from './cost-vs-caps';

vi.setConfig({ testTimeout: 20_000 });

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Below the shell breakpoint while `media.phone` is set. `lib/media` keeps
 * each query's list for the whole module, so `matches` is read live.
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

const quietDay = (day: string) => ({ day, settledUsd: 0, ladderUsd: 0, usd: 0 });

/** `/api/spend` as a 7.0 server sends it: every sum the server's. */
const SPEND: SpendView = {
  today: { settledUsd: 18.25, ladderUsd: 2.5, capUsd: 40, ladderLeftUsd: 37.5 },
  series: [quietDay('2026-10-10'), { day: '2026-10-11', settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 }],
  total: { settledUsd: 18.25, ladderUsd: 2.5, usd: 20.75 },
  runs: [
    { runId: 'run-0001aaaabbbbcccc', slug: 'demo', spentUsd: 61.5, budgetUsd: 100 },
    { runId: 'run-0002ddddeeeeffff', slug: 'quiet', spentUsd: 4, budgetUsd: null },
  ],
};

function mount(spend: SpendView = SPEND) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  // The page read the report before it drew the panel that shows it.
  client.setQueryData(keys.spend(), spend);
  server.reads['/api/spend'] = spend;
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={insightsHref()}>
        <TooltipProvider>
          <CostVsCapsPanel spend={spend} />
          <InspectorHost />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** The runs sit under a fold named for its rows, as a figure's numbers do: open it. */
function openTheRuns(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^The runs/ }));
  return screen.getByRole('table', { name: 'Each run against its budget' });
}

/** One fact of the Overview, by its label. */
function factOf(panel: HTMLElement, label: string): HTMLElement {
  const term = within(within(panel).getByTestId('run-spend-overview')).getByText(label, { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
}

beforeEach(() => {
  server.reads = {};
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  // A desk's box everywhere: the grid cuts its columns to the width it measures.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
});

afterEach(() => {
  media.phone = false;
  vi.restoreAllMocks();
});

describe('a run’s spend, from its line to the panel', () => {
  it('opens a line in place onto its id and Inspect, and puts the run’s spend in the panel', async () => {
    mount();
    const table = openTheRuns();
    const demo = within(table).getByRole('row', { name: /demo/ });
    fireEvent.click(within(demo).getByRole('button', { name: /^Show the rest of this row/ }));
    const detail = await screen.findByTestId('run-spend-detail');
    // The id waits in the fold beside the way into the panel.
    expect(detail.closest('td')).toHaveTextContent('run-0001aaaa');
    const inspect = within(detail).getByRole('button', { name: 'Inspect' });
    expect(inspect).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(inspect);

    const panel = await screen.findByRole('region', { name: 'demo' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'demo' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('Run run-0001aaaa');
    expect(factOf(panel, 'Plan')).toHaveTextContent('demo');
    expect(
      within(factOf(panel, 'Run')).getByRole('button', { name: 'run-0001aaaabbbbcccc' }),
    ).toBeInTheDocument();
    expect(factOf(panel, 'Spent')).toHaveTextContent('$61.50');
    expect(factOf(panel, 'Budget')).toHaveTextContent('$100.00');
    expect(factOf(panel, 'Read').querySelector('time')?.getAttribute('datetime')).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    // The report keeps no history of a run, and its acts are the run's page's.
    expect(
      within(panel)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Overview', 'Raw']);
    // The line whose run is on show says so.
    expect(inspect).toHaveAttribute('aria-pressed', 'true');

    const raw = within(panel).getByRole('tab', { name: 'Raw' });
    fireEvent.mouseDown(raw, { button: 0 });
    fireEvent.click(raw);
    expect(JSON.parse(within(panel).getByRole('tabpanel').textContent ?? '')).toEqual(SPEND.runs[0]);
  });

  it('says a run with no budget has none, and paints nothing as over', async () => {
    mount();
    const table = openTheRuns();
    fireEvent.click(
      within(within(table).getByRole('row', { name: /quiet/ })).getByRole('button', {
        name: /^Show the rest of this row/,
      }),
    );
    fireEvent.click(
      within(await screen.findByTestId('run-spend-detail')).getByRole('button', { name: 'Inspect' }),
    );
    const panel = await screen.findByRole('region', { name: 'quiet' });
    expect(factOf(panel, 'Budget')).toHaveTextContent('None set');
    expect(factOf(panel, 'Spent')).toHaveTextContent('$4.00');
    expect(factOf(panel, 'Spent').querySelector('.text-failed')).toBeNull();
  });

  it('paints a run over its budget the way its line does — the kit’s rule, not a sum of its own', async () => {
    const over: SpendView = {
      ...SPEND,
      runs: [{ runId: 'run-0003', slug: 'heavy', spentUsd: 130, budgetUsd: 100 }],
    };
    mount(over);
    const table = openTheRuns();
    fireEvent.click(within(table).getByRole('button', { name: /^Show the rest of this row/ }));
    fireEvent.click(
      within(await screen.findByTestId('run-spend-detail')).getByRole('button', { name: 'Inspect' }),
    );
    const panel = await screen.findByRole('region', { name: 'heavy' });
    const spent = factOf(panel, 'Spent').firstElementChild as HTMLElement;
    expect(spent).toHaveTextContent('$130.00');
    expect(spent).toHaveClass('text-failed');
    expect(spent).toHaveAttribute('title', '$130.00 of a $100.00 budget — over');
    // Both figures, never their difference.
    expect(panel).not.toHaveTextContent('$30.00');
  });

  it('follows the one spend answer the page reads: a run that spends moves in the panel', async () => {
    const { client } = mount();
    const table = openTheRuns();
    fireEvent.click(
      within(within(table).getByRole('row', { name: /demo/ })).getByRole('button', {
        name: /^Show the rest of this row/,
      }),
    );
    fireEvent.click(
      within(await screen.findByTestId('run-spend-detail')).getByRole('button', { name: 'Inspect' }),
    );
    const panel = await screen.findByRole('region', { name: 'demo' });
    expect(factOf(panel, 'Spent')).toHaveTextContent('$61.50');

    act(() => {
      client.setQueryData(keys.spend(), {
        ...SPEND,
        runs: [{ ...SPEND.runs[0]!, spentUsd: 72.25 }, SPEND.runs[1]!],
      });
    });
    await waitFor(() => expect(factOf(panel, 'Spent')).toHaveTextContent('$72.25'));

    // A run the report stops carrying keeps the figures it was inspected with, and says so.
    act(() => {
      client.setQueryData(keys.spend(), { ...SPEND, runs: [SPEND.runs[1]!] });
    });
    await waitFor(() => expect(panel).toHaveTextContent('no longer carries this run'));
    expect(factOf(panel, 'Spent')).toHaveTextContent('$61.50');
    expect(within(within(panel).getByTestId('run-spend-overview')).queryByText('Read')).toBeNull();
  });

  it('on a phone, keeps Inspect in the record’s own Details fold', async () => {
    media.phone = true;
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^The runs/ }));
    const fold = screen.getAllByRole('button', { name: /^Details\b/ })[0]!;
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    const region = document.getElementById(fold.getAttribute('aria-controls') ?? '')!;
    expect(region).toBeTruthy();
    const inspect = within(region).getByRole('button', { name: 'Inspect' });
    fireEvent.click(inspect);
    expect(await screen.findByRole('region', { name: 'demo' })).toBeInTheDocument();
    expect(inspect).toHaveAttribute('aria-pressed', 'true');
  });
});

/* ---------------- the source ---------------- */

/** Comments stripped: a header that explains the rule is not a breach of it. */
const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('no figure is made in the browser', () => {
  it('neither the panel’s record nor the line it comes from sums, subtracts or scales a dollar', () => {
    for (const file of ['inspector.tsx', 'cost-vs-caps.tsx']) {
      const code = decommented(readFileSync(join(HERE, file), 'utf8'));
      // The read saw the module, so an empty string cannot pass for a clean one.
      expect(code, file).toMatch(/export function/);
      expect(code, file).not.toContain('.reduce(');
      expect(code, file).not.toMatch(
        /(?:spentUsd|budgetUsd|Usd)\s*[-+*/](?!=)|[-+*/]\s*[\w.!?]*(?:spentUsd|budgetUsd)\b/,
      );
    }
  });
});
