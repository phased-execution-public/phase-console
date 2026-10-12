/**
 * The Source view — the plan file, read two ways (7.0, quiet-console phase 10;
 * ported from `features/plans/source-tab.test.tsx`).
 *
 * The 6.2 properties, kept:
 *
 * 1. **The phase graph never renders headers over nothing.** An empty graph is
 *    not "a plan with no phases", it is `phase-graph.sh` failing to parse the
 *    plan's own table — so the empty state says that, and offers the markdown,
 *    which is where the malformed cell is.
 * 2. **The row is a link and nothing is painted over the cells** — swept as
 *    source text, because jsdom has no pseudo elements and no layout.
 * 3. **Every cell that prints the plan's own prose is cut against its column
 *    and carries the whole value on hover** — and, new in 7.0, whole in the
 *    row's fold, because a phone has no hover.
 * 4. **Nothing here sizes itself in `vh`.** The raw file's box is bounded by
 *    `--app-height`, which knows about the iOS keyboard.
 *
 * And 7.0's: one column (the 6.x two-column grid is gone); a decision's state
 * is a dot and a word from the typed family, a misspelt one the plan's own
 * text; the raw reading is an address flipped in place; and the engine fold
 * sits at the foot without spending an engine call.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDetail } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import type { SourceView } from '../tabs';
import { SourceTab } from './source-tab';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, 'source-tab.tsx'), 'utf8');
/** The file with its comments blanked — a rule about what ships is not tripped by a sentence about it. */
const CODE = SOURCE.replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, '').replace(/^[ \t]*\/\/.*$/gm, '');

const { planRaw, boardText, memoryBlock, sessionPlan, state } = vi.hoisted(() => ({
  planRaw: vi.fn(),
  boardText: vi.fn(),
  memoryBlock: vi.fn(),
  sessionPlan: vi.fn(),
  state: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, planRaw, boardText, memoryBlock, sessionPlan, state } };
});

const LONG_EXIT =
  'Every phase row survives a 1024px window, the sticky header binds to the shell scroller, and the ' +
  'engine parity test re-derives the same board from the JS parser';

const graphRow = (over: Record<string, unknown> = {}) => ({
  phase: 1,
  title: 'Foundations',
  dependsOn: [],
  parallelSafe: '',
  repos: '',
  exitCriteria: 'the suite passes',
  ...over,
});

const detail = (
  graph: ReturnType<typeof graphRow>[] | undefined,
  over: Record<string, unknown> = {},
): PlanDetail =>
  ({
    summary: { slug: 'demo', phases: 1 },
    phases: [],
    locks: [],
    plan: {
      slug: 'demo',
      graph,
      sessionBudget: { raw: '**Target model:** opus', targetModel: 'opus', skills: [], mcpServers: [] },
      callouts: [],
    },
    ...over,
  }) as unknown as PlanDetail;

const DECISIONS = [
  {
    key: 'gates',
    value: 'delegated',
    owner: 'operator',
    state: 'answered',
    blocking: 'no',
    source: 'plan',
    evidence: 'phases 22–23',
    phase: null,
  },
  {
    key: 'waits',
    value: 'window',
    owner: 'operator',
    state: 'outstanding',
    blocking: 'yes',
    source: 'ruling',
    evidence: 'ruling abcdef012345',
    phase: 4,
  },
];

const withDecisions = (decisions: unknown[]): PlanDetail => {
  const view = detail([graphRow()]);
  (view.plan as unknown as { decisions: unknown[] }).decisions = decisions;
  return view;
};

beforeEach(() => {
  planRaw.mockReset().mockResolvedValue('# demo\n\n## Phase graph\n| Phase | Title |\n');
  boardText.mockReset().mockResolvedValue('demo board');
  memoryBlock.mockReset().mockResolvedValue('done: 1');
  sessionPlan.mockReset().mockResolvedValue({ raw: 'S1 P1', groups: [] });
  state.mockReset().mockResolvedValue({ models: ['opus'] });
});

afterEach(() => {
  window.location.hash = '';
});

