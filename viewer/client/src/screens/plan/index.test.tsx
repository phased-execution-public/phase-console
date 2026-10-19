/**
 * One plan — `#/plan/:slug` (7.0, quiet-console phase 10; ported from
 * `features/plans/detail.test.tsx`), mounted as the shell mounts it, beside
 * the panel host, against a stubbed server.
 *
 * Three properties are worth a test rather than a look:
 *
 * 1. **The views are total over the frozen vocabulary.** `PLAN_TABS` lives in
 *    `shared/route-meta.js` because the *server* builds notification deep links
 *    from it. A view added there and forgotten here is a push notification that
 *    opens a page saying nothing — so every id must have a label and a body
 *    that is not the fallback.
 *
 * 2. **A repo change does not blank the page.** The page looks right until
 *    something else in the repo moves, and then the plan you were reading is
 *    replaced by a spinner and your scroll position is gone — unless the last
 *    answer is held while the next one is fetched.
 *
 * 3. **Opening a plan spends no prompt and no engine call.** A boot prompt, the
 *    end-of-phase banner, a QA brief, the board text, the memory block and the
 *    session plan are each an engine shell-out on the server; each is asked
 *    for only when the fold that shows it opens — Everything on included.
 *
 * The Run view is the 6.2 run page through its door until phase 11; it is
 * stubbed here behind the same `lazy()` boundary, and tested where it lives.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_TABS } from '@shared/route-meta.js';
import type { PlanDetail } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import type { Route } from '@/shell/routes';
import PlanPage from './index';
import { DETAIL_TABS, TAB_IDS, resolveTab, tabLabel } from './tabs';

// The Run view's body is its own chunk (`./run`, quiet-console phase 11) with
// its own tests. Stubbed here, behind the page's lazy boundary, so this file
// still proves the view's Suspense resolves rather than spinning for ever — and
// what the page hands it.
vi.mock('./run', () => ({
  default: ({ detail, view }: { detail: PlanDetail; view?: string }) => (
    <div data-testid="run-view-stub">
      The run of {detail.summary.slug}
      {view ? `, read as ${view}` : ''}
    </div>
  ),
}));

const NOW = Date.now();

const DETAIL = {
  summary: {
    slug: 'demo',
    title: 'demo plan',
    kind: 'plan',
    status: 'active',
    created: '2026-08-01',
    activity: 0,
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
    bottleneck: { phase: 2, blocks: 1 },
    nextBest: { phase: 2, unblocks: 1 },
    budget: 200_000,
    targetModel: 'claude-opus-5',
    branch: 'main',
    skills: [],
    mcpServers: [],
    qaMode: 'off',
    qaFailures: [],
    locks: [],
    repos: ['skill'],
    handoffCount: 1,
    lastCompleted: '2026-08-02',
    spanDays: 1,
    medianGapDays: 1,
    issues: [],
    issueCounts: { error: 0, warning: 0, info: 0 },
    hasHandoffs: true,
  },
  plan: {
    slug: 'demo',
    title: 'demo plan',
    context: 'Why this exists.',
    architecture: 'How it hangs together.',
    endToEnd: '1. Everything green.',
    sessionBudget: {
      raw: '**Target model:** `claude-opus-5`',
      targetModel: 'claude-opus-5',
      branch: 'main',
      skills: [],
      mcpServers: [],
    },
    graph: [
      {
        phase: 1,
        title: 'Foundations',
        dependsOn: [],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'it builds',
      },
      {
        phase: 2,
        title: 'Surface',
        dependsOn: [1],
        parallelSafe: '3',
        repos: 'skill',
        exitCriteria: 'it renders',
      },
      {
        phase: 3,
        title: 'Cutover',
        dependsOn: [2],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'web/ gone',
      },
    ],
    callouts: ['**Blocking:** `1 → 2 → 3`'],
    sections: [],
  },
  phases: [
    {
      phase: 1,
      title: 'Foundations',
      state: 'done',
      size: 'M',
      weight: 40_000,
      gated: false,
      goal: 'Scaffold the thing.',
      exitCriteria: '1. It builds.',
      bullets: [],
      row: {
        phase: 1,
        title: 'Foundations',
        dependsOn: [],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'it builds',
      },
      analysis: {
        phase: 1,
        state: 'done',
        size: 'M',
        weight: 40_000,
        dependsOn: [],
        dependents: [2],
        transitiveDependents: [2, 3],
        unblocks: 2,
        onCriticalPath: false,
      },
      handoff: {
        file: 'phase-01-x.md',
        status: 'complete',
        completed: '2026-08-02',
        title: 'foundations',
        outstanding: 'None.',
        skillsUsed: ['phased-execution'],
        prompts: 1,
      },
    },
    {
      phase: 2,
      title: 'Surface',
      state: 'ready',
      size: 'L',
      weight: 90_000,
      gated: false,
      goal: 'Build the **surface**.',
      steps: '1. Do it.',
      exitCriteria: '1. It renders.',
      bullets: [],
      row: {
        phase: 2,
        title: 'Surface',
        dependsOn: [1],
        parallelSafe: '3',
        repos: 'skill',
        exitCriteria: 'it renders',
      },
      analysis: {
        phase: 2,
        state: 'ready',
        size: 'L',
        weight: 90_000,
        dependsOn: [1],
        dependents: [3],
        transitiveDependents: [3],
        unblocks: 1,
        onCriticalPath: true,
      },
    },
    {
      phase: 3,
      title: 'Cutover',
      state: 'waiting',
      size: 'S',
      weight: 15_000,
      gated: false,
      bullets: [],
      row: {
        phase: 3,
        title: 'Cutover',
        dependsOn: [2],
        parallelSafe: '—',
        repos: 'skill',
        exitCriteria: 'web/ gone',
      },
      analysis: {
        phase: 3,
        state: 'waiting',
        size: 'S',
        weight: 15_000,
        dependsOn: [2],
        dependents: [],
        transitiveDependents: [],
        unblocks: 0,
        onCriticalPath: true,
      },
    },
  ],
  route: {
    nodes: [
      { phase: 1, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 'Foundations' },
      { phase: 2, layer: 1, row: 0, state: 'ready', size: 'L', gated: false, title: 'Surface' },
      { phase: 3, layer: 2, row: 0, state: 'waiting', size: 'S', gated: false, title: 'Cutover' },
    ],
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ],
    layers: 3,
    rows: 1,
  },
  batches: {
    groups: [{ index: 1, kind: 'batch', weight: '105K', phases: [2, 3], gated: false }],
    raw: '',
    budget: '200K/session',
  },
  boardText: 'Phase graph — demo   (1/3 done)',
  lint: { ok: true, issues: [], summary: 'LINT OK: demo — 3 phases', timedOut: false },
  handoffs: [
    {
      phase: 1,
      file: 'phase-01-x.md',
      title: 'foundations',
      status: 'complete',
      completed: '2026-08-02',
      bytes: 2048,
      mtime: 0,
      prompts: 1,
      skillsUsed: ['phased-execution'],
    },
  ],
  index: [{ phase: 1, title: 'foundations', status: 'complete', link: 'phase-01-x.md' }],
  qa: [],
  locks: [],
  git: { sha: 'abc1234', subject: 'x', relativeDate: '2 hours ago', dirty: false },
  memory: { key: 'project_demo', path: '/m.md', text: '**Status:** done 1.', indexLines: [] },
} as unknown as PlanDetail;

const HANDOFF = {
  slug: 'demo',
  phase: 1,
  file: 'phase-01-x.md',
  path: '/x',
  title: 'foundations',
  status: 'complete',
  completed: '2026-08-03',
  dependsOn: [],
  blocks: [2],
  parallelSafe: [],
  skillsUsed: ['phased-execution'],
  keyFiles: ['viewer/shared/routes.js'],
  outstanding: 'None.',
  prompts: 1,
  body: '## What this phase did\n\nScaffolded it.',
  bytes: 2048,
  mtime: 0,
};

/* ---------------- the server ---------------- */

