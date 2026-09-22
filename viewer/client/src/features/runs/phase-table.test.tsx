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
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { TooltipProvider } from '@/components/ui';
import { expectNoAxeViolations } from '@/test/axe';
import { keys, queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { ChildRef, PhaseView, RunState } from '@/lib/api';
import { PhaseTable } from './phase-table';

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
  it('keeps alignment on the column definition and nowhere else', () => {
    // The per-cell class map is TYPOGRAPHY. A `text-right` in it is a second
    // source for a fact the column already states, and the copy that would
    // have been missed is the one the new column forgot.
    const map = SOURCE.slice(SOURCE.indexOf('const CELL_CLASS'), SOURCE.indexOf('const alignClass'));
    expect(map).not.toMatch(/text-right/);
    expect(SOURCE).toMatch(/const alignClass = .*c\.align === 'end' && 'text-right'/);
    // Both halves read it: once for the header cell, once for the body cell.
    expect(SOURCE.match(/alignClass\(c\)/g)?.length).toBe(2);
  });

  it('waits for a real measurement before it stops scrolling or starts sticking', () => {
    // jsdom measures nothing, so this is the source contract rather than a
    // computed style: `scrolls` and the sticky header are one decision, and
    // "not measured yet" is not "it fits".
    expect(SOURCE).toContain('scrolls={overflows || !measured}');
    expect(SOURCE).toContain('!overflows && measured && stickyHeadCell');
  });

  it('pins the identity rail through the primitive, so a tinted row stays legible', () => {
    // The pinned cell is the ONE cell scrolled content passes beneath, so it
    // has to be opaque AND keep the row's own tint — `stickyIdentityCell`
    // paints both (`--surface`, then `bg-inherit`). A live row here is
    // `bg-progress/8`, which through a `bg-inherit`-only pin was 92 % see
    // through: phase numbers read through the Status column sliding past them.
    expect(SOURCE).toContain('pinIdentity && c.identity && cn(stickyIdentityCell,');
    // Both halves of the rail: the header end is painted in the header band's
    // own colour, never the row-hover token it used to carry.
    expect(SOURCE).toMatch(/overflows &&\s*c\.identity &&\s*'sticky left-0 z-\(--z-base\) bg-ground/);
    expect(SOURCE).not.toMatch(/c\.identity && 'sticky left-0 z-\(--z-base\) bg-surface-raised'/);
  });

  it('bounds the two joins that have no width of their own', () => {
    expect(SOURCE).toMatch(
      /className="truncate text-2xs text-ink-faint" title=\{mcpCallList\(r\.mcpCalls\)\}/,
    );
    expect(SOURCE).toMatch(/inline-block max-w-full truncate align-bottom font-mono/);
  });
});

describe('PhaseTable — what it renders', () => {
  it('names the region each group heading opens', () => {
    setPrefs({ runPhasesCollapsed: [] });
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
    const heading = screen.getByRole('button', { name: /Done/ });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    const controls = heading.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    // The reference must resolve — a dangling `aria-controls` is worse than
    // none, and the rows' body is rendered whether or not the group is shut.
    expect(container.querySelector(`#${controls}`)).toBeTruthy();
  });

  it('right-aligns the numeric columns in both halves of the table', () => {
    setPrefs({ runPhasesCollapsed: [] });
    mount(
      <PhaseTable
        slug="demo"
        run={run({
          phases: { 1: { phase: 1, status: 'done', attempts: 1, costUsd: 2.5, turns: 7 } },
        } as never)}
        planPhases={[phase({ phase: 1, state: 'done', title: 'Editor truth' })]}
        live={false}
        allowRun
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Cost' }).className).toContain('text-right');
    const row = screen.getByRole('link', { name: 'Editor truth' }).closest('tr') as HTMLElement;
    expect(within(row).getByText('$2.50').closest('td')?.className).toContain('text-right');
  });

  it('has no axe violations with a populated board', async () => {
    setPrefs({ runPhasesCollapsed: [] });
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
