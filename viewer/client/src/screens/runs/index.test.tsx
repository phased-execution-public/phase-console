/**
 * The Runs home (7.0, quiet-console phase 7), mounted as the shell mounts it —
 * inside the router, over a client of the app's own config — against a
 * stubbed server (exit criterion 4).
 *
 * What is pinned: the home reads the SLIM run list and never the whole one
 * (#234) — every `/api/runs` request it makes carries a `view=`, in either
 * shape of the page — and its heading IS the situation sentence: on a console
 * with nothing live, "Nothing running right now".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import RunsHome from './index';

const NOW = '2026-10-09T00:00:00.000Z';

/** `/api/state`: a console that drives runs, with no license to speak of. */
const STATE = { autopilot: true, allowRun: true, license: undefined };

/** `GET /api/turn`, answered with nothing in it. */
const NO_TURN = {
  round: { at: NOW, n: 0, ranAt: null, changedAt: null },
  headline: 'Nothing needs you now.',
  groups: { now: [], decide: [], upcoming: [], checking: [], done: [] },
  handled: [],
  counts: { now: 0, decide: 0, upcoming: 0, checking: 0, done: 0, total: 0, handled: 0 },
  seen: null,
  issues: null,
};

/** What each route answers — the shapes `situation.test.tsx` seeds; anything else an empty object. */
const ANSWERS: [RegExp, unknown][] = [
  [/^\/api\/state(\?|$)/, STATE],
  [/^\/api\/runs(\?|$)/, []],
  [/^\/api\/queue(\?|$)/, { entries: [], advice: [] }],
  [/^\/api\/plans(\?|$)/, []],
  [/^\/api\/inbox(\?|$)/, { items: [], generatedAt: NOW }],
  [/^\/api\/turn(\?|$)/, NO_TURN],
  [/^\/api\/spend(\?|$)/, { today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] }],
  [/^\/api\/converge(\?|$)/, { automatic: true, everyMs: 0, pending: [], running: [], reports: [] }],
  [/^\/api\/approvals(\?|$)/, []],
  [/^\/api\/sessions(\?|$)/, []],
];

const answerFor = (url: string): unknown => ANSWERS.find(([route]) => route.test(url))?.[1] ?? {};

let sent: string[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      sent.push(path);
      return new Response(JSON.stringify(answerFor(path)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** The home at an address, inside the router and over a fresh client — nothing seeded, everything read. */
function mount(address = '#/runs') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <RunsHome route={parseHash(address) as Route} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const runReads = () => sent.filter((url) => url.includes('/api/runs'));

describe('the Runs home against the server (criterion 4)', () => {
  it('reads the slim run list and never the whole one, and heads itself with the situation', async () => {
    mount('#/runs');
    const page = await screen.findByTestId('runs-home');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nothing running right now'),
    );
    expect(page).toBeInTheDocument();

    // Every read of the runs is the slim projection (#234): never `/api/runs` bare.
    expect(runReads().length).toBeGreaterThan(0);
    for (const url of runReads()) expect(url, url).toMatch(/[?&]view=/);
    expect(sent).toContain('/api/runs?view=slim');
    expect(sent).not.toContain('/api/runs');
    // The home asked the server for the console's facts it heads itself with.
    expect(sent).toContain('/api/state');
  });

  it('reads the same slim list for the grid of every run', async () => {
    mount('#/runs?view=all');
    await screen.findByTestId('runs-home');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nothing running right now'),
    );
    expect(runReads().length).toBeGreaterThan(0);
    for (const url of runReads()) expect(url, url).toMatch(/[?&]view=/);
    expect(sent).not.toContain('/api/runs');
  });
});