/** What `/api/plans/demo` answers — a test swaps it, or holds it open. */
let planAnswer: () => PlanDetail | Promise<PlanDetail> = () => DETAIL;
let engineQueue = { active: 0, queued: 0, max: 8 };
let gate: Record<string, unknown> = { kind: 'manual', clear: false, detail: 'not approved yet' };
let state: Record<string, unknown> = {};
let sent: string[] = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const text = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

async function answer(path: string): Promise<Response> {
  if (/^\/api\/state(\?|$)/.test(path)) return json(state);
  if (path === '/api/plans/demo') return json(await planAnswer());
  // The prose and the document projections: the same plan, which carries both.
  if (/^\/api\/plans\/demo\?include=/.test(path)) return json(await planAnswer());
  if (/^\/api\/plans\/other(\?|$)/.test(path)) return new Promise<Response>(() => {});
  if (path === '/api/plans') return json([DETAIL.summary]);
  if (path === '/api/engine') return json(engineQueue);
  let m = path.match(/^\/api\/plans\/demo\/(prompt|next-prompt|qa-prompt)\/(\d+)$/);
  if (m)
    return text(
      m[1] === 'prompt' ? `/phased-execution\n\nStart phase ${m[2]}.` : `${m[1]} after phase ${m[2]}`,
    );
  if (path === '/api/plans/demo/board') return text(DETAIL.boardText!);
  if (path === '/api/plans/demo/memory-block') return text('done: 1\nready: 2');
  if (path === '/api/plans/demo/handoff/1') return json(HANDOFF);
  m = path.match(/^\/api\/plans\/demo\/gate\/(\d+)$/);
  if (m) return json(gate);
  if (path === '/api/plans/demo/raw') return text('# raw plan body');
  if (path === '/api/runs?view=slim') return json([]);
  if (path === '/api/run/demo') return json({ run: null, history: [], eta: null });
  if (path === '/api/inbox') return json({ items: [], generatedAt: new Date(NOW).toISOString() });
  if (path === '/api/queue') return json({ entries: [], at: NOW });
  // Your turn's one source (one-pool phase 14): nothing waits on this plan.
  if (path.startsWith('/api/turn'))
    return json({
      round: { at: new Date(NOW).toISOString(), n: 1, ranAt: new Date(NOW).toISOString(), changedAt: null },
      headline: 'Nothing needs you now.',
      groups: { approve: [], now: [], decide: [], checking: [], upcoming: [], done: [] },
      handled: [],
      counts: { approve: 0, now: 0, decide: 0, checking: 0, upcoming: 0, done: 0, total: 0, handled: 0 },
      seen: null,
      issues: null,
    });
  if (path.startsWith('/api/human-steps')) return json({ steps: [] });
  if (path === '/api/terminal')
    return json({ allowed: false, agentAllowed: false, available: 'yes', sessions: [] });
  return json({});
}

