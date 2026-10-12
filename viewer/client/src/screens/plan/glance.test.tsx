/**
 * The plan's glance (7.0, quiet-console phase 10) — the top of every view of
 * `#/plan/:slug`: which plan, what it is doing, how far along its line, what is
 * left and what it cost, and ONE act.
 *
 * What is pinned: the title is the page's heading, beside its mark (the plan's
 * status, painted by the plan vocabulary — the 6.2 header's badge, now a dot
 * and a word) and its slug; the line is the plans list's own, labelled
 * stations; the left sentence says sessions, the estimate and the spend. The
 * act is the Runs home's: a placed run draws `RowActionButton` with the action
 * `rowModel` decides, so the plan page and the home can never offer different
 * moves for one run (#278); with no run, a console that may run offers the
 * first ready phase, and a read-only console — or a closed plan — offers none.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDetail } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';
import { PlanGlance } from './glance';

const NOW = Date.now();

const SUMMARY = {
  slug: 'demo',
  title: 'demo plan',
  kind: 'plan',
  status: 'active',
  created: '2026-08-01',
  activity: NOW - 3_600_000,
  phases: 3,
  done: 1,
  ready: [2],
  waiting: 1,
  inProgress: [],
  stuck: [],
  percent: 33,
  remainingWeight: 130_000,
  remainingSessions: 1,
  criticalPath: [2, 3],
  criticalWeight: 130_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [],
  mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['skill'],
  handoffCount: 1,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: true,
};

const detail = (summary: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({
    summary: { ...SUMMARY, ...summary },
    plan: { slug: 'demo', title: 'demo plan', sessionBudget: { skills: [] } },
    phases: [
      { phase: 1, title: 'Foundations', state: 'done', size: 'M', weight: 40_000, gated: false, bullets: [] },
      { phase: 2, title: 'Surface', state: 'ready', size: 'L', weight: 90_000, gated: false, bullets: [] },
      { phase: 3, title: 'Cutover', state: 'waiting', size: 'S', weight: 15_000, gated: false, bullets: [] },
    ],
    ...over,
  }) as unknown as PlanDetail;

/** A slim run of the plan, live on phase 2 — what the home's fold places in Running. */
const RUNNING = {
  id: 'r1',
  slug: 'demo',
  status: 'running',
  activePhase: 2,
  halt: null,
  children: { 2: { pid: 9, phase: 2, sessionId: 's2', startedAt: new Date(NOW - 60_000).toISOString() } },
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
};

let runs: unknown[] = [];
let sent: string[] = [];

const answerFor = (path: string): unknown => {
  if (/^\/api\/runs\?view=slim$/.test(path)) return runs;
  if (/^\/api\/plans(\?|$)/.test(path)) return [SUMMARY];
  if (/^\/api\/inbox(\?|$)/.test(path)) return { items: [], generatedAt: new Date(NOW).toISOString() };
  if (/^\/api\/queue$/.test(path)) return { entries: [], at: NOW };
  return {};
};

beforeEach(() => {
  runs = [];
  sent = [];
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

function mount(view: PlanDetail, state: Record<string, unknown> = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), { autopilot: true, allowRun: true, allowWrites: false, ...state });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PlanGlance detail={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the glance — which plan, and how far along', () => {
  it('heads the page with the title, beside its mark and its slug', () => {
    mount(detail());
    const glance = screen.getByTestId('plan-glance');
    expect(within(glance).getByRole('heading', { level: 1, name: 'demo plan' })).toBeInTheDocument();
    // The 6.2 header's status badge, as the family draws a status: a dot and a word.
    const mark = within(glance).getByTestId('plan-mark');
    expect(mark).toHaveAttribute('data-status', 'active');
    expect(mark).toHaveAttribute('data-vocab', 'plan');
    expect(within(glance).getByText('demo')).toBeInTheDocument();
  });

  /*
   * The way out, and it is not decoration. A plan is reachable from a push
   * notification, a handoff link and the palette, so this page is routinely
   * the first thing a session sees — and a deep link has nothing to go Back to.
   */
  it('offers the way back to the list, on every width', () => {
    mount(detail());
    const back = screen.getByRole('link', { name: 'All plans' });
    expect(back).toHaveAttribute('href', '#/plans');
    expect(back.className).not.toMatch(/(^|\s)(\w+:)?hidden(\s|$)/);
  });

  it('draws the plan as the list draws it — labelled stations, the ready phase named', () => {
    mount(detail());
    const line = screen.getByRole('list', { name: /demo plan: 1 of 3 phases done/ });
    expect(
      within(line)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1 done', 'P2 next up', '1 left']);
  });

  it('says what is left in sessions, with the estimate and what it has cost', () => {
    mount(
      detail(
        {},
        {
          eta: {
            plan: { lowMs: 2 * 3_600_000, highMs: 4 * 3_600_000, basis: 'plan', samples: 6 },
            perPhase: [],
          },
          cost: { totalUsd: 61.5, partialPhases: [] },
        },
      ),
    );
    const left = screen.getByTestId('plan-left');
    expect(left.textContent).toMatch(/^1 session left, ~2 h–4 h of work left .*\. \$61\.50 spent so far\.$/);
  });

  it('says nothing about money when a plan has never cost anything', () => {
    mount(detail({}, { cost: { totalUsd: 0, partialPhases: [] } }));
    expect(screen.getByTestId('plan-left').textContent).toBe('1 session left.');
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('says what never ran on a closed plan, rather than what is left', () => {
    mount(detail({ status: 'abandoned', closed: true, closedOn: '2026-08-05' }));
    expect(screen.getByTestId('plan-left').textContent).toBe('2 never ran.');
    expect(screen.getByTestId('plan-mark')).toHaveAttribute('data-status', 'abandoned');
  });
});

describe('the one act', () => {
  it('a placed run draws the home’s own action for it — Pause, on a live run', async () => {
    runs = [RUNNING];
    mount(detail());
    const act = await screen.findByTestId('strip-action');
    expect(act).toHaveAttribute('data-action', 'pause');
    // One act: the run's, never beside an offer to start another phase.
    expect(screen.queryByTestId('glance-start')).toBeNull();
    expect(sent).toContain('/api/runs?view=slim');
  });

  it('no run, a ready phase and a console that may run: Start phase N', async () => {
    mount(detail());
    await waitFor(() => expect(sent).toContain('/api/runs?view=slim'));
    const start = await screen.findByTestId('glance-start');
    expect(start).toHaveTextContent('Start phase 2');
    expect(start).toHaveAttribute('title', expect.stringMatching(/launch form/));
    expect(screen.queryByTestId('strip-action')).toBeNull();
  });

  it('a read-only console offers no start', async () => {
    mount(detail(), { allowRun: false });
    await waitFor(() => expect(sent).toContain('/api/runs?view=slim'));
    expect(screen.queryByTestId('glance-start')).toBeNull();
    expect(screen.queryByTestId('strip-action')).toBeNull();
  });

  it('a read-only console reads a placed run rather than driving it — the home’s answer too', async () => {
    runs = [RUNNING];
    mount(detail(), { allowRun: false });
    const act = await screen.findByTestId('strip-action');
    expect(act).toHaveAttribute('data-action', 'open');
    expect(act).toHaveAttribute('href', '#/plan/demo/run');
  });

  it('a closed plan offers no start, though its ready list stays populated', async () => {
    mount(detail({ status: 'abandoned', closed: true }));
    await waitFor(() => expect(sent).toContain('/api/runs?view=slim'));
    expect(screen.queryByTestId('glance-start')).toBeNull();
  });
});
