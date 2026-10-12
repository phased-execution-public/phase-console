/**
 * What the ladder tried (7.0, quiet-console phase 11) — the 6.x ledger card's
 * rung table, as the grid.
 *
 * Pinned: each settlement's outcome and cause are status words through the
 * family — `withdrawn` (#16) reads as its own word, never a failure, and
 * `environment` names the machine; who drives each vehicle is the ladder
 * table's own word, with how on hover; the total is said beside the rows and
 * never added; an empty ledger is one line.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RUNG_DRIVER_LABELS, VEHICLE_DRIVERS } from '@shared/ladder-model.js';
import type { LedgerRung, LedgerTotals, RunLedger } from '@/data/api';
import { expectNoAxeViolations } from '@/test/axe';
import { RunRungs } from './rungs';

const totals = (over: Partial<LedgerTotals> = {}): LedgerTotals => ({
  sessions: 2,
  sessionsUsd: 2.25,
  unknownCost: 0,
  turns: 16,
  ms: 120_000,
  rungsUsd: 0.75,
  spentUsd: 2.25,
  gapUsd: 0,
  reconciled: true,
  truncated: false,
  ...over,
});

const rung = (over: Partial<LedgerRung>): LedgerRung => ({
  at: '2026-09-15T10:11:00.000Z',
  phase: 2,
  rung: 'resume-own-session',
  driver: 'console',
  outcome: 'fixed',
  cause: null,
  situation: 'crashed',
  costUsd: 0,
  note: null,
  by: 'drive',
  ...over,
});

const ledger = (rungs: LedgerRung[], over: Partial<LedgerTotals> = {}): RunLedger => ({
  runId: 'r1',
  starts: [],
  sessions: [],
  rungs,
  totals: totals(over),
});

const ladder = () =>
  ledger([
    rung({ phase: 2, outcome: 'withdrawn', cause: 'never-ran' }),
    rung({
      at: '2026-09-15T10:12:00.000Z',
      phase: 3,
      rung: 'switch-account',
      outcome: 'failed',
      cause: 'environment',
      situation: 'resource-wall:auth',
      costUsd: 0.75,
    }),
    rung({ at: '2026-09-15T10:13:00.000Z', phase: 4, outcome: 'fixed' }),
  ]);

describe('<RunRungs>', () => {
  it('reads a withdrawn rung as withdrawn — its own settled word, never a failure', () => {
    render(<RunRungs ledger={ladder()} />);
    const outcomes = screen.getAllByTestId('rung-outcome');
    expect(outcomes.map((word) => word.getAttribute('data-status'))).toEqual([
      'withdrawn',
      'failed',
      'fixed',
    ]);
    expect(outcomes[0]!.textContent).toContain('Withdrawn');
    expect(outcomes[0]!.getAttribute('data-vocab')).toBe('rung');
    // Every word is a dot and a word, the family's — never bare text.
    for (const word of outcomes) expect(word.querySelector('[data-dot]')).not.toBeNull();
  });

  it('names the machine when the environment defeated a rung, and a dash when no cause was written', () => {
    render(<RunRungs ledger={ladder()} />);
    const causes = screen.getAllByTestId('rung-cause');
    expect(causes.map((word) => word.getAttribute('data-status'))).toEqual(['never-ran', 'environment']);
    expect(causes[1]!.textContent).toContain('The machine');
    expect(causes[1]!.getAttribute('data-vocab')).toBe('rungCause');
    // The third settlement names no cause: a quiet dash that says why on hover.
    expect(screen.getAllByTitle('This settlement names no cause.')).toHaveLength(1);
  });

  it('says who drives each vehicle in the ladder table’s words, and how on hover', () => {
    render(<RunRungs ledger={ladder()} />);
    const drivers = screen.getAllByTestId('rung-driver');
    expect(drivers).toHaveLength(3);
    const words = RUNG_DRIVER_LABELS.console;
    expect(drivers[1]!.textContent).toBe(words.charAt(0).toUpperCase() + words.slice(1));
    expect(drivers[1]!.getAttribute('title')).toBe(VEHICLE_DRIVERS['switch-account'].how);
  });

  it('names the phase and the vehicle on each row, the vehicle in the machine face', () => {
    render(<RunRungs ledger={ladder()} />);
    const table = screen.getByRole('table', { name: 'Rung settlements' });
    const row = within(table).getByText('switch-account').closest('tr')!;
    expect(within(row).getByText('P3')).toBeInTheDocument();
    expect(within(row).getByText('switch-account').tagName).toBe('CODE');
    expect(within(row).getByText('resource-wall:auth')).toBeInTheDocument();
    expect(within(row).getByText('$0.75')).toBeInTheDocument();
  });

  it('says what the rungs cost in all, already inside the sessions’ costs', () => {
    render(<RunRungs ledger={ladder()} />);
    expect(screen.getByTestId('rungs-total').textContent).toBe(
      '3 rungs, $0.75 in all, already inside the sessions’ costs.',
    );
  });

  it('says when the journal read was cut and early rungs may be missing', () => {
    render(<RunRungs ledger={ledger([rung({})], { rungsUsd: 0, truncated: true })} />);
    expect(screen.getByTestId('rungs-total').textContent).toBe(
      '1 rung, $0.00 in all, already inside the sessions’ costs. The journal read was cut, so early rungs may be missing.',
    );
  });

  it('draws one line when the ladder has tried nothing', () => {
    render(<RunRungs ledger={ledger([], { rungsUsd: 0 })} />);
    const line = screen.getByTestId('run-rungs');
    expect(line.textContent).toBe('The ladder has not tried anything on this run.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says the ledger has not answered while there is none to read', () => {
    render(<RunRungs ledger={undefined} />);
    expect(screen.getByTestId('run-rungs').getAttribute('data-state')).toBe('unread');
  });

  it('has no axe violations', async () => {
    const { container } = render(<RunRungs ledger={ladder()} />);
    await expectNoAxeViolations(container);
  });
});
