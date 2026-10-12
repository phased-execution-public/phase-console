/**
 * No datum removed — every fact the 6.2 plan page showed is within TWO
 * presses of where a plan OPENS (7.0, quiet-console phase 10, the exit
 * criterion "keeps every 6.2 row"; ported from
 * `features/plans/detail.datums.test.tsx`, control-tower phase 23; design.md
 * §1: "No datum removed · every datum within 2 interactions").
 *
 * The plan is mounted whole — `#/plan/alpha`, the Phases view on its table,
 * beside the shell's panel host — and every press is counted: a view's link
 * (followed to the address it names), a folded group or section, a row's
 * detail, Inspect. A fact that needs a third press, or that is not on the page
 * at all, fails its row by name.
 *
 * The rows are 6.2's — the header's (#28's start and span, #27's QA card,
 * #17's "could not run", the plan's model, budget, branch, last commit and
 * skills) and the three folded tabs' (Route, QA, Handoffs) — plus 7.0's own:
 * the inspector's eight sections each show their record's fields, Inspect
 * being one press and the section's fold the second, and the Raw tab holds the
 * record whole.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseRecord, PhaseView, PlanDetail } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { TooltipProvider } from '@/ui/tooltip';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { parseHash, type Route } from '@/shell/routes';
import PlanPage from './index';
import { PHASE_RECORD_SECTIONS } from './phases/inspector';

// The map is its own chunk and its own ledger (`map/map.test.tsx`); none of
// its drawing is a datum of a tab that folded.
vi.mock('./map/map-view', () => ({ MapView: () => <div data-testid="route-map" /> }));

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

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
    analysis: {
      phase: 3,
      state: 'waiting',
      size: 'L',
      weight: 1,
      dependsOn: [2],
      dependents: [],
      transitiveDependents: [],
      unblocks: 0,
      onCriticalPath: true,
    },
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
    budget: 200_000,
    qaMode: 'on',
    qaModeReason: 'plan directive: QA gate: on',
    startedAt: '2026-09-22T06:40:19.000Z',
    spanMs: 7_200_000,
  },
  plan: {
    sessionBudget: { targetModel: 'claude-opus-5', branch: '`pe/alpha`', skills: ['frontend-design'] },
  },
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
  git: { sha: 'abc1234', subject: 'x', relativeDate: '2 hours ago', dirty: false },
  route: { nodes: [], edges: [], layers: 0, rows: 0 },
} as unknown as PlanDetail;

/**
 * Phase 3's record in this plan's run — ONE field of each of the inspector's
 * eight sections at least, each a value the section must say.
 */
const RECORD = {
  phase: 3,
  status: 'parked',
  attempts: 2,
  costUsd: 3.25,
  creditUsd: 0.75,
  // Boarding
  attemptStartedAt: iso(NOW - 14 * 60_000),
  // Context
  tokens: [
    {
      calls: 41,
      lastContext: 150_000,
      peakContext: 182_000,
      input: 1,
      cacheWrite: 1,
      cacheRead: 1,
      output: 1,
      rebuilds: 2,
      mode: 'phase',
      sessionId: 's3',
      resumed: false,
      model: 'opus',
      window: 200_000,
      endedAt: iso(NOW - 10 * 60_000),
    },
  ],
  contextWrapup: { sessionId: 's3', at: iso(NOW - 11 * 60_000), context: 170_000, window: 200_000 },
  // Verification
  verification: {
    ok: false,
    reason: 'npm test exited 1',
    ran: [{ command: 'npm test', ok: false, code: 1, ms: 4000 }],
    notRun: [],
  },
  owed: [{ command: 'npm run lint', failures: ['a.ts'], by: 2, at: iso(NOW - 9 * 60_000), how: 'charged' }],
  // Waits and watches
  parkedUntil: iso(NOW + 30 * 60_000),
  waitHistory: [
    { parkedFrom: iso(NOW - 8 * 60_000), parkedUntil: iso(NOW + 30 * 60_000), by: 'session', kind: 'person' },
  ],
  // Queue
  queueSince: iso(NOW - 20 * 60_000),
  waitingOn: [{ slug: 'beta', phase: 2, owner: 'console' }],
  // Walls and permissions
  toolDenied: {
    tool: 'Bash',
    rule: 'Bash(git push:*)',
    command: 'git push origin main',
    at: iso(NOW - 7 * 60_000),
  },
  walls: [
    {
      wall: 'deny',
      tool: 'Bash',
      rule: 'Bash(git push:*)',
      at: iso(NOW - 7 * 60_000),
      source: 'hook',
      reason: 'a push is never automatic',
    },
  ],
  // Isolation and trees
  errandTree: {
    dir: '/repo/.worktrees/errand-alpha-p3',
    at: iso(NOW - 6 * 60_000),
    by: 'operator',
    mounts: [{ rel: 'web', sha: 'abc1234', pushed: false }],
  },
  landing: {
    policy: 'pr',
    conflict: 'park',
    state: 'parked',
    step: 'push',
    repos: {},
    attempts: 1,
    at: iso(NOW - 5 * 60_000),
    note: 'waiting for --allow-publish',
  },
} as unknown as PhaseRecord;

