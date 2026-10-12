/**
 * A figure's numbers — the fold every figure owes. Pinned: folded, it names
 * what it holds and counts it; open, it is the table the figure was drawn
 * from, named by a sentence, its numbers reading from the end in tabular
 * figures; with nothing charted it is not drawn at all.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { FigureNumbers, type FigureColumn } from './numbers';

type Point = { name: string; usd: number };

const ROWS: Point[] = [
  { name: 'P1 attempt 1', usd: 4.25 },
  { name: 'P2 attempt 1', usd: 11 },
];

const COLUMNS: FigureColumn<Point>[] = [
  { head: 'Attempt', cell: (point) => point.name },
  { head: 'Cost', cell: (point) => `$${point.usd.toFixed(2)}`, align: 'end' },
];

const mount = (rows: Point[] = ROWS, note?: string) =>
  render(
    <FigureNumbers
      label="attempt costs"
      caption="What each attempt cost: the numbers behind the cost strip"
      rows={rows}
      getRowKey={(point) => point.name}
      columns={COLUMNS}
      {...(note ? { note } : {})}
    />,
  );

describe('<FigureNumbers>', () => {
  it('folds its table under a line that names it and counts it — the table unmounted until asked for', () => {
    mount();
    const fold = screen.getByRole('button', { name: /The attempt costs/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(fold).toHaveTextContent('(2)');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('opens to the table the figure was drawn from, named by its sentence, numbers from the end', () => {
    mount(ROWS, 'Booked when each session ended.');
    fireEvent.click(screen.getByRole('button', { name: /The attempt costs/ }));
    expect(screen.getByRole('button', { name: 'Hide the attempt costs' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const table = screen.getByRole('table', {
      name: 'What each attempt cost: the numbers behind the cost strip',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((head) => head.textContent),
    ).toEqual(['Attempt', 'Cost']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([
      ['P1 attempt 1', '$4.25'],
      ['P2 attempt 1', '$11.00'],
    ]);
    const cost = rows[0]!.querySelectorAll('td')[1]!;
    expect(cost.className).toContain('text-end');
    expect(cost.className).toContain('tnum');
    expect(screen.getByText('Booked when each session ended.')).toBeInTheDocument();
    // Until it is measured, the wrapper is the safe scroller; it says so.
    expect(table.closest('[data-scrolls]')).not.toBeNull();
  });

  it('is not drawn at all with nothing charted — the figure’s own empty line is the message', () => {
    const { container } = mount([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('is clean to axe, folded and open', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { name: /The attempt costs/ }));
    await expectNoAxeViolations(container);
  });
});
