/**
 * The Handoffs table — the row is a link, and every cell in it is still alive.
 *
 * Four properties, and the first is why this file exists:
 *
 * 1. **Nothing is painted over a row.** The identity cell used to carry
 *    `after:absolute after:inset-0`, which stretched an invisible sheet over
 *    every other cell — so the expander button and the Index-row chip stayed in
 *    the tab order and could not be pressed with a pointer. `rowHref` is the
 *    supported way and the ban is swept as source text, because a pseudo
 *    element has no presence in jsdom at all.
 * 2. **Every column that renders text the console did not write is cut against
 *    its column and carries the whole value on hover.** A handoff title is
 *    prose off the file's frontmatter; one long one used to set the height of
 *    every row beside it.
 * 3. **A status word is painted like a status word.** The Index-row column had
 *    the only bare status word in the console, beside a `missing` chip — two
 *    readings of one column that did not look like the same column.
 * 4. **An empty list says so inside the table's own frame**, with a way out.
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
import { HandoffsTab } from './handoffs-tab';

const here = dirname(fileURLToPath(import.meta.url));

const LONG_TITLE =
  'Rework the departures board so a phase row survives a 1024px window without losing its Phase column';

const handoff = (over: Record<string, unknown> = {}) =>
  ({
    phase: 1,
    title: 'Foundations',
    status: 'complete',
    completed: '2026-08-01',
    skillsUsed: [],
    bytes: 4096,
    dependsOn: [],
    blocks: [],
    ...over,
  }) as never;

const detail = (over: Partial<PlanDetail> = {}): PlanDetail =>
  ({
    summary: { slug: 'demo', phases: 3 },
    handoffs: [],
    index: [],
    ...over,
  }) as unknown as PlanDetail;

function mount(view: PlanDetail) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <HandoffsTab detail={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the handoffs table', () => {
  it('makes the row a link without painting anything over the cells beside it', () => {
    /*
     * Source text, not the DOM: `::after` is a pseudo element and jsdom has no
     * layout, so the only honest place to assert "nothing is stretched over
     * this row" is what ships. Both halves of the old device are banned — the
     * overlay classes AND the `relative` row that gave them a containing block.
     */
    const source = readFileSync(join(here, 'handoffs-tab.tsx'), 'utf8');
    expect(source).not.toMatch(/after:inset-0/);
    expect(source).not.toMatch(/rowClassName=\{\(\) => 'relative'\}/);
    expect(source).toMatch(/rowHref=\{\(handoff\) => handoffHref\(/);
  });

  it('points the row at the handoff, and leaves the other cells their own content', () => {
    mount(detail({ handoffs: [handoff({ phase: 2, title: 'Surface', status: 'in-progress' })] }));
    const row = screen.getByRole('row', { name: /Surface/ });
    expect(within(row).getByRole('link')).toHaveAttribute('href', '#/plan/demo/handoff/2');
    // The status is IN the row and is not the row's link — the overlay is what
    // used to make that distinction meaningless.
    expect(within(row).getByText('in-progress')).toBeInTheDocument();
  });

  it('cuts a long title against its column and keeps the whole one on hover', () => {
    mount(detail({ handoffs: [handoff({ title: LONG_TITLE })] }));
    const title = screen.getByTitle(LONG_TITLE);
    expect(title).toHaveTextContent(LONG_TITLE);
    expect(title.className).toContain('truncate');
  });

  it('cuts the skills list the same way rather than letting it set the row height', () => {
    const skills = ['phased-execution', 'frontend-design', 'systematic-debugging'];
    mount(detail({ handoffs: [handoff({ skillsUsed: skills })] }));
    expect(screen.getByTitle(skills.join(', ')).className).toContain('truncate');
  });

  it('paints the INDEX row status as a status, and a missing one as the warning it is', () => {
    mount(
      detail({
        handoffs: [handoff({ phase: 1 }), handoff({ phase: 2, title: 'Surface' })],
        index: [{ phase: 1, status: 'complete' } as never],
      }),
    );
    // Two readings of one column, and both are now chips — the plain grey word
    // read as a note about the row rather than a claim about it.
    const withRow = screen.getByRole('row', { name: /Foundations/ });
    expect(within(withRow).getAllByText('complete').length).toBeGreaterThan(0);
    const without = screen.getByRole('row', { name: /Surface/ });
    expect(within(without).getByText('missing')).toBeInTheDocument();
  });

  it('says the list is empty INSIDE the table, and offers the way work gets started', () => {
    mount(detail());
    // The columns are still named — the page does not change shape between
    // "nothing yet" and "one row".
    expect(screen.getByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('No handoffs yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the boot prompts' })).toHaveAttribute(
      'href',
      '#/plan/demo/route',
    );
  });

  it('has no axe violations with rows on screen', async () => {
    const { container } = mount(
      detail({
        handoffs: [handoff({ phase: 1 }), handoff({ phase: 2, title: 'Surface', status: 'blocked' })],
        index: [{ phase: 1, status: 'complete' } as never],
      }),
    );
    await expectNoAxeViolations(container);
  });
});
