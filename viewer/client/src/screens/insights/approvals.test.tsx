/**
 * Who was asked — the cards-raised panel (TRS-5): a count with the date it
 * started, so "0 cards in N days" is a reading on a screen rather than an
 * assumption. Rendered directly: its one input is `/api/state`'s `approvals`,
 * passed straight through by the destination.
 *
 * Since 7.0 the answer is a sentence and the counts are fact rows beside it,
 * each its label, its figure and what the figure is.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalsPanel } from './approvals';

afterEach(cleanup);

/** A sentence as a person reads it: a paragraph's whole text, however many elements it spans. */
const sentence = (text: string) =>
  screen.queryByText((_, el) => el?.tagName === 'P' && el.textContent === text);

/** A fact row's value cell — the figure and, beside it, what the figure is. */
const fact = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;

describe('ApprovalsPanel', () => {
  it('says how many cards were raised and auto-granted, and since when', () => {
    render(
      <ApprovalsPanel
        counts={{
          raised: 3,
          autoGranted: 12,
          since: '2026-09-01T08:00:00.000Z',
          lastRaisedAt: '2026-09-14T10:00:00.000Z',
          pending: 1,
        }}
      />,
    );
    expect(sentence('3 cards raised for a person since 2026-09-01.')).toBeTruthy();
    expect(within(fact('Raised for a person')).getByText('3')).toBeTruthy();
    expect(within(fact('Answered by auto-grant')).getByText('12')).toBeTruthy();
    expect(within(fact('Waiting now')).getByText('1')).toBeTruthy();
    expect(screen.getByText(/^Last raised/).textContent).toMatch(/, 2026-09-14 10:00$/);
    expect(document.body.textContent).not.toMatch(/No card has been raised/);
    expect(document.body.textContent).not.toMatch(/a reading, not a verdict/);
  });

  it('turns zero cards into a reading, never a verdict', () => {
    render(
      <ApprovalsPanel
        counts={{
          raised: 0,
          autoGranted: 0,
          since: '2026-09-01T08:00:00.000Z',
          lastRaisedAt: null,
          pending: 0,
        }}
      />,
    );
    expect(screen.getByText('Last raised').textContent).toBe('Last raised never');
    expect(sentence('No card has been raised for a person since 2026-09-01.')).toBeTruthy();
    expect(screen.getByText(/That is a reading, not a verdict/)).toBeTruthy();
  });

  it('names a console that does not count yet', () => {
    render(<ApprovalsPanel counts={undefined} />);
    expect(screen.getByText(/does not count the cards it raises yet/)).toBeTruthy();
  });
});
