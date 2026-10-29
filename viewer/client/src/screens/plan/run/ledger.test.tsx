/**
 * What every session cost and ran, held to the run's spend (7.0, quiet-console
 * phase 12; the cases carried from the 6.x ledger card's suite).
 *
 * Pinned: a session the console ended still shows its own cost, and a cost
 * never reported reads unknown, never $0.00; the reconciliation against the
 * run's spend is a finding when it does not hold, and says reconciled when it
 * does; the turn cap binds per PROMPT, so the Turns cell names the largest
 * prompt beside the sum and the cap says what it counts (#62's SIZ-7, PT-1).
 * The rungs are not drawn here: they are the ladder's own fold (`rungs.tsx`).
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LedgerSession, LedgerTotals, RunLedger } from '@/data/api';
import { expectNoAxeViolations } from '@/test/axe';
import { RunCostLedger, reconciliation } from './ledger';

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

const ledger = (sessions: LedgerSession[], over: Partial<LedgerTotals> = {}): RunLedger => ({
  runId: 'r1',
  starts: [],
  sessions,
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
  totals: totals(over),
});

describe('<RunCostLedger>', () => {
  it('a session the console ended shows its own cost, and a cost never reported reads unknown — never $0.00', () => {
    render(
      <RunCostLedger
        ledger={ledger(
          [
            session({ endedBy: 'watchdog', consoleEnded: true, costUsd: 0.75, sessionId: 's-2' }),
            session({ costUsd: null, costSource: 'none', sessionId: 's-3', at: '2026-09-15T10:20:00.000Z' }),
          ],
          { sessionsUsd: 0.75, unknownCost: 1, spentUsd: 0.75, gapUsd: 0, reconciled: false },
        )}
      />,
    );
    expect(screen.getAllByTestId('ledger-cost').map((node) => node.textContent)).toEqual(['$0.75']);
    expect(screen.getByTestId('ledger-cost-unknown').textContent).toBe('unavailable');
    expect(screen.queryByText('$0.00')).toBeNull();
    // How it ended is the machine's word; that the console cut it short is said beside it.
    expect(screen.getByText('watchdog').tagName).toBe('CODE');
    expect(screen.getByTestId('ledger-console-ended').textContent).toBe('cut short by the console');
  });

  it('draws no rung: what the ladder tried is its own fold', () => {
    render(<RunCostLedger ledger={ledger([session({})])} />);
    expect(screen.getByRole('table', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Rung settlements' })).toBeNull();
    expect(screen.queryByText('switch-account')).toBeNull();
  });

  it('names each session on its row — the phase, what it was for, who paid, with which model', () => {
    render(<RunCostLedger ledger={ledger([session({ mode: 'qa', attempt: 3, model: 'sonnet' })])} />);
    const table = screen.getByRole('table', { name: 'Sessions' });
    const row = within(table).getByText('qa').closest('tr')!;
    expect(within(row).getByText('P2')).toBeInTheDocument();
    expect(within(row).getByText('qa').tagName).toBe('CODE');
    expect(within(row).getByText('attempt 3')).toBeInTheDocument();
    expect(within(row).getByText('default').tagName).toBe('CODE');
    expect(within(row).getByText('sonnet').tagName).toBe('CODE');
    expect(within(row).getByText('$1.50')).toBeInTheDocument();
  });

  it('says what the sessions cost and ran in all, above the rows', () => {
    render(<RunCostLedger ledger={ledger([session({}), session({ sessionId: 's-2' })])} />);
    expect(screen.getByTestId('ledger-total').textContent).toMatch(
      /^\$2\.25 estimated, 16 turns and .+ across 2 sessions\.$/,
    );
  });

  it('flags a gap against the run’s spend', () => {
    render(
      <RunCostLedger
        ledger={ledger([session({})], {
          sessions: 1,
          sessionsUsd: 1.5,
          spentUsd: 5,
          gapUsd: 3.5,
          reconciled: false,
        })}
      />,
    );
    const line = screen.getByTestId('ledger-reconcile');
    expect(line.getAttribute('data-gap')).toBe('true');
    expect(line.className).toContain('state-failed');
    expect(line.textContent).toMatch(/\$3\.50 of it no session line accounts for/);
  });

  it('PT-1: the Turns cell names the largest prompt beside the sum, and the turn cap reads per prompt', () => {
    // many-plans-one-repo P15 in #62: 338 turns in sum under a 300 cap the CLI
    // enforces per prompt — its largest prompt was the figure to read against it.
    render(
      <RunCostLedger
        everything
        ledger={ledger(
          [
            session({ turns: 338, promptTurns: 300, maxTurns: { value: 300, source: 'measured' } }),
            session({ turns: 40, promptTurns: null, sessionId: 's-2', at: '2026-09-15T10:20:00.000Z' }),
          ],
          { sessions: 2, turns: 378 },
        )}
      />,
    );
    const beside = screen.getAllByTestId('ledger-prompt-turns');
    expect(beside.map((node) => node.textContent)).toEqual(['max 300 per prompt']);
    expect(screen.getByText('338')).toBeTruthy();
    // The cap counts per prompt and names where it came from; the sum is never set against it.
    const capped = screen.getByText('measured').closest('td')!;
    expect(capped.textContent).toBe('300 turns per prompt measured');
    expect(screen.queryByText(/338 turns per prompt/)).toBeNull();
  });

  it('PT-1: one prompt, or a line from before the field, shows the count alone — nothing invented beside it', () => {
    render(
      <RunCostLedger
        ledger={ledger([
          session({}),
          session({ promptTurns: null, sessionId: 's-2', at: '2026-09-15T10:20:00.000Z' }),
        ])}
      />,
    );
    expect(screen.queryByTestId('ledger-prompt-turns')).toBeNull();
  });

  it('keeps the caps, the session id and where the cost was read as Everything’s columns', () => {
    const { rerender } = render(
      <RunCostLedger ledger={ledger([session({ sessionId: 'abcdef0123456789' })])} />,
    );
    // Folded into the row at the glance — counted on its +N, one press away.
    for (const head of ['Turn cap', 'Dollar cap', 'Session id', 'Cost read from', 'Ended']) {
      expect(screen.queryByRole('columnheader', { name: head })).toBeNull();
    }
    rerender(<RunCostLedger everything ledger={ledger([session({ sessionId: 'abcdef0123456789' })])} />);
    for (const head of ['Turn cap', 'Dollar cap', 'Session id', 'Cost read from', 'Ended']) {
      expect(screen.getByRole('columnheader', { name: head })).toBeInTheDocument();
    }
    expect(screen.getByText('abcdef01').getAttribute('title')).toBe('abcdef0123456789');
    expect(screen.getByText('$60.00')).toBeInTheDocument();
  });

  it('says when a session ended in an error', () => {
    render(<RunCostLedger ledger={ledger([session({ isError: true })])} />);
    expect(screen.getByTestId('ledger-error').textContent).toBe('with an error');
  });

  it('draws one line when no session has ended, and still holds the run’s spend to them', () => {
    render(
      <RunCostLedger
        ledger={ledger([], { sessions: 0, sessionsUsd: 0, turns: 0, ms: 0, spentUsd: 4.25, gapUsd: null })}
      />,
    );
    expect(screen.getByTestId('ledger-empty').textContent).toBe('No session has ended on this run yet.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('ledger-reconcile').textContent).toBe(
      'No session has reported a cost; the run’s own spend is $4.25.',
    );
  });

  it('draws nothing until the ledger answers', () => {
    const { container } = render(<RunCostLedger ledger={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <RunCostLedger ledger={ledger([session({}), session({ consoleEnded: true, endedBy: 'stop' })])} />,
    );
    await expectNoAxeViolations(container);
  });
});

describe('reconciliation', () => {
  it('says reconciled when the sessions account for every cent', () => {
    const { text, gap } = reconciliation(totals({}));
    expect(gap).toBe(false);
    expect(text).toBe('2 sessions reported $2.25; the run’s own spend is $2.25, reconciled.');
    expect(reconciliation(totals({ unknownCost: 1, reconciled: false })).text).toMatch(
      /and 1 never reported a cost; .*, so it cannot be reconciled\.$/,
    );
  });

  it('says by how much the session lines exceed the run’s spend', () => {
    const { text, gap } = reconciliation(
      totals({ sessionsUsd: 3, spentUsd: 2.5, gapUsd: -0.5, reconciled: false }),
    );
    expect(gap).toBe(true);
    expect(text).toMatch(/the session lines exceed it by \$0\.50\.$/);
  });

  it('reads a cent of drift as rounding, never a finding', () => {
    expect(reconciliation(totals({ gapUsd: 0.01 })).text).toMatch(/, reconciled\.$/);
  });

  it('says when the journal read was cut', () => {
    expect(reconciliation(totals({ truncated: true })).text).toMatch(
      / The journal read was cut, so early sessions may be missing\.$/,
    );
  });

  it('holds nothing to a run it does not know', () => {
    expect(reconciliation(totals({ spentUsd: null, gapUsd: null, reconciled: null }))).toEqual({
      text: '2 sessions reported $2.25.',
      gap: false,
    });
  });

  it('glues nothing with a middle dot', () => {
    const text = reconciliation(
      totals({ unknownCost: 1, truncated: true, gapUsd: 3, reconciled: false }),
    ).text;
    expect(text).not.toMatch(/·/);
  });
});
