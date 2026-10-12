/**
 * This plan's record — the one surface that renders `test-status.md`, drawn on
 * the grid since 7.0.
 *
 * Three properties:
 *
 * 1. **A verdict is painted through the QA vocabulary**, so `fail` reads the
 *    same hue here as on the phase row and on the board: a dot and its word
 *    (`QaStatus`), the raw word on `data-status`. The 6.x list once carried a
 *    local `pass|fail|waived → tone` table, a fourth opinion about a word three
 *    other files already own.
 * 2. **It can be asked for the failures first.** Worst-first is not a rank
 *    written here — it is the verdict's paint's place in `UI_STATES`, the
 *    vocabulary's own worst-first order — so a word this console does not know
 *    sorts last rather than first. Twenty-two `pass` rows in plan order with
 *    one `fail` somewhere in them is what the column's sort is for.
 * 3. **Every row shows, and the count is said.** 6.2 bounded the list at twenty
 *    rows behind a "Show all N" button; 7.0 dropped the bound, and the line
 *    above the grid names how many verdicts there are.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeWord } from '@shared/status-model.js';
import { setPrefs } from '@/lib/prefs';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import { PlanRecord, type QaRow } from './plan-record';

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {} });
  // A 400 px box, as the Repo ledger stubs it: the grid cuts its columns to
  // the width it measures, and at 400 every column of this one still fits.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
});

afterEach(() => vi.restoreAllMocks());

function mount(qa: QaRow[]) {
  return render(
    <TooltipProvider>
      <PlanRecord slug="demo" qa={qa} />
    </TooltipProvider>,
  );
}

/** The phases as the grid draws them, top to bottom — each row's link to its handoff. */
const order = () =>
  within(screen.getByRole('table', { name: 'QA verdicts' }))
    .getAllByRole('link', { name: /^P\d+$/ })
    .map((link) => link.textContent);

describe('the QA verdicts list', () => {
  it('links every row to its handoff and names the report file it stands on', () => {
    mount([{ phase: 4, result: 'pass', report: 'docs/handoffs/demo/qa-4.md' }]);
    expect(screen.getByRole('link', { name: 'P4' })).toHaveAttribute('href', '#/plan/demo/handoff/4');
    expect(screen.getByTitle('docs/handoffs/demo/qa-4.md')).toHaveAttribute(
      'href',
      '#/plan/demo/phases?view=qa&report=4',
    );
  });

  it('says so rather than nothing when a verdict has no report behind it', () => {
    mount([{ phase: 1, result: 'waived' }]);
    expect(screen.getByText('no report file')).toBeInTheDocument();
  });

  it('paints each verdict through the QA vocabulary, a dot and its word', () => {
    mount([
      { phase: 1, result: 'pass' },
      { phase: 2, result: 'fail' },
    ]);
    for (const word of ['pass', 'fail']) {
      const view = describeWord('qa-result', word);
      const status = document.querySelector(`[data-vocab="qa-result"][data-status="${word}"]`);
      expect(status, `no QA status for "${word}"`).toBeTruthy();
      expect(status!.querySelector('[data-dot]')).toBeTruthy();
      expect(status!.textContent?.trim()).toBe(view.label);
      expect(status!.getAttribute('data-paint')).toBe(view.paint);
    }
  });

  it('opens in plan order and can be asked for the failures first', () => {
    mount([
      { phase: 1, result: 'pass' },
      { phase: 2, result: 'waived' },
      { phase: 3, result: 'fail' },
    ]);
    const head = (name: string) => screen.getByRole('columnheader', { name });
    expect(order()).toEqual(['P1', 'P2', 'P3']);
    expect(head('Phase')).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(screen.getByRole('button', { name: 'Verdict' }));
    // Worst first, straight off `UI_STATES`: failed, then skipped, then done.
    expect(order()).toEqual(['P3', 'P2', 'P1']);
    expect(head('Verdict')).toHaveAttribute('aria-sort', 'ascending');
    expect(head('Phase')).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    expect(order()).toEqual(['P1', 'P2', 'P3']);
  });

  // 6.2's "offers no order at all for a list with one row in it" is dropped:
  // the 6.2 sort control is gone, and the grid's column heads sort whatever the row count.

  // Replaces 6.2's "shows twenty rows and names how many are behind the button":
  // 7.0 dropped the twenty-row bound and its "Show all N" button.
  it('shows every verdict, and names how many there are', () => {
    mount(Array.from({ length: 22 }, (_, i) => ({ phase: i + 1, result: 'pass' })));
    expect(order()).toHaveLength(22);
    expect(screen.getByText(/^22 QA verdicts, from/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'the plan’s test-status.md' })).toHaveAttribute(
      'href',
      '#/plan/demo/source',
    );
    expect(screen.queryByRole('button', { name: /^Show (all|the first)/ })).toBeNull();
  });

  it('reads an absent list as "QA was never asked for", with the plan file one press away', () => {
    mount([]);
    expect(screen.getByText(/^QA is off for this plan/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /QA line/ })).toHaveAttribute('href', '#/plan/demo/source');
  });

  it('has no axe violations with verdicts on screen', async () => {
    const { container } = mount([
      { phase: 1, result: 'pass', report: 'docs/handoffs/demo/qa-1.md' },
      { phase: 2, result: 'fail' },
    ]);
    await expectNoAxeViolations(container);
  });
});