function mount(view: PlanDetail, reading: SourceView = 'reading') {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <SourceTab detail={view} slug="demo" view={reading} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the phase graph table', () => {
  it('names the parse failure rather than showing headers over nothing', () => {
    mount(detail([]));
    expect(screen.getByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText(/No machine-readable phase graph/)).toBeInTheDocument();
    // The way out is the file itself: a malformed cell is only visible there.
    expect(screen.getByRole('link', { name: 'Read the markdown' })).toHaveAttribute(
      'href',
      '#/plan/demo/source?view=raw',
    );
  });

  it('points each row at its phase without covering the cells beside it', () => {
    expect(SOURCE).not.toMatch(/after:inset-0/);
    expect(SOURCE).not.toMatch(/rowClassName=\{\(\) => 'relative'\}/);

    mount(detail([graphRow({ phase: 3, title: 'Cutover' })]));
    const row = screen.getByRole('row', { name: /Cutover/ });
    expect(within(row).getByRole('link')).toHaveAttribute('href', '#/plan/demo/phase/3');
  });

  it('clamps exit criteria to two lines, keeps the whole sentence on hover, and whole in the row’s fold', () => {
    mount(detail([graphRow({ exitCriteria: LONG_EXIT })]));
    const cell = screen.getByTitle(LONG_EXIT);
    expect(cell.className).toContain('line-clamp-2');
    // A phone has no hover: the row opens in place onto the whole value.
    fireEvent.click(screen.getByRole('button', { name: /Show the rest of this row/ }));
    expect(screen.getByText('Exit criteria, whole')).toBeInTheDocument();
    expect(screen.getAllByText(LONG_EXIT).length).toBeGreaterThan(1);
  });

  it('cuts the raw parallel-safe and repos cells against their columns', () => {
    mount(detail([graphRow({ parallelSafe: 'P2, P3, P4', repos: 'hub, viewer, scripts' })]));
    expect(screen.getByTitle('P2, P3, P4').className).toContain('truncate');
    expect(screen.getByTitle('hub, viewer, scripts').className).toContain('truncate');
  });

  it('sizes the raw file by --app-height, never by the large viewport', () => {
    // `vh` on iOS ignores the software keyboard, so a box sized in it grows
    // past the screen the moment anything on the page takes focus.
    expect(CODE).not.toMatch(/\d+vh\b/);
    expect(CODE).toMatch(/var\(--app-height,100%\)/);
  });

  it('joins who waits on a row in from the board', () => {
    const view = detail([graphRow({ phase: 2, title: 'Surface', dependsOn: [1] })], {
      phases: [{ phase: 2, title: 'Surface', state: 'ready', analysis: { dependsOn: [1], unblocks: 3 } }],
    });
    mount(view);
    const row = screen.getByRole('row', { name: /Surface/ });
    expect(within(row).getByText('unblocks 3')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'P1' })).toHaveAttribute('href', '#/plan/demo/phase/1');
  });

  it('has no axe violations with a parsed graph on screen', async () => {
    const { container } = mount(detail([graphRow(), graphRow({ phase: 2, title: 'Surface' })]));
    await expectNoAxeViolations(container);
  });
});

describe('the Decisions table', () => {
  it('shows each row’s state and source and its evidence, and a per-phase row under its phase', () => {
    mount(withDecisions(DECISIONS));
    const table = screen.getByRole('table', { name: 'Decisions' });
    expect(within(table).getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Evidence' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Phase' })).toBeInTheDocument();
    expect(within(table).getByText('ruling')).toBeInTheDocument();
    expect(within(table).getByText('ruling abcdef012345')).toBeInTheDocument();
    expect(within(table).getByText('P4')).toBeInTheDocument();
    expect(within(table).getByText('Outstanding')).toBeInTheDocument();
  });

  it('asks for no Phase column when every row is plan-wide', () => {
    mount(withDecisions([{ ...DECISIONS[0], evidence: '' }]));
    const table = screen.getByRole('table', { name: 'Decisions' });
    expect(within(table).queryByRole('columnheader', { name: 'Phase' })).toBeNull();
    expect(within(table).getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
  });

  it('draws a known state as a dot and a word, and a misspelt one as the plan’s own breakable text', () => {
    mount(withDecisions([DECISIONS[1], { ...DECISIONS[0], key: 'typo', state: 'answerd' }]));
    const table = screen.getByRole('table', { name: 'Decisions' });
    const word = within(table).getByText('Outstanding').closest('[data-status]')!;
    expect(word).toHaveAttribute('data-vocab', 'decision');
    expect(word).toHaveAttribute('data-status', 'outstanding');
    const typo = within(table).getByText('answerd');
    expect(typo.closest('[data-status]')).toBeNull();
    expect(typo.className).toMatch(/wrap-anywhere/);
    // No nowrap anywhere in the view: a vocabulary cell that cannot wrap is
    // the escape `styles/touch.test.ts` hunts.
    expect(CODE).not.toMatch(/whitespace-nowrap/);
  });

  it('is absent from a plan that carries no manifest', () => {
    mount(detail([graphRow()]));
    expect(screen.queryByRole('table', { name: 'Decisions' })).toBeNull();
  });
});

