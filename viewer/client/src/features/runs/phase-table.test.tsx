/**
 * The run page's phase table, on a desktop.
 *
 * What is pinned here is the set of promises the twelve-column layout makes
 * and had no test for:
 *
 *   - **one source for alignment.** `align` is declared on the column; the
 *     header read it and the body read a hand-kept class map, so the two
 *     halves of a numeric column agreed only until a fourth one was added.
 *   - **the group heading NAMES what it opens** (`aria-controls`), rather than
 *     announcing that something unspecified expanded.
 *   - **two unbounded joins are bounded.** A watch list and an MCP call list
 *     have no width of their own, and both sit in declared 128px tracks.
 *   - **`scrolls` and `sticky` are one decision**, and both wait for a real
 *     measurement — the arrangement that hides a column with no way back.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEngine } from '@/components/data-table';
import { MemoryRouterProvider } from '@/app/router';
import { TooltipProvider } from '@/components/ui';
import { expectNoAxeViolations } from '@/test/axe';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { EVENT_EFFECTS, keys, queryClientConfig, useRun } from '@/lib/queries';
import type { ChildRef, LaneLiveness, PhaseView, RunState } from '@/lib/api';
import { PHASE_COLUMNS, PHASE_TABLE_CONTEXTS, PhaseTable } from './phase-table';

// The grid's row model arrives on demand; its first import in a fresh worker
// can take longer than a `findBy` waits, so it is fetched once, up front.
beforeAll(async () => {
  await loadEngine();
}, 30_000);

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'phase-table.tsx'), 'utf8');

const phase = (over: Partial<PhaseView>): PhaseView =>
  ({
    phase: 1,
    title: 'A phase',
    state: 'ready',
    size: 'S',
    weight: 1,
    gated: false,
    ...over,
  }) as PhaseView;

const run = (over: Partial<RunState>): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'parked',
    autonomy: 'keep-going',
    model: 'opus',
    createdAt: '',
    updatedAt: '',
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    spentUsd: 0,
    ...over,
  }) as unknown as RunState;

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.state(), {
    allowRun: true,
    allowAgent: true,
    allowWrites: false,
    autopilot: true,
    root: { ok: true, path: '/repo' },
  });
  client.setQueryData(keys.terminal(), {
    allowed: false,
    agentAllowed: true,
    available: 'yes',
    sessions: [],
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('PhaseTable — the layout promises', () => {
  it('draws through the grid, so alignment lives on the column and nowhere else', () => {
    // Since control-tower phase 23 the table is `DataTable` over one column
    // array: the grid reads `align` for the header and the body from the same
    // declaration, so there is no second map here to disagree with it.
    expect(SOURCE).toMatch(/<DataTable\b/);
    expect(SOURCE).not.toMatch(/const CELL_CLASS/);
    expect(SOURCE).toMatch(/id: 'spend',[\s\S]{0,80}?align: 'end'/);
  });

  it('waits for a real measurement before it stops scrolling or starts sticking — through the grid', () => {
    const grid = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../components/data-table/data-table.tsx'),
      'utf8',
    );
    expect(grid).toContain('scrolls={overflows || !measured}');
    expect(grid).toContain('sticky={!overflows && measured}');
  });

  it('bounds the two joins that have no width of their own', () => {
    expect(SOURCE).toMatch(/className="truncate text-ink-faint" title=\{mcpCallList\(r\.mcpCalls\)\}/);
    expect(SOURCE).toMatch(/inline-block max-w-full truncate align-bottom font-mono/);
  });
});

describe('PhaseTable — what it renders', () => {
  beforeEach(() => setPrefs({ tables: {} }));

  it('names the region each group heading opens, and folds Done until asked', async () => {
    const { container } = mount(
      <PhaseTable
        slug="demo"
        run={run({
          phases: { 1: { phase: 1, status: 'done', attempts: 1, costUsd: 1.5, turns: 4 } },
        } as never)}
        planPhases={[phase({ phase: 1, state: 'done', title: 'Editor truth' })]}
        live={false}
        allowRun
      />,
    );
    const heading = await screen.findByRole('button', { name: /Need:\s*Done/ });
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    const controls = heading.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    // The reference must resolve — a dangling `aria-controls` is worse than
    // none, and the rows' body is rendered whether or not the group is shut.
    expect(container.querySelector(`#${CSS.escape(controls!)}`)).toBeTruthy();
    fireEvent.click(heading);
    expect(await screen.findByRole('link', { name: 'Editor truth' })).toBeInTheDocument();
  });

  it('right-aligns the numeric columns in both halves of the table', async () => {
    mount(
      <PhaseTable
        slug="demo"
        run={run({
          phases: { 1: { phase: 1, status: 'failed', attempts: 1, costUsd: 2.5, turns: 7 } },
        } as never)}
        planPhases={[phase({ phase: 1, state: 'ready', title: 'Editor truth' })]}
        live={false}
        allowRun
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Spend' }).className).toContain('text-right');
    const row = (await screen.findByRole('link', { name: 'Editor truth' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('$2.50').closest('td')?.className).toContain('text-right');
  });

  it('has no axe violations with a populated board', async () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    const { container } = mount(
      <PhaseTable
        slug="demo"
        run={run({
          phases: {
            1: { phase: 1, status: 'done', attempts: 1, costUsd: 1, turns: 3 },
            2: { phase: 2, status: 'failed', attempts: 2, costUsd: 2, note: 'did not verify' },
          },
        } as never)}
        planPhases={[
          phase({ phase: 1, state: 'done', title: 'Editor truth' }),
          phase({ phase: 2, state: 'ready', title: 'Ship it', gated: true }),
        ]}
        live={false}
        allowRun
      />,
    );
    await expectNoAxeViolations(container);
  });

  it('#91: a phase parked on a model mismatch says so on its row — and a phase that boarded again does not', () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    const mismatch = {
      requested: 'claude-fable-5-1',
      resolved: 'claude-opus-5-5',
      at: '2026-09-24T10:00:00Z',
    };
    const { unmount } = mount(
      <PhaseTable
        slug="demo"
        run={run({
          phases: {
            1: {
              phase: 1,
              status: 'parked',
              attempts: 1,
              costUsd: 0,
              model: 'claude-fable-5-1',
              note: 'Model mismatch — …',
              modelMismatch: mismatch,
            },
          },
        } as never)}
        planPhases={[phase({ phase: 1, state: 'ready', title: 'Pinned work' })]}
        live={false}
        allowRun
      />,
    );
    expect(screen.getAllByText('model mismatch').length).toBeGreaterThan(0);
    unmount();
    mount(
      <PhaseTable
        slug="demo"
        run={run({
          phases: { 1: { phase: 1, status: 'done', attempts: 2, costUsd: 1, modelMismatch: mismatch } },
        } as never)}
        planPhases={[phase({ phase: 1, state: 'done', title: 'Pinned work' })]}
        live={false}
        allowRun
      />,
    );
    expect(screen.queryByText('model mismatch')).toBeNull();
  });

  it("#148: a waiting phase's row shows each ref's last probe and a countdown to its resume — never a bare list", async () => {
    const now = Date.now();
    const until = new Date(now + 17 * 60_000 + 20_000).toISOString();
    const checked = new Date(now - 3 * 60_000 - 5_000).toISOString();
    const CD = 'gh:acme/web#run/17843290511';
    mount(
      <PhaseTable
        slug="demo"
        run={run({
          status: 'paused',
          stoppedBy: 'system',
          waitUntil: until,
          waitReason: 'external',
          phases: {
            28: {
              phase: 28,
              status: 'waiting',
              attempts: 1,
              costUsd: 0,
              parkedUntil: until,
              parkReason: 'waiting for the deploy of 0588175c',
              watch: [CD, 'date:2099-01-01T00:00:00Z'],
              watchState: {
                at: checked,
                refs: [
                  {
                    ref: CD,
                    scheme: 'gh-run',
                    state: 'pending',
                    checkedAt: checked,
                    nextDueAt: now + 60_000,
                  },
                ],
              },
            },
          },
        } as never)}
        planPhases={[phase({ phase: 28, state: 'in-progress', title: 'Deploy' })]}
        live={false}
        allowRun
      />,
    );
    // One press from the row: the wait is the row's detail.
    const row = (await screen.findByRole('link', { name: 'Deploy' })).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Show the rest of this row/ }));
    const detail = document.getElementById('row-28-detail')!.textContent ?? '';
    expect(detail).toMatch(/waiting for the deploy of 0588175c/);
    expect(detail).toMatch(/resumes .+ \(17m left\)/);
    expect(detail).toContain(`${CD} (pending · checked 3 minutes ago)`);
    expect(detail).toContain('date:2099-01-01T00:00:00Z (not checked yet)');
  });

  it('RS-4: a hinted phase no lane holds yet is named on its row with its hint time — through the shared reader, so a stopped run names none', () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    const hinted = {
      phase: 2,
      status: 'pending',
      attempts: 1,
      costUsd: 0,
      boardingHint: {
        situation: 'work-in-progress',
        rung: 'reboard-resume-brief',
        brief: 'resume',
        at: '2026-09-26T16:09:43Z',
        by: 'console',
      },
    };
    const planPhases = [phase({ phase: 2, state: 'in-progress', title: 'Handed off at the wrap-up' })];
    const { unmount } = mount(
      <PhaseTable
        slug="demo"
        run={run({ status: 'running', phases: { 2: hinted } } as never)}
        planPhases={planPhases}
        live
        allowRun
      />,
    );
    expect(screen.getAllByText('hinted since 16:09Z').length).toBeGreaterThan(0);
    unmount();
    // A stopped run drives nothing: "boards at the next free lane" would be a promise nobody keeps.
    mount(
      <PhaseTable
        slug="demo"
        run={run({ status: 'parked', phases: { 2: hinted } } as never)}
        planPhases={planPhases}
        live={false}
        allowRun
      />,
    );
    expect(screen.queryByText('hinted since 16:09Z')).toBeNull();
  });
});

/**
 * The phase table's branch chip — the row's answer to "which checkout is this
 * one committing in".
 *
 * The table had no test that mounted it at all, and the chip's real risk is
 * which lane it reads. `RunState.child` is a MIRROR pointer — with two lanes
 * live it names only the LOWEST-numbered one — so sourcing the chip from it
 * would paint one lane's branch onto every row, confidently and wrongly. The
 * chip reads `children` keyed by the ROW's own phase, and that is what these
 * cases pin.
 *
 * (Not pinned, because JS cannot tell them apart: `children[10]` and
 * `children['10']` are the same property access. The `String()` in the source
 * is for the reader and the type-checker, not for the runtime.)
 */
