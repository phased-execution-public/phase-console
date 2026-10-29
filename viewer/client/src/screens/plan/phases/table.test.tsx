/**
 * The phases grid (7.0, quiet-console phase 10; ported from
 * `features/runs/phase-table.test.tsx` and `phase-cards.test.tsx`).
 *
 * What is pinned is the set of promises the one grid makes on both pages:
 *
 *   - **ONE column array** (exit criterion 1): the run page and every plan
 *     reading draw `PHASE_COLUMNS`; a reading only marks the columns it does
 *     not lead with as Everything columns, which fold into the row's detail.
 *   - **one source for alignment**, on the column; **the group heading NAMES
 *     what it opens**; **`scrolls` and `sticky` are one decision** that waits
 *     for a real measurement.
 *   - what a row says at the glance, in words — the QA regime with its
 *     deciding level (#27), the lane on its labelled clock (#28), what holds it
 *     in the engine's words, the lane's own branch, the plan's `Land:` word,
 *     where the landing has got to, what the session says it is doing and did
 *     last — and what is one press away in its detail.
 *   - the cells that move while a lane works move on `run:progress` and a
 *     local tick, with no request (#25); a 72-phase plan draws a window (#26).
 *   - Inspect puts the phase in the panel and keeps it live there.
 *   - below the shell breakpoint the same records are a list, with the
 *     remedies on it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildRef, LaneLiveness, PhaseView, RunState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { EVENT_EFFECTS } from '@/data/live';
import { useRun } from '@/data/runs';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { __resetInspectorForTests, useInspected } from '@/shell/panel/inspector-host';
import { MemoryRouterProvider } from '@/shell/router';
import { expectNoAxeViolations } from '@/test/axe';
import { loadEngine } from '@/ui/grid/grid';
import { TooltipProvider } from '@/ui/tooltip';
import { PHASE_TABLE_CONTEXTS, PHASE_VIRTUAL_FROM, type PhaseTableContext } from './model';
import { phaseInspectKey } from './inspector';
import { PHASE_COLUMNS, PhaseTable, columnsFor } from './table';

// Below the shell breakpoint the grid draws records, not a table — answered
// per case, because the grid asks on every render.
const media = vi.hoisted(() => ({ phone: false }));
vi.mock('@/lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media')>()),
  usePhone: () => media.phone,
  useNarrow: () => media.phone,
  isPhone: () => media.phone,
}));

// The grid's row model arrives on demand; its first import in a fresh worker
// can take longer than a `findBy` waits, so it is fetched once, up front.
beforeAll(async () => {
  await loadEngine();
}, 30_000);

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'table.tsx'), 'utf8');

const phase = (over: Partial<PhaseView>): PhaseView =>
  ({ phase: 1, title: 'A phase', state: 'ready', size: 'S', weight: 1, gated: false, ...over }) as PhaseView;

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

function clientWithState(): QueryClient {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
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
  return client;
}

function wrap(node: React.ReactElement, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/plan/demo/phases">
        <TooltipProvider>{node}</TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>
  );
}

function mount(node: React.ReactElement, client = clientWithState()) {
  const out = render(wrap(node, client));
  return { ...out, client, rerender: (next: React.ReactElement) => out.rerender(wrap(next, client)) };
}

const rowOf = (title: string) => screen.getByRole('link', { name: title }).closest('tr') as HTMLElement;
const openRow = (title: string) =>
  fireEvent.click(within(rowOf(title)).getByRole('button', { name: /Show the rest of this row/ }));
const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent ?? '');
/** The cell under a column head, in a row. */
const cellOf = (row: HTMLElement, head: string) =>
  row.querySelectorAll('td')[headers().indexOf(head)] as HTMLElement;