const RUN = {
  id: 'r1',
  slug: 'alpha',
  status: 'paused',
  phases: { 3: RECORD },
  children: {},
  verifying: {},
  createdAt: iso(NOW - 60 * 60_000),
  updatedAt: iso(NOW - 5 * 60_000),
};

/** Every section, the fact of its record it must say, and where: a label and a piece of its value. */
const SECTION_FACTS: Record<string, [label: string, value: RegExp][]> = {
  boarding: [
    ['Attempts', /^2$/],
    ['This attempt started', /ago$/],
  ],
  context: [
    ['Sessions', /^phase, opus: peak 182k of 200k, 41 calls, 2 rebuilds$/],
    ['Wrap-up notice', /^at 170k of 200k$/],
  ],
  verification: [
    ['Verdict', /^red: npm test exited 1$/],
    ['Reds owed', /npm run lint, charged, 1 failure/],
  ],
  waits: [
    // A future instant: its words are the clock's, the instant itself is asserted below.
    ['Parked until', /\S/],
    ['Wait history', /^a person, .+ ago, not resumed yet$/],
  ],
  queue: [
    ['In the queue since', /ago$/],
    ['Waiting on', /^beta phase 2 \(console\)$/],
  ],
  walls: [
    ['Tool denied', /^Bash by Bash\(git push:\*\)git push origin main$/],
    ['Walls met', /^deny on Bash \(Bash\(git push:\*\)\), from the hook: a push is never automatic$/],
  ],
  isolation: [
    ['Errand tree', /\/repo\/\.worktrees\/errand-alpha-p3/],
    ['Landing', /^pr, parked at push, 1 attempt: waiting for --allow-publish$/],
  ],
  cost: [
    ['Spent', /^\$3\.25$/],
    ['Credit', /^\$0\.75$/],
  ],
};

/* ---------------- the server ---------------- */

let run: unknown = null;
let sent: string[] = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function answer(path: string): Response {
  if (/^\/api\/state(\?|$)/.test(path))
    return json({
      allowRun: true,
      allowAgent: false,
      allowWrites: true,
      autopilot: true,
      scriptsDir: '/opt/pe/scripts',
    });
  // The board, and — for a row's detail or the inspector — the same plan as prose.
  if (/^\/api\/plans\/alpha(\?|$)/.test(path)) return json(DETAIL);
  if (path === '/api/plans') return json([DETAIL.summary]);
  if (path === '/api/run/alpha') return json({ run, history: [], eta: null });
  if (path === '/api/runs?view=slim') return json([]);
  if (path === '/api/inbox') return json({ items: [], generatedAt: iso(NOW) });
  if (path === '/api/queue') return json({ entries: [], at: NOW });
  return json({});
}

beforeEach(() => {
  run = null;
  sent = [];
  presses = 0;
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

/* ---------------- the page, and the presses ---------------- */

let rerenderAt: (route: Route) => void = () => {};

/** The plan page as it opens — `#/plan/alpha`, the Phases view on its table — beside the panel host. */
function openPlan(address = '#/plan/alpha') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (route: Route) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PlanPage route={route} />
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree(parseHash(address) as Route));
  rerenderAt = (route) => view.rerender(tree(route));
  return view;
}

