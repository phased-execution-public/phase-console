/**
 * Sessions' strip (one-pool phase 17, #369): the machine at a glance, above
 * the list — the live lanes, the shells and agents, the other sessions, who
 * waits on a person and how many accounts the live sessions spend.
 *
 * ```
 * 2 live lanes   1 shell   0 agents   1 other session   1 waiting on you   2 accounts in use
 * ```
 *
 * Words with figures on one line, never tiles (design.md §1, principle 1) —
 * Your turn's strip's grammar. The figures are `sessionSummary`'s, counted
 * over every row, never over what a filter left.
 */

import { sessionSummary, type SessionRow, type SessionSummary } from './model';

/** One figure and its word: the number in tabular figures, the word after it. */
function Figure({ id, n, word }: { id: keyof SessionSummary; n: number; word: string }) {
  return (
    <span data-testid={`sessions-strip-${id}`} data-value={n} className="flex items-baseline gap-1.5">
      <span className="text-section font-semibold text-ink tabular-nums">{n}</span>{' '}
      <span className="text-body text-ink-muted">{word}</span>
    </span>
  );
}

/** The word for a figure drawn on its own — `plural`'s rule, without the figure. */
const wordOf = (n: number, one: string): string => (n === 1 ? one : `${one}s`);

export function SessionsStrip({ rows }: { rows: readonly SessionRow[] }) {
  const sum = sessionSummary(rows);
  return (
    <p
      data-testid="sessions-strip"
      aria-label="Sessions at a glance"
      className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1"
    >
      <Figure id="lanes" n={sum.lanes} word={wordOf(sum.lanes, 'live lane')} />
      <Figure id="shells" n={sum.shells} word={wordOf(sum.shells, 'shell')} />
      <Figure id="agents" n={sum.agents} word={wordOf(sum.agents, 'agent')} />
      <Figure id="foreign" n={sum.foreign} word={wordOf(sum.foreign, 'other session')} />
      <Figure id="waiting" n={sum.waiting} word="waiting on you" />
      <Figure id="accounts" n={sum.accounts} word={`${wordOf(sum.accounts, 'account')} in use`} />
    </p>
  );
}