beforeEach(() => {
  planAnswer = () => DETAIL;
  engineQueue = { active: 0, queued: 0, max: 8 };
  gate = { kind: 'manual', clear: false, detail: 'not approved yet' };
  state = { allowRun: true, autopilot: true, allowWrites: false, root: { ok: true, path: '/repo' } };
  sent = [];
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
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

function route(segments: string[], query: Record<string, string> = {}): Route {
  return { segments: ['plan', ...segments], query, path: ['plan', ...segments].join('/') };
}

function page(segments: string[], query: Record<string, string> = {}) {
  return (
    <TooltipProvider>
      <PlanPage route={route(segments, query)} />
      <InspectorHost />
    </TooltipProvider>
  );
}

function renderPlan(segments: string[], query: Record<string, string> = {}, client = newClient()) {
  const view = render(<QueryClientProvider client={client}>{page(segments, query)}</QueryClientProvider>);
  return { ...view, client };
}

function newClient() {
  return new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
}

/** The plan with its summary (or anything else) changed. */
const withSummary = (over: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  ({ ...DETAIL, summary: { ...DETAIL.summary, ...over }, ...rest }) as unknown as PlanDetail;

const closedDetail = (over: Record<string, unknown> = {}) =>
  withSummary(
    {
      status: 'abandoned',
      closed: true,
      closedOn: '2026-08-05',
      closedReason: 'the approach did not survive contact',
      ...over,
    },
    {
      batches: { groups: [], raw: '🔒 CLOSED [abandoned]\n\nNo sessions to plan.\n', budget: '200K/session' },
    },
  );

const viewsNav = () => screen.getByRole('navigation', { name: 'Views of the plan' });

/** "About this plan" — one press. */
const openFacts = () => fireEvent.click(screen.getByTestId('plan-facts'));

/** The reads that are an engine shell-out on the server. */
const ENGINE_READ = /\/(prompt|next-prompt|qa-prompt)\/\d+$|\/board$|\/memory-block$|\/session-plan(\?|$)/;
const engineReads = () => sent.filter((path) => ENGINE_READ.test(path));

describe('the views', () => {
  it('are real links, one per frozen id, in the shared order — the Phases one counted', async () => {
    renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    const links = within(viewsNav()).getAllByRole('link');
    expect(links.map((a) => a.textContent?.replace(/\d+$/, ''))).toEqual(TAB_IDS.map(tabLabel));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(TAB_IDS.map((id) => `#/plan/demo/${id}`));
    expect(links[0]).toHaveTextContent(/3$/);
  });

  it('gives every frozen id a label and a body that is not the fallback', async () => {
    // The fallback is the Phases view; a view that renders it is a view nobody
    // built. `phases` itself is excluded for the obvious reason.
    const BODY: Record<string, string> = {
      phases: 'phases-view',
      run: 'run-view-stub',
      turn: 'turn-page-body',
      source: 'source-view',
    };
    for (const id of PLAN_TABS) {
      const { unmount } = renderPlan(['demo', id]);
      expect(tabLabel(id), `${id} has no label`).not.toBe(id);
      expect(BODY, `no body named for '${id}'`).toHaveProperty(id);
      expect(await screen.findByTestId(BODY[id]!, {}, { timeout: 10_000 })).toBeInTheDocument();
      if (id !== 'phases')
        expect(screen.queryByTestId('phases-view'), `${id} fell through to Phases`).toBeNull();
      expect(within(viewsNav()).getByRole('link', { name: new RegExp(`^${tabLabel(id)}`) })).toHaveAttribute(
        'aria-current',
        'page',
      );
      unmount();
    }
  });

  it('is reached by keyboard, not just the mouse — every view is a real link in the tab order', async () => {
    renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    for (const link of within(viewsNav()).getAllByRole('link')) {
      expect(link).toHaveAttribute('href');
      expect(link).not.toHaveAttribute('tabindex', '-1');
      link.focus();
      expect(link).toHaveFocus();
    }
  });

  it('marks the view a retired address lands on, for the render before its redirect', async () => {
    renderPlan(['demo', 'analysis']);
    await screen.findByRole('heading', { name: 'demo plan' });
    expect(within(viewsNav()).getByRole('link', { current: 'page' })).toHaveTextContent(/^Phases/);
  });

  it('shows a detail page under the list it was reached from', async () => {
    const { unmount } = renderPlan(['demo', 'phase', '2']);
    await screen.findByTestId('phase-page', {}, { timeout: 10_000 });
    expect(within(viewsNav()).getByRole('link', { current: 'page' })).toHaveTextContent(
      new RegExp(`^${tabLabel(DETAIL_TABS.phase!)}`),
    );
    expect(screen.getByRole('link', { name: 'All phases' })).toHaveAttribute('href', '#/plan/demo/phases');
    unmount();
    renderPlan(['demo', 'handoff', '1']);
    await screen.findByTestId('handoff-page', {}, { timeout: 10_000 });
    expect(screen.getByRole('link', { name: 'All handoffs' })).toHaveAttribute(
      'href',
      '#/plan/demo/phases?view=handoffs',
    );
  });
});

describe('resolveTab', () => {
  it('defaults to the phase grid and maps the two detail routes', () => {
    expect(resolveTab(undefined)).toBe('phases');
    expect(resolveTab('phase')).toBe('phases');
    expect(resolveTab('handoff')).toBe('phases');
  });

  it('falls back rather than showing an empty page for an unknown segment', () => {
    expect(resolveTab('not-a-tab')).toBe('phases');
  });

  it('accepts every id the shared vocabulary declares', () => {
    for (const id of PLAN_TABS as readonly string[]) expect(resolveTab(id)).toBe(id);
  });
});

describe('a repo change does not blank the page', () => {
  it('keeps the plan on screen while a `changed` refetch is in flight', async () => {
    const { client } = renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    expect(await screen.findByRole('table', { name: 'Phases' })).toBeInTheDocument();

    // What the stream does for a `changed` event naming this slug — with a
    // refetch that has not answered yet.
    let release: (value: PlanDetail) => void = () => {};
    planAnswer = () =>
      new Promise<PlanDetail>((resolve) => {
        release = resolve;
      });
    // NOT awaited: `invalidateQueries` resolves only once the refetch settles,
    // and the refetch is the thing being held open.
    await act(async () => {
      void client.invalidateQueries({ queryKey: ['plan', 'demo'] });
    });
    await waitFor(() => expect(sent.filter((path) => path === '/api/plans/demo')).toHaveLength(2));

    // The old view set its state to null here and rendered a spinner.
    expect(screen.getByRole('heading', { name: 'demo plan' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Phases' })).toBeInTheDocument();

    await act(async () => {
      release(DETAIL);
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'demo plan' })).toBeInTheDocument());
  });

  it('does show a skeleton for a *different* plan, rather than the previous one', async () => {
    const client = newClient();
    const { rerender } = renderPlan(['demo'], {}, client);
    await screen.findByRole('heading', { name: 'demo plan' });

    rerender(<QueryClientProvider client={client}>{page(['other'])}</QueryClientProvider>);

    // Holding `demo plan` under the name `other` would be a lie about the data.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'demo plan' })).toBeNull());
    expect(document.querySelector('[data-page][aria-busy="true"]')).not.toBeNull();
  });
});

describe('the plan page renders its parts', () => {
  /*
   * The way out, and it is not decoration. A plan is reachable from a push
   * notification, a handoff link and the palette, so this page is routinely
   * the first thing a session sees — and its only other exits were the rail,
   * which lights Plans, and Back, which a deep link has nothing to go back to.
   */
  it('offers the way back to the list, on every width', async () => {
    renderPlan(['demo']);
    const back = await screen.findByRole('link', { name: 'All plans' });
    expect(back).toHaveAttribute('href', '#/plans');
    // Not hidden above a breakpoint: arriving from a deep link on a laptop is
    // the same dead end as arriving from one on a phone.
    expect(back.className).not.toMatch(/(^|\s)(\w+:)?hidden(\s|$)/);
  });

  it('names the ready phase at the top, and it is a real link where the plan opens', async () => {
    renderPlan(['demo']);
    // The track carries the counts (#360); the ready phase is named by its link.
    expect(
      await screen.findByRole('img', { name: 'demo plan, 3 phases: 1 done, 1 next up, 1 waiting, 33 %' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Surface' })).toHaveAttribute(
      'href',
      '#/plan/demo/phase/2',
    );
  });

  it('puts the spend on the glance, and the total and the finish date one press in, linking to the breakdown', async () => {
    planAnswer = () =>
      ({
        ...DETAIL,
        cost: {
          slug: 'demo',
          totalUsd: 61.5,
          attributedUsd: 61.5,
          residualUsd: 0,
          ladderUsd: 12,
          partialPhases: [],
          phases: [],
          byModel: [],
          byDay: [],
          byDayTruncated: false,
          runs: [],
        },
        forecast: {
          earliest: '2026-08-26T12:00:00Z',
          expected: '2026-08-28T12:00:00Z',
          latest: '2026-08-30T12:00:00Z',
          clock: 'calendar',
          calendar: 'known',
          basis: 'plan',
          samples: 6,
          missing: 0,
          remainingPhases: 4,
          remainingWeight: 160_000,
          workingLowMs: 7_200_000,
          workingHighMs: 14_400_000,
          duty: { ratio: 0.25, samples: 6, known: true, workingMs: 3_600_000, elapsedMs: 14_400_000 },
          assumptions: ['Duty cycle: 25% — measured.'],
          label: '~8 h on the calendar',
        },
      }) as unknown as PlanDetail;
    renderPlan(['demo']);
    expect(await screen.findByTestId('plan-left')).toHaveTextContent('$61.50 spent so far');
    openFacts();
    const link = screen.getByRole('link', { name: '$61.50' });
    // Not a dead figure: the glance is the headline and Insights is the answer.
    // The `#/` is not cosmetic — this href was once written by hand without
    // one, so the browser resolved it against the ORIGIN and left the app.
    expect(link).toHaveAttribute('href', '#/insights?plan=demo');
    const finish = screen.getByText(/finishing about Aug 2[78]/);
    // The assumptions ride with the date, never a date with its caveats lost.
    expect(finish).toHaveAttribute('title', 'Duty cycle: 25% — measured.');
  });

  it('says nothing about money when a plan has never cost anything', async () => {
    // A plan with run files that cost nothing — the case a bare `detail.cost`
    // check would render as `$0.00`.
    planAnswer = () =>
      ({
        ...DETAIL,
        cost: {
          slug: 'demo',
          totalUsd: 0,
          attributedUsd: 0,
          residualUsd: 0,
          ladderUsd: 0,
          partialPhases: [],
          phases: [],
          byModel: [],
          byDay: [],
          byDayTruncated: false,
          runs: [{ runId: 'run-1', spentUsd: 0, budgetUsd: null }],
        },
      }) as unknown as PlanDetail;
    renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    openFacts();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.queryByText('Cost')).toBeNull();
    expect(screen.getByTestId('plan-left').textContent).not.toMatch(/spent/);
  });

  /* ---------------- a closed plan reads as closed ----------------
   * `summary.ready` stays populated on a closed plan — the engine reports what
   * never got done so this page can say so — and everything below turns that
   * array into an invitation. The page has to keep the record and drop the
   * invitations. */

  it('says a closed plan is closed at the top, with both the fact and the status word', async () => {
    planAnswer = () => closedDetail();
    renderPlan(['demo']);
    const banner = await screen.findByTestId('plan-closed');
    expect(banner.textContent).toContain('Closed');
    // Both words: closed is the fact, `abandoned` is the one that says more.
    expect(banner.textContent).toContain('abandoned');
    expect(banner).toHaveAttribute('title', expect.stringMatching(/Reopen it/));
    expect(screen.getByTestId('plan-mark')).toHaveAttribute('data-status', 'abandoned');
  });

  it('leaves an open plan its plain status mark — no closed banner', async () => {
    renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    expect(screen.queryByTestId('plan-closed')).toBeNull();
    expect(screen.getByTestId('plan-mark')).toHaveAttribute('data-status', 'active');
  });

  it('leads a closed plan with why it is closed, not with what could start', async () => {
    planAnswer = () => closedDetail();
    renderPlan(['demo']);
    expect(
      await screen.findByText('Closed, abandoned on 2026-08-05: the approach did not survive contact.'),
    ).toBeTruthy();
    // The invitations are gone: the start, the next-up station, the prompts.
    expect(screen.queryByTestId('glance-start')).toBeNull();
    expect(screen.queryByText('P2 next up')).toBeNull();
    expect(screen.queryByTestId('foot-prompts')).toBeNull();
    // The record is not: the phase is still reachable from the grid.
    expect(await screen.findByRole('link', { name: 'Surface' })).toHaveAttribute(
      'href',
      '#/plan/demo/phase/2',
    );
  });

  it('says why there are no sessions to plan rather than dropping the fold', async () => {
    // `--session-plan` answers a closed plan with its banner and no groups, so
    // the batches would simply vanish — which reads as a console that failed
    // to compute one, on a plan still showing unfinished phases.
    planAnswer = () => closedDetail();
    renderPlan(['demo']);
    expect(await screen.findByText(/No sessions to plan/)).toBeTruthy();
    // The batching lives in "What is left", which a closed plan does not get.
    expect(screen.queryByText('What is left')).toBeNull();
  });

  it('still offers the start, the boot prompts and the batches on an OPEN plan', async () => {
    // The control for the two above: they must be asserting closure, not a
    // fixture that never had these in the first place.
    renderPlan(['demo']);
    expect(await screen.findByTestId('glance-start')).toHaveTextContent('Start phase 2');
    expect(await screen.findByTestId('foot-prompts')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('foot-left'));
    // The batch itself, not just the fold around it.
    expect(await screen.findByText('Session 1: P2 + P3')).toBeTruthy();
  });

  it('keeps the terminal board, copyable — two presses away, in Source', async () => {
    const { unmount } = renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    // Press one: the Source view, by its link.
    expect(within(viewsNav()).getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      '#/plan/demo/source',
    );
    unmount();
    renderPlan(['demo', 'source']);
    const fold = await screen.findByTestId('engine-board', {}, { timeout: 10_000 });
    expect(engineReads()).toEqual([]);
    // Press two: the board's own fold — the engine is asked only now.
    fireEvent.click(within(fold).getByRole('button'));
    // Inside a <pre>: assert the CONTENT, whitespace and all.
    expect(
      await screen.findByText((_, el) => el?.tagName === 'PRE' && el.textContent === DETAIL.boardText),
    ).toBeTruthy();
    expect(engineReads()).toEqual(['/api/plans/demo/board']);
  });

  it('makes every phase row reachable by keyboard — a folded group is one button away', async () => {
    renderPlan(['demo']);
    await screen.findByRole('table', { name: 'Phases' });
    // Done folds by default; its heading is a real button, so one Enter opens it.
    const done = await screen.findByRole('button', { name: /Need:\s*Done/ });
    expect(done).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Foundations' })).toBeNull();
    fireEvent.click(done);
    // One link per phase, each carrying the phase deep link — not a `tr onClick`.
    for (const [phase, title] of [
      [1, 'Foundations'],
      [2, 'Surface'],
      [3, 'Cutover'],
    ] as const) {
      expect(await screen.findByRole('link', { name: title })).toHaveAttribute(
        'href',
        `#/plan/demo/phase/${phase}`,
      );
    }
  });

  it('puts what is wrong above the views, and the rest of the plan’s health below the grid', async () => {
    planAnswer = () =>
      ({
        ...DETAIL,
        phases: DETAIL.phases.map((p) => (p.phase === 2 ? { ...p, state: 'stuck' } : p)),
      }) as unknown as PlanDetail;
    renderPlan(['demo']);
    const table = await screen.findByRole('table', { name: 'Phases' });
    const order = [screen.getByTestId('plan-trouble'), viewsNav(), table, screen.getByTestId('phases-foot')];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('renders a phase page through the markdown pipeline', async () => {
    renderPlan(['demo', 'phase', '2']);
    const phasePage = await screen.findByTestId('phase-page', {}, { timeout: 10_000 });
    expect(within(phasePage).getByRole('heading', { name: 'Goal' })).toBeInTheDocument();
    // `**surface**` came through the sanitizer as real emphasis, not asterisks.
    await waitFor(() => expect(phasePage.querySelector('.md strong')?.textContent).toBe('surface'));
  });

  it('mounts the run view on the Run view, through its lazy boundary', async () => {
    // It arrives through a `lazy()` boundary, so this also proves the Suspense
    // fallback resolves rather than leaving the view on a spinner for ever.
    renderPlan(['demo', 'run']);
    expect(await screen.findByTestId('run-view-stub', {}, { timeout: 10_000 })).toHaveTextContent(
      'The run of demo',
    );
    // …asked for with the prose the run page's grid draws.
    expect(sent.some((path) => /^\/api\/plans\/demo\?include=prose%2Chandoffs$/.test(path))).toBe(true);
  });

  it('hands the Run view its reading, and leaves the run’s one act to the view’s own head', async () => {
    const phases = renderPlan(['demo', 'phases']);
    await screen.findByTestId('plan-glance', {}, { timeout: 10_000 });
    const actOnPhases = screen.queryByTestId('glance-start') != null;
    phases.unmount();
    renderPlan(['demo', 'run'], { view: 'history' });
    expect(await screen.findByTestId('run-view-stub', {}, { timeout: 10_000 })).toHaveTextContent(
      'read as history',
    );
    // The same act for the same run, once: the Run view's head carries it.
    if (actOnPhases) expect(screen.queryByTestId('glance-start')).toBeNull();
  });

  it('reports a missing phase instead of rendering an empty page', async () => {
    renderPlan(['demo', 'phase', '99']);
    expect(await screen.findByText(/no phase 99/, {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See every phase' })).toHaveAttribute(
      'href',
      '#/plan/demo/phases',
    );
  });

  /* The boot prompt is on every state, not only the two that can start —
     re-running a phase, seeing what a finished session was told. What changes
     with the state is the caution above it and whether it starts open. */
  describe('the boot prompt', () => {
    const promptFold = (phase: number) =>
      screen.findByTestId(`prompt-boot-${phase}`, {}, { timeout: 10_000 });

    it('is open with no caution on the one phase that can actually start', async () => {
      renderPlan(['demo', 'phase', '2']);
      const fold = await promptFold(2);
      expect(within(fold).getByText('Boot prompt for phase 2')).toBeInTheDocument();
      // Open: the engine's text is already on screen, no Show button.
      expect(await within(fold).findByText(/Start phase 2\./)).toBeInTheDocument();
      expect(within(fold).queryByRole('status')).toBeNull();
    });

    it('a departed phase keeps its prompt, folded, and says so', async () => {
      renderPlan(['demo', 'phase', '1']);
      const fold = await promptFold(1);
      // The caution's own words, not the bare state.
      expect(within(fold).getByText(/kept for reference/i)).toBeInTheDocument();
      // Folded costs nothing: the fold does not ask until it is opened.
      const show = within(fold).getByRole('button', { name: 'Show the prompt' });
      expect(sent).not.toContain('/api/plans/demo/prompt/1');

      fireEvent.click(show);
      expect(await within(fold).findByText(/Start phase 1\./)).toBeInTheDocument();
      expect(sent).toContain('/api/plans/demo/prompt/1');
    });

    it('a waiting phase warns that a session booted now stops at the checks', async () => {
      renderPlan(['demo', 'phase', '3']);
      const fold = await promptFold(3);
      expect(within(fold).getByText(/stops at the lock and board checks/i)).toBeInTheDocument();
      // The caution is OUTSIDE the fold — hidden behind the same press it
      // would reach only someone who had already decided to look.
      expect(within(fold).getByRole('button', { name: 'Show the prompt' })).toBeInTheDocument();
    });

    it('names the lock for a phase somebody else is already on', async () => {
      planAnswer = () =>
        ({
          ...DETAIL,
          phases: DETAIL.phases.map((p) => (p.phase === 2 ? { ...p, state: 'in-progress' } : p)),
        }) as unknown as PlanDetail;
      renderPlan(['demo', 'phase', '2']);
      const fold = await promptFold(2);
      expect(within(fold).getByText(/phase-lock will refuse a second one/i)).toBeInTheDocument();
    });

    it('a gate outranks the state — it is what actually holds the phase', async () => {
      planAnswer = () =>
        ({
          ...DETAIL,
          phases: DETAIL.phases.map((p) => (p.phase === 2 ? { ...p, gated: true } : p)),
        }) as unknown as PlanDetail;
      renderPlan(['demo', 'phase', '2']);
      const fold = await promptFold(2);
      // `ready` on the board, but the gate is the wall a booted session hits.
      expect(within(fold).getByText(/stops at the gate check/i)).toBeInTheDocument();
    });

    it('the gate card names who clears it and, with writes off, says how to approve', async () => {
      planAnswer = () =>
        ({
          ...DETAIL,
          phases: DETAIL.phases.map((p) =>
            p.phase === 2
              ? { ...p, gated: true, gateKind: 'human', gates: '1. mint the keys\n2. export them' }
              : p,
          ),
        }) as unknown as PlanDetail;
      renderPlan(['demo', 'phase', '2']);
      const card = await screen.findByTestId('gate-card', {}, { timeout: 10_000 });
      const kind = card.querySelector('[data-vocab="gate"]');
      expect(kind).toHaveAttribute('data-status', 'human');
      expect(kind).toHaveTextContent('Person');
      expect(await within(card).findByText(/gate-approve\.sh/)).toBeInTheDocument();
      // Writes are off in this console's state — no button, an honest hint.
      expect(within(card).queryByRole('button', { name: /Approve the gate/ })).toBeNull();
    });

    it('an ai gate says booting IS the way through', async () => {
      planAnswer = () =>
        ({
          ...DETAIL,
          phases: DETAIL.phases.map((p) =>
            p.phase === 2 ? { ...p, gated: true, gateKind: 'ai', gates: 'staging deployed' } : p,
          ),
        }) as unknown as PlanDetail;
      renderPlan(['demo', 'phase', '2']);
      const card = await screen.findByTestId('gate-card', {}, { timeout: 10_000 });
      expect(card.querySelector('[data-vocab="gate"]')).toHaveAttribute('data-status', 'ai');
      expect(within(await promptFold(2)).getByText(/booting is the way through/i)).toBeInTheDocument();
    });
  });

  it('renders a handoff body as markdown', async () => {
    renderPlan(['demo', 'handoff', '1']);
    expect(await screen.findByText('Scaffolded it.', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What this phase did' })).toBeInTheDocument();
  });
});

/*
 * Opening a plan spends no prompt and no engine call (#44's cousin, and the
 * reason the prompts are folds): each of these is a shell-out on the server,
 * and a plan with four ready phases used to open with four engine runs.
 */
describe('opening a plan spends no engine call', () => {
  it('asks for no prompt, no board text, no memory block and no session plan until a fold opens', async () => {
    planAnswer = () => withSummary({ ready: [2, 3] });
    renderPlan(['demo']);
    await screen.findByRole('table', { name: 'Phases' });
    await screen.findByTestId('foot-prompts');
    expect(engineReads()).toEqual([]);
    // The board the page reads is the projection — never the prose, never the document.
    expect(sent.filter((path) => path.startsWith('/api/plans/demo?'))).toEqual([]);

    // The folds open; still nothing — each prompt is a fold of its own.
    fireEvent.click(screen.getByTestId('foot-prompts'));
    fireEvent.click(screen.getByTestId('foot-banner'));
    expect(engineReads()).toEqual([]);

    // The one opened is the one asked for.
    fireEvent.click(
      within(screen.getByTestId('prompt-boot-3')).getByRole('button', { name: 'Show the prompt' }),
    );
    expect(await screen.findByText(/Start phase 3\./)).toBeInTheDocument();
    expect(engineReads()).toEqual(['/api/plans/demo/prompt/3']);
  });

  it('asks for none with Everything on either — Everything opens folds, never a read', async () => {
    setPrefs({ everything: { plan: true } });
    planAnswer = () => withSummary({ ready: [2, 3] });
    renderPlan(['demo']);
    await screen.findByRole('table', { name: 'Phases' });
    expect(screen.getByTestId('plan-facts')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('foot-prompts')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Boot prompt for phase 3')).toBeInTheDocument();
    expect(engineReads()).toEqual([]);
  });

  it('asks the Source view’s engine nothing until its folds open either', async () => {
    renderPlan(['demo', 'source']);
    await screen.findByTestId('engine-fold', {}, { timeout: 10_000 });
    expect(engineReads()).toEqual([]);
    fireEvent.click(within(screen.getByTestId('engine-memory')).getByRole('button'));
    await waitFor(() => expect(engineReads()).toEqual(['/api/plans/demo/memory-block']));
  });
});

/*
 * A slow engine is said, not hidden (#44, control-tower phase 55). A cold plan's
 * board queues behind every other engine read, and a board read that times out
 * is served as the last good one: both used to look like a console that was
 * down, or like a plan where nothing had ever run.
 */
describe('a slow engine is said, not hidden', () => {
  it('says the board is being computed, and how many reads wait ahead of it', async () => {
    planAnswer = () => new Promise<PlanDetail>(() => {});
    engineQueue = { active: 8, queued: 3, max: 8 };
    renderPlan(['demo']);
    const line = await screen.findByText('Computing the board, 3 queued');
    expect(line).toHaveAttribute('role', 'status');
  });

  it('says only that it is computing when nothing is queued ahead', async () => {
    planAnswer = () => new Promise<PlanDetail>(() => {});
    engineQueue = { active: 1, queued: 0, max: 8 };
    renderPlan(['demo']);
    await waitFor(() => expect(sent).toContain('/api/engine'));
    expect(await screen.findByText('Computing the board')).toBeInTheDocument();
  });

  it('marks a board served from the last good read as stale, beside the progress it qualifies', async () => {
    const at = Date.now() - 5 * 60_000;
    planAnswer = () => withSummary({ boardStale: { at, ageMs: 5 * 60_000 } });
    renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    openFacts();
    const labels = [...document.querySelectorAll('[data-testid="plan-facts"] + * dt, dt')].map(
      (dt) => dt.textContent,
    );
    expect(labels.indexOf('Stale board')).toBe(labels.indexOf('Board') + 1);
    const marker = screen.getByText('Stale board').nextElementSibling;
    expect(marker?.textContent).toMatch(/the engine timed out; this is the board it read .+ ago/);
    // The stale board is said as a fact, not under an engine-error banner.
    expect(screen.queryByText(/The engine said/)).toBeNull();
  });

  it('shows no stale marker on a board the current read answered', async () => {
    renderPlan(['demo']);
    await screen.findByRole('heading', { name: 'demo plan' });
    openFacts();
    expect(screen.queryByText(/Stale board/)).toBeNull();
  });

  it('dates a lint verdict carried over from an earlier revision', async () => {
    planAnswer = () =>
      ({
        ...DETAIL,
        lint: {
          ok: false,
          issues: ['F2: phase 3 depends on undefined phase 9'],
          summary: 'LINT FAIL: demo — 1 error',
          timedOut: false,
          stale: { at: Date.now() - 60_000, revision: 4 },
        },
      }) as unknown as PlanDetail;
    renderPlan(['demo']);
    expect(await screen.findAllByText('LINT FAIL: demo — 1 error')).not.toHaveLength(0);
    // The date belongs to the banner; the trouble above the views says the
    // lint fails and offers to ask again.
    expect(screen.getByText(/From the last check that finished/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('plan-trouble')).getByText('The plan fails its lint.'),
    ).toBeInTheDocument();
  });
});