/** Every press is counted; a datum's budget is two. */
let presses = 0;
const press = (el: Element) => {
  presses += 1;
  fireEvent.click(el);
};
/** A view's link, followed: one press, and the page is drawn at the address it names. */
const follow = (link: HTMLElement) => {
  presses += 1;
  rerenderAt(parseHash(link.getAttribute('href') ?? '') as Route);
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

const readings = () => screen.getByRole('navigation', { name: 'Readings of the phases' });

describe('every datum of the 6.2 plan page is within two presses', () => {
  it('the header — #27 and #17 — with none', async () => {
    openPlan();
    await screen.findByRole('heading', { name: 'Alpha' });
    await expectWithinTwo([
      'plan directive: QA gate: on',
      '1 failing, 1 passed',
      'holding P3 (by P2)',
      'Plan health could not run',
    ]);
    // The regime is a dot and its word — the engine's word.
    expect(screen.getByTestId('qa-header-card').querySelector('[data-vocab="qa-mode"]')).toHaveTextContent(
      'QA on',
    );
    expect(presses).toBe(0);
  });

  it('the header’s own facts — #28 and the plan’s model, budget, branch, last commit and skills — in one', async () => {
    openPlan();
    await screen.findByRole('heading', { name: 'Alpha' });
    press(screen.getByTestId('plan-facts'));
    await expectWithinTwo([
      '2026-09-22 06:40Z',
      ', over 2h',
      'claude-opus-5',
      '200K a session',
      'pe/alpha',
      'abc1234',
      'frontend-design',
    ]);
    expect(presses).toBe(1);
  });

  it('Route: a waiting phase — its name, goal, state, what holds it, scope, size, ETA, gate, lock, deps', async () => {
    openPlan();
    await screen.findByRole('link', { name: 'Cutover' });
    // On the row itself…
    await expectWithinTwo([
      '03',
      'Cutover',
      'retire the old client',
      'qa:fail',
      'held by its QA verdict',
      'web',
      'L',
      '~3h',
      'human gate',
      'manual: operator sign-off',
    ]);
    expect(rowOf('Cutover').querySelector('[data-vocab="board"]')).toHaveAttribute('data-status', 'waiting');
    // …or, for a column the reading folds, in the row's detail: one press.
    openRow('Cutover');
    await expectWithinTwo(['autopilot/abc123', 'needs']);
    const detail = rowOf('Cutover').nextElementSibling as HTMLElement;
    for (const link of within(detail).getAllByRole('link', { name: 'P2' })) {
      expect(link).toHaveAttribute('href', '#/plan/alpha/phase/2');
    }
    // The panel is a press from the row too.
    expect(screen.getByRole('button', { name: 'Inspect phase 3' })).toBeInTheDocument();
  });

  it('QA: the regime and its level, the verdict and its round, what it holds, the actions — on the QA reading', async () => {
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    follow(within(readings()).getByRole('link', { name: 'QA' })); // the reading's link is the first press
    await screen.findByRole('table', { name: 'QA by phase' });
    await expectWithinTwo(['round 2', 'holds P3', 'on, phase directive', 'on, plan']);
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
    expect(screen.getByRole('link', { name: 'Open the report' })).toBeInTheDocument();
  });

  it('QA: the same facts from the table — unfold Done, open the row', async () => {
    openPlan();
    const done = await screen.findByRole('button', { name: /Need:\s*Done/ });
    press(done);
    await screen.findByRole('link', { name: 'Surface' });
    openRow('Surface');
    await expectWithinTwo(['decided by the phase’s own QA bullet', 'round 2 of 2']);
  });

  it('Handoffs: status, completed, title, size, skills and the INDEX row — on the Handoffs reading', async () => {
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    follow(within(readings()).getByRole('link', { name: 'Handoffs' }));
    await screen.findByRole('table', { name: 'Handoffs by phase' });
    await expectWithinTwo(['2026-09-01', 'no index row']);
    expect(
      document.querySelectorAll('[data-vocab="handoff"][data-status="complete"]').length,
    ).toBeGreaterThanOrEqual(2);
    openRow('Foundations');
    await expectWithinTwo([
      'Foundations handoff',
      '4K',
      'superpowers:test-driven-development',
      'reads complete',
    ]);
    expect(screen.getAllByRole('link', { name: /Read the handoff|Handoff complete/ })[0]).toHaveAttribute(
      'href',
      '#/plan/alpha/handoff/1',
    );
  });

  it('the plan’s own folds are under every reading, with no press', async () => {
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    for (const name of ['Table', 'Map', 'QA', 'Handoffs']) {
      rerenderAt(
        parseHash(within(readings()).getByRole('link', { name }).getAttribute('href') ?? '') as Route,
      );
      const foot = await screen.findByTestId('phases-foot');
      expect(within(foot).getByTestId('foot-left'), name).toBeInTheDocument();
      expect(within(foot).getByTestId('landing-card'), name).toBeInTheDocument();
      expect(within(foot).getByTestId('foot-banner'), name).toBeInTheDocument();
    }
  });
});

describe('the inspector — the run’s record of a phase, in eight sections', () => {
  /** Inspect, from the row: one press, and the panel it drew. */
  async function inspect(): Promise<HTMLElement> {
    press(await screen.findByRole('button', { name: 'Inspect phase 3' }));
    const panel = document.querySelector<HTMLElement>('[data-inspector]');
    if (!panel) throw new Error('Inspect drew nothing in the panel');
    return panel;
  }

  /** The value a section's fact carries — the `dd` beside its `dt`. */
  const valueOf = (root: HTMLElement, label: string): string | null => {
    const dt = within(root).queryAllByText(label, { selector: 'dt' }).at(0);
    return dt?.nextElementSibling?.textContent ?? null;
  };

  it('each section says its record’s fields — Inspect is one press, the section’s fold the second', async () => {
    run = RUN;
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    const panel = await inspect();
    expect(panel).toHaveAttribute('aria-label', 'Cutover');
    const sections = await within(panel).findByTestId('phase-record-sections');
    expect(PHASE_RECORD_SECTIONS.map((s) => s.id)).toEqual(Object.keys(SECTION_FACTS));

    const missing: string[] = [];
    for (const section of PHASE_RECORD_SECTIONS) {
      const fold = within(sections).getByTestId(`phase-section-${section.id}`);
      expect(fold, section.label).toHaveAttribute('aria-expanded', 'false');
      // Each datum's own count: Inspect, then its section.
      presses = 1;
      press(fold);
      const body = sections.querySelector<HTMLElement>(`[data-section="${section.id}"]`)!;
      for (const [label, value] of SECTION_FACTS[section.id]!) {
        const said = valueOf(body, label);
        if (said == null || !value.test(said))
          missing.push(`${section.label} › ${label}: ${said ?? 'not said'}`);
      }
      expect(presses, section.label).toBeLessThanOrEqual(2);
    }
    expect(missing).toEqual([]);
    // The record's time is a real instant, not a sentence: the attempt's start.
    const started = sections.querySelector('[data-section="boarding"] time');
    expect(started).toHaveAttribute('dateTime', RECORD.attemptStartedAt);
    expect(
      sections.querySelector(`[data-section="waits"] time[datetime="${RECORD.parkedUntil}"]`),
    ).not.toBeNull();
  });

  it('opens every section with Everything on — Inspect is the only press', async () => {
    run = RUN;
    setPrefs({ everything: { plan: true } });
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    const panel = await inspect();
    for (const section of PHASE_RECORD_SECTIONS) {
      expect(within(panel).getByTestId(`phase-section-${section.id}`), section.label).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }
    expect(valueOf(panel, 'Credit')).toBe('$0.75');
    expect(presses).toBe(1);
  });

  it('says a phase this run never boarded has no record, rather than eight empty sections', async () => {
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    const panel = await inspect();
    expect(within(panel).getByText(/has not boarded/)).toBeInTheDocument();
    expect(within(panel).queryByTestId('phase-record-sections')).toBeNull();
  });

  it('holds the record whole on the Raw tab', async () => {
    run = RUN;
    openPlan();
    await screen.findByRole('table', { name: 'Phases' });
    const panel = await inspect();
    const raw = within(panel).getByRole('tab', { name: 'Raw' });
    fireEvent.mouseDown(raw);
    fireEvent.click(raw);
    const pre = await within(panel).findByText(/"attemptStartedAt"/);
    const said = JSON.parse(pre.textContent ?? '') as { phase: PhaseView; record: unknown };
    expect(said.record).toEqual(JSON.parse(JSON.stringify(RECORD)));
    expect(said.phase).toMatchObject({ phase: 3, title: 'Cutover', state: 'waiting', gateKind: 'human' });
    expect(presses).toBe(1);
  });
});
