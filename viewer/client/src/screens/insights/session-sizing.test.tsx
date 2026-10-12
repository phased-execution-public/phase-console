/**
 * What a session may spend (quiet-console phase 26): the panel draws the
 * server's sizing answer — every figure through `./model`, whose own cases
 * hold the arithmetic to the server — and its refusals: no plan directory is
 * one line and the way to open one, any other failure the server's words and
 * Try again. Before this console has read its own sessions it says every
 * figure is the shipped one; Everything adds how each cap was reached and how
 * each size's peaks sat against the model.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/http';
import { setPrefs } from '@/lib/prefs';
import { TooltipProvider } from '@/ui/tooltip';
import { SessionSizingPanel } from './session-sizing';
import { sizingAnswer } from './test-answers';

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  // A desk's box: the grid cuts its columns to the width it measures.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
});

const panel = (props: Partial<Parameters<typeof SessionSizingPanel>[0]> = {}) =>
  render(
    <TooltipProvider>
      <SessionSizingPanel sizing={sizingAnswer()} error={null} onRetry={() => {}} {...props} />
    </TooltipProvider>,
  );

describe('the answer', () => {
  it('says when this console measured its own sessions', () => {
    panel();
    expect(screen.getByTestId('sizing-derived')).toHaveTextContent(
      'Measured from this console’s own sessions',
    );
  });

  it('before any, every figure is the shipped one, and says so', () => {
    panel({ sizing: { ...sizingAnswer(), derivedAt: null } });
    expect(screen.getByTestId('sizing-derived')).toHaveTextContent(
      'This console has not read its own sessions yet, so every figure is the shipped one.',
    );
  });

  it('the cap table is folded under the phase’s two caps, and opens to every mode', () => {
    panel();
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^The cap table/ }));
    const rows = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    // Each row: the cap, then measured here, then shipped (the basis is Everything's, folded into the row).
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/phase turns.*510490$/);
    expect(rows[1]).toMatch(/phase dollars.*not measured\$120\.00$/);
    expect(rows[2]).toMatch(/resume turns.*not measured120$/);
    expect(rows[3]).toMatch(/closeout turns.*70—$/);
  });
});

describe('Everything', () => {
  it('adds each size’s peaks against the model', () => {
    panel({ everything: true });
    expect(screen.getByTestId('sizing-peaks')).toHaveTextContent('118K median peak');
    expect(screen.getByTestId('sizing-peaks')).toHaveTextContent('0.98 of the model at 160K of weight');
  });

  it('at the glance there are none', () => {
    panel();
    expect(screen.queryByTestId('sizing-peaks')).toBeNull();
  });
});

describe('refusals', () => {
  it('no plan directory is one line and the way to open one', () => {
    panel({ sizing: undefined, error: new ApiError('No source directory is open.', 409, '/api/sizing') });
    expect(
      screen.getByText('No plan directory is open, so there are no sessions to measure.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a source directory' })).toHaveAttribute(
      'href',
      '#/source',
    );
  });

  it('any other failure is the server’s words, and Try again asks again', () => {
    const onRetry = vi.fn();
    panel({ sizing: undefined, error: new ApiError('the census threw', 500, '/api/sizing'), onRetry });
    expect(screen.getByText('The session caps could not be read: the census threw')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
