/**
 * The Source tab — the plan file, read two ways.
 *
 * Four properties:
 *
 * 1. **The phase graph never renders headers over nothing.** An empty graph is
 *    not "a plan with no phases", it is `phase-graph.sh` failing to parse the
 *    plan's own table — so the empty state says that, and offers the markdown,
 *    which is where the malformed cell is.
 * 2. **The row is a link and nothing is painted over the cells.** Same ban as
 *    the handoffs table; swept as source text for the same reason (jsdom has
 *    no pseudo elements and no layout).
 * 3. **Every cell that prints the plan's own prose is cut against its column
 *    and carries the whole value on hover.** Exit criteria is a sentence, and
 *    unclamped the tallest one set the height of every row in the table.
 * 4. **Nothing here sizes itself in `vh`.** The raw file's box used to be
 *    `70vh` — the LARGE viewport, which ignores the iOS software keyboard.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';
import type { PlanDetail } from '@/lib/api';
import { SourceTab } from './source-tab';

const here = dirname(fileURLToPath(import.meta.url));

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

const detail = (graph: ReturnType<typeof graphRow>[] | undefined): PlanDetail =>
  ({
    summary: { slug: 'demo', phases: 1 },
    phases: [],
    locks: [],
    plan: {
      slug: 'demo',
      graph,
      sessionBudget: { raw: '**Target model:** opus' },
      callouts: [],
    },
  }) as unknown as PlanDetail;

function mount(view: PlanDetail) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <SourceTab detail={view} slug="demo" view="reading" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the phase graph table', () => {
  it('names the parse failure rather than showing headers over nothing', () => {
    mount(detail([]));
    expect(screen.getByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('No machine-readable phase graph')).toBeInTheDocument();
    // The way out is the file itself: a malformed cell is only visible there.
    expect(screen.getByRole('link', { name: 'Read the markdown' })).toHaveAttribute(
      'href',
      '#/plan/demo/source?view=raw',
    );
  });

  it('points each row at its phase without covering the cells beside it', () => {
    const source = readFileSync(join(here, 'source-tab.tsx'), 'utf8');
    expect(source).not.toMatch(/after:inset-0/);
    expect(source).not.toMatch(/rowClassName=\{\(\) => 'relative'\}/);

    mount(detail([graphRow({ phase: 3, title: 'Cutover' })]));
    const row = screen.getByRole('row', { name: /Cutover/ });
    expect(within(row).getByRole('link')).toHaveAttribute('href', '#/plan/demo/phase/3');
  });

  it('clamps exit criteria to two lines and keeps the whole sentence on hover', () => {
    mount(detail([graphRow({ exitCriteria: LONG_EXIT })]));
    const cell = screen.getByTitle(LONG_EXIT);
    expect(cell.className).toContain('line-clamp-2');
  });

  it('cuts the raw parallel-safe and repos cells against their columns', () => {
    mount(detail([graphRow({ parallelSafe: 'P2, P3, P4', repos: 'hub, viewer, scripts' })]));
    expect(screen.getByTitle('P2, P3, P4').className).toContain('truncate');
    expect(screen.getByTitle('hub, viewer, scripts').className).toContain('truncate');
  });

  it('sizes the raw file by --app-height, never by the large viewport', () => {
    // `vh` on iOS ignores the software keyboard, so a box sized in it grows
    // past the screen the moment anything on the page takes focus.
    const source = readFileSync(join(here, 'source-tab.tsx'), 'utf8')
      .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\d+vh\b/);
    expect(source).toMatch(/var\(--app-height,100%\)/);
  });

  it('has no axe violations with a parsed graph on screen', async () => {
    const { container } = mount(detail([graphRow(), graphRow({ phase: 2, title: 'Surface' })]));
    await expectNoAxeViolations(container);
  });
});

describe('the Decisions card', () => {
  it('shows each row’s state and source and its evidence, and a per-phase row under its phase', () => {
    const view = detail([graphRow()]);
    (view.plan as unknown as { decisions: unknown[] }).decisions = [
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
    mount(view);
    expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Phase' })).toBeInTheDocument();
    expect(screen.getByText('ruling')).toBeInTheDocument();
    expect(screen.getByText('ruling abcdef012345')).toBeInTheDocument();
    expect(screen.getByText('p4')).toBeInTheDocument();
    expect(screen.getByText('outstanding')).toBeInTheDocument();
  });

  it('asks for no Phase column when every row is plan-wide', () => {
    const view = detail([graphRow()]);
    (view.plan as unknown as { decisions: unknown[] }).decisions = [
      {
        key: 'gates',
        value: 'delegated',
        owner: 'operator',
        state: 'answered',
        blocking: 'no',
        source: 'plan',
        evidence: '',
        phase: null,
      },
    ];
    mount(view);
    expect(screen.queryByRole('columnheader', { name: 'Phase' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
  });
});
