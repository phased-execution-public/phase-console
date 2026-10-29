/**
 * The Money card's forecast line (measured-console phase 23): what the run will likely cost,
 * beside the ceilings, always `estimated` — and said to be over a ceiling when it is.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunForecastUsdView } from '@/data/api';
import { ForecastLine } from './money-and-stops';

const phase = (n: number, usd: number | null, basis: 'measured' | 'shipped' = 'shipped') => ({
  phase: n,
  usd,
  word: usd === null ? ('unavailable' as const) : ('estimated' as const),
  source: 'forecast' as const,
  sessions: 1.66,
  sessionsBasis: 'shipped' as const,
  size: 'M',
  perSession: {
    usd: usd === null ? null : 14.67,
    basis,
    samples: basis === 'measured' ? 24 : 0,
    model: 'claude-opus-5-5',
    effort: 'high',
    kind: 'default',
  },
});

describe('<ForecastLine>', () => {
  it('says what the run will likely cost, estimated, and where the dollars came from', () => {
    const forecast: RunForecastUsdView = {
      usd: 48.64,
      word: 'estimated',
      source: 'forecast',
      unpricedPhases: 0,
      phases: [phase(1, 24.32, 'measured'), phase(2, 24.32, 'measured')],
    };
    render(
      <ul>
        <ForecastLine forecast={forecast} atMost={null} />
      </ul>,
    );
    const line = screen.getByTestId('launch-forecast-usd');
    expect(line).toHaveTextContent(
      "Likely cost $48.64 estimated for 2 phases — each its size's sessions × dollars per session, 2 of them from this console's own ledger.",
    );
    expect(line.querySelector('[data-money="estimated"]')).not.toBeNull();
  });

  it('is a floor when a phase is unpriced, and says when it is over the ceiling', () => {
    const forecast: RunForecastUsdView = {
      usd: 24.42,
      word: 'estimated',
      source: 'forecast',
      unpricedPhases: 1,
      phases: [phase(1, 24.42), phase(2, null)],
    };
    render(
      <ul>
        <ForecastLine forecast={forecast} atMost={20} />
      </ul>,
    );
    const line = screen.getByTestId('launch-forecast-usd');
    expect(line).toHaveTextContent(
      'from the shipped table until twenty sessions are measured; 1 phase nobody prices, so it is a floor',
    );
    expect(line).toHaveTextContent('over the ceiling of $20.00, so it would halt and ask before the end.');
  });
});
