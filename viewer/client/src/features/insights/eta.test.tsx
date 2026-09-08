/**
 * The ETA panel's floor — what the dependency chain costs an estimate.
 *
 * The plan page already counts the critical path; this row exists to say the
 * thing a count cannot, which is how much of the remaining work could run
 * BESIDE the chain rather than after it. Three ways to get that wrong, one
 * test each: saying it when the server did not answer, saying "0 could run
 * beside it" (a choice the reader does not have, phrased as one they do), and
 * saying it on the portfolio view, where there is no chain to have.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EtaPanel } from './eta';
import type { EtaEstimate, PlanSummaryFull, Portfolio } from '@/lib/api';

const STATS = {
  totals: {
    plans: 2,
    closed: 0,
    remainingWeight: 400_000,
    remainingSessions: 4,
    ready: 1,
    inProgress: 0,
  },
  rate: null,
  medianCycleDays: 2,
  velocity: [],
  calendar: [],
} as unknown as Portfolio;

const ETA: EtaEstimate = {
  label: '≈ 3 days',
  basis: 'plan',
  samples: 6,
  remainingPhases: 5,
  remainingWeight: 400_000,
} as EtaEstimate;

const summary = (over: Partial<PlanSummaryFull>) => ({ ...over }) as PlanSummaryFull;

const mount = (planStats?: PlanSummaryFull) =>
  render(<EtaPanel stats={STATS} mediumWeight={40_000} plan="demo" planEta={ETA} planStats={planStats} />);

describe('the floor under a scoped estimate', () => {
  it('says how much could run beside the chain', () => {
    mount(summary({ minimumSessions: 5, remainingSessions: 12 }));
    expect(screen.getByText(/5 sessions must run in order/)).toBeTruthy();
    expect(screen.getByText(/7 sessions of the 12 could run beside the chain/)).toBeTruthy();
  });

  it('does not offer a parallelism that does not exist', () => {
    // "0 sessions could run beside it" reads as a choice. There is none.
    mount(summary({ minimumSessions: 4, remainingSessions: 4 }));
    expect(screen.getByText(/accounts for all of it/)).toBeTruthy();
    expect(screen.queryByText(/could run beside/)).toBeNull();
  });

  it('stays silent when the server did not say', () => {
    // An older console answers `/api/plans/:slug` without these fields, and a
    // page whose job is to be readable must read a missing field as "not
    // said" rather than as zero.
    mount(summary({}));
    expect(screen.queryByText(/must run in order/)).toBeNull();
  });

  it('stays silent on the portfolio view, which has no chain', () => {
    render(<EtaPanel stats={STATS} mediumWeight={40_000} />);
    expect(screen.queryByText(/must run in order/)).toBeNull();
  });
});
