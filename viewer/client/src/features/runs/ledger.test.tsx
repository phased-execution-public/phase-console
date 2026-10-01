/**
 * What the run cost and how long it ran (zero-touch phase 19): a session the
 * console ended still renders its own cost; a cost never reported reads unknown;
 * and the reconciliation against the run's spend is flagged when it does not
 * hold — and says reconciled when it does. And (control-tower phase 89, #62's
 * SIZ-7, PT-1) the turn cap binds per PROMPT, so the Turns cell beside it names
 * the largest prompt next to the sum, and the cap says what it counts.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import type { LedgerSession, LedgerTotals, RunLedger } from '@/lib/api';
import { LedgerCard, reconciliation } from './ledger';

const session = (over: Partial<LedgerSession>): LedgerSession => ({
  at: '2026-09-15T10:10:00.000Z',
  phase: 2,
  mode: 'phase',
  attempt: 1,
  model: 'opus',
  sessionId: 's-1',
  resumed: false,
  endedBy: 'exit',
  consoleEnded: false,
  isError: false,
  turns: 12,
  promptTurns: 12,
  turnsSource: 'result',
  costUsd: 1.5,
  costSource: 'result',
  ms: 60_000,
  maxTurns: { value: 300, source: 'size' },
  maxBudgetUsd: { value: 60, source: 'size' },
  account: 'default',
  ...over,
});

const totals = (over: Partial<LedgerTotals>): LedgerTotals => ({
  sessions: 2,
  sessionsUsd: 2.25,
  unknownCost: 0,
  turns: 16,
  ms: 120_000,
  rungsUsd: 0,
  spentUsd: 2.25,
  gapUsd: 0,
  reconciled: true,
  truncated: false,
  ...over,
});

function mount(ledger: RunLedger) {
  return render(
    <MemoryRouterProvider initial="#/plan/demo/run">
      <LedgerCard ledger={ledger} />
    </MemoryRouterProvider>,
  );
}

describe('the ledger card', () => {
  it('a session the console ended renders its own cost, and a cost never reported reads unknown', () => {
    mount({
      runId: 'r1',
      starts: [],
      sessions: [
        session({ endedBy: 'watchdog', consoleEnded: true, costUsd: 0.75, sessionId: 's-2' }),
        session({ costUsd: null, costSource: 'none', sessionId: 's-3', at: '2026-09-15T10:20:00.000Z' }),
      ],
      rungs: [
        {
          at: '2026-09-15T10:11:00.000Z',
          phase: 2,
          rung: 'switch-account',
          driver: 'console',
          outcome: 'failed',
          situation: 'resource-wall:usage',
          costUsd: 0.75,
          note: null,
          by: 'drive',
        },
      ],
      totals: totals({
        sessions: 2,
        sessionsUsd: 0.75,
        unknownCost: 1,
        spentUsd: 0.75,
        gapUsd: 0,
        reconciled: false,
      }),
    });
    expect(screen.getAllByTestId('ledger-cost').map((node) => node.textContent)).toContain('$0.75');
    expect(screen.getByText('watchdog')).toBeTruthy();
    expect(screen.getByText('console')).toBeTruthy();
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.getByTestId('ledger-driver').textContent).toBeTruthy();
  });

  it('paints each rung’s outcome and cause as a badge with its icon — withdrawn (#16) and environment included', () => {
    const rung = {
      driver: 'console',
      costUsd: 0,
      note: null,
      by: 'drive',
    };
    mount({
      runId: 'r1',
      starts: [],
      sessions: [],
      rungs: [
        {
          ...rung,
          at: '2026-09-15T10:11:00.000Z',
          phase: 2,
          rung: 'resume',
          outcome: 'withdrawn',
          cause: 'never-ran',
          situation: 'crashed',
        },
        {
          ...rung,
          at: '2026-09-15T10:12:00.000Z',
          phase: 3,
          rung: 'switch-account',
          outcome: 'failed',
          cause: 'environment',
          situation: 'resource-wall:auth',
        },
        {
          ...rung,
          at: '2026-09-15T10:13:00.000Z',
          phase: 4,
          rung: 'resume',
          outcome: 'fixed',
          cause: null,
          situation: 'crashed',
        },
      ],
      totals: totals({}),
    });
    const outcomes = screen.getAllByTestId('ledger-outcome');
    expect(outcomes.map((badge) => badge.getAttribute('data-status'))).toEqual([
      'withdrawn',
      'failed',
      'fixed',
    ]);
    expect(outcomes[0]!.textContent).toContain('Withdrawn');
    const causes = screen.getAllByTestId('ledger-cause');
    expect(causes.map((badge) => badge.getAttribute('data-status'))).toEqual(['never-ran', 'environment']);
    // Never plain text: every word rides a badge that draws its icon beside it.
    for (const badge of [...outcomes, ...causes]) {
      expect(badge.querySelector('svg')).not.toBeNull();
      expect(badge.getAttribute('data-vocab')).toMatch(/^rung/);
    }
  });

  it('flags a gap against the run’s spend', () => {
    mount({
      runId: 'r1',
      starts: [],
      sessions: [session({})],
      rungs: [],
      totals: totals({ sessions: 1, sessionsUsd: 1.5, spentUsd: 5, gapUsd: 3.5, reconciled: false }),
    });
    const line = screen.getByTestId('ledger-reconcile');
    expect(line.getAttribute('data-gap')).toBe('true');
    expect(line.textContent).toMatch(/\$3\.50 of it no session line accounts for/);
  });

  it('PT-1: the Turns cell names the largest prompt beside the sum, and the turn cap reads per prompt', () => {
    // many-plans-one-repo P15 in #62: 338 turns in sum under a 300 cap the CLI
    // enforces per prompt — its largest prompt was the figure to read against it.
    mount({
      runId: 'r1',
      starts: [],
      sessions: [
        session({ turns: 338, promptTurns: 300, maxTurns: { value: 300, source: 'measured' } }),
        session({ turns: 40, promptTurns: null, sessionId: 's-2', at: '2026-09-15T10:20:00.000Z' }),
      ],
      rungs: [],
      totals: totals({ sessions: 2, turns: 378 }),
    });
    const beside = screen.getAllByTestId('ledger-prompt-turns');
    expect(beside.map((node) => node.textContent)).toEqual(['max 300 per prompt']);
    expect(screen.getByText('338')).toBeTruthy();
    expect(screen.getAllByText(/300 turns per prompt · measured/).length).toBe(1);
    expect(screen.queryByText(/^300 turns · /)).toBeNull();
  });

  it('PT-1: one prompt, or a line from before the field, shows the count alone — nothing invented beside it', () => {
    mount({
      runId: 'r1',
      starts: [],
      sessions: [
        session({}),
        session({ promptTurns: null, sessionId: 's-2', at: '2026-09-15T10:20:00.000Z' }),
      ],
      rungs: [],
      totals: totals({}),
    });
    expect(screen.queryByTestId('ledger-prompt-turns')).toBeNull();
  });

  it('says reconciled when the sessions account for every cent', () => {
    const { text, gap } = reconciliation(totals({}));
    expect(gap).toBe(false);
    expect(text).toMatch(/reconciled\.$/);
    expect(reconciliation(totals({ unknownCost: 1, reconciled: false })).text).toMatch(
      /cannot be reconciled/,
    );
  });
});
