/**
 * The QA verdicts list — the one surface that renders `test-status.md`.
 *
 * Three properties:
 *
 * 1. **A verdict is painted through the QA vocabulary**, so `fail` reads the
 *    same hue here as on the phase row and on the board. The list used to
 *    carry a local `pass|fail|waived → tone` table, which is a fourth opinion
 *    about a word three other files already own.
 * 2. **It can be asked for the failures first.** Worst-first is not a rank
 *    written here — it is the verdict's position in `UI_STATES`, the
 *    vocabulary's own worst-first order — so a word this console does not know
 *    sorts last rather than first. Twenty-two `pass` rows in plan order with
 *    one `fail` somewhere in them is what the control is for.
 * 3. **A long plan is bounded, and says so.** Twenty rows, then a button that
 *    names how many are behind it.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { expectNoAxeViolations } from '@/test/axe';
import { PlanRecord } from './index';

const verdicts = (rows: { phase: number; result: string; report?: string }[]) => rows;

function mount(qa: { phase: number; result: string; report?: string }[]) {
  return render(
    <TooltipProvider>
      <PlanRecord slug="demo" qa={qa} />
    </TooltipProvider>,
  );
}

const order = () =>
  screen
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '')
    .map((text) => text.slice(0, 2));

describe('the QA verdicts list', () => {
  it('links every row to its handoff and names the report file it stands on', () => {
    mount(verdicts([{ phase: 4, result: 'pass', report: 'docs/handoffs/demo/qa-4.md' }]));
    expect(screen.getByRole('link', { name: 'P4' })).toHaveAttribute('href', '#/plan/demo/handoff/4');
    expect(screen.getByTitle('docs/handoffs/demo/qa-4.md')).toBeInTheDocument();
  });

  it('says so rather than nothing when a verdict has no report behind it', () => {
    mount(verdicts([{ phase: 1, result: 'waived' }]));
    expect(screen.getByText('no report file')).toBeInTheDocument();
  });

  it('opens in plan order and can be asked for the failures first', () => {
    mount(
      verdicts([
        { phase: 1, result: 'pass' },
        { phase: 2, result: 'waived' },
        { phase: 3, result: 'fail' },
      ]),
    );
    expect(order()).toEqual(['P1', 'P2', 'P3']);
    fireEvent.click(screen.getByRole('button', { name: 'Verdict' }));
    // Worst first, straight off `UI_STATES`: failed, then skipped, then done.
    expect(order()).toEqual(['P3', 'P2', 'P1']);
    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    expect(order()).toEqual(['P1', 'P2', 'P3']);
  });

  it('offers no order at all for a list with one row in it', () => {
    mount(verdicts([{ phase: 1, result: 'pass' }]));
    expect(screen.queryByRole('button', { name: 'Verdict' })).toBeNull();
  });

  it('shows twenty rows and names how many are behind the button', () => {
    mount(verdicts(Array.from({ length: 22 }, (_, i) => ({ phase: i + 1, result: 'pass' }))));
    expect(order()).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 22' }));
    expect(order()).toHaveLength(22);
    fireEvent.click(screen.getByRole('button', { name: 'Show the first 20' }));
    expect(order()).toHaveLength(20);
  });

  it('reads an absent list as "QA was never asked for", with the plan file one press away', () => {
    mount([]);
    expect(screen.getByText('QA is off for this plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /QA line/ })).toHaveAttribute('href', '#/plan/demo/source');
  });

  it('has no axe violations with verdicts on screen', async () => {
    const { container } = mount(
      verdicts([
        { phase: 1, result: 'pass', report: 'docs/handoffs/demo/qa-1.md' },
        { phase: 2, result: 'fail' },
      ]),
    );
    await expectNoAxeViolations(container);
  });
});