const branchPhase = (n: number): PhaseView => ({
  phase: n,
  title: `Phase ${n}`,
  state: 'ready',
  size: 'M',
  weight: 40_000,
  gated: false,
  bullets: [],
});

const branchChild = (n: number, over: Partial<ChildRef> = {}): ChildRef => ({
  pid: 1000 + n,
  phase: n,
  sessionId: `s${n}`,
  startedAt: new Date().toISOString(),
  ...over,
});

const branchRun = (children: Record<string, ChildRef>): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'running',
    autonomy: 'keep-going',
    model: 'opus',
    phaseBudgetUsd: null,
    runBudgetUsd: null,
    spentUsd: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activePhase: 10,
    child: null,
    children,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
  }) as RunState;

function mountBranchTable(state: RunState | null) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/plan/demo/run">
        <TooltipProvider>
          <PhaseTable slug="demo" run={state} planPhases={[branchPhase(10), branchPhase(11)]} live allowRun />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('the phase table’s branch chip', () => {
  it('appears on the row whose lane took a checkout of its own', () => {
    mountBranchTable(
      branchRun({ '10': branchChild(10, { worktree: '/state/wt/demo-p10', branch: 'pe/demo-p10' }) }),
    );
    const chips = screen.getAllByTestId('branch-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('pe/demo-p10');
  });

  it('appears once per lane that has one, each on its OWN row', () => {
    mountBranchTable(
      branchRun({
        '10': branchChild(10, { worktree: '/a', branch: 'pe/demo-p10' }),
        '11': branchChild(11, { worktree: '/b', branch: 'pe/demo-p11' }),
      }),
    );
    expect(screen.getAllByTestId('branch-chip').map((c) => c.textContent)).toEqual([
      'pe/demo-p10',
      'pe/demo-p11',
    ]);
  });

  it('never paints the mirror lane’s branch onto a row that is not its own', () => {
    // `run.child` names the LOWEST live lane. Sourcing the chip from it would
    // put phase 10's branch on phase 11's row — a row that reads plausibly and
    // says the wrong thing, which is the failure worth a test.
    const state = branchRun({ '11': branchChild(11, { worktree: '/b', branch: 'pe/demo-p11' }) });
    (state as { child: ChildRef | null }).child = branchChild(10, {
      worktree: '/a',
      branch: 'pe/demo-p10',
    });
    mountBranchTable(state);
    const chips = screen.getAllByTestId('branch-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('pe/demo-p11');
    expect(chips[0]!.textContent).not.toContain('pe/demo-p10');
  });

  it('appears nowhere for lanes sharing the run’s own checkout, or with no run', () => {
    mountBranchTable(branchRun({ '10': branchChild(10) }));
    expect(screen.queryByTestId('branch-chip')).toBeNull();
  });

  it('appears nowhere when there is no run at all', () => {
    mountBranchTable(null);
    expect(screen.queryByTestId('branch-chip')).toBeNull();
  });
});

/*
 * The landing chips (many-plans-one-repo phase 15): what the PLAN says
 * happens to a phase's commits (`Land:`, resolved phase → plan → default by
 * the server, `PhaseView.land`) and, once the engine has written one, where
 * the landing HAS GOT TO (`PhaseRecord.landing.state`). Two chips because they
 * are two facts from two sources — the plan's word never changes while the
 * run drives; the state does.
 */
function mountLandingTable(planPhases: PhaseView[], state: RunState | null) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/plan/demo/run">
        <TooltipProvider>
          <PhaseTable slug="demo" run={state} planPhases={planPhases} live allowRun />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('the phase table’s landing chips', () => {
  it('shows the plan’s Land: word on the row, and says where the word came from', () => {
    mountLandingTable(
      [
        { ...branchPhase(10), land: { value: 'pr', source: 'phase' } },
        { ...branchPhase(11), land: { value: 'integrate', source: 'plan' } },
      ],
      null,
    );
    const chips = screen.getAllByTestId('land-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['Land: pr', 'Land: integrate']);
    expect(chips[0]!.getAttribute('title')).toMatch(/this phase’s own `Land:` line/);
    expect(chips[1]!.getAttribute('title')).toMatch(/the plan’s `Land:` line/);
  });

  it('says nothing for the shipped default — every row would say hold, and a chip on every row says nothing', () => {
    mountLandingTable([{ ...branchPhase(10), land: { value: 'hold', source: 'default' } }], null);
    expect(screen.queryByTestId('land-chip')).toBeNull();
  });

  it('shows a hold the plan asked for by name — that is a decision, not a default', () => {
    mountLandingTable([{ ...branchPhase(10), land: { value: 'hold', source: 'plan' } }], null);
    expect(screen.getByTestId('land-chip')).toHaveTextContent('Land: hold');
  });

  it('shows where the landing has got to once the engine has written a state, on its own row only', () => {
    const state = branchRun({});
    state.phases = {
      '10': {
        phase: 10,
        status: 'done',
        attempts: 1,
        costUsd: 0,
        landing: {
          policy: 'pr',
          conflict: 'halt',
          state: 'pr-open',
          step: 'watch',
          attempts: 1,
          at: '2026-09-21T10:30:00.000Z',
          repos: { '': { branch: 'pe/demo-p10', state: 'pr-open' } },
        },
      },
    } as RunState['phases'];
    mountLandingTable(
      [{ ...branchPhase(10), land: { value: 'pr', source: 'plan' } }, branchPhase(11)],
      state,
    );
    const chips = screen.getAllByTestId('landing-state-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('pr-open');
    expect(chips[0]!.getAttribute('title')).toMatch(/watching the pull request/);
  });

  it('paints a parked landing as needing a person, in the state vocabulary’s own tone', () => {
    const state = branchRun({});
    state.phases = {
      '10': {
        phase: 10,
        status: 'done',
        attempts: 1,
        costUsd: 0,
        landing: {
          policy: 'integrate',
          conflict: 'park',
          state: 'conflict',
          step: 'parked',
          attempts: 1,
          at: '2026-09-21T10:30:00.000Z',
          repos: { '': { branch: 'pe/demo-p10', state: 'conflict' } },
        },
      },
    } as RunState['phases'];
    mountLandingTable([branchPhase(10)], state);
    const chip = screen.getByTestId('landing-state-chip');
    expect(chip).toHaveTextContent('conflict');
    expect(chip.getAttribute('title')).toMatch(/parked/);
    // The amber family — a person owns the next step — never the failed red:
    // nothing failed, the engine set the phase aside and drove on.
    expect(chip.className).toMatch(/text-accent/);
  });
});

describe('PhaseTable — the lane card says what the lane did last (control-tower phase 95, #138)', () => {
  it("a live row carries the newest event of its session's own log; a row with no lane carries none", () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    const client = new QueryClient({
      ...queryClientConfig,
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(keys.state(), {
      allowRun: true,
      allowAgent: true,
      allowWrites: false,
      autopilot: true,
      root: { ok: true, path: '/repo' },
    });
    client.setQueryData(keys.terminal(), {
      allowed: false,
      agentAllowed: true,
      available: 'yes',
      sessions: [],
    });
    client.setQueryData([...keys.phaseNow('demo'), '3', 'activity', 5], {
      slug: 'demo',
      phase: 3,
      live: true,
      source: 'session-log',
      untrusted: true,
      bytesRead: 512,
      events: [
        {
          kind: 'tool',
          id: 't9',
          name: 'Bash',
          description: 'Run the iOS sweep',
          at: new Date().toISOString(),
          open: true,
          line: 'l9',
        },
      ],
    });
    const started = new Date(Date.now() - 20 * 60_000).toISOString();
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <PhaseTable
            slug="demo"
            run={run({
              status: 'running',
              phases: {
                3: { phase: 3, status: 'running', attempts: 1, costUsd: 0, turns: 4, startedAt: started },
                4: { phase: 4, status: 'done', attempts: 1, costUsd: 1, turns: 2 },
              },
            } as never)}
            planPhases={[
              phase({ phase: 3, state: 'in-progress', title: 'Sweep' }),
              phase({ phase: 4, state: 'done', title: 'Done one' }),
            ]}
            live
            allowRun
            liveness={[
              {
                phase: 3,
                lastOutputAt: new Date().toISOString(),
                turnsSinceLastTool: 0,
                commitsSinceStart: 0,
                treeDirty: false,
              },
            ]}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const lines = screen.getAllByTestId('last-activity');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Bash — Run the iOS sweep, running');
  });
});

/* ------------------------------------------------------------------------- *
 * The one phase table (control-tower phase 23, #25 #26 #27 #28)
 * ------------------------------------------------------------------------- */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('the one phase table — both pages, one column array', () => {
  beforeEach(() => setPrefs({ tables: {} }));

  it('exit 2: the run page and every plan reading draw from ONE column array', async () => {
    const ids = PHASE_COLUMNS.map((c) => c.id);
    const heads = PHASE_COLUMNS.map((c) => c.head);
    // A reading may only HIDE columns of the array — never bring its own.
    for (const [context, reading] of Object.entries(PHASE_TABLE_CONTEXTS)) {
      for (const id of reading.hidden) expect(ids, `${context} hides '${id}'`).toContain(id);
    }
    expect(SOURCE.match(/: Column<PhaseTableRow>\[\] = \[/g), 'one column array, not two').toHaveLength(1);
    for (const context of ['run', 'plan', 'plan-qa', 'plan-handoffs'] as const) {
      const { unmount } = mount(
        <PhaseTable
          context={context}
          slug="demo"
          run={null}
          planPhases={[phase({ phase: 1, title: 'Only one' })]}
          live={false}
          allowRun
        />,
      );
      await screen.findByRole('link', { name: 'Only one' });
      const shown = screen.getAllByRole('columnheader').map((th) => th.textContent ?? '');
      // Every header is a column of the array, in the array's order.
      expect(
        shown.every((h) => heads.includes(h)),
        `${context}: ${shown.join(', ')}`,
      ).toBe(true);
      expect(shown).toEqual(heads.filter((h) => shown.includes(h)));
      unmount();
    }
  });

  it('exit 4 (#27): the QA column keeps the round and the three-state regime with its deciding level', async () => {
    setPrefs({ tables: { 'phases.plan-qa': { collapsed: [] } } });
    mount(
      <PhaseTable
        context="plan-qa"
        slug="demo"
        run={null}
        planPhases={[
          phase({
            phase: 2,
            state: 'done',
            title: 'Reviewed',
            qa: { result: 'fail', report: 'reports/phase-02-qa-round2.md' },
            qaMode: { mode: 'on', source: 'phase' },
            qaRounds: { count: 2, latest: { round: 2, result: 'fail' } },
          }),
          phase({
            phase: 3,
            state: 'done',
            title: 'Waived',
            qa: { result: 'pass' },
            qaMode: { mode: 'waived', source: 'plan' },
          }),
          phase({ phase: 5, state: 'waiting', title: 'Held', blockedBy: [{ phase: 2, why: 'qa:fail' }] }),
        ]}
        qaHeld={{ 2: [5] }}
        live={false}
        allowRun
        recovery={{ allowAgent: false, qaMode: 'on' }}
      />,
    );
    const reviewed = await screen.findByTestId('qa-2');
    expect(reviewed.textContent).toContain('round 2');
    expect(reviewed.textContent).toContain('holds P5');
    expect(reviewed.textContent).toContain('on · phase directive');
    // The verdict IS the way to its report — the sheet keeps its address.
    expect(within(reviewed).getByRole('link', { name: /QA fail — open the report/ })).toHaveAttribute(
      'href',
      '#/plan/demo/phases?view=qa&report=2:2',
    );
    expect(screen.getByTestId('qa-3').textContent).toContain('waived · plan');
    // …and a phase held by that verdict says so in its OWN blocked-by reason.
    const held = (await screen.findByRole('link', { name: 'Held' })).closest('tr') as HTMLElement;
    expect(held.textContent).toContain('qa:fail');
    expect(held.textContent).toContain('held by its QA verdict');
  });

  it('exit 8 (#28): a live lane prints its silence LABELLED, with its threshold — and the attempt clock by name', async () => {
    const now = Date.now();
    const liveness: LaneLiveness[] = [
      {
        phase: 4,
        lastOutputAt: ago(4 * 60_000),
        turnsSinceLastTool: 0,
        commitsSinceStart: 0,
        treeDirty: false,
        silence: { kind: 'unproductive', sinceMs: now - 4 * 60_000, thresholdMs: 600_000 },
      },
    ];
    mount(
      <PhaseTable
        slug="demo"
        run={run({
          status: 'running',
          phases: {
            4: {
              phase: 4,
              status: 'running',
              attempts: 2,
              startedAt: ago(20 * 60_000),
              attemptStartedAt: ago(5 * 60_000),
            },
          },
        } as never)}
        planPhases={[phase({ phase: 4, title: 'Working' })]}
        live
        liveness={liveness}
        allowRun
      />,
    );
    const silence = await screen.findByTestId('lane-silence');
    expect(silence.textContent).toMatch(/^no productive output \S+ · flagged at 10m$/);
    const lane = screen.getByTestId('lane-4');
    expect(lane.textContent).toContain('attempt 2');
    expect(lane.textContent).toContain('this attempt');
  });

  it('exit 9 (#25): tasks, spend and the attempt clock move on run:progress and a local tick — zero fetches', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('a live table must not fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new QueryClient({
      ...queryClientConfig,
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(keys.state(), {
      allowRun: true,
      allowAgent: true,
      autopilot: true,
      root: { ok: true },
    });
    client.setQueryData(keys.terminal(), {
      allowed: false,
      agentAllowed: true,
      available: 'yes',
      sessions: [],
    });
    client.setQueryData(keys.run('demo'), {
      run: run({
        status: 'running',
        phases: {
          7: {
            phase: 7,
            status: 'running',
            attempts: 1,
            costUsd: 1,
            startedAt: ago(3 * 60_000),
            attemptStartedAt: ago(3 * 60_000),
            tasks: { total: 3, done: 0, active: 'read the plan' },
          },
        } as never,
      }),
      history: [],
    });
    function Page() {
      const { data } = useRun('demo');
      return (
        <PhaseTable
          context="plan"
          slug="demo"
          run={data?.run ?? null}
          planPhases={[phase({ phase: 7, title: 'Live one' })]}
          live
          allowRun
        />
      );
    }
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <Page />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const row = () => screen.getByRole('link', { name: 'Live one' }).closest('tr') as HTMLElement;
    await screen.findByRole('link', { name: 'Live one' });
    expect(row().textContent).toContain('$1.00');
    const clockBefore = screen.getByTestId('lane-7').textContent;

    // One frame, exactly as the stream would deliver it.
    act(() =>
      EVENT_EFFECTS['run:progress'].patch!(client, {
        slug: 'demo',
        phase: 7,
        runId: 'r1',
        status: 'running',
        attempt: 1,
        tasks: { total: 3, done: 2, active: 'write the tests' },
        spentUsd: 0.75,
      }),
    );
    await waitFor(() => expect(row().textContent).toContain('$1.75'));
    expect(row().textContent).toContain('write the tests');
    // …and the clock moves on its own, between frames.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
    expect(screen.getByTestId('lane-7').textContent).not.toBe(clockBefore);
    expect(fetchSpy, 'not one request for a frame and a tick').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('exit 10 (#26): groups by need, by plan order or by scope, and remembers its column set', async () => {
    const planPhases = [
      phase({ phase: 1, title: 'First', state: 'done', row: { repos: 'web' } as never }),
      phase({ phase: 2, title: 'Second', state: 'waiting', row: { repos: 'api' } as never }),
      phase({ phase: 3, title: 'Third', state: 'ready', row: { repos: 'web' } as never }),
    ];
    const table = (
      <PhaseTable context="plan" slug="demo" run={null} planPhases={planPhases} live={false} allowRun />
    );
    const { unmount } = mount(table);
    // By NEED, worst first: Ready before Waiting before a folded Done.
    const needs = await screen.findAllByRole('button', { name: /^Need:/ });
    expect(needs.map((b) => b.textContent)).toEqual(['▾Need: Ready1', '▾Need: Waiting1', '▸Need: Done1']);

    const view = async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^View/ }));
      return screen.findByRole('dialog', { name: 'View' });
    };
    // By SCOPE…
    fireEvent.click(within(await view()).getByRole('radio', { name: 'Scope' }));
    // (The sheet is modal, so the page behind it is hidden from the tree
    // while it stays open — hence `hidden: true`.)
    expect(await screen.findByRole('button', { name: /^Scope:\s*web/, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Scope:\s*api/, hidden: true })).toBeInTheDocument();
    // …and in PLAN ORDER: no headings, the rows as the plan numbers them.
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'View' })).getByRole('radio', { name: 'Plan order' }),
    );
    expect(screen.queryByRole('button', { name: /^(Scope|Need):/, hidden: true })).toBeNull();
    const order = screen
      .getAllByRole('link', { name: /^(First|Second|Third)$/, hidden: true })
      .map((a) => a.textContent);
    expect(order).toEqual(['First', 'Second', 'Third']);

    // The column set is REMEMBERED: hide Size, and a fresh mount has no Size.
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'View' })).getByRole('checkbox', { name: 'Size' }),
    );
    expect(getPrefs().tables?.['phases.plan']?.hidden).toContain('size');
    unmount();
    mount(table);
    await screen.findByRole('link', { name: 'Third' });
    expect(screen.queryByRole('columnheader', { name: 'Size' })).toBeNull();
    expect(getPrefs().tables?.['phases.plan']?.groupBy).toBeNull();
  });
});
