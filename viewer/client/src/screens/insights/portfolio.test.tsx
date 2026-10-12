/**
 * Insights, and what shape the work is in — the portfolio panel.
 *
 * Its job is "which of these should I look at next", so the properties worth
 * asserting are the ones that make it answerable: the health filter actually
 * filters, an issue points at the phase it is about rather than only the plan,
 * an empty filter says *which* filter is empty rather than implying the
 * portfolio is clean, and every status is the status model's word, so a phase
 * state or a severity reads here as it does everywhere else.
 *
 * Mounted through the destination (`./index`) rather than the panel alone,
 * because the panel's inputs — the portfolio, the closed-plan set, whether
 * writes are allowed, the console's own sizing — are exactly what the
 * destination assembles, and a test that hand-built them would pass while the
 * real page passed the wrong ones. The server answers by path through
 * `@/data/http`, the one door every hook under `data/` reads and writes through.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`), and every write it was sent. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  posts: [] as { path: string; body: unknown }[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return {
    ...actual,
    request: (path: string) => answer(path),
    post: (path: string, body?: unknown) => {
      server.posts.push({ path, body });
      return answer(path);
    },
  };
});

import { BOARD_ORDER } from '@shared/phase-model.js';
import { describeWord } from '@shared/status-model.js';
import type { Portfolio } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import InsightsView from './index';

vi.setConfig({ testTimeout: 20_000 });

const PORTFOLIO: Portfolio = {
  generatedAt: Date.parse('2026-08-03T12:00:00Z'),
  totals: {
    plans: 4,
    documents: 1,
    orphans: 0,
    closed: 1,
    open: 3,
    phases: 30,
    done: 21,
    ready: 3,
    waiting: 5,
    inProgress: 1,
    stuck: 0,
    percent: 70,
    remainingWeight: 310_000,
    remainingSessions: 2,
  },
  byStatus: [
    { status: 'active', count: 3, closed: false },
    { status: 'complete', count: 1, closed: true },
  ],
  activeLocks: [
    {
      slug: 'demo',
      phase: 5,
      owner: 'claude-a/p5',
      expired: false,
      leaseUntil: Date.now() + 900_000,
      closed: false,
    },
    // A lapsed lease on a CLOSED plan: debris, not a chore. `phase-lock.sh
    // conflicts` skips it, so it blocks nobody and must not be counted as an
    // expired lease needing release.
    { slug: 'shelved', phase: 2, owner: 'claude-b/p2', expired: true, closed: true },
  ],
  issues: [
    { slug: 'demo', severity: 'warning', kind: 'handoff-drift', message: 'INDEX disagrees', phase: 2 },
    { slug: 'other', severity: 'error', kind: 'cycle', message: 'phase 3 depends on itself' },
    { slug: 'demo', severity: 'info', kind: 'note', message: 'no QA recorded' },
  ],
  velocity: [
    { week: '2026-W30', count: 2 },
    { week: '2026-W31', count: 4 },
  ],
  calendar: [{ date: '2026-08-01', count: 2 }],
  medianCycleDays: 0,
  sizeMix: [
    { size: 'S', count: 4 },
    { size: 'M', count: 18 },
    { size: 'L', count: 8 },
  ],
  repos: [{ repo: 'skill', count: 8 }],
  skills: [],
  models: [{ model: 'claude-opus-5', count: 4 }],
  stalled: [{ slug: 'other', days: 12, ready: [2, 3] }],
  busiest: [{ slug: 'demo', completions: 12 }],
};

/** A lapsed lease on an OPEN plan: the one kind of claim that is a chore. */
const LAPSED = { slug: 'demo', phase: 7, owner: 'claude-c/p7', expired: true, closed: false };

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  recentRoots: [],
  unread: 0,
};

