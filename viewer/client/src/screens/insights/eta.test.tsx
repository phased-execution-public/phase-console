/**
 * How long is left — the ETA panel (7.0, quiet-console phase 19).
 *
 * The panel prints the server's arithmetic and makes none of its own (`./model`),
 * so what is worth failing over is a figure that says more than the server did.
 *
 * The floor under a scoped estimate: the plan page already counts the critical
 * path, and this row exists to say what a count cannot — how much of the work
 * left must run in order. Three ways to get that wrong, one test each: saying it
 * when the server did not answer, saying "0 could run beside it" (a choice the
 * reader does not have, phrased as one they do), and saying it on the portfolio
 * view, where there is no chain to have. Since 7.0 it prints the two counts the
 * server sent and never their difference.
 *
 * An M phase: 6.2 multiplied a rate by the console's M weight in the browser
 * (`recentRate`, in the portfolio panel). 7.0 prints `rate.mediumMs`, which the
 * server computes with the same `estimateMs` every phase, run and lane ETA uses,
 * and prints "—" when an older server did not send it.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EtaEstimate, PlanSummaryFull, Portfolio } from '@/data/api';
import { EtaPanel } from './eta';

const STATS = {
  totals: {
    plans: 2,
    closed: 0,
    open: 2,
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
  missing: 0,
  remainingPhases: 5,
  remainingWeight: 400_000,
  ratePerWeight: 36,
  floorMs: 42 * 60_000,
  slopeMsPerWeight: 36,
  lowMs: 2 * 86_400_000,
  highMs: 4 * 86_400_000,
  clock: 'working',
};

/**
 * The plan's own analysis. `ready` and `inProgress` are on every server's
 * summary; the floor's two counts are what an older server leaves out.
 */
const summary = (over: Partial<PlanSummaryFull>) =>
  ({ ready: [], inProgress: [], ...over }) as unknown as PlanSummaryFull;

const mount = (planStats?: PlanSummaryFull, everything = false) =>
  render(<EtaPanel stats={STATS} plan="demo" planEta={ETA} planStats={planStats} everything={everything} />);

/** A row of the estimate: the value beside its label. */
const valueOf = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('the floor under a scoped estimate', () => {
  it('says how much must run in order, as the two counts the server sent', () => {
    const { container } = mount(summary({ minimumSessions: 5, remainingSessions: 12 }));
    expect(
      screen.getByText('5 sessions of the 12 left must run in order; the rest could run beside the chain.'),
    ).toBeTruthy();
    // The two counts, never their difference: "7 could run beside it" is a
    // subtraction the server did not make.
    expect(container.textContent).not.toMatch(/\b7 sessions?\b/);
    expect(screen.getByRole('link', { name: 'The route map draws it' })).toHaveAttribute(
      'href',
      '#/plan/demo/phases?view=map',
    );
  });

  it('does not offer a parallelism that does not exist', () => {
    // "0 sessions could run beside it" reads as a choice. There is none.
    mount(summary({ minimumSessions: 4, remainingSessions: 4 }));
    expect(
      screen.getByText(/All 4 sessions left must run in order: the dependency chain accounts for all of it/),
    ).toBeTruthy();
    expect(screen.queryByText(/could run beside/)).toBeNull();
  });

  it('stays silent when the server did not say', () => {
    // An older console answers `/api/plans/:slug` without these fields, and a
    // page whose job is to be readable must read a missing field as "not
    // said" rather than as zero.
    mount(summary({}));
    expect(screen.queryByText(/must run in order/)).toBeNull();
    expect(screen.queryByText('Floor')).toBeNull();
    expect(screen.queryByText('Sessions left')).toBeNull();
  });

  it('stays silent on the portfolio view, which has no chain', () => {
    render(<EtaPanel stats={STATS} />);
    expect(screen.queryByText(/must run in order/)).toBeNull();
  });
});

describe('the pooled reading (control-tower phase 58)', () => {
  const rate = {
    basis: 'portfolio',
    floorMs: 42 * 60_000,
    slopeMsPerWeight: 36,
    ratePerWeight: 99,
    samples: 60,
    missing: 2,
    spread: 0.8,
    clock: 'working',
    mediumMs: 40 * 60_000,
  } as const;
  const pooled = (over: Partial<NonNullable<Portfolio['rate']>> = {}) =>
    ({ ...STATS, rate: { ...rate, ...over } }) as unknown as Portfolio;

  it('states the band as the factor it is, both ways, and where it comes from', () => {
    // `spread` runs the same FACTOR above and below the point, so a `±` percent
    // misstates the lower end; the band is read from how the measured phases
    // fell around the model, never from how many there were.
    render(<EtaPanel stats={pooled()} />);
    expect(
      screen.getByText('÷1.8 to ×1.8 of the estimate, where three in four measured phases fell'),
    ).toBeTruthy();
    expect(screen.queryByText(/±/)).toBeNull();
  });

  it('counts what it weighted and names what it left out', () => {
    render(<EtaPanel stats={pooled()} />);
    expect(
      screen.getByText('60 measured phases weighted, 2 left out with no usable measurement'),
    ).toBeTruthy();
  });

  // The three below stand in for 6.2's `recentRate` tests (portfolio.test.tsx),
  // whose fact, the rate per M phase, is this panel's "An M phase" since 7.0.
  it('states an M phase in the working time the server computed, never a rate per unit of weight', () => {
    // "36 ms per unit of weight" is the right thing to store and an unreadable
    // thing to print; and 99 × 40K in the browser would be 66 min, a second
    // arithmetic beside the server's.
    const { container } = render(<EtaPanel stats={pooled()} />);
    expect(valueOf('An M phase')).toBe('about 40m of work');
    expect(container.textContent).not.toMatch(/66\s*m|per unit of weight/);
  });

  it('says "—" when the server sent no M-phase time, never a figure of its own', () => {
    const { container } = render(<EtaPanel stats={pooled({ mediumMs: undefined })} />);
    expect(valueOf('An M phase')).toBe('—');
    expect(container.textContent).not.toMatch(/about .* of work/);
  });

  it('prints no estimate on the shipped constants, which are a placeholder, not a measurement', () => {
    render(<EtaPanel stats={pooled({ basis: 'heuristic' })} />);
    expect(screen.queryByText('An M phase')).toBeNull();
    expect(
      screen.getByText('No phase has finished yet, so estimates use the shipped constants.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See what could start' })).toHaveAttribute(
      'href',
      '#/runs?group=ready',
    );
  });
});

describe('Everything', () => {
  it('adds the model under the estimate and what each figure is', () => {
    const plan = summary({ minimumSessions: 5, remainingSessions: 12 });
    const { unmount } = mount(plan);
    // The glance: the figures, with what each one is on hover only.
    expect(screen.queryByText('Model')).toBeNull();
    expect(screen.queryByText(/one phase is at least one session/)).toBeNull();
    expect(screen.queryByText('working time: nothing parked, queued or overnight')).toBeNull();
    unmount();

    mount(plan, true);
    expect(valueOf('Model')).toBe('42m plus 36 ms per unit of weight');
    expect(screen.getByText(/one phase is at least one session/)).toBeTruthy();
    expect(screen.getByText('working time: nothing parked, queued or overnight')).toBeTruthy();
    expect(screen.getByText(/every one of them reads this rate/)).toBeTruthy();
  });
});
