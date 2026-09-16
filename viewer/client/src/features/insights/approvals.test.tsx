/**
 * The cards-raised panel (TRS-5): a count with the date it started, so "0
 * cards in N days" is a reading on a screen rather than an assumption. Rendered
 * directly: its one input is `/api/state`'s `approvals`, passed straight
 * through by the destination.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalsPanel } from './approvals';

afterEach(cleanup);

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
    expect(screen.getByText('since 2026-09-01')).toBeTruthy();
    expect(screen.getByText('Raised for a person').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('Answered by auto-grant').nextElementSibling?.textContent).toBe('12');
    expect(screen.getByText('Waiting now').nextElementSibling?.textContent).toBe('1');
    expect(screen.queryByText(/No card has been raised/)).toBeNull();
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
    expect(screen.getByText('Last raised').nextElementSibling?.textContent).toBe('never');
    expect(screen.getByText(/No card has been raised since 2026-09-01/)).toBeTruthy();
  });

  it('names a console that does not count yet', () => {
    render(<ApprovalsPanel counts={undefined} />);
    expect(screen.getByText(/does not count the cards it raises yet/)).toBeTruthy();
  });
});