function mount(address = '#/insights') {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <InsightsView route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** A claim's row in the locks grid, by the link its identity cell is. */
const lockRow = async (name: string) =>
  (await screen.findByRole('link', { name })).closest('tr') as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  // A 400 px box, as the Repo ledger stubs it: the grid cuts its columns to
  // the width it measures, and a claim, its state and its release stay on the row.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  server.posts = [];
  server.reads = {
    '/api/stats': PORTFOLIO,
    // The destination also asks for money, the ledgers and the console's own
    // state. They are their own panels; here they only have to answer.
    '/api/spend': { today: { settledUsd: 0, ladderUsd: 0, capUsd: null }, runs: [], series: [] },
    '/api/ledger': { plans: [], accounts: [], truncatedRuns: 0, unknownSessions: 0 },
    '/api/state': STATE,
    // `plans` as well as `stats`: the page joins closure on from the plan list,
    // because the search-independent `HealthIssue` carries no status of its own.
    '/api/plans': [
      { slug: 'demo', kind: 'plan', phases: 8, ready: [2], status: 'active', closed: false },
      { slug: 'other', kind: 'plan', phases: 6, ready: [2, 3], status: 'active', closed: false },
      { slug: 'shelved', kind: 'plan', phases: 4, ready: [], status: 'abandoned', closed: true },
    ],
  };
});

afterEach(() => vi.restoreAllMocks());

