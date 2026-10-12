/**
 * The meter — the line's short form, one share of one whole (design.md §8.2).
 *
 * A mark owes no numbers table: the words beside it are its table. What it
 * does owe is a real meter a screen reader can read, a fill that never runs
 * past its track, a paint that is a state and never a colour, and silence
 * rather than an empty bar when there is no whole to read the part against.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { LoadMeter } from './meter';

/** Anything that is a colour but not a token reference. */
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/i;

const fill = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="meter"] > span:first-child')!;

describe('LoadMeter', () => {
  it('is a meter with its numbers on it, read as words', () => {
    render(<LoadMeter value={2.5} max={40} label="Ladder spend today" valueText="$2.50 of $40.00" />);
    const meter = screen.getByRole('meter', { name: 'Ladder spend today' });
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '40');
    expect(meter).toHaveAttribute('aria-valuenow', '2.5');
    expect(meter).toHaveAttribute('aria-valuetext', '$2.50 of $40.00');
  });

  it('draws the share as the fill, and clamps a part over its whole to the track', () => {
    const { container, rerender } = render(<LoadMeter value={10} max={40} label="Load" />);
    expect(fill(container).style.width).toBe('25%');
    rerender(<LoadMeter value={60} max={40} label="Load" valueText="$60.00 of $40.00" />);
    expect(fill(container).style.width).toBe('100%');
    // The numbers are not clamped, and the title says the part is over.
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByRole('meter').getAttribute('title')).toMatch(/— over$/);
  });

  it('paints through a state, never a colour, with ticks at the quarters', () => {
    const { container } = render(<LoadMeter value={1} max={4} label="Load" paint="needs-you" />);
    const meter = screen.getByRole('meter');
    expect(meter.className).toMatch(/\bstate-needs-you\b/);
    expect(fill(container).className).toMatch(/\bbg-state\b/);
    const ticks = [...meter.querySelectorAll<HTMLElement>('[aria-hidden]')].map(
      (tick) => tick.style.insetInlineStart,
    );
    expect(ticks).toEqual(['25%', '50%', '75%']);
    for (const node of container.querySelectorAll<HTMLElement>('*')) {
      expect(node.getAttribute('style') ?? '').not.toMatch(LITERAL_COLOUR);
    }
  });

  it('says its reading instead of drawing an empty bar when there is no whole', () => {
    const { container, rerender } = render(
      <LoadMeter value={3} max={null} label="Load" reading="no day cap" />,
    );
    expect(screen.queryByRole('meter')).toBeNull();
    expect(container.textContent).toBe('no day cap');
    rerender(<LoadMeter value={3} max={0} label="Load" />);
    expect(container.textContent).toBe('');
  });

  it('carries a short reading at the bar’s end', () => {
    render(<LoadMeter value={1} max={4} label="Load" reading="25%" />);
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('is clean to axe', async () => {
    const { container } = render(
      <LoadMeter value={2.5} max={40} label="Ladder spend today" valueText="$2.50 of $40.00" reading="6%" />,
    );
    await expectNoAxeViolations(container);
  });
});