/** Every popover a case opens, it closes: one left open keeps its layer on top for the next case. */
async function close(layer: HTMLElement) {
  fireEvent.keyDown(layer, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

beforeEach(() => {
  media.phone = false;
  setPrefs({ tables: {}, everything: {} });
  // A row's detail fetches the phase's prose on open; nothing here answers it.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no server in this test'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => __resetInspectorForTests());
});

describe('PhaseTable — the layout promises', () => {
  it('draws through the grid, so alignment lives on the column and nowhere else', () => {
    // The grid reads `align` for the header and the body from the same
    // declaration, so there is no second map here to disagree with it.
    expect(SOURCE).toMatch(/<Grid\b/);
    expect(SOURCE).not.toMatch(/const CELL_CLASS/);
    expect(SOURCE).toMatch(/id: 'spend',[\s\S]{0,120}?align: 'end'/);
  });

  it('waits for a real measurement before it stops scrolling or starts sticking — through the grid', () => {
    const grid = readFileSync(join(HERE, '../../../ui/grid/grid.tsx'), 'utf8');
    expect(grid).toContain('scrolls={overflows || !measured}');
    expect(grid).toContain('sticky={!overflows && measured}');
  });

  it('bounds the joins that have no width of their own', () => {
    // The MCP call list is truncated in its column with the whole list on its
    // title; the watch list moved to the row's detail, where it wraps.
    expect(SOURCE).toMatch(/className="truncate text-ink-muted" title=\{mcpCallWords\(r\.mcpCalls\)\}/);
    const drawer = readFileSync(join(HERE, 'drawer.tsx'), 'utf8');
    expect(drawer).toMatch(/<li key=\{ref\} className="min-w-0 break-words">/);
  });
});

describe('PhaseTable — what it renders', () => {
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
    expect(screen.queryByRole('link', { name: 'Editor truth' })).toBeNull();
    fireEvent.click(heading);
    expect(await screen.findByRole('link', { name: 'Editor truth' })).toBeInTheDocument();
  });

  it('end-aligns the numeric columns in both halves of the table', async () => {
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
    expect(screen.getByRole('columnheader', { name: 'Spend' }).className).toContain('text-end');
    const row = (await screen.findByRole('link', { name: 'Editor truth' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('$2.50').closest('td')?.className).toContain('text-end');
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
        inspectable
      />,
    );
    await screen.findByRole('link', { name: 'Ship it' });
    await expectNoAxeViolations(container);
  });

  it('never puts a link or a control inside a link — the name and Inspect are siblings', async () => {
    const { container } = mount(
      <PhaseTable
        slug="demo"
        run={null}
        planPhases={[phase({ phase: 3, title: 'Third' })]}
        live={false}
        allowRun
        inspectable
      />,
    );
    await screen.findByRole('link', { name: 'Third' });
    expect(screen.getByRole('link', { name: 'Third' })).toHaveAttribute('href', '#/plan/demo/phase/3');
    expect(container.querySelectorAll('a a, a button')).toHaveLength(0);
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
    await screen.findByRole('link', { name: 'Deploy' });
    openRow('Deploy');
    const detail = document.getElementById('row-28-detail')!.textContent ?? '';
    expect(detail).toMatch(/waiting for the deploy of 0588175c/);
    expect(detail).toMatch(/Resumes at \d\d:\d\d:\d\d, 17m left/);
    expect(detail).toContain(`Watching ${CD} — pending, checked 3 minutes ago`);
    expect(detail).toContain('Watching date:2099-01-01T00:00:00Z — not checked yet');
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

  it('a gate names its category in its column, and the State cell’s overlay words leave the claim to its own column', async () => {
    // The 6.2 flag pile (`FlagsCell`) held both; 7.0 says the gate twice — the
    // State cell's `gated`, the Gate column's kind and check — and never the claim.
    mount(
      <PhaseTable
        context="plan"
        slug="demo"
        run={null}
        planPhases={[
          phase({
            phase: 5,
            title: 'Approve the cutover',
            gated: true,
            gateKind: 'ai',
            gateCheck: 'manual: operator sign-off',
            lock: { owner: 'someone/else', expired: false },
          }),
        ]}
        live={false}
        allowRun
      />,
    );
    const row = (await screen.findByRole('link', { name: 'Approve the cutover' })).closest(
      'tr',
    ) as HTMLElement;
    expect(cellOf(row, 'Gate').textContent).toBe('ai gatemanual: operator sign-off');
    const state = cellOf(row, 'State');
    expect(within(state).getByText('gated')).toBeInTheDocument();
    expect(state.textContent).not.toMatch(/held/);
  });

  it('a claim that stops Run only this names its holder and what is left of the lease on the disabled button', async () => {
    mount(
      <PhaseTable
        slug="demo"
        run={null}
        planPhases={[
          phase({
            phase: 6,
            title: 'Claimed',
            lock: {
              owner: 'someone/else',
              host: 'their-box',
              expired: false,
              leaseUntil: Date.now() + 620_000,
            },
          }),
        ]}
        live={false}
        allowRun
      />,
    );
    const row = (await screen.findByRole('link', { name: 'Claimed' })).closest('tr') as HTMLElement;
    const button = within(row).getByRole('button', { name: 'Run only this' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'Phase 6 is claimed by someone/else on their-box — the lease has 10m left. Release the claim to start a session here.',
    );
  });
});

/*
 * The lane's own branch — the row's answer to "which checkout is this one
 * committing in".
 *
 * Its real risk is which lane it reads. `RunState.child` is a MIRROR pointer —
 * with two lanes live it names only the LOWEST-numbered one — so sourcing the
 * branch from it would paint one lane's branch onto every row, confidently and
 * wrongly. The row reads `children` keyed by its OWN phase, and that is what
 * these cases pin.
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
  run({ status: 'running', activePhase: 10, children, phases: {} } as Partial<RunState>);

const mountLanes = (state: RunState | null, planPhases = [branchPhase(10), branchPhase(11)]) =>
  mount(<PhaseTable slug="demo" run={state} planPhases={planPhases} live allowRun />);

describe('the lane’s own branch', () => {
  it('is said on the row whose lane took a checkout of its own', () => {
    mountLanes(
      branchRun({ '10': branchChild(10, { worktree: '/state/wt/demo-p10', branch: 'pe/demo-p10' }) }),
    );
    const words = screen.getAllByTestId('lane-branch');
    expect(words).toHaveLength(1);
    expect(words[0]!.textContent).toBe('on pe/demo-p10');
    expect(words[0]!.closest('tr')).toHaveAttribute('data-phase', '10');
    expect(words[0]).toHaveAttribute('title', expect.stringContaining('its own checkout'));
  });

  it('is said once per lane that has one, each on its OWN row', () => {
    mountLanes(
      branchRun({
        '10': branchChild(10, { worktree: '/a', branch: 'pe/demo-p10' }),
        '11': branchChild(11, { worktree: '/b', branch: 'pe/demo-p11' }),
      }),
    );
    expect(
      screen
        .getAllByTestId('lane-branch')
        .map((w) => [w.closest('tr')?.getAttribute('data-phase'), w.textContent]),
    ).toEqual([
      ['10', 'on pe/demo-p10'],
      ['11', 'on pe/demo-p11'],
    ]);
  });

  it('never paints the mirror lane’s branch onto a row that is not its own', () => {
    // `run.child` names the LOWEST live lane. Sourcing the branch from it would
    // put phase 10's branch on phase 11's row — a row that reads plausibly and
    // says the wrong thing, which is the failure worth a test.
    const state = branchRun({ '11': branchChild(11, { worktree: '/b', branch: 'pe/demo-p11' }) });
    (state as { child: ChildRef | null }).child = branchChild(10, { worktree: '/a', branch: 'pe/demo-p10' });
    mountLanes(state);
    const words = screen.getAllByTestId('lane-branch');
    expect(words).toHaveLength(1);
    expect(words[0]!.textContent).toContain('pe/demo-p11');
    expect(words[0]!.textContent).not.toContain('pe/demo-p10');
  });

  it('is said nowhere for lanes sharing the run’s own checkout', () => {
    mountLanes(branchRun({ '10': branchChild(10) }));
    expect(screen.queryByTestId('lane-branch')).toBeNull();
  });

  it('is said nowhere when there is no run at all', () => {
    mountLanes(null);
    expect(screen.queryByTestId('lane-branch')).toBeNull();
  });
});

/*
 * The landing words (many-plans-one-repo phase 15): what the PLAN says happens
 * to a phase's commits (`Land:`, resolved phase → plan → default by the server,
 * `PhaseView.land`) and, once the engine has written one, where the landing HAS
 * GOT TO (`PhaseRecord.landing.state`). Two facts from two sources — the plan's
 * word never changes while the run drives; the state does.
 */
describe('the landing words', () => {
  it('says the plan’s Land: word on the row, and where the word came from', () => {
    mountLanes(null, [
      { ...branchPhase(10), land: { value: 'pr', source: 'phase' } },
      { ...branchPhase(11), land: { value: 'integrate', source: 'plan' } },
    ]);
    const words = screen.getAllByTestId('land-words');
    expect(words.map((w) => w.textContent)).toEqual(['Land: pr', 'Land: integrate']);
    expect(words[0]!.getAttribute('title')).toMatch(/this phase’s own `Land:` line/);
    expect(words[1]!.getAttribute('title')).toMatch(/the plan’s `Land:` line/);
  });

  it('says nothing for the shipped default — every row would say hold, and a word on every row says nothing', () => {
    mountLanes(null, [{ ...branchPhase(10), land: { value: 'hold', source: 'default' } }]);
    expect(screen.queryByTestId('land-words')).toBeNull();
  });

  it('says a hold the plan asked for by name — that is a decision, not a default', () => {
    mountLanes(null, [{ ...branchPhase(10), land: { value: 'hold', source: 'plan' } }]);
    expect(screen.getByTestId('land-words')).toHaveTextContent('Land: hold');
  });

  it('says where the landing has got to once the engine has written a state, on its own row only', () => {
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
    mountLanes(state, [{ ...branchPhase(10), land: { value: 'pr', source: 'plan' } }, branchPhase(11)]);
    const words = screen.getAllByTestId('landing-words');
    expect(words).toHaveLength(1);
    expect(words[0]).toHaveTextContent('landing pr-open');
    expect(words[0]!.closest('tr')).toHaveAttribute('data-phase', '10');
    expect(words[0]!.getAttribute('title')).toMatch(/Watching the pull request/);
  });

  it('says a parked landing is a person’s next step — and never paints it failed: nothing failed', () => {
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
    mountLanes(state, [branchPhase(10)]);
    const words = screen.getByTestId('landing-words');
    expect(words).toHaveTextContent('landing conflict, parked');
    expect(words).toHaveAttribute('data-landing-step', 'parked');
    expect(words.getAttribute('title')).toMatch(/a person owns the next step/);
    // The engine set the phase aside and drove on: ink, never the failed hue.
    expect(words.className).not.toMatch(/state-failed|text-failed/);
  });
});

describe('PhaseTable — the lane says what it did last (control-tower phase 95, #138)', () => {
  it("a live row carries the newest event of its session's own log; a row with no lane carries none", () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    const client = clientWithState();
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
    mount(
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
      />,
      client,
    );
    const lines = screen.getAllByTestId('last-activity');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Bash — Run the iOS sweep, running');
    expect(lines[0]!.closest('tr')).toHaveAttribute('data-phase', '3');
  });
});

/* ------------------------------------------------------------------------- *
 * The one phase table (control-tower phase 23, #25 #26 #27 #28; quiet-console
 * phase 10, exit criterion 1)
 * ------------------------------------------------------------------------- */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const CONTEXTS = ['run', 'plan', 'plan-record'] as const satisfies readonly PhaseTableContext[];

describe('the one phase table — both pages, one column array', () => {
  it('exit 1: every context is PHASE_COLUMNS, in its order — a context only marks what it hides as Everything', () => {
    expect(
      SOURCE.match(/: readonly Column<PhaseTableRow>\[\] = \[/g),
      'one column array, not two',
    ).toHaveLength(1);
    const ids = PHASE_COLUMNS.map((c) => c.id);
    for (const context of CONTEXTS) {
      const hidden = new Set(PHASE_TABLE_CONTEXTS[context].hidden);
      // A reading may only HIDE columns of the array — never bring its own.
      for (const id of hidden) expect(ids, `${context} hides '${id}'`).toContain(id);
      const columns = columnsFor(context);
      expect(
        columns.map((c) => c.id),
        context,
      ).toEqual(ids);
      columns.forEach((column, i) => {
        const original = PHASE_COLUMNS[i]!;
        if (hidden.has(column.id) && !original.identity) {
          expect(column.everything, `${context}: ${column.id} folds`).toBe(true);
          // …and NOTHING else about it differs: the same head, cell, value, filter.
          const { everything: _hiddenFlag, ...rest } = column;
          const { everything: _ownFlag, ...own } = original;
          expect(rest, `${context}: ${column.id}`).toEqual(own);
        } else {
          expect(column, `${context}: ${column.id} is the array's own column`).toBe(original);
        }
      });
    }
    // The identity is never hidden: it holds the row's toggle and its link.
    expect(PHASE_COLUMNS.find((c) => c.identity)?.id).toBe('phase');
  });

  it('exit 2: the run page and every plan reading draw their heads from the ONE array, in its order', async () => {
    const heads = PHASE_COLUMNS.map((c) => c.head);
    for (const context of CONTEXTS) {
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
      const shown = headers();
      // Every header is a column of the array, in the array's order…
      expect(
        shown.every((h) => heads.includes(h)),
        `${context}: ${shown.join(', ')}`,
      ).toBe(true);
      expect(shown).toEqual(heads.filter((h) => shown.includes(h)));
      // …and what the reading hides is not a header, but is counted on the row.
      const hiddenHeads = PHASE_TABLE_CONTEXTS[context].hidden.map(
        (id) => PHASE_COLUMNS.find((c) => c.id === id)!.head,
      );
      for (const head of hiddenHeads) expect(shown, `${context} folds ${head}`).not.toContain(head);
      expect(within(rowOf('Only one')).getByText(`+${hiddenHeads.length}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('exit 4 (#27): the QA column keeps the round and the three-state regime with its deciding level', async () => {
    mount(
      <PhaseTable
        context="plan-record"
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
    expect(reviewed.textContent).toContain('on, phase directive');
    // The verdict IS the way to its report — the sheet keeps its address.
    expect(within(reviewed).getByRole('link', { name: /QA fail — open the report/ })).toHaveAttribute(
      'href',
      '#/plan/demo/phases?view=handoffs&report=2:2',
    );
    expect(reviewed.querySelector('[data-status="fail"]')).toBeInTheDocument();
    expect(screen.getByTestId('qa-3').textContent).toContain('waived, plan');
    // …and a phase held by that verdict says so in its OWN blocked-by reason.
    const held = rowOf('Held');
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
    expect(silence.textContent).toMatch(/^no productive output \S+, flagged at 10m$/);
    const lane = screen.getByTestId('lane-4');
    expect(lane.textContent).toContain('attempt 2');
    expect(lane.textContent).toContain('this attempt');
  });

  it('exit 9 (#25): tasks, spend and the attempt clock move on run:progress and a local tick — zero fetches', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('a live table must not fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    const client = clientWithState();
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
            tasks: [
              { id: '1', content: 'Read the plan', activeForm: 'read the plan', status: 'in_progress' },
              { id: '2', content: 'Write the tests', activeForm: 'write the tests', status: 'pending' },
              { id: '3', content: 'Ship', activeForm: 'shipping', status: 'pending' },
            ],
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
    mount(<Page />, client);
    const row = () => rowOf('Live one');
    await screen.findByRole('link', { name: 'Live one' });
    expect(row().textContent).toContain('$1.00');
    expect(within(row()).getByTestId('task-words').textContent).toBe('0 of 3 tasks, read the plan');
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
    expect(within(row()).getByTestId('task-words').textContent).toBe('2 of 3 tasks, write the tests');
    // …and the clock moves on its own, between frames.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
    expect(screen.getByTestId('lane-7').textContent).not.toBe(clockBefore);
    expect(fetchSpy, 'not one request for a frame and a tick').not.toHaveBeenCalled();
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
    expect(needs.map((b) => [b.textContent, b.getAttribute('aria-expanded')])).toEqual([
      ['Need: Ready1', 'true'],
      ['Need: Waiting1', 'true'],
      ['Need: Done1', 'false'],
    ]);

    const groupBy = async (choice: string) => {
      fireEvent.click(screen.getByRole('button', { name: /^Group/ }));
      const sheet = await screen.findByRole('dialog', { name: 'Group' });
      fireEvent.click(within(sheet).getByRole('radio', { name: choice }));
      await close(sheet);
    };
    // By SCOPE…
    await groupBy('Scope');
    expect(await screen.findByRole('button', { name: /^Scope:\s*web/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Scope:\s*api/ })).toBeInTheDocument();
    // …and in PLAN ORDER: no headings, the rows as the plan numbers them.
    await groupBy('Plan order');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(Scope|Need):/ })).toBeNull());
    expect(screen.getAllByRole('link', { name: /^(First|Second|Third)$/ }).map((a) => a.textContent)).toEqual(
      ['First', 'Second', 'Third'],
    );

    // The column set is REMEMBERED: hide Size, and a fresh mount has no Size.
    fireEvent.click(screen.getByRole('button', { name: /^Columns/ }));
    const columns = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(
      within(within(columns).getByRole('group', { name: 'Columns' })).getByRole('checkbox', { name: 'Size' }),
    );
    await close(columns);
    expect(getPrefs().tables?.['phases.plan']?.hidden).toContain('size');
    unmount();
    mount(table);
    await screen.findByRole('link', { name: 'Third' });
    expect(screen.queryByRole('columnheader', { name: 'Size' })).toBeNull();
    expect(getPrefs().tables?.['phases.plan']?.groupBy).toBeNull();
  });

  it('a 72-phase plan draws a window of its rows, and a filter narrows it', async () => {
    const many = Array.from({ length: 72 }, (_, i) =>
      phase({ phase: i + 1, title: `Step ${i + 1}`, state: 'waiting' }),
    );
    render(
      <main>
        {wrap(
          <PhaseTable context="plan" slug="demo" run={null} planPhases={many} live={false} allowRun />,
          clientWithState(),
        )}
      </main>,
    );
    const table = await screen.findByRole('table', { name: 'Phases' });
    // Past `PHASE_VIRTUAL_FROM` the table says how many rows it has — the
    // Waiting heading and 72 phases, and its own header — while holding fewer.
    expect(PHASE_VIRTUAL_FROM).toBeLessThan(many.length);
    await expect.poll(() => table.getAttribute('aria-rowcount')).toBe(String(many.length + 2));
    expect(table.querySelectorAll('tr[data-phase]').length).toBeLessThan(many.length);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Step 33' } });
    await waitFor(() => expect(table.querySelectorAll('tr[data-phase]')).toHaveLength(1));
    expect(screen.getByRole('link', { name: 'Step 33' })).toBeInTheDocument();
    expect(table.hasAttribute('aria-rowcount')).toBe(false);
  });
});

describe('the phases as strips (Tower strips)', () => {
  it('each row is a strip in its board hue, its plate before its name, its state the ONE lead badge', async () => {
    setPrefs({ tables: { 'phases.plan': { collapsed: [] } } });
    mount(
      <PhaseTable
        context="plan"
        slug="demo"
        run={null}
        planPhases={[
          phase({
            phase: 1,
            state: 'done',
            title: 'Laid',
            qa: { result: 'pass' },
            handoff: { status: 'complete', skillsUsed: [], prompts: 0 } as never,
          }),
          phase({ phase: 2, state: 'stuck', title: 'Blocked one' }),
          phase({ phase: 3, state: 'ready', title: 'Behind a gate', gated: true }),
          phase({ phase: 4, state: 'ready', title: 'Next' }),
          phase({ phase: 17, state: 'waiting', title: 'Later' }),
        ]}
        live={false}
        allowRun
      />,
    );
    await screen.findByRole('link', { name: 'Laid' });
    // The edge is the lead badge's own hue — the word beside it — so a stuck
    // phase is violet like its "Stuck": amber is never derived from a status
    // word (design.md §3.1), and a gate says so in its own badge.
    expect(rowOf('Laid')).toHaveAttribute('data-strip', 'done');
    expect(rowOf('Blocked one')).toHaveAttribute('data-strip', 'waiting');
    expect(rowOf('Behind a gate')).toHaveAttribute('data-strip', 'queued');
    expect(rowOf('Next')).toHaveAttribute('data-strip', 'queued');
    expect(rowOf('Later')).toHaveAttribute('data-strip', 'waiting');
    expect(rowOf('Blocked one').querySelector('td [data-strip-edge]')).toHaveClass('state-waiting');
    for (const name of ['Laid', 'Blocked one', 'Behind a gate', 'Next', 'Later']) {
      const lead = rowOf(name).querySelector('[data-chrome="tint"]');
      expect(lead, `${name}: the edge and the lead badge are one colour`).toHaveAttribute(
        'data-paint',
        rowOf(name).getAttribute('data-strip'),
      );
    }
    // The plate: the phase number, tabular, before the name.
    const plate = rowOf('Later').querySelector('[data-plate]')!;
    expect(plate).toHaveTextContent(/^P17$/);
    expect(plate).toHaveClass('tabular-nums', 'font-semibold', 'bg-ground-deep');
    expect(
      plate.compareDocumentPosition(within(rowOf('Later')).getByRole('link', { name: 'Later' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ONE lead badge per strip — the state — and the record's badges outlined.
    const laid = rowOf('Laid');
    expect(laid.querySelectorAll('[data-chrome="tint"]')).toHaveLength(1);
    expect(laid.querySelector('[data-chrome="tint"]')).toHaveAttribute('data-vocab', 'board');
    expect(laid.querySelector('[data-vocab="qa-result"]')).toHaveAttribute('data-chrome', 'badge');
  });

  it('opens a strip onto its state’s tint, the edge running down its detail', async () => {
    setPrefs({ tables: { 'phases.plan': { collapsed: [] } } });
    mount(
      <PhaseTable
        context="plan"
        slug="demo"
        run={null}
        planPhases={[phase({ phase: 2, state: 'stuck', title: 'Blocked one' })]}
        live={false}
        allowRun
      />,
    );
    await screen.findByRole('link', { name: 'Blocked one' });
    openRow('Blocked one');
    const row = rowOf('Blocked one');
    expect(row).toHaveClass('state-waiting', 'bg-state-tint');
    const detail = row.nextElementSibling!.querySelector('td')!;
    expect(detail).toHaveClass('bg-state-tint', 'state-waiting');
    expect(detail.querySelector('[data-strip-edge]')).toHaveClass('state-waiting');
  });
});

describe('Handoffs & QA — an opened row leads with the record', () => {
  it('draws the handoff and the QA as two cards, before the verbs, each with its one lead badge', async () => {
    mount(
      <PhaseTable
        context="plan-record"
        slug="demo"
        run={null}
        planPhases={[
          phase({
            phase: 2,
            state: 'done',
            title: 'Reviewed',
            qa: { result: 'fail', report: 'reports/phase-02-qa.md' },
            qaMode: { mode: 'on', source: 'plan' },
            handoff: { status: 'complete', completed: '2026-10-01', skillsUsed: [], prompts: 0 } as never,
          }),
        ]}
        live={false}
        allowRun
        recovery={{ allowAgent: false, qaMode: 'on' }}
      />,
    );
    await screen.findByRole('link', { name: 'Reviewed' });
    openRow('Reviewed');
    const cards = await screen.findByTestId('phase-record-2');
    // Side by side from 40 rem of room — a container query, so the panel and a narrow page stack them.
    expect(cards).toHaveClass('@container/record');
    expect(cards.firstElementChild).toHaveClass('@min-[40rem]/record:grid-cols-2');
    const handoff = within(cards).getByTestId('record-handoff');
    const qa = within(cards).getByTestId('record-qa');
    expect(handoff.compareDocumentPosition(qa) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(handoff).getByRole('heading', { name: 'Handoff' })).toBeInTheDocument();
    expect(handoff.querySelector('[data-chrome="tint"]')).toHaveAttribute('data-vocab', 'handoff');
    expect(handoff.querySelector('[data-chrome="tint"]')).toHaveAttribute('data-status', 'complete');
    expect(handoff).toHaveTextContent('Completed 2026-10-01');
    expect(qa.querySelectorAll('[data-chrome="tint"]')).toHaveLength(1);
    expect(qa.querySelector('[data-chrome="tint"]')).toHaveAttribute('data-status', 'fail');
    // The record leads; the rest of the drawer follows and does not draw the two again.
    const drawer = screen.getByTestId('phase-drawer-2');
    expect(cards.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('drawer-qa')).toHaveLength(1);
    expect(within(drawer).queryByTestId('drawer-qa')).toBeNull();
  });

  it('the table reading opens a row onto the drawer as before — no record cards', async () => {
    mount(
      <PhaseTable
        context="plan"
        slug="demo"
        run={null}
        planPhases={[phase({ phase: 2, state: 'ready', title: 'Plain' })]}
        live={false}
        allowRun
      />,
    );
    await screen.findByRole('link', { name: 'Plain' });
    openRow('Plain');
    await screen.findByTestId('phase-drawer-2');
    expect(screen.queryByTestId('phase-record-2')).toBeNull();
    expect(within(screen.getByTestId('phase-drawer-2')).getByTestId('drawer-qa')).toBeInTheDocument();
  });
});

describe('Inspect — the phase in the panel', () => {
  /** What the panel holds: its key, and the identity row it draws. */
  function Panel() {
    const record = useInspected();
    return record ? (
      <div data-testid="panel" data-key={record.key}>
        {record.meta}
      </div>
    ) : null;
  }

  const board = (state: string, record?: Record<string, unknown>) => (
    <>
      <PhaseTable
        slug="demo"
        run={
          record ? run({ phases: { 3: { phase: 3, attempts: 1, costUsd: 0, ...record } } } as never) : null
        }
        planPhases={[phase({ phase: 3, title: 'Third', state })]}
        live={false}
        allowRun
        inspectable
      />
      <Panel />
    </>
  );

  it('puts the phase in the panel under its key, and the door to it is inked above the AA floor', async () => {
    mount(board('ready'));
    const inspect = await screen.findByRole('button', { name: 'Inspect phase 3' });
    // `--ink-faint` clears only the large-text floor; this word is 12.5 px,
    // and an affordance is never metadata (design.md §3).
    expect(inspect.className).toContain('text-ink-muted');
    expect(inspect.className).not.toContain('text-ink-faint');
    expect(screen.queryByTestId('panel')).toBeNull();
    fireEvent.click(inspect);
    const panel = await screen.findByTestId('panel');
    expect(panel).toHaveAttribute('data-key', phaseInspectKey('demo', 3));
    expect(panel.querySelector('[data-status]')).toHaveAttribute('data-status', 'ready');
  });

  it('refreshes the inspected phase in place when the board moves', async () => {
    const { rerender } = mount(board('ready'));
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect phase 3' }));
    expect((await screen.findByTestId('panel')).querySelector('[data-status]')).toHaveAttribute(
      'data-status',
      'ready',
    );
    // The phase finishes: the row folds under Done, and the panel follows the board.
    rerender(board('done', { status: 'done' }));
    await waitFor(() =>
      expect(screen.getByTestId('panel').querySelector('[data-status]')).toHaveAttribute(
        'data-status',
        'done',
      ),
    );
    expect(screen.getByTestId('panel')).toHaveAttribute('data-key', phaseInspectKey('demo', 3));
  });

  it('is offered only where the page asks for it', async () => {
    mount(
      <PhaseTable
        slug="demo"
        run={null}
        planPhases={[phase({ phase: 3, title: 'Third' })]}
        live={false}
        allowRun
      />,
    );
    await screen.findByRole('link', { name: 'Third' });
    expect(screen.queryByRole('button', { name: /^Inspect/ })).toBeNull();
  });
});

/*
 * Below the shell breakpoint — the same records as a list (ported from
 * `phase-cards.test.tsx`). What these hold: the list is the same board, not a
 * reduced one. At 390 px the old twelve-column cut folded nine columns away
 * and put every remedy behind a disclosure triangle — so the remedy is on the
 * record, the runner's last word and the way in are on it, the money is one
 * press away, the group headings fold from the same preference, and nothing
 * inside a record is a table.
 */
describe('the phase board on a phone', () => {
  beforeEach(() => {
    media.phone = true;
  });

  const cards = () => (
    <PhaseTable
      slug="demo"
      run={run({
        phases: {
          1: { phase: 1, status: 'done', attempts: 1, costUsd: 1.25, turns: 6, durationMs: 90_000 },
          2: { phase: 2, status: 'failed', attempts: 2, costUsd: 3.5, note: 'did not verify' },
        },
      } as never)}
      planPhases={[
        phase({ phase: 1, state: 'done', title: 'Editor truth' }),
        phase({ phase: 2, state: 'ready', title: 'Ship it' }),
      ]}
      live={false}
      allowRun
    />
  );
  const cardOf = (title: string) => screen.getByRole('link', { name: title }).closest('li') as HTMLElement;

  it('draws records, not a table', async () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    mount(cards());
    await screen.findByRole('link', { name: 'Ship it' });
    expect(screen.queryByRole('table')).toBeNull();
    // One record per phase, each a real list item.
    for (const title of ['Editor truth', 'Ship it']) expect(cardOf(title)).toBeTruthy();
  });

  it('carries the facts a phone is opened for: the state, the runner’s word and the way in — the money one press away', async () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    mount(cards());
    await screen.findByRole('link', { name: 'Ship it' });
    const card = cardOf('Ship it');
    expect(card.querySelector('[data-status="ready"]')).toBeInTheDocument();
    // The runner's own last word, in full on the record — a `title` is not
    // reachable with a thumb.
    expect(within(card).getAllByText('did not verify').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute('href', '#/plan/demo/phase/2');
    expect(within(card).queryByText('$3.50')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /^Details/ }));
    expect(within(card).getByText('$3.50')).toBeInTheDocument();
  });

  it('keeps the remedy ON the record — it is why the page is open — and every verb one press away', async () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    mount(cards());
    await screen.findByRole('link', { name: 'Ship it' });
    const card = cardOf('Ship it');
    const onRecord = within(card)
      .getAllByRole('button')
      .filter((b) => !/^Details/.test(b.textContent ?? ''));
    expect(onRecord.length).toBeGreaterThan(0);
    fireEvent.click(within(card).getByRole('button', { name: /^Details/ }));
    expect(within(card).getByRole('button', { name: /Run only this/i })).toBeInTheDocument();
  });

  it('folds Done from the same view the desk keeps', async () => {
    // One view per reading (`tableId`), kept in `prefs.tables` — the desk's
    // table and the phone's records are the same grid, so a fold made on either
    // is the fold on both.
    setPrefs({ tables: { 'phases.run': { collapsed: ['need:done'] } } });
    mount(cards());
    expect(await screen.findByRole('link', { name: 'Ship it' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Editor truth' })).toBeNull());
    expect(getPrefs().tables?.['phases.run']?.collapsed).toEqual(['need:done']);
  });

  it('has no axe violations', async () => {
    setPrefs({ tables: { 'phases.run': { collapsed: [] } } });
    const { container } = mount(cards());
    await screen.findByRole('link', { name: 'Ship it' });
    await expectNoAxeViolations(container);
  });
});