describe('the reading', () => {
  it('is one column — the 6.x two-column grid is gone — prose at the measure', () => {
    expect(CODE).not.toMatch(/grid-cols-\[minmax\(0,1fr\)_minmax\(0,24rem\)\]/);
    expect(CODE).not.toMatch(/lg:grid-cols/);
    const view = detail([graphRow()]);
    (view.plan as unknown as { context: string }).context = 'Why this plan exists.';
    mount(view);
    const context = screen.getByTestId('source-context');
    expect(within(context).getByRole('heading', { name: 'Context' })).toBeInTheDocument();
    expect(
      within(context).getByText('Why this plan exists.').closest('.max-w-\\(--measure\\)'),
    ).not.toBeNull();
  });

  it('reads the file in its own order: context, approach, budget, decisions, graph, the end-to-end check', () => {
    const view = withDecisions(DECISIONS);
    Object.assign(view.plan as object, {
      provenance: 'Written from the 6.2 audit.',
      context: 'Why.',
      architecture: 'How.',
      endToEnd: 'Run the whole tour.',
    });
    mount(view);
    const order = [
      'source-provenance',
      'source-context',
      'source-architecture',
      'source-budget',
      'source-decisions',
      'source-graph',
      'source-end-to-end',
      'source-memory',
    ].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING: each section sits after the one before it.
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('shows the plan’s memory entry under its key, and says so when there is none', () => {
    const view = detail([graphRow()], {
      memory: {
        key: 'project_demo.md',
        path: '/m/project_demo.md',
        text: 'Remember the cutover.',
        indexLines: [],
      },
    });
    const { unmount } = mount(view);
    const memory = screen.getByTestId('source-memory');
    expect(within(memory).getByText('project_demo.md')).toBeInTheDocument();
    expect(within(memory).getByText('Remember the cutover.')).toBeInTheDocument();
    unmount();

    mount(detail([graphRow()], { memory: null }));
    expect(within(screen.getByTestId('source-memory')).getByText(/No memory entry for/)).toBeInTheDocument();
  });

  it('lists who holds which phase, and for how much longer', () => {
    mount(
      detail([graphRow()], {
        locks: [{ phase: 2, owner: 'session-abc', expired: false, leaseUntil: Date.now() + 3_600_000 }],
      }),
    );
    const locks = screen.getByTestId('source-locks');
    expect(within(locks).getByText('Phase 2')).toBeInTheDocument();
    expect(within(locks).getByText('session-abc')).toBeInTheDocument();
  });

  it('a slug with handoffs and no plan file says so, and offers the handoffs', () => {
    mount(detail(undefined, { plan: null }));
    expect(screen.getByText(/no plan file/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the handoffs' })).toHaveAttribute(
      'href',
      '#/plan/demo/phases?view=handoffs',
    );
    // Nothing for the engine to read without a plan.
    expect(screen.queryByTestId('engine-fold')).toBeNull();
  });
});

describe('the two readings', () => {
  it('flips to the markdown in place: the address is replaced, never pushed', () => {
    window.location.hash = '#/plan/demo/source';
    const pushes = window.history.length;
    mount(detail([graphRow()]));
    const markdown = screen.getByRole('button', { name: 'Markdown' });
    expect(markdown).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Reading' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(markdown);
    expect(window.location.hash).toBe('#/plan/demo/source?view=raw');
    expect(window.history.length).toBe(pushes);
  });

  it('reads the file byte for byte, with a copy and the path it came from', async () => {
    mount(detail([graphRow()]), 'raw');
    const raw = await screen.findByTestId('source-raw');
    expect(planRaw).toHaveBeenCalledWith('demo');
    expect(raw.querySelector('pre')!.textContent).toBe('# demo\n\n## Phase graph\n| Phase | Title |\n');
    expect(within(raw).getByRole('button', { name: /Copy markdown/ })).toBeInTheDocument();
    expect(screen.getByText('docs/plans/demo.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Markdown' })).toHaveAttribute('aria-pressed', 'true');
    // The prose reading is not drawn under the bytes.
    expect(screen.queryByTestId('source-graph')).toBeNull();
  });

  it('a file that could not be read is the server’s words, and a way to read it again', async () => {
    // Every attempt refuses — the client retries a read once before it says so.
    planRaw.mockRejectedValue(new Error('ENOENT: docs/plans/demo.md'));
    mount(detail([graphRow()]), 'raw');
    expect(await screen.findByText('ENOENT: docs/plans/demo.md')).toBeInTheDocument();
    planRaw.mockResolvedValue('# demo');
    fireEvent.click(screen.getByRole('button', { name: 'Read it again' }));
    expect(await screen.findByTestId('source-raw')).toBeInTheDocument();
  });

  it('keeps the engine fold at the foot, and opening the view asks the engine nothing', async () => {
    mount(detail([graphRow()]));
    const fold = screen.getByTestId('engine-fold');
    expect(
      screen.getByTestId('source-memory').compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The plan's target model names the session plan's command.
    expect(within(fold).getByRole('button', { name: /Session plan/ })).toHaveTextContent(
      '--session-plan opus',
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(boardText).not.toHaveBeenCalled();
    expect(memoryBlock).not.toHaveBeenCalled();
    expect(sessionPlan).not.toHaveBeenCalled();
  });
});