describe('insights', () => {
  it('counts issues by severity in the filter labels, every severity shown at first', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Errors 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Warnings 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Info 1' })).toBeTruthy();
  });

  it('sorts issues worst-first, whatever order the server sent them, each severity a dot and its word', async () => {
    mount();
    const list = await screen.findByTestId('insights-health');
    const kinds = within(list)
      .getAllByText(/^(cycle|handoff-drift|note)$/)
      .map((el) => el.textContent);
    expect(kinds).toEqual(['cycle', 'handoff-drift', 'note']);
    const severities = [...list.querySelectorAll('[data-vocab="health"]')];
    expect(severities.map((el) => el.getAttribute('data-status'))).toEqual(['error', 'warning', 'info']);
    for (const el of severities) {
      expect(el.querySelector('[data-dot]')).toBeTruthy();
      expect(el.textContent?.trim()).toBe(describeWord('health', el.getAttribute('data-status')).label);
    }
  });

  it('filters to one severity, and says which filter is pressed', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Errors 1' }));
    expect(screen.getByRole('button', { name: 'Errors 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('phase 3 depends on itself')).toBeTruthy();
    expect(screen.queryByText('INDEX disagrees')).toBeNull();
  });

  it('says which filter is empty, never that the portfolio is clean', async () => {
    // What matters is that an empty *filter* never reads as an empty portfolio.
    server.reads['/api/stats'] = {
      ...PORTFOLIO,
      issues: PORTFOLIO.issues.filter((i) => i.severity !== 'info'),
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Info 0' }));
    expect(screen.getByText('No info-level issues; other severities may still have some.')).toBeTruthy();
    expect(screen.queryByText(/plans, handoffs, indexes and locks all agree/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show every issue' }));
    expect(screen.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('INDEX disagrees')).toBeTruthy();
  });

  it('links an issue at its phase when it names one, and at the plan when it does not', async () => {
    mount();
    const list = await screen.findByTestId('insights-health');
    const hrefs = within(list)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('#/plan/demo/phase/2');
    expect(hrefs).toContain('#/plan/other/phases');
  });

  it('links a held lock at the phase it holds', async () => {
    mount();
    const link = await screen.findByRole('link', { name: 'demo P5' });
    expect(link.getAttribute('href')).toBe('#/plan/demo/phase/5');
  });

  it('shows stalled plans with how long they have been idle', async () => {
    mount();
    expect(await screen.findByText('P2, P3 ready, idle 12 days')).toBeTruthy();
  });

  /* ---------------- closure ---------------- */

  // `phase-lock.sh conflicts` skips a closed plan's locks outright, so a lapsed
  // lease on one blocks nobody. Counting it would put a Release-all button in
  // front of the operator for a chore that does not exist.
  it('calls a lapsed lock on a closed plan debris, and does not count it as expired', async () => {
    // Beside it, one lapsed lease on an open plan: counted with the debris, the
    // two would raise "Release all 2 lapsed". One alone raises nothing.
    server.reads['/api/stats'] = { ...PORTFOLIO, activeLocks: [...PORTFOLIO.activeLocks, LAPSED] };
    mount();
    const debris = await lockRow('shelved P2');
    expect(within(debris).getByText('debris')).toBeTruthy();
    expect(within(debris).queryByText('expired')).toBeNull();
    expect(within(await lockRow('demo P7')).getByText('expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Release all/ })).toBeNull();
    // Still listed and still releasable — this is the lock inventory — and,
    // with writes off, every release says why it cannot be pressed.
    const releases = screen.getAllByRole('button', { name: 'Release' });
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release).toBeDisabled();
      expect(release.getAttribute('title')).toMatch(/--allow-writes/);
    }
  });

  it('releases a lapsed claim through the one release door once writes are allowed', async () => {
    server.reads['/api/state'] = { ...STATE, allowWrites: true };
    server.reads['/api/stats'] = { ...PORTFOLIO, activeLocks: [...PORTFOLIO.activeLocks, LAPSED] };
    server.reads['/api/locks/release'] = { slug: 'demo', phase: 7, ok: true, owner: 'claude-c/p7' };
    mount();
    const row = await lockRow('demo P7');
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Release' })).toBeEnabled());
    fireEvent.click(within(row).getByRole('button', { name: 'Release' }));
    // The owner is the server's to read off the lock file: the release names
    // the claim and nothing else.
    await waitFor(() =>
      expect(server.posts).toContainEqual({ path: '/api/locks/release', body: { slug: 'demo', phase: 7 } }),
    );
  });

  // The row is MARKED but not otherwise special-cased. The absence of a repair
  // button is the SERVER's doing — `healthIssues()` demotes a closed plan's
  // issues to `info` and `classifyIssue()` offers a repair only for
  // error/warning — so this asserts the two layers meet, not that the client
  // added a redundant second gate. (It had one for a while; the severity had
  // already handled it, and the test only passed because of that.)
  it('marks a closed plan’s issue row, and its demoted severity is what withholds the repair', async () => {
    server.reads['/api/stats'] = {
      ...PORTFOLIO,
      issues: [
        { slug: 'shelved', severity: 'info', kind: 'orphan', message: 'phase 9 is unreachable' },
        { slug: 'demo', severity: 'error', kind: 'engine', message: 'will not parse' },
      ],
    };
    mount();
    await screen.findByText('phase 9 is unreachable');
    // Marked, because a bare row in this list reads as live work.
    expect(screen.getByText('closed plan')).toBeTruthy();
    // One offer, and it belongs to the open plan.
    const repairs = within(screen.getByTestId('insights-health')).getAllByRole('button', {
      name: /Repair|Fix/,
    });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.closest('li')).toBe(screen.getByText('will not parse').closest('li'));
    // The proof it is severity doing the work: give the SAME closed plan an
    // error-severity row and the button comes back. If a future change stops
    // demoting, this line turns red and says which layer moved.
    server.reads['/api/stats'] = {
      ...PORTFOLIO,
      issues: [{ slug: 'shelved', severity: 'error', kind: 'engine', message: 'will not parse' }],
    };
    cleanup();
    mount();
    await screen.findByText('will not parse');
    expect(
      within(screen.getByTestId('insights-health')).getAllByRole('button', { name: /Repair|Fix/ }),
    ).toHaveLength(1);
  });

  it('says how much of the portfolio is still open, as the server counted it', async () => {
    mount();
    expect(await screen.findByText('3 open, 1 closed')).toBeTruthy();
  });

  it('never subtracts to say what is open when an older server did not', async () => {
    server.reads['/api/stats'] = { ...PORTFOLIO, totals: { ...PORTFOLIO.totals, open: undefined } };
    mount();
    expect(await screen.findByText('1 closed')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/3 open/);
  });

  it('says “the same day” rather than “0d” for a zero median gap, as How fast’s answer', async () => {
    mount();
    expect(
      await screen.findByText('At the median, a phase lands the same day as the one before it.'),
    ).toBeTruthy();
    expect(document.querySelector('[data-insight="velocity"]')?.textContent).not.toMatch(/\b0d\b|\b0 days\b/);
    // 6.2 put the gap among the ETA's tiles; 7.0 says it once, under How fast.
    expect(document.querySelector('[data-insight="eta"]')?.textContent).not.toMatch(/median/i);
  });

  it('says nothing is flagged when the portfolio is clean', async () => {
    server.reads['/api/stats'] = { ...PORTFOLIO, issues: [] };
    mount();
    expect(
      await screen.findByText('Nothing flagged: plans, handoffs, indexes and locks all agree.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse the plans' })).toHaveAttribute('href', '#/plans');
  });

  it('surfaces a failure as an error rather than an endless skeleton', async () => {
    server.reads['/api/stats'] = () => {
      throw new Error('the engine is not there');
    };
    mount();
    // The shared client config retries once before giving up, so the error is
    // two round trips away — past the 1s default of `findBy`.
    expect(
      await screen.findByText('The portfolio could not be read: the engine is not there', undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
  });

  /* ---------------- the figures ---------------- */

  it('draws the phase states in the board’s own words and paints, so a stuck phase reads as on its plan', async () => {
    mount();
    const shape = await screen.findByTestId('insights-shape');
    const stack = shape.querySelector('[data-figure="StackBar"]')!;
    const segments = [...stack.querySelectorAll('[data-datum]')];
    expect(segments.map((el) => el.getAttribute('data-datum'))).toEqual(
      BOARD_ORDER.map((word) => describeWord('board', word).label),
    );
    const counts: Readonly<Record<(typeof BOARD_ORDER)[number], number>> = {
      'in-progress': 1,
      ready: 3,
      stuck: 0,
      waiting: 5,
      done: 21,
    };
    BOARD_ORDER.forEach((word, i) => {
      expect(segments[i]!.getAttribute('data-value')).toBe(String(counts[word]));
      expect(segments[i]!.classList).toContain(`state-${describeWord('board', word).paint}`);
    });
  });

  it('draws the phase sizes in one hue, from the console’s own sizing, with the numbers a fold away', async () => {
    mount();
    const shape = await screen.findByTestId('insights-shape');
    expect(
      await within(shape).findByText(
        'S 15K, M 40K and L 90K of working-set weight, from the skill’s sizing.env.',
      ),
    ).toBeTruthy();
    // A size is not a status: one paint for every bar, the length the only encoding.
    const sizes = within(shape).getByRole('heading', { name: 'Phase sizes' }).parentElement!;
    const bars = [...sizes.querySelectorAll('[data-datum]')];
    expect(bars.map((el) => el.getAttribute('data-datum'))).toEqual(['S', 'M', 'L']);
    const paints = new Set(
      bars.flatMap((bar) =>
        [...bar.querySelectorAll('[class*="state-"]')].flatMap((el) =>
          [...el.classList].filter((name) => name.startsWith('state-')),
        ),
      ),
    );
    expect(paints.size).toBe(1);
    fireEvent.click(within(sizes).getByRole('button', { name: /^The phase sizes, in full/ }));
    const table = within(sizes).getByRole('table');
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['S413%', 'M1860%', 'L827%']);
  });
});

// 6.2's `recentRate` tests are gone with `recentRate`: the rate per M phase is
// the server's `rate.mediumMs` since 7.0, printed by the ETA panel (eta.test.tsx).
