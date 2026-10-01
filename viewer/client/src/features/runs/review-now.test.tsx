/** *Review now* presses `POST /api/run/<slug>/ultrareview` once, after asking (control-tower phase 25). */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runUltraReview } = vi.hoisted(() => ({ runUltraReview: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runUltraReview } };
});

import { ReviewNow, reviewAnswerText } from './review-now';

beforeEach(() => vi.clearAllMocks());

describe('Review now', () => {
  it('asks first — it is billed — then runs one review and says what it found', async () => {
    runUltraReview.mockResolvedValue({
      slug: 'demo',
      phase: 7,
      state: 'landed',
      verdict: 'approve',
      findings: 2,
      ms: 1000,
    });
    render(<ReviewNow slug="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Review now' }));
    expect(runUltraReview).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Review now' }));
    await waitFor(() => expect(runUltraReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('review-now-answer')).toHaveTextContent(
      'Reviewed phase 7: approve — 2 findings.',
    );
  });

  it('never words a review that could not run as one that found nothing', () => {
    expect(
      reviewAnswerText({ slug: 'demo', phase: 7, state: 'unknown', reason: 'no branch pushed', ms: 5 }),
    ).toBe('The review could not run: no branch pushed.');
  });
});
